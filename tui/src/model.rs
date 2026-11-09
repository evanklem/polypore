//! Normalized view of an agent run. Every source adapter (claude transcripts,
//! codex rollouts) folds its raw events into these types, and every UI
//! component reads only these types.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
}

impl AgentKind {
    pub fn label(self) -> &'static str {
        match self {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct RunKey {
    pub kind: AgentKind,
    pub id: String,
}

/// What the user needs to know about a session, in order of urgency.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RunState {
    /// Blocked on you: a question, a permission prompt, a plan to approve.
    NeedsInput,
    /// The agent is mid-turn.
    Working,
    /// The process is open and waiting for your next prompt.
    Ready,
    /// No agent process is running for this session.
    Closed,
}

impl RunState {
    pub fn label(self) -> &'static str {
        match self {
            RunState::NeedsInput => "needs you",
            RunState::Working => "working",
            RunState::Ready => "ready",
            RunState::Closed => "closed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskStatus {
    Pending,
    InProgress,
    Done,
}

#[derive(Clone, Debug)]
pub struct Task {
    pub id: String,
    pub subject: String,
    pub active: String,
    pub status: TaskStatus,
}

#[derive(Clone, Debug, Default)]
pub struct FileTouch {
    pub path: String,
    pub reads: u32,
    pub edits: u32,
    pub writes: u32,
    pub added: u32,
    pub removed: u32,
    pub last: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WebKind {
    Search,
    Fetch,
    Browse,
}

#[derive(Clone, Debug)]
pub struct WebHit {
    pub kind: WebKind,
    pub target: String,
    pub ts: i64,
}

#[derive(Clone, Debug)]
pub struct CmdRun {
    pub cmd: String,
    pub desc: String,
    pub ts: i64,
    pub ok: Option<bool>,
    pub background: bool,
    pub duration_ms: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct Subagent {
    pub id: String,
    pub desc: String,
    pub kind: String,
    pub ts: i64,
    pub done: bool,
    pub ok: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvKind {
    Prompt,
    Tool,
    Reply,
    Thinking,
    Error,
    Compact,
}

#[derive(Clone, Debug)]
pub struct Event {
    pub ts: i64,
    pub kind: EvKind,
    pub text: String,
}

#[derive(Clone, Debug, Default)]
pub struct RateWindow {
    pub used_percent: f64,
    pub window_minutes: u64,
    pub resets_at: i64,
}

#[derive(Clone, Debug, Default)]
pub struct RateLimits {
    pub primary: Option<RateWindow>,
    pub secondary: Option<RateWindow>,
    pub plan: String,
    pub ts: i64,
}

#[derive(Clone, Debug)]
pub struct PendingTool {
    pub name: String,
    pub summary: String,
    pub ts: i64,
}

pub const MAX_EVENTS: usize = 400;
pub const MAX_LIST: usize = 200;

#[derive(Clone, Debug)]
pub struct AgentRun {
    pub key: RunKey,
    #[allow(dead_code)]
    pub path: PathBuf,
    pub cwd: String,
    pub title: String,
    pub branch: String,
    pub model: String,
    pub effort: String,
    pub permission_mode: String,
    pub started: i64,
    pub updated: i64,

    pub tasks: Vec<Task>,
    pub goal: String,
    pub files: HashMap<String, FileTouch>,
    pub web: Vec<WebHit>,
    pub cmds: Vec<CmdRun>,
    pub subagents: Vec<Subagent>,
    pub events: VecDeque<Event>,
    pub errors: Vec<Event>,
    pub tool_counts: HashMap<String, u32>,
    pub skills_used: HashMap<String, u32>,

    pub ctx_tokens: u64,
    pub ctx_window: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub tokens_cache_read: u64,
    pub cost_usd: f64,
    pub lines_added: u64,
    pub lines_removed: u64,
    pub compactions: u32,
    pub turns: u32,
    pub turn_ms_total: u64,

    pub thinking_ms: u64,
    pub thinking_count: u32,
    pub last_reasoning: String,

    pub pending: HashMap<String, PendingTool>,
    pub question: Option<String>,
    pub approval: Option<String>,
    pub now: String,
    pub turn_open: bool,
    pub last_prompt: String,
    pub last_reply: String,
    pub rate_limits: Option<RateLimits>,

    /// Live process info, filled by the session scanner, not the parser.
    pub live_pid: Option<u32>,
    pub live_status: Option<String>,
    /// What claude says it is waiting on (`waitingFor` in its session file).
    pub waiting_for: Option<String>,
    pub background_job: bool,

    pub offset: u64,
    pub file_len: u64,
    pub parse_complete: bool,
}

impl AgentRun {
    pub fn new(key: RunKey, path: PathBuf) -> Self {
        AgentRun {
            key,
            path,
            cwd: String::new(),
            title: String::new(),
            branch: String::new(),
            model: String::new(),
            effort: String::new(),
            permission_mode: String::new(),
            started: 0,
            updated: 0,
            tasks: Vec::new(),
            goal: String::new(),
            files: HashMap::new(),
            web: Vec::new(),
            cmds: Vec::new(),
            subagents: Vec::new(),
            events: VecDeque::new(),
            errors: Vec::new(),
            tool_counts: HashMap::new(),
            skills_used: HashMap::new(),
            ctx_tokens: 0,
            ctx_window: 0,
            tokens_in: 0,
            tokens_out: 0,
            tokens_cache_read: 0,
            cost_usd: 0.0,
            lines_added: 0,
            lines_removed: 0,
            compactions: 0,
            turns: 0,
            turn_ms_total: 0,
            thinking_ms: 0,
            thinking_count: 0,
            last_reasoning: String::new(),
            pending: HashMap::new(),
            question: None,
            approval: None,
            now: String::new(),
            turn_open: false,
            last_prompt: String::new(),
            last_reply: String::new(),
            rate_limits: None,
            live_pid: None,
            live_status: None,
            waiting_for: None,
            background_job: false,
            offset: 0,
            file_len: 0,
            parse_complete: false,
        }
    }

    pub fn push_event(&mut self, ts: i64, kind: EvKind, text: impl Into<String>) {
        let text = one_line(&text.into(), 240);
        if kind == EvKind::Error {
            self.errors.push(Event { ts, kind, text: text.clone() });
            if self.errors.len() > MAX_LIST {
                self.errors.remove(0);
            }
        }
        self.events.push_back(Event { ts, kind, text });
        while self.events.len() > MAX_EVENTS {
            self.events.pop_front();
        }
    }

    pub fn touch_file(&mut self, path: &str, ts: i64, f: impl FnOnce(&mut FileTouch)) {
        let entry = self.files.entry(path.to_string()).or_insert_with(|| FileTouch {
            path: path.to_string(),
            ..Default::default()
        });
        entry.last = entry.last.max(ts);
        f(entry);
    }

    pub fn push_web(&mut self, kind: WebKind, target: String, ts: i64) {
        self.web.push(WebHit { kind, target, ts });
        if self.web.len() > MAX_LIST {
            self.web.remove(0);
        }
    }

    pub fn push_cmd(&mut self, c: CmdRun) {
        self.cmds.push(c);
        if self.cmds.len() > MAX_LIST {
            self.cmds.remove(0);
        }
    }

    pub fn display_title(&self) -> String {
        if !self.title.is_empty() {
            return self.title.clone();
        }
        if !self.last_prompt.is_empty() {
            return one_line(&self.last_prompt, 60);
        }
        format!("{} {}", self.key.kind.label(), short_id(&self.key.id))
    }

    pub fn tasks_done(&self) -> (usize, usize) {
        let done = self.tasks.iter().filter(|t| t.status == TaskStatus::Done).count();
        (done, self.tasks.len())
    }

    pub fn ctx_percent(&self) -> Option<f64> {
        if self.ctx_window == 0 || self.ctx_tokens == 0 {
            return None;
        }
        Some((self.ctx_tokens as f64 / self.ctx_window as f64 * 100.0).min(100.0))
    }

    pub fn is_live(&self) -> bool {
        self.live_pid.is_some() || self.background_job
    }

    pub fn state(&self, now_ms: i64) -> RunState {
        self.state_hosted(now_ms, false)
    }

    /// Claude publishes its exact status (busy / idle / waiting) for live
    /// sessions; codex does not, so its state comes from turn events and
    /// file activity. `hosted` means a polypore terminal is running it.
    pub fn state_hosted(&self, now_ms: i64, hosted: bool) -> RunState {
        if let Some(status) = &self.live_status {
            return match status.to_ascii_lowercase().as_str() {
                "waiting" | "blocked" | "needs_input" | "requires_action" => RunState::NeedsInput,
                "busy" | "running" | "working" => RunState::Working,
                _ => RunState::Ready,
            };
        }
        let age = now_ms - self.updated;
        match self.key.kind {
            AgentKind::Claude => {
                if self.live_pid.is_some() || hosted {
                    if self.turn_open { RunState::Working } else { RunState::Ready }
                } else {
                    RunState::Closed
                }
            }
            AgentKind::Codex => {
                if self.approval.is_some() && (hosted || age < 10 * 60_000) {
                    RunState::NeedsInput
                } else if self.turn_open && (hosted || age < 3 * 60_000) {
                    RunState::Working
                } else if hosted || age < 20 * 60_000 {
                    RunState::Ready
                } else {
                    RunState::Closed
                }
            }
        }
    }

    /// One line saying what the session is doing or waiting for.
    pub fn activity(&self, state: RunState) -> String {
        match state {
            RunState::NeedsInput => {
                if let Some(q) = &self.question {
                    return q.clone();
                }
                if let Some(a) = &self.approval {
                    return a.clone();
                }
                if let Some(p) = self.pending.values().max_by_key(|p| p.ts) {
                    return format!("approve: {}", p.summary);
                }
                match self.waiting_for.as_deref() {
                    Some(w) if !w.is_empty() => format!("waiting for {}", w.replace('_', " ")),
                    _ => "waiting for you".into(),
                }
            }
            RunState::Working => {
                if let Some(p) = self.pending.values().max_by_key(|p| p.ts) {
                    return p.summary.clone();
                }
                if let Some(t) = self.tasks.iter().find(|t| t.status == TaskStatus::InProgress) {
                    if !t.active.is_empty() {
                        return t.active.to_lowercase();
                    }
                }
                "thinking".into()
            }
            _ => plain(&self.last_reply),
        }
    }

    pub fn ctx_percent_with(&self, window: u64) -> Option<f64> {
        if window == 0 || self.ctx_tokens == 0 {
            return None;
        }
        Some((self.ctx_tokens as f64 / window as f64 * 100.0).min(100.0))
    }

    pub fn recent_files(&self, n: usize) -> Vec<&FileTouch> {
        let mut v: Vec<&FileTouch> = self.files.values().collect();
        v.sort_by(|a, b| b.last.cmp(&a.last));
        v.truncate(n);
        v
    }
}

pub fn one_line(s: &str, max: usize) -> String {
    let mut out = String::with_capacity(s.len().min(max + 4));
    let mut last_space = false;
    for ch in s.chars() {
        let c = if ch.is_whitespace() { ' ' } else { ch };
        if c == ' ' {
            if last_space || out.is_empty() {
                continue;
            }
            last_space = true;
        } else {
            last_space = false;
        }
        if c.is_control() {
            continue;
        }
        out.push(c);
        if out.chars().count() >= max {
            out.push('…');
            break;
        }
    }
    out.trim_end().to_string()
}

/// Strips markdown emphasis, code ticks and headings for one-line display.
pub fn plain(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for line in s.lines() {
        let l = line.trim_start_matches(['#', '>', ' ']).trim_start_matches("- ").trim_start_matches("* ");
        if l.starts_with("```") {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(l);
    }
    one_line(&out.replace("**", "").replace("__", "").replace('`', ""), 300)
}

pub fn short_id(id: &str) -> &str {
    let end = id.char_indices().nth(8).map(|(i, _)| i).unwrap_or(id.len());
    &id[..end]
}

pub fn parse_ts(s: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn ago(now: i64, ts: i64) -> String {
    if ts <= 0 {
        return "-".into();
    }
    let s = ((now - ts) / 1000).max(0);
    if s < 60 {
        format!("{s}s")
    } else if s < 3600 {
        format!("{}m", s / 60)
    } else if s < 86400 {
        format!("{}h", s / 3600)
    } else {
        format!("{}d", s / 86400)
    }
}

pub fn fmt_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1e6)
    } else if n >= 1000 {
        format!("{:.1}k", n as f64 / 1e3)
    } else {
        n.to_string()
    }
}

/// Shortens a path relative to a project root, falling back to ~ for home.
pub fn rel_path(path: &str, root: &str) -> String {
    if !root.is_empty() {
        if let Some(rest) = path.strip_prefix(root) {
            let rest = rest.trim_start_matches('/');
            if !rest.is_empty() {
                return rest.to_string();
            }
        }
    }
    // Agent scratch folders (/tmp/claude-1000/<project>/<session>/scratchpad/…)
    // are noise in every list that shows them; keep only what is inside.
    if path.starts_with("/tmp/") || path.starts_with(std::env::temp_dir().to_string_lossy().as_ref()) {
        if let Some(i) = path.find("/scratchpad/") {
            return format!("scratchpad/{}", &path[i + "/scratchpad/".len()..]);
        }
    }
    if let Some(home) = dirs::home_dir() {
        let h = home.to_string_lossy();
        if let Some(rest) = path.strip_prefix(h.as_ref()) {
            return format!("~{rest}");
        }
    }
    path.to_string()
}

pub fn domain_of(url: &str) -> String {
    let s = url.split("://").nth(1).unwrap_or(url);
    let host = s.split(['/', '?', '#']).next().unwrap_or(s);
    host.trim_start_matches("www.").to_string()
}
