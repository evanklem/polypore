use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use ignore::WalkBuilder;

use crate::project_context;

#[derive(Clone, Debug, serde::Deserialize, Default)]
pub struct DiagnosticsCollectInput {
    /* legacy single-command path. when set, runs the command and parses
    output with the tsc parser. preserved so existing callers don't
    break. new callers should use `sources` instead. */
    pub command: Option<String>,
    /* multi-source path. each entry names a built-in source ("tsc",
    "eslint", "cargo", "dotnet-build", ...). when omitted, sources are
    auto-detected from config files at the project root. */
    pub sources: Option<Vec<String>>,
}

/* a project-declared diagnostics source from `.polypore/diagnostics.json`.
this is the agnostic escape hatch: any language whose checker isn't in the
built-in matrix can declare a command plus a named output parser, and it runs
alongside the built-ins with no source changes. */
#[derive(Clone, Debug, serde::Deserialize)]
pub struct ProjectDiagnosticSource {
    pub id: String,
    pub command: String,
    /* named parser format. defaults to "generic-colon" (`file:line:col:
    message`), which covers the majority of compiler/linter output. other
    accepted values map to the built-in parsers (see `parser_for`). */
    #[serde(default)]
    pub parser: Option<String>,
    /* when true, only runs during the deep scan; otherwise runs in both the
    fast collect and the deep scan. defaults to false so a quick custom
    checker is always available. */
    #[serde(default)]
    pub deep: bool,
    /* per-source wall-clock budget in seconds; defaults to 30. */
    #[serde(default, rename = "timeoutSecs")]
    pub timeout_secs: Option<u64>,
}

