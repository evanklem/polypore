//! Secret broker. Values live in the OS keyring; `secrets.toml` holds only
//! names, scope and allowlists. Agent terminals get scrubbed environments,
//! the user's own terminals get the values injected, and agents reach
//! secrets only through the MCP server's mediated exec/http tools.

use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::config::{config_dir, state_dir};

const SERVICE: &str = "polypore";
pub const SENTINEL_PREFIX: &str = "polypore-secret://";

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SecretMeta {
    pub name: String,
    /// Project root, or "*" for every project.
    pub project: String,
    /// Command patterns this secret may be injected into, e.g. "stripe *".
    pub allow: Vec<String>,
    /// Hosts mediated HTTP requests may send this secret to.
    pub hosts: Vec<String>,
    pub created: i64,
    pub source: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Index {
    secret: Vec<SecretMeta>,
}

fn index_path() -> PathBuf {
    config_dir().join("secrets.toml")
}

fn load_index() -> Index {
    std::fs::read_to_string(index_path()).ok().and_then(|t| toml::from_str(&t).ok()).unwrap_or_default()
}

fn save_index(idx: &Index) -> Result<(), String> {
    let _ = std::fs::create_dir_all(config_dir());
    let body = toml::to_string_pretty(idx).map_err(|e| e.to_string())?;
    let tmp = index_path().with_extension("tmp");
    std::fs::write(&tmp, format!("# polypore secret index: names and allowlists only, values are in the OS keyring.\n\n{body}"))
        .map_err(|e| e.to_string())?;
    std::fs::rename(tmp, index_path()).map_err(|e| e.to_string())
}

fn account(project: &str, name: &str) -> String {
    format!("{project}::{name}")
}

fn entry(project: &str, name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &account(project, name)).map_err(|e| e.to_string())
}

pub fn list(project: &str) -> Vec<SecretMeta> {
    let mut v: Vec<SecretMeta> =
        load_index().secret.into_iter().filter(|s| s.project == project || s.project == "*").collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

pub fn value(meta: &SecretMeta) -> Result<String, String> {
    entry(&meta.project, &meta.name)?.get_password().map_err(|e| e.to_string())
}

pub fn set(project: &str, name: &str, value: &str, source: &str) -> Result<(), String> {
    if !valid_name(name) {
        return Err(format!("{name} is not a valid variable name"));
    }
    entry(project, name)?.set_password(value).map_err(|e| e.to_string())?;
    let mut idx = load_index();
    if let Some(m) = idx.secret.iter_mut().find(|s| s.project == project && s.name == name) {
        m.source = source.to_string();
    } else {
        idx.secret.push(SecretMeta {
            name: name.to_string(),
            project: project.to_string(),
            allow: Vec::new(),
            hosts: Vec::new(),
            created: crate::model::now_ms(),
            source: source.to_string(),
        });
    }
    save_index(&idx)
}

pub fn remove(project: &str, name: &str) -> Result<(), String> {
    if let Ok(e) = entry(project, name) {
        let _ = e.delete_credential();
    }
    let mut idx = load_index();
    idx.secret.retain(|s| !(s.project == project && s.name == name));
    save_index(&idx)
}

pub fn add_allow(project: &str, name: &str, pattern: &str, host: bool) -> Result<(), String> {
    let mut idx = load_index();
    let Some(m) = idx.secret.iter_mut().find(|s| (s.project == project || s.project == "*") && s.name == name) else {
        return Err("unknown secret".into());
    };
    let list = if host { &mut m.hosts } else { &mut m.allow };
    if !list.iter().any(|p| p == pattern) {
        list.push(pattern.to_string());
    }
    save_index(&idx)
}

pub fn valid_name(n: &str) -> bool {
    !n.is_empty()
        && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !n.chars().next().unwrap().is_ascii_digit()
}

pub const ENV_FILES: [&str; 4] = [".env", ".env.local", ".env.development", ".env.development.local"];

/// Keys (never values) found in a project's env files.
pub fn env_file_keys(root: &Path) -> Vec<(PathBuf, Vec<String>)> {
    let mut out = Vec::new();
    for f in ENV_FILES {
        let p = root.join(f);
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let keys: Vec<String> = parse_env(&text).into_iter().map(|(k, _)| k).collect();
        if !keys.is_empty() {
            out.push((p, keys));
        }
    }
    out
}

fn parse_env(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        let l = l.strip_prefix("export ").unwrap_or(l);
        let Some((k, v)) = l.split_once('=') else { continue };
        let k = k.trim();
        if !valid_name(k) {
            continue;
        }
        let mut v = v.trim().to_string();
        if (v.starts_with('"') && v.ends_with('"') && v.len() >= 2) || (v.starts_with('\'') && v.ends_with('\'') && v.len() >= 2) {
            v = v[1..v.len() - 1].to_string();
        } else if let Some(i) = v.find(" #") {
            v = v[..i].trim().to_string();
        }
        if !v.is_empty() {
            out.push((k.to_string(), v));
        }
    }
    out
}

