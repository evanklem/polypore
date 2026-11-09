//! `polypore ls`, `send` and `watch`: the dashboard's knowledge as plain
//! unix tools, for status bars, scripts and notify-send. Plus the state
//! tracker and `[hooks]`, which the dashboard shares.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::Serialize;

use crate::config::Config;
use crate::model::*;
use crate::server::{Conn, PaneInfo};
use crate::store::{self, Snapshot};

// ---------------------------------------------------------------- tracker

#[derive(Clone, Debug)]
pub struct Change {
    pub key: RunKey,
    pub from: RunState,
    pub to: RunState,
}

/// Remembers each session's last state and reports what moved.
#[derive(Default)]
pub struct Tracker {
    prev: HashMap<RunKey, RunState>,
}

impl Tracker {
    /// Sessions that are live, or `hosted` in polypore terminals, compared
    /// against the last call. The first sighting of a session is not a change.
    pub fn step(&mut self, snap: &Snapshot, hosted: &HashSet<RunKey>, now: i64) -> Vec<Change> {
        let mut out = Vec::new();
        for (k, r) in snap.runs.iter() {
            let host = hosted.contains(k);
            if !r.is_live() && !host {
                continue;
            }
            let s = r.state_hosted(now, host);
            if let Some(prev) = self.prev.insert(k.clone(), s) {
                if prev != s {
                    out.push(Change { key: k.clone(), from: prev, to: s });
                }
            }
        }
        out
    }
}

/// Runs the `[hooks]` command for a change, if one is set.
pub fn fire_hooks(cfg: &Config, c: &Change, run: &AgentRun, project: &str, title: &str) {
    let cmd = match (c.from, c.to) {
        (_, RunState::NeedsInput) => &cfg.hooks.on_needs_you,
        (RunState::Working, RunState::Ready) => &cfg.hooks.on_done,
        (_, RunState::Working) => &cfg.hooks.on_working,
        _ => return,
    };
    if cmd.trim().is_empty() {
        return;
    }
    let text = match c.to {
        RunState::NeedsInput => run.activity(RunState::NeedsInput),
        _ => plain(&run.last_reply),
    };
    let mut command = std::process::Command::new("sh");
    command
        .arg("-c")
        .arg(cmd)
        .env("POLYPORE_STATE", c.to.label())
        .env("POLYPORE_AGENT", run.key.kind.label())
        .env("POLYPORE_SESSION", &run.key.id)
        .env("POLYPORE_PROJECT", project)
        .env("POLYPORE_TITLE", title)
        .env("POLYPORE_TEXT", one_line(&text, 400))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if let Ok(mut child) = command.spawn() {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

// ---------------------------------------------------------------- hosted panes

/// The terminal server's panes with the agent session running in each.
pub fn hosted(conn: &Conn) -> Vec<(PaneInfo, Option<RunKey>)> {
    let table = crate::procs::table();
    conn.list()
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let run = if p.exited.is_some() {
                None
            } else {
                p.pid.and_then(|pid| crate::procs::detect(pid, &table, &p.cwd, p.created)).and_then(|d| d.run).or_else(|| p.meta.run.clone())
            };
            (p, run)
        })
        .collect()
}

// ---------------------------------------------------------------- ls

#[derive(Serialize)]
struct Row {
    id: String,
    agent: &'static str,
    state: &'static str,
    project: String,
    cwd: String,
    title: String,
    activity: String,
    updated: i64,
    branch: String,
    model: String,
    /// The polypore terminal running it, if any.
    pane: Option<u64>,
    pid: Option<u32>,
}

struct Args {
    flags: HashSet<String>,
    opts: HashMap<String, String>,
    pos: Vec<String>,
}

fn parse_args(args: &[String], with_value: &[&str]) -> Args {
    let mut a = Args { flags: HashSet::new(), opts: HashMap::new(), pos: Vec::new() };
    let mut i = 0;
    while i < args.len() {
        let x = &args[i];
        if let Some(name) = x.strip_prefix("--").or_else(|| x.strip_prefix('-').filter(|n| n.len() == 1)) {
            let (name, inline) = match name.split_once('=') {
                Some((n, v)) => (n.to_string(), Some(v.to_string())),
                None => (name.to_string(), None),
            };
            if with_value.contains(&name.as_str()) {
                let v = inline.or_else(|| {
                    i += 1;
                    args.get(i).cloned()
                });
                a.opts.insert(name, v.unwrap_or_default());
            } else {
                a.flags.insert(name);
            }
        } else {
            a.pos.push(x.clone());
        }
        i += 1;
    }
    a
}

fn project_matches(filter: &str, root: &str) -> bool {
    if filter.is_empty() {
        return true;
    }
    let f = crate::config::expand(filter).to_string_lossy().to_string();
    let name = Path::new(root).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    root == f || name == filter || root.ends_with(&format!("/{filter}"))
}

