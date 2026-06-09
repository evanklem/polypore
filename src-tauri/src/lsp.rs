use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::diagnostics::{Diagnostic, Position, Range};
use crate::project_context;

#[derive(Clone, Debug, serde::Serialize)]
pub struct LspServerStatus {
    pub id: String,
    pub command: String,
    pub available: bool,
    pub detail: String,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct LspStatus {
    pub servers: Vec<LspServerStatus>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct LspDiagnosticsResult {
    pub servers: Vec<LspServerStatus>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerSpec {
    id: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    extensions: Vec<String>,
    #[serde(default)]
    filenames: Vec<String>,
    #[serde(default)]
    language_ids: HashMap<String, String>,
}

#[derive(Clone, Debug, serde::Deserialize, Default)]
struct ProjectServerConfig {
    #[serde(default)]
    servers: Vec<ServerSpec>,
}

#[tauri::command]
pub fn lsp_status() -> LspStatus {
    let specs = active_project_server_specs().unwrap_or_default();
    LspStatus {
        servers: specs
            .iter()
            .map(|spec| probe(&spec.id, &spec.command))
            .collect(),
    }
}

#[tauri::command]
pub fn lsp_diagnostics_collect() -> Result<LspDiagnosticsResult, String> {
    let root = project_context::active_project_root()?;
    let files = collect_project_files(&root)?;
    let specs = server_specs(&root);
    let mut servers = vec![];
    let mut diagnostics = vec![];

    for spec in &specs {
        let matched: Vec<PathBuf> = files
            .iter()
            .filter(|path| matches_spec(path, spec))
            .take(80)
            .cloned()
            .collect();
        if matched.is_empty() {
            continue;
        }

        let status = probe(&spec.id, &spec.command);
        if !status.available {
            servers.push(status);
            continue;
        }

        match collect_from_server(spec, &root, &matched, None) {
            Ok(mut items) => {
                servers.push(LspServerStatus {
                    id: spec.id.to_string(),
                    command: command_line(spec),
                    available: true,
                    detail: format!("collected diagnostics for {} file(s)", matched.len()),
                });
                diagnostics.append(&mut items);
            }
            Err(err) => servers.push(LspServerStatus {
                id: spec.id.to_string(),
                command: command_line(spec),
                available: false,
                detail: err,
            }),
        }
    }

    Ok(LspDiagnosticsResult {
        servers,
        diagnostics,
    })
}

#[tauri::command]
pub fn lsp_diagnostics_document(
    path: String,
    text: String,
) -> Result<LspDiagnosticsResult, String> {
    let root = project_context::active_project_root()?;
    let relative = sanitize_relative_document_path(&path)?;
    let file = root.join(&relative);
    let specs = server_specs(&root);
    let mut servers = vec![];
    let mut diagnostics = vec![];

    for spec in specs.iter().filter(|spec| matches_spec(&file, spec)) {
        match collect_from_server(
            spec,
            &root,
            std::slice::from_ref(&file),
            Some((&file, text.as_str())),
        ) {
            Ok(mut items) => {
                servers.push(LspServerStatus {
                    id: spec.id.clone(),
                    command: command_line(spec),
                    available: true,
                    detail: format!("collected diagnostics for {}", relative.display()),
                });
                diagnostics.append(&mut items);
            }
            Err(err) => servers.push(LspServerStatus {
                id: spec.id.clone(),
                command: command_line(spec),
                available: false,
                detail: err,
            }),
        }
    }

    Ok(LspDiagnosticsResult {
        servers,
        diagnostics,
    })
}

fn probe(id: &str, command: &str) -> LspServerStatus {
    let started = Instant::now();
    let mut child = match Command::new(command).arg("--version").spawn() {
        Ok(child) => child,
        Err(err) => {
            return LspServerStatus {
                id: id.to_string(),
                command: command.to_string(),
                available: false,
                detail: format!("not available: {err}"),
            };
        }
    };

    while started.elapsed() < Duration::from_secs(2) {
        match child.try_wait() {
            Ok(Some(status)) => {
                return LspServerStatus {
                    id: id.to_string(),
                    command: command.to_string(),
                    available: true,
                    detail: if status.success() {
                        "available".to_string()
                    } else {
                        "executable found; version probe returned non-zero".to_string()
                    },
                };
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(err) => {
                return LspServerStatus {
                    id: id.to_string(),
                    command: command.to_string(),
                    available: false,
                    detail: format!("probe failed: {err}"),
                };
            }
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    LspServerStatus {
        id: id.to_string(),
        command: command.to_string(),
        available: true,
        detail: "executable found; version probe timed out".to_string(),
    }
}

fn collect_from_server(
    spec: &ServerSpec,
    root: &Path,
    files: &[PathBuf],
    document_override: Option<(&Path, &str)>,
) -> Result<Vec<Diagnostic>, String> {
    let mut child = Command::new(&spec.command)
        .args(&spec.args)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("failed to start {}: {err}", spec.id))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| format!("{} stdin unavailable", spec.id))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{} stdout unavailable", spec.id))?;
    let (tx, rx) = mpsc::channel::<serde_json::Value>();
    thread::spawn(move || read_lsp_messages(stdout, tx));

    let root_uri = path_to_uri(root);
    send_request(
        &mut stdin,
        1,
        "initialize",
        serde_json::json!({
            "processId": std::process::id(),
            "rootUri": root_uri,
            "capabilities": {
                "textDocument": {
                    "publishDiagnostics": {
                        "relatedInformation": false,
                        "versionSupport": false
                    }
                }
            }
        }),
    )?;
    wait_for_response(&rx, 1, Duration::from_secs(5))?;
    send_notification(&mut stdin, "initialized", serde_json::json!({}))?;

    let mut uri_to_path = HashMap::new();
    for file in files {
        let text = document_override
            .filter(|(path, _)| *path == file.as_path())
            .map(|(_, text)| text.to_string())
            .or_else(|| fs::read_to_string(file).ok());
        let Some(text) = text else { continue };
        let uri = path_to_uri(file);
        uri_to_path.insert(uri.clone(), relative_path(root, file));
        send_notification(
            &mut stdin,
            "textDocument/didOpen",
            serde_json::json!({
                "textDocument": {
                    "uri": uri,
                    "languageId": language_id(file, spec),
                    "version": 1,
                    "text": text
                }
            }),
        )?;
    }

    let diagnostics =
        collect_publish_diagnostics(&rx, &spec.id, &uri_to_path, Duration::from_secs(3));
    let _ = send_request(&mut stdin, 2, "shutdown", serde_json::json!(null));
    let _ = send_notification(&mut stdin, "exit", serde_json::json!(null));
    stop_child(child);
    Ok(diagnostics)
}

fn read_lsp_messages<R: Read>(reader: R, tx: mpsc::Sender<serde_json::Value>) {
    let mut reader = BufReader::new(reader);
    loop {
        let mut content_length: Option<usize> = None;
        loop {
            let mut header = String::new();
            let Ok(n) = reader.read_line(&mut header) else {
                return;
            };
            if n == 0 {
                return;
            }
            let header = header.trim_end_matches(['\r', '\n']);
            if header.is_empty() {
                break;
            }
            if let Some(value) = header.strip_prefix("Content-Length:") {
                content_length = value.trim().parse::<usize>().ok();
            }
        }
        let Some(len) = content_length else { continue };
        let mut body = vec![0_u8; len];
        if reader.read_exact(&mut body).is_err() {
            return;
        }
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) {
            let _ = tx.send(value);
        }
    }
}

fn wait_for_response(
    rx: &mpsc::Receiver<serde_json::Value>,
    id: i64,
    timeout: Duration,
) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(value) if value.get("id").and_then(|item| item.as_i64()) == Some(id) => {
                if let Some(err) = value.get("error") {
                    return Err(format!("lsp initialize failed: {err}"));
                }
                return Ok(());
            }
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => return Err("lsp server stopped during initialize".to_string()),
        }
    }
    Err("lsp initialize timed out".to_string())
}

