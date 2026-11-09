//! Codex rollout adapter (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).
//! Uses the app-server item records (`item_completed`) where present, plus
//! raw response items for the "currently running" line.

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;

use crate::model::*;

#[derive(Deserialize, Default)]
#[serde(default)]
struct Line<'a> {
    timestamp: String,
    #[serde(rename = "type")]
    ty: String,
    #[serde(borrow)]
    payload: Option<&'a RawValue>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Payload<'a> {
    #[serde(rename = "type")]
    ty: String,
    id: String,
    cwd: String,
    model: String,
    effort: Option<String>,
    approval_policy: Option<Value>,
    git: Option<Git>,
    model_context_window: Option<u64>,
    duration_ms: Option<u64>,
    last_agent_message: Option<String>,
    info: Option<TokenInfo>,
    rate_limits: Option<Rates>,
    goal: Option<Value>,
    #[serde(borrow)]
    item: Option<&'a RawValue>,
    name: String,
    call_id: String,
    input: Option<String>,
    arguments: Option<String>,
    message: Option<String>,
    changes: Option<serde_json::Map<String, Value>>,
    query: Option<String>,
    output: Option<Value>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Git {
    branch: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TokenInfo {
    total_token_usage: Option<TokenUse>,
    last_token_usage: Option<TokenUse>,
    model_context_window: Option<u64>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TokenUse {
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Rates {
    primary: Option<Window>,
    secondary: Option<Window>,
    plan_type: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Window {
    used_percent: f64,
    window_minutes: u64,
    resets_at: i64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Item {
    #[serde(rename = "type")]
    ty: String,
    content: Vec<ContentPart>,
    command: Vec<String>,
    parsed_cmd: Vec<ParsedCmd>,
    exit_code: Option<i64>,
    duration: Option<Dur>,
    changes: Option<serde_json::Map<String, Value>>,
    summary_text: Vec<String>,
    query: Option<String>,
    action: Option<Value>,
    results: Vec<SearchResult>,
    server: String,
    tool: String,
    path: String,
    status: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ContentPart {
    text: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ParsedCmd {
    #[serde(rename = "type")]
    ty: String,
    path: Option<String>,
    query: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Dur {
    secs: u64,
    nanos: u64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct SearchResult {
    url: String,
}

pub fn apply_line(run: &mut AgentRun, raw: &[u8]) {
    let Ok(line) = serde_json::from_slice::<Line>(raw) else { return };
    let ts = parse_ts(&line.timestamp);
    if ts > 0 {
        if run.started == 0 {
            run.started = ts;
        }
        run.updated = run.updated.max(ts);
    }
    let Some(p) = line.payload else { return };
    let Ok(p) = serde_json::from_str::<Payload>(p.get()) else { return };
    match (line.ty.as_str(), p.ty.as_str()) {
        ("session_meta", _) => {
            if !p.cwd.is_empty() {
                run.cwd = p.cwd.clone();
            }
            if let Some(b) = p.git.and_then(|g| g.branch) {
                run.branch = b;
            }
        }
        ("turn_context", _) => {
            if !p.model.is_empty() {
                run.model = p.model.clone();
            }
            if let Some(e) = p.effort {
                run.effort = e;
            }
            if let Some(a) = p.approval_policy {
                run.permission_mode = value_text(&a);
            }
            if run.cwd.is_empty() && !p.cwd.is_empty() {
                run.cwd = p.cwd.clone();
            }
        }
        ("event_msg", "task_started") => {
            run.turn_open = true;
            run.turns += 1;
            if let Some(w) = p.model_context_window {
                run.ctx_window = w;
            }
            run.now = "thinking".into();
        }
        ("event_msg", "task_complete") => {
            run.turn_open = false;
            run.approval = None;
            run.pending.clear();
            run.turn_ms_total += p.duration_ms.unwrap_or(0);
            if let Some(m) = p.last_agent_message {
                if !m.is_empty() {
                    run.last_reply = one_line(&m, 300);
                }
            }
            run.now = run.last_reply.clone();
        }
        ("event_msg", "turn_aborted") => {
            run.turn_open = false;
            run.pending.clear();
            run.now = "interrupted".into();
        }
        ("event_msg", "token_count") => {
            if let Some(info) = p.info {
                if let Some(w) = info.model_context_window {
                    run.ctx_window = w;
                }
                if let Some(last) = info.last_token_usage {
                    run.ctx_tokens = last.input_tokens;
                }
                if let Some(total) = info.total_token_usage {
                    run.tokens_in = total.input_tokens.saturating_sub(total.cached_input_tokens);
                    run.tokens_cache_read = total.cached_input_tokens;
                    run.tokens_out = total.output_tokens;
                }
            }
            if let Some(r) = p.rate_limits {
                run.rate_limits = Some(RateLimits {
                    primary: r.primary.map(window),
                    secondary: r.secondary.map(window),
                    plan: r.plan_type.unwrap_or_default(),
                    ts,
                });
            }
        }
        ("event_msg", "thread_goal_updated") => {
            if let Some(g) = p.goal {
                run.goal = one_line(&value_text(&g), 200);
            }
        }
        ("event_msg", "error") => {
            run.push_event(ts, EvKind::Error, p.message.unwrap_or_else(|| "error".into()));
        }
        ("event_msg", t) if t.contains("approval_request") => {
            run.approval = Some(t.replace("_approval_request", " approval").replace('_', " "));
            run.now = "waiting for approval".into();
        }
        ("event_msg", "item_completed") => {
            if let Some(item) = p.item {
                if let Ok(item) = serde_json::from_str::<Item>(item.get()) {
                    apply_item(run, item, ts);
                }
            }
        }
        // Older rollouts (before app-server item records).
        ("event_msg", "user_message") => {
            let t = p.message.clone().unwrap_or_default();
            let t = t.trim();
            if !t.is_empty() && !t.starts_with('<') {
                run.last_prompt = one_line(t, 300);
                run.question = None;
                run.push_event(ts, EvKind::Prompt, t.to_string());
            }
        }
        ("event_msg", "agent_message") => {
            if let Some(m) = p.message.clone().filter(|m| !m.trim().is_empty()) {
                run.last_reply = one_line(&m, 300);
                run.push_event(ts, EvKind::Reply, m);
            }
        }
        ("event_msg", "patch_apply_end") => {
            let root = run.cwd.clone();
            if let Some(changes) = p.changes {
                for (path, v) in changes {
                    let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("update").to_string();
                    let diff = v.get("unified_diff").and_then(|d| d.as_str()).unwrap_or("");
                    let (add, del) = super::count_diff_lines(diff);
                    run.touch_file(&path, ts, |f| {
                        if kind == "add" { f.writes += 1 } else { f.edits += 1 }
                        f.added += add;
                        f.removed += del;
                    });
                    run.lines_added += add as u64;
                    run.lines_removed += del as u64;
                    run.push_event(ts, EvKind::Tool, format!("edited {}", rel_path(&path, &root)));
                }
            }
        }
        ("event_msg", "web_search_end") => {
            if let Some(q) = p.query.filter(|q| !q.is_empty()) {
                run.push_event(ts, EvKind::Tool, format!("searching web: {}", one_line(&q, 80)));
                run.push_web(WebKind::Search, q, ts);
            }
        }
        ("event_msg", "context_compacted") => {
            run.compactions += 1;
            run.push_event(ts, EvKind::Compact, "context compacted");
        }
        ("response_item", "custom_tool_call") | ("response_item", "function_call") => {
            let text = p.input.or(p.arguments).unwrap_or_default();
            let summary = summarize_call(&p.name, &text);
            *run.tool_counts.entry(p.name.clone()).or_default() += 1;
            match p.name.as_str() {
                "exec_command" | "shell" | "local_shell" => {
                    let cmd = summary.trim_start_matches("$ ").to_string();
                    run.push_cmd(CmdRun { cmd, desc: String::new(), ts, ok: None, background: false, duration_ms: None });
                    run.push_event(ts, EvKind::Tool, summary.clone());
                }
                "update_plan" => {
                    if let Ok(v) = serde_json::from_str::<Value>(&text) {
                        if let Some(plan) = v.get("plan").and_then(|p| p.as_array()) {
                            run.tasks = plan
                                .iter()
                                .enumerate()
                                .map(|(i, s)| Task {
                                    id: (i + 1).to_string(),
                                    subject: s.get("step").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                                    active: String::new(),
                                    status: match s.get("status").and_then(|x| x.as_str()).unwrap_or("") {
                                        "completed" => TaskStatus::Done,
                                        "in_progress" => TaskStatus::InProgress,
                                        _ => TaskStatus::Pending,
                                    },
                                })
                                .collect();
                        }
                    }
                }
                "view_image" => {
                    if let Ok(v) = serde_json::from_str::<Value>(&text) {
                        if let Some(path) = v.get("path").and_then(|x| x.as_str()) {
                            let full = absolutize(path, &run.cwd);
                            run.touch_file(&full, ts, |f| f.reads += 1);
                        }
                    }
                }
                _ => {}
            }
            run.pending.insert(p.call_id.clone(), PendingTool { name: p.name, summary: summary.clone(), ts });
            run.now = summary;
        }
        ("response_item", "custom_tool_call_output") | ("response_item", "function_call_output") => {
            if let Some(pt) = run.pending.remove(&p.call_id) {
                if matches!(pt.name.as_str(), "exec_command" | "shell" | "local_shell") {
                    let out = p.output.as_ref().map(value_text).unwrap_or_default();
                    let code = exit_code(&out);
                    if let Some(c) = run.cmds.iter_mut().rev().find(|c| c.ok.is_none()) {
                        c.ok = Some(code.map(|x| x == 0).unwrap_or(true));
                        if ts > c.ts {
                            c.duration_ms = Some((ts - c.ts) as u64);
                        }
                        if code.map(|x| x != 0).unwrap_or(false) {
                            let cmd = c.cmd.clone();
                            run.push_event(ts, EvKind::Error, format!("exit {} {}", code.unwrap_or(-1), one_line(&cmd, 80)));
                        }
                    }
                }
            }
        }
        _ => {}
    }
    let _ = &p.id;
}

fn exit_code(out: &str) -> Option<i64> {
    for pat in ["exited with code ", "Exit code: ", "exit_code\":"] {
        if let Some(i) = out.find(pat) {
            let rest = out[i + pat.len()..].trim_start();
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '-').collect();
            if let Ok(n) = digits.parse() {
                return Some(n);
            }
        }
    }
    None
}

fn window(w: Window) -> RateWindow {
    RateWindow { used_percent: w.used_percent, window_minutes: w.window_minutes, resets_at: w.resets_at }
}

fn apply_item(run: &mut AgentRun, item: Item, ts: i64) {
    let root = run.cwd.clone();
    run.approval = None;
    match item.ty.as_str() {
        "UserMessage" => {
            let text: String = item.content.iter().map(|c| c.text.as_str()).collect::<Vec<_>>().join(" ");
            let t = text.trim();
            if !t.is_empty() && !t.starts_with('<') {
                run.last_prompt = one_line(t, 300);
                run.question = None;
                run.push_event(ts, EvKind::Prompt, t.to_string());
            }
        }
        "AgentMessage" => {
            let text: String = item.content.iter().map(|c| c.text.as_str()).collect::<Vec<_>>().join(" ");
            if !text.trim().is_empty() {
                run.last_reply = one_line(&text, 300);
                run.push_event(ts, EvKind::Reply, text);
            }
        }
        "Reasoning" => {
            run.thinking_count += 1;
            let text = item.summary_text.join(" ");
            if !text.trim().is_empty() {
                run.last_reasoning = one_line(&text, 300);
                run.push_event(ts, EvKind::Thinking, text);
            }
        }
        "CommandExecution" => {
            let cmd = item.command.last().cloned().unwrap_or_default();
            let ok = item.exit_code.map(|c| c == 0);
            for pc in &item.parsed_cmd {
                match pc.ty.as_str() {
                    "read" => {
                        if let Some(path) = &pc.path {
                            let full = absolutize(path, &root);
                            run.touch_file(&full, ts, |f| f.reads += 1);
                        }
                    }
                    "search" | "list_files" => {}
                    _ => {}
                }
                let _ = &pc.query;
            }
            run.push_cmd(CmdRun {
                cmd: one_line(&cmd, 200),
                desc: String::new(),
                ts,
                ok,
                background: false,
                duration_ms: item.duration.map(|d| d.secs * 1000 + d.nanos / 1_000_000),
            });
            run.push_event(ts, EvKind::Tool, format!("$ {}", one_line(&cmd, 120)));
            if ok == Some(false) {
                run.push_event(
                    ts,
                    EvKind::Error,
                    format!("exit {} {}", item.exit_code.unwrap_or(-1), one_line(&cmd, 80)),
                );
            }
        }
        "FileChange" => {
            if let Some(changes) = item.changes {
                for (path, v) in changes {
                    let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("update").to_string();
                    let diff = v.get("unified_diff").and_then(|d| d.as_str()).unwrap_or("");
                    let (add, del) = super::count_diff_lines(diff);
                    run.touch_file(&path, ts, |f| {
                        if kind == "add" { f.writes += 1 } else { f.edits += 1 }
                        f.added += add;
                        f.removed += del;
                    });
                    run.lines_added += add as u64;
                    run.lines_removed += del as u64;
                    run.push_event(ts, EvKind::Tool, format!("edited {}", rel_path(&path, &root)));
                }
            }
        }
        "Extension" | "WebSearch" => {
            let mut queries: Vec<String> = Vec::new();
            if let Some(q) = &item.query {
                if !q.is_empty() {
                    queries.push(q.clone());
                }
            }
            if let Some(a) = &item.action {
                if let Some(qs) = a.get("queries").and_then(|q| q.as_array()) {
                    for q in qs.iter().filter_map(|q| q.as_str()) {
                        if !queries.iter().any(|x| x == q) {
                            queries.push(q.to_string());
                        }
                    }
                }
            }
            for q in &queries {
                run.push_web(WebKind::Search, q.clone(), ts);
            }
            for r in item.results.iter().take(5) {
                if !r.url.is_empty() {
                    run.push_web(WebKind::Fetch, r.url.clone(), ts);
                }
            }
            if let Some(q) = queries.first() {
                run.push_event(ts, EvKind::Tool, format!("searching web: {}", one_line(q, 80)));
            }
        }
        "McpToolCall" => {
            *run.tool_counts.entry(format!("mcp:{}.{}", item.server, item.tool)).or_default() += 1;
            run.push_event(ts, EvKind::Tool, format!("mcp {}.{}", item.server, item.tool));
            if item.status == "failed" {
                run.push_event(ts, EvKind::Error, format!("mcp {}.{} failed", item.server, item.tool));
            }
        }
        "ContextCompaction" => {
            run.compactions += 1;
            run.push_event(ts, EvKind::Compact, "context compacted");
        }
        "ImageView" => {
            let p = item.path.strip_prefix("file://").unwrap_or(&item.path).to_string();
            run.touch_file(&p, ts, |f| f.reads += 1);
        }
        _ => {}
    }
}

/// Turns a raw codex tool call into a human line. The `exec` tool carries a
/// small JS program; pull the shell command out of it when possible.
fn summarize_call(name: &str, text: &str) -> String {
    if let Some(i) = text.find("cmd:\"") {
        let rest = &text[i + 5..];
        let end = rest.find("\"").unwrap_or(rest.len());
        return format!("$ {}", one_line(&rest[..end].replace("\\n", " "), 80));
    }
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        if let Some(c) = v.get("cmd").or_else(|| v.get("command")) {
            return format!("$ {}", one_line(&value_text(c), 80));
        }
    }
    match name {
        "wait" => "waiting on a process".into(),
        "apply_patch" => "applying a patch".into(),
        n => n.replace('_', " "),
    }
}

fn value_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(value_text).collect::<Vec<_>>().join(" "),
        Value::Object(o) => {
            for k in ["objective", "goal", "text", "title", "description", "summary"] {
                if let Some(x) = o.get(k) {
                    return value_text(x);
                }
            }
            o.keys().next().cloned().unwrap_or_default()
        }
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn absolutize(path: &str, root: &str) -> String {
    if path.starts_with('/') || root.is_empty() {
        path.to_string()
    } else {
        format!("{}/{}", root.trim_end_matches('/'), path)
    }
}

/// Metadata for the project index: cwd, id, start time and the first real
/// user prompt (codex has no title of its own for most sessions).
pub fn scan_meta(path: &std::path::Path) -> (String, String, i64, String) {
    let mut cwd = String::new();
    let mut id = String::new();
    let mut ts = 0;
    let mut first = String::new();
    let _ = super::head_lines(path, 4 * 1024 * 1024, |l| {
        let Ok(line) = serde_json::from_slice::<Line>(l) else { return true };
        let Some(p) = line.payload else { return true };
        if line.ty == "session_meta" {
            #[derive(Deserialize, Default)]
            #[serde(default)]
            struct Meta {
                id: String,
                cwd: String,
                timestamp: String,
            }
            if let Ok(m) = serde_json::from_str::<Meta>(p.get()) {
                cwd = m.cwd;
                id = m.id;
                ts = parse_ts(&m.timestamp);
            }
            return true;
        }
        if let Ok(pl) = serde_json::from_str::<Payload>(p.get()) {
            let text = match pl.ty.as_str() {
                "user_message" => pl.message.unwrap_or_default(),
                "item_completed" => pl
                    .item
                    .and_then(|i| serde_json::from_str::<Item>(i.get()).ok())
                    .filter(|i| i.ty == "UserMessage")
                    .map(|i| i.content.iter().map(|c| c.text.as_str()).collect::<Vec<_>>().join(" "))
                    .unwrap_or_default(),
                _ => String::new(),
            };
            let t = text.trim();
            if !t.is_empty() && !t.starts_with('<') {
                first = one_line(t, 80);
                return false;
            }
        }
        true
    });
    (cwd, id, ts, first)
}