fn rows(all: bool, project: &str, limit: usize) -> Vec<Row> {
    let conn = Conn::connect(false).ok();
    let hosted = conn.as_ref().map(|c| hosted(c)).unwrap_or_default();
    let extra: Vec<RunKey> = hosted.iter().filter_map(|(_, r)| r.clone()).collect();
    let snap = store::snapshot_once(&extra, None, 0);
    let names = crate::meta::SessionMeta::load();
    let now = now_ms();
    let pane_of: HashMap<&RunKey, &PaneInfo> = hosted.iter().filter_map(|(p, r)| r.as_ref().map(|r| (r, p))).collect();
    let mut out: Vec<Row> = Vec::new();
    let mut seen: HashSet<RunKey> = HashSet::new();
    let root_of = |k: &RunKey, cwd: &str| snap.sessions.get(k).map(|s| s.root.clone()).unwrap_or_else(|| store::git_root(Path::new(cwd)).unwrap_or(cwd.to_string()));
    for r in snap.runs.values() {
        let pane = pane_of.get(&r.key).copied();
        let state = r.state_hosted(now, pane.is_some());
        if state == RunState::Closed && !all {
            continue;
        }
        let root = root_of(&r.key, &r.cwd);
        if !project_matches(project, &root) {
            continue;
        }
        seen.insert(r.key.clone());
        out.push(Row {
            id: r.key.id.clone(),
            agent: r.key.kind.label(),
            state: state.label(),
            project: root,
            cwd: r.cwd.clone(),
            title: names.name(&r.key).map(String::from).unwrap_or_else(|| r.display_title()),
            activity: r.activity(state),
            updated: r.updated,
            branch: r.branch.clone(),
            model: r.model.clone(),
            pane: pane.map(|p| p.id),
            pid: r.live_pid.or(pane.and_then(|p| p.pid)),
        });
    }
    // Plain terminals in the server.
    for (p, run) in &hosted {
        if run.is_some() || p.exited.is_some() {
            continue;
        }
        let root = if p.meta.project.is_empty() { p.cwd.clone() } else { p.meta.project.clone() };
        if !project_matches(project, &root) {
            continue;
        }
        out.push(Row {
            id: format!("pane-{}", p.id),
            agent: "terminal",
            state: "open",
            project: root,
            cwd: p.cwd.clone(),
            title: if p.meta.name.is_empty() { "terminal".into() } else { p.meta.name.clone() },
            activity: String::new(),
            updated: p.last_output,
            branch: String::new(),
            model: String::new(),
            pane: Some(p.id),
            pid: p.pid,
        });
    }
    if all {
        for s in snap.sessions.values() {
            if seen.contains(&s.key) || !project_matches(project, &s.root) {
                continue;
            }
            out.push(Row {
                id: s.key.id.clone(),
                agent: s.key.kind.label(),
                state: RunState::Closed.label(),
                project: s.root.clone(),
                cwd: s.cwd.clone(),
                title: names.name(&s.key).map(String::from).unwrap_or_else(|| if s.title.is_empty() { one_line(&s.first_prompt, 60) } else { s.title.clone() }),
                activity: String::new(),
                updated: s.mtime,
                branch: String::new(),
                model: String::new(),
                pane: None,
                pid: None,
            });
        }
    }
    let rank = |s: &str| match s {
        "needs you" => 0,
        "working" => 1,
        "ready" => 2,
        "open" => 3,
        _ => 4,
    };
    out.sort_by(|a, b| rank(a.state).cmp(&rank(b.state)).then(b.updated.cmp(&a.updated)));
    if limit > 0 {
        out.truncate(limit);
    }
    out
}

pub fn ls(args: &[String]) -> i32 {
    let a = parse_args(args, &["project", "p", "n", "limit"]);
    if a.flags.contains("help") || a.flags.contains("h") {
        println!("usage: polypore ls [--all] [--json] [--project NAME|PATH] [-n N]\n\nlists open sessions (needs you, working, ready) and polypore terminals.\n--all adds closed sessions. the id column takes a prefix in `polypore send`.");
        return 0;
    }
    let all = a.flags.contains("all") || a.flags.contains("a");
    let project = a.opts.get("project").or(a.opts.get("p")).cloned().unwrap_or_default();
    let limit = a.opts.get("n").or(a.opts.get("limit")).and_then(|n| n.parse().ok()).unwrap_or(if all { 50 } else { 0 });
    let rows = rows(all, &project, limit);
    if a.flags.contains("json") {
        println!("{}", serde_json::to_string_pretty(&rows).unwrap_or_else(|_| "[]".into()));
        return 0;
    }
    if rows.is_empty() {
        println!("nothing open{}", if all { "" } else { " (--all lists closed sessions too)" });
        return 0;
    }
    let now = now_ms();
    let pw = rows.iter().map(|r| Path::new(&r.project).file_name().map(|n| n.len()).unwrap_or(0)).max().unwrap_or(7).clamp(7, 24);
    println!("{:<9}  {:<8}  {:<9}  {:<pw$}  {:>4}  {}", "STATE", "AGENT", "ID", "PROJECT", "AGE", "TITLE");
    for r in rows {
        let proj = Path::new(&r.project).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let id: String = r.id.chars().take(8).collect();
        let mut title = r.title.clone();
        if let Some(p) = r.pane {
            title = format!("{title}  [pane {p}]");
        }
        if r.state == "needs you" && !r.activity.is_empty() {
            title = format!("{title}: {}", one_line(&r.activity, 80));
        }
        println!("{:<9}  {:<8}  {:<9}  {:<pw$}  {:>4}  {}", r.state, r.agent, id, crate::ui::trunc(&proj, pw), ago(now, r.updated), title);
    }
    0
}