fn collect_publish_diagnostics(
    rx: &mpsc::Receiver<serde_json::Value>,
    source: &str,
    uri_to_path: &HashMap<String, String>,
    timeout: Duration,
) -> Vec<Diagnostic> {
    let started = Instant::now();
    let mut by_file: HashMap<String, Vec<Diagnostic>> = HashMap::new();
    while started.elapsed() < timeout {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(value) => {
                if value.get("method").and_then(|m| m.as_str())
                    != Some("textDocument/publishDiagnostics")
                {
                    continue;
                }
                let Some(params) = value.get("params") else {
                    continue;
                };
                let Some(uri) = params.get("uri").and_then(|item| item.as_str()) else {
                    continue;
                };
                let file = uri_to_path
                    .get(uri)
                    .cloned()
                    .unwrap_or_else(|| uri_to_path_lossy(uri));
                let items = params
                    .get("diagnostics")
                    .and_then(|item| item.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .enumerate()
                            .filter_map(|(index, item)| {
                                lsp_diagnostic_to_polypore(source, &file, index, item)
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                by_file.insert(file, items);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => break,
        }
    }
    by_file.into_values().flatten().collect()
}

fn lsp_diagnostic_to_polypore(
    source: &str,
    file: &str,
    index: usize,
    item: &serde_json::Value,
) -> Option<Diagnostic> {
    let range = item.get("range")?;
    let start = range.get("start")?;
    let end = range.get("end").unwrap_or(start);
    let message = item.get("message")?.as_str()?.to_string();
    let severity = match item
        .get("severity")
        .and_then(|value| value.as_i64())
        .unwrap_or(1)
    {
        1 => "error",
        2 => "warn",
        3 => "info",
        4 => "hint",
        _ => "info",
    };
    let code = item.get("code").and_then(|code| {
        code.as_str()
            .map(|value| value.to_string())
            .or_else(|| code.as_i64().map(|value| value.to_string()))
    });
    Some(Diagnostic {
        id: format!("{source}-{file}-{index}"),
        severity: severity.to_string(),
        source: source.to_string(),
        file: file.to_string(),
        range: Range {
            start: Position {
                line: start.get("line").and_then(|v| v.as_i64()).unwrap_or(0),
                column: start.get("character").and_then(|v| v.as_i64()).unwrap_or(0),
            },
            end: Position {
                line: end.get("line").and_then(|v| v.as_i64()).unwrap_or(0),
                column: end.get("character").and_then(|v| v.as_i64()).unwrap_or(0),
            },
        },
        message,
        code,
    })
}

fn send_request(
    stdin: &mut ChildStdin,
    id: i64,
    method: &str,
    params: serde_json::Value,
) -> Result<(), String> {
    write_message(
        stdin,
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }),
    )
}

fn send_notification(
    stdin: &mut ChildStdin,
    method: &str,
    params: serde_json::Value,
) -> Result<(), String> {
    write_message(
        stdin,
        serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }),
    )
}

