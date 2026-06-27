use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use notify::event::EventKind;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::project_context;

#[derive(Default)]
pub struct FsWatcher {
    inner: Mutex<Option<RecommendedWatcher>>,
    root: Mutex<Option<PathBuf>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsWatchStatus {
    pub root: Option<String>,
    pub running: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FileTreeNode {
    File {
        name: String,
        path: String,
    },
    Folder {
        name: String,
        children: Vec<FileTreeNode>,
    },
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileTreeConfig {
    #[serde(default)]
    include_dirs: Vec<String>,
    #[serde(default)]
    exclude_dirs: Vec<String>,
    #[serde(default)]
    text_extensions: Vec<String>,
    #[serde(default)]
    binary_extensions: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct KnowledgeNode {
    pub kind: &'static str,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBase {
    pub id: String,
    pub name: String,
    pub root: String,
    pub scope: String,
    pub suggested_scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_root: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBaseCreateInput {
    pub name: String,
    pub scope: String,
    pub preset: String,
    #[serde(default)]
    pub root: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBaseLocationInput {
    pub name: String,
    pub scope: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBaseLocation {
    pub location: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsEventPayload {
    kind: &'static str,
    paths: Vec<String>,
}

impl FsWatcher {
    fn ensure_started(&self, app: tauri::AppHandle) -> Result<FsWatchStatus, String> {
        let mut watcher_guard = self
            .inner
            .lock()
            .map_err(|_| "fs watcher lock failed".to_string())?;
        let mut root_guard = self
            .root
            .lock()
            .map_err(|_| "fs watcher root lock failed".to_string())?;
        let root = resolve_workspace_root()?;
        if watcher_guard.is_some() && root_guard.as_ref() == Some(&root) {
            return Ok(FsWatchStatus {
                root: root_guard.as_ref().map(|p| p.display().to_string()),
                running: true,
                message: "fs watcher already running".to_string(),
            });
        }
        if watcher_guard.is_some() {
            *watcher_guard = None;
            *root_guard = None;
        }

        let emit_app = app.clone();
        let watch_root = root.clone();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                let event = match result {
                    Ok(event) => event,
                    Err(_) => return,
                };
                let kind = match event.kind {
                    EventKind::Create(_) => "create",
                    EventKind::Modify(_) => "modify",
                    EventKind::Remove(_) => "remove",
                    EventKind::Access(_) => return,
                    _ => "other",
                };
                let paths = event
                    .paths
                    .iter()
                    .filter(|path| !ignored_watch_path(&watch_root, path))
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>();
                if paths.is_empty() {
                    return;
                }
                let _ = emit_app.emit("polypore://fs-event", FsEventPayload { kind, paths });
            })
            .map_err(|err| format!("failed to construct fs watcher: {err}"))?;

        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|err| format!("failed to watch {}: {err}", root.display()))?;

        let display = root.display().to_string();
        *watcher_guard = Some(watcher);
        *root_guard = Some(root);
        Ok(FsWatchStatus {
            root: Some(display),
            running: true,
            message: "fs watcher started".to_string(),
        })
    }
}

#[tauri::command]
pub fn fs_watch_status(
    state: tauri::State<'_, FsWatcher>,
    app: tauri::AppHandle,
) -> Result<FsWatchStatus, String> {
    state.ensure_started(app)
}

#[tauri::command]
pub fn fs_read_text(path: String) -> Result<String, String> {
    let target = resolve_workspace_path(&path)?;
    std::fs::read_to_string(&target)
        .map_err(|err| format!("failed to read {}: {err}", target.display()))
}

#[tauri::command]
pub fn fs_write_text(path: String, content: String) -> Result<(), String> {
    let target = resolve_workspace_write_path(&path)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create parent directory: {err}"))?;
    }
    std::fs::write(&target, content)
        .map_err(|err| format!("failed to write {}: {err}", target.display()))
}

#[tauri::command]
pub fn fs_mkdir(path: String) -> Result<(), String> {
    let target = resolve_workspace_write_path(&path)?;
    std::fs::create_dir_all(&target)
        .map_err(|err| format!("failed to create directory {}: {err}", target.display()))
}

#[tauri::command]
pub fn fs_delete(path: String) -> Result<(), String> {
    let target = resolve_workspace_write_path(&path)?;
    let meta = std::fs::symlink_metadata(&target)
        .map_err(|err| format!("failed to stat {}: {err}", target.display()))?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&target)
            .map_err(|err| format!("failed to delete directory {}: {err}", target.display()))
    } else {
        std::fs::remove_file(&target)
            .map_err(|err| format!("failed to delete file {}: {err}", target.display()))
    }
}

/* agent roots that know about skill symlinks (same as server.mjs agentSkillRoots) */
fn agent_skill_roots() -> Vec<(&'static str, PathBuf)> {
    let home = match std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        Ok(h) => PathBuf::from(h),
        Err(_) => return vec![],
    };
    vec![
        ("claude", home.join(".claude").join("skills")),
        ("codex", home.join(".codex").join("skills")),
    ]
}

#[tauri::command]
pub fn skill_publish(
    id: String,
    name: String,
    body: String,
    agents: Vec<String>,
) -> Result<Vec<String>, String> {
    let project_root = project_context::active_project_root()?;
    let skills_dir = project_root.join(".polypore").join("skills");
    /* write as a dir-based skill: {id}/SKILL.md — matches the format that
    Claude Code's slash-completion and Polypore's slash catalog both expect. */
    let skill_dir = skills_dir.join(&id);
    std::fs::create_dir_all(&skill_dir)
        .map_err(|err| format!("failed to create skill dir: {err}"))?;
    let description: String = body
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .chars()
        .take(100)
        .collect();
    let skill_md = format!("---\nname: {name}\ndescription: {description}\n---\n\n{body}");
    let skill_file = skill_dir.join("SKILL.md");
    std::fs::write(&skill_file, skill_md.as_bytes())
        .map_err(|err| format!("failed to write SKILL.md: {err}"))?;
    /* clean up any legacy flat .md file for the same id */
    let _ = std::fs::remove_file(skills_dir.join(format!("{id}.md")));

    let mut published = Vec::new();
    for (agent, dir) in agent_skill_roots() {
        if !agents.contains(&agent.to_string()) {
            continue;
        }
        if !dir.exists() {
            continue;
        }
        /* directory symlink has no extension; also clean up legacy .md symlink */
        let target = dir.join(&id);
        let legacy = dir.join(format!("{id}.md"));
        if legacy.symlink_metadata().is_ok() {
            let _ = std::fs::remove_file(&legacy);
        }
        if target.symlink_metadata().is_ok() {
            let _ = std::fs::remove_file(&target);
        }
        #[cfg(unix)]
        {
            if std::os::unix::fs::symlink(&skill_dir, &target).is_ok() {
                published.push(agent.to_string());
            }
        }
        #[cfg(windows)]
        {
            if std::fs::create_dir_all(&target).is_ok()
                && std::fs::copy(&skill_file, target.join("SKILL.md")).is_ok()
            {
                published.push(agent.to_string());
            }
        }
    }
    Ok(published)
}

#[tauri::command]
pub fn skill_unpublish(id: String) -> Result<Vec<String>, String> {
    let mut removed = Vec::new();
    for (agent, dir) in agent_skill_roots() {
        let dir_target = dir.join(&id);
        let flat_target = dir.join(format!("{id}.md"));
        let mut any = false;
        if dir_target.symlink_metadata().is_ok() && std::fs::remove_file(&dir_target).is_ok() {
            any = true;
        }
        if flat_target.symlink_metadata().is_ok() && std::fs::remove_file(&flat_target).is_ok() {
            any = true;
        }
        if any {
            removed.push(agent.to_string());
        }
    }
    Ok(removed)
}

#[tauri::command]
pub fn skill_delete(id: String) -> Result<(), String> {
    /* remove symlinks from agent skill dirs */
    for (_, dir) in agent_skill_roots() {
        let dir_target = dir.join(&id);
        let flat_target = dir.join(format!("{id}.md"));
        if dir_target.symlink_metadata().is_ok() {
            let _ = std::fs::remove_file(&dir_target);
        }
        if flat_target.symlink_metadata().is_ok() {
            let _ = std::fs::remove_file(&flat_target);
        }
    }
    /* delete the source directory from the project */
    let project_root = project_context::active_project_root()?;
    let skill_dir = project_root.join(".polypore").join("skills").join(&id);
    if skill_dir.exists() {
        std::fs::remove_dir_all(&skill_dir)
            .map_err(|e| format!("failed to delete skill directory: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn skill_list() -> Result<Vec<serde_json::Value>, String> {
    let project_root = project_context::active_project_root()?;
    let skills_dir = project_root.join(".polypore").join("skills");
    if !skills_dir.exists() {
        return Ok(vec![]);
    }
    let read = match std::fs::read_dir(&skills_dir) {
        Ok(r) => r,
        Err(_) => return Ok(vec![]),
    };
    let mut skills = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            /* directory-based skill (current format: {id}/SKILL.md) */
            let id = match path.file_name().and_then(|n| n.to_str()) {
                Some(s) if !s.is_empty() => s.to_string(),
                _ => continue,
            };
            let skill_file = path.join("SKILL.md");
            if !skill_file.exists() {
                continue;
            }
            let content = match std::fs::read_to_string(&skill_file) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let (name, description, body) = parse_skill_frontmatter(&content, &id);
            let published_to = skill_published_to(&id);
            skills.push(serde_json::json!({
                "id": id,
                "name": name,
                "summary": description,
                "body": body,
                "origin": "polypore",
                "publishedTo": published_to,
            }));
        } else if path.extension().is_some_and(|e| e == "md") {
            /* flat .md skill (legacy format) — migrate to directory on the fly so
            Codex can discover it (Codex only reads {id}/SKILL.md directories) */
            let stem = match path.file_stem().and_then(|n| n.to_str()) {
                Some(s) if !s.is_empty() => s.to_string(),
                _ => continue,
            };
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let (name, description, body) = parse_skill_frontmatter(&content, &stem);
            let desc_clamped: String = description.chars().take(100).collect();
            let skill_md = format!("---\nname: {name}\ndescription: {desc_clamped}\n---\n\n{body}");
            let skill_dir = skills_dir.join(&stem);
            if std::fs::create_dir_all(&skill_dir).is_ok()
                && std::fs::write(skill_dir.join("SKILL.md"), skill_md.as_bytes()).is_ok()
            {
                /* re-point agent symlinks from the flat .md to the new directory */
                for (_, agent_dir) in agent_skill_roots() {
                    let flat_link = agent_dir.join(format!("{stem}.md"));
                    let dir_link = agent_dir.join(&stem);
                    if flat_link.symlink_metadata().is_ok() {
                        let _ = std::fs::remove_file(&flat_link);
                        if dir_link.symlink_metadata().is_ok() {
                            let _ = std::fs::remove_file(&dir_link);
                        }
                        #[cfg(unix)]
                        {
                            let _ = std::os::unix::fs::symlink(&skill_dir, &dir_link);
                        }
                    }
                }
                let _ = std::fs::remove_file(&path); /* remove old flat file */
                let published_to = skill_published_to(&stem);
                skills.push(serde_json::json!({
                    "id": stem,
                    "name": name,
                    "summary": desc_clamped,
                    "body": body,
                    "origin": "polypore",
                    "publishedTo": published_to,
                }));
            }
        }
    }
    Ok(skills)
}

fn skill_published_to(id: &str) -> Vec<String> {
    agent_skill_roots()
        .into_iter()
        .filter(|(_, dir)| dir.join(id).symlink_metadata().is_ok())
        .map(|(agent, _)| agent.to_string())
        .collect()
}

fn parse_skill_frontmatter(content: &str, fallback_id: &str) -> (String, String, String) {
    let mut lines = content.lines();
    let mut name = fallback_id.to_string();
    let mut description = String::new();
    let body_start;
    /* check for YAML frontmatter block */
    if lines.next().is_some_and(|l| l.trim() == "---") {
        let mut consumed = 4usize; /* "---\n" */
        let mut found_end = false;
        for line in &mut lines {
            consumed += line.len() + 1;
            if line.trim() == "---" {
                found_end = true;
                consumed += 0;
                break;
            }
            if let Some(rest) = line.strip_prefix("name:") {
                name = rest.trim().to_string();
            } else if let Some(rest) = line.strip_prefix("description:") {
                description = rest.trim().to_string();
            }
        }
        body_start = if found_end { consumed } else { 0 };
    } else {
        body_start = 0;
    }
    let body = if body_start > 0 && body_start <= content.len() {
        content[body_start..].trim_start_matches('\n').to_string()
    } else {
        content.to_string()
    };
    if description.is_empty() {
        description = body
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .chars()
            .take(120)
            .collect();
    }
    (name, description, body)
}

#[tauri::command]
pub fn fs_list_tree() -> Result<Vec<FileTreeNode>, String> {
    let root = resolve_workspace_root()?;
    let mut count = 0usize;
    let config = load_file_tree_config(&root);
    list_dir(&root, &root, 0, &mut count, &config)
}

/// Lazy one-level listing for the file explorer. `path` is workspace-relative
/// (empty = root). Folders come back collapsed; the explorer requests their
/// children on expand via another call.
#[tauri::command]
pub fn fs_list_dir(path: String) -> Result<Vec<FileTreeNode>, String> {
    let root = resolve_workspace_root()?;
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());
    let target = resolve_workspace_path(&path)?;
    let config = load_file_tree_config(&root);
    list_dir_shallow(&canonical_root, &target, &config)
}

/// Complete, gitignore-aware list of workspace files for the quick-open index and
/// Monaco cross-file resolution. Decoupled from the explorer tree so it stays
/// complete even as the tree loads lazily. Backed by `rg --files`; falls back to an
/// empty list when ripgrep is unavailable (the host then scans open buffers).
fn list_workspace_files(root: &Path) -> Result<Vec<String>, String> {
    let output = match std::process::Command::new("rg")
        .arg("--files")
        .current_dir(root)
        .output()
    {
        Ok(output) => output,
        Err(_) => return Ok(Vec::new()),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| line.replace('\\', "/"))
        .collect())
}