/// Moves every key from the project's env files into the keyring and
/// replaces each line with a comment. Returns the moved key names.
pub fn import_env(root: &Path) -> Result<Vec<String>, String> {
    let project = root.to_string_lossy().to_string();
    let mut moved = Vec::new();
    for f in ENV_FILES {
        let p = root.join(f);
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let pairs = parse_env(&text);
        if pairs.is_empty() {
            continue;
        }
        for (k, v) in &pairs {
            set(&project, k, v, f)?;
            moved.push(k.clone());
        }
        // Only rewrite once every value is safely in the keyring.
        let mut out = String::new();
        for line in text.lines() {
            let l = line.trim();
            let stripped = l.strip_prefix("export ").unwrap_or(l);
            let key = stripped.split_once('=').map(|(k, _)| k.trim().to_string());
            match key {
                Some(k) if !l.starts_with('#') && pairs.iter().any(|(pk, _)| *pk == k) => {
                    out.push_str(&format!("# {k} is in the polypore keyring; polypore terminals and `polypore run` inject it\n"));
                }
                _ => {
                    out.push_str(line);
                    out.push('\n');
                }
            }
        }
        let perms = std::fs::metadata(&p).map(|m| m.permissions()).ok();
        let tmp = p.with_extension("polypore-tmp");
        std::fs::write(&tmp, out).map_err(|e| e.to_string())?;
        if let Some(perms) = perms {
            let _ = std::fs::set_permissions(&tmp, perms);
        }
        std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    }
    moved.sort();
    moved.dedup();
    Ok(moved)
}

/// Values for the user's own terminals and `polypore run`.
pub fn inject_env(project: &str) -> Vec<(String, String)> {
    list(project).iter().filter_map(|m| value(m).ok().map(|v| (m.name.clone(), v))).collect()
}

/// Environment edits for agent terminals: drop every known secret name and
/// replace it with a sentinel that tells the agent how to use it.
pub fn scrub(project: &str) -> (Vec<String>, Vec<(String, String)>) {
    let metas = list(project);
    let remove: Vec<String> = metas.iter().map(|m| m.name.clone()).collect();
    let mut set: Vec<(String, String)> = metas
        .iter()
        .map(|m| (m.name.clone(), format!("{SENTINEL_PREFIX}{} (use the polypore-secrets MCP tools: secrets_exec / secrets_http)", m.name)))
        .collect();
    set.push(("POLYPORE_AGENT_SCRUBBED".into(), "1".into()));
    set.push(("POLYPORE_PROJECT".into(), project.to_string()));
    (remove, set)
}

/// Masks a secret value and its common encodings in tool output.
pub fn mask(text: &str, secrets: &[(String, String)]) -> String {
    let mut out = text.to_string();
    for (name, v) in secrets {
        if v.len() < 4 {
            continue;
        }
        let tag = format!("[polypore:{name}]");
        let b = v.as_bytes();
        let forms = [
            v.clone(),
            base64::engine::general_purpose::STANDARD.encode(b),
            base64::engine::general_purpose::STANDARD_NO_PAD.encode(b),
            base64::engine::general_purpose::URL_SAFE.encode(b),
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b),
            hex(b, false),
            hex(b, true),
            url_encode(v),
        ];
        for f in forms.iter() {
            if f.len() >= 4 && out.contains(f.as_str()) {
                out = out.replace(f.as_str(), &tag);
            }
        }
    }
    out
}

fn hex(b: &[u8], upper: bool) -> String {
    b.iter().map(|x| if upper { format!("{x:02X}") } else { format!("{x:02x}") }).collect()
}

fn url_encode(s: &str) -> String {
    let mut o = String::new();
    for c in s.bytes() {
        if c.is_ascii_alphanumeric() || b"-_.~".contains(&c) {
            o.push(c as char);
        } else {
            o.push_str(&format!("%{c:02X}"));
        }
    }
    o
}

pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti, mut star, mut mark) = (0usize, 0usize, None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == t[ti] || p[pi] == '?') {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Commands that would print or exfiltrate their environment are refused
/// outright, whatever the allowlist says.
pub fn dangerous(cmd: &str) -> Option<&'static str> {
    let first = cmd.split_whitespace().next().unwrap_or("");
    let base = first.rsplit('/').next().unwrap_or(first);
    let bad = ["env", "printenv", "set", "export", "declare", "echo", "printf", "cat", "sh", "bash", "zsh", "fish", "python", "python3", "node", "perl", "ruby", "eval"];
    if bad.contains(&base) {
        return Some("this command can print its environment");
    }
    if cmd.contains('$') || cmd.contains('`') {
        return Some("shell expansion is not allowed in mediated commands");
    }
    if cmd.contains("/proc/") {
        return Some("reading /proc is not allowed");
    }
    None
}

// ---- approvals (MCP process <-> TUI) ----

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Approval {
    pub id: String,
    pub project: String,
    pub secrets: Vec<String>,
    pub kind: String,
    pub target: String,
    pub pattern: String,
    pub ts: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Once,
    Always,
    Deny,
}

fn approvals_dir() -> PathBuf {
    let d = state_dir().join("approvals");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn tui_pid_path() -> PathBuf {
    state_dir().join("tui.pid")
}

pub fn tui_running() -> bool {
    std::fs::read_to_string(tui_pid_path())
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .map(crate::store::pid_alive)
        .unwrap_or(false)
}

pub fn request_approval(a: &Approval, timeout_s: u64) -> Decision {
    if !tui_running() {
        return Decision::Deny;
    }
    let dir = approvals_dir();
    let req = dir.join(format!("{}.json", a.id));
    let dec = dir.join(format!("{}.decision", a.id));
    if std::fs::write(&req, serde_json::to_string(a).unwrap_or_default()).is_err() {
        return Decision::Deny;
    }
    let start = std::time::Instant::now();
    let result = loop {
        if let Ok(d) = std::fs::read_to_string(&dec) {
            break match d.trim() {
                "once" => Decision::Once,
                "always" => Decision::Always,
                _ => Decision::Deny,
            };
        }
        if start.elapsed().as_secs() > timeout_s {
            break Decision::Deny;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    };
    let _ = std::fs::remove_file(&req);
    let _ = std::fs::remove_file(&dec);
    result
}

pub fn pending_approvals() -> Vec<Approval> {
    let mut out = Vec::new();
    let now = crate::model::now_ms();
    if let Ok(rd) = std::fs::read_dir(approvals_dir()) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            if p.with_extension("decision").exists() {
                continue;
            }
            if let Ok(a) = std::fs::read_to_string(&p).map(|t| serde_json::from_str::<Approval>(&t)) {
                if let Ok(a) = a {
                    if now - a.ts < 10 * 60_000 {
                        out.push(a);
                    } else {
                        let _ = std::fs::remove_file(&p);
                    }
                }
            }
        }
    }
    out.sort_by_key(|a| a.ts);
    out
}

pub fn decide(a: &Approval, d: Decision) {
    if d == Decision::Always {
        for s in &a.secrets {
            let _ = add_allow(&a.project, s, &a.pattern, a.kind == "http");
        }
    }
    let word = match d {
        Decision::Once => "once",
        Decision::Always => "always",
        Decision::Deny => "deny",
    };
    let _ = std::fs::write(approvals_dir().join(format!("{}.decision", a.id)), word);
}

// ---- wiring a project so agents can find and use the broker ----

pub fn wire_preview(root: &Path) -> Vec<String> {
    vec![
        format!("{}: deny Read on .env files", rel(root, ".claude/settings.local.json")),
        format!("{}: register polypore-secrets MCP server", rel(root, ".mcp.json")),
        "codex: `codex mcp add polypore-secrets` (if codex is installed and it isn't registered)".into(),
        "skills source: install the polypore-secrets skill and sync it to both CLIs".into(),
        format!("{} and AGENTS.md: one line pointing agents at the broker", rel(root, "CLAUDE.md")),
    ]
}

fn rel(root: &Path, f: &str) -> String {
    crate::config::display_path(&root.join(f))
}