fn write_message(stdin: &mut ChildStdin, value: serde_json::Value) -> Result<(), String> {
    let bytes =
        serde_json::to_vec(&value).map_err(|err| format!("failed to encode lsp message: {err}"))?;
    write!(stdin, "Content-Length: {}\r\n\r\n", bytes.len())
        .map_err(|err| format!("failed to write lsp header: {err}"))?;
    stdin
        .write_all(&bytes)
        .map_err(|err| format!("failed to write lsp body: {err}"))?;
    stdin
        .flush()
        .map_err(|err| format!("failed to flush lsp message: {err}"))
}

fn collect_project_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = vec![];
    collect_project_files_inner(root, root, &mut out)?;
    Ok(out)
}

fn collect_project_files_inner(
    root: &Path,
    dir: &Path,
    out: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if out.len() >= 300 {
        return Ok(());
    }
    let entries =
        fs::read_dir(dir).map_err(|err| format!("failed to read {}: {err}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("failed to read dir entry: {err}"))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip(&name, root, &path) {
            continue;
        }
        if path.is_dir() {
            collect_project_files_inner(root, &path, out)?;
        } else if path.is_file() {
            out.push(path);
        }
        if out.len() >= 300 {
            break;
        }
    }
    Ok(())
}

fn should_skip(name: &str, root: &Path, path: &Path) -> bool {
    const SKIP_NAMES: &[&str] = &[
        ".git",
        "node_modules",
        "target",
        "dist",
        "build",
        ".next",
        ".vite",
        "coverage",
    ];
    if is_agent_worktree_path(root, path) {
        return true;
    }
    if SKIP_NAMES.contains(&name) {
        return true;
    }
    path.strip_prefix(root)
        .ok()
        .and_then(|relative| relative.to_str())
        .map(|relative| relative.contains("src-tauri/target"))
        .unwrap_or(false)
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

fn matches_spec(path: &Path, spec: &ServerSpec) -> bool {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if spec.filenames.iter().any(|item| item == filename) {
        return true;
    }
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| spec.extensions.iter().any(|item| item == ext))
        .unwrap_or(false)
}

