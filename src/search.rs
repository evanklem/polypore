//! One finder over every transcript: titles, your prompts, the agents'
//! replies and the files they touched, across all projects. The index is
//! built in the background and cached per transcript (by size), so only
//! new or grown sessions are read again.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::model::*;
use crate::store::SessionInfo;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Doc {
    pub key: RunKey,
    pub path: PathBuf,
    pub size: u64,
    pub root: String,
    pub cwd: String,
    pub title: String,
    pub mtime: i64,
    /// Your prompts, oldest first, separated by blank lines.
    pub prompts: String,
    pub replies: String,
    pub files: Vec<String>,
}

#[derive(Default)]
pub struct Index {
    pub docs: Vec<Doc>,
    pub building: bool,
    pub done: usize,
    pub total: usize,
    pub built_at: Option<std::time::Instant>,
}

pub type Shared = Arc<Mutex<Index>>;

const PROMPT_CAP: usize = 24 * 1024;
const REPLY_CAP: usize = 16 * 1024;

fn cache_path() -> PathBuf {
    crate::config::state_dir().join("search-v2.json")
}

/// Drops terminal color codes that pasted logs carry (`ESC[31m`).
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' {
            if it.peek() == Some(&'[') {
                it.next();
                while let Some(&n) = it.peek() {
                    it.next();
                    if n.is_ascii_alphabetic() || n == '~' {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn push_capped(buf: &mut String, text: &str, each: usize, cap: usize, keep_newest: bool) {
    let t = one_line(&strip_ansi(text), each);
    if t.is_empty() {
        return;
    }
    if !buf.is_empty() {
        buf.push_str("\n\n");
    }
    buf.push_str(&t);
    if buf.len() > cap {
        if keep_newest {
            let mut cut = buf.len() - cap;
            while !buf.is_char_boundary(cut) {
                cut += 1;
            }
            buf.drain(..cut);
        } else {
            let mut cut = cap;
            while !buf.is_char_boundary(cut) {
                cut -= 1;
            }
            buf.truncate(cut);
        }
    }
}

fn texts(v: &serde_json::Value, kinds: &[&str]) -> Vec<String> {
    match v {
        serde_json::Value::String(s) => vec![s.clone()],
        serde_json::Value::Array(a) => a
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()).map(|t| kinds.contains(&t)).unwrap_or(false))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()).map(String::from))
            .collect(),
        _ => Vec::new(),
    }
}

