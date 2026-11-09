//! Process-tree inspection: which agent runs inside a pane, and which
//! session it writes. Exact on Linux (/proc, open file handles), best-effort
//! on macOS (ps + cwd/start-time match).

use std::collections::HashMap;
use std::path::PathBuf;

use crate::config::claude_dir;
use crate::model::{AgentKind, RunKey};

#[derive(Clone, Debug)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub comm: String,
    pub cmdline: String,
}

pub fn table() -> HashMap<u32, Proc> {
    let mut out = HashMap::new();
    #[cfg(target_os = "linux")]
    {
        if let Ok(rd) = std::fs::read_dir("/proc") {
            for e in rd.flatten() {
                let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
                let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
                // comm is in parens and may contain spaces.
                let Some(open) = stat.find('(') else { continue };
                let Some(close) = stat.rfind(')') else { continue };
                let comm = stat[open + 1..close].to_string();
                let rest: Vec<&str> = stat[close + 2..].split(' ').collect();
                let ppid = rest.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
                out.insert(pid, Proc { pid, ppid, comm, cmdline: String::new() });
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        if let Ok(o) = std::process::Command::new("ps").args(["-A", "-o", "pid=,ppid=,comm="]).output() {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                let mut it = line.split_whitespace();
                let (Some(pid), Some(ppid)) = (it.next(), it.next()) else { continue };
                let comm: String = it.collect::<Vec<_>>().join(" ");
                let (Ok(pid), Ok(ppid)) = (pid.parse(), ppid.parse()) else { continue };
                let short = comm.rsplit('/').next().unwrap_or(&comm).to_string();
                out.insert(pid, Proc { pid, ppid, comm: short, cmdline: comm });
            }
        }
    }
    out
}

fn cmdline(pid: u32) -> String {
    #[cfg(target_os = "linux")]
    {
        std::fs::read(format!("/proc/{pid}/cmdline"))
            .map(|b| b.split(|c| *c == 0).map(|s| String::from_utf8_lossy(s).to_string()).collect::<Vec<_>>().join(" "))
            .unwrap_or_default()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        String::new()
    }
}

pub fn descendants(root: u32, table: &HashMap<u32, Proc>) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in table.values() {
        children.entry(p.ppid).or_default().push(p.pid);
    }
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(p) = stack.pop() {
        if let Some(c) = children.get(&p) {
            for &k in c {
                out.push(k);
                stack.push(k);
            }
        }
    }
    out
}

fn classify(p: &Proc) -> Option<AgentKind> {
    let comm = p.comm.to_ascii_lowercase();
    if comm == "claude" {
        return Some(AgentKind::Claude);
    }
    if comm == "codex" || comm.starts_with("codex-") {
        return Some(AgentKind::Codex);
    }
    if comm == "node" || comm == "bun" || comm.starts_with("mainthread") {
        let cl = if p.cmdline.is_empty() { cmdline(p.pid) } else { p.cmdline.clone() };
        if cl.contains("claude-code") || cl.contains("/claude ") || cl.ends_with("/claude") {
            return Some(AgentKind::Claude);
        }
        if cl.contains("@openai/codex") || cl.contains("/codex ") || cl.ends_with("/codex") {
            return Some(AgentKind::Codex);
        }
    }
    None
}

#[derive(Clone, Debug)]
pub struct Detected {
    pub kind: AgentKind,
    pub run: Option<RunKey>,
}

/// Finds the agent process under `root` (the pane's child) and its session.
pub fn detect(root: u32, table: &HashMap<u32, Proc>, cwd: &str, since_ms: i64) -> Option<Detected> {
    let mut pids = vec![root];
    pids.extend(descendants(root, table));
    for pid in pids {
        let Some(p) = table.get(&pid) else { continue };
        let Some(kind) = classify(p) else { continue };
        let run = match kind {
            AgentKind::Claude => claude_session_for(pid, table),
            AgentKind::Codex => codex_session_for(pid, table, cwd, since_ms),
        };
        return Some(Detected { kind, run });
    }
    None
}

fn claude_session_for(pid: u32, table: &HashMap<u32, Proc>) -> Option<RunKey> {
    let mut cands = vec![pid];
    cands.extend(descendants(pid, table));
    for c in cands {
        let path = claude_dir().join("sessions").join(format!("{c}.json"));
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(id) = v.get("sessionId").and_then(|s| s.as_str()) {
                    return Some(RunKey { kind: AgentKind::Claude, id: id.to_string() });
                }
            }
        }
    }
    None
}

fn codex_session_for(pid: u32, table: &HashMap<u32, Proc>, cwd: &str, since_ms: i64) -> Option<RunKey> {
    // Exact: a rollout file the process holds open.
    #[cfg(target_os = "linux")]
    {
        let mut cands = vec![pid];
        cands.extend(descendants(pid, table));
        for c in cands {
            if let Ok(rd) = std::fs::read_dir(format!("/proc/{c}/fd")) {
                for e in rd.flatten() {
                    if let Ok(target) = std::fs::read_link(e.path()) {
                        if let Some(k) = rollout_key(&target) {
                            return Some(k);
                        }
                    }
                }
            }
        }
    }
    let _ = (table, pid);
    // Fallback: newest rollout started after the pane with a matching cwd.
    newest_rollout(cwd, since_ms)
}

pub fn rollout_key(path: &std::path::Path) -> Option<RunKey> {
    let s = path.to_string_lossy();
    if !s.contains("/sessions/") || !s.ends_with(".jsonl") || !s.contains("rollout-") {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    if stem.len() < 36 {
        return None;
    }
    Some(RunKey { kind: AgentKind::Codex, id: stem[stem.len() - 36..].to_string() })
}

fn newest_rollout(cwd: &str, since_ms: i64) -> Option<RunKey> {
    let now = chrono::Local::now();
    let mut best: Option<(i64, PathBuf)> = None;
    for back in 0..2 {
        let day = now - chrono::Duration::days(back);
        let dir = crate::config::codex_dir().join("sessions").join(day.format("%Y/%m/%d").to_string());
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(md) = e.metadata() else { continue };
            let mt = md
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if mt + 2000 < since_ms {
                continue;
            }
            if best.as_ref().map(|b| b.0 >= mt).unwrap_or(false) {
                continue;
            }
            let (c, _, _, _) = crate::sources::codex::scan_meta(&p);
            if c == cwd || cwd.starts_with(&c) || c.starts_with(cwd) {
                best = Some((mt, p));
            }
        }
    }
    best.and_then(|(_, p)| rollout_key(&p))
}

/// Current working directory of a process, for shells that don't emit OSC 7.
pub fn cwd_of(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{pid}/cwd")).ok().map(|p| p.to_string_lossy().to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

/// The deepest descendant's command name, used as a pane label ("nvim", "htop").
pub fn foreground(root: u32, table: &HashMap<u32, Proc>) -> Option<String> {
    let mut cur = root;
    let mut name = None;
    loop {
        let next = table.values().filter(|p| p.ppid == cur).max_by_key(|p| p.pid);
        match next {
            Some(p) => {
                name = Some(p.comm.clone());
                cur = p.pid;
            }
            None => break,
        }
    }
    name
}
