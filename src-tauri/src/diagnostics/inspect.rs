//! project-file inspections: structural checks polypore runs itself
//! (strict JSON/TOML parses, merge-conflict markers, local-import
//! resolution with tsconfig aliases, css asset references).

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use super::*;

pub(crate) fn inspect_project_files(root: &Path) -> SourceRun {
    let files = project_files(root, 3000);
    let aliases = TsConfigAliases::load(root);
    let mut diagnostics = vec![];
    for file in &files {
        let extension = file.extension().and_then(|ext| ext.to_str()).unwrap_or("");
        if extension == "json" && is_strict_json_file(file) {
            inspect_json_file(root, file, &mut diagnostics);
        }
        if extension == "toml" {
            inspect_toml_file(root, file, &mut diagnostics);
        }
        if !is_text_inspection_file(file) {
            continue;
        }
        let Ok(text) = fs::read_to_string(file) else {
            continue;
        };
        let relative = relative_path(root, file);
        inspect_conflict_markers(&relative, &text, &mut diagnostics);
        if is_module_source_file(file) {
            inspect_local_module_references(
                root,
                file,
                &relative,
                &text,
                &aliases,
                &mut diagnostics,
            );
        }
    }

    SourceRun {
        source: "project-inspect".to_string(),
        command: "deep project file inspection".to_string(),
        exit_code: Some(if diagnostics.iter().any(|item| item.severity == "error") {
            1
        } else {
            0
        }),
        output: format!("inspected {} project file(s)", files.len()),
        diagnostics,
    }
}

pub(crate) fn inspect_json_file(root: &Path, file: &Path, diagnostics: &mut Vec<Diagnostic>) {
    let Ok(text) = fs::read_to_string(file) else {
        return;
    };
    let Err(err) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let line = err.line().saturating_sub(1) as i64;
    let column = err.column().saturating_sub(1) as i64;
    let relative = relative_path(root, file);
    diagnostics.push(Diagnostic {
        id: format!("project-json-{relative}-{line}-{column}"),
        severity: "error".to_string(),
        source: "project-inspect".to_string(),
        file: relative,
        range: line_range(line, column),
        message: format!("Invalid JSON: {err}"),
        code: Some("invalid-json".to_string()),
    });
}

