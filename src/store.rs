//! Session index, live-process discovery and incremental run parsing, all on
//! a worker thread. The UI only reads `Shared` snapshots.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

use crate::config::{claude_dir, codex_dir, state_dir};
use crate::model::*;
use crate::sources::{self, claude::ClaudeCursor};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionInfo {
    pub key: RunKey,
    pub path: PathBuf,
    pub cwd: String,
    pub root: String,
    pub title: String,
    pub first_prompt: String,
    pub mtime: i64,
    pub size: u64,
}

#[derive(Clone, Debug, Default)]
pub struct Project {
    pub root: String,
    pub name: String,
    pub last: i64,
    pub sessions: Vec<RunKey>,
    pub claude: usize,
    pub codex: usize,
}

#[derive(Clone, Debug)]
pub struct LiveClaude {
    pub pid: u32,
    pub waiting_for: String,
    pub session_id: String,
    pub cwd: String,
    pub status: String,
    pub name: String,
    pub background: bool,
}

#[derive(Default)]
pub struct Snapshot {
    pub projects: Vec<Project>,
    pub sessions: HashMap<RunKey, SessionInfo>,
    pub runs: HashMap<RunKey, Arc<AgentRun>>,
    pub live: Vec<LiveClaude>,
    pub rate_limits: Option<RateLimits>,
    pub indexed: bool,
    pub version: u64,
    pub parse_queue: usize,
}

#[derive(Default)]
pub struct Wants {
    pub project: Option<String>,
    pub pinned: HashSet<RunKey>,
    pub recent: usize,
}

pub type Shared = Arc<Mutex<Snapshot>>;
pub type SharedWants = Arc<Mutex<Wants>>;

pub fn spawn(recent: usize) -> (Shared, SharedWants) {
    let shared: Shared = Arc::new(Mutex::new(Snapshot::default()));
    let wants: SharedWants = Arc::new(Mutex::new(Wants { recent, ..Default::default() }));
    let s = shared.clone();
    let w = wants.clone();
    std::thread::Builder::new()
        .name("polypore-store".into())
        .spawn(move || Worker::new(s, w).run())
        .expect("spawn store worker");
    (shared, wants)
}

struct Parsed {
    run: AgentRun,
    cursor: ClaudeCursor,
}

struct Worker {
    shared: Shared,
    wants: SharedWants,
    index: HashMap<PathBuf, SessionInfo>,
    roots: HashMap<String, String>,
    parsed: HashMap<RunKey, Parsed>,
    codex_titles: HashMap<String, String>,
    last_index: Option<Instant>,
}

impl Worker {
    fn new(shared: Shared, wants: SharedWants) -> Worker {
        let mut w = Worker {
            shared,
            wants,
            index: HashMap::new(),
            roots: HashMap::new(),
            parsed: HashMap::new(),
            codex_titles: HashMap::new(),
            last_index: None,
        };
        w.load_cache();
        w
    }

    fn run(mut self) {
        let mut first = true;
        loop {
            let started = Instant::now();
            let due = self.last_index.map(|t| t.elapsed() > Duration::from_secs(6)).unwrap_or(true);
            if due {
                self.reindex();
                self.last_index = Some(Instant::now());
                if first {
                    self.save_cache();
                    first = false;
                }
            }
            let live = live_claude();
            self.parse_wanted(&live);
            let elapsed = started.elapsed();
            if elapsed < Duration::from_millis(800) {
                std::thread::sleep(Duration::from_millis(800) - elapsed);
            }
        }
    }

    fn cache_path() -> PathBuf {
        state_dir().join("index-v2.json")
    }

    fn load_cache(&mut self) {
        if let Ok(text) = std::fs::read_to_string(Self::cache_path()) {
            if let Ok(v) = serde_json::from_str::<Vec<SessionInfo>>(&text) {
                for s in v {
                    self.roots.insert(s.cwd.clone(), s.root.clone());
                    self.index.insert(s.path.clone(), s);
                }
                self.publish_index();
            }
        }
    }

    fn save_cache(&self) {
        let v: Vec<&SessionInfo> = self.index.values().collect();
        if let Ok(text) = serde_json::to_string(&v) {
            let tmp = Self::cache_path().with_extension("tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(tmp, Self::cache_path());
            }
        }
    }

    fn root_for(&mut self, cwd: &str) -> String {
        if cwd.is_empty() {
            return String::new();
        }
        if let Some(r) = self.roots.get(cwd) {
            return r.clone();
        }
        let r = git_root(Path::new(cwd)).unwrap_or_else(|| cwd.to_string());
        self.roots.insert(cwd.to_string(), r.clone());
        r
    }