#[tauri::command]
pub fn fs_list_files() -> Result<Vec<String>, String> {
    let root = resolve_workspace_root()?;
    list_workspace_files(&root)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub file: String,
    pub line: u32,
    pub text: String,
}

/// ripgrep-backed project search. rg is preferred for speed + gitignore
/// awareness; when it isn't on PATH we return an empty result rather than
/// blocking — the host falls back to scanning open editor buffers.
#[tauri::command]
pub fn fs_search(
    query: String,
    regex: Option<bool>,
    glob: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<SearchMatch>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }
    let root = resolve_workspace_root()?;
    let cap = limit.unwrap_or(200).min(1000) as usize;
    let mut args: Vec<String> = vec![
        "--line-number".into(),
        "--no-heading".into(),
        "--color".into(),
        "never".into(),
        "--max-count".into(),
        "50".into(),
    ];
    if regex != Some(true) {
        args.push("--fixed-strings".into());
    }
    if let Some(g) = glob.as_ref().filter(|g| !g.is_empty()) {
        args.push("--glob".into());
        args.push(g.clone());
    }
    args.push("--".into());
    args.push(query);
    args.push(".".into());

    let output = match std::process::Command::new("rg")
        .args(&args)
        .current_dir(&root)
        .output()
    {
        Ok(output) => output,
        Err(_) => return Ok(vec![]),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut matches = Vec::new();
    for line in stdout.lines() {
        let mut parts = line.splitn(3, ':');
        let file = parts.next().unwrap_or("");
        let lineno = parts.next().and_then(|value| value.parse::<u32>().ok());
        let text = parts.next().unwrap_or("");
        if let Some(lineno) = lineno {
            matches.push(SearchMatch {
                file: file.to_string(),
                line: lineno,
                text: text.chars().take(400).collect(),
            });
            if matches.len() >= cap {
                break;
            }
        }
    }
    Ok(matches)
}