pub(crate) fn is_strict_json_file(path: &Path) -> bool {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");

    /* known JSON-with-comments names — these permit `// ...` and `/* ... */`
    so strict JSON parsing would surface false errors. */
    if filename.starts_with("tsconfig")
        || filename == "jsconfig.json"
        || filename == "devcontainer.json"
        || filename == "deno.json"
        || filename == "deno.jsonc"
        || filename == "biome.json"
        || filename == "biome.jsonc"
        || filename == "turbo.json"
        || filename.ends_with(".jsonc")
        || filename.ends_with(".code-workspace")
    {
        return false;
    }

    /* anything under .vscode/ or .devcontainer/ is conventionally JSONC. */
    let in_jsonc_dir = path.components().any(|part| {
        let part = part.as_os_str();
        part == ".vscode" || part == ".devcontainer"
    });
    !in_jsonc_dir
}

pub(crate) fn inspect_toml_file(root: &Path, file: &Path, diagnostics: &mut Vec<Diagnostic>) {
    let Ok(text) = fs::read_to_string(file) else {
        return;
    };
    let Err(err) = text.parse::<toml::Value>() else {
        return;
    };
    let (line, column) = err
        .span()
        .map(|span| byte_offset_to_position(&text, span.start))
        .unwrap_or((0, 0));
    let relative = relative_path(root, file);
    diagnostics.push(Diagnostic {
        id: format!("project-toml-{relative}-{line}-{column}"),
        severity: "error".to_string(),
        source: "project-inspect".to_string(),
        file: relative,
        range: line_range(line, column),
        message: format!("Invalid TOML: {}", err.message()),
        code: Some("invalid-toml".to_string()),
    });
}

pub(crate) fn byte_offset_to_position(text: &str, offset: usize) -> (i64, i64) {
    let mut line = 0i64;
    let mut column = 0i64;
    for (idx, ch) in text.char_indices() {
        if idx >= offset {
            break;
        }
        if ch == '\n' {
            line += 1;
            column = 0;
        } else {
            column += 1;
        }
    }
    (line, column)
}

/* tsconfig path-alias resolver. parsed once per scan from the project's
tsconfig.json (or jsconfig.json). when an import specifier matches a
configured prefix, `resolve` returns the candidate filesystem locations
it could map to; the caller then checks which exist. */
#[derive(Debug, Default)]
pub(crate) struct TsConfigAliases {
    base_dir: Option<PathBuf>,
    base_url: Option<String>,
    paths: Vec<(String, Vec<String>)>,
}

impl TsConfigAliases {
    pub(crate) fn load(root: &Path) -> Self {
        for name in ["tsconfig.json", "jsconfig.json"] {
            let path = root.join(name);
            if let Some(parsed) = Self::parse_file(&path) {
                return parsed;
            }
        }
        Self::default()
    }

    fn parse_file(path: &Path) -> Option<Self> {
        let text = fs::read_to_string(path).ok()?;
        let stripped = strip_json_comments(&text);
        let value: serde_json::Value = serde_json::from_str(&stripped).ok()?;
        let compiler_options = value.get("compilerOptions")?;
        let base_url = compiler_options
            .get("baseUrl")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string());
        let paths: Vec<(String, Vec<String>)> = compiler_options
            .get("paths")
            .and_then(|value| value.as_object())
            .map(|map| {
                map.iter()
                    .filter_map(|(prefix, targets)| {
                        let targets = targets.as_array()?;
                        let target_strings: Vec<String> = targets
                            .iter()
                            .filter_map(|value| value.as_str().map(|s| s.to_string()))
                            .collect();
                        if target_strings.is_empty() {
                            None
                        } else {
                            Some((prefix.clone(), target_strings))
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        if base_url.is_none() && paths.is_empty() {
            return None;
        }
        Some(TsConfigAliases {
            base_dir: path.parent().map(|p| p.to_path_buf()),
            base_url,
            paths,
        })
    }

    pub(crate) fn resolve(&self, specifier: &str, root: &Path) -> Option<Vec<PathBuf>> {
        let base = self.base_dir.as_deref().unwrap_or(root).to_path_buf();
        let base_url_dir = self
            .base_url
            .as_deref()
            .map(|url| base.join(url))
            .unwrap_or_else(|| base.clone());

        for (prefix, targets) in &self.paths {
            if let Some(suffix) = match_path_prefix(prefix, specifier) {
                let candidates = targets
                    .iter()
                    .map(|target| base_url_dir.join(target.replace('*', &suffix)))
                    .collect();
                return Some(candidates);
            }
        }
        /* without a paths entry, bare specifiers under baseUrl can still
        resolve (TypeScript's classic / node10 behavior). only treat
        the specifier as an alias if a baseUrl is configured. */
        if self.base_url.is_some() && !specifier.is_empty() {
            return Some(vec![base_url_dir.join(specifier)]);
        }
        None
    }
}

pub(crate) fn match_path_prefix(pattern: &str, specifier: &str) -> Option<String> {
    if let Some(star) = pattern.find('*') {
        let head = &pattern[..star];
        let tail = &pattern[star + 1..];
        if specifier.starts_with(head) && specifier.ends_with(tail) {
            let end = specifier.len().saturating_sub(tail.len());
            if end >= head.len() {
                return Some(specifier[head.len()..end].to_string());
            }
        }
        None
    } else if pattern == specifier {
        Some(String::new())
    } else {
        None
    }
}

/* tsconfig.json is JSONC: line comments, block comments, and trailing
commas are permitted. strip them just enough that serde_json can parse
the remainder. preserves byte/line offsets so any future error
reporting still points to the right place. */
pub(crate) fn strip_json_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut i = 0;
    while i < n {
        let c = chars[i];
        if c == '/' && i + 1 < n && chars[i + 1] == '/' {
            out.push(' ');
            out.push(' ');
            i += 2;
            while i < n && chars[i] != '\n' {
                out.push(' ');
                i += 1;
            }
            continue;
        }
        if c == '/' && i + 1 < n && chars[i + 1] == '*' {
            out.push(' ');
            out.push(' ');
            i += 2;
            while i + 1 < n && !(chars[i] == '*' && chars[i + 1] == '/') {
                out.push(if chars[i] == '\n' { '\n' } else { ' ' });
                i += 1;
            }
            if i + 1 < n {
                out.push(' ');
                out.push(' ');
                i += 2;
            }
            continue;
        }
        if c == '"' {
            out.push(c);
            i += 1;
            while i < n && chars[i] != '"' {
                if chars[i] == '\\' && i + 1 < n {
                    out.push(chars[i]);
                    out.push(chars[i + 1]);
                    i += 2;
                    continue;
                }
                out.push(chars[i]);
                i += 1;
            }
            if i < n {
                out.push(chars[i]);
                i += 1;
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    /* strip trailing commas: `,]` and `,}` (with optional whitespace
    between). cheap regex-free pass. */
    let mut cleaned = String::with_capacity(out.len());
    let bytes: Vec<char> = out.chars().collect();
    let m = bytes.len();
    let mut j = 0;
    while j < m {
        if bytes[j] == ',' {
            let mut k = j + 1;
            while k < m && bytes[k].is_whitespace() {
                k += 1;
            }
            if k < m && (bytes[k] == ']' || bytes[k] == '}') {
                /* skip the comma */
                j += 1;
                continue;
            }
        }
        cleaned.push(bytes[j]);
        j += 1;
    }
    cleaned
}

pub(crate) fn inspect_conflict_markers(
    relative: &str,
    text: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let has_boundary = text.lines().any(|line| {
        let trimmed = line.trim_start();
        trimmed.starts_with("<<<<<<< ") || trimmed.starts_with(">>>>>>> ")
    });
    for (line_index, line) in text.lines().enumerate() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with("<<<<<<< ")
            && (!has_boundary || trimmed != "=======")
            && !trimmed.starts_with(">>>>>>> ")
        {
            continue;
        }
        diagnostics.push(Diagnostic {
            id: format!("project-conflict-{relative}-{line_index}"),
            severity: "error".to_string(),
            source: "project-inspect".to_string(),
            file: relative.to_string(),
            range: line_range(line_index as i64, 0),
            message: "Unresolved merge conflict marker".to_string(),
            code: Some("merge-conflict".to_string()),
        });
    }
}

pub(crate) fn inspect_local_module_references(
    root: &Path,
    file: &Path,
    relative: &str,
    text: &str,
    aliases: &TsConfigAliases,
    diagnostics: &mut Vec<Diagnostic>,
) {
    for import in scan_module_imports(text) {
        if !specifier_is_local_path(&import.specifier) {
            /* alias-mapped imports route through tsconfig.json's paths
            map. when no aliases are configured (or this specifier
            doesn't match one), treat it as a bare module — out of
            scope for our local-resolver. */
            if let Some(resolved) = aliases.resolve(&import.specifier, root) {
                if !resolved.iter().any(|path| path.exists()) {
                    diagnostics.push(Diagnostic {
                        id: format!(
                            "project-import-{relative}-{}-{}",
                            import.line, import.specifier
                        ),
                        severity: "error".to_string(),
                        source: "project-inspect".to_string(),
                        file: relative.to_string(),
                        range: line_range(import.line as i64, 0),
                        message: format!(
                            "Cannot resolve aliased module '{}' (no tsconfig path target exists)",
                            import.specifier
                        ),
                        code: Some("unresolved-import".to_string()),
                    });
                }
            }
            continue;
        }
        if local_module_exists(root, file, &import.specifier) {
            continue;
        }
        diagnostics.push(Diagnostic {
            id: format!(
                "project-import-{relative}-{}-{}",
                import.line, import.specifier
            ),
            severity: "error".to_string(),
            source: "project-inspect".to_string(),
            file: relative.to_string(),
            range: line_range(import.line as i64, 0),
            message: format!("Cannot resolve local module '{}'", import.specifier),
            code: Some("unresolved-import".to_string()),
        });
    }
}

pub(crate) fn specifier_is_local_path(specifier: &str) -> bool {
    specifier.starts_with('.') || specifier.starts_with('/')
}

#[derive(Debug)]
pub(crate) struct ImportRef {
    pub(crate) line: usize,
    pub(crate) specifier: String,
}

/* full-file scanner that walks the source one char at a time, tracking
comment + string state so it doesn't false-positive on:

  /* import "./foo" */     — block comment
  const m = 'import "./x"'; — literal string containing the keyword
  import.meta.url          — `import.X` is not a statement import

it captures the specifier of statement imports (`import "./x"`, `import
x from "./x"`), dynamic imports (`import("./x")`), and require calls
(`require("./x")`), regardless of how many newlines separate the
keyword from the target string. */
pub(crate) fn scan_module_imports(text: &str) -> Vec<ImportRef> {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut out = Vec::new();
    let mut line = 0usize;
    let mut i = 0usize;
    let mut import_pending = false;

    while i < n {
        let c = chars[i];

        if c == '\n' {
            line += 1;
            import_pending = false;
            i += 1;
            continue;
        }
        if c == ';' {
            import_pending = false;
            i += 1;
            continue;
        }
        if c == '/' && i + 1 < n && chars[i + 1] == '/' {
            while i < n && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && i + 1 < n && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < n && !(chars[i] == '*' && chars[i + 1] == '/') {
                if chars[i] == '\n' {
                    line += 1;
                }
                i += 1;
            }
            i = (i + 2).min(n);
            continue;
        }
        if c == '\'' || c == '"' {
            let quote = c;
            let start_line = line;
            let mut value = String::new();
            i += 1;
            while i < n && chars[i] != quote {
                if chars[i] == '\\' && i + 1 < n {
                    value.push(chars[i + 1]);
                    i += 2;
                    continue;
                }
                if chars[i] == '\n' {
                    /* unterminated single/double quote on this line —
                    bail rather than slurping the rest of the file. */
                    break;
                }
                value.push(chars[i]);
                i += 1;
            }
            if i < n && chars[i] == quote {
                i += 1;
            }
            if import_pending {
                out.push(ImportRef {
                    line: start_line,
                    specifier: value,
                });
                import_pending = false;
            }
            continue;
        }
        if c == '`' {
            i += 1;
            while i < n && chars[i] != '`' {
                if chars[i] == '\\' && i + 1 < n {
                    if chars[i + 1] == '\n' {
                        line += 1;
                    }
                    i += 2;
                    continue;
                }
                if chars[i] == '\n' {
                    line += 1;
                }
                if chars[i] == '$' && i + 1 < n && chars[i + 1] == '{' {
                    i += 2;
                    let mut depth = 1usize;
                    while i < n && depth > 0 {
                        if chars[i] == '\n' {
                            line += 1;
                        }
                        if chars[i] == '{' {
                            depth += 1;
                        } else if chars[i] == '}' {
                            depth -= 1;
                        }
                        i += 1;
                    }
                    continue;
                }
                i += 1;
            }
            if i < n {
                i += 1;
            }
            import_pending = false;
            continue;
        }
        if is_ident_start(c) {
            let start = i;
            while i < n && is_ident_part(chars[i]) {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            if word == "import" || word == "from" || word == "require" {
                let mut j = i;
                while j < n && (chars[j] == ' ' || chars[j] == '\t') {
                    j += 1;
                }
                if word == "import" {
                    if j < n && chars[j] == '.' {
                        /* `import.meta...` — not an import statement. */
                    } else if j < n && chars[j] == '(' {
                        import_pending = true;
                        i = j + 1;
                    } else {
                        import_pending = true;
                    }
                } else if word == "require" {
                    if j < n && chars[j] == '(' {
                        import_pending = true;
                        i = j + 1;
                    }
                } else {
                    import_pending = true;
                }
            }
            continue;
        }
        i += 1;
    }
    out
}