// ---------------------------------------------------------------- send

pub fn send(args: &[String]) -> i32 {
    let a = parse_args(args, &["timeout"]);
    if a.pos.len() < 2 || a.flags.contains("help") {
        eprintln!("usage: polypore send [--now] [--timeout SECS] <id|pane-N> <text...>\n\ntypes a prompt into a session and presses enter.\n  a session in a polypore terminal: typed into it; if it is mid-turn, send waits\n    for the turn to end first (--now types it right away).\n  a closed session: resumed in a new polypore terminal with the prompt.\n  `-` as the text reads it from stdin.");
        return 2;
    }
    let target = a.pos[0].clone();
    let mut text = a.pos[1..].join(" ");
    if text == "-" {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut s);
        text = s;
    }
    if text.trim().is_empty() {
        eprintln!("polypore send: empty prompt");
        return 2;
    }
    let conn = match Conn::connect(true) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("polypore send: {e}");
            return 1;
        }
    };
    let hosted = hosted(&conn);
    // pane-N, or a bare number, is a polypore terminal.
    let pane_id = target.strip_prefix("pane-").unwrap_or(&target).parse::<u64>().ok();
    if let Some(id) = pane_id.filter(|id| hosted.iter().any(|(p, _)| p.id == *id)) {
        return match conn.prompt(id, &text) {
            Ok(_) => {
                println!("sent to pane {id}");
                0
            }
            Err(e) => {
                eprintln!("polypore send: {e}");
                1
            }
        };
    }
    let snap = store::snapshot_once(&hosted.iter().filter_map(|(_, r)| r.clone()).collect::<Vec<_>>(), None, 0);
    let matches: Vec<RunKey> = snap.sessions.keys().filter(|k| k.id.starts_with(&target)).cloned().collect();
    let key = match matches.len() {
        0 => {
            eprintln!("polypore send: no session id starts with {target} (polypore ls --all lists them)");
            return 1;
        }
        1 => matches[0].clone(),
        n => {
            eprintln!("polypore send: {target} matches {n} sessions; give more of the id");
            return 1;
        }
    };
    if let Some((p, _)) = hosted.iter().find(|(p, r)| r.as_ref() == Some(&key) && p.exited.is_none()) {
        let id = p.id;
        if !a.flags.contains("now") {
            let timeout = a.opts.get("timeout").and_then(|t| t.parse::<u64>().ok()).unwrap_or(3600);
            let start = std::time::Instant::now();
            let mut said = false;
            loop {
                let snap = store::snapshot_once(std::slice::from_ref(&key), None, 0);
                let state = snap.runs.get(&key).map(|r| r.state_hosted(now_ms(), true)).unwrap_or(RunState::Ready);
                if state != RunState::Working {
                    break;
                }
                if !said {
                    eprintln!("waiting for the current turn to end (--now skips this)…");
                    said = true;
                }
                if start.elapsed().as_secs() > timeout {
                    eprintln!("polypore send: still working after {timeout}s; not sent");
                    return 1;
                }
                std::thread::sleep(std::time::Duration::from_millis(1500));
            }
        }
        return match conn.prompt(id, &text) {
            Ok(_) => {
                println!("sent to {} {} (pane {id})", key.kind.label(), short_id(&key.id));
                0
            }
            Err(e) => {
                eprintln!("polypore send: {e}");
                1
            }
        };
    }
    if snap.runs.get(&key).map(|r| r.is_live()).unwrap_or(false) {
        eprintln!("polypore send: that session is running in a terminal polypore does not own; type it there");
        return 1;
    }
    // Closed: resume it in a polypore terminal with the prompt.
    let Some(info) = snap.sessions.get(&key).cloned() else { return 1 };
    let cfg = Config::load().0;
    let kind = if key.kind == AgentKind::Codex { crate::pane::PaneKind::Codex } else { crate::pane::PaneKind::Claude };
    let base = cfg.agent(key.kind.label()).command;
    let typed = match key.kind {
        AgentKind::Claude => format!("{base} --resume {} {}\r", key.id, shell_words::quote(&text)),
        AgentKind::Codex => format!("{base} resume {} {}\r", key.id, shell_words::quote(&text)),
    };
    let (env_remove, env_set) = crate::secrets::scrub(&info.root);
    let cwd = if Path::new(&info.cwd).is_dir() { info.cwd.clone() } else { info.root.clone() };
    let req = crate::server::SpawnReq {
        spec: crate::pane::SpawnSpec { kind, cwd, argv: Vec::new(), env_set, env_remove, scrubbed: true },
        rows: 40,
        cols: 120,
        typed: Some(typed),
        meta: crate::server::Meta {
            project: info.root.clone(),
            name: names_or_title(&key, &info),
            run: Some(key.clone()),
            workspace: None,
        },
    };
    match conn.spawn(&req) {
        Ok(p) => {
            println!("resumed {} {} in pane {} with your prompt; polypore shows it under {}", key.kind.label(), short_id(&key.id), p.id, crate::config::display_path(Path::new(&info.root)));
            0
        }
        Err(e) => {
            eprintln!("polypore send: {e}");
            1
        }
    }
}