#[tauri::command]
pub fn knowledge_bases_list() -> Result<Vec<KnowledgeBase>, String> {
    visible_knowledge_bases()
}

#[tauri::command]
pub async fn knowledge_pick_base_folder() -> Result<Option<KnowledgeBase>, String> {
    let result = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("polypore - open documents folder")
            .pick_folder()
    })
    .await
    .map_err(|err| format!("folder dialog dispatch failed: {err}"))?;

    result.map(configure_knowledge_folder).transpose()
}

#[tauri::command]
pub fn knowledge_base_suggest_location(
    input: KnowledgeBaseLocationInput,
) -> Result<String, String> {
    let root = unique_base_path(&default_knowledge_base_path(&input.name, &input.scope)?);
    Ok(folder_display(&root))
}

#[tauri::command]
pub async fn knowledge_pick_base_location() -> Result<KnowledgeBaseLocation, String> {
    let result = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("polypore - choose documents folder")
            .pick_folder()
    })
    .await
    .map_err(|err| format!("folder dialog dispatch failed: {err}"))?;

    let Some(path) = result else {
        return Ok(KnowledgeBaseLocation {
            location: None,
            scope: None,
        });
    };
    let scope = scope_for_folder(&path)?;
    Ok(KnowledgeBaseLocation {
        location: Some(folder_display(&path)),
        scope: Some(scope),
    })
}

#[tauri::command]
pub fn knowledge_base_create(input: KnowledgeBaseCreateInput) -> Result<KnowledgeBase, String> {
    let scope = checked_scope(&input.scope)?;
    let name = input.name.trim();
    if name.is_empty() {
        return Err("knowledge base name is required".to_string());
    }
    let root = if let Some(raw_root) = input
        .root
        .as_deref()
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        expand_user_path(raw_root)?
    } else {
        unique_base_path(&default_knowledge_base_path(name, scope)?)
    };
    std::fs::create_dir_all(&root)
        .map_err(|err| format!("failed to create documents base {}: {err}", root.display()))?;
    write_knowledge_preset(&root, name, &input.preset)?;

    let suggested_scope = scope_for_folder(&root)?;
    let base = KnowledgeBase {
        id: knowledge_base_id(name),
        name: name.to_string(),
        root: folder_display(&root),
        scope: scope.to_string(),
        suggested_scope: suggested_scope.clone(),
        project_root: (scope == "project")
            .then(project_root_display)
            .transpose()?,
    };
    upsert_knowledge_base(base)
}

