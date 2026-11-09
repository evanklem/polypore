//! Cross-session analysis. Stats are local and cached per transcript; the
//! LLM pass is on demand and sends a compact extract to a headless agent.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::config::state_dir;
use crate::model::*;
use crate::sources::{self, claude::ClaudeCursor};
use crate::store::SessionInfo;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct SessionStat {
    pub kind: Option<AgentKind>,
    pub root: String,
    pub title: String,
    pub started: i64,
    pub updated: i64,
    pub turns: u32,
    pub turn_ms: u64,
    pub tools: HashMap<String, u32>,
    pub errors: u32,
    pub cmds: u32,
    pub failed_cmds: Vec<String>,
    pub loops: Vec<String>,
    pub edited: Vec<(String, u32)>,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub tokens_cache: u64,
    pub cost: f64,
    pub skills: HashMap<String, u32>,
    pub compactions: u32,
    pub prompts: Vec<String>,
    pub error_lines: Vec<String>,
    pub size: u64,
    pub mtime: i64,
}

#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub sessions: usize,
    pub claude: usize,
    pub codex: usize,
    pub per_day: Vec<(String, u32, u32)>,
    pub tokens_per_day: Vec<(String, u64)>,
    pub tools: Vec<(String, u32)>,
    pub failing: Vec<(String, u32)>,
    pub loops: Vec<(String, String)>,
    pub files: Vec<(String, u32)>,
    pub projects: Vec<(String, u32)>,
    pub skills: Vec<(String, u32)>,
    pub avg_turn_s: f64,
    pub turns: u64,
    pub errors: u64,
    pub cmds: u64,
    pub compactions: u64,
    pub cost: f64,
    pub tokens_out: u64,
    pub tokens_in: u64,
    /// Prompts per day: (label, claude, codex), oldest first.
    pub prompts_per_day: Vec<(String, u32, u32)>,
    /// Prompts by weekday (Mon = 0) and hour, local time.
    pub heat: [[u32; 24]; 7],
    pub days: i64,
    pub active_days: u32,
}

#[derive(Default)]
pub struct State {
    pub running: bool,
    pub progress: (usize, usize),
    pub stats: Option<Stats>,
    pub llm_running: bool,
    pub report: Option<String>,
    pub report_path: Option<PathBuf>,
    pub message: String,
}

pub type Shared = Arc<Mutex<State>>;

fn cache_path() -> PathBuf {
    state_dir().join("stats-cache.json")
}

pub fn start_stats(state: Shared, sessions: Vec<SessionInfo>, days: i64) {
    {
        let mut s = state.lock().unwrap();
        if s.running {
            return;
        }
        s.running = true;
        s.message = "scanning sessions".into();
    }
    std::thread::spawn(move || {
        let cutoff = now_ms() - days * 86_400_000;
        let mut cache: HashMap<String, SessionStat> = std::fs::read_to_string(cache_path())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let todo: Vec<&SessionInfo> = sessions.iter().filter(|s| s.mtime >= cutoff).collect();
        let total = todo.len();
        let mut out: Vec<SessionStat> = Vec::new();
        for (i, s) in todo.iter().enumerate() {
            state.lock().unwrap().progress = (i, total);
            let key = s.path.to_string_lossy().to_string();
            if let Some(c) = cache.get(&key) {
                if c.size == s.size && c.mtime == s.mtime {
                    out.push(c.clone());
                    continue;
                }
            }
            let st = summarize(s);
            cache.insert(key, st.clone());
            out.push(st);
        }
        cache.retain(|_, v| v.mtime >= cutoff - 30 * 86_400_000);
        if let Ok(t) = serde_json::to_string(&cache) {
            let _ = std::fs::write(cache_path(), t);
        }
        let stats = aggregate(&out, days);
        let mut st = state.lock().unwrap();
        st.stats = Some(stats);
        st.running = false;
        st.progress = (total, total);
        st.message = format!("{} sessions from the last {days} days", total);
        *LAST.lock().unwrap() = out;
    });
}