fn language_id(path: &Path, spec: &ServerSpec) -> String {
    let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if let Some(id) = spec.language_ids.get(filename) {
        return id.clone();
    }
    if let Some(id) = spec.language_ids.get(ext) {
        return id.clone();
    }
    if ext.is_empty() {
        return filename_language_id(filename).to_string();
    }
    default_language_id(ext).to_string()
}

fn path_to_uri(path: &Path) -> String {
    let absolute = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    format!("file://{}", absolute.to_string_lossy().replace('\\', "/"))
}

fn uri_to_path_lossy(uri: &str) -> String {
    uri.strip_prefix("file://")
        .unwrap_or(uri)
        .trim_start_matches('/')
        .to_string()
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn command_line(spec: &ServerSpec) -> String {
    let mut parts = vec![spec.command.clone()];
    parts.extend(spec.args.iter().cloned());
    parts.join(" ")
}

fn active_project_server_specs() -> Result<Vec<ServerSpec>, String> {
    let root = project_context::active_project_root()?;
    let files = collect_project_files(&root)?;
    Ok(server_specs(&root)
        .into_iter()
        .filter(|spec| files.iter().any(|path| matches_spec(path, spec)))
        .collect())
}

fn server_specs(root: &Path) -> Vec<ServerSpec> {
    let mut specs = builtin_server_specs();
    let config_path = root.join(".polypore").join("language-servers.json");
    let Ok(config) = fs::read_to_string(config_path) else {
        return specs;
    };
    let Ok(config) = serde_json::from_str::<ProjectServerConfig>(&config) else {
        return specs;
    };
    specs.extend(config.servers.into_iter().filter(valid_server_spec));
    specs
}

fn valid_server_spec(spec: &ServerSpec) -> bool {
    !spec.id.trim().is_empty()
        && !spec.command.trim().is_empty()
        && (!spec.extensions.is_empty() || !spec.filenames.is_empty())
}

fn builtin_server_specs() -> Vec<ServerSpec> {
    vec![
        server(
            "typescript-language-server",
            "typescript-language-server",
            &["--stdio"],
            &["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"],
        ),
        server("rust-analyzer", "rust-analyzer", &[], &["rs"]),
        server(
            "pyright",
            "pyright-langserver",
            &["--stdio"],
            &["py", "pyi"],
        ),
        server("gopls", "gopls", &[], &["go"]),
        server(
            "clangd",
            "clangd",
            &[],
            &[
                "c", "h", "cc", "cpp", "cxx", "c++", "hh", "hpp", "hxx", "m", "mm",
            ],
        ),
        server("jdtls", "jdtls", &[], &["java"]),
        server("metals", "metals", &[], &["scala", "sc", "sbt"]),
        server(
            "kotlin-language-server",
            "kotlin-language-server",
            &[],
            &["kt", "kts"],
        ),
        server("csharp-ls", "csharp-ls", &[], &["cs", "csx"]),
        server("zls", "zls", &[], &["zig", "zon"]),
        server(
            "dart-language-server",
            "dart",
            &["language-server", "--protocol=lsp"],
            &["dart"],
        ),
        server("sourcekit-lsp", "sourcekit-lsp", &[], &["swift"]),
        server("lua-language-server", "lua-language-server", &[], &["lua"]),
        named_server(
            "bash-language-server",
            "bash-language-server",
            &["start"],
            &["sh", "bash", "zsh", "ksh"],
            &[".bashrc", ".bash_profile", ".zshrc"],
        ),
        server(
            "yaml-language-server",
            "yaml-language-server",
            &["--stdio"],
            &["yaml", "yml"],
        ),
        server(
            "vscode-json-language-server",
            "vscode-json-language-server",
            &["--stdio"],
            &["json", "jsonc"],
        ),
        server(
            "vscode-css-language-server",
            "vscode-css-language-server",
            &["--stdio"],
            &["css", "scss", "less"],
        ),
        server(
            "vscode-html-language-server",
            "vscode-html-language-server",
            &["--stdio"],
            &["html", "htm"],
        ),
        named_server(
            "ruby-lsp",
            "ruby-lsp",
            &[],
            &["rb", "rake", "gemspec"],
            &["Gemfile", "Rakefile"],
        ),
        server("intelephense", "intelephense", &["--stdio"], &["php"]),
        server(
            "elixir-ls",
            "elixir-ls",
            &[],
            &["ex", "exs", "heex", "leex"],
        ),
        server("erlang-ls", "erlang_ls", &[], &["erl", "hrl"]),
        server(
            "haskell-language-server",
            "haskell-language-server-wrapper",
            &["--lsp"],
            &["hs", "lhs"],
        ),
        server("ocamllsp", "ocamllsp", &[], &["ml", "mli", "re", "rei"]),
        server(
            "clojure-lsp",
            "clojure-lsp",
            &[],
            &["clj", "cljs", "cljc", "edn"],
        ),
        server("nil", "nil", &[], &["nix"]),
        server(
            "vue-language-server",
            "vue-language-server",
            &["--stdio"],
            &["vue"],
        ),
        server(
            "svelte-language-server",
            "svelteserver",
            &["--stdio"],
            &["svelte"],
        ),
        server(
            "terraform-ls",
            "terraform-ls",
            &["serve"],
            &["tf", "tfvars"],
        ),
        server("taplo", "taplo", &["lsp", "stdio"], &["toml"]),
        named_server(
            "docker-langserver",
            "docker-langserver",
            &["--stdio"],
            &["dockerfile"],
            &["Dockerfile", "Containerfile"],
        ),
        server("sqls", "sqls", &[], &["sql"]),
        server(
            "lemminx",
            "lemminx",
            &[],
            &["xml", "xsd", "xsl", "xslt", "svg"],
        ),
        server("marksman", "marksman", &["server"], &["md", "markdown"]),
    ]
}

fn server(id: &str, command: &str, args: &[&str], extensions: &[&str]) -> ServerSpec {
    named_server(id, command, args, extensions, &[])
}

fn named_server(
    id: &str,
    command: &str,
    args: &[&str],
    extensions: &[&str],
    filenames: &[&str],
) -> ServerSpec {
    ServerSpec {
        id: id.to_string(),
        command: command.to_string(),
        args: args.iter().map(|item| item.to_string()).collect(),
        extensions: extensions.iter().map(|item| item.to_string()).collect(),
        filenames: filenames.iter().map(|item| item.to_string()).collect(),
        language_ids: HashMap::new(),
    }
}

fn default_language_id(ext: &str) -> &str {
    match ext {
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "rs" => "rust",
        "py" | "pyi" => "python",
        "go" => "go",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "c++" | "hh" | "hpp" | "hxx" => "cpp",
        "m" => "objective-c",
        "mm" => "objective-cpp",
        "cs" | "csx" => "csharp",
        "kt" | "kts" => "kotlin",
        "java" => "java",
        "scala" | "sc" | "sbt" => "scala",
        "zig" | "zon" => "zig",
        "dart" => "dart",
        "rb" | "rake" | "gemspec" => "ruby",
        "php" => "php",
        "lua" => "lua",
        "sh" | "bash" | "zsh" | "ksh" => "shellscript",
        "swift" => "swift",
        "ex" | "exs" => "elixir",
        "erl" | "hrl" => "erlang",
        "hs" | "lhs" => "haskell",
        "ml" | "mli" => "ocaml",
        "re" | "rei" => "reason",
        "clj" | "cljs" | "cljc" | "edn" => "clojure",
        "nix" => "nix",
        "heex" => "phoenix-heex",
        "leex" => "phoenix-leex",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "html" | "htm" => "html",
        "json" => "json",
        "jsonc" => "jsonc",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "tf" | "tfvars" => "terraform",
        "xml" | "xsd" | "xsl" | "xslt" | "svg" => "xml",
        "md" | "markdown" => "markdown",
        "vue" => "vue",
        "svelte" => "svelte",
        "sql" => "sql",
        _ => ext,
    }
}

fn filename_language_id(filename: &str) -> &str {
    match filename {
        "Dockerfile" | "Containerfile" => "dockerfile",
        "Gemfile" | "Rakefile" => "ruby",
        ".bashrc" | ".bash_profile" | ".zshrc" => "shellscript",
        _ => "plaintext",
    }
}

fn sanitize_relative_document_path(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("lsp document path must stay inside the project".to_string());
    }
    Ok(path.to_path_buf())
}