#[tauri::command]
pub fn knowledge_base_set_scope(id: String, scope: String) -> Result<KnowledgeBase, String> {
    let scope = checked_scope(&scope)?;
    let visible = visible_knowledge_bases()?;
    let mut base = visible
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("knowledge base not found: {id}"))?;
    base.scope = scope.to_string();
    base.project_root = (scope == "project")
        .then(project_root_display)
        .transpose()?;
    upsert_knowledge_base(base)
}

#[tauri::command]
pub fn knowledge_base_rename(id: String, name: String) -> Result<KnowledgeBase, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("memory base name is required".to_string());
    }
    let mut bases = read_knowledge_registry()?;
    let pos = bases
        .iter()
        .position(|item| item.id == id)
        .ok_or_else(|| format!("memory base not found: {id}"))?;
    bases[pos].name = trimmed.to_string();
    write_knowledge_registry(&bases)?;
    Ok(bases[pos].clone())
}

#[tauri::command]
pub fn knowledge_base_delete(id: String) -> Result<(), String> {
    let bases = read_knowledge_registry()?;
    let base = bases.iter().find(|item| item.id == id).cloned();
    let root = base.as_ref().map(|b| PathBuf::from(&b.root));
    /* remove the on-disk folder before forgetting the registry entry so a
    partial failure (permission denied, fs error) leaves the user with a
    still-visible base they can retry on, rather than orphaned bytes. */
    if let Some(path) = root.as_ref() {
        if path.exists() {
            std::fs::remove_dir_all(path).map_err(|err| {
                format!("failed to remove memory folder {}: {err}", path.display())
            })?;
        }
    }
    let remaining: Vec<KnowledgeBase> = bases.into_iter().filter(|item| item.id != id).collect();
    write_knowledge_registry(&remaining)
}

