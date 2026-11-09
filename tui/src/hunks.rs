//! lazygit-style review of the working tree: the diff as files and hunks,
//! each hunk staged, unstaged or reverted on its own with `git apply`.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Clone, Debug, PartialEq)]
pub struct Hunk {
    /// `@@ -a,b +c,d @@ context`
    pub header: String,
    pub lines: Vec<String>,
    /// First line of the hunk in the new file.
    pub new_start: u32,
    pub added: u32,
    pub removed: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FileDiff {
    pub path: String,
    /// `diff --git`, `index`, `---`, `+++` and mode lines.
    pub header: Vec<String>,
    pub hunks: Vec<Hunk>,
    pub staged: bool,
    pub untracked: bool,
    pub binary: bool,
}

impl FileDiff {
    pub fn added(&self) -> u32 {
        self.hunks.iter().map(|h| h.added).sum()
    }
    pub fn removed(&self) -> u32 {
        self.hunks.iter().map(|h| h.removed).sum()
    }
}

/// Parses `git diff` output.
pub fn parse(diff: &str, staged: bool) -> Vec<FileDiff> {
    let mut out: Vec<FileDiff> = Vec::new();
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            // `a/x b/x`: take the b side.
            let path = rest.rsplit_once(" b/").map(|(_, b)| b.to_string()).unwrap_or_else(|| rest.to_string());
            out.push(FileDiff { path, header: vec![line.to_string()], hunks: Vec::new(), staged, untracked: false, binary: false });
            continue;
        }
        let Some(f) = out.last_mut() else { continue };
        if line.starts_with("@@") {
            let new_start = line
                .split_whitespace()
                .find(|w| w.starts_with('+'))
                .and_then(|w| w.trim_start_matches('+').split(',').next())
                .and_then(|n| n.parse().ok())
                .unwrap_or(1);
            f.hunks.push(Hunk { header: line.to_string(), lines: Vec::new(), new_start, added: 0, removed: 0 });
        } else if let Some(h) = f.hunks.last_mut() {
            if line.starts_with('+') {
                h.added += 1;
            } else if line.starts_with('-') {
                h.removed += 1;
            }
            h.lines.push(line.to_string());
        } else {
            if line.starts_with("Binary files") {
                f.binary = true;
            }
            f.header.push(line.to_string());
        }
    }
    out
}

fn git(root: &str, args: &[&str]) -> String {
    Command::new("git").arg("-C").arg(root).args(args).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default()
}

/// Unstaged changes, then staged ones, then untracked files.
pub fn load(root: &str) -> Vec<FileDiff> {
    // Fixed prefixes: diff.mnemonicPrefix and diff.noprefix would change them.
    let base = ["--no-color", "--no-ext-diff", "-U3", "--src-prefix=a/", "--dst-prefix=b/"];
    let mut v = parse(&git(root, &[&["diff"][..], &base].concat()), false);
    v.extend(parse(&git(root, &[&["diff", "--cached"][..], &base].concat()), true));
    for p in git(root, &["ls-files", "--others", "--exclude-standard"]).lines() {
        let lines: Vec<String> = std::fs::read_to_string(Path::new(root).join(p)).map(|t| t.lines().take(2000).map(|l| format!("+{l}")).collect()).unwrap_or_default();
        let n = lines.len() as u32;
        let hunk = Hunk { header: format!("@@ -0,0 +1,{n} @@ new file"), lines, new_start: 1, added: n, removed: 0 };
        v.push(FileDiff { path: p.to_string(), header: Vec::new(), hunks: vec![hunk], staged: false, untracked: true, binary: false });
    }
    v
}

/// A patch holding one hunk, for `git apply`.
pub fn patch(f: &FileDiff, h: &Hunk) -> String {
    let mut s = f.header.join("\n");
    s.push('\n');
    s.push_str(&h.header);
    s.push('\n');
    for l in &h.lines {
        s.push_str(l);
        s.push('\n');
    }
    s
}

fn apply(root: &str, args: &[&str], patch: &str) -> Result<(), String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .arg("apply")
        .args(args)
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child.stdin.take().ok_or("no stdin")?.write_all(patch.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(crate::model::one_line(&String::from_utf8_lossy(&out.stderr), 160))
    }
}

/// Stages an unstaged hunk, or unstages a staged one.
pub fn toggle_stage(root: &str, f: &FileDiff, h: &Hunk) -> Result<&'static str, String> {
    if f.untracked {
        let out = Command::new("git").args(["-C", root, "add", "--", &f.path]).output().map_err(|e| e.to_string())?;
        return if out.status.success() { Ok("staged the new file") } else { Err(crate::model::one_line(&String::from_utf8_lossy(&out.stderr), 160)) };
    }
    if f.binary {
        return Err("binary file: stage it from a terminal".into());
    }
    let p = patch(f, h);
    if f.staged {
        apply(root, &["--cached", "-R"], &p).map(|_| "unstaged the hunk")
    } else {
        apply(root, &["--cached"], &p).map(|_| "staged the hunk")
    }
}

/// Throws away an unstaged hunk from the working tree (an untracked file
/// is deleted).
pub fn revert(root: &str, f: &FileDiff, h: &Hunk) -> Result<&'static str, String> {
    if f.staged {
        return Err("that hunk is staged; unstage it (space) before reverting".into());
    }
    if f.untracked {
        return std::fs::remove_file(Path::new(root).join(&f.path)).map(|_| "deleted the new file").map_err(|e| e.to_string());
    }
    if f.binary {
        return Err("binary file: revert it from a terminal".into());
    }
    apply(root, &["-R"], &patch(f, h)).map(|_| "reverted the hunk")
}

/// One row of the diff panel: a file heading or a hunk.
#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    File(usize),
    Hunk(usize, usize),
}

/// Files and hunks in display order, optionally only `only` paths.
pub fn items(files: &[FileDiff], only: Option<&[String]>) -> Vec<Item> {
    let mut v = Vec::new();
    for (i, f) in files.iter().enumerate() {
        if let Some(only) = only {
            if !only.iter().any(|p| p == &f.path) {
                continue;
            }
        }
        v.push(Item::File(i));
        for j in 0..f.hunks.len() {
            v.push(Item::Hunk(i, j));
        }
    }
    v
}