#[derive(Clone, Debug, serde::Deserialize, Default)]
struct ProjectDiagnosticsFile {
    #[serde(default)]
    sources: Vec<ProjectDiagnosticSource>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct Position {
    pub line: i64,
    pub column: i64,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct Diagnostic {
    pub id: String,
    pub severity: String,
    pub source: String,
    pub file: String,
    pub range: Range,
    pub message: String,
    pub code: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsCollectResult {
    pub command: String,
    pub exit_code: Option<i32>,
    pub diagnostics: Vec<Diagnostic>,
    pub output: String,
}

pub(crate) struct SourceRun {
    source: String,
    command: String,
    exit_code: Option<i32>,
    diagnostics: Vec<Diagnostic>,
    output: String,
}

#[tauri::command]
pub fn diagnostics_collect(
    input: Option<DiagnosticsCollectInput>,
) -> Result<DiagnosticsCollectResult, String> {
    let root = project_context::active_project_root()?;
    let input = input.unwrap_or_default();

    /* legacy single-command path. preserved for any caller that still
    passes a raw command — output is parsed as tsc. */
    if let Some(command) = input.command.clone() {
        let run = run_shell_parsed(&command, &root, "tsc", parse_typescript_diagnostics);
        return Ok(DiagnosticsCollectResult {
            command: run.command,
            exit_code: run.exit_code,
            diagnostics: run.diagnostics,
            output: tail_output(&run.output),
        });
    }

    let sources = match input.sources {
        Some(list) if !list.is_empty() => list,
        _ => auto_detect_sources(&root),
    };

    if sources.is_empty() {
        return Ok(DiagnosticsCollectResult {
            command: String::new(),
            exit_code: Some(0),
            diagnostics: vec![],
            output: "no diagnostic sources detected".to_string(),
        });
    }

    /* fan out: each source runs in its own thread so a slow `cargo check`
    doesn't block a quick `tsc --noEmit`. results stream back through a
    channel and are merged in arrival order. */
    let (tx, rx) = mpsc::channel::<SourceRun>();
    let mut handles = Vec::with_capacity(sources.len());
    for source in &sources {
        let tx = tx.clone();
        let root = root.clone();
        let name = source.clone();
        let handle = thread::spawn(move || {
            let run = run_source(&name, &root);
            let _ = tx.send(run);
        });
        handles.push(handle);
    }
    drop(tx);

    let mut all_diagnostics: Vec<Diagnostic> = vec![];
    let mut commands: Vec<String> = vec![];
    let mut output_parts: Vec<String> = vec![];
    let mut worst_exit: Option<i32> = None;
    while let Ok(run) = rx.recv() {
        if !run.command.is_empty() {
            commands.push(run.command.clone());
        }
        if let Some(code) = run.exit_code {
            worst_exit = Some(match worst_exit {
                Some(existing) => existing.max(code),
                None => code,
            });
        }
        output_parts.push(format!(
            "--- {} ({}) ---\n{}",
            run.source, run.command, run.output
        ));
        all_diagnostics.extend(run.diagnostics);
    }
    for handle in handles {
        let _ = handle.join();
    }

    Ok(DiagnosticsCollectResult {
        command: commands.join(" && "),
        exit_code: worst_exit,
        diagnostics: dedupe_diagnostics(all_diagnostics),
        output: tail_output(&output_parts.join("\n\n")),
    })
}

#[tauri::command]
pub async fn diagnostics_deep_scan() -> Result<DiagnosticsCollectResult, String> {
    tauri::async_runtime::spawn_blocking(diagnostics_deep_scan_blocking)
        .await
        .map_err(|err| format!("deep scan task failed: {err}"))?
}

fn diagnostics_deep_scan_blocking() -> Result<DiagnosticsCollectResult, String> {
    let root = project_context::active_project_root()?;
    let sources = auto_detect_deep_sources(&root);
    if sources.is_empty() {
        return Ok(DiagnosticsCollectResult {
            command: String::new(),
            exit_code: Some(0),
            diagnostics: vec![],
            output: "no deep scan sources detected".to_string(),
        });
    }

    let (tx, rx) = mpsc::channel::<SourceRun>();
    let mut handles = Vec::with_capacity(sources.len());
    for source in &sources {
        let tx = tx.clone();
        let root = root.clone();
        let name = source.clone();
        handles.push(thread::spawn(move || {
            let run = run_deep_source(&name, &root);
            let _ = tx.send(run);
        }));
    }
    drop(tx);

    let mut diagnostics = vec![];
    let mut commands = vec![];
    let mut outputs = vec![];
    let mut worst_exit: Option<i32> = None;
    while let Ok(run) = rx.recv() {
        if !run.command.is_empty() {
            commands.push(run.command.clone());
        }
        if let Some(code) = run.exit_code {
            worst_exit = Some(worst_exit.map_or(code, |existing| existing.max(code)));
        }
        outputs.push(format!(
            "--- {} ({}) ---\n{}",
            run.source, run.command, run.output
        ));
        diagnostics.extend(run.diagnostics);
    }
    for handle in handles {
        let _ = handle.join();
    }

    Ok(DiagnosticsCollectResult {
        command: commands.join(" && "),
        exit_code: worst_exit,
        diagnostics: dedupe_diagnostics(diagnostics),
        output: tail_output(&outputs.join("\n\n")),
    })
}

fn auto_detect_sources(root: &Path) -> Vec<String> {
    let mut sources = vec![];
    if root.join("tsconfig.json").exists() || package_uses_typescript(root) {
        sources.push("tsc".to_string());
    }
    if has_eslint_config(root) {
        sources.push("eslint".to_string());
    }
    if root.join("Cargo.toml").exists() || root.join("src-tauri/Cargo.toml").exists() {
        sources.push("cargo".to_string());
    }
    /* project-declared sources that aren't deep-only run in the fast collect
    too, so a custom checker for an otherwise-unsupported language is on by
    default. */
    for source in load_project_diagnostic_sources(root) {
        if !source.deep {
            sources.push(source.id);
        }
    }
    sources
}

fn auto_detect_deep_sources(root: &Path) -> Vec<String> {
    let mut sources = auto_detect_sources(root);
    sources.push("project-inspect".to_string());
    sources.push("css-assets".to_string());
    if root.join("package.json").exists() {
        sources.push("npm-audit".to_string());
    }
    if root.join("go.mod").exists() {
        sources.push("go-build".to_string());
        sources.push("go-vet".to_string());
    }
    if root.join("pom.xml").exists() {
        sources.push("maven-compile".to_string());
    }
    if has_gradle_project(root) {
        sources.push("gradle-build".to_string());
    }
    if has_dotnet_project(root) {
        sources.push("dotnet-build".to_string());
    }
    if root.join("build.sbt").exists() {
        sources.push("sbt-compile".to_string());
    }
    if root.join("mix.exs").exists() {
        sources.push("mix-compile".to_string());
    }
    if root.join("composer.json").exists() {
        sources.push("composer-validate".to_string());
    }
    if root.join("Package.swift").exists() {
        sources.push("swift-build".to_string());
    }
    if root.join("pubspec.yaml").exists() {
        sources.push(if pubspec_uses_flutter(root) {
            "flutter-analyze".to_string()
        } else {
            "dart-analyze".to_string()
        });
    }
    if has_files_with_extension(root, "py") {
        sources.push("python-compile".to_string());
    }
    if root.join("pyproject.toml").exists() || root.join("ruff.toml").exists() {
        sources.push("ruff".to_string());
    }
    if has_files_with_extension(root, "rb") && tool_available("ruby") {
        sources.push("ruby-syntax".to_string());
    }
    if has_files_with_extension(root, "php") && tool_available("php") {
        sources.push("php-lint".to_string());
    }
    if has_files_with_extension(root, "lua") && tool_available("luac") {
        sources.push("lua-syntax".to_string());
    }
    if has_shell_files(root) {
        if tool_available("shellcheck") {
            sources.push("shellcheck".to_string());
        } else if tool_available("bash") {
            sources.push("bash-syntax".to_string());
        }
    }
    /* deep-only project sources (non-deep ones already came in via
    `auto_detect_sources`). dedupe so a source listed in both phases of the
    file isn't run twice. */
    for source in load_project_diagnostic_sources(root) {
        if source.deep && !sources.contains(&source.id) {
            sources.push(source.id);
        }
    }
    sources
}

fn has_files_with_extension(root: &Path, extension: &str) -> bool {
    project_files(root, 200)
        .into_iter()
        .any(|path| path.extension().and_then(|ext| ext.to_str()) == Some(extension))
}

fn has_gradle_project(root: &Path) -> bool {
    has_any(
        root,
        &[
            "build.gradle",
            "build.gradle.kts",
            "settings.gradle",
            "settings.gradle.kts",
        ],
    )
}

fn has_dotnet_project(root: &Path) -> bool {
    project_files(root, 500).into_iter().any(|path| {
        matches!(
            path.extension().and_then(|ext| ext.to_str()),
            Some("sln" | "csproj" | "fsproj" | "vbproj")
        )
    })
}

fn pubspec_uses_flutter(root: &Path) -> bool {
    fs::read_to_string(root.join("pubspec.yaml"))
        .map(|content| content.contains("sdk: flutter") || content.contains("flutter:"))
        .unwrap_or(false)
}

fn has_shell_files(root: &Path) -> bool {
    project_files(root, 200).into_iter().any(|path| {
        let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
        ext == "sh" || ext == "bash"
    })
}

fn tool_available(name: &str) -> bool {
    which::which(name).is_ok()
}

fn has_eslint_config(root: &Path) -> bool {
    const CANDIDATES: &[&str] = &[
        "eslint.config.js",
        "eslint.config.mjs",
        "eslint.config.cjs",
        "eslint.config.ts",
        ".eslintrc",
        ".eslintrc.js",
        ".eslintrc.cjs",
        ".eslintrc.json",
        ".eslintrc.yml",
        ".eslintrc.yaml",
    ];
    CANDIDATES.iter().any(|name| root.join(name).exists()) || package_has_eslint_config(root)
}

fn package_has_eslint_config(root: &Path) -> bool {
    fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|package| package.get("eslintConfig").cloned())
        .is_some()
}

fn package_uses_typescript(root: &Path) -> bool {
    let package = match fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    {
        Some(value) => value,
        None => return false,
    };
    [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    ]
    .iter()
    .filter_map(|key| package.get(*key).and_then(|value| value.as_object()))
    .any(|deps| deps.contains_key("typescript"))
}

/* read project-declared diagnostics sources from `.polypore/diagnostics.json`.
returns an empty list when the file is missing or malformed — diagnostics are
best-effort, so a bad config never blocks the built-in matrix. */
fn load_project_diagnostic_sources(root: &Path) -> Vec<ProjectDiagnosticSource> {
    let path = root.join(".polypore").join("diagnostics.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    /* accept both `{ "sources": [...] }` and a bare `[...]` array. */
    if let Ok(file) = serde_json::from_str::<ProjectDiagnosticsFile>(&text) {
        return file.sources;
    }
    serde_json::from_str::<Vec<ProjectDiagnosticSource>>(&text).unwrap_or_default()
}

/* map a named parser format to its parser function. unknown names fall back to
the generic `file:line:col: message` parser, which is the most broadly useful. */
fn parser_for(name: &str) -> fn(&str, &str) -> Vec<Diagnostic> {
    match name {
        "tsc" => parse_typescript_diagnostics,
        "eslint-json" => parse_eslint_json_diagnostics,
        "cargo-json" => parse_cargo_json_diagnostics,
        "msbuild" => parse_msbuild_diagnostics,
        "jvm" => parse_jvm_build_diagnostics,
        "dart" => parse_dart_analyze_diagnostics,
        "php" => parse_php_lint_diagnostics,
        "python-compile" => parse_python_compile_diagnostics,
        "bash" => parse_bash_syntax_diagnostics,
        "luac" => parse_luac_diagnostics,
        "npm-audit" => parse_npm_audit_diagnostics,
        "composer" => parse_composer_validate_diagnostics,
        _ => parse_generic_colon_diagnostics,
    }
}

/* resolve and run a project-declared diagnostics source by id. returns None
when no `.polypore/diagnostics.json` entry matches, so callers can fall through
to the unknown-source path. */
fn run_project_source(id: &str, root: &Path) -> Option<SourceRun> {
    let spec = load_project_diagnostic_sources(root)
        .into_iter()
        .find(|source| source.id == id)?;
    let parser = parser_for(spec.parser.as_deref().unwrap_or("generic-colon"));
    let timeout = Duration::from_secs(spec.timeout_secs.unwrap_or(30));
    Some(run_shell_parsed_timeout(
        &spec.command,
        root,
        &spec.id,
        parser,
        timeout,
    ))
}

fn run_source(source: &str, root: &Path) -> SourceRun {
    match source {
        /* 60s wall-clock budget per source. tsc --noEmit and eslint can
        stall on large projects or slow TS servers; cargo check blocks on
        dep compilation on first run. without a cap, one slow source hangs
        the entire collect indefinitely — VS Code handles this with
        cancellation tokens; we use a poll-loop kill. */
        "tsc" => run_shell_parsed_timeout(
            "npx tsc --noEmit",
            root,
            "tsc",
            parse_typescript_diagnostics,
            Duration::from_secs(60),
        ),
        "eslint" => run_shell_parsed_timeout(
            "npx eslint . -f json",
            root,
            "eslint",
            parse_eslint_json_diagnostics,
            Duration::from_secs(60),
        ),
        "cargo" => {
            let manifest = pick_cargo_manifest(root);
            let manifest_dir = manifest
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| root.to_path_buf());
            /* run `cargo check` with json output so we can read structured
            spans rather than scraping the human-readable text. clippy
            would be richer but requires `cargo clippy` which isn't
            always installed; check is on every rust toolchain. */
            let command = "cargo check --message-format=json".to_string();
            match run_shell_timeout(&command, &manifest_dir, Duration::from_secs(60)) {
                Ok(output) => SourceRun {
                    source: "cargo".to_string(),
                    command,
                    exit_code: output.exit_code,
                    diagnostics: parse_cargo_json_diagnostics(&output.combined, "cargo"),
                    output: output.combined,
                },
                Err(err) => SourceRun {
                    source: "cargo".to_string(),
                    command,
                    exit_code: None,
                    diagnostics: vec![],
                    output: err,
                },
            }
        }
        other => run_project_source(other, root).unwrap_or_else(|| SourceRun {
            source: other.to_string(),
            command: String::new(),
            exit_code: None,
            diagnostics: vec![],
            output: format!("unknown diagnostic source: {other}"),
        }),
    }
}

fn run_deep_source(source: &str, root: &Path) -> SourceRun {
    match source {
        "project-inspect" => inspect_project_files(root),
        "css-assets" => scan_css_assets(root),
        "npm-audit" => run_shell_parsed_timeout(
            "npm audit --json",
            root,
            "npm-audit",
            parse_npm_audit_diagnostics,
            Duration::from_secs(20),
        ),
        "go-vet" => run_shell_parsed_timeout(
            "go vet ./...",
            root,
            "go-vet",
            parse_generic_colon_diagnostics,
            Duration::from_secs(20),
        ),
        /* `go build ./...` catches compile errors across every package
        without running tests — running tests during a "diagnostic
        scan" is destructive (network, side effects, slow). */
        "go-build" => run_shell_parsed_timeout(
            "go build ./...",
            root,
            "go-build",
            parse_generic_colon_diagnostics,
            Duration::from_secs(30),
        ),
        "maven-compile" => run_shell_parsed_timeout(
            "mvn -q -DskipTests compile",
            root,
            "maven-compile",
            parse_jvm_build_diagnostics,
            Duration::from_secs(45),
        ),
        "gradle-build" => run_shell_parsed_timeout(
            &gradle_build_command(root),
            root,
            "gradle-build",
            parse_jvm_build_diagnostics,
            Duration::from_secs(45),
        ),
        "dotnet-build" => run_shell_parsed_timeout(
            "dotnet build --nologo",
            root,
            "dotnet-build",
            parse_msbuild_diagnostics,
            Duration::from_secs(45),
        ),
        "sbt-compile" => run_shell_parsed_timeout(
            "sbt -batch compile",
            root,
            "sbt-compile",
            parse_jvm_build_diagnostics,
            Duration::from_secs(45),
        ),
        "mix-compile" => run_shell_parsed_timeout(
            "mix compile --warnings-as-errors",
            root,
            "mix-compile",
            parse_generic_colon_diagnostics,
            Duration::from_secs(30),
        ),
        "composer-validate" => run_shell_parsed_timeout(
            "composer validate --no-check-publish --no-interaction",
            root,
            "composer-validate",
            parse_composer_validate_diagnostics,
            Duration::from_secs(20),
        ),
        "swift-build" => run_shell_parsed_timeout(
            "swift build",
            root,
            "swift-build",
            parse_generic_colon_diagnostics,
            Duration::from_secs(45),
        ),
        "dart-analyze" => run_shell_parsed_timeout(
            "dart analyze",
            root,
            "dart-analyze",
            parse_dart_analyze_diagnostics,
            Duration::from_secs(30),
        ),
        "flutter-analyze" => run_shell_parsed_timeout(
            "flutter analyze",
            root,
            "flutter-analyze",
            parse_dart_analyze_diagnostics,
            Duration::from_secs(45),
        ),
        "python-compile" => run_shell_parsed_timeout(
            "python3 -m compileall -q .",
            root,
            "python-compile",
            parse_python_compile_diagnostics,
            Duration::from_secs(20),
        ),
        "ruff" => run_shell_parsed_timeout(
            "python3 -m ruff check --output-format=concise .",
            root,
            "ruff",
            parse_generic_colon_diagnostics,
            Duration::from_secs(20),
        ),
        "ruby-syntax" => run_per_file_check(
            root,
            "ruby-syntax",
            &["rb"],
            |file| format!("ruby -wc {}", shell_quote(file)),
            parse_generic_colon_diagnostics,
        ),
        "php-lint" => run_per_file_check(
            root,
            "php-lint",
            &["php"],
            |file| format!("php -l {}", shell_quote(file)),
            parse_php_lint_diagnostics,
        ),
        "lua-syntax" => run_per_file_check(
            root,
            "lua-syntax",
            &["lua"],
            |file| format!("luac -p {}", shell_quote(file)),
            parse_luac_diagnostics,
        ),
        "shellcheck" => run_shell_parsed_timeout(
            /* shellcheck reads paths from stdin via `-`; collect every
            *.sh / *.bash file under the project and pipe them in. */
            "find . \\( -name '*.sh' -o -name '*.bash' \\) -not -path './node_modules/*' -not -path './target/*' -not -path './dist/*' -not -path './build/*' -print0 | xargs -0 -r shellcheck -f gcc",
            root,
            "shellcheck",
            parse_generic_colon_diagnostics,
            Duration::from_secs(30),
        ),
        "bash-syntax" => run_per_file_check(
            root,
            "bash-syntax",
            &["sh", "bash"],
            |file| format!("bash -n {}", shell_quote(file)),
            parse_bash_syntax_diagnostics,
        ),
        other => run_source(other, root),
    }
}

fn has_any(root: &Path, names: &[&str]) -> bool {
    names.iter().any(|name| root.join(name).exists())
}

fn gradle_build_command(root: &Path) -> String {
    if root.join("gradlew").exists() {
        "./gradlew build -x test".to_string()
    } else {
        "gradle build -x test".to_string()
    }
}

fn shell_quote(path: &Path) -> String {
    /* single-quote escape: ' → '\''  */
    let raw = path.to_string_lossy();
    let escaped = raw.replace('\'', "'\\''");
    format!("'{escaped}'")
}

/* runs `command_for(file)` for every matching file under `root`, aggregates
the parsed diagnostics, and caps the work so a giant repo can't stall the
scan. each invocation has its own 4s timeout; the whole pass is capped at
80 files to keep cold scans snappy on macro-projects. */
fn run_per_file_check<F>(
    root: &Path,
    source: &str,
    extensions: &[&str],
    command_for: F,
    parser: fn(&str, &str) -> Vec<Diagnostic>,
) -> SourceRun
where
    F: Fn(&Path) -> String,
{
    const MAX_FILES: usize = 80;
    let files: Vec<PathBuf> = project_files(root, 1500)
        .into_iter()
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| extensions.contains(&ext))
                .unwrap_or(false)
        })
        .take(MAX_FILES)
        .collect();

    if files.is_empty() {
        return SourceRun {
            source: source.to_string(),
            command: String::new(),
            exit_code: Some(0),
            diagnostics: vec![],
            output: format!("{source}: no matching files"),
        };
    }

    let mut diagnostics = Vec::new();
    let mut output = String::new();
    let mut worst_exit: Option<i32> = None;
    let mut commands = Vec::new();

    for file in &files {
        let relative = file.strip_prefix(root).unwrap_or(file).to_path_buf();
        let command = command_for(&relative);
        commands.push(command.clone());
        let shell_output = match run_shell_timeout(&command, root, Duration::from_secs(4)) {
            Ok(out) => out,
            Err(err) => ShellOutput {
                exit_code: None,
                combined: err,
            },
        };
        if let Some(code) = shell_output.exit_code {
            worst_exit = Some(worst_exit.map_or(code, |existing| existing.max(code)));
        }
        diagnostics.extend(parser(&shell_output.combined, source));
        output.push_str(&shell_output.combined);
        output.push('\n');
    }

    SourceRun {
        source: source.to_string(),
        command: commands
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join(" && "),
        exit_code: worst_exit,
        diagnostics,
        output,
    }
}