#[tauri::command]
pub fn knowledge_folder_create(base_id: Option<String>, path: String) -> Result<(), String> {
    let cleaned = path.trim().trim_matches('/').to_string();
    if cleaned.is_empty() {
        return Err("folder name is required".to_string());
    }
    let target = resolve_knowledge_write_path(&cleaned, base_id.as_deref())?;
    if target.exists() {
        return Err(format!("folder already exists: {cleaned}"));
    }
    std::fs::create_dir_all(&target)
        .map_err(|err| format!("failed to create folder {}: {err}", target.display()))?;
    let leaf = cleaned.rsplit('/').next().unwrap_or("folder");
    let mut chars = leaf.chars();
    let heading: String = match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => "Folder".to_string(),
    };
    let index_path = target.join("index.md");
    if !index_path.exists() {
        std::fs::write(&index_path, format!("# {heading}\n\n"))
            .map_err(|err| format!("failed to seed {}: {err}", index_path.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn knowledge_folder_rename(
    base_id: Option<String>,
    from: String,
    to: String,
) -> Result<(), String> {
    let from_clean = from.trim().trim_matches('/').to_string();
    let to_clean = to.trim().trim_matches('/').to_string();
    if from_clean.is_empty() || to_clean.is_empty() {
        return Err("both folder names are required".to_string());
    }
    if from_clean == to_clean {
        return Ok(());
    }
    let source = resolve_knowledge_write_path(&from_clean, base_id.as_deref())?;
    if !source.is_dir() {
        return Err(format!("folder not found: {from_clean}"));
    }
    let dest = resolve_knowledge_write_path(&to_clean, base_id.as_deref())?;
    if dest.exists() {
        return Err(format!("folder already exists: {to_clean}"));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("failed to prepare {}: {err}", parent.display()))?;
    }
    std::fs::rename(&source, &dest)
        .map_err(|err| format!("failed to rename folder {}: {err}", source.display()))
}

#[tauri::command]
pub fn knowledge_folder_delete(base_id: Option<String>, path: String) -> Result<(), String> {
    let cleaned = path.trim().trim_matches('/').to_string();
    if cleaned.is_empty() {
        return Err("folder name is required".to_string());
    }
    let target = resolve_knowledge_write_path(&cleaned, base_id.as_deref())?;
    if !target.is_dir() {
        return Err(format!("folder not found: {cleaned}"));
    }
    std::fs::remove_dir_all(&target)
        .map_err(|err| format!("failed to remove folder {}: {err}", target.display()))
}

#[tauri::command]
pub fn knowledge_delete_doc(base_id: Option<String>, path: String) -> Result<(), String> {
    let cleaned = path.trim().trim_matches('/').to_string();
    if cleaned.is_empty() {
        return Err("file path is required".to_string());
    }
    let target = resolve_knowledge_write_path(&cleaned, base_id.as_deref())?;
    if !target.is_file() {
        return Err(format!("file not found: {cleaned}"));
    }
    std::fs::remove_file(&target)
        .map_err(|err| format!("failed to delete {}: {err}", target.display()))
}

#[tauri::command]
pub fn knowledge_list(base_id: Option<String>) -> Result<Vec<KnowledgeNode>, String> {
    let root = resolve_knowledge_root(base_id.as_deref())?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut nodes = Vec::new();
    list_knowledge_dir(&root, &root, &mut nodes)?;
    nodes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(nodes)
}

#[tauri::command]
pub fn knowledge_read(path: String, base_id: Option<String>) -> Result<String, String> {
    let target = resolve_knowledge_path(&path, base_id.as_deref())?;
    std::fs::read_to_string(&target)
        .map_err(|err| format!("failed to read knowledge doc {}: {err}", target.display()))
}

#[tauri::command]
pub fn knowledge_write(
    path: String,
    content: String,
    base_id: Option<String>,
) -> Result<(), String> {
    let target = resolve_knowledge_write_path(&path, base_id.as_deref())?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create knowledge directory: {err}"))?;
    }
    std::fs::write(&target, content)
        .map_err(|err| format!("failed to write knowledge doc {}: {err}", target.display()))
}

/// One level of children for `dir`, relative to the workspace `root`. Folders are
/// returned with empty `children` (the frontend resolves them lazily on expand), so
/// there is no global file cap and no walk depth — an oversized subtree like `.venv`
/// is a single collapsed node that costs one `read_dir`, never starving its siblings.
fn list_dir_shallow(
    root: &Path,
    dir: &Path,
    config: &FileTreeConfig,
) -> Result<Vec<FileTreeNode>, String> {
    let mut entries = std::fs::read_dir(dir)
        .map_err(|err| format!("failed to list {}: {err}", dir.display()))?
        .filter_map(|entry| entry.ok())
        .collect::<Vec<_>>();

    entries.sort_by_key(|entry| {
        let is_file = entry.file_type().map(|kind| kind.is_file()).unwrap_or(true);
        (is_file, entry.file_name().to_string_lossy().to_lowercase())
    });

    let mut nodes = Vec::new();
    for entry in entries {
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        if file_type.is_dir() {
            if ignored_dir_path(root, &path, &name, config) {
                continue;
            }
            nodes.push(FileTreeNode::Folder {
                name,
                children: Vec::new(),
            });
            continue;
        }
        if !file_type.is_file() || !looks_textual_with_config(&path, config) {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        nodes.push(FileTreeNode::File {
            name,
            path: relative,
        });
    }
    Ok(nodes)
}

fn list_dir(
    root: &Path,
    dir: &Path,
    depth: usize,
    count: &mut usize,
    config: &FileTreeConfig,
) -> Result<Vec<FileTreeNode>, String> {
    if depth > 6 || *count > 2500 {
        return Ok(Vec::new());
    }
    let mut entries = std::fs::read_dir(dir)
        .map_err(|err| format!("failed to list {}: {err}", dir.display()))?
        .filter_map(|entry| entry.ok())
        .collect::<Vec<_>>();

    entries.sort_by_key(|entry| {
        let is_file = entry.file_type().map(|kind| kind.is_file()).unwrap_or(true);
        (is_file, entry.file_name().to_string_lossy().to_lowercase())
    });

    let mut nodes = Vec::new();
    for entry in entries {
        if *count > 2500 {
            break;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        if file_type.is_dir() {
            if ignored_dir_path(root, &path, &name, config) {
                continue;
            }
            let children = list_dir(root, &path, depth + 1, count, config)?;
            nodes.push(FileTreeNode::Folder { name, children });
            continue;
        }
        if !file_type.is_file() || !looks_textual_with_config(&path, config) {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        *count += 1;
        nodes.push(FileTreeNode::File {
            name,
            path: relative,
        });
    }
    Ok(nodes)
}

fn load_file_tree_config(root: &Path) -> FileTreeConfig {
    let path = root.join(".polypore").join("file-tree.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return FileTreeConfig::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn always_ignored_dir_name(name: &str) -> bool {
    name == ".git"
}

fn built_in_ignored_dir_name(name: &str) -> bool {
    matches!(
        name,
        ".idea"
            | ".DS_Store"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".vite"
            | ".tauri"
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".mypy_cache"
            | ".pytest_cache"
            | ".ruff_cache"
    )
}

fn ignored_watch_path(root: &Path, path: &Path) -> bool {
    let config = load_file_tree_config(root);
    ignored_watch_path_with_config(root, path, &config)
}

fn ignored_watch_path_with_config(root: &Path, path: &Path, config: &FileTreeConfig) -> bool {
    let mut relative_so_far = PathBuf::new();
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .any(|component| match component {
            std::path::Component::Normal(name) => {
                let name = name.to_string_lossy();
                relative_so_far.push(name.as_ref());
                ignored_dir_path_by_relative(&relative_so_far, &name, config)
            }
            _ => false,
        })
}

fn ignored_dir_path(root: &Path, path: &Path, name: &str, config: &FileTreeConfig) -> bool {
    let relative = path.strip_prefix(root).unwrap_or(path);
    ignored_dir_path_by_relative(relative, name, config)
}

fn ignored_dir_path_by_relative(relative: &Path, name: &str, config: &FileTreeConfig) -> bool {
    if always_ignored_dir_name(name) {
        return true;
    }
    if config.dir_matches(&config.include_dirs, relative, name) {
        return false;
    }
    built_in_ignored_dir_name(name)
        || built_in_ignored_dir_path(relative)
        || config.dir_matches(&config.exclude_dirs, relative, name)
}

fn built_in_ignored_dir_path(relative: &Path) -> bool {
    let mut components = relative
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(name) => name.to_str(),
            _ => None,
        });
    matches!(components.next(), Some(".claude")) && matches!(components.next(), Some("worktrees"))
}

fn looks_textual(path: &Path) -> bool {
    !matches!(
        path.extension().and_then(|ext| ext.to_str()).unwrap_or(""),
        "bmp"
            | "gif"
            | "ico"
            | "jpeg"
            | "jpg"
            | "pdf"
            | "png"
            | "rmeta"
            | "rlib"
            | "so"
            | "sqlite"
            | "webp"
            | "zip"
    )
}

fn looks_textual_with_config(path: &Path, config: &FileTreeConfig) -> bool {
    let extension = normalized_extension(path);
    if !extension.is_empty() {
        if config.extension_matches(&config.text_extensions, &extension) {
            return true;
        }
        if config.extension_matches(&config.binary_extensions, &extension) {
            return false;
        }
    }
    looks_textual(path)
}

fn normalized_extension(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
}

impl FileTreeConfig {
    fn dir_matches(&self, patterns: &[String], relative: &Path, name: &str) -> bool {
        let relative = relative.to_string_lossy().replace('\\', "/");
        patterns
            .iter()
            .any(|pattern| dir_pattern_matches(pattern, &relative, name))
    }

    fn extension_matches(&self, patterns: &[String], extension: &str) -> bool {
        patterns.iter().any(|pattern| {
            pattern
                .trim()
                .trim_start_matches('.')
                .eq_ignore_ascii_case(extension)
        })
    }
}

fn dir_pattern_matches(pattern: &str, relative: &str, name: &str) -> bool {
    let normalized = pattern
        .trim()
        .trim_matches('/')
        .trim_start_matches("./")
        .replace('\\', "/");
    if normalized.is_empty() {
        return false;
    }
    normalized == name || normalized == relative
}

fn list_knowledge_dir(
    root: &Path,
    dir: &Path,
    nodes: &mut Vec<KnowledgeNode>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(dir)
        .map_err(|err| format!("failed to list knowledge dir {}: {err}", dir.display()))?
        .filter_map(|entry| entry.ok())
    {
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            nodes.push(KnowledgeNode {
                kind: "folder",
                path: relative,
            });
            list_knowledge_dir(root, &path, nodes)?;
            continue;
        }
        if !file_type.is_file() || !looks_textual(&path) {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        nodes.push(KnowledgeNode {
            kind: "doc",
            path: relative,
        });
    }
    Ok(())
}

fn resolve_workspace_root() -> Result<PathBuf, String> {
    project_context::active_project_root()
}

fn resolve_workspace_path(path: &str) -> Result<PathBuf, String> {
    let cwd = resolve_workspace_root()?;
    resolve_existing_or_read_path(&cwd, path, "path must stay under the active workspace")
}

fn resolve_workspace_write_path(path: &str) -> Result<PathBuf, String> {
    let cwd = resolve_workspace_root()?;
    resolve_write_path(&cwd, path, "path must stay under the active workspace")
}

fn documents_config_dir() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("POLYPORE_CONFIG_DIR") {
        return Ok(PathBuf::from(path).join("documents"));
    }
    if cfg!(windows) {
        std::env::var("APPDATA")
            .map(|base| PathBuf::from(base).join("polypore").join("documents"))
            .map_err(|_| "APPDATA is not set".to_string())
    } else {
        std::env::var("HOME")
            .map(|base| {
                PathBuf::from(base)
                    .join(".config")
                    .join("polypore")
                    .join("documents")
            })
            .map_err(|_| "HOME is not set".to_string())
    }
}

fn knowledge_registry_path() -> Result<PathBuf, String> {
    Ok(documents_config_dir()?.join("knowledge-bases.json"))
}

fn default_knowledge_base_path(name: &str, scope: &str) -> Result<PathBuf, String> {
    let scope = checked_scope(scope)?;
    let folder = file_slug(name);
    if scope == "project" {
        Ok(resolve_workspace_root()?.join(".knowledge").join(folder))
    } else {
        Ok(documents_config_dir()?.join("bases").join(folder))
    }
}

fn expand_user_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed == "~" {
        return std::env::var("HOME")
            .map(PathBuf::from)
            .map_err(|_| "HOME is not set".to_string());
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return std::env::var("HOME")
            .map(|home| PathBuf::from(home).join(rest))
            .map_err(|_| "HOME is not set".to_string());
    }
    Ok(PathBuf::from(trimmed))
}

fn read_knowledge_registry() -> Result<Vec<KnowledgeBase>, String> {
    let path = knowledge_registry_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|err| format!("failed to read documents bases {}: {err}", path.display()))?;
    serde_json::from_str(&raw).map_err(|err| format!("invalid documents base metadata: {err}"))
}