static LAST: Mutex<Vec<SessionStat>> = Mutex::new(Vec::new());

fn summarize(s: &SessionInfo) -> SessionStat {
    let mut run = AgentRun::new(s.key.clone(), s.path.clone());
    let mut cur = ClaudeCursor::default();
    let mut off = 0u64;
    let mut prompts = Vec::new();
    let _ = sources::tail_lines(&s.path, &mut off, |line| {
        let before = run.last_prompt.clone();
        match s.key.kind {
            AgentKind::Claude => sources::claude::apply_line(&mut run, &mut cur, line),
            AgentKind::Codex => sources::codex::apply_line(&mut run, line),
        }
        if run.last_prompt != before && !run.last_prompt.is_empty() && prompts.len() < 40 {
            prompts.push(one_line(&run.last_prompt, 240));
        }
    });
    let mut fail_counts: HashMap<String, u32> = HashMap::new();
    let mut failed = Vec::new();
    for c in &run.cmds {
        if c.ok == Some(false) {
            let norm = norm_cmd(&c.cmd);
            *fail_counts.entry(c.cmd.clone()).or_default() += 1;
            failed.push(norm);
        }
    }
    let mut loops: Vec<String> = fail_counts
        .iter()
        .filter(|(_, n)| **n >= 3)
        .map(|(c, n)| format!("`{}` failed {n} times", one_line(c, 70)))
        .collect();
    let mut edited: Vec<(String, u32)> = run.files.values().filter(|f| f.edits + f.writes > 0).map(|f| (f.path.clone(), f.edits + f.writes)).collect();
    edited.sort_by(|a, b| b.1.cmp(&a.1));
    for (p, n) in edited.iter().filter(|(_, n)| *n >= 10) {
        loops.push(format!("{} edited {n} times", rel_path(p, &s.root)));
    }
    edited.truncate(20);
    SessionStat {
        kind: Some(s.key.kind),
        root: s.root.clone(),
        title: run.display_title(),
        started: run.started,
        updated: run.updated,
        turns: run.turns,
        turn_ms: run.turn_ms_total,
        tools: run.tool_counts.clone(),
        errors: run.errors.len() as u32,
        cmds: run.cmds.len() as u32,
        failed_cmds: failed,
        loops,
        edited,
        tokens_in: run.tokens_in,
        tokens_out: run.tokens_out,
        tokens_cache: run.tokens_cache_read,
        cost: run.cost_usd,
        skills: run.skills_used.clone(),
        compactions: run.compactions,
        prompts,
        error_lines: run.errors.iter().rev().take(12).map(|e| one_line(&e.text, 160)).collect(),
        size: s.size,
        mtime: s.mtime,
    }
}

/// Groups a failing command by what actually ran: skips `cd dir &&`,
/// `export`, `VAR=value` prefixes and flags, keeps the first two words.
fn norm_cmd(c: &str) -> String {
    let segs: Vec<&str> = c.split(|ch| ch == ';' || ch == '&' || ch == '|').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    let seg = segs
        .iter()
        .find(|s| {
            let first = s.split_whitespace().next().unwrap_or("");
            !(first == "cd" || first == "export" || first == "set" || first == "source" || first == "." || (first.contains('=') && !first.starts_with('-')))
        })
        .copied()
        .unwrap_or(c);
    let words: Vec<&str> = seg
        .split_whitespace()
        .skip_while(|w| w.contains('=') && !w.starts_with('-'))
        .filter(|w| !w.starts_with('-'))
        .take(2)
        .map(|w| w.rsplit('/').next().unwrap_or(w))
        .collect();
    words.join(" ")
}

fn top<K: Clone + Ord>(m: HashMap<K, u32>, n: usize) -> Vec<(K, u32)> {
    let mut v: Vec<(K, u32)> = m.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    v.truncate(n);
    v
}

