use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredMcp {
    pub name: String,
    pub origins: Vec<String>,
    pub transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
}

// ── Claude JSON structs ──────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeConfig {
    #[serde(default)]
    mcp_servers: HashMap<String, ClaudeMcpEntry>,
    #[serde(default)]
    projects: HashMap<String, ClaudeProjectConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeProjectConfig {
    #[serde(default)]
    mcp_servers: HashMap<String, ClaudeMcpEntry>,
}

#[derive(Deserialize)]
struct ClaudeMcpEntry {
    #[serde(rename = "type")]
    kind: Option<String>,
    transport: Option<String>,
    url: Option<String>,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
}

// ── Codex TOML structs ───────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CodexConfig {
    #[serde(default)]
    mcp_servers: HashMap<String, CodexMcpEntry>,
}

#[derive(Deserialize)]
struct CodexMcpEntry {
    transport: Option<String>,
    url: Option<String>,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
}

// ── .mcp.json struct ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DotMcpJson {
    #[serde(default)]
    mcp_servers: HashMap<String, ClaudeMcpEntry>,
}

// ── Discovery logic ──────────────────────────────────────────────────────────

/// Discover MCPs from a project-level `.mcp.json` file.
fn discover_dot_mcp_json(project_dir: &Path, results: &mut Vec<DiscoveredMcp>) {
    let path = project_dir.join(".mcp.json");
    if !path.exists() {
        return;
    }
    match std::fs::read_to_string(&path) {
        Ok(contents) => match serde_json::from_str::<DotMcpJson>(&contents) {
            Ok(config) => {
                for (name, entry) in config.mcp_servers {
                    let mut discovered = claude_entry(name, entry);
                    discovered.origins = vec!["project".to_string()];
                    results.push(discovered);
                }
            }
            Err(e) => eprintln!("mcp_discover: failed to parse .mcp.json: {e}"),
        },
        Err(e) => eprintln!("mcp_discover: failed to read .mcp.json: {e}"),
    }
}

/// Discover MCPs from external agent configs (claude + codex).
/// Production callers pass the `$HOME` directory.
/// In tests, pass a temp dir containing the fixture files.
pub fn discover(base_dir: &Path) -> Result<Vec<DiscoveredMcp>, String> {
    let mut results: Vec<DiscoveredMcp> = Vec::new();

    // Parse ~/.claude.json
    let claude_path = base_dir.join(".claude.json");
    if claude_path.exists() {
        match std::fs::read_to_string(&claude_path) {
            Ok(contents) => match serde_json::from_str::<ClaudeConfig>(&contents) {
                Ok(config) => {
                    for (name, entry) in config.mcp_servers {
                        results.push(claude_entry(name, entry));
                    }
                    for project in config.projects.into_values() {
                        for (name, entry) in project.mcp_servers {
                            results.push(claude_entry(name, entry));
                        }
                    }
                }
                Err(e) => {
                    eprintln!("mcp_discover: failed to parse .claude.json: {e}");
                }
            },
            Err(e) => {
                eprintln!("mcp_discover: failed to read .claude.json: {e}");
            }
        }
    }

    // Parse ~/.codex/config.toml
    let codex_path = base_dir.join(".codex").join("config.toml");
    if codex_path.exists() {
        match std::fs::read_to_string(&codex_path) {
            Ok(contents) => match toml::from_str::<CodexConfig>(&contents) {
                Ok(config) => {
                    for (name, entry) in config.mcp_servers {
                        let transport = classify_transport(
                            entry.url.as_deref(),
                            entry.command.as_deref(),
                            entry.transport.as_deref(),
                        );
                        results.push(DiscoveredMcp {
                            name,
                            origins: vec!["codex".to_string()],
                            transport,
                            url: entry.url,
                            command: entry.command,
                            args: entry.args,
                            env: entry.env,
                        });
                    }
                }
                Err(e) => {
                    eprintln!("mcp_discover: failed to parse .codex/config.toml: {e}");
                }
            },
            Err(e) => {
                eprintln!("mcp_discover: failed to read .codex/config.toml: {e}");
            }
        }
    }

    Ok(results)
}