pub fn wire_project(root: &Path, exe: &Path, skills_source: &Path, skill_targets: &[PathBuf]) -> Vec<String> {
    let mut log = Vec::new();
    // 1. Claude deny rules.
    let settings = root.join(".claude/settings.local.json");
    let mut v: serde_json::Value = std::fs::read_to_string(&settings)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let deny = [
        "Read(./.env)",
        "Read(./.env.*)",
        "Read(**/.env)",
        "Read(**/.env.*)",
        "Bash(polypore run:*)",
        "Bash(secret-tool:*)",
        "Bash(security find-generic-password:*)",
    ];
    {
        let perms = v.as_object_mut().unwrap().entry("permissions").or_insert_with(|| serde_json::json!({}));
        let list = perms.as_object_mut().unwrap().entry("deny").or_insert_with(|| serde_json::json!([]));
        if let Some(arr) = list.as_array_mut() {
            for d in deny {
                if !arr.iter().any(|x| x.as_str() == Some(d)) {
                    arr.push(serde_json::Value::String(d.into()));
                }
            }
        }
    }
    let _ = std::fs::create_dir_all(root.join(".claude"));
    match std::fs::write(&settings, serde_json::to_string_pretty(&v).unwrap_or_default() + "\n") {
        Ok(_) => log.push("deny rules written to .claude/settings.local.json".into()),
        Err(e) => log.push(format!("settings.local.json: {e}")),
    }
    // 2. Project MCP registration for Claude.
    let mcp = root.join(".mcp.json");
    let mut m: serde_json::Value = std::fs::read_to_string(&mcp)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    {
        let servers = m.as_object_mut().unwrap().entry("mcpServers").or_insert_with(|| serde_json::json!({}));
        servers.as_object_mut().unwrap().insert(
            "polypore-secrets".into(),
            serde_json::json!({ "command": exe.to_string_lossy(), "args": ["mcp"] }),
        );
    }
    match std::fs::write(&mcp, serde_json::to_string_pretty(&m).unwrap_or_default() + "\n") {
        Ok(_) => log.push("polypore-secrets registered in .mcp.json".into()),
        Err(e) => log.push(format!(".mcp.json: {e}")),
    }
    // 3. Codex (global config; only if missing).
    let codex_cfg = crate::config::codex_dir().join("config.toml");
    let registered = std::fs::read_to_string(&codex_cfg).map(|t| t.contains("polypore-secrets")).unwrap_or(false);
    if !registered && crate::sleep::which("codex") {
        let ok = std::process::Command::new("codex")
            .args(["mcp", "add", "polypore-secrets", "--", &exe.to_string_lossy(), "mcp"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        log.push(if ok { "registered with codex".into() } else { "codex mcp add failed; add it by hand".into() });
    }
    // 4. Skill.
    match crate::skills::install_builtin(skills_source, skill_targets, "polypore-secrets", SKILL_TEXT) {
        Ok(_) => log.push("polypore-secrets skill installed and synced".into()),
        Err(e) => log.push(format!("skill: {e}")),
    }
    // 5. One line in agent instructions.
    for f in ["CLAUDE.md", "AGENTS.md"] {
        let p = root.join(f);
        let existing = std::fs::read_to_string(&p).unwrap_or_default();
        if existing.contains("polypore-secrets") {
            continue;
        }
        if !p.exists() && f == "AGENTS.md" && !crate::sleep::which("codex") {
            continue;
        }
        let line = "\n## Secrets\n\nSecrets are not in your environment; variables holding `polypore-secret://NAME` are placeholders. Use the `polypore-secrets` MCP tools (`secrets_list`, `secrets_exec`, `secrets_http`) and never read `.env*` files.\n";
        let body = if existing.is_empty() { line.trim_start().to_string() } else { format!("{}{line}", existing.trim_end_matches('\n').to_string() + "\n") };
        match std::fs::write(&p, body) {
            Ok(_) => log.push(format!("{f}: added a secrets note")),
            Err(e) => log.push(format!("{f}: {e}")),
        }
    }
    log
}

pub const SKILL_TEXT: &str = r#"---
name: polypore-secrets
description: How to use API keys and credentials in a project managed by polypore. Use whenever a task needs a secret, token, password or anything from a .env file.
---

# Using secrets through polypore

Secrets are kept in the OS keyring by polypore. They are not in your environment:
a variable whose value starts with `polypore-secret://` is a placeholder.

- Never read `.env*` files and never ask the user to paste a secret.
- `secrets_list` shows the names available for this project.
- `secrets_exec` runs one command with secrets injected as environment
  variables, e.g. `{"command": ["stripe", "customers", "list"], "secrets": ["STRIPE_API_KEY"]}`.
  The first time a command is used, the user approves it in polypore.
  Commands that could print the environment (env, echo, cat, shells,
  interpreters) are refused. Output has secret values masked.
- `secrets_http` makes one HTTP request. Reference secrets as `{{NAME}}`
  in headers, URL or body, e.g. `"headers": {"Authorization": "Bearer {{OPENAI_API_KEY}}"}`.
- If a needed secret is missing, stop and ask the user to add it in polypore
  (secrets tab, `a`), not in chat.
"#;