fn aggregate(all: &[SessionStat], days: i64) -> Stats {
    let mut st = Stats { sessions: all.len(), ..Default::default() };
    let mut tools = HashMap::new();
    let mut failing = HashMap::new();
    let mut files = HashMap::new();
    let mut projects = HashMap::new();
    let mut skills = HashMap::new();
    let mut day_claude: HashMap<String, u32> = HashMap::new();
    let mut day_codex: HashMap<String, u32> = HashMap::new();
    let mut day_tokens: HashMap<String, u64> = HashMap::new();
    let mut prompt_claude: HashMap<String, u32> = HashMap::new();
    let mut prompt_codex: HashMap<String, u32> = HashMap::new();
    let mut turn_ms = 0u64;
    st.days = days;
    for s in all {
        let when = if s.started > 0 { s.started } else { s.updated };
        if let Some(dt) = chrono::DateTime::from_timestamp_millis(when) {
            use chrono::{Datelike, Timelike};
            let local = dt.with_timezone(&chrono::Local);
            let wd = local.weekday().num_days_from_monday() as usize;
            st.heat[wd][local.hour() as usize] += s.turns.max(1);
        }
        let pday = day_of(s.updated.max(s.started));
        match s.kind {
            Some(AgentKind::Codex) => *prompt_codex.entry(pday).or_default() += s.turns.max(1),
            _ => *prompt_claude.entry(pday).or_default() += s.turns.max(1),
        }
        match s.kind {
            Some(AgentKind::Claude) => st.claude += 1,
            Some(AgentKind::Codex) => st.codex += 1,
            None => {}
        }
        let day = day_of(s.updated.max(s.started));
        match s.kind {
            Some(AgentKind::Codex) => *day_codex.entry(day.clone()).or_default() += 1,
            _ => *day_claude.entry(day.clone()).or_default() += 1,
        }
        *day_tokens.entry(day).or_default() += s.tokens_out + s.tokens_in;
        for (k, v) in &s.tools {
            *tools.entry(k.clone()).or_default() += *v;
        }
        for f in &s.failed_cmds {
            *failing.entry(f.clone()).or_default() += 1;
        }
        for (p, n) in &s.edited {
            let rel = rel_path(p, &s.root);
            let label = if rel.starts_with('/') || rel.starts_with('~') { rel } else { format!("{}/{rel}", std::path::Path::new(&s.root).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()) };
            *files.entry(label).or_default() += *n;
        }
        let pname = std::path::Path::new(&s.root).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        *projects.entry(pname.clone()).or_default() += 1;
        for (k, v) in &s.skills {
            *skills.entry(k.clone()).or_default() += *v;
        }
        for l in &s.loops {
            st.loops.push((pname.clone(), l.clone()));
        }
        st.turns += s.turns as u64;
        turn_ms += s.turn_ms;
        st.errors += s.errors as u64;
        st.cmds += s.cmds as u64;
        st.compactions += s.compactions as u64;
        st.cost += s.cost;
        st.tokens_out += s.tokens_out;
        st.tokens_in += s.tokens_in;
    }
    st.avg_turn_s = if st.turns > 0 { turn_ms as f64 / st.turns as f64 / 1000.0 } else { 0.0 };
    st.tools = top(tools, 12);
    st.failing = top(failing, 10);
    st.files = top(files, 10);
    st.projects = top(projects, 10);
    st.skills = top(skills, 12);
    st.loops.truncate(30);
    let today = chrono::Local::now().date_naive();
    for i in (0..days.min(60)).rev() {
        let d = (today - chrono::Duration::days(i)).format("%m-%d").to_string();
        st.per_day.push((d.clone(), *day_claude.get(&d).unwrap_or(&0), *day_codex.get(&d).unwrap_or(&0)));
        st.tokens_per_day.push((d.clone(), *day_tokens.get(&d).unwrap_or(&0)));
        let (pc, px) = (*prompt_claude.get(&d).unwrap_or(&0), *prompt_codex.get(&d).unwrap_or(&0));
        if pc + px > 0 {
            st.active_days += 1;
        }
        st.prompts_per_day.push((d, pc, px));
    }
    st
}

fn day_of(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.with_timezone(&chrono::Local).format("%m-%d").to_string())
        .unwrap_or_default()
}

