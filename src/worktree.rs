//! A git worktree per session: the agent works on its own branch in its own
//! folder, and finishing asks whether to merge, keep or delete it.

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Worktree {
    /// Folder the agent works in.
    pub path: String,
    pub branch: String,
    /// Branch it was cut from, and where a merge goes.
    pub base: String,
    /// The main checkout.
    pub repo: String,
}

fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(crate::model::one_line(err.trim(), 200))
    }
}

/// A branch name from free text: lowercase words joined by dashes.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() || c == '/' || c == '.' || c == '_' {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches(['-', '/', '.']).to_string();
    if out.is_empty() { "session".into() } else { out.chars().take(60).collect() }
}

/// The main checkout a linked worktree belongs to (its `.git` file points
/// into `<repo>/.git/worktrees/<name>`).
pub fn main_repo_of(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(".git")).ok()?;
    let gitdir = text.trim().strip_prefix("gitdir:")?.trim();
    let i = gitdir.find("/.git/worktrees/")?;
    Some(gitdir[..i].to_string())
}

pub fn worktrees_dir() -> std::path::PathBuf {
    crate::config::state_dir().join("worktrees")
}

/// Cuts a new branch from the repo's current branch and checks it out in
/// its own folder under the state dir.
pub fn create(repo: &str, name: &str, project_key: &str) -> Result<Worktree, String> {
    let base = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if base == "HEAD" {
        return Err("the repo is on a detached HEAD; check out a branch first".into());
    }
    let stem = slug(name);
    let mut branch = stem.clone();
    let mut n = 2;
    while git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok() {
        branch = format!("{stem}-{n}");
        n += 1;
    }
    let dir = worktrees_dir().join(project_key).join(branch.replace('/', "-"));
    let _ = std::fs::create_dir_all(dir.parent().unwrap_or(&dir));
    let path = dir.to_string_lossy().to_string();
    git(repo, &["worktree", "add", "-b", &branch, &path, &base])?;
    Ok(Worktree { path, branch, base, repo: repo.to_string() })
}

/// Commits on the branch that the base does not have, and whether the
/// worktree has uncommitted changes.
pub fn status(wt: &Worktree) -> (u32, bool) {
    let ahead = git(&wt.repo, &["rev-list", "--count", &format!("{}..{}", wt.base, wt.branch)]).ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    let dirty = git(&wt.path, &["status", "--porcelain"]).map(|s| !s.is_empty()).unwrap_or(false);
    (ahead, dirty)
}

/// Merges the branch into its base in the main checkout, then removes the
/// worktree and the branch.
pub fn merge(wt: &Worktree) -> Result<String, String> {
    let (ahead, dirty) = status(wt);
    if dirty {
        return Err(format!("{} has uncommitted changes; commit them in the worktree first, or keep it", wt.branch));
    }
    let cur = git(&wt.repo, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if cur != wt.base {
        return Err(format!("the main checkout is on {cur}, not {}; switch it back to merge", wt.base));
    }
    if ahead > 0 {
        git(&wt.repo, &["merge", "--no-ff", "--no-edit", &wt.branch])?;
    }
    remove(wt, true)?;
    Ok(if ahead > 0 { format!("merged {} commit{} from {} into {}", ahead, if ahead == 1 { "" } else { "s" }, wt.branch, wt.base) } else { format!("{} had no commits; removed it", wt.branch) })
}

/// Removes the worktree folder, and the branch when `delete_branch`.
pub fn remove(wt: &Worktree, delete_branch: bool) -> Result<(), String> {
    if Path::new(&wt.path).exists() {
        git(&wt.repo, &["worktree", "remove", "--force", &wt.path])?;
    }
    let _ = git(&wt.repo, &["worktree", "prune"]);
    if delete_branch {
        git(&wt.repo, &["branch", "-D", &wt.branch])?;
    }
    Ok(())
}