pub(crate) fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || c == '$'
}

pub(crate) fn is_ident_part(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

pub(crate) fn is_text_inspection_file(path: &Path) -> bool {
    let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    matches!(
        extension,
        "ts" | "tsx"
            | "mts"
            | "cts"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "vue"
            | "svelte"
            | "css"
            | "scss"
            | "sass"
            | "less"
            | "html"
            | "htm"
            | "json"
            | "md"
            | "rs"
            | "py"
            | "go"
            | "java"
            | "kt"
            | "kts"
            | "c"
            | "cc"
            | "cpp"
            | "h"
            | "hpp"
            | "yaml"
            | "yml"
    )
}

pub(crate) fn is_module_source_file(path: &Path) -> bool {
    let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    matches!(
        extension,
        "ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "mjs" | "cjs" | "vue" | "svelte"
    )
}

/* the set of extensions TypeScript / bundlers treat as a complete leaf path —
if the specifier ends in one of these and the file doesn't exist, we don't
attempt to append further extensions. anything else (no extension, or a
project-specific extension like `.gen`) goes through the append-loop because
TS resolves e.g. `./types.gen` to `./types.gen.ts`. */
const RESOLVABLE_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "css", "scss", "sass", "less",
    "svg", "png", "jpg", "jpeg", "gif", "webp",
];