const INSTRUCTIONS: &str = "You are reviewing a developer's own AI coding-agent sessions (Claude Code and Codex) to help them work better. \
Below is an extract: per session, the project, the user's prompts and the errors the agent hit. Write a short markdown report with these sections:\n\
1. Corrections the user keeps making (quote short prompt fragments as evidence).\n\
2. Where agents waste time (repeated failures, loops, flailing), with the concrete pattern.\n\
3. Instructions worth adding to CLAUDE.md / AGENTS.md, as ready-to-paste bullet lines.\n\
4. Skills worth writing, one line each with when it would trigger.\n\
Be specific and dry. No preamble, no closing summary, no em dashes.\n\n";

pub fn build_extract(max_kb: usize) -> String {
    let all = LAST.lock().unwrap().clone();
    let mut sorted = all;
    sorted.sort_by_key(|s| -s.updated);
    let mut out = String::new();
    for s in sorted {
        if out.len() > max_kb * 1024 {
            break;
        }
        if s.prompts.is_empty() && s.error_lines.is_empty() {
            continue;
        }
        let pname = std::path::Path::new(&s.root).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        out.push_str(&format!(
            "## {} · {} · {} · {}\n",
            pname,
            s.kind.map(|k| k.label()).unwrap_or("?"),
            day_of(s.updated),
            one_line(&s.title, 80)
        ));
        if !s.prompts.is_empty() {
            out.push_str("prompts:\n");
            for p in s.prompts.iter().take(25) {
                out.push_str(&format!("- {p}\n"));
            }
        }
        if !s.error_lines.is_empty() {
            out.push_str("errors:\n");
            for e in s.error_lines.iter().take(8) {
                out.push_str(&format!("- {e}\n"));
            }
        }
        for l in &s.loops {
            out.push_str(&format!("- loop: {l}\n"));
        }
        out.push('\n');
    }
    out
}

pub fn start_llm(state: Shared, command: String, wiki: PathBuf, max_kb: usize) {
    {
        let mut s = state.lock().unwrap();
        if s.llm_running {
            return;
        }
        if s.stats.is_none() {
            s.message = "run the stats scan first (r)".into();
            return;
        }
        s.llm_running = true;
        s.message = format!("running `{command}` over the extract");
    }
    std::thread::spawn(move || {
        let extract = build_extract(max_kb);
        let dir = state_dir().join("analysis");
        let _ = std::fs::create_dir_all(&dir);
        let date = chrono::Local::now().format("%Y-%m-%d").to_string();
        let _ = std::fs::write(dir.join(format!("extract-{date}.md")), &extract);
        let prompt = format!("{INSTRUCTIONS}{extract}");
        let res = run_headless(&command, &prompt, &dir);
        let mut s = state.lock().unwrap();
        s.llm_running = false;
        match res {
            Ok(report) => {
                let body = format!("# Agent session analysis, {date}\n\nGenerated by polypore with `{command}`.\n\n{report}\n");
                let path = dir.join(format!("report-{date}.md"));
                let _ = std::fs::write(&path, &body);
                let mut saved = crate::config::display_path(&path);
                if wiki.is_dir() {
                    let wp = wiki.join(format!("agent-analysis-{date}.md"));
                    if std::fs::write(&wp, &body).is_ok() {
                        saved = crate::config::display_path(&wp);
                    }
                }
                s.message = format!("report saved to {saved}");
                s.report_path = Some(path);
                s.report = Some(body);
            }
            Err(e) => s.message = format!("analysis failed: {e}"),
        }
    });
}

fn run_headless(command: &str, prompt: &str, cwd: &std::path::Path) -> Result<String, String> {
    use std::io::Write;
    let argv = shell_words::split(command).map_err(|e| e.to_string())?;
    if argv.is_empty() {
        return Err("empty analysis command".into());
    }
    let mut child = std::process::Command::new(&argv[0])
        .args(&argv[1..])
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("{}: {e}", argv[0]))?;
    if let Some(mut si) = child.stdin.take() {
        si.write_all(prompt.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(crate::model::one_line(&String::from_utf8_lossy(&out.stderr), 200));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