fn write_knowledge_registry(bases: &[KnowledgeBase]) -> Result<(), String> {
    let path = knowledge_registry_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| {
            format!(
                "failed to create documents config {}: {err}",
                parent.display()
            )
        })?;
    }
    let raw = serde_json::to_string_pretty(bases)
        .map_err(|err| format!("failed to encode documents bases: {err}"))?;
    std::fs::write(&path, format!("{raw}\n"))
        .map_err(|err| format!("failed to write documents bases {}: {err}", path.display()))
}

fn visible_knowledge_bases() -> Result<Vec<KnowledgeBase>, String> {
    let project_root = project_root_display()?;
    let mut bases = read_knowledge_registry()?
        .into_iter()
        .filter(|base| {
            base.scope == "global"
                || (base.scope == "project" && base.project_root.as_deref() == Some(&project_root))
        })
        .filter(|base| Path::new(&base.root).exists())
        .collect::<Vec<_>>();

    let default_root = resolve_workspace_root()?.join(".knowledge");
    let has_configured_base_under_default = bases
        .iter()
        .any(|base| folder_starts_with(Path::new(&base.root), &default_root));
    if default_root.exists()
        && !bases
            .iter()
            .any(|base| same_folder(Path::new(&base.root), &default_root))
        && !has_configured_base_under_default
    {
        bases.push(KnowledgeBase {
            id: format!("project-default-{}", file_slug(&project_root)),
            name: "project documents".to_string(),
            root: folder_display(&default_root),
            scope: "project".to_string(),
            suggested_scope: "project".to_string(),
            project_root: Some(project_root),
        });
    }

    bases.sort_by(|left, right| {
        left.scope
            .cmp(&right.scope)
            .then(left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(bases)
}

fn configure_knowledge_folder(path: PathBuf) -> Result<KnowledgeBase, String> {
    if !path.is_dir() {
        return Err("documents folder must be a directory".to_string());
    }
    let root = path.canonicalize().map_err(|err| {
        format!(
            "failed to resolve documents folder {}: {err}",
            path.display()
        )
    })?;
    let registry = read_knowledge_registry()?;
    if let Some(existing) = registry
        .into_iter()
        .find(|base| same_folder(Path::new(&base.root), &root))
    {
        return Ok(existing);
    }
    let suggested_scope = scope_for_folder(&root)?;
    let name = root
        .file_name()
        .and_then(|item| item.to_str())
        .filter(|item| !item.trim().is_empty())
        .unwrap_or("documents")
        .to_string();
    let base = KnowledgeBase {
        id: knowledge_base_id(&name),
        name,
        root: folder_display(&root),
        scope: suggested_scope.clone(),
        suggested_scope: suggested_scope.clone(),
        project_root: (suggested_scope == "project")
            .then(project_root_display)
            .transpose()?,
    };
    upsert_knowledge_base(base)
}

fn upsert_knowledge_base(base: KnowledgeBase) -> Result<KnowledgeBase, String> {
    let mut bases = read_knowledge_registry()?;
    bases.retain(|item| {
        item.id != base.id && !same_folder(Path::new(&item.root), Path::new(&base.root))
    });
    bases.push(base.clone());
    write_knowledge_registry(&bases)?;
    Ok(base)
}

fn resolve_knowledge_root(base_id: Option<&str>) -> Result<PathBuf, String> {
    let Some(base_id) = base_id.filter(|id| !id.trim().is_empty()) else {
        return Ok(resolve_workspace_root()?.join(".knowledge"));
    };
    let base = visible_knowledge_bases()?
        .into_iter()
        .find(|base| base.id == base_id)
        .ok_or_else(|| format!("knowledge base not found: {base_id}"))?;
    Ok(PathBuf::from(base.root))
}

fn write_knowledge_preset(root: &Path, name: &str, preset: &str) -> Result<(), String> {
    let files = match preset {
        "basic" => vec![
            ("README.md", format!("# {name}\n\nMemory base.\n")),
            (
                "CLAUDE.md",
                "# Wiki workflow\n\nKeep raw source material in `raw/` — never edit those. Maintain durable notes in `wiki/` and link claims back to sources.\n".to_string(),
            ),
            ("raw/.keep", String::new()),
            ("wiki/index.md", "# Wiki\n\n".to_string()),
        ],
        "blank" => vec![("index.md", format!("# {name}\n\n"))],
        _ => return Err(format!("unsupported memory preset: {preset}")),
    };
    for (relative, content) in files {
        let target = root.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|err| {
                format!("failed to create preset folder {}: {err}", parent.display())
            })?;
        }
        if !target.exists() {
            std::fs::write(&target, content).map_err(|err| {
                format!("failed to write preset file {}: {err}", target.display())
            })?;
        }
    }
    Ok(())
}

fn scope_for_folder(path: &Path) -> Result<String, String> {
    let root = resolve_workspace_root()?
        .canonicalize()
        .unwrap_or(resolve_workspace_root()?);
    let folder = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    Ok(if folder.starts_with(&root) {
        "project".to_string()
    } else {
        "global".to_string()
    })
}

fn checked_scope(scope: &str) -> Result<&str, String> {
    match scope {
        "global" | "project" => Ok(scope),
        _ => Err(format!("unsupported knowledge base scope: {scope}")),
    }
}

fn project_root_display() -> Result<String, String> {
    Ok(folder_display(&resolve_workspace_root()?))
}

fn folder_display(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string()
}

fn same_folder(left: &Path, right: &Path) -> bool {
    left.canonicalize().unwrap_or_else(|_| left.to_path_buf())
        == right.canonicalize().unwrap_or_else(|_| right.to_path_buf())
}

fn folder_starts_with(path: &Path, root: &Path) -> bool {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .starts_with(root.canonicalize().unwrap_or_else(|_| root.to_path_buf()))
}

fn unique_base_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    for suffix in 2..1000 {
        let candidate = PathBuf::from(format!("{}-{suffix}", path.display()));
        if !candidate.exists() {
            return candidate;
        }
    }
    path.join(format!("base-{}", timestamp_ms()))
}