    fn reindex(&mut self) {
        let mut seen: HashSet<PathBuf> = HashSet::new();
        let mut changed = false;
        // Claude: ~/.claude/projects/<enc>/<session>.jsonl
        if let Ok(dirs) = std::fs::read_dir(claude_dir().join("projects")) {
            for d in dirs.flatten() {
                let Ok(files) = std::fs::read_dir(d.path()) else { continue };
                for f in files.flatten() {
                    let p = f.path();
                    if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                        continue;
                    }
                    seen.insert(p.clone());
                    changed |= self.index_file(&p, AgentKind::Claude);
                }
            }
        }
        // Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
        self.load_codex_titles();
        let mut stack = vec![codex_dir().join("sessions")];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    seen.insert(p.clone());
                    changed |= self.index_file(&p, AgentKind::Codex);
                }
            }
        }
        let before = self.index.len();
        self.index.retain(|p, _| seen.contains(p));
        changed |= before != self.index.len();
        // Titles from parsed runs beat the index's cached first prompt.
        for s in self.index.values_mut() {
            if let Some(p) = self.parsed.get(&s.key) {
                if !p.run.title.is_empty() {
                    s.title = p.run.title.clone();
                }
            }
            if s.key.kind == AgentKind::Codex && s.title.is_empty() {
                if let Some(t) = self.codex_titles.get(&s.key.id) {
                    s.title = t.clone();
                }
            }
        }
        if changed || !self.shared.lock().unwrap().indexed {
            self.publish_index();
            if changed {
                self.save_cache();
            }
        }
    }

    fn load_codex_titles(&mut self) {
        let path = codex_dir().join("session_index.jsonl");
        let Ok(text) = std::fs::read_to_string(path) else { return };
        #[derive(Deserialize)]
        struct E {
            id: String,
            #[serde(default)]
            thread_name: String,
        }
        for l in text.lines() {
            if let Ok(e) = serde_json::from_str::<E>(l) {
                if !e.thread_name.is_empty() {
                    self.codex_titles.insert(e.id, e.thread_name);
                }
            }
        }
    }

    /// Returns true when the file is new or changed.
    fn index_file(&mut self, p: &Path, kind: AgentKind) -> bool {
        let Ok(md) = std::fs::metadata(p) else { return false };
        let mtime = md
            .modified()
            .ok()
            .and_then(|m| m.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let size = md.len();
        if let Some(existing) = self.index.get_mut(p) {
            if existing.size == size && existing.mtime == mtime {
                return false;
            }
            existing.size = size;
            existing.mtime = mtime;
            if existing.title.is_empty() && kind == AgentKind::Claude && size < 64 * 1024 * 1024 {
                let meta = sources::claude::scan_meta(p);
                existing.title = meta.title;
            }
            return true;
        }
        let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let (id, cwd, title, first_prompt) = match kind {
            AgentKind::Claude => {
                let meta = sources::claude::scan_meta(p);
                (stem, meta.cwd, meta.title, meta.first_prompt)
            }
            AgentKind::Codex => {
                let (cwd, mid, _, first) = sources::codex::scan_meta(p);
                let id = if stem.len() >= 36 { stem[stem.len() - 36..].to_string() } else { mid };
                let title = self.codex_titles.get(&id).cloned().unwrap_or_default();
                (id, cwd, title, first)
            }
        };
        if cwd.is_empty() {
            return false;
        }
        let root = self.root_for(&cwd);
        self.index.insert(
            p.to_path_buf(),
            SessionInfo { key: RunKey { kind, id }, path: p.to_path_buf(), cwd, root, title, first_prompt, mtime, size },
        );
        true
    }

    fn publish_index(&mut self) {
        let mut projects: HashMap<String, Project> = HashMap::new();
        let mut sessions = HashMap::new();
        for s in self.index.values() {
            let p = projects.entry(s.root.clone()).or_insert_with(|| Project {
                root: s.root.clone(),
                name: Path::new(&s.root).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| s.root.clone()),
                ..Default::default()
            });
            p.last = p.last.max(s.mtime);
            p.sessions.push(s.key.clone());
            match s.key.kind {
                AgentKind::Claude => p.claude += 1,
                AgentKind::Codex => p.codex += 1,
            }
            sessions.insert(s.key.clone(), s.clone());
        }
        let mut projects: Vec<Project> = projects.into_values().filter(|p| !p.root.is_empty()).collect();
        for p in projects.iter_mut() {
            p.sessions.sort_by_key(|k| -sessions.get(k).map(|s| s.mtime).unwrap_or(0));
        }
        projects.sort_by_key(|p| -p.last);
        let mut snap = self.shared.lock().unwrap();
        snap.projects = projects;
        snap.sessions = sessions;
        snap.indexed = true;
        snap.version += 1;
    }

    fn parse_wanted(&mut self, live: &[LiveClaude]) {
        let now = now_ms();
        let (project, pinned, recent) = {
            let w = self.wants.lock().unwrap();
            (w.project.clone(), w.pinned.clone(), w.recent)
        };
        let mut want: Vec<RunKey> = Vec::new();
        let live_ids: HashMap<&str, &LiveClaude> = live.iter().map(|l| (l.session_id.as_str(), l)).collect();
        // Live claude sessions everywhere (for the attention strip).
        for l in live {
            want.push(RunKey { kind: AgentKind::Claude, id: l.session_id.clone() });
        }
        // Recently written codex rollouts everywhere.
        for s in self.index.values() {
            if s.key.kind == AgentKind::Codex && now - s.mtime < 5 * 60_000 {
                want.push(s.key.clone());
            }
        }
        want.extend(pinned.iter().cloned());
        if let Some(root) = &project {
            let snap = self.shared.lock().unwrap();
            if let Some(p) = snap.projects.iter().find(|p| &p.root == root) {
                want.extend(p.sessions.iter().take(recent).cloned());
            }
        }
        let mut seen = HashSet::new();
        want.retain(|k| seen.insert(k.clone()));

        let paths: HashMap<RunKey, PathBuf> =
            self.index.values().map(|s| (s.key.clone(), s.path.clone())).collect();
        let total = want.len();
        let mut done = 0;
        let mut latest_rates: Option<RateLimits> = None;
        for key in want {
            let Some(path) = paths.get(&key).cloned() else {
                // Live session whose transcript isn't indexed yet.
                continue;
            };
            let entry = self.parsed.entry(key.clone()).or_insert_with(|| Parsed {
                run: AgentRun::new(key.clone(), path.clone()),
                cursor: ClaudeCursor::default(),
            });
            let before = (entry.run.offset, entry.run.live_pid, entry.run.live_status.clone(), entry.run.waiting_for.clone());
            let Parsed { run, cursor } = entry;
            let mut off = run.offset;
            let res = sources::tail_lines(&path, &mut off, |line| match key.kind {
                AgentKind::Claude => sources::claude::apply_line(run, cursor, line),
                AgentKind::Codex => sources::codex::apply_line(run, line),
            });
            run.offset = off;
            if let Ok(len) = res {
                run.file_len = len;
            }
            run.parse_complete = true;
            if key.kind == AgentKind::Claude {
                sources::claude::refresh_now(run);
                if let Some(l) = live_ids.get(key.id.as_str()) {
                    run.live_pid = Some(l.pid);
                    run.live_status = Some(l.status.clone());
                    run.waiting_for = Some(l.waiting_for.clone()).filter(|w| !w.is_empty());
                    run.background_job = l.background;
                    if run.title.is_empty() && !l.name.is_empty() {
                        run.title = l.name.clone();
                    }
                } else {
                    run.live_pid = None;
                    run.live_status = None;
                    run.background_job = false;
                }
            }
            if key.kind == AgentKind::Codex && run.title.is_empty() {
                if let Some(t) = self.codex_titles.get(&key.id) {
                    run.title = t.clone();
                }
            }
            if let Some(r) = &run.rate_limits {
                if latest_rates.as_ref().map(|x| x.ts < r.ts).unwrap_or(true) {
                    latest_rates = Some(r.clone());
                }
            }
            let after = (run.offset, run.live_pid, run.live_status.clone(), run.waiting_for.clone());
            done += 1;
            let snapshot_run = if before != after || !self.shared.lock().unwrap().runs.contains_key(&key) {
                Some(Arc::new(run.clone()))
            } else {
                None
            };
            let mut snap = self.shared.lock().unwrap();
            if let Some(r) = snapshot_run {
                snap.runs.insert(key.clone(), r);
                snap.version += 1;
            }
            snap.parse_queue = total - done;
        }
        let mut snap = self.shared.lock().unwrap();
        snap.live = live.to_vec();
        if latest_rates.is_some() {
            snap.rate_limits = latest_rates;
        }
        // Clear live flags for runs that stopped being live.
        let live_set: HashSet<&str> = live.iter().map(|l| l.session_id.as_str()).collect();
        let mut stale = Vec::new();
        for (k, r) in snap.runs.iter() {
            if k.kind == AgentKind::Claude && r.live_pid.is_some() && !live_set.contains(k.id.as_str()) {
                stale.push(k.clone());
            }
        }
        for k in stale {
            if let Some(p) = self.parsed.get_mut(&k) {
                p.run.live_pid = None;
                p.run.live_status = None;
                p.run.background_job = false;
                snap.runs.insert(k, Arc::new(p.run.clone()));
                snap.version += 1;
            }
        }
    }
}