pub(crate) fn local_module_exists(root: &Path, file: &Path, specifier: &str) -> bool {
    let specifier = specifier
        .split(['?', '#'])
        .next()
        .unwrap_or(specifier)
        .trim();
    if specifier.is_empty() {
        return true;
    }
    let base = file.parent().unwrap_or(root).join(specifier);
    if base.exists() {
        return true;
    }
    let extension_is_known_leaf = base
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| RESOLVABLE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false);
    if !extension_is_known_leaf {
        /* no extension OR an unrecognized extension (`.gen`, `.d`, etc.). TS
        resolves these by appending its own extensions onto the full
        filename, not by replacing — `./types.gen` → `./types.gen.ts`. */
        const APPEND_EXTENSIONS: &[&str] = &[
            "ts", "tsx", "d.ts", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "css", "scss",
            "sass", "less", "svg", "png", "jpg", "jpeg", "gif", "webp",
        ];
        for ext in APPEND_EXTENSIONS {
            if path_with_appended_extension(&base, ext).exists() {
                return true;
            }
            if base.join("index").with_extension(ext).exists() {
                return true;
            }
        }
        return false;
    }
    typescript_module_fallback_exists(&base)
}

pub(crate) fn path_with_appended_extension(base: &Path, ext: &str) -> PathBuf {
    let mut path = base.to_path_buf();
    let new_name = match base.file_name().and_then(|name| name.to_str()) {
        Some(name) => format!("{name}.{ext}"),
        None => format!(".{ext}"),
    };
    path.set_file_name(new_name);
    path
}