fn knowledge_base_id(name: &str) -> String {
    format!("{}-{}", file_slug(name), timestamp_ms())
}

fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn file_slug(raw: &str) -> String {
    let slug = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "documents".to_string()
    } else {
        trimmed.chars().take(64).collect()
    }
}

fn resolve_existing_or_read_path(
    root: &Path,
    path: &str,
    message: &str,
) -> Result<PathBuf, String> {
    let cwd = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let requested = Path::new(path);
    if requested.is_absolute()
        || requested
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(message.to_string());
    }
    let target = cwd.join(path);
    let normalized = target
        .canonicalize()
        .unwrap_or(target)
        .components()
        .collect::<PathBuf>();
    if !normalized.starts_with(&cwd) {
        return Err(message.to_string());
    }
    Ok(normalized)
}

fn resolve_knowledge_path(path: &str, base_id: Option<&str>) -> Result<PathBuf, String> {
    let root = resolve_knowledge_root(base_id)?;
    resolve_existing_or_read_path(
        &root,
        path,
        "knowledge path must stay inside its documents base",
    )
}

fn resolve_knowledge_write_path(path: &str, base_id: Option<&str>) -> Result<PathBuf, String> {
    let root = resolve_knowledge_root(base_id)?;
    resolve_write_path(
        &root,
        path,
        "knowledge path must stay inside its documents base",
    )
}

