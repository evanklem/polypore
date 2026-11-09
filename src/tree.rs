//! The files panel: a navigable tree of the project, with what the agent
//! touched marked and unfolded. Pure functions so it can be tested.

use std::collections::{BTreeMap, HashMap};

/// What the agent did to a file (paths relative to the project root).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mark {
    pub added: u32,
    pub removed: u32,
    pub changed: bool,
    pub read: bool,
}

#[derive(Clone, Debug, Default)]
pub struct TreeState {
    /// Show every project file instead of only the touched ones.
    pub all: bool,
    /// Folders the user opened or closed by hand; others follow the default.
    pub open: HashMap<String, bool>,
    pub sel: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub depth: usize,
    pub name: String,
    pub rel: String,
    pub dir: bool,
    pub open: bool,
    pub mark: Mark,
    /// Changed files somewhere below a folder (shown when it is closed).
    pub changed_below: usize,
}

#[derive(Default)]
struct Node {
    dirs: BTreeMap<String, Node>,
    files: BTreeMap<String, Mark>,
}

impl Node {
    fn insert(&mut self, parts: &[&str], mark: Mark) {
        match parts {
            [] => {}
            [file] => {
                let e = self.files.entry(file.to_string()).or_default();
                e.added += mark.added;
                e.removed += mark.removed;
                e.changed |= mark.changed;
                e.read |= mark.read;
            }
            [dir, rest @ ..] => self.dirs.entry(dir.to_string()).or_default().insert(rest, mark),
        }
    }

    fn touched(&self) -> (usize, usize) {
        let mut changed = self.files.values().filter(|m| m.changed).count();
        let mut any = self.files.values().filter(|m| m.changed || m.read).count();
        for d in self.dirs.values() {
            let (c, a) = d.touched();
            changed += c;
            any += a;
        }
        (changed, any)
    }
}

/// Flattens the tree into visible rows. Folders holding touched files start
/// open; everything else starts closed. A single-child folder chain is
/// shown as one row ("src/sources") to keep depth down.
pub fn rows(paths: &[String], marks: &HashMap<String, Mark>, st: &TreeState) -> Vec<Row> {
    let mut root = Node::default();
    if st.all {
        for p in paths {
            root.insert(&p.split('/').collect::<Vec<_>>(), marks.get(p).copied().unwrap_or_default());
        }
    }
    for (p, m) in marks {
        if !st.all || !paths.iter().any(|x| x == p) {
            root.insert(&p.split('/').collect::<Vec<_>>(), *m);
        }
    }
    let mut out = Vec::new();
    walk(&root, "", 0, st, &mut out);
    out
}

fn walk(node: &Node, prefix: &str, depth: usize, st: &TreeState, out: &mut Vec<Row>) {
    for (name, child) in &node.dirs {
        // Collapse chains of single folders: a/b/c with nothing else.
        let mut label = name.clone();
        let mut rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        let mut cur = child;
        while cur.files.is_empty() && cur.dirs.len() == 1 {
            let (n, c) = cur.dirs.iter().next().unwrap();
            label = format!("{label}/{n}");
            rel = format!("{rel}/{n}");
            cur = c;
        }
        let (changed, touched) = cur.touched();
        let default_open = touched > 0 && (touched <= 60 || !st.all);
        let open = st.open.get(&rel).copied().unwrap_or(default_open);
        out.push(Row { depth, name: label, rel: rel.clone(), dir: true, open, mark: Mark::default(), changed_below: changed });
        if open {
            walk(cur, &rel, depth + 1, st, out);
        }
    }
    for (name, mark) in &node.files {
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        out.push(Row { depth, name: name.clone(), rel, dir: false, open: false, mark: *mark, changed_below: 0 });
    }
}

/// Lists project files: git's view when it is a repository (tracked plus
/// untracked, minus ignored), otherwise a bounded walk.
pub fn list_files(root: &str) -> Vec<String> {
    let out = std::process::Command::new("git")
        .args(["-C", root, "ls-files", "--cached", "--others", "--exclude-standard"])
        .stderr(std::process::Stdio::null())
        .output();
    if let Ok(o) = out {
        if o.status.success() {
            let mut v: Vec<String> = String::from_utf8_lossy(&o.stdout).lines().map(String::from).collect();
            v.truncate(20_000);
            return v;
        }
    }
    let mut v = Vec::new();
    let mut stack = vec![(std::path::PathBuf::from(root), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target" | "dist" | "build" | "__pycache__") {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                if depth < 6 {
                    stack.push((p, depth + 1));
                }
            } else if let Ok(rel) = p.strip_prefix(root) {
                v.push(rel.to_string_lossy().to_string());
                if v.len() >= 5000 {
                    return v;
                }
            }
        }
    }
    v.sort();
    v
}