/// Prompts, replies and files from one transcript.
pub fn extract(info: &SessionInfo) -> Doc {
    let mut prompts = String::new();
    let mut replies = String::new();
    let mut files: Vec<String> = Vec::new();
    let add_file = |p: &str, files: &mut Vec<String>| {
        let p = rel_path(p, &info.root);
        if !p.is_empty() && files.len() < 300 && !files.contains(&p) {
            files.push(p);
        }
    };
    let mut off = 0u64;
    let _ = crate::sources::tail_lines(&info.path, &mut off, |line| {
        match info.key.kind {
            AgentKind::Claude => {
                let user = memfind(line, b"\"type\":\"user\"");
                let asst = memfind(line, b"\"type\":\"assistant\"");
                if !user && !asst {
                    return;
                }
                // Tool results are the bulk of a transcript and not what you search for.
                if user && memfind(line, b"\"tool_result\"") && !memfind(line, b"\"type\":\"text\"") {
                    return;
                }
                let Ok(v) = serde_json::from_slice::<serde_json::Value>(line) else { return };
                if v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false) || v.get("isMeta").and_then(|b| b.as_bool()).unwrap_or(false) {
                    return;
                }
                let Some(content) = v.get("message").and_then(|m| m.get("content")) else { return };
                if user {
                    for t in texts(content, &["text"]) {
                        if !t.trim_start().starts_with('<') {
                            push_capped(&mut prompts, &t, 600, PROMPT_CAP, false);
                        }
                    }
                } else {
                    for t in texts(content, &["text"]) {
                        push_capped(&mut replies, &t, 400, REPLY_CAP, true);
                    }
                    if let Some(a) = content.as_array() {
                        for b in a.iter().filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use")) {
                            let input = b.get("input");
                            for k in ["file_path", "notebook_path", "path"] {
                                if let Some(p) = input.and_then(|i| i.get(k)).and_then(|p| p.as_str()) {
                                    add_file(p, &mut files);
                                }
                            }
                        }
                    }
                }
            }
            AgentKind::Codex => {
                if !memfind(line, b"\"response_item\"") {
                    return;
                }
                let Ok(v) = serde_json::from_slice::<serde_json::Value>(line) else { return };
                let Some(p) = v.get("payload") else { return };
                match p.get("type").and_then(|t| t.as_str()) {
                    Some("message") => {
                        let role = p.get("role").and_then(|r| r.as_str()).unwrap_or("");
                        let Some(c) = p.get("content") else { return };
                        for t in texts(c, &["input_text", "output_text", "text"]) {
                            if t.trim_start().starts_with('<') {
                                continue;
                            }
                            if role == "user" {
                                push_capped(&mut prompts, &t, 600, PROMPT_CAP, false);
                            } else if role == "assistant" {
                                push_capped(&mut replies, &t, 400, REPLY_CAP, true);
                            }
                        }
                    }
                    Some("function_call") | Some("custom_tool_call") => {
                        let args = p.get("arguments").or_else(|| p.get("input")).and_then(|a| a.as_str()).unwrap_or("");
                        for l in args.split("\\n").flat_map(|x| x.lines()) {
                            for pre in ["*** Update File: ", "*** Add File: ", "*** Delete File: "] {
                                if let Some(rest) = l.trim().strip_prefix(pre) {
                                    add_file(rest.trim_end_matches(['"', '\\']), &mut files);
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    });
    Doc {
        key: info.key.clone(),
        path: info.path.clone(),
        size: info.size,
        root: info.root.clone(),
        cwd: info.cwd.clone(),
        title: if !info.title.is_empty() {
            info.title.clone()
        } else if !info.first_prompt.is_empty() {
            one_line(&strip_ansi(&info.first_prompt), 80)
        } else {
            prompts.split("\n\n").next().map(|p| one_line(p, 80)).filter(|p| !p.is_empty()).unwrap_or_else(|| "untitled".into())
        },
        mtime: info.mtime,
        prompts,
        replies,
        files,
    }
}

fn memfind(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// Builds (or brings up to date) the index in the background.
pub fn build(shared: Shared, sessions: Vec<SessionInfo>) {
    {
        let mut s = shared.lock().unwrap();
        if s.building {
            return;
        }
        s.building = true;
        s.done = 0;
        s.total = sessions.len();
    }
    std::thread::Builder::new()
        .name("polypore-search".into())
        .spawn(move || {
            let mut cache: HashMap<PathBuf, Doc> = {
                let have = shared.lock().unwrap().docs.clone();
                let from_disk: Vec<Doc> = if have.is_empty() { std::fs::read_to_string(cache_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default() } else { have };
                from_disk.into_iter().map(|d| (d.path.clone(), d)).collect()
            };
            let mut docs = Vec::with_capacity(sessions.len());
            let mut changed = false;
            for (i, s) in sessions.iter().enumerate() {
                let doc = match cache.remove(&s.path) {
                    Some(mut d) if d.size == s.size => {
                        d.title = if s.title.is_empty() { d.title } else { s.title.clone() };
                        d.root = s.root.clone();
                        d
                    }
                    _ => {
                        changed = true;
                        extract(s)
                    }
                };
                docs.push(doc);
                if i % 20 == 0 {
                    shared.lock().unwrap().done = i;
                }
            }
            changed |= !cache.is_empty();
            if changed {
                if let Ok(t) = serde_json::to_string(&docs) {
                    let tmp = cache_path().with_extension("tmp");
                    if std::fs::write(&tmp, t).is_ok() {
                        let _ = std::fs::rename(tmp, cache_path());
                    }
                }
            }
            let mut s = shared.lock().unwrap();
            s.docs = docs;
            s.building = false;
            s.done = s.total;
            s.built_at = Some(std::time::Instant::now());
        })
        .expect("spawn search thread");
}

/// ASCII case-insensitive find; `needle` must already be lowercase.
pub fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    let h = hay.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || n.len() > h.len() {
        return if n.is_empty() { Some(0) } else { None };
    }
    let first = n[0];
    'outer: for i in 0..=h.len() - n.len() {
        if h[i].to_ascii_lowercase() != first {
            continue;
        }
        for j in 1..n.len() {
            if h[i + j].to_ascii_lowercase() != n[j] {
                continue 'outer;
            }
        }
        if hay.is_char_boundary(i) {
            return Some(i);
        }
    }
    None
}

#[derive(Clone, Debug)]
pub struct Hit {
    pub doc: usize,
    pub score: i64,
    /// (field, text around the first match).
    pub snippets: Vec<(&'static str, String)>,
}

fn snippet(text: &str, at: usize, w: usize) -> String {
    let mut start = at.saturating_sub(w / 3);
    while !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (at + w).min(text.len());
    while !text.is_char_boundary(end) {
        end += 1;
    }
    let s = one_line(&text[start..end], w + 10);
    if start > 0 { format!("…{s}") } else { s }
}

/// Every term must appear somewhere in a session; titles count most, then
/// the project, files, your prompts, the replies. Newer sessions break ties.
pub fn query(docs: &[Doc], q: &str, now: i64, limit: usize) -> Vec<Hit> {
    let terms: Vec<String> = q.split_whitespace().map(|t| t.to_lowercase()).collect();
    if terms.is_empty() {
        let mut v: Vec<Hit> = (0..docs.len()).map(|i| Hit { doc: i, score: docs[i].mtime / 1000, snippets: Vec::new() }).collect();
        v.sort_by(|a, b| b.score.cmp(&a.score));
        v.truncate(limit);
        return v;
    }
    let mut out = Vec::new();
    for (i, d) in docs.iter().enumerate() {
        let project = Path::new(&d.root).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let files = d.files.join("  ");
        let mut score = 0i64;
        let mut snippets: Vec<(&'static str, String)> = Vec::new();
        let mut all = true;
        for t in &terms {
            let fields: [(&'static str, &str, i64); 5] = [("title", &d.title, 40), ("project", &project, 25), ("file", &files, 15), ("you", &d.prompts, 10), ("reply", &d.replies, 4)];
            let mut found = false;
            for (name, text, weight) in fields {
                if let Some(at) = find_ci(text, t) {
                    score += weight;
                    found = true;
                    if !snippets.iter().any(|s| s.0 == name) && matches!(name, "you" | "reply" | "file") {
                        snippets.push((name, snippet(text, at, 90)));
                    }
                }
            }
            if !found {
                all = false;
                break;
            }
        }
        if !all {
            continue;
        }
        // Recency: up to 20 points across the last 30 days.
        let age_days = ((now - d.mtime) / 86_400_000).clamp(0, 30);
        score = score * 10 + (30 - age_days) * 2 / 3;
        out.push(Hit { doc: i, score, snippets });
    }
    out.sort_by(|a, b| b.score.cmp(&a.score).then(docs[b.doc].mtime.cmp(&docs[a.doc].mtime)));
    out.truncate(limit);
    out
}