fn names_or_title(key: &RunKey, info: &store::SessionInfo) -> String {
    let names = crate::meta::SessionMeta::load();
    names.name(key).map(String::from).unwrap_or_else(|| one_line(if info.title.is_empty() { &info.first_prompt } else { &info.title }, 30))
}

// ---------------------------------------------------------------- watch

#[derive(Serialize)]
struct WatchLine<'a> {
    ts: i64,
    id: &'a str,
    agent: &'a str,
    from: &'a str,
    state: &'a str,
    project: &'a str,
    title: &'a str,
    text: String,
}

pub fn watch(args: &[String]) -> i32 {
    let a = parse_args(args, &[]);
    if a.flags.contains("help") || a.flags.contains("h") {
        println!("usage: polypore watch [--json] [--hooks]\n\nprints a line each time a session changes state (needs you, working, ready, closed).\n--hooks also runs the [hooks] commands from config.toml.");
        return 0;
    }
    let json = a.flags.contains("json");
    let hooks = a.flags.contains("hooks");
    let cfg = Config::load().0;
    let (shared, wants) = store::spawn(0);
    let mut tracker = Tracker::default();
    let names = crate::meta::SessionMeta::load();
    let mut conn = Conn::connect(false).ok();
    let mut last_conn_try = std::time::Instant::now();
    loop {
        if conn.as_ref().map(|c| !c.is_alive()).unwrap_or(true) && last_conn_try.elapsed().as_secs() > 10 {
            conn = Conn::connect(false).ok();
            last_conn_try = std::time::Instant::now();
        }
        let hosted_runs: HashSet<RunKey> = conn.as_ref().map(|c| hosted(c)).unwrap_or_default().into_iter().filter_map(|(p, r)| r.filter(|_| p.exited.is_none())).collect();
        wants.lock().unwrap().pinned = hosted_runs.clone();
        let changes = {
            let snap = shared.lock().unwrap();
            let changes = tracker.step(&snap, &hosted_runs, now_ms());
            changes
                .into_iter()
                .filter_map(|c| {
                    let r = snap.runs.get(&c.key)?.clone();
                    let root = snap.sessions.get(&c.key).map(|s| s.root.clone()).unwrap_or(r.cwd.clone());
                    Some((c, r, root))
                })
                .collect::<Vec<_>>()
        };
        for (c, r, root) in changes {
            let title = names.name(&r.key).map(String::from).unwrap_or_else(|| r.display_title());
            let text = if c.to == RunState::NeedsInput { r.activity(c.to) } else if c.to == RunState::Ready { plain(&r.last_reply) } else { r.activity(c.to) };
            if json {
                let l = WatchLine { ts: now_ms(), id: &r.key.id, agent: r.key.kind.label(), from: c.from.label(), state: c.to.label(), project: &root, title: &title, text: one_line(&text, 400) };
                println!("{}", serde_json::to_string(&l).unwrap_or_default());
            } else {
                let proj = Path::new(&root).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                println!(
                    "{}  {:<9}  {:<6}  {}  {:<14}  {}{}",
                    chrono::Local::now().format("%H:%M:%S"),
                    c.to.label(),
                    r.key.kind.label(),
                    short_id(&r.key.id),
                    crate::ui::trunc(&proj, 14),
                    title,
                    if text.is_empty() { String::new() } else { format!(": {}", one_line(&text, 90)) }
                );
            }
            if hooks {
                fire_hooks(&cfg, &c, &r, &root, &title);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(1000));
    }
}
