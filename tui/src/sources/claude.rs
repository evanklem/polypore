//! Claude Code transcript adapter (`~/.claude/projects/<enc>/<session>.jsonl`).
//! The format is undocumented, so every field is optional and unknown entries
//! are ignored.

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::model::*;

#[derive(Deserialize, Default)]
#[serde(default)]
struct Line<'a> {
    #[serde(rename = "type")]
    ty: String,
    timestamp: String,
    cwd: String,
    #[serde(rename = "gitBranch")]
    git_branch: String,
    #[serde(rename = "isSidechain")]
    is_sidechain: bool,
    #[serde(rename = "isMeta")]
    is_meta: bool,
    #[serde(borrow)]
    message: Option<&'a RawValue>,
    #[serde(rename = "aiTitle")]
    ai_title: String,
    #[serde(rename = "permissionMode")]
    permission_mode: String,
    #[serde(rename = "totalCostUSD")]
    total_cost: Option<f64>,
    #[serde(rename = "totalLinesAdded")]
    lines_added: Option<u64>,
    #[serde(rename = "totalLinesRemoved")]
    lines_removed: Option<u64>,
    #[serde(rename = "toolUseResult", borrow)]
    tool_use_result: Option<&'a RawValue>,
    subtype: String,
    #[serde(rename = "durationMs")]
    duration_ms: Option<u64>,
    #[serde(rename = "thinkingDurationMs")]
    thinking_ms: Option<u64>,
    effort: String,
    content: String,
    level: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Msg<'a> {
    id: String,
    model: String,
    #[serde(borrow)]
    content: Option<&'a RawValue>,
    usage: Option<Usage>,
    stop_reason: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Usage {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_input_tokens: u64,
    cache_creation_input_tokens: u64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Block<'a> {
    #[serde(rename = "type")]
    ty: String,
    id: String,
    name: String,
    #[serde(borrow)]
    input: Option<&'a RawValue>,
    tool_use_id: String,
    is_error: bool,
    #[serde(borrow)]
    content: Option<&'a RawValue>,
    text: String,
    thinking: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ToolInput {
    file_path: String,
    notebook_path: String,
    command: String,
    description: String,
    run_in_background: bool,
    url: String,
    query: String,
    pattern: String,
    path: String,
    subject: String,
    #[serde(rename = "activeForm")]
    active_form: String,
    #[serde(rename = "taskId")]
    task_id: String,
    status: String,
    subagent_type: String,
    prompt: String,
    skill: String,
    old_string: String,
    new_string: String,
    content: String,
    todos: Vec<Todo>,
    questions: Vec<Question>,
    edits: Vec<EditPair>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Todo {
    content: String,
    status: String,
    #[serde(rename = "activeForm")]
    active_form: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Question {
    question: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct EditPair {
    old_string: String,
    new_string: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ToolUseResult {
    task: Option<TaskRef>,
    status: String,
    #[serde(rename = "isAsync")]
    is_async: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TaskRef {
    id: String,
    subject: String,
}

/// Per-run parser state that must survive between incremental reads.
#[derive(Default, Clone, Debug)]
pub struct ClaudeCursor {
    last_msg_id: String,
    /// tool_use id -> (tool name, raw input) for tools awaiting a result.
    inputs: std::collections::HashMap<String, (String, String)>,
}

pub fn apply_line(run: &mut AgentRun, cur: &mut ClaudeCursor, raw: &[u8]) {
    // Cheap reject for the large bookkeeping entries before full parsing.
    if raw.len() > 2048 {
        let head = &raw[..raw.len().min(256)];
        if contains(head, b"\"type\":\"api-request") || contains(head, b"\"type\":\"attachment\"") {
            return;
        }
    }
    let Ok(line) = serde_json::from_slice::<Line>(raw) else { return };
    let ts = if line.timestamp.is_empty() { 0 } else { parse_ts(&line.timestamp) };
    if ts > 0 {
        if run.started == 0 {
            run.started = ts;
        }
        run.updated = run.updated.max(ts);
    }
    if !line.cwd.is_empty() && run.cwd.is_empty() {
        run.cwd = line.cwd.clone();
    }
    if !line.git_branch.is_empty() {
        run.branch = line.git_branch.clone();
    }
    if !line.effort.is_empty() {
        run.effort = line.effort.clone();
    }
    if let Some(ms) = line.thinking_ms {
        run.thinking_ms += ms;
    }
    match line.ty.as_str() {
        "ai-title" if !line.ai_title.is_empty() => run.title = line.ai_title.clone(),
        "permission-mode" if !line.permission_mode.is_empty() => {
            run.permission_mode = line.permission_mode.clone()
        }
        "cost-state" => {
            if let Some(c) = line.total_cost {
                run.cost_usd = c;
            }
            if let Some(a) = line.lines_added {
                run.lines_added = a;
            }
            if let Some(r) = line.lines_removed {
                run.lines_removed = r;
            }
        }
        "system" => match line.subtype.as_str() {
            "turn_duration" => {
                run.turn_open = false;
                run.turn_ms_total += line.duration_ms.unwrap_or(0);
                run.pending.clear();
                refresh_now(run);
            }
            "compact_boundary" => {
                run.compactions += 1;
                run.push_event(ts, EvKind::Compact, "context compacted");
            }
            "api_error" => run.push_event(ts, EvKind::Error, format!("api error {}", line.content)),
            _ => {
                if line.level == "error" && !line.content.is_empty() {
                    run.push_event(ts, EvKind::Error, line.content.clone());
                }
            }
        },
        "assistant" if !line.is_sidechain => {
            if let Some(m) = line.message {
                assistant(run, cur, m.get(), ts);
            }
        }
        "user" if !line.is_sidechain && !line.is_meta => {
            if let Some(m) = line.message {
                user(run, cur, m.get(), line.tool_use_result.map(|r| r.get()), ts);
            }
        }
        _ => {}
    }
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

fn assistant(run: &mut AgentRun, cur: &mut ClaudeCursor, raw: &str, ts: i64) {
    let Ok(msg) = serde_json::from_str::<Msg>(raw) else { return };
    if !msg.model.is_empty() && !msg.model.starts_with('<') {
        run.model = msg.model.clone();
    }
    if let Some(u) = &msg.usage {
        let ctx = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
        if ctx > 0 {
            run.ctx_tokens = ctx;
        }
        if msg.id != cur.last_msg_id {
            cur.last_msg_id = msg.id.clone();
            run.tokens_in += u.input_tokens + u.cache_creation_input_tokens;
            run.tokens_cache_read += u.cache_read_input_tokens;
            run.tokens_out += u.output_tokens;
        }
    }
    let blocks: Vec<Block> = msg
        .content
        .and_then(|c| serde_json::from_str(c.get()).ok())
        .unwrap_or_default();
    for b in blocks {
        match b.ty.as_str() {
            "text" if !b.text.trim().is_empty() => {
                run.last_reply = one_line(&b.text, 300);
                run.push_event(ts, EvKind::Reply, b.text.clone());
            }
            "thinking" => {
                run.thinking_count += 1;
                if !b.thinking.trim().is_empty() {
                    run.last_reasoning = one_line(&b.thinking, 300);
                    run.push_event(ts, EvKind::Thinking, b.thinking.clone());
                }
            }
            "tool_use" => {
                let input_raw = b.input.map(|r| r.get()).unwrap_or("{}");
                tool_use(run, cur, &b.id, &b.name, input_raw, ts);
            }
            _ => {}
        }
    }
    match msg.stop_reason.as_deref() {
        Some("end_turn") | Some("stop_sequence") => {
            run.turn_open = false;
        }
        Some("tool_use") => run.turn_open = true,
        _ => {}
    }
    refresh_now(run);
}

fn tool_use(run: &mut AgentRun, cur: &mut ClaudeCursor, id: &str, name: &str, input_raw: &str, ts: i64) {
    *run.tool_counts.entry(name.to_string()).or_default() += 1;
    let inp: ToolInput = serde_json::from_str(input_raw).unwrap_or_default();
    let root = run.cwd.clone();
    let summary = match name {
        "Read" => {
            run.touch_file(&inp.file_path, ts, |f| f.reads += 1);
            format!("reading {}", rel_path(&inp.file_path, &root))
        }
        "Edit" | "MultiEdit" | "NotebookEdit" => {
            let path = if inp.file_path.is_empty() { inp.notebook_path.clone() } else { inp.file_path.clone() };
            let (mut add, mut del) = (count_lines(&inp.new_string), count_lines(&inp.old_string));
            for e in &inp.edits {
                add += count_lines(&e.new_string);
                del += count_lines(&e.old_string);
            }
            run.touch_file(&path, ts, |f| {
                f.edits += 1;
                f.added += add;
                f.removed += del;
            });
            format!("editing {}", rel_path(&path, &root))
        }
        "Write" => {
            let add = count_lines(&inp.content);
            run.touch_file(&inp.file_path, ts, |f| {
                f.writes += 1;
                f.added += add;
            });
            format!("writing {}", rel_path(&inp.file_path, &root))
        }
        "Bash" => {
            run.push_cmd(CmdRun {
                cmd: one_line(&inp.command, 200),
                desc: inp.description.clone(),
                ts,
                ok: None,
                background: inp.run_in_background,
                duration_ms: None,
            });
            if inp.description.is_empty() {
                format!("$ {}", one_line(&inp.command, 80))
            } else {
                inp.description.to_lowercase()
            }
        }
        "WebFetch" => {
            run.push_web(WebKind::Fetch, inp.url.clone(), ts);
            format!("fetching {}", domain_of(&inp.url))
        }
        "WebSearch" => {
            run.push_web(WebKind::Search, inp.query.clone(), ts);
            format!("searching web: {}", one_line(&inp.query, 60))
        }
        "Grep" => format!("grep {}", one_line(&inp.pattern, 50)),
        "Glob" => format!("glob {}", one_line(&inp.pattern, 50)),
        "Agent" | "Task" => {
            run.subagents.push(Subagent {
                id: id.to_string(),
                desc: if inp.description.is_empty() { one_line(&inp.prompt, 60) } else { inp.description.clone() },
                kind: if inp.subagent_type.is_empty() { "agent".into() } else { inp.subagent_type.clone() },
                ts,
                done: false,
                ok: true,
            });
            format!("subagent: {}", inp.description)
        }
        "TaskCreate" => format!("planning: {}", inp.subject),
        "TaskUpdate" => {
            apply_task_update(run, &inp);
            "updating tasks".into()
        }
        "TodoWrite" => {
            run.tasks = inp
                .todos
                .iter()
                .enumerate()
                .map(|(i, t)| Task {
                    id: (i + 1).to_string(),
                    subject: t.content.clone(),
                    active: t.active_form.clone(),
                    status: task_status(&t.status),
                })
                .collect();
            "updating todos".into()
        }
        "AskUserQuestion" => {
            let q = inp.questions.first().map(|q| q.question.clone()).unwrap_or_else(|| "question".into());
            run.question = Some(one_line(&q, 200));
            format!("asking: {}", one_line(&q, 60))
        }
        "ExitPlanMode" => {
            run.approval = Some("plan ready for approval".into());
            "waiting for plan approval".into()
        }
        "Skill" => {
            *run.skills_used.entry(inp.skill.clone()).or_default() += 1;
            format!("skill /{}", inp.skill)
        }
        n if n.contains("navigate") => {
            run.push_web(WebKind::Browse, inp.url.clone(), ts);
            format!("browsing {}", domain_of(&inp.url))
        }
        n if n.starts_with("mcp__") => {
            let short = n.trim_start_matches("mcp__").replace("__", ".");
            format!("mcp {short}")
        }
        n => n.to_lowercase(),
    };
    run.push_event(ts, EvKind::Tool, summary.clone());
    run.pending.insert(id.to_string(), PendingTool { name: name.to_string(), summary, ts });
    cur.inputs.insert(id.to_string(), (name.to_string(), input_raw.to_string()));
    run.turn_open = true;
}

fn user(run: &mut AgentRun, cur: &mut ClaudeCursor, raw: &str, tur: Option<&str>, ts: i64) {
    let Ok(msg) = serde_json::from_str::<Msg>(raw) else { return };
    let Some(content) = msg.content else { return };
    let c = content.get();
    if c.starts_with('"') {
        let text: String = serde_json::from_str(c).unwrap_or_default();
        prompt(run, &text, ts);
        return;
    }
    let blocks: Vec<Block> = serde_json::from_str(c).unwrap_or_default();
    for b in blocks {
        match b.ty.as_str() {
            "text" => prompt(run, &b.text, ts),
            "tool_result" => {
                let id = b.tool_use_id.clone();
                run.pending.remove(&id);
                let (name, input_raw) = cur.inputs.remove(&id).unwrap_or_default();
                let result: ToolUseResult = tur.and_then(|t| serde_json::from_str(t).ok()).unwrap_or_default();
                tool_result(run, &id, &name, &input_raw, b.is_error, &result, b.content.map(|r| r.get()), ts);
            }
            _ => {}
        }
    }
    refresh_now(run);
}

fn prompt(run: &mut AgentRun, text: &str, ts: i64) {
    let t = text.trim();
    if t.is_empty() || t.starts_with('<') || t.starts_with("[Request interrupted") {
        if t.starts_with("[Request interrupted") {
            run.turn_open = false;
            run.pending.clear();
        }
        return;
    }
    run.turns += 1;
    run.turn_open = true;
    run.question = None;
    run.approval = None;
    run.last_prompt = one_line(t, 300);
    run.push_event(ts, EvKind::Prompt, t.to_string());
}

#[allow(clippy::too_many_arguments)]
fn tool_result(
    run: &mut AgentRun,
    id: &str,
    name: &str,
    input_raw: &str,
    is_error: bool,
    result: &ToolUseResult,
    content: Option<&str>,
    ts: i64,
) {
    match name {
        "Bash" => {
            if let Some(c) = run.cmds.iter_mut().rev().find(|c| c.ok.is_none()) {
                c.ok = Some(!is_error);
                if c.ts > 0 && ts > c.ts {
                    c.duration_ms = Some((ts - c.ts) as u64);
                }
            }
        }
        "TaskCreate" => {
            let inp: ToolInput = serde_json::from_str(input_raw).unwrap_or_default();
            let tid = result
                .task
                .as_ref()
                .map(|t| t.id.clone())
                .or_else(|| content.and_then(task_id_from_text))
                .unwrap_or_else(|| (run.tasks.len() + 1).to_string());
            let subject = result
                .task
                .as_ref()
                .map(|t| t.subject.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or(inp.subject);
            if !run.tasks.iter().any(|t| t.id == tid) {
                run.tasks.push(Task { id: tid, subject, active: inp.active_form, status: TaskStatus::Pending });
            }
        }
        "Agent" | "Task" => {
            if let Some(s) = run.subagents.iter_mut().find(|s| s.id == id) {
                let async_launch = result.is_async && result.status.contains("launch");
                s.done = !async_launch;
                s.ok = !is_error;
            }
        }
        "AskUserQuestion" => run.question = None,
        "ExitPlanMode" => run.approval = None,
        _ => {}
    }
    if is_error {
        let text = content.map(result_text).unwrap_or_default();
        let first = text.lines().next().unwrap_or("").to_string();
        run.push_event(ts, EvKind::Error, format!("{} failed: {}", name.to_lowercase(), first));
    }
}

fn apply_task_update(run: &mut AgentRun, inp: &ToolInput) {
    if let Some(t) = run.tasks.iter_mut().find(|t| t.id == inp.task_id) {
        if !inp.status.is_empty() {
            if inp.status == "deleted" {
                let id = t.id.clone();
                run.tasks.retain(|t| t.id != id);
                return;
            }
            t.status = task_status(&inp.status);
        }
        if !inp.subject.is_empty() {
            t.subject = inp.subject.clone();
        }
        if !inp.active_form.is_empty() {
            t.active = inp.active_form.clone();
        }
    }
}

fn task_status(s: &str) -> TaskStatus {
    match s {
        "completed" | "done" => TaskStatus::Done,
        "in_progress" | "active" => TaskStatus::InProgress,
        _ => TaskStatus::Pending,
    }
}

fn task_id_from_text(c: &str) -> Option<String> {
    let text = result_text(c);
    let i = text.find('#')?;
    let digits: String = text[i + 1..].chars().take_while(|c| c.is_ascii_digit()).collect();
    (!digits.is_empty()).then_some(digits)
}

fn result_text(raw: &str) -> String {
    if raw.starts_with('"') {
        return serde_json::from_str(raw).unwrap_or_default();
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct T {
        text: String,
    }
    let v: Vec<T> = serde_json::from_str(raw).unwrap_or_default();
    v.into_iter().map(|t| t.text).collect::<Vec<_>>().join("\n")
}

fn count_lines(s: &str) -> u32 {
    if s.is_empty() { 0 } else { s.lines().count() as u32 }
}

/// Recomputes the one-line "what is it doing right now" summary.
pub fn refresh_now(run: &mut AgentRun) {
    if let Some(p) = run.pending.values().max_by_key(|p| p.ts) {
        run.now = p.summary.clone();
        return;
    }
    if let Some(q) = &run.question {
        run.now = format!("asking: {q}");
        return;
    }
    if run.turn_open {
        run.now = "thinking".into();
        return;
    }
    if let Some(t) = run.tasks.iter().find(|t| t.status == TaskStatus::InProgress) {
        if !t.active.is_empty() {
            run.now = t.active.to_lowercase();
            return;
        }
    }
    run.now = if run.last_reply.is_empty() { String::new() } else { run.last_reply.clone() };
}

/// Fast metadata scan used by the project index: cwd, title and first prompt
/// without folding the whole transcript.
#[derive(Default, Debug, Clone)]
pub struct ClaudeMeta {
    pub cwd: String,
    pub title: String,
    pub first_prompt: String,
}

pub fn scan_meta(path: &std::path::Path) -> ClaudeMeta {
    let mut meta = ClaudeMeta::default();
    let _ = super::head_lines(path, 512 * 1024, |l| {
        if let Ok(line) = serde_json::from_slice::<Line>(l) {
            if meta.cwd.is_empty() && !line.cwd.is_empty() {
                meta.cwd = line.cwd.clone();
            }
            if line.ty == "ai-title" && !line.ai_title.is_empty() {
                meta.title = line.ai_title.clone();
            }
            if line.ty == "user" && meta.first_prompt.is_empty() && !line.is_meta {
                if let Some(m) = line.message {
                    if let Ok(msg) = serde_json::from_str::<Msg>(m.get()) {
                        if let Some(c) = msg.content {
                            let s = c.get();
                            let text = if s.starts_with('"') {
                                serde_json::from_str::<String>(s).unwrap_or_default()
                            } else {
                                serde_json::from_str::<Vec<Block>>(s)
                                    .unwrap_or_default()
                                    .into_iter()
                                    .find(|b| b.ty == "text")
                                    .map(|b| b.text)
                                    .unwrap_or_default()
                            };
                            if !text.trim_start().starts_with('<') {
                                meta.first_prompt = one_line(&text, 80);
                            }
                        }
                    }
                }
            }
        }
        meta.cwd.is_empty() || meta.first_prompt.is_empty()
    });
    if meta.title.is_empty() {
        let _ = super::last_lines(path, 256 * 1024, |l| {
            if let Ok(line) = serde_json::from_slice::<Line>(l) {
                if line.ty == "ai-title" && !line.ai_title.is_empty() {
                    meta.title = line.ai_title.clone();
                }
                if meta.cwd.is_empty() && !line.cwd.is_empty() {
                    meta.cwd = line.cwd.clone();
                }
            }
        });
    }
    meta
}
