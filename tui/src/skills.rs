//! Skill management: one source folder, symlinked into each CLI's skills
//! directory. Reports drift, duplicates, broken links and usage.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// Symlink into the source folder.
    Synced,
    /// Real directory with the same content as the source copy.
    CopySame,
    /// Real directory whose SKILL.md differs from the source copy.
    Drift,
    /// Real directory with no source copy.
    Unmanaged,
    /// Symlink somewhere else (e.g. /usr/share/omarchy).
    External,
    /// Symlink whose target is gone.
    Broken,
    /// In the source but not installed here.
    Missing,
    /// Managed by the CLI itself (claude.ai sync).
    Vendor,
}

impl Status {
    pub fn label(self) -> &'static str {
        match self {
            Status::Synced => "synced",
            Status::CopySame => "copy",
            Status::Drift => "drift",
            Status::Unmanaged => "unmanaged",
            Status::External => "external",
            Status::Broken => "broken",
            Status::Missing => "missing",
            Status::Vendor => "vendor",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub in_source: bool,
    /// target label ("claude", "codex") -> status
    pub installs: BTreeMap<String, (Status, Option<PathBuf>)>,
    pub uses: u32,
}

pub fn target_label(p: &Path) -> String {
    let s = p.to_string_lossy();
    if s.contains(".claude") {
        "claude".into()
    } else if s.contains(".codex") {
        "codex".into()
    } else {
        p.parent().and_then(|x| x.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| s.to_string())
    }
}

fn skill_md(dir: &Path) -> Option<String> {
    for n in ["SKILL.md", "skill.md"] {
        if let Ok(t) = std::fs::read_to_string(dir.join(n)) {
            return Some(t);
        }
    }
    None
}

pub fn description(text: &str) -> String {
    let lines: Vec<&str> = text.lines().take(40).collect();
    for (i, l) in lines.iter().enumerate() {
        if let Some(d) = l.strip_prefix("description:") {
            let d = d.trim();
            // YAML block scalars (> >- | |-) continue on indented lines.
            if d.is_empty() || d.starts_with('>') || d.starts_with('|') {
                let body: Vec<&str> = lines[i + 1..]
                    .iter()
                    .take_while(|x| x.starts_with(' ') || x.starts_with('\t') || x.is_empty())
                    .map(|x| x.trim())
                    .collect();
                return crate::model::one_line(&body.join(" "), 160);
            }
            return crate::model::one_line(d.trim_matches('"').trim_matches('\''), 160);
        }
    }
    String::new()
}

pub fn inventory(source: &Path, targets: &[PathBuf], usage: &HashMap<String, u32>) -> Vec<Skill> {
    let mut skills: BTreeMap<String, Skill> = BTreeMap::new();
    let mut source_md: HashMap<String, String> = HashMap::new();
    if let Ok(rd) = std::fs::read_dir(source) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            let md = skill_md(&p).unwrap_or_default();
            skills.insert(
                name.clone(),
                Skill { name: name.clone(), description: description(&md), in_source: true, installs: BTreeMap::new(), uses: 0 },
            );
            source_md.insert(name, md);
        }
    }
    let canon_source = std::fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf());
    for t in targets {
        let label = target_label(t);
        let Ok(rd) = std::fs::read_dir(t) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let p = e.path();
            let meta = std::fs::symlink_metadata(&p);
            let is_link = meta.as_ref().map(|m| m.file_type().is_symlink()).unwrap_or(false);
            let (status, link) = if name == "synced" {
                (Status::Vendor, None)
            } else if is_link {
                let target = std::fs::read_link(&p).ok();
                let resolved = std::fs::canonicalize(&p).ok();
                match resolved {
                    None => (Status::Broken, target),
                    Some(r) if r.starts_with(&canon_source) => (Status::Synced, target),
                    Some(_) => (Status::External, target),
                }
            } else if p.is_dir() {
                match source_md.get(&name) {
                    Some(src) => {
                        if skill_md(&p).as_deref() == Some(src.as_str()) {
                            (Status::CopySame, None)
                        } else {
                            (Status::Drift, None)
                        }
                    }
                    None => (Status::Unmanaged, None),
                }
            } else {
                continue;
            };
            let s = skills.entry(name.clone()).or_insert_with(|| Skill {
                name: name.clone(),
                description: skill_md(&p).map(|t| description(&t)).unwrap_or_default(),
                in_source: false,
                installs: BTreeMap::new(),
                uses: 0,
            });
            if s.description.is_empty() {
                s.description = skill_md(&p).map(|t| description(&t)).unwrap_or_default();
            }
            s.installs.insert(label.clone(), (status, link));
        }
    }
    for t in targets {
        let label = target_label(t);
        for s in skills.values_mut() {
            if s.in_source && !s.installs.contains_key(&label) {
                s.installs.insert(label.clone(), (Status::Missing, None));
            }
        }
    }
    for s in skills.values_mut() {
        s.uses = usage.get(&s.name).copied().unwrap_or(0);
    }
    skills.into_values().collect()
}