fn resolve_write_path(root: &Path, path: &str, message: &str) -> Result<PathBuf, String> {
    let base = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let requested = Path::new(path);
    if requested.is_absolute()
        || requested
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(message.to_string());
    }
    let target = base.join(path);
    if std::fs::symlink_metadata(&target)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(message.to_string());
    }
    if target.exists() {
        let normalized = target
            .canonicalize()
            .map_err(|err| format!("failed to resolve {}: {err}", target.display()))?;
        if !normalized.starts_with(&base) {
            return Err(message.to_string());
        }
        return Ok(normalized);
    }

    let mut ancestor = target.parent();
    while let Some(path) = ancestor {
        if path.exists() {
            let normalized = path
                .canonicalize()
                .map_err(|err| format!("failed to resolve {}: {err}", path.display()))?;
            if !normalized.starts_with(&base) {
                return Err(message.to_string());
            }
            return Ok(target.components().collect::<PathBuf>());
        }
        ancestor = path.parent();
    }
    Err(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("polypore-{name}-{unique}"));
        std::fs::create_dir_all(&root).expect("create temp root");
        root
    }

    #[test]
    fn resolve_write_path_allows_new_nested_files_inside_root() {
        let root = temp_root("write-inside");

        let target = resolve_write_path(&root, "notes/new.md", "outside").expect("inside path");

        assert!(target.starts_with(root.canonicalize().expect("canonical root")));
        assert!(target.ends_with("notes/new.md"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_write_path_rejects_new_files_below_symlinked_parent() {
        let root = temp_root("write-symlink-root");
        let outside = temp_root("write-symlink-outside");
        std::os::unix::fs::symlink(&outside, root.join("linked")).expect("symlink");

        let result = resolve_write_path(&root, "linked/new.md", "outside");

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "outside");
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_write_path_rejects_existing_symlink_leaf() {
        let root = temp_root("write-symlink-leaf-root");
        let outside = temp_root("write-symlink-leaf-outside");
        std::fs::write(outside.join("target.md"), "outside").expect("outside file");
        std::os::unix::fs::symlink(outside.join("target.md"), root.join("note.md"))
            .expect("symlink");

        let result = resolve_write_path(&root, "note.md", "outside");

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "outside");
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn ignored_watch_path_rejects_workspace_build_artifacts() {
        let root = Path::new("/workspace");

        assert!(ignored_watch_path(
            root,
            &root.join("src-tauri/target/debug/incremental/dep-graph.part.bin"),
        ));
        assert!(ignored_watch_path(root, &root.join(".git/index.lock")));
        assert!(ignored_watch_path(
            root,
            &root.join(".claude/worktrees/agent-a39821ffefee81420/src/App.tsx"),
        ));
        assert!(!ignored_watch_path(
            root,
            &root.join(".claude/orchestration/agent-rail-contract.md"),
        ));
    }

    #[test]
    fn file_tree_config_include_dirs_override_builtin_build_artifacts() {
        let root = Path::new("/workspace");
        let config = FileTreeConfig {
            include_dirs: vec!["src-tauri/target".to_string()],
            ..FileTreeConfig::default()
        };

        assert!(!ignored_watch_path_with_config(
            root,
            &root.join("src-tauri/target/debug/incremental/dep-graph.part.bin"),
            &config,
        ));
        assert!(ignored_watch_path_with_config(
            root,
            &root.join("target/debug/incremental/dep-graph.part.bin"),
            &config,
        ));
    }

    #[test]
    fn file_tree_config_exclude_dirs_add_project_specific_generated_paths() {
        let root = Path::new("/workspace");
        let config = FileTreeConfig {
            exclude_dirs: vec!["generated".to_string()],
            ..FileTreeConfig::default()
        };

        assert!(ignored_watch_path_with_config(
            root,
            &root.join("src/generated/schema.rs"),
            &config,
        ));
        assert!(!ignored_watch_path_with_config(
            root,
            &root.join("src/manual/schema.rs"),
            &config,
        ));
    }

    #[test]
    fn file_tree_config_overrides_textual_extension_heuristics() {
        let config = FileTreeConfig {
            text_extensions: vec!["rlib".to_string()],
            binary_extensions: vec!["foo".to_string()],
            ..FileTreeConfig::default()
        };

        assert!(looks_textual_with_config(
            Path::new("libcustom.rlib"),
            &config
        ));
        assert!(!looks_textual_with_config(Path::new("module.foo"), &config));
    }

    #[test]
    fn looks_textual_keeps_lockfiles_visible() {
        assert!(looks_textual(Path::new("Cargo.lock")));
        assert!(looks_textual(Path::new("package-lock.json")));
        assert!(looks_textual(Path::new("poetry.lock")));
    }

    #[test]
    fn ignored_watch_path_keeps_regular_workspace_source_paths() {
        let root = Path::new("/workspace");

        assert!(!ignored_watch_path(root, &root.join("src/App.tsx")));
        assert!(!ignored_watch_path(
            root,
            &root.join("src-tauri/src/fs_watch.rs")
        ));
    }

    #[test]
    fn list_workspace_files_enumerates_every_file_uncapped() {
        if std::process::Command::new("rg")
            .arg("--version")
            .output()
            .is_err()
        {
            return; // ripgrep is the index backend; nothing to assert without it
        }
        let root = temp_root("index-files");
        std::fs::create_dir_all(root.join("src/deep/nested")).expect("nested dirs");
        std::fs::write(root.join("README.md"), "x").expect("readme");
        std::fs::write(root.join("src/app.ts"), "x").expect("app");
        std::fs::write(root.join("src/deep/nested/leaf.rs"), "x").expect("leaf");

        let files = list_workspace_files(&root).expect("index");

        assert!(files.contains(&"README.md".to_string()));
        assert!(files.contains(&"src/app.ts".to_string()));
        // the deeply nested file proves there is no depth/count cap on the index
        assert!(
            files.contains(&"src/deep/nested/leaf.rs".to_string()),
            "index dropped a deeply nested file: {files:?}",
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn list_dir_shallow_returns_one_level_folders_first_without_recursing() {
        let root = temp_root("shallow-list");
        // a virtualenv with contents that must NOT appear at all
        std::fs::create_dir_all(root.join(".venv/lib")).expect("venv");
        std::fs::write(root.join(".venv/pyvenv.cfg"), "home = /x").expect("venv file");
        // real source folders, each with a child so we can prove non-recursion
        std::fs::create_dir_all(root.join("alembic")).expect("alembic");
        std::fs::write(root.join("alembic/env.py"), "x").expect("alembic file");
        std::fs::create_dir_all(root.join("frontend")).expect("frontend");
        std::fs::write(root.join("frontend/app.tsx"), "x").expect("frontend file");
        // top-level files
        std::fs::write(root.join("README.md"), "x").expect("readme");
        std::fs::write(root.join("zzz.txt"), "x").expect("zzz");

        let config = FileTreeConfig::default();
        let nodes = list_dir_shallow(&root, &root, &config).expect("shallow list");

        // folders first (alpha), then files (alpha); .venv excluded entirely
        let summary: Vec<String> = nodes
            .iter()
            .map(|node| match node {
                FileTreeNode::Folder { name, children } => {
                    format!("dir:{name}:{}", children.len())
                }
                FileTreeNode::File { name, .. } => format!("file:{name}"),
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                "dir:alembic:0".to_string(),
                "dir:frontend:0".to_string(),
                "file:README.md".to_string(),
                "file:zzz.txt".to_string(),
            ],
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ignored_dir_path_excludes_python_virtualenv_and_caches() {
        let root = Path::new("/workspace");
        let config = FileTreeConfig::default();

        for dir in [
            ".venv",
            "venv",
            "__pycache__",
            ".mypy_cache",
            ".pytest_cache",
            ".ruff_cache",
        ] {
            assert!(
                ignored_dir_path(root, &root.join(dir), dir, &config),
                "{dir} should be ignored by default",
            );
        }
        // a real source dir with a similar name must stay visible
        assert!(!ignored_dir_path(
            root,
            &root.join("environments"),
            "environments",
            &config,
        ));
    }
}