fn stop_child(mut child: Child) {
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(300) {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(_) => return,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtins_cover_extension_and_filename_languages() {
        let specs = builtin_server_specs();
        let docker = Path::new("Dockerfile");
        let rust = Path::new("src/lib.rs");
        let vue = Path::new("src/App.vue");

        assert!(specs.iter().any(|spec| matches_spec(docker, spec)));
        assert!(specs.iter().any(|spec| matches_spec(rust, spec)));
        assert!(specs.iter().any(|spec| matches_spec(vue, spec)));
    }

    #[test]
    fn language_ids_accept_spec_overrides_and_filename_defaults() {
        let mut spec = server("custom", "custom-lsp", &["--stdio"], &["foo"]);
        spec.language_ids
            .insert("foo".to_string(), "foo-script".to_string());

        assert_eq!(language_id(Path::new("src/file.foo"), &spec), "foo-script");
        assert_eq!(
            language_id(
                Path::new("Dockerfile"),
                &named_server("docker", "docker-lsp", &[], &[], &["Dockerfile"])
            ),
            "dockerfile"
        );
    }

    #[test]
    fn document_paths_cannot_escape_the_project() {
        assert!(sanitize_relative_document_path("src/main.rs").is_ok());
        assert!(sanitize_relative_document_path("../outside.rs").is_err());
        assert!(sanitize_relative_document_path("/tmp/outside.rs").is_err());
    }

    #[test]
    fn project_collection_skips_generated_agent_worktrees_only() {
        let root = Path::new("/workspace");

        assert!(should_skip(
            "worktrees",
            root,
            &root.join(".claude/worktrees/agent-a39821ffefee81420"),
        ));
        assert!(!should_skip(
            "orchestration",
            root,
            &root.join(".claude/orchestration"),
        ));
    }
}