fn pick_cargo_manifest(root: &Path) -> PathBuf {
    let nested = root.join("src-tauri").join("Cargo.toml");
    if nested.exists() {
        return nested;
    }
    root.join("Cargo.toml")
}

fn run_shell_parsed(
    command: &str,
    root: &Path,
    source: &str,
    parser: fn(&str, &str) -> Vec<Diagnostic>,
) -> SourceRun {
    run_shell_parsed_in(command, root, source, parser)
}

fn run_shell_parsed_timeout(
    command: &str,
    root: &Path,
    source: &str,
    parser: fn(&str, &str) -> Vec<Diagnostic>,
    timeout: Duration,
) -> SourceRun {
    let output_result = run_shell_timeout(command, root, timeout);
    let output = match output_result {
        Ok(output) => output,
        Err(err) => {
            return SourceRun {
                source: source.to_string(),
                command: command.to_string(),
                exit_code: None,
                diagnostics: vec![],
                output: err,
            };
        }
    };
    let diagnostics = parser(&output.combined, source);
    SourceRun {
        source: source.to_string(),
        command: command.to_string(),
        exit_code: output.exit_code,
        diagnostics,
        output: output.combined,
    }
}

struct ShellOutput {
    exit_code: Option<i32>,
    combined: String,
}

fn run_shell_timeout(command: &str, cwd: &Path, timeout: Duration) -> Result<ShellOutput, String> {
    let mut child = Command::new("sh")
        .arg("-lc")
        .arg(command)
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to run {command}: {err}"))?;

    let started = Instant::now();
    while started.elapsed() < timeout {
        match child.try_wait() {
            Ok(Some(_)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|err| format!("failed to read {command} output: {err}"))?;
                return Ok(ShellOutput {
                    exit_code: output.status.code(),
                    combined: format!(
                        "{}{}",
                        String::from_utf8_lossy(&output.stdout),
                        String::from_utf8_lossy(&output.stderr)
                    ),
                });
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(err) => return Err(format!("failed to poll {command}: {err}")),
        }
    }
    let _ = child.kill();
    let output = child
        .wait_with_output()
        .map_err(|err| format!("timed out and failed to read {command} output: {err}"))?;
    Ok(ShellOutput {
        exit_code: None,
        combined: format!(
            "timed out after {}s\n{}{}",
            timeout.as_secs(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ),
    })
}

fn run_shell_parsed_in(
    command: &str,
    cwd: &Path,
    source: &str,
    parser: fn(&str, &str) -> Vec<Diagnostic>,
) -> SourceRun {
    let output_result = Command::new("sh")
        .arg("-lc")
        .arg(command)
        .current_dir(cwd)
        .output();
    let output = match output_result {
        Ok(o) => o,
        Err(err) => {
            return SourceRun {
                source: source.to_string(),
                command: command.to_string(),
                exit_code: None,
                diagnostics: vec![],
                output: format!("failed to run {source}: {err}"),
            };
        }
    };
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let diagnostics = parser(&combined, source);
    SourceRun {
        source: source.to_string(),
        command: command.to_string(),
        exit_code: output.status.code(),
        diagnostics,
        output: combined,
    }
}

fn tail_output(combined: &str) -> String {
    /* keep the tail rather than the head — diagnostic tools typically
    print a summary at the end, and char-bounded slicing avoids
    splitting a multibyte sequence. */
    combined
        .chars()
        .rev()
        .take(20000)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn dedupe_diagnostics(items: Vec<Diagnostic>) -> Vec<Diagnostic> {
    let mut seen = HashSet::new();
    items
        .into_iter()
        .filter(|item| {
            seen.insert(format!(
                "{}:{}:{}:{}:{}",
                item.source,
                item.file,
                item.range.start.line,
                item.range.start.column,
                item.message
            ))
        })
        .collect()
}

/* directory names we always skip even when not gitignored. covers most
build/cache/vendor layouts across ecosystems so scans don't drown in
generated noise on projects without a .gitignore. nested
`src-tauri/target` is handled by the recursive walk hitting `target`
again at that depth. */
const ALWAYS_SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".idea",
    ".vscode-test",
    ".polypore",
    ".turbo",
    ".cache",
    ".parcel-cache",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".astro",
    ".vercel",
    ".netlify",
    ".serverless",
    ".gradle",
    ".mvn",
    ".tox",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".ipynb_checkpoints",
    "__pycache__",
    "node_modules",
    "bower_components",
    "vendor",
    "Pods",
    "DerivedData",
    "dist",
    "build",
    "out",
    "bin",
    "obj",
    "coverage",
    "target",
    "reports",
    "venv",
    ".venv",
    "env",
    ".env.d",
    ".yarn",
    ".pnpm-store",
];

fn project_files(root: &Path, limit: usize) -> Vec<PathBuf> {
    let root = root.to_path_buf();
    let filter_root = root.clone();
    let walker = WalkBuilder::new(&root)
        .standard_filters(true)
        .hidden(false)
        .require_git(false)
        .parents(true)
        .filter_entry(move |entry| {
            !is_agent_worktree_path(&filter_root, entry.path())
                && entry
                    .file_name()
                    .to_str()
                    .map(|name| !ALWAYS_SKIP_DIRS.contains(&name))
                    .unwrap_or(true)
        })
        .build();
    let mut out = Vec::with_capacity(limit.min(4096));
    for entry in walker.flatten() {
        if out.len() >= limit {
            break;
        }
        if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            out.push(entry.into_path());
        }
    }
    out
}