fn backup_dir() -> PathBuf {
    let d = crate::config::state_dir().join("skill-backups").join(chrono::Local::now().format("%Y%m%d-%H%M%S").to_string());
    let _ = std::fs::create_dir_all(&d);
    d
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let p = e.path();
        let dest = to.join(e.file_name());
        let ft = e.file_type()?;
        if ft.is_dir() {
            copy_dir(&p, &dest)?;
        } else if ft.is_symlink() {
            if let Ok(t) = std::fs::read_link(&p) {
                #[cfg(unix)]
                let _ = std::os::unix::fs::symlink(t, &dest);
            }
        } else {
            std::fs::copy(&p, &dest)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn link(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst)
}

#[cfg(not(unix))]
fn link(src: &Path, dst: &Path) -> std::io::Result<()> {
    copy_dir(src, dst)
}

/// Creates missing symlinks in every target for every source skill.
pub fn sync(source: &Path, targets: &[PathBuf]) -> Vec<String> {
    let mut log = Vec::new();
    let Ok(rd) = std::fs::read_dir(source) else { return vec!["no skills source folder yet".into()] };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let name = e.file_name();
        for t in targets {
            let _ = std::fs::create_dir_all(t);
            let dst = t.join(&name);
            if std::fs::symlink_metadata(&dst).is_ok() {
                continue;
            }
            match link(&p, &dst) {
                Ok(_) => log.push(format!("linked {} into {}", name.to_string_lossy(), target_label(t))),
                Err(e) => log.push(format!("{}: {e}", dst.display())),
            }
        }
    }
    if log.is_empty() {
        log.push("everything already linked".into());
    }
    log
}

/// Moves a skill under management: copies it into the source (if needed),
/// backs up every real-directory copy and replaces it with a symlink.
pub fn adopt(name: &str, source: &Path, targets: &[PathBuf]) -> Result<Vec<String>, String> {
    let mut log = Vec::new();
    std::fs::create_dir_all(source).map_err(|e| e.to_string())?;
    let src = source.join(name);
    if !src.exists() {
        let from = targets
            .iter()
            .map(|t| t.join(name))
            .find(|p| p.is_dir())
            .ok_or_else(|| format!("{name} is not installed anywhere"))?;
        let real = std::fs::canonicalize(&from).map_err(|e| e.to_string())?;
        copy_dir(&real, &src).map_err(|e| e.to_string())?;
        log.push(format!("copied {name} into the source folder"));
    }
    let backup = backup_dir();
    for t in targets {
        let dst = t.join(name);
        let meta = std::fs::symlink_metadata(&dst);
        let is_link = meta.as_ref().map(|m| m.file_type().is_symlink()).unwrap_or(false);
        if is_link {
            let resolved = std::fs::canonicalize(&dst).ok();
            let canon_src = std::fs::canonicalize(&src).ok();
            if resolved.is_some() && resolved == canon_src {
                continue;
            }
            std::fs::remove_file(&dst).map_err(|e| e.to_string())?;
        } else if dst.is_dir() {
            let b = backup.join(target_label(t)).join(name);
            if let Some(parent) = b.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::rename(&dst, &b).or_else(|_| copy_dir(&dst, &b).and_then(|_| std::fs::remove_dir_all(&dst))).map_err(|e| e.to_string())?;
            log.push(format!("backed up {}'s copy to {}", target_label(t), crate::config::display_path(&b)));
        }
        let _ = std::fs::create_dir_all(t);
        link(&src, &dst).map_err(|e| e.to_string())?;
        log.push(format!("linked {name} into {}", target_label(t)));
    }
    Ok(log)
}

pub fn remove_broken(name: &str, targets: &[PathBuf]) -> Vec<String> {
    let mut log = Vec::new();
    for t in targets {
        let p = t.join(name);
        let is_link = std::fs::symlink_metadata(&p).map(|m| m.file_type().is_symlink()).unwrap_or(false);
        if is_link && std::fs::canonicalize(&p).is_err() && std::fs::remove_file(&p).is_ok() {
            log.push(format!("removed broken link from {}", target_label(t)));
        }
    }
    log
}

pub fn create(name: &str, source: &Path, targets: &[PathBuf]) -> Result<PathBuf, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("use letters, digits, - and _".into());
    }
    let dir = source.join(name);
    if dir.exists() {
        return Err(format!("{name} already exists"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let md = dir.join("SKILL.md");
    std::fs::write(
        &md,
        format!(
            "---\nname: {name}\ndescription: One sentence saying when an agent should use this skill.\n---\n\n# {name}\n\nWrite the steps the agent should follow.\n"
        ),
    )
    .map_err(|e| e.to_string())?;
    sync(source, targets);
    Ok(md)
}

pub fn install_builtin(source: &Path, targets: &[PathBuf], name: &str, text: &str) -> Result<(), String> {
    let dir = source.join(name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("SKILL.md"), text).map_err(|e| e.to_string())?;
    sync(source, targets);
    Ok(())
}

/// Counts Skill tool calls across all claude transcripts. Byte-level scan,
/// only lines that mention the Skill tool are parsed.
pub fn usage_counts() -> HashMap<String, u32> {
    let mut counts: HashMap<String, u32> = HashMap::new();
    let root = crate::config::claude_dir().join("projects");
    let Ok(dirs) = std::fs::read_dir(root) else { return counts };
    let needle = b"\"name\":\"Skill\"";
    for d in dirs.flatten() {
        let Ok(files) = std::fs::read_dir(d.path()) else { continue };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let mut off = 0u64;
            let _ = crate::sources::tail_lines(&p, &mut off, |line| {
                if !line.windows(needle.len()).any(|w| w == needle) {
                    return;
                }
                let s = String::from_utf8_lossy(line);
                let mut rest: &str = &s;
                while let Some(i) = rest.find("\"name\":\"Skill\"") {
                    rest = &rest[i + 14..];
                    if let Some(j) = rest.find("\"skill\":\"") {
                        let after = &rest[j + 9..];
                        if let Some(k) = after.find('"') {
                            let name = after[..k].trim_start_matches('/').to_string();
                            let name = name.split(':').next_back().unwrap_or(&name).to_string();
                            *counts.entry(name).or_default() += 1;
                        }
                    }
                }
            });
        }
    }
    counts
}
