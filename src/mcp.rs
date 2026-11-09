//! `polypore mcp`: a small stdio MCP server exposing mediated secret use.

use std::io::{BufRead, Write};
use std::process::{Command, Stdio};

use serde_json::{Value, json};

use crate::secrets::{self, Approval, Decision, SecretMeta};

pub fn serve() -> anyhow::Result<()> {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    let project = project_root();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let id = req.get("id").cloned();
        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = req.get("params").cloned().unwrap_or(Value::Null);
        let result = match method {
            "initialize" => Some(json!({
                "protocolVersion": params.get("protocolVersion").and_then(|v| v.as_str()).unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "polypore-secrets", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Use these tools for any API key, token or credential. Secrets are never in your environment and .env files are off limits."
            })),
            "ping" => Some(json!({})),
            "tools/list" => Some(json!({ "tools": tools() })),
            "tools/call" => {
                let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                let (text, is_error) = match name {
                    "secrets_list" => (list_text(&project), false),
                    "secrets_exec" => exec(&project, &args),
                    "secrets_http" => http(&project, &args),
                    _ => (format!("unknown tool {name}"), true),
                };
                Some(json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }))
            }
            _ => None,
        };
        let Some(id) = id else { continue };
        let resp = match result {
            Some(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            None => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("method not found: {method}") } }),
        };
        writeln!(out, "{resp}")?;
        out.flush()?;
    }
    Ok(())
}

fn project_root() -> String {
    if let Ok(p) = std::env::var("POLYPORE_PROJECT") {
        if !p.is_empty() {
            return p;
        }
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    crate::store::git_root(&cwd).unwrap_or_else(|| cwd.to_string_lossy().to_string())
}

fn tools() -> Value {
    json!([
        {
            "name": "secrets_list",
            "description": "List the secret names available to this project (names only, never values).",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "secrets_exec",
            "description": "Run one command with the named secrets injected as environment variables. No shell: pass argv. The user approves each new command in polypore. Output has secret values masked.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": { "type": "array", "items": { "type": "string" }, "description": "argv, e.g. [\"gh\", \"release\", \"list\"]" },
                    "secrets": { "type": "array", "items": { "type": "string" } },
                    "cwd": { "type": "string" },
                    "timeout_s": { "type": "integer" }
                },
                "required": ["command", "secrets"]
            }
        },
        {
            "name": "secrets_http",
            "description": "Make one HTTP request. Write secrets as {{NAME}} in url, headers or body; polypore substitutes them and masks the response. The user approves each new host.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "method": { "type": "string" },
                    "url": { "type": "string" },
                    "headers": { "type": "object", "additionalProperties": { "type": "string" } },
                    "body": { "type": "string" }
                },
                "required": ["url"]
            }
        }
    ])
}