/// One synchronous pass for the CLI: the index (cache, then a rescan), then
/// live sessions, `extra` and the project's recent ones parsed.
pub fn snapshot_once(extra: &[RunKey], project: Option<String>, recent: usize) -> Snapshot {
    let shared: Shared = Arc::new(Mutex::new(Snapshot::default()));
    let wants: SharedWants = Arc::new(Mutex::new(Wants { project, pinned: extra.iter().cloned().collect(), recent }));
    let mut w = Worker::new(shared.clone(), wants);
    w.reindex();
    let live = live_claude();
    w.parse_wanted(&live);
    drop(w);
    std::mem::take(&mut *shared.lock().unwrap())
}

/// The checkout a path is in: the nearest folder holding `.git`, a linked
/// worktree's own folder included. For diffs and file lists; projects use
/// `git_root`, which files worktrees under their main checkout.
pub fn work_root(start: &Path) -> Option<String> {
    let home = dirs::home_dir();
    let mut cur = Some(start);
    while let Some(dir) = cur {
        if home.as_deref() == Some(dir) {
            return None;
        }
        if dir.join(".git").exists() {
            return Some(dir.to_string_lossy().to_string());
        }
        cur = dir.parent();
    }
    None
}

pub fn git_root(start: &Path) -> Option<String> {
    let mut cur = Some(start);
    let home = dirs::home_dir();
    while let Some(dir) = cur {
        if home.as_deref() == Some(dir) {
            return None;
        }
        let dot = dir.join(".git");
        if dot.exists() {
            // A linked worktree (polypore's per-session ones included)
            // belongs to the project of its main checkout.
            if dot.is_file() {
                if let Some(main) = crate::worktree::main_repo_of(dir) {
                    return Some(main);
                }
            }
            return Some(dir.to_string_lossy().to_string());
        }
        cur = dir.parent();
    }
    None
}