fn is_agent_worktree_path(root: &Path, path: &Path) -> bool {
    let mut components = path
        .strip_prefix(root)
        .unwrap_or(path)
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(name) => name.to_str(),
            _ => None,
        });
    matches!(components.next(), Some(".claude")) && matches!(components.next(), Some("worktrees"))
}

mod inspect;
mod parsers;

pub(crate) use inspect::*;
pub use parsers::*;

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn line_range(line: i64, column: i64) -> Range {
    Range {
        start: Position { line, column },
        end: Position { line, column },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tsc_output() {
        let out = "src/foo.ts(12,5): error TS2304: Cannot find name 'bar'.\n";
        let diags = parse_typescript_diagnostics(out, "tsc");
        assert_eq!(diags.len(), 1);
        let d = &diags[0];
        assert_eq!(d.source, "tsc");
        assert_eq!(d.file, "src/foo.ts");
        assert_eq!(d.range.start.line, 11);
        assert_eq!(d.range.start.column, 4);
        assert_eq!(d.code.as_deref(), Some("TS2304"));
        assert_eq!(d.severity, "error");
    }

    #[test]
    fn parses_eslint_json_output() {
        let out = r#"npm warn from stderr
[{"filePath":"src/foo.ts","messages":[{"ruleId":"no-unused-vars","severity":2,"message":"'bar' is assigned a value but never used.","line":5,"column":10,"endLine":5,"endColumn":13}]}]"#;
        let diags = parse_eslint_json_diagnostics(out, "eslint");
        assert_eq!(diags.len(), 1);
        let d = &diags[0];
        assert_eq!(d.source, "eslint");
        assert_eq!(d.file, "src/foo.ts");
        assert_eq!(d.range.start.line, 4);
        assert_eq!(d.range.start.column, 9);
        assert_eq!(d.range.end.column, 12);
        assert_eq!(d.code.as_deref(), Some("no-unused-vars"));
        assert_eq!(d.severity, "error");
    }

    #[test]
    fn parses_cargo_json_output() {
        let out = r#"{"reason":"compiler-message","message":{"level":"warning","message":"unused variable: `x`","code":{"code":"unused_variables"},"spans":[{"file_name":"src/main.rs","line_start":3,"line_end":3,"column_start":9,"column_end":10,"is_primary":true}]}}
{"reason":"build-script-executed","package_id":"foo"}
"#;
        let diags = parse_cargo_json_diagnostics(out, "cargo");
        assert_eq!(diags.len(), 1);
        let d = &diags[0];
        assert_eq!(d.source, "cargo");
        assert_eq!(d.file, "src/main.rs");
        assert_eq!(d.range.start.line, 2);
        assert_eq!(d.range.start.column, 8);
        assert_eq!(d.severity, "warn");
        assert_eq!(d.code.as_deref(), Some("unused_variables"));
    }

    #[test]
    fn ignores_non_json_lines_in_cargo_output() {
        let out = "warning: unused variable\nrandom text\n";
        let diags = parse_cargo_json_diagnostics(out, "cargo");
        assert!(diags.is_empty());
    }

    #[test]
    fn auto_detect_picks_up_cargo_and_tsc() {
        let dir = std::env::temp_dir().join(format!(
            "polypore-diag-detect-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tsconfig.json"), "{}").unwrap();
        std::fs::write(dir.join("Cargo.toml"), "[package]\nname='x'").unwrap();
        let sources = auto_detect_sources(&dir);
        assert!(sources.contains(&"tsc".to_string()));
        assert!(sources.contains(&"cargo".to_string()));
        assert!(!sources.contains(&"eslint".to_string()));
        std::fs::remove_dir_all(&dir).ok();
    }

    fn temp_project(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "polypore-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(dir.join(".polypore")).unwrap();
        dir
    }

    #[test]
    fn project_diagnostics_sources_join_auto_detect() {
        let dir = temp_project("diag-project");
        std::fs::write(
            dir.join(".polypore").join("diagnostics.json"),
            r#"{"sources":[
                {"id":"mylang","command":"mylang check","parser":"generic-colon"},
                {"id":"slow-audit","command":"audit --deep","deep":true}
            ]}"#,
        )
        .unwrap();

        let light = auto_detect_sources(&dir);
        assert!(light.contains(&"mylang".to_string()));
        // deep-only sources stay out of the fast collect.
        assert!(!light.contains(&"slow-audit".to_string()));

        let deep = auto_detect_deep_sources(&dir);
        assert!(deep.contains(&"mylang".to_string()));
        assert!(deep.contains(&"slow-audit".to_string()));
        // not duplicated across the two phases.
        assert_eq!(deep.iter().filter(|id| id.as_str() == "mylang").count(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn project_diagnostics_resolve_named_parser() {
        let dir = temp_project("diag-parser");
        std::fs::write(
            dir.join(".polypore").join("diagnostics.json"),
            r#"{"sources":[{"id":"echoer","command":"echo 'src/x.go:4:2: bad thing'","parser":"generic-colon"}]}"#,
        )
        .unwrap();

        let run = run_project_source("echoer", &dir).expect("source resolves");
        assert_eq!(run.source, "echoer");
        assert_eq!(run.diagnostics.len(), 1);
        assert_eq!(run.diagnostics[0].file, "src/x.go");
        assert_eq!(run.diagnostics[0].range.start.line, 3);

        assert!(run_project_source("missing", &dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn project_diagnostics_accept_bare_array() {
        let dir = temp_project("diag-bare");
        std::fs::write(
            dir.join(".polypore").join("diagnostics.json"),
            r#"[{"id":"bare","command":"true"}]"#,
        )
        .unwrap();
        let sources = load_project_diagnostic_sources(&dir);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].id, "bare");
        // default parser/deep when omitted.
        assert!(!sources[0].deep);
        assert!(sources[0].parser.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn auto_detect_does_not_assume_package_json_means_typescript() {
        let dir = std::env::temp_dir().join(format!(
            "polypore-plain-package-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), r#"{"name":"plain-js"}"#).unwrap();

        let sources = auto_detect_sources(&dir);

        assert!(!sources.contains(&"tsc".to_string()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn auto_detect_picks_up_package_eslint_config() {
        let dir = std::env::temp_dir().join(format!(
            "polypore-eslint-detect-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), r#"{"eslintConfig":{"rules":{}}}"#).unwrap();

        let sources = auto_detect_sources(&dir);

        assert!(sources.contains(&"eslint".to_string()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn deep_auto_detect_covers_non_js_runtimes() {
        let dir = std::env::temp_dir().join(format!(
            "polypore-diag-deep-detect-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(dir.join("dotnet")).unwrap();
        std::fs::write(dir.join("pom.xml"), "<project />").unwrap();
        std::fs::write(dir.join("build.gradle.kts"), "").unwrap();
        std::fs::write(dir.join("dotnet").join("App.csproj"), "<Project />").unwrap();
        std::fs::write(dir.join("build.sbt"), r#"name := "app""#).unwrap();
        std::fs::write(dir.join("mix.exs"), "defmodule App.MixProject do end").unwrap();
        std::fs::write(dir.join("composer.json"), "{}").unwrap();
        std::fs::write(dir.join("Package.swift"), "// swift-tools-version: 5.10").unwrap();
        std::fs::write(
            dir.join("pubspec.yaml"),
            "dependencies:\n  flutter:\n    sdk: flutter\n",
        )
        .unwrap();

        let sources = auto_detect_deep_sources(&dir);

        for expected in [
            "maven-compile",
            "gradle-build",
            "dotnet-build",
            "sbt-compile",
            "mix-compile",
            "composer-validate",
            "swift-build",
            "flutter-analyze",
        ] {
            assert!(
                sources.contains(&expected.to_string()),
                "missing {expected}"
            );
        }
        assert!(!sources.contains(&"dart-analyze".to_string()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn generic_colon_parser_accepts_optional_column() {
        let diags =
            parse_generic_colon_diagnostics("lib/app.ex:12: undefined function run/0", "mix");
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].file, "lib/app.ex");
        assert_eq!(diags[0].range.start.line, 11);
        assert_eq!(diags[0].range.start.column, 0);
    }

    #[test]
    fn parses_jvm_bracket_and_kotlin_compiler_output() {
        let output = "[ERROR] src/main/java/App.java:[7,13] cannot find symbol\n\
e: file://src/main/kotlin/App.kt: (4, 9): Unresolved reference: missing\n";
        let diags = parse_jvm_build_diagnostics(output, "maven-compile");
        assert_eq!(diags.len(), 2);
        assert_eq!(diags[0].file, "src/main/java/App.java");
        assert_eq!(diags[0].range.start.line, 6);
        assert_eq!(diags[0].range.start.column, 12);
        assert_eq!(diags[1].file, "src/main/kotlin/App.kt");
        assert_eq!(diags[1].range.start.line, 3);
        assert_eq!(diags[1].range.start.column, 8);
    }

    #[test]
    fn parses_msbuild_output() {
        let output =
            "Program.cs(12,18): error CS0103: The name 'x' does not exist in the current context";
        let diags = parse_msbuild_diagnostics(output, "dotnet-build");
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].file, "Program.cs");
        assert_eq!(diags[0].code.as_deref(), Some("CS0103"));
        assert_eq!(diags[0].range.start.line, 11);
        assert_eq!(diags[0].range.start.column, 17);
    }

    #[test]
    fn parses_dart_and_composer_diagnostics() {
        let dart = parse_dart_analyze_diagnostics(
            "error - lib/main.dart:3:1 - Undefined name 'missing' - undefined_identifier",
            "dart-analyze",
        );
        assert_eq!(dart.len(), 1);
        assert_eq!(dart[0].file, "lib/main.dart");
        assert_eq!(dart[0].code.as_deref(), Some("undefined_identifier"));

        let composer = parse_composer_validate_diagnostics(
            "[ERROR] require.vendor is invalid",
            "composer-validate",
        );
        assert_eq!(composer.len(), 1);
        assert_eq!(composer[0].file, "composer.json");
    }

    #[test]
    fn project_inspection_finds_integrity_problems() {
        let dir = std::env::temp_dir().join(format!(
            "polypore-project-inspect-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let src = dir.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("present.ts"), "export const present = true;\n").unwrap();
        std::fs::write(
            src.join("index.ts"),
            "import './present';\nimport './missing';\n<<<<<<< HEAD\n",
        )
        .unwrap();
        std::fs::write(dir.join("broken.json"), "{\"open\": true").unwrap();
        std::fs::write(
            dir.join("tsconfig.json"),
            "{\n  // TypeScript permits comments here.\n  \"compilerOptions\": {}\n}\n",
        )
        .unwrap();

        let run = inspect_project_files(&dir);

        assert!(run
            .diagnostics
            .iter()
            .any(|item| item.code.as_deref() == Some("unresolved-import")));
        assert!(run
            .diagnostics
            .iter()
            .any(|item| item.code.as_deref() == Some("merge-conflict")));
        assert!(run
            .diagnostics
            .iter()
            .any(|item| item.code.as_deref() == Some("invalid-json")));
        assert!(!run
            .diagnostics
            .iter()
            .any(|item| item.message.contains("./present")));
        assert!(!run.diagnostics.iter().any(
            |item| item.file == "tsconfig.json" && item.code.as_deref() == Some("invalid-json")
        ));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn module_resolver_handles_unrecognized_extensions() {
        let dir = std::env::temp_dir().join(format!(
            "polypore-mod-resolve-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let src = dir.join("pkg").join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("types.gen.ts"), "export type T = unknown;\n").unwrap();
        std::fs::write(src.join("validators.gen.ts"), "export const v = 1;\n").unwrap();
        std::fs::write(src.join("typed.d.ts"), "export type X = number;\n").unwrap();
        let importer = src.join("index.ts");
        std::fs::write(
            &importer,
            "import './types.gen';\nimport './validators.gen';\nimport './typed';\nimport './missing.gen';\n",
        )
        .unwrap();

        assert!(local_module_exists(&dir, &importer, "./types.gen"));
        assert!(local_module_exists(&dir, &importer, "./validators.gen"));
        assert!(local_module_exists(&dir, &importer, "./typed"));
        assert!(!local_module_exists(&dir, &importer, "./missing.gen"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn custom_property_collector_picks_up_jsx_inline_styles() {
        let mut props = HashSet::new();
        collect_custom_properties_from_text(
            "style={{ '--knowledge-depth': depth } as React.CSSProperties}",
            &mut props,
        );
        collect_custom_properties_from_text(
            "el.style.setProperty(\"--ring-color\", value);",
            &mut props,
        );
        collect_custom_properties_from_text(":root { --honey: #c58b31; }", &mut props);
        /* `var(--foo)` is a reference, not a definition — must not get
        recorded as one. */
        collect_custom_properties_from_text("color: var(--undefined);", &mut props);

        assert!(props.contains("--knowledge-depth"));
        assert!(props.contains("--ring-color"));
        assert!(props.contains("--honey"));
        assert!(!props.contains("--undefined"));
    }

    #[test]
    fn module_scanner_ignores_strings_and_comments() {
        let source = r#"
            // import './ignored-line-comment';
            /* import './ignored-block-comment'; */
            const message = "import './ignored-string-literal'";
            import './kept-statement';
            import x from './kept-named';
            const dyn = await import('./kept-dynamic');
            const cjs = require('./kept-require');
            const meta = import.meta.url; // not an import target
        "#;
        let imports = scan_module_imports(source);
        let specs: Vec<&str> = imports.iter().map(|i| i.specifier.as_str()).collect();
        assert!(specs.contains(&"./kept-statement"));
        assert!(specs.contains(&"./kept-named"));
        assert!(specs.contains(&"./kept-dynamic"));
        assert!(specs.contains(&"./kept-require"));
        assert!(!specs.iter().any(|s| s.contains("ignored")));
    }

    #[test]
    fn module_scanner_handles_multiline_imports() {
        let source = r#"
            import {
              a,
              b,
            } from './multiline';
        "#;
        let imports = scan_module_imports(source);
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].specifier, "./multiline");
    }

    #[test]
    fn tsconfig_aliases_resolve_path_mappings() {
        let dir = std::env::temp_dir().join(format!(
            "polypore-tsconfig-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(dir.join("src/components")).unwrap();
        std::fs::write(
            dir.join("tsconfig.json"),
            r#"{
              // jsonc with a comment
              "compilerOptions": {
                "baseUrl": ".",
                "paths": {
                  "@components/*": ["src/components/*"],
                },
              },
            }"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("src/components/Button.tsx"),
            "export const Button = () => null;",
        )
        .unwrap();
        let aliases = TsConfigAliases::load(&dir);
        let resolved = aliases
            .resolve("@components/Button", &dir)
            .expect("alias should resolve");
        assert!(resolved
            .iter()
            .any(|p| p.ends_with("src/components/Button")));
        let missing = aliases
            .resolve("@components/Missing", &dir)
            .expect("alias prefix should still match");
        assert!(missing.iter().all(|p| !p.exists()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn css_import_paths_extracts_bare_string_form() {
        assert_eq!(
            css_import_paths("@import \"./base.css\";"),
            vec!["./base.css"]
        );
        assert_eq!(
            css_import_paths("@import 'layer.css' layer(reset);"),
            vec!["layer.css"]
        );
        /* the url(...) form is left to css_urls so we don't double-count. */
        assert!(css_import_paths("@import url(\"./via-url.css\");").is_empty());
        assert!(css_import_paths("/* @import \"./commented.css\"; */").is_empty());
    }

    #[test]
    fn strip_json_comments_handles_line_block_and_trailing_commas() {
        let input = r#"{
            "a": 1, // line
            /* block */
            "b": [1, 2,],
            "c": { "d": 3, },
        }"#;
        let stripped = strip_json_comments(input);
        let parsed: serde_json::Value = serde_json::from_str(&stripped).expect("should parse");
        assert_eq!(parsed["a"], 1);
        assert_eq!(parsed["b"], serde_json::json!([1, 2]));
        assert_eq!(parsed["c"]["d"], 3);
    }

    #[test]
    fn toml_inspector_flags_invalid_syntax() {
        let dir = std::env::temp_dir().join(format!(
            "polypore-toml-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("good.toml"), "[a]\nb = 1\n").unwrap();
        std::fs::write(dir.join("bad.toml"), "[a\nb = 1\n").unwrap();
        let mut diags = Vec::new();
        inspect_toml_file(&dir, &dir.join("good.toml"), &mut diags);
        inspect_toml_file(&dir, &dir.join("bad.toml"), &mut diags);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].file, "bad.toml");
        assert_eq!(diags[0].code.as_deref(), Some("invalid-toml"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parses_php_lint_output() {
        let output = "Parse error: syntax error, unexpected token \";\" in /tmp/foo.php on line 7\nErrors parsing /tmp/foo.php\n";
        let diags = parse_php_lint_diagnostics(output, "php-lint");
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].file, "/tmp/foo.php");
        assert_eq!(diags[0].range.start.line, 6);
    }

    #[test]
    fn parses_luac_output() {
        let output = "luac: foo.lua:4: '=' expected near '<eof>'\n";
        let diags = parse_luac_diagnostics(output, "lua-syntax");
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].file, "foo.lua");
        assert_eq!(diags[0].range.start.line, 3);
        assert!(diags[0].message.contains("expected"));
    }

    #[test]
    fn parses_bash_syntax_output() {
        let output = "./scripts/deploy.sh: line 12: syntax error near unexpected token `fi'\n";
        let diags = parse_bash_syntax_diagnostics(output, "bash-syntax");
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].file, "./scripts/deploy.sh");
        assert_eq!(diags[0].range.start.line, 11);
    }

    #[test]
    fn project_walker_respects_gitignore_and_skip_dirs() {
        let dir = std::env::temp_dir().join(format!(
            "polypore-walk-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(dir.join("dist")).unwrap();
        std::fs::create_dir_all(dir.join("secret")).unwrap();
        std::fs::create_dir_all(dir.join(".claude/worktrees/agent-a39821ffefee81420/src")).unwrap();
        std::fs::create_dir_all(dir.join(".claude/orchestration")).unwrap();
        std::fs::write(dir.join("src/keep.ts"), "export {};\n").unwrap();
        std::fs::write(
            dir.join("node_modules/pkg/skip.js"),
            "module.exports = 1;\n",
        )
        .unwrap();
        std::fs::write(dir.join("dist/skip.js"), "1;\n").unwrap();
        std::fs::write(dir.join("secret/hidden.ts"), "//\n").unwrap();
        std::fs::write(
            dir.join(".claude/worktrees/agent-a39821ffefee81420/src/skip.ts"),
            "export {};\n",
        )
        .unwrap();
        std::fs::write(dir.join(".claude/orchestration/keep.md"), "# keep\n").unwrap();
        std::fs::write(dir.join(".gitignore"), "secret/\n").unwrap();

        let files = project_files(&dir, 200);
        let names: Vec<String> = files
            .iter()
            .filter_map(|p| p.strip_prefix(&dir).ok())
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .collect();

        assert!(names.iter().any(|n| n == "src/keep.ts"));
        assert!(!names.iter().any(|n| n.starts_with("node_modules")));
        assert!(!names.iter().any(|n| n.starts_with("dist")));
        assert!(!names.iter().any(|n| n.starts_with(".claude/worktrees")));
        assert!(names.iter().any(|n| n == ".claude/orchestration/keep.md"));
        assert!(
            !names.iter().any(|n| n.starts_with("secret")),
            ".gitignore entry should exclude secret/"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