pub(crate) fn typescript_module_fallback_exists(base: &Path) -> bool {
    match base.extension().and_then(|ext| ext.to_str()) {
        Some("js") | Some("jsx") => {
            base.with_extension("ts").exists() || base.with_extension("tsx").exists()
        }
        Some("mjs") => base.with_extension("mts").exists(),
        Some("cjs") => base.with_extension("cts").exists(),
        _ => false,
    }
}

pub(crate) fn scan_css_assets(root: &Path) -> SourceRun {
    let mut diagnostics = vec![];
    let all_files = project_files(root, 3000);
    let css_files: Vec<PathBuf> = all_files
        .iter()
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("css"))
        .cloned()
        .collect();
    /* custom properties can be declared in CSS (`--foo: ...`) OR set at
    runtime via inline JSX styles (`style={{ '--foo': value }}`) or
    `setProperty('--foo', value)`. scanning module files alongside CSS
    eliminates a class of false "Cannot resolve" warnings for
    properties that only ever materialize from JS. */
    let mut custom_props = collect_css_custom_properties(&css_files);
    for file in &all_files {
        if !is_module_source_file(file) {
            continue;
        }
        let Ok(text) = fs::read_to_string(file) else {
            continue;
        };
        collect_custom_properties_from_text(&text, &mut custom_props);
    }

    for file in &css_files {
        let Ok(text) = fs::read_to_string(file) else {
            continue;
        };
        let relative = relative_path(root, file);
        for (line_index, line) in text.lines().enumerate() {
            let mut urls_to_check: Vec<String> = css_urls(line);
            urls_to_check.extend(css_import_paths(line));
            for url in urls_to_check {
                if url.starts_with("data:")
                    || url.starts_with("http://")
                    || url.starts_with("https://")
                    || url.starts_with('#')
                    || url.is_empty()
                {
                    continue;
                }
                let resolved = if url.starts_with('/') {
                    root.join("public").join(url.trim_start_matches('/'))
                } else {
                    file.parent().unwrap_or(root).join(&url)
                };
                if !resolved.exists() {
                    diagnostics.push(Diagnostic {
                        id: format!("css-assets-{}-{}-{}", relative, line_index, url),
                        severity: "error".to_string(),
                        source: "css-assets".to_string(),
                        file: relative.clone(),
                        range: line_range(line_index as i64, 0),
                        message: format!("Cannot resolve file '{url}'"),
                        code: Some("unresolved-url".to_string()),
                    });
                }
            }
            for prop in css_vars_without_fallback(line) {
                if !custom_props.contains(&prop) {
                    diagnostics.push(Diagnostic {
                        id: format!("css-var-{}-{}-{}", relative, line_index, prop),
                        severity: "warn".to_string(),
                        source: "css-assets".to_string(),
                        file: relative.clone(),
                        range: line_range(line_index as i64, 0),
                        message: format!("Cannot resolve '{prop}' custom property"),
                        code: Some("unresolved-var".to_string()),
                    });
                }
            }
        }
    }

    SourceRun {
        source: "css-assets".to_string(),
        command: "deep css asset/custom-property scan".to_string(),
        exit_code: Some(if diagnostics.iter().any(|d| d.severity == "error") {
            1
        } else {
            0
        }),
        output: format!("scanned {} css file(s)", css_files.len()),
        diagnostics,
    }
}