fn claude_entry(name: String, entry: ClaudeMcpEntry) -> DiscoveredMcp {
    let declared = entry.transport.as_deref().or(entry.kind.as_deref());
    let transport = classify_transport(entry.url.as_deref(), entry.command.as_deref(), declared);
    DiscoveredMcp {
        name,
        origins: vec!["claude".to_string()],
        transport,
        url: entry.url,
        command: entry.command,
        args: entry.args,
        env: entry.env,
    }
}

fn classify_transport(url: Option<&str>, command: Option<&str>, declared: Option<&str>) -> String {
    match declared.map(|value| value.to_ascii_lowercase()) {
        Some(value) if value == "sse" => "sse".to_string(),
        Some(value) if value == "http" || value == "streamable_http" || value == "streamable-http" => {
            "http".to_string()
        }
        Some(value) if value == "stdio" => "stdio".to_string(),
        _ if url.is_some() => "http".to_string(),
        _ if command.is_some() => "stdio".to_string(),
        _ => "stdio".to_string(),
    }
}

// ── Install helpers ───────────────────────────────────────────────────────────

fn write_json_mcp_entry(
    path: &Path,
    name: &str,
    entry: &serde_json::Value,
) -> Result<(), String> {
    let mut config: serde_json::Value = if path.exists() {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()))
    } else {
        serde_json::Value::Object(serde_json::Map::new())
    };
    if let serde_json::Value::Object(ref mut root) = config {
        let servers = root
            .entry("mcpServers")
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if let serde_json::Value::Object(ref mut map) = servers {
            map.insert(name.to_string(), entry.clone());
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let out = serde_json::to_string_pretty(&config).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(path, out).map_err(|e| format!("write: {e}"))
}

fn write_toml_mcp_entry(
    path: &Path,
    name: &str,
    transport: &str,
    command: &Option<String>,
    args: &Option<Vec<String>>,
    env: &Option<HashMap<String, String>>,
    url: &Option<String>,
) -> Result<(), String> {
    let mut root: toml::map::Map<String, toml::Value> = if path.exists() {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| toml::from_str::<toml::Value>(&s).ok())
            .and_then(|v| if let toml::Value::Table(t) = v { Some(t) } else { None })
            .unwrap_or_default()
    } else {
        toml::map::Map::new()
    };

    let mut entry = toml::map::Map::new();
    entry.insert("transport".to_string(), toml::Value::String(transport.to_string()));
    if let Some(c) = command {
        entry.insert("command".to_string(), toml::Value::String(c.clone()));
    }
    if let Some(a) = args {
        entry.insert(
            "args".to_string(),
            toml::Value::Array(a.iter().map(|s| toml::Value::String(s.clone())).collect()),
        );
    }
    if let Some(e) = env {
        let mut env_map = toml::map::Map::new();
        for (k, v) in e {
            env_map.insert(k.clone(), toml::Value::String(v.clone()));
        }
        entry.insert("env".to_string(), toml::Value::Table(env_map));
    }
    if let Some(u) = url {
        entry.insert("url".to_string(), toml::Value::String(u.clone()));
    }

    let servers = root
        .entry("mcp_servers".to_string())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    if let toml::Value::Table(ref mut map) = servers {
        map.insert(name.to_string(), toml::Value::Table(entry));
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let out = toml::to_string(&toml::Value::Table(root)).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(path, out).map_err(|e| format!("write: {e}"))
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Install an MCP server into agent config files (.mcp.json / ~/.claude.json /
/// ~/.codex/config.toml) based on which agents are selected.
#[tauri::command]
pub fn mcp_config_install(
    name: String,
    transport: String,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    url: Option<String>,
    headers: Option<HashMap<String, String>>,
    agents: Vec<String>,
    project_dir: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut entry_map = serde_json::Map::new();
    entry_map.insert("type".to_string(), serde_json::Value::String(transport.clone()));
    if let Some(ref c) = command {
        entry_map.insert("command".to_string(), serde_json::Value::String(c.clone()));
    }
    if let Some(ref a) = args {
        entry_map.insert(
            "args".to_string(),
            serde_json::Value::Array(a.iter().map(|s| serde_json::Value::String(s.clone())).collect()),
        );
    }
    if let Some(ref e) = env {
        let obj: serde_json::Map<_, _> = e
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect();
        entry_map.insert("env".to_string(), serde_json::Value::Object(obj));
    }
    if let Some(ref u) = url {
        entry_map.insert("url".to_string(), serde_json::Value::String(u.clone()));
    }
    if let Some(ref h) = headers {
        let obj: serde_json::Map<_, _> = h
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect();
        entry_map.insert("headers".to_string(), serde_json::Value::Object(obj));
    }
    let entry = serde_json::Value::Object(entry_map);

    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let mut targets: Vec<String> = Vec::new();

    for agent in &agents {
        match agent.as_str() {
            "claude-project" => {
                if let Some(ref dir) = project_dir {
                    let path = Path::new(dir).join(".mcp.json");
                    match write_json_mcp_entry(&path, &name, &entry) {
                        Ok(()) => targets.push("claude-project".to_string()),
                        Err(e) => eprintln!("mcp_config_install .mcp.json: {e}"),
                    }
                }
            }
            "claude-user" => {
                if let Some(ref home) = home {
                    let path = home.join(".claude.json");
                    match write_json_mcp_entry(&path, &name, &entry) {
                        Ok(()) => targets.push("claude-user".to_string()),
                        Err(e) => eprintln!("mcp_config_install ~/.claude.json: {e}"),
                    }
                }
            }
            "codex" => {
                if let Some(ref home) = home {
                    let path = home.join(".codex").join("config.toml");
                    match write_toml_mcp_entry(&path, &name, &transport, &command, &args, &env, &url) {
                        Ok(()) => targets.push("codex".to_string()),
                        Err(e) => eprintln!("mcp_config_install .codex/config.toml: {e}"),
                    }
                }
            }
            _ => {}
        }
    }

    Ok(serde_json::json!({ "installed": !targets.is_empty(), "targets": targets }))
}

#[tauri::command]
pub fn mcp_discover_external(project_dir: Option<String>) -> Result<Vec<DiscoveredMcp>, String> {
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "could not determine home directory".to_string())?;
    let mut results = discover(&home)?;
    if let Some(dir) = project_dir {
        discover_dot_mcp_json(std::path::Path::new(&dir), &mut results);
    }
    Ok(results)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn mcp_discover_parses_claude_json() {
        let dir = TempDir::new().expect("tempdir");
        let claude_json = dir.path().join(".claude.json");
        fs::write(
            &claude_json,
            r#"{
              "mcpServers": {
                "filesystem": {
                  "command": "npx",
                  "args": ["-y", "@modelcontextprotocol/server-filesystem"]
                },
                "my-http-server": {
                  "url": "http://localhost:3000/mcp"
                }
              }
            }"#,
        )
        .expect("write fixture");

        let result = discover(dir.path()).expect("discover should not error");

        assert_eq!(result.len(), 2, "expected 2 results, got {}", result.len());

        for entry in &result {
            assert_eq!(
                entry.origins,
                vec!["claude".to_string()],
                "entry '{}' should have origin 'claude'",
                entry.name
            );
        }

        let fs_entry = result.iter().find(|e| e.name == "filesystem").expect("filesystem entry");
        assert_eq!(fs_entry.transport, "stdio");
        assert_eq!(fs_entry.command.as_deref(), Some("npx"));

        let http_entry = result.iter().find(|e| e.name == "my-http-server").expect("http entry");
        assert_eq!(http_entry.transport, "http");
        assert_eq!(http_entry.url.as_deref(), Some("http://localhost:3000/mcp"));
    }

    #[test]
    fn mcp_discover_parses_claude_project_mcp_servers() {
        let dir = TempDir::new().expect("tempdir");
        let claude_json = dir.path().join(".claude.json");
        fs::write(
            &claude_json,
            r#"{
              "projects": {
                "/tmp/project": {
                  "mcpServers": {
                    "playwright": {
                      "command": "npx",
                      "args": ["@playwright/mcp"]
                    }
                  }
                }
              }
            }"#,
        )
        .expect("write fixture");

        let result = discover(dir.path()).expect("discover should not error");

        assert_eq!(result.len(), 1, "expected project-scoped MCP result, got {:?}", result);
        let entry = &result[0];
        assert_eq!(entry.name, "playwright");
        assert_eq!(entry.origins, vec!["claude".to_string()]);
        assert_eq!(entry.transport, "stdio");
        assert_eq!(entry.command.as_deref(), Some("npx"));
    }

    #[test]
    fn mcp_discover_parses_codex_toml() {
        let dir = TempDir::new().expect("tempdir");
        let codex_dir = dir.path().join(".codex");
        fs::create_dir_all(&codex_dir).expect("create .codex dir");
        let config_toml = codex_dir.join("config.toml");
        fs::write(
            &config_toml,
            r#"
[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
"#,
        )
        .expect("write fixture");

        let result = discover(dir.path()).expect("discover should not error");

        assert_eq!(result.len(), 1, "expected 1 result, got {}", result.len());
        let entry = &result[0];
        assert_eq!(entry.name, "github");
        assert_eq!(entry.origins, vec!["codex".to_string()]);
        assert_eq!(entry.transport, "stdio");
        assert_eq!(entry.command.as_deref(), Some("npx"));
        assert_eq!(
            entry.args.as_deref(),
            Some(&["-y".to_string(), "@modelcontextprotocol/server-github".to_string()][..])
        );
    }

    #[test]
    fn mcp_discover_parses_codex_url_toml() {
        let dir = TempDir::new().expect("tempdir");
        let codex_dir = dir.path().join(".codex");
        fs::create_dir_all(&codex_dir).expect("create .codex dir");
        let config_toml = codex_dir.join("config.toml");
        fs::write(
            &config_toml,
            r#"
[mcp_servers.remote]
url = "https://example.test/mcp"
transport = "sse"
"#,
        )
        .expect("write fixture");

        let result = discover(dir.path()).expect("discover should not error");

        assert_eq!(result.len(), 1, "expected 1 result, got {}", result.len());
        let entry = &result[0];
        assert_eq!(entry.name, "remote");
        assert_eq!(entry.origins, vec!["codex".to_string()]);
        assert_eq!(entry.transport, "sse");
        assert_eq!(entry.url.as_deref(), Some("https://example.test/mcp"));
    }

    #[test]
    fn mcp_discover_dot_mcp_json() {
        let dir = TempDir::new().expect("tempdir");
        fs::write(
            dir.path().join(".mcp.json"),
            r#"{
              "mcpServers": {
                "polypore-ide": {
                  "type": "stdio",
                  "command": "node",
                  "args": ["packages/mcp-server/src/server.mjs"]
                }
              }
            }"#,
        )
        .expect("write fixture");

        let mut results = Vec::new();
        discover_dot_mcp_json(dir.path(), &mut results);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "polypore-ide");
        assert_eq!(results[0].origins, vec!["project".to_string()]);
        assert_eq!(results[0].transport, "stdio");
        assert_eq!(results[0].command.as_deref(), Some("node"));
    }

    #[test]
    fn mcp_discover_missing_files_returns_empty() {
        let dir = TempDir::new().expect("tempdir");
        // neither .claude.json nor .codex/config.toml exist in this dir
        let result = discover(dir.path()).expect("should not error on missing files");
        assert!(result.is_empty(), "expected empty result for missing files, got {:?}", result);
    }

    #[test]
    fn mcp_discover_malformed_returns_empty() {
        let dir = TempDir::new().expect("tempdir");
        let claude_json = dir.path().join(".claude.json");
        fs::write(&claude_json, b"{ this is not valid json !!").expect("write bad fixture");

        let result = discover(dir.path()).expect("should not error, just log warning");
        assert!(result.is_empty(), "expected empty result for malformed JSON, got {:?}", result);
    }
}
