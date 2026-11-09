//! Reviewer agent: a clean-context headless run over a session's
//! uncommitted changes, with its findings kept beside the session.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::model::*;

#[derive(Clone, Debug, Default)]
pub struct Review {
    pub running: bool,
    pub started: i64,
    pub finished: i64,
    pub files: usize,
    pub text: String,
    pub error: String,
    pub path: Option<PathBuf>,
}

pub type Shared = Arc<Mutex<HashMap<RunKey, Review>>>;

pub fn dir() -> PathBuf {
    crate::config::state_dir().join("reviews")
}

fn file_for(k: &RunKey) -> PathBuf {
    dir().join(format!("{}-{}.md", k.kind.label(), k.id))
}

/// Reviews saved by earlier runs, so findings survive a restart.
pub fn load_all() -> Shared {
    let mut m = HashMap::new();
    if let Ok(rd) = std::fs::read_dir(dir()) {
        for e in rd.flatten() {
            let p = e.path();
            let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else { continue };
            let Some((kind, id)) = stem.split_once('-') else { continue };
            let kind = match kind {
                "claude" => AgentKind::Claude,
                "codex" => AgentKind::Codex,
                _ => continue,
            };
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            let finished = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
            let body = text.split_once("\n---\n").map(|(_, b)| b.trim().to_string()).unwrap_or(text);
            m.insert(RunKey { kind, id: id.to_string() }, Review { finished, text: body, path: Some(p), ..Default::default() });
        }
    }
    Arc::new(Mutex::new(m))
}

const INSTRUCTIONS: &str = "You are a code reviewer with a fresh context. Another coding agent made the uncommitted changes below in this repository. Review them for correctness bugs, missed edge cases, broken behaviour, security problems and leftovers (debug code, dead code, unfinished work). You may read files in the repository for context. Do not change any files.

Answer as a markdown list, most severe first. Each item: `- **severity** path:line: what is wrong, and what happens because of it.` Severity is one of bug, risk, nit. Leave out style preferences. If you find nothing worth fixing, say so in one line.

";

/// The repo's diff for the files the session changed (all uncommitted
/// changes when it changed none we know of), new files included.
pub fn session_diff(run: &AgentRun) -> (String, usize) {
    let root = crate::store::work_root(Path::new(&run.cwd)).unwrap_or(run.cwd.clone());
    let mut files: Vec<String> = run
        .files
        .values()
        .filter(|f| f.edits + f.writes > 0)
        .filter_map(|f| f.path.strip_prefix(&root).map(|p| p.trim_start_matches('/').to_string()))
        .filter(|p| !p.is_empty())
        .collect();
    files.sort();
    let mut args = vec!["-C".to_string(), root.clone(), "diff".into(), "--no-color".into(), "--no-ext-diff".into(), "--src-prefix=a/".into(), "--dst-prefix=b/".into(), "HEAD".into(), "--".into()];
    args.extend(files.iter().cloned());
    let mut diff = std::process::Command::new("git").args(&args).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    // Untracked files the session wrote do not show in git diff.
    let untracked = std::process::Command::new("git")
        .args(["-C", &root, "ls-files", "--others", "--exclude-standard", "--"])
        .args(&files)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(String::from).collect::<Vec<_>>())
        .unwrap_or_default();
    for f in &untracked {
        if let Ok(text) = std::fs::read_to_string(Path::new(&root).join(f)) {
            diff.push_str(&format!("diff --git a/{f} b/{f}\nnew file\n--- /dev/null\n+++ b/{f}\n"));
            for l in text.lines().take(400) {
                diff.push('+');
                diff.push_str(l);
                diff.push('\n');
            }
        }
    }
    let n = diff.lines().filter(|l| l.starts_with("diff --git ")).count();
    (diff, n)
}

/// Starts a review in the background. Returns how many files it covers.
pub fn start(shared: Shared, run: &AgentRun, title: &str, command: &str) -> Result<usize, String> {
    if shared.lock().unwrap().get(&run.key).map(|r| r.running).unwrap_or(false) {
        return Err("a review of this session is already running".into());
    }
    let (diff, n) = session_diff(run);
    if diff.trim().is_empty() {
        return Err("nothing uncommitted to review in this session's files".into());
    }
    let cap = 200_000;
    let diff = if diff.len() > cap { format!("{}\n[diff cut at {cap} bytes]\n", &diff[..diff.char_indices().take_while(|(i, _)| *i < cap).last().map(|(i, _)| i).unwrap_or(0)]) } else { diff };
    let prompt = format!("{INSTRUCTIONS}The session was: {title}\n\n```diff\n{diff}```\n");
    let key = run.key.clone();
    let root = crate::store::work_root(Path::new(&run.cwd)).unwrap_or(run.cwd.clone());
    let command = command.to_string();
    shared.lock().unwrap().insert(key.clone(), Review { running: true, started: now_ms(), files: n, ..Default::default() });
    let title = title.to_string();
    std::thread::spawn(move || {
        let res = run_headless(&command, &prompt, Path::new(&root));
        let mut m = shared.lock().unwrap();
        let r = m.entry(key.clone()).or_default();
        r.running = false;
        r.finished = now_ms();
        match res {
            Ok(text) => {
                let _ = std::fs::create_dir_all(dir());
                let p = file_for(&key);
                let head = format!("# Review: {title}\n\n{} files, by `{command}`, {}\n\n---\n", n, chrono::Local::now().format("%Y-%m-%d %H:%M"));
                let _ = std::fs::write(&p, format!("{head}{text}\n"));
                r.text = text;
                r.error.clear();
                r.path = Some(p);
            }
            Err(e) => r.error = e,
        }
    });
    Ok(n)
}

fn run_headless(command: &str, prompt: &str, cwd: &Path) -> Result<String, String> {
    use std::io::Write;
    let argv = shell_words::split(command).map_err(|e| e.to_string())?;
    if argv.is_empty() {
        return Err("empty review command".into());
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
        return Err(one_line(&String::from_utf8_lossy(&out.stderr), 200));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