pub(crate) fn collect_css_custom_properties(files: &[PathBuf]) -> HashSet<String> {
    let mut props = HashSet::new();
    for file in files {
        let Ok(text) = fs::read_to_string(file) else {
            continue;
        };
        collect_custom_properties_from_text(&text, &mut props);
    }
    props
}

pub(crate) fn collect_custom_properties_from_text(text: &str, props: &mut HashSet<String>) {
    for line in text.lines() {
        let mut rest = line;
        while let Some(index) = rest.find("--") {
            rest = &rest[index..];
            let name: String = rest
                .chars()
                .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
                .collect();
            if name.len() > 2 && looks_like_custom_property_definition(&rest[name.len()..]) {
                props.insert(name.clone());
            }
            /* always advance at least past the `--` we matched, even when
            the name was just `--`, to avoid an infinite loop. */
            rest = &rest[name.len().max(2).min(rest.len())..];
        }
    }
}

/* a `--foo` reference counts as a definition site if it's followed by:
- `:` (CSS declaration: `--foo: 1px`)
- `':` or `":` (JSX object key: `{ '--foo': value }`)
- `',` or `",` (setProperty argument: `style.setProperty('--foo', value)`) */
pub(crate) fn looks_like_custom_property_definition(after: &str) -> bool {
    let after = after.trim_start_matches([' ', '\t']);
    if after.starts_with(':') {
        return true;
    }
    if let Some(rest) = after.strip_prefix(['\'', '"']) {
        let rest = rest.trim_start_matches([' ', '\t']);
        return rest.starts_with(':') || rest.starts_with(',');
    }
    false
}

pub(crate) fn css_urls(line: &str) -> Vec<String> {
    let mut urls = vec![];
    let mut rest = line;
    while let Some(index) = rest.find("url(") {
        rest = &rest[index + 4..];
        let Some(end) = rest.find(')') else { break };
        let url = rest[..end].trim().trim_matches(['"', '\'']).to_string();
        if !url.is_empty() {
            urls.push(url);
        }
        rest = &rest[end + 1..];
    }
    urls
}

/* `@import "path";` and `@import url("path");` are equivalent forms of the
same directive. the url(...) form is already picked up by `css_urls`, so
we only need to handle the bare-string variant here. layer/supports/media
qualifiers (e.g. `@import "a.css" layer(reset);`) prefix the string we
care about; the quoted segment is always the first quote-pair on the
line after `@import`. */
pub(crate) fn css_import_paths(line: &str) -> Vec<String> {
    let trimmed = line.trim_start();
    let Some(rest) = trimmed.strip_prefix("@import") else {
        return Vec::new();
    };
    let rest = rest.trim_start();
    /* url("...") form is handled by `css_urls` — avoid double-counting. */
    if rest.starts_with("url(") {
        return Vec::new();
    }
    let Some(quote) = rest.chars().next() else {
        return Vec::new();
    };
    if quote != '"' && quote != '\'' {
        return Vec::new();
    }
    let after = &rest[1..];
    let Some(end) = after.find(quote) else {
        return Vec::new();
    };
    vec![after[..end].to_string()]
}

pub(crate) fn css_vars_without_fallback(line: &str) -> Vec<String> {
    let mut vars = vec![];
    let mut rest = line;
    while let Some(index) = rest.find("var(") {
        rest = &rest[index + 4..];
        let Some(end) = rest.find(')') else { break };
        let body = rest[..end].trim();
        if !body.contains(',') {
            let prop = body.trim();
            if prop.starts_with("--") {
                vars.push(prop.to_string());
            }
        }
        rest = &rest[end + 1..];
    }
    vars
}