fn list_text(project: &str) -> String {
    let l = secrets::list(project);
    if l.is_empty() {
        return "no secrets are registered for this project. Ask the user to add them in polypore (secrets tab).".into();
    }
    l.iter()
        .map(|m| {
            format!(
                "{} (scope: {}; approved commands: {}; approved hosts: {})",
                m.name,
                if m.project == "*" { "global" } else { "project" },
                if m.allow.is_empty() { "none yet".into() } else { m.allow.join(", ") },
                if m.hosts.is_empty() { "none yet".into() } else { m.hosts.join(", ") }
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn resolve(project: &str, names: &[String]) -> Result<Vec<(SecretMeta, String)>, String> {
    let all = secrets::list(project);
    let mut out = Vec::new();
    for n in names {
        let Some(m) = all.iter().find(|m| &m.name == n) else {
            return Err(format!("unknown secret {n}. Call secrets_list, or ask the user to add it in polypore."));
        };
        let v = secrets::value(m).map_err(|e| format!("keyring: {e}"))?;
        out.push((m.clone(), v));
    }
    Ok(out)
}

fn approve(project: &str, metas: &[SecretMeta], kind: &str, target: &str, pattern: &str, allowed: impl Fn(&SecretMeta) -> bool) -> Result<(), String> {
    if metas.iter().all(&allowed) {
        return Ok(());
    }
    let a = Approval {
        id: format!("{}-{}", crate::model::now_ms(), std::process::id()),
        project: project.to_string(),
        secrets: metas.iter().map(|m| m.name.clone()).collect(),
        kind: kind.to_string(),
        target: target.to_string(),
        pattern: pattern.to_string(),
        ts: crate::model::now_ms(),
    };
    if !secrets::tui_running() {
        return Err("polypore is not running, so nobody can approve this. Ask the user to open polypore.".into());
    }
    match secrets::request_approval(&a, 180) {
        Decision::Once | Decision::Always => Ok(()),
        Decision::Deny => Err("the user denied this request (or it timed out after 3 minutes).".into()),
    }
}

fn exec(project: &str, args: &Value) -> (String, bool) {
    let argv: Vec<String> = args
        .get("command")
        .and_then(|c| c.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .or_else(|| args.get("command").and_then(|c| c.as_str()).and_then(|s| shell_words::split(s).ok()))
        .unwrap_or_default();
    if argv.is_empty() {
        return ("command is required".into(), true);
    }
    let names: Vec<String> = args
        .get("secrets")
        .and_then(|s| s.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let cmdline = argv.join(" ");
    if let Some(why) = secrets::dangerous(&cmdline) {
        return (format!("refused: {why}"), true);
    }
    let resolved = match resolve(project, &names) {
        Ok(r) => r,
        Err(e) => return (e, true),
    };
    let metas: Vec<SecretMeta> = resolved.iter().map(|(m, _)| m.clone()).collect();
    let pattern = format!("{} *", argv[0]);
    if let Err(e) = approve(project, &metas, "exec", &cmdline, &pattern, |m| {
        m.allow.iter().any(|p| secrets::glob_match(p, &cmdline) || secrets::glob_match(p, &format!("{cmdline} ")))
    }) {
        return (e, true);
    }
    let cwd = args.get("cwd").and_then(|c| c.as_str()).map(String::from).unwrap_or_else(|| project.to_string());
    let timeout = args.get("timeout_s").and_then(|t| t.as_u64()).unwrap_or(120).min(900);
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]).current_dir(&cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (m, v) in &resolved {
        cmd.env(&m.name, v);
    }
    let pairs: Vec<(String, String)> = resolved.iter().map(|(m, v)| (m.name.clone(), v.clone())).collect();
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return (format!("spawn failed: {e}"), true),
    };
    let out = wait_with_timeout(child, timeout);
    match out {
        Ok((code, stdout, stderr)) => {
            let text = format!(
                "exit {code}\n--- stdout ---\n{}\n--- stderr ---\n{}",
                truncate(&secrets::mask(&stdout, &pairs), 60_000),
                truncate(&secrets::mask(&stderr, &pairs), 20_000)
            );
            (text, code != 0)
        }
        Err(e) => (e, true),
    }
}

fn wait_with_timeout(mut child: std::process::Child, timeout_s: u64) -> Result<(i32, String, String), String> {
    use std::io::Read;
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let t1 = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = so.read_to_end(&mut s);
        s
    });
    let t2 = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = se.read_to_end(&mut s);
        s
    });
    let start = std::time::Instant::now();
    let code = loop {
        if let Ok(Some(st)) = child.try_wait() {
            break st.code().unwrap_or(-1);
        }
        if start.elapsed().as_secs() > timeout_s {
            let _ = child.kill();
            return Err(format!("timed out after {timeout_s}s"));
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    let o = t1.join().unwrap_or_default();
    let e = t2.join().unwrap_or_default();
    Ok((code, String::from_utf8_lossy(&o).to_string(), String::from_utf8_lossy(&e).to_string()))
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[truncated {} bytes]", &s[..end], s.len() - end)
}

fn placeholders(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(i) = rest.find("{{") {
        let after = &rest[i + 2..];
        let Some(j) = after.find("}}") else { break };
        let name = after[..j].trim().to_string();
        if secrets::valid_name(&name) && !out.contains(&name) {
            out.push(name);
        }
        rest = &after[j + 2..];
    }
    out
}

fn curl_quote(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn http(project: &str, args: &Value) -> (String, bool) {
    let method = args.get("method").and_then(|m| m.as_str()).unwrap_or("GET").to_uppercase();
    let url = args.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string();
    if !(url.starts_with("https://") || url.starts_with("http://localhost") || url.starts_with("http://127.0.0.1")) {
        return ("only https URLs (or localhost) are allowed".into(), true);
    }
    let headers: Vec<(String, String)> = args
        .get("headers")
        .and_then(|h| h.as_object())
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect())
        .unwrap_or_default();
    let body = args.get("body").and_then(|b| b.as_str()).map(String::from);
    let mut names = placeholders(&url);
    for (k, v) in &headers {
        names.extend(placeholders(k));
        names.extend(placeholders(v));
    }
    if let Some(b) = &body {
        names.extend(placeholders(b));
    }
    names.sort();
    names.dedup();
    let resolved = match resolve(project, &names) {
        Ok(r) => r,
        Err(e) => return (e, true),
    };
    let host = crate::model::domain_of(&url);
    let metas: Vec<SecretMeta> = resolved.iter().map(|(m, _)| m.clone()).collect();
    if let Err(e) = approve(project, &metas, "http", &format!("{method} {url}"), &host, |m| {
        m.hosts.iter().any(|h| secrets::glob_match(h, &host))
    }) {
        return (e, true);
    }
    let sub = |s: &str| -> String {
        let mut o = s.to_string();
        for (m, v) in &resolved {
            o = o.replace(&format!("{{{{{}}}}}", m.name), v);
        }
        o
    };
    let mut cfg = String::new();
    cfg.push_str(&format!("url = {}\n", curl_quote(&sub(&url))));
    cfg.push_str(&format!("request = {}\n", curl_quote(&method)));
    for (k, v) in &headers {
        cfg.push_str(&format!("header = {}\n", curl_quote(&format!("{}: {}", sub(k), sub(v)))));
    }
    if let Some(b) = &body {
        cfg.push_str(&format!("data-binary = {}\n", curl_quote(&sub(b))));
    }
    let child = Command::new("curl")
        .args(["-sS", "-i", "--max-time", "60", "-K", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => return (format!("curl: {e}"), true),
    };
    if let Some(mut si) = child.stdin.take() {
        let _ = si.write_all(cfg.as_bytes());
    }
    let pairs: Vec<(String, String)> = resolved.iter().map(|(m, v)| (m.name.clone(), v.clone())).collect();
    match wait_with_timeout(child, 70) {
        Ok((code, so, se)) => {
            let text = format!("{}{}", secrets::mask(&so, &pairs), if se.is_empty() { String::new() } else { format!("\n{}", secrets::mask(&se, &pairs)) });
            (truncate(&text, 80_000), code != 0)
        }
        Err(e) => (e, true),
    }
}

/// `polypore run -- cmd...`: run your own command with project secrets
/// injected (the replacement for a .env file on disk).
pub fn run(args: &[String]) -> anyhow::Result<i32> {
    let project = project_root();
    let argv: Vec<String> = args.iter().skip_while(|a| *a == "--").cloned().collect();
    if argv.is_empty() {
        anyhow::bail!("usage: polypore run -- <command> [args]");
    }
    if std::env::var("POLYPORE_AGENT_SCRUBBED").is_ok() {
        anyhow::bail!("refused: this shell is an agent terminal. Agents use the polypore-secrets MCP tools instead.");
    }
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]);
    for (k, v) in secrets::inject_env(&project) {
        cmd.env(k, v);
    }
    let st = cmd.status()?;
    Ok(st.code().unwrap_or(1))
}