/// Live claude processes, from `~/.claude/sessions/<pid>.json` plus background
/// jobs supervised by the claude daemon.
pub fn live_claude() -> Vec<LiveClaude> {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct S {
        pid: u32,
        #[serde(rename = "sessionId")]
        session_id: String,
        cwd: String,
        status: String,
        name: String,
        kind: String,
        #[serde(rename = "waitingFor")]
        waiting_for: String,
        #[serde(rename = "procStart")]
        proc_start: String,
    }
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(claude_dir().join("sessions")) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            let Ok(s) = serde_json::from_str::<S>(&text) else { continue };
            if s.pid == 0 || s.session_id.is_empty() || !same_process(s.pid, &s.proc_start) {
                continue;
            }
            out.push(LiveClaude {
                pid: s.pid,
                waiting_for: s.waiting_for,
                session_id: s.session_id,
                cwd: s.cwd,
                status: s.status,
                name: s.name,
                background: s.kind != "interactive" && !s.kind.is_empty(),
            });
        }
    }
    // Background jobs (`claude --bg`): ~/.claude/jobs/<id>/state.json
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct J {
        #[serde(rename = "sessionId")]
        session_id: String,
        state: String,
        name: String,
        cwd: String,
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Roster {
        workers: HashMap<String, W>,
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct W {
        pid: u32,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "procStart")]
        proc_start: String,
    }
    let roster: Roster = std::fs::read_to_string(claude_dir().join("daemon/roster.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    if let Ok(rd) = std::fs::read_dir(claude_dir().join("jobs")) {
        for e in rd.flatten() {
            let Ok(text) = std::fs::read_to_string(e.path().join("state.json")) else { continue };
            let Ok(j) = serde_json::from_str::<J>(&text) else { continue };
            if j.session_id.is_empty() || out.iter().any(|l| l.session_id == j.session_id) {
                continue;
            }
            let worker = roster.workers.values().find(|w| w.session_id == j.session_id && same_process(w.pid, &w.proc_start));
            let Some(w) = worker else { continue };
            out.push(LiveClaude {
                pid: w.pid,
                waiting_for: String::new(),
                session_id: j.session_id,
                cwd: j.cwd,
                status: j.state,
                name: j.name,
                background: true,
            });
        }
    }
    out
}

/// Whether `pid` is still the process claude recorded. Claude writes the
/// process start time (`procStart`, field 22 of /proc/<pid>/stat) next to
/// the pid; after a reboot, or a long uptime, pids are handed out again and
/// a leftover session file would otherwise mark its session as running
/// somewhere, which keeps polypore from resuming it.
pub fn same_process(pid: u32, proc_start: &str) -> bool {
    if !pid_alive(pid) {
        return false;
    }
    match (proc_start.is_empty(), proc_start_of(pid)) {
        (false, Some(now)) => now == proc_start,
        _ => true,
    }
}

fn proc_start_of(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        proc_start_field(&stat)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

/// Field 22 (starttime) of a /proc/<pid>/stat line. The command name in
/// field 2 is in parens and may hold spaces, so count from its end.
pub fn proc_start_field(stat: &str) -> Option<String> {
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(19).map(String::from)
}

pub fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as libc::pid_t, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}
