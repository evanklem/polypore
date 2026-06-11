use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use crate::agent;
use crate::project_context;

/* the launcher needs three things from Rust:
- a native folder picker (so users can navigate to any directory on disk)
- a persistent recent-projects list (carried across boots in the same
  sqlite db the rest of the shell uses)
- a catalog of starter templates + a scaffold runner that drops a real
  project into a directory of the user's choosing.

it also needs an agent-binary probe so the launcher can tell the user
whether `claude` / `codex` will actually answer once they enter the IDE. */

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub last_opened: i64,
    pub exists: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct ProjectMeta {
    pub path: String,
    pub name: String,
    pub created: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct ProjectStatus {
    pub path: String,
    pub name: String,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub dirty: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRunResult {
    pub action: String,
    pub command: Vec<String>,
    pub exit_code: Option<i32>,
    pub output: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub mode: String,
    pub file: Option<String>,
    pub base_ref: Option<String>,
    pub target_ref: Option<String>,
    pub changed_files: Vec<String>,
    pub diff: String,
    pub exit_code: Option<i32>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeResult {
    pub id: String,
    pub path: String,
    pub branch: String,
    pub forked_from_event_id: String,
    pub output: String,
    pub exit_code: Option<i32>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRevertResult {
    pub files: Vec<String>,
    pub output: String,
    pub exit_code: Option<i32>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub id: String,
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub is_current: bool,
    pub is_locked: bool,
    pub is_detached: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct ProjectTemplate {
    pub id: &'static str,
    pub label: &'static str,
    pub category: &'static str,
    pub language: &'static str,
    pub summary: &'static str,
    /* the scaffold command runs in the project's parent directory with the
    project name available as `{name}`. `external` means we don't ship
    scaffolding — we delegate to the upstream tool's official initializer. */
    pub command: &'static str,
    pub requires: &'static str,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct AgentBinaryStatus {
    pub agent: String,
    pub available: bool,
    pub path: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct ScaffoldOutcome {
    pub ok: bool,
    pub log: String,
    pub project: ProjectMeta,
}

/* the template catalog is language-agnostic on purpose. each entry maps to
a real upstream initializer so we never have to maintain code-generators
ourselves — we just run the tool the community already uses. */
pub fn templates() -> &'static [ProjectTemplate] {
    static TEMPLATES: &[ProjectTemplate] = &[
        ProjectTemplate {
            id: "blank",
            label: "blank folder",
            category: "general",
            language: "any",
            summary: "empty directory with a .gitignore stub. start from scratch.",
            command: "blank",
            requires: "",
        },
        ProjectTemplate {
            id: "vite-react-ts",
            label: "vite + react + typescript",
            category: "web frontend",
            language: "typescript",
            summary: "vite scaffold, react 18, typescript strict.",
            command: "npm create vite@latest {name} -- --template react-ts",
            requires: "npm",
        },
        ProjectTemplate {
            id: "vite-vue-ts",
            label: "vite + vue 3 + typescript",
            category: "web frontend",
            language: "typescript",
            summary: "vue 3 SFCs with vite + ts.",
            command: "npm create vite@latest {name} -- --template vue-ts",
            requires: "npm",
        },
        ProjectTemplate {
            id: "vite-svelte-ts",
            label: "vite + svelte + typescript",
            category: "web frontend",
            language: "typescript",
            summary: "svelte 5 + vite + ts.",
            command: "npm create vite@latest {name} -- --template svelte-ts",
            requires: "npm",
        },
        ProjectTemplate {
            id: "vite-solid-ts",
            label: "vite + solid + typescript",
            category: "web frontend",
            language: "typescript",
            summary: "solidjs + vite + ts.",
            command: "npm create vite@latest {name} -- --template solid-ts",
            requires: "npm",
        },
        ProjectTemplate {
            id: "vite-vanilla-ts",
            label: "vite vanilla typescript",
            category: "web frontend",
            language: "typescript",
            summary: "vite + ts with no framework.",
            command: "npm create vite@latest {name} -- --template vanilla-ts",
            requires: "npm",
        },
        ProjectTemplate {
            id: "nextjs",
            label: "next.js (app router)",
            category: "web fullstack",
            language: "typescript",
            summary: "react server components, app router, ts.",
            command: "npx create-next-app@latest {name} --yes --ts --app --no-tailwind --no-src-dir",
            requires: "npx",
        },
        ProjectTemplate {
            id: "nuxt",
            label: "nuxt 3",
            category: "web fullstack",
            language: "typescript",
            summary: "vue meta-framework with file-based routing.",
            command: "npx nuxi@latest init {name}",
            requires: "npx",
        },
        ProjectTemplate {
            id: "sveltekit",
            label: "sveltekit",
            category: "web fullstack",
            language: "typescript",
            summary: "svelte 5 + kit, ts, vitest.",
            command: "npx sv create {name} --template minimal --types ts --no-add-ons",
            requires: "npx",
        },
        ProjectTemplate {
            id: "astro",
            label: "astro",
            category: "web fullstack",
            language: "typescript",
            summary: "islands architecture, ts.",
            command: "npm create astro@latest {name} -- --template minimal --typescript strict --install --no-git --yes",
            requires: "npm",
        },
        ProjectTemplate {
            id: "remix",
            label: "remix (react router 7)",
            category: "web fullstack",
            language: "typescript",
            summary: "remix react-router meta-framework.",
            command: "npx create-react-router@latest {name} --no-git-init",
            requires: "npx",
        },
        ProjectTemplate {
            id: "node-express",
            label: "node + express",
            category: "web backend",
            language: "typescript",
            summary: "minimal express ts api scaffold.",
            command: "blank-node-express",
            requires: "npm",
        },
        ProjectTemplate {
            id: "node-fastify",
            label: "node + fastify",
            category: "web backend",
            language: "typescript",
            summary: "fastify ts api scaffold.",
            command: "blank-node-fastify",
            requires: "npm",
        },
        ProjectTemplate {
            id: "node-hono",
            label: "hono",
            category: "web backend",
            language: "typescript",
            summary: "runtime-agnostic web framework (node / bun / deno).",
            command: "npm create hono@latest {name} -- --template nodejs --install --pm npm",
            requires: "npm",
        },
        ProjectTemplate {
            id: "bun-elysia",
            label: "bun + elysia",
            category: "web backend",
            language: "typescript",
            summary: "elysia on bun runtime.",
            command: "bun create elysia {name}",
            requires: "bun",
        },
        ProjectTemplate {
            id: "deno-fresh",
            label: "deno fresh",
            category: "web fullstack",
            language: "typescript",
            summary: "deno fresh edge-rendered app.",
            command: "deno run -A -r https://fresh.deno.dev {name}",
            requires: "deno",
        },
        ProjectTemplate {
            id: "python-uv",
            label: "python (uv)",
            category: "python",
            language: "python",
            summary: "modern python project managed by uv.",
            command: "uv init {name}",
            requires: "uv",
        },
        ProjectTemplate {
            id: "python-poetry",
            label: "python (poetry)",
            category: "python",
            language: "python",
            summary: "poetry-managed python package.",
            command: "poetry new {name}",
            requires: "poetry",
        },
        ProjectTemplate {
            id: "python-fastapi",
            label: "python + fastapi",
            category: "python",
            language: "python",
            summary: "uv + fastapi + uvicorn scaffold.",
            command: "blank-python-fastapi",
            requires: "uv",
        },
        ProjectTemplate {
            id: "python-flask",
            label: "python + flask",
            category: "python",
            language: "python",
            summary: "minimal flask app under uv.",
            command: "blank-python-flask",
            requires: "uv",
        },
        ProjectTemplate {
            id: "python-django",
            label: "python + django",
            category: "python",
            language: "python",
            summary: "django startproject.",
            command: "uvx django-admin startproject {name}",
            requires: "uvx",
        },
        ProjectTemplate {
            id: "python-jupyter",
            label: "python + jupyter",
            category: "python",
            language: "python",
            summary: "uv project pre-wired for jupyter notebooks.",
            command: "blank-python-jupyter",
            requires: "uv",
        },
        ProjectTemplate {
            id: "rust-bin",
            label: "rust (cargo bin)",
            category: "rust",
            language: "rust",
            summary: "cargo new --bin",
            command: "cargo new {name} --bin",
            requires: "cargo",
        },
        ProjectTemplate {
            id: "rust-lib",
            label: "rust (cargo lib)",
            category: "rust",
            language: "rust",
            summary: "cargo new --lib",
            command: "cargo new {name} --lib",
            requires: "cargo",
        },
        ProjectTemplate {
            id: "rust-axum",
            label: "rust + axum",
            category: "rust",
            language: "rust",
            summary: "axum web server scaffold.",
            command: "blank-rust-axum",
            requires: "cargo",
        },
        ProjectTemplate {
            id: "rust-tauri",
            label: "rust + tauri 2",
            category: "rust",
            language: "rust",
            summary: "create-tauri-app, vanilla template.",
            command: "npm create tauri-app@latest {name} -- --template vanilla --yes",
            requires: "npm",
        },
        ProjectTemplate {
            id: "rust-leptos",
            label: "rust + leptos",
            category: "rust",
            language: "rust",
            summary: "leptos fullstack web app via cargo-leptos.",
            command: "cargo leptos new --git https://github.com/leptos-rs/start-axum {name}",
            requires: "cargo-leptos",
        },
        ProjectTemplate {
            id: "go-mod",
            label: "go module",
            category: "go",
            language: "go",
            summary: "go mod init + hello main.go.",
            command: "blank-go-mod",
            requires: "go",
        },
        ProjectTemplate {
            id: "go-gin",
            label: "go + gin",
            category: "go",
            language: "go",
            summary: "gin web server scaffold.",
            command: "blank-go-gin",
            requires: "go",
        },
        ProjectTemplate {
            id: "go-echo",
            label: "go + echo",
            category: "go",
            language: "go",
            summary: "echo web server scaffold.",
            command: "blank-go-echo",
            requires: "go",
        },
        ProjectTemplate {
            id: "java-gradle",
            label: "java (gradle)",
            category: "jvm",
            language: "java",
            summary: "gradle init application.",
            command: "gradle init --type java-application --dsl groovy --project-name {name} --package app --no-incubating --no-split-project",
            requires: "gradle",
        },
        ProjectTemplate {
            id: "kotlin-gradle",
            label: "kotlin (gradle)",
            category: "jvm",
            language: "kotlin",
            summary: "gradle init kotlin app.",
            command: "gradle init --type kotlin-application --dsl kotlin --project-name {name} --package app --no-incubating --no-split-project",
            requires: "gradle",
        },
        ProjectTemplate {
            id: "scala-sbt",
            label: "scala (sbt)",
            category: "jvm",
            language: "scala",
            summary: "sbt new with scala/scala3.g8.",
            command: "sbt new scala/scala3.g8 --name={name}",
            requires: "sbt",
        },
        ProjectTemplate {
            id: "clojure-deps",
            label: "clojure (deps.edn)",
            category: "jvm",
            language: "clojure",
            summary: "deps.edn project skeleton.",
            command: "blank-clojure-deps",
            requires: "clojure",
        },
        ProjectTemplate {
            id: "swift-pm",
            label: "swift package",
            category: "native",
            language: "swift",
            summary: "swift package init.",
            command: "blank-swift-pm",
            requires: "swift",
        },
        ProjectTemplate {
            id: "c-cmake",
            label: "c (cmake)",
            category: "native",
            language: "c",
            summary: "minimal cmake + main.c.",
            command: "blank-c-cmake",
            requires: "cmake",
        },
        ProjectTemplate {
            id: "cpp-cmake",
            label: "c++ (cmake)",
            category: "native",
            language: "c++",
            summary: "minimal cmake + main.cpp.",
            command: "blank-cpp-cmake",
            requires: "cmake",
        },
        ProjectTemplate {
            id: "zig",
            label: "zig",
            category: "native",
            language: "zig",
            summary: "zig init exe.",
            command: "blank-zig",
            requires: "zig",
        },
        ProjectTemplate {
            id: "elixir-phoenix",
            label: "elixir + phoenix",
            category: "beam",
            language: "elixir",
            summary: "phoenix web app generator.",
            command: "mix phx.new {name} --install",
            requires: "mix",
        },
        ProjectTemplate {
            id: "erlang-rebar3",
            label: "erlang (rebar3)",
            category: "beam",
            language: "erlang",
            summary: "rebar3 new release.",
            command: "rebar3 new release {name}",
            requires: "rebar3",
        },
        ProjectTemplate {
            id: "ruby-rails",
            label: "ruby on rails",
            category: "ruby",
            language: "ruby",
            summary: "rails new with minimal flags.",
            command: "rails new {name} --skip-bundle",
            requires: "rails",
        },
        ProjectTemplate {
            id: "ruby-sinatra",
            label: "ruby + sinatra",
            category: "ruby",
            language: "ruby",
            summary: "minimal sinatra app.",
            command: "blank-ruby-sinatra",
            requires: "ruby",
        },
        ProjectTemplate {
            id: "php-laravel",
            label: "php + laravel",
            category: "php",
            language: "php",
            summary: "laravel new (requires composer).",
            command: "composer create-project laravel/laravel {name}",
            requires: "composer",
        },
        ProjectTemplate {
            id: "haskell-stack",
            label: "haskell (stack)",
            category: "functional",
            language: "haskell",
            summary: "stack new simple.",
            command: "stack new {name} simple",
            requires: "stack",
        },
        ProjectTemplate {
            id: "ocaml-dune",
            label: "ocaml (dune)",
            category: "functional",
            language: "ocaml",
            summary: "dune init proj.",
            command: "dune init proj {name}",
            requires: "dune",
        },
        ProjectTemplate {
            id: "lua-love",
            label: "lua (love2d)",
            category: "lua",
            language: "lua",
            summary: "love2d game skeleton.",
            command: "blank-lua-love",
            requires: "lua",
        },
        ProjectTemplate {
            id: "nim",
            label: "nim",
            category: "native",
            language: "nim",
            summary: "nimble init.",
            command: "nimble init {name} --no-git",
            requires: "nimble",
        },
        ProjectTemplate {
            id: "react-native",
            label: "react native",
            category: "mobile",
            language: "typescript",
            summary: "react-native init via community CLI.",
            command: "npx @react-native-community/cli@latest init {name} --skip-install --pm npm",
            requires: "npx",
        },
        ProjectTemplate {
            id: "flutter",
            label: "flutter",
            category: "mobile",
            language: "dart",
            summary: "flutter create.",
            command: "flutter create {name}",
            requires: "flutter",
        },
        ProjectTemplate {
            id: "electron",
            label: "electron + vite",
            category: "desktop",
            language: "typescript",
            summary: "electron-vite ts scaffold.",
            command: "npm create @quick-start/electron@latest {name} -- --template vanilla-ts --skip-install",
            requires: "npm",
        },
        ProjectTemplate {
            id: "python-ml-torch",
            label: "python + pytorch",
            category: "ml",
            language: "python",
            summary: "uv project with torch / numpy / matplotlib.",
            command: "blank-python-torch",
            requires: "uv",
        },
        ProjectTemplate {
            id: "r-renv",
            label: "r (renv)",
            category: "data",
            language: "r",
            summary: "r project with renv lockfile.",
            command: "blank-r-renv",
            requires: "r",
        },
    ];
    TEMPLATES
}

#[tauri::command]
pub fn project_templates() -> Vec<ProjectTemplate> {
    templates().to_vec()
}

#[tauri::command]
pub fn project_status() -> Result<ProjectStatus, String> {
    let root = project_context::active_project_root()?;
    let name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("workspace")
        .to_string();
    let branch = git_output(&root, &["branch", "--show-current"]).filter(|value| !value.is_empty());
    let upstream = branch.as_ref().and_then(|_| {
        let base = branch_compare_base_ref(&root);
        if base == "HEAD" {
            None
        } else {
            Some(base)
        }
    });
    Ok(ProjectStatus {
        path: root.display().to_string(),
        name,
        branch,
        upstream,
        dirty: git_output(&root, &["status", "--porcelain"])
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
    })
}

#[tauri::command]
pub fn git_run(action: String) -> Result<GitRunResult, String> {
    let root = project_context::active_project_root()?;
    let args = git_action_args(&action)?;
    let output = Command::new("git")
        .args(args)
        .current_dir(&root)
        .output()
        .map_err(|err| format!("failed to run git {action}: {err}"))?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(GitRunResult {
        action,
        command: args.iter().map(|arg| (*arg).to_string()).collect(),
        exit_code: output.status.code(),
        output: trim_tail(&combined, 20000),
    })
}

#[tauri::command]
pub fn git_diff(
    mode: String,
    file: Option<String>,
    snapshot_commit: Option<String>,
    worktree_path: Option<String>,
) -> Result<GitDiffResult, String> {
    let root = match worktree_path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => project_context::active_project_root()?,
    };
    let mode = match mode.as_str() {
        "working" | "branch" | "snapshot" => mode,
        other => return Err(format!("unsupported git diff mode: {other}")),
    };
    let file = file
        .map(|value| safe_relative_git_path(&value))
        .transpose()?;

    let snapshot_commit = if mode == "snapshot" {
        let raw = snapshot_commit
            .ok_or_else(|| "snapshot mode requires a snapshot commit".to_string())?;
        validate_commit_hash(&raw)?;
        Some(raw)
    } else {
        None
    };
    let branch_base_ref = if mode == "branch" {
        Some(branch_compare_base_ref(&root))
    } else {
        None
    };

    let changed_files = match mode.as_str() {
        "branch" => {
            let range = format!("{}...HEAD", branch_base_ref.as_deref().unwrap_or("HEAD"));
            git_changed_files_from_name_only(&root, &["diff", "--name-only", &range])
        }
        "snapshot" => {
            let commit = snapshot_commit.as_deref().unwrap();
            git_changed_files_from_name_only(&root, &["diff", "--name-only", commit])
        }
        _ => git_changed_files_from_status(&root),
    };

    let mut args = match mode.as_str() {
        "branch" => vec![
            "diff".to_string(),
            format!("{}...HEAD", branch_base_ref.as_deref().unwrap_or("HEAD")),
        ],
        "snapshot" => vec!["diff".to_string(), snapshot_commit.clone().unwrap()],
        "working" => vec!["diff".to_string(), "HEAD".to_string()],
        _ => unreachable!(),
    };
    if let Some(path) = &file {
        args.push("--".to_string());
        args.push(path.clone());
    }

    let (exit_code, output) = run_git_collect(&root, &args)?;
    let diff = if output.trim().is_empty() && file.is_some() {
        "no tracked diff for selected file; it may be untracked or unchanged".to_string()
    } else {
        trim_tail(&output, 120000)
    };
    Ok(GitDiffResult {
        base_ref: match mode.as_str() {
            "branch" => branch_base_ref,
            "snapshot" => snapshot_commit.clone(),
            "working" => Some("HEAD".to_string()),
            _ => None,
        },
        target_ref: Some(match mode.as_str() {
            "branch" => current_branch_label(&root),
            "snapshot" | "working" => "working tree".to_string(),
            _ => "HEAD".to_string(),
        }),
        mode,
        file,
        changed_files,
        diff,
        exit_code,
    })
}

fn branch_compare_base_ref(root: &Path) -> String {
    git_output(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .filter(|value| !value.is_empty() && value != "@{upstream}")
    .or_else(|| {
        git_output(
            root,
            &[
                "symbolic-ref",
                "--quiet",
                "--short",
                "refs/remotes/origin/HEAD",
            ],
        )
        .filter(|value| !value.is_empty())
    })
    .or_else(|| first_existing_ref(root, &["origin/main", "origin/master", "main", "master"]))
    .unwrap_or_else(|| "HEAD".to_string())
}

fn first_existing_ref(root: &Path, refs: &[&str]) -> Option<String> {
    refs.iter()
        .find(|candidate| ref_exists(root, candidate))
        .map(|candidate| (*candidate).to_string())
}

fn ref_exists(root: &Path, candidate: &str) -> bool {
    Command::new("git")
        .args(["rev-parse", "--verify", "--quiet", candidate])
        .current_dir(root)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn current_branch_label(root: &Path) -> String {
    git_output(root, &["branch", "--show-current"])
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "HEAD".to_string())
}

fn validate_commit_hash(raw: &str) -> Result<(), String> {
    if raw.is_empty() || raw.len() > 64 {
        return Err(format!("snapshot commit has invalid length: {raw}"));
    }
    if !raw.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!(
            "snapshot commit has non-alphanumeric characters: {raw}"
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn git_fork(event_id: String) -> Result<GitWorktreeResult, String> {
    let root = project_context::active_project_root()?;
    let slug = git_ref_slug(&event_id);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("project");
    let parent = root
        .parent()
        .ok_or_else(|| "active project has no parent directory".to_string())?;
    let worktree_path = parent.join(format!("{name}-fork-{slug}-{ts}"));
    let branch = format!("polypore/fork/{slug}-{ts}");
    let args = vec![
        "worktree".to_string(),
        "add".to_string(),
        "-b".to_string(),
        branch.clone(),
        worktree_path.display().to_string(),
        "HEAD".to_string(),
    ];
    let (exit_code, output) = run_git_collect(&root, &args)?;
    if exit_code != Some(0) {
        return Err(trim_tail(&output, 20000));
    }
    Ok(GitWorktreeResult {
        id: format!("wt-{slug}-{ts}"),
        path: worktree_path.display().to_string(),
        branch,
        forked_from_event_id: event_id,
        output: trim_tail(&output, 20000),
        exit_code,
    })
}

#[tauri::command]
pub fn worktree_create(
    branch: Option<String>,
    path: Option<String>,
    from_ref: Option<String>,
) -> Result<GitWorktreeResult, String> {
    let root = project_context::active_project_root()?;
    worktree_create_from(&root, branch, path, from_ref)
}

fn worktree_create_from(
    root: &Path,
    branch: Option<String>,
    path: Option<String>,
    from_ref: Option<String>,
) -> Result<GitWorktreeResult, String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let branch = normalize_worktree_branch(root, branch, ts)?;
    let start_point = normalize_worktree_start_ref(root, from_ref)?;
    let worktree_path = resolve_worktree_create_path(root, path.as_deref(), &branch, ts)?;
    let args = vec![
        "worktree".to_string(),
        "add".to_string(),
        "-b".to_string(),
        branch.clone(),
        worktree_path.display().to_string(),
        start_point,
    ];
    let (exit_code, output) = run_git_collect(root, &args)?;
    if exit_code != Some(0) {
        return Err(trim_tail(&output, 20000));
    }
    let canonical_path = std::fs::canonicalize(&worktree_path).unwrap_or(worktree_path);
    let common_dir = git_common_dir(root)?;
    let id = derive_worktree_id(&common_dir, &canonical_path);
    Ok(GitWorktreeResult {
        id,
        path: canonical_path.display().to_string(),
        branch,
        forked_from_event_id: "manual".to_string(),
        output: trim_tail(&output, 20000),
        exit_code,
    })
}

#[tauri::command]
pub fn git_revert_files(files: Vec<String>) -> Result<GitRevertResult, String> {
    let root = project_context::active_project_root()?;
    if files.is_empty() {
        return Err("no files selected for revert".into());
    }
    let files = files
        .into_iter()
        .map(|file| safe_relative_git_path(&file))
        .collect::<Result<Vec<_>, _>>()?;
    let mut combined = String::new();
    let mut final_exit = Some(0);

    for file in &files {
        let restore_args = vec![
            "restore".to_string(),
            "--source".to_string(),
            "HEAD".to_string(),
            "--".to_string(),
            file.clone(),
        ];
        let (restore_exit, restore_output) = run_git_collect(&root, &restore_args)?;
        if !restore_output.trim().is_empty() {
            combined.push_str(&restore_output);
        }

        let clean_args = vec![
            "clean".to_string(),
            "-f".to_string(),
            "--".to_string(),
            file.clone(),
        ];
        let (clean_exit, clean_output) = run_git_collect(&root, &clean_args)?;
        if !clean_output.trim().is_empty() {
            combined.push_str(&clean_output);
        }

        if restore_exit != Some(0) && clean_exit != Some(0) {
            final_exit = restore_exit.or(clean_exit);
        }
    }

    Ok(GitRevertResult {
        files,
        output: trim_tail(&combined, 20000),
        exit_code: final_exit,
    })
}

#[tauri::command]
pub fn git_restore_from_snapshot(
    worktree_path: Option<String>,
    snapshot_commit: String,
    files: Vec<String>,
) -> Result<GitRevertResult, String> {
    let root = match worktree_path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => project_context::active_project_root()?,
    };
    restore_from_snapshot(&root, &snapshot_commit, &files)
}

pub fn restore_from_snapshot(
    worktree_path: &Path,
    snapshot_commit: &str,
    files: &[String],
) -> Result<GitRevertResult, String> {
    if snapshot_commit.trim().is_empty() {
        return Err("snapshot commit cannot be empty".into());
    }
    if !snapshot_commit.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!(
            "snapshot commit has invalid characters: {snapshot_commit}"
        ));
    }
    if files.is_empty() {
        return Err("no files selected for snapshot restore".into());
    }
    let safe_files: Vec<String> = files
        .iter()
        .map(|f| safe_relative_git_path(f))
        .collect::<Result<_, _>>()?;

    let mut combined = String::new();
    let mut final_exit: Option<i32> = Some(0);
    for file in &safe_files {
        let args = vec![
            "checkout".to_string(),
            snapshot_commit.to_string(),
            "--".to_string(),
            file.clone(),
        ];
        let (exit, output) = run_git_collect(worktree_path, &args)?;
        if !output.trim().is_empty() {
            combined.push_str(&output);
        }
        if exit != Some(0) {
            final_exit = exit;
        }
    }
    Ok(GitRevertResult {
        files: safe_files,
        output: trim_tail(&combined, 20000),
        exit_code: final_exit,
    })
}

#[tauri::command]
pub fn worktrees_list() -> Result<Vec<WorktreeInfo>, String> {
    let root = project_context::active_project_root()?;
    worktrees_list_from(&root, &root)
}

/* Pure-function variant for tests and for cases where the caller already
knows the main root (e.g., scheduler bootstrap discovers worktrees from a
known repo regardless of the env-derived active project). */
pub fn worktrees_list_from(
    main_root: &Path,
    current_root: &Path,
) -> Result<Vec<WorktreeInfo>, String> {
    let common_dir = git_common_dir(main_root)?;
    let porcelain = run_git_output_or_error(main_root, &["worktree", "list", "--porcelain"])?;
    Ok(parse_worktree_porcelain(
        &porcelain,
        &common_dir,
        current_root,
    ))
}

fn parse_worktree_porcelain(
    porcelain: &str,
    common_dir: &Path,
    current_root: &Path,
) -> Vec<WorktreeInfo> {
    let mut out: Vec<WorktreeInfo> = Vec::new();
    let mut path: Option<String> = None;
    let mut head: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut locked = false;
    let mut detached = false;

    let flush = |path: &mut Option<String>,
                 head: &mut Option<String>,
                 branch: &mut Option<String>,
                 locked: &mut bool,
                 detached: &mut bool,
                 out: &mut Vec<WorktreeInfo>| {
        if let Some(p) = path.take() {
            let id = derive_worktree_id(common_dir, Path::new(&p));
            let is_current = Path::new(&p) == current_root;
            out.push(WorktreeInfo {
                id,
                path: p,
                branch: branch.take(),
                head: head.take(),
                is_current,
                is_locked: *locked,
                is_detached: *detached,
            });
            *locked = false;
            *detached = false;
        }
    };

    for raw in porcelain.lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            flush(
                &mut path,
                &mut head,
                &mut branch,
                &mut locked,
                &mut detached,
                &mut out,
            );
            continue;
        }
        let (key, rest) = match line.split_once(' ') {
            Some((k, r)) => (k, r),
            None => (line, ""),
        };
        match key {
            "worktree" => {
                flush(
                    &mut path,
                    &mut head,
                    &mut branch,
                    &mut locked,
                    &mut detached,
                    &mut out,
                );
                path = Some(rest.to_string());
            }
            "HEAD" => head = Some(rest.to_string()),
            "branch" => {
                branch = Some(rest.trim_start_matches("refs/heads/").to_string());
            }
            "detached" => detached = true,
            "locked" => locked = true,
            _ => {}
        }
    }
    flush(
        &mut path,
        &mut head,
        &mut branch,
        &mut locked,
        &mut detached,
        &mut out,
    );
    out
}

fn derive_worktree_id(common_dir: &Path, worktree_path: &Path) -> String {
    let main_root = common_dir.parent();
    if main_root.map(|r| r == worktree_path).unwrap_or(false) {
        return "main".to_string();
    }
    let worktrees_dir = common_dir.join("worktrees");
    if let Ok(entries) = std::fs::read_dir(&worktrees_dir) {
        for entry in entries.flatten() {
            let gitdir_file = entry.path().join("gitdir");
            if let Ok(contents) = std::fs::read_to_string(&gitdir_file) {
                let gitdir = contents.trim();
                let path_buf = Path::new(gitdir);
                let wt_from_file = path_buf.parent().unwrap_or(path_buf);
                if wt_from_file == worktree_path {
                    if let Some(name) = entry.file_name().to_str() {
                        return name.to_string();
                    }
                }
            }
        }
    }
    worktree_path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn git_common_dir(root: &Path) -> Result<PathBuf, String> {
    let out = run_git_output_or_error(root, &["rev-parse", "--git-common-dir"])?;
    let trimmed = out.trim();
    let path = Path::new(trimmed);
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(root.join(trimmed))
    }
}

fn run_git_output_or_error(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|err| format!("git failed: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
pub async fn project_pick_folder() -> Result<Option<String>, String> {
    /* rfd's async dialog uses the freedesktop portal on linux so we don't
    have to ship gtk linkage. on macos and windows it uses the native
    APIs. it must be awaited off the tauri command thread. */
    let result = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("polypore — choose project folder")
            .pick_folder()
    })
    .await
    .map_err(|err| format!("folder dialog dispatch failed: {err}"))?;
    Ok(result.map(|path| path.display().to_string()))
}

#[tauri::command]
pub fn project_recent_list() -> Result<Vec<RecentProject>, String> {
    let db_path = persistence_path()?;
    if !db_path.exists() {
        return Ok(Vec::new());
    }
    let conn = Connection::open(&db_path).map_err(|err| format!("failed to open sqlite: {err}"))?;
    let mut stmt = conn
        .prepare("SELECT path, last_opened FROM projects ORDER BY last_opened DESC LIMIT 24")
        .map_err(|err| format!("failed to prepare recents query: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            let path: String = row.get(0)?;
            let last_opened: Option<i64> = row.get(1)?;
            Ok(RecentProject {
                exists: Path::new(&path).is_dir(),
                name: Path::new(&path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("")
                    .to_string(),
                path,
                last_opened: last_opened.unwrap_or(0),
            })
        })
        .map_err(|err| format!("failed to read recents: {err}"))?;
    let mut out = Vec::new();
    for row in rows {
        match row {
            Ok(project) => out.push(project),
            Err(err) => return Err(format!("recent row decode failed: {err}")),
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn project_open(path: String) -> Result<ProjectMeta, String> {
    let resolved =
        std::fs::canonicalize(&path).map_err(|err| format!("cannot open '{path}': {err}"))?;
    if !resolved.is_dir() {
        return Err(format!("'{path}' is not a directory"));
    }
    touch_recent(&resolved)?;
    let display = resolved.display().to_string();
    let name = resolved
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("project")
        .to_string();
    project_context::set_active_project_root(&display);
    Ok(ProjectMeta {
        path: display,
        name,
        created: false,
    })
}

#[tauri::command]
pub fn project_forget(path: String) -> Result<(), String> {
    let db_path = persistence_path()?;
    if !db_path.exists() {
        return Ok(());
    }
    let conn = Connection::open(&db_path).map_err(|err| format!("failed to open sqlite: {err}"))?;
    conn.execute("DELETE FROM projects WHERE path = ?1", params![path])
        .map_err(|err| format!("failed to forget project: {err}"))?;
    Ok(())
}

#[tauri::command]
pub async fn project_create(
    parent: String,
    name: String,
    template_id: String,
) -> Result<ScaffoldOutcome, String> {
    let safe_name = sanitize_name(&name)?;
    let parent_path = std::fs::canonicalize(&parent)
        .map_err(|err| format!("invalid parent '{parent}': {err}"))?;
    if !parent_path.is_dir() {
        return Err(format!("parent '{parent}' is not a directory"));
    }
    let target = parent_path.join(&safe_name);
    if target.exists() {
        return Err(format!(
            "'{}' already exists — pick another name",
            target.display()
        ));
    }

    let template = templates()
        .iter()
        .find(|tpl| tpl.id == template_id)
        .ok_or_else(|| format!("unknown template '{template_id}'"))?;

    let log = run_scaffold(&parent_path, &safe_name, template).await?;
    if !target.exists() {
        /* a few scaffolders create the directory themselves; if it isn't
        there yet but the command succeeded, create an empty dir so we
        don't trap the user. */
        std::fs::create_dir_all(&target)
            .map_err(|err| format!("failed to create target dir: {err}"))?;
    }
    touch_recent(&target)?;
    project_context::set_active_project_root(&target);
    Ok(ScaffoldOutcome {
        ok: true,
        log,
        project: ProjectMeta {
            path: target.display().to_string(),
            name: safe_name,
            created: true,
        },
    })
}

#[tauri::command]
pub fn project_agent_status() -> Vec<AgentBinaryStatus> {
    /* report whether the binaries that drive the chat panel are reachable
    on PATH so the launcher can warn the user before they boot the IDE
    with no agent at all. ACP gating lives in agent::runtime_for; this is
    a presence check, not a full handshake. */
    ["claude", "codex"]
        .iter()
        .map(|name| {
            let path = which::which(name).ok();
            AgentBinaryStatus {
                agent: (*name).to_string(),
                available: path.is_some() && agent::command_available(name),
                path: path.map(|p| p.display().to_string()),
            }
        })
        .collect()
}

fn sanitize_name(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("project name cannot be empty".into());
    }
    if !trimmed
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
    {
        return Err("project name must start with a letter or number".into());
    }
    if trimmed
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
    {
        return Err(
            "project name can only contain letters, numbers, dots, underscores, and hyphens".into(),
        );
    }
    Ok(trimmed.to_string())
}

fn touch_recent(path: &Path) -> Result<(), String> {
    let db_path = persistence_path()?;
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let conn = Connection::open(&db_path).map_err(|err| format!("failed to open sqlite: {err}"))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS projects(
           id INTEGER PRIMARY KEY,
           path TEXT UNIQUE NOT NULL,
           last_opened INTEGER
         );",
    )
    .map_err(|err| format!("failed to ensure projects table: {err}"))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO projects(path, last_opened) VALUES (?1, ?2)
         ON CONFLICT(path) DO UPDATE SET last_opened=excluded.last_opened",
        params![path.display().to_string(), now],
    )
    .map_err(|err| format!("failed to touch project: {err}"))?;
    Ok(())
}

fn persistence_path() -> Result<PathBuf, String> {
    crate::persistence::db_path()
}

fn git_output(root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_action_args(action: &str) -> Result<&'static [&'static str], String> {
    match action {
        "status" => Ok(&["status", "--short", "--branch"]),
        "fetch" => Ok(&["fetch", "--prune"]),
        "pull" => Ok(&["pull", "--ff-only"]),
        "push" => Ok(&["push"]),
        "log" => Ok(&["log", "--oneline", "--decorate", "-n", "30"]),
        _ => Err(format!("unsupported git action: {action}")),
    }
}

fn run_git_collect(root: &Path, args: &[String]) -> Result<(Option<i32>, String), String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|err| format!("failed to run git {}: {err}", args.join(" ")))?;
    Ok((
        output.status.code(),
        format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ),
    ))
}

fn git_changed_files_from_name_only(root: &Path, args: &[&str]) -> Vec<String> {
    git_output(root, args)
        .map(|value| {
            value
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn git_changed_files_from_status(root: &Path) -> Vec<String> {
    git_output(root, &["status", "--porcelain"])
        .map(|value| {
            value
                .lines()
                .filter_map(|line| {
                    let path = line.get(3..)?.trim();
                    let path = path
                        .rsplit_once(" -> ")
                        .map(|(_, new_path)| new_path)
                        .unwrap_or(path);
                    (!path.is_empty()).then(|| path.to_string())
                })
                .collect()
        })
        .unwrap_or_default()
}

fn safe_relative_git_path(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("git diff path cannot be empty".into());
    }
    if trimmed.contains('\0') {
        return Err("git diff path contains a null byte".into());
    }
    let path = Path::new(trimmed);
    if path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(format!(
            "git diff path must stay inside the project: {trimmed}"
        ));
    }
    Ok(trimmed.to_string())
}

fn normalize_worktree_branch(
    root: &Path,
    branch: Option<String>,
    ts: u64,
) -> Result<String, String> {
    let branch = match branch {
        Some(raw) if !raw.trim().is_empty() => raw.trim().to_string(),
        _ => {
            let name = root
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("project");
            format!("polypore/worktree/{}-{ts}", git_ref_slug(name))
        }
    };
    if branch.contains('\0') || branch.starts_with('-') || branch.starts_with("refs/") {
        return Err(format!("invalid worktree branch: {branch}"));
    }
    let args = vec![
        "check-ref-format".to_string(),
        "--branch".to_string(),
        branch.clone(),
    ];
    let (exit, output) = run_git_collect(root, &args)?;
    if exit != Some(0) {
        return Err(trim_tail(&output, 20000));
    }
    Ok(branch)
}

fn normalize_worktree_start_ref(root: &Path, from_ref: Option<String>) -> Result<String, String> {
    let start_point = from_ref
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .unwrap_or_else(|| "HEAD".to_string());
    if start_point.contains('\0') || start_point.starts_with('-') {
        return Err(format!("invalid worktree start ref: {start_point}"));
    }
    let verify = vec![
        "rev-parse".to_string(),
        "--verify".to_string(),
        format!("{start_point}^{{commit}}"),
    ];
    let (exit, output) = run_git_collect(root, &verify)?;
    if exit != Some(0) {
        return Err(trim_tail(&output, 20000));
    }
    Ok(start_point)
}

fn resolve_worktree_create_path(
    root: &Path,
    raw_path: Option<&str>,
    branch: &str,
    ts: u64,
) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let parent = root
        .parent()
        .ok_or_else(|| "active project has no parent directory".to_string())?;
    let path = match raw_path {
        Some(raw) if !raw.trim().is_empty() => {
            let trimmed = raw.trim();
            if trimmed.contains('\0') {
                return Err("worktree path contains a null byte".to_string());
            }
            let requested = PathBuf::from(trimmed);
            if requested.is_absolute() {
                requested
            } else {
                if requested
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir))
                {
                    return Err("relative worktree path cannot contain '..'".to_string());
                }
                parent.join(requested)
            }
        }
        _ => {
            let name = root
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("project");
            parent.join(format!("{name}-{}-{ts}", git_ref_slug(branch)))
        }
    };
    Ok(path)
}

fn git_ref_slug(raw: &str) -> String {
    let slug: String = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "event".to_string()
    } else {
        trimmed.chars().take(48).collect()
    }
}

fn trim_tail(value: &str, max_chars: usize) -> String {
    let chars = value.chars().count();
    if chars <= max_chars {
        return value.to_string();
    }
    value.chars().skip(chars - max_chars).collect()
}

async fn run_scaffold(
    parent: &Path,
    name: &str,
    template: &ProjectTemplate,
) -> Result<String, String> {
    /* the "blank-*" command sentinels are templates we scaffold inline —
    they're tiny scaffolds where pulling in an upstream generator would be
    overkill. everything else gets executed via the user's shell so we
    don't have to maintain language-specific code paths. */
    if template.command.starts_with("blank") {
        return scaffold_inline(parent, name, template).await;
    }
    let rendered = template.command.replace("{name}", name);
    let log = format!("$ {rendered}\n");
    let output = tokio::process::Command::new("sh")
        .arg("-lc")
        .arg(&rendered)
        .current_dir(parent)
        .output()
        .await
        .map_err(|err| format!("failed to spawn scaffold: {err}"))?;
    let mut combined = String::new();
    combined.push_str(&log);
    combined.push_str(&String::from_utf8_lossy(&output.stdout));
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    if !output.status.success() {
        return Err(format!(
            "scaffold exited with status {}:\n{combined}",
            output.status.code().unwrap_or(-1)
        ));
    }
    Ok(combined)
}

async fn scaffold_inline(
    parent: &Path,
    name: &str,
    template: &ProjectTemplate,
) -> Result<String, String> {
    let target = parent.join(name);
    std::fs::create_dir_all(&target)
        .map_err(|err| format!("failed to create '{}': {err}", target.display()))?;
    let mut log = format!("scaffolding {} → {}\n", template.id, target.display());
    let files: Vec<(&str, String)> = match template.command {
        "blank" => vec![
            (".gitignore", String::from("# polypore blank project\n")),
            ("README.md", format!("# {name}\n\nopened in polypore.\n")),
        ],
        "blank-node-express" => vec![
            (
                "package.json",
                format!(
                    "{{\n  \"name\": \"{name}\",\n  \"version\": \"0.1.0\",\n  \"type\": \"module\",\n  \"scripts\": {{\n    \"dev\": \"node --watch src/server.js\"\n  }},\n  \"dependencies\": {{ \"express\": \"^4\" }}\n}}\n"
                ),
            ),
            (
                "src/server.js",
                "import express from 'express';\nconst app = express();\napp.get('/', (_, res) => res.json({ ok: true }));\napp.listen(3000, () => console.log('listening on http://localhost:3000'));\n".into(),
            ),
            (".gitignore", "node_modules/\n.env\n".into()),
        ],
        "blank-node-fastify" => vec![
            (
                "package.json",
                format!(
                    "{{\n  \"name\": \"{name}\",\n  \"version\": \"0.1.0\",\n  \"type\": \"module\",\n  \"scripts\": {{\n    \"dev\": \"node --watch src/server.js\"\n  }},\n  \"dependencies\": {{ \"fastify\": \"^4\" }}\n}}\n"
                ),
            ),
            (
                "src/server.js",
                "import Fastify from 'fastify';\nconst app = Fastify({ logger: true });\napp.get('/', async () => ({ ok: true }));\napp.listen({ port: 3000 });\n".into(),
            ),
            (".gitignore", "node_modules/\n.env\n".into()),
        ],
        "blank-python-fastapi" => vec![
            (
                "pyproject.toml",
                format!(
                    "[project]\nname = \"{name}\"\nversion = \"0.1.0\"\nrequires-python = \">=3.11\"\ndependencies = [\"fastapi\", \"uvicorn\"]\n"
                ),
            ),
            (
                "src/main.py",
                "from fastapi import FastAPI\napp = FastAPI()\n\n@app.get('/')\nasync def root() -> dict:\n    return {'ok': True}\n".into(),
            ),
            (".gitignore", ".venv/\n__pycache__/\n*.pyc\n".into()),
        ],
        "blank-python-flask" => vec![
            (
                "pyproject.toml",
                format!(
                    "[project]\nname = \"{name}\"\nversion = \"0.1.0\"\nrequires-python = \">=3.11\"\ndependencies = [\"flask\"]\n"
                ),
            ),
            (
                "src/app.py",
                "from flask import Flask\napp = Flask(__name__)\n\n@app.get('/')\ndef root() -> dict:\n    return {'ok': True}\n".into(),
            ),
            (".gitignore", ".venv/\n__pycache__/\n*.pyc\n".into()),
        ],
        "blank-python-jupyter" => vec![
            (
                "pyproject.toml",
                format!(
                    "[project]\nname = \"{name}\"\nversion = \"0.1.0\"\nrequires-python = \">=3.11\"\ndependencies = [\"jupyterlab\", \"ipykernel\", \"pandas\", \"matplotlib\"]\n"
                ),
            ),
            (
                "notebooks/scratch.ipynb",
                "{\n \"cells\": [],\n \"metadata\": {},\n \"nbformat\": 4,\n \"nbformat_minor\": 5\n}\n".into(),
            ),
            (".gitignore", ".venv/\n__pycache__/\n*.pyc\n.ipynb_checkpoints/\n".into()),
        ],
        "blank-python-torch" => vec![
            (
                "pyproject.toml",
                format!(
                    "[project]\nname = \"{name}\"\nversion = \"0.1.0\"\nrequires-python = \">=3.11\"\ndependencies = [\"torch\", \"numpy\", \"matplotlib\"]\n"
                ),
            ),
            (
                "src/main.py",
                "import torch\n\nif __name__ == '__main__':\n    print('torch', torch.__version__, 'cuda', torch.cuda.is_available())\n".into(),
            ),
            (".gitignore", ".venv/\n__pycache__/\n*.pyc\n".into()),
        ],
        "blank-rust-axum" => vec![
            (
                "Cargo.toml",
                format!(
                    "[package]\nname = \"{name}\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\naxum = \"0.7\"\ntokio = {{ version = \"1\", features = [\"full\"] }}\n"
                ),
            ),
            (
                "src/main.rs",
                "use axum::{routing::get, Router};\n\n#[tokio::main]\nasync fn main() {\n    let app = Router::new().route(\"/\", get(|| async { \"ok\" }));\n    let listener = tokio::net::TcpListener::bind(\"0.0.0.0:3000\").await.unwrap();\n    axum::serve(listener, app).await.unwrap();\n}\n".into(),
            ),
            (".gitignore", "target/\n".into()),
        ],
        "blank-go-mod" => vec![
            (
                "go.mod",
                format!("module {name}\n\ngo 1.22\n"),
            ),
            (
                "main.go",
                format!("package main\n\nimport \"fmt\"\n\nfunc main() {{\n    fmt.Println(\"{name}\")\n}}\n"),
            ),
            (".gitignore", "/bin\n".into()),
        ],
        "blank-go-gin" => vec![
            (
                "go.mod",
                format!("module {name}\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.10.0\n"),
            ),
            (
                "main.go",
                "package main\n\nimport \"github.com/gin-gonic/gin\"\n\nfunc main() {\n    r := gin.Default()\n    r.GET(\"/\", func(c *gin.Context) { c.JSON(200, gin.H{\"ok\": true}) })\n    r.Run(\":3000\")\n}\n".into(),
            ),
            (".gitignore", "/bin\n".into()),
        ],
        "blank-go-echo" => vec![
            (
                "go.mod",
                format!("module {name}\n\ngo 1.22\n\nrequire github.com/labstack/echo/v4 v4.12.0\n"),
            ),
            (
                "main.go",
                "package main\n\nimport (\n    \"net/http\"\n    \"github.com/labstack/echo/v4\"\n)\n\nfunc main() {\n    e := echo.New()\n    e.GET(\"/\", func(c echo.Context) error { return c.JSON(http.StatusOK, map[string]bool{\"ok\": true}) })\n    e.Logger.Fatal(e.Start(\":3000\"))\n}\n".into(),
            ),
            (".gitignore", "/bin\n".into()),
        ],
        "blank-c-cmake" => vec![
            (
                "CMakeLists.txt",
                format!(
                    "cmake_minimum_required(VERSION 3.20)\nproject({name} C)\nset(CMAKE_C_STANDARD 11)\nadd_executable({name} src/main.c)\n"
                ),
            ),
            (
                "src/main.c",
                "#include <stdio.h>\n\nint main(void) {\n    puts(\"polypore\");\n    return 0;\n}\n".into(),
            ),
            (".gitignore", "build/\n".into()),
        ],
        "blank-cpp-cmake" => vec![
            (
                "CMakeLists.txt",
                format!(
                    "cmake_minimum_required(VERSION 3.20)\nproject({name} CXX)\nset(CMAKE_CXX_STANDARD 20)\nadd_executable({name} src/main.cpp)\n"
                ),
            ),
            (
                "src/main.cpp",
                "#include <iostream>\n\nint main() {\n    std::cout << \"polypore\" << std::endl;\n    return 0;\n}\n".into(),
            ),
            (".gitignore", "build/\n".into()),
        ],
        "blank-zig" => vec![
            (
                "build.zig",
                format!(
                    "const std = @import(\"std\");\n\npub fn build(b: *std.Build) void {{\n    const target = b.standardTargetOptions(.{{}});\n    const optimize = b.standardOptimizeOption(.{{}});\n    const exe = b.addExecutable(.{{ .name = \"{name}\", .root_source_file = b.path(\"src/main.zig\"), .target = target, .optimize = optimize }});\n    b.installArtifact(exe);\n}}\n"
                ),
            ),
            (
                "src/main.zig",
                "const std = @import(\"std\");\n\npub fn main() !void {\n    const out = std.io.getStdOut().writer();\n    try out.print(\"polypore\\n\", .{});\n}\n".into(),
            ),
            (".gitignore", "zig-out/\nzig-cache/\n.zig-cache/\n".into()),
        ],
        "blank-swift-pm" => vec![
            (
                "Package.swift",
                format!(
                    "// swift-tools-version:5.9\nimport PackageDescription\n\nlet package = Package(\n    name: \"{name}\",\n    targets: [\n        .executableTarget(name: \"{name}\", path: \"Sources/{name}\"),\n    ]\n)\n"
                ),
            ),
            (
                "Sources/main.swift",
                "print(\"polypore\")\n".into(),
            ),
            (".gitignore", ".build/\n".into()),
        ],
        "blank-ruby-sinatra" => vec![
            (
                "Gemfile",
                "source 'https://rubygems.org'\ngem 'sinatra'\n".into(),
            ),
            (
                "app.rb",
                "require 'sinatra'\n\nget '/' do\n  { ok: true }.to_json\nend\n".into(),
            ),
            (".gitignore", "vendor/\n*.lock\n".into()),
        ],
        "blank-lua-love" => vec![
            (
                "main.lua",
                "function love.draw()\n    love.graphics.print('polypore', 200, 200)\nend\n".into(),
            ),
            ("conf.lua", "function love.conf(t)\n    t.window.title = 'polypore'\nend\n".into()),
        ],
        "blank-clojure-deps" => vec![
            (
                "deps.edn",
                "{:paths [\"src\"]\n :deps {org.clojure/clojure {:mvn/version \"1.12.0\"}}}\n".into(),
            ),
            (
                "src/core.clj",
                format!("(ns {name}.core)\n\n(defn -main [& _] (println \"polypore\"))\n"),
            ),
            (".gitignore", ".cpcache/\n".into()),
        ],
        "blank-r-renv" => vec![
            (
                "DESCRIPTION",
                format!("Package: {name}\nVersion: 0.0.1\nDescription: polypore r project\n"),
            ),
            (
                "renv.lock",
                "{ \"R\": { \"Version\": \"4.3.0\" }, \"Packages\": {} }\n".into(),
            ),
            (".gitignore", "renv/library/\n.Rproj.user/\n".into()),
        ],
        other => return Err(format!("unknown inline template '{other}'")),
    };

    for (rel, content) in files {
        let file = target.join(rel);
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("failed to create '{}': {err}", parent.display()))?;
        }
        std::fs::write(&file, content)
            .map_err(|err| format!("failed to write '{}': {err}", file.display()))?;
        log.push_str(&format!("  + {}\n", rel));
    }
    Ok(log)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_name_allows_simple_ascii_project_names() {
        assert_eq!(sanitize_name("app").expect("valid"), "app");
        assert_eq!(
            sanitize_name("  app.v2_test-1  ").expect("valid"),
            "app.v2_test-1"
        );
    }

    #[test]
    fn sanitize_name_rejects_shell_and_path_metacharacters() {
        for name in [
            "app;touch-pwned",
            "app $(touch pwned)",
            "app`touch pwned`",
            "app && touch pwned",
            "app/name",
            "app\\name",
            "app name",
        ] {
            assert!(sanitize_name(name).is_err(), "{name} should be rejected");
        }
    }

    #[test]
    fn sanitize_name_rejects_option_like_or_special_names() {
        for name in ["", "   ", "-app", ".app", ".", "..", "_app"] {
            assert!(sanitize_name(name).is_err(), "{name:?} should be rejected");
        }
    }

    use std::sync::atomic::{AtomicU64, Ordering};
    static WT_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_dir(label: &str) -> PathBuf {
        let n = WT_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "polypore-wt-test-{}-{}-{}",
            std::process::id(),
            label,
            n
        ))
    }

    fn git(dir: &Path, args: &[&str]) {
        let s = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git spawn");
        assert!(
            s.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&s.stderr)
        );
    }

    fn init_repo_with_worktree(label: &str) -> (PathBuf, PathBuf) {
        let main = unique_dir(label);
        let linked = unique_dir(&format!("{label}-linked"));
        std::fs::create_dir_all(&main).unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        git(&main, &["config", "user.email", "t@p.local"]);
        git(&main, &["config", "user.name", "t"]);
        std::fs::write(main.join("x.txt"), "x\n").unwrap();
        git(&main, &["add", "."]);
        git(&main, &["commit", "-q", "-m", "init"]);
        git(
            &main,
            &["worktree", "add", "-b", "feature", linked.to_str().unwrap()],
        );
        (main, linked)
    }

    #[test]
    fn worktrees_list_returns_main_and_linked() {
        let (main, linked) = init_repo_with_worktree("two");
        let entries = worktrees_list_from(&main, &main).expect("list");
        assert_eq!(entries.len(), 2, "got: {entries:?}");

        let main_entry = entries.iter().find(|w| w.id == "main").expect("main entry");
        assert!(main_entry.is_current);
        assert_eq!(main_entry.branch.as_deref(), Some("main"));

        let linked_entry = entries
            .iter()
            .find(|w| w.id != "main")
            .expect("linked entry");
        assert!(!linked_entry.is_current);
        assert_eq!(linked_entry.branch.as_deref(), Some("feature"));
        assert_eq!(linked_entry.path, linked.display().to_string());

        let _ = std::fs::remove_dir_all(&main);
        let _ = std::fs::remove_dir_all(&linked);
    }

    #[test]
    fn worktrees_list_marks_current_when_run_from_linked_worktree() {
        let (main, linked) = init_repo_with_worktree("linked-current");
        let entries = worktrees_list_from(&main, &linked).expect("list");
        let linked_entry = entries
            .iter()
            .find(|w| w.path == linked.display().to_string())
            .expect("linked");
        assert!(linked_entry.is_current);
        let main_entry = entries.iter().find(|w| w.id == "main").expect("main");
        assert!(!main_entry.is_current);

        let _ = std::fs::remove_dir_all(&main);
        let _ = std::fs::remove_dir_all(&linked);
    }

    #[test]
    fn worktree_create_adds_linked_worktree_with_stable_list_id() {
        let main = unique_dir("create-main");
        let linked = unique_dir("create-linked");
        std::fs::create_dir_all(&main).unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        git(&main, &["config", "user.email", "t@p.local"]);
        git(&main, &["config", "user.name", "t"]);
        std::fs::write(main.join("x.txt"), "x\n").unwrap();
        git(&main, &["add", "."]);
        git(&main, &["commit", "-q", "-m", "init"]);

        let created = worktree_create_from(
            &main,
            Some("polypore/worktree/test-create".to_string()),
            Some(linked.display().to_string()),
            None,
        )
        .expect("create worktree");
        assert_eq!(created.branch, "polypore/worktree/test-create");
        assert_eq!(created.path, linked.display().to_string());

        let entries = worktrees_list_from(&main, &main).expect("list");
        let linked_entry = entries
            .iter()
            .find(|w| w.path == linked.display().to_string())
            .expect("linked entry");
        assert_eq!(created.id, linked_entry.id);
        assert_eq!(
            linked_entry.branch.as_deref(),
            Some("polypore/worktree/test-create")
        );

        let _ = std::fs::remove_dir_all(&main);
        let _ = std::fs::remove_dir_all(&linked);
    }

    #[test]
    fn restore_from_snapshot_replaces_working_tree_with_snapshot_content() {
        use crate::snapshotter::{take_snapshot, SnapshotKind};
        let dir = unique_dir("restore");
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.email", "t@p.local"]);
        git(&dir, &["config", "user.name", "t"]);
        std::fs::write(dir.join("a.txt"), "original\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "init"]);

        let snap = take_snapshot(&dir, "main", SnapshotKind::Manual).unwrap();

        std::fs::write(dir.join("a.txt"), "MUTATED\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "MUTATED\n"
        );

        let result =
            restore_from_snapshot(&dir, &snap.commit_hash, &["a.txt".to_string()]).unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "original\n"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_diff_snapshot_mode_diffs_snapshot_against_working_tree() {
        use crate::snapshotter::{take_snapshot, SnapshotKind};
        let dir = unique_dir("diff-snap");
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.email", "t@p.local"]);
        git(&dir, &["config", "user.name", "t"]);
        std::fs::write(dir.join("a.txt"), "old\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "init"]);

        let snap = take_snapshot(&dir, "main", SnapshotKind::Manual).unwrap();
        std::fs::write(dir.join("a.txt"), "new\n").unwrap();

        let result = git_diff(
            "snapshot".to_string(),
            None,
            Some(snap.commit_hash.clone()),
            Some(dir.display().to_string()),
        )
        .expect("diff snapshot");
        assert_eq!(result.mode, "snapshot");
        assert!(result.changed_files.contains(&"a.txt".to_string()));
        assert!(
            result.diff.contains("-old"),
            "diff missing -old: {}",
            result.diff
        );
        assert!(
            result.diff.contains("+new"),
            "diff missing +new: {}",
            result.diff
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_diff_branch_mode_uses_configured_upstream_ref() {
        let dir = unique_dir("diff-upstream");
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "trunk"]);
        git(&dir, &["config", "user.email", "t@p.local"]);
        git(&dir, &["config", "user.name", "t"]);
        std::fs::write(dir.join("a.txt"), "base\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "base"]);
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        git(&dir, &["branch", "--set-upstream-to", "trunk"]);
        std::fs::write(dir.join("a.txt"), "feature\n").unwrap();
        git(&dir, &["commit", "-am", "feature", "-q"]);

        let result = git_diff(
            "branch".to_string(),
            None,
            None,
            Some(dir.display().to_string()),
        )
        .expect("diff branch");

        assert_eq!(result.base_ref.as_deref(), Some("trunk"));
        assert_eq!(result.target_ref.as_deref(), Some("feature"));
        assert!(result.changed_files.contains(&"a.txt".to_string()));
        assert!(
            result.diff.contains("-base"),
            "diff missing base: {}",
            result.diff
        );
        assert!(
            result.diff.contains("+feature"),
            "diff missing feature: {}",
            result.diff
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_diff_snapshot_mode_requires_commit_hash() {
        let dir = unique_dir("diff-no-commit");
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        let result = git_diff(
            "snapshot".to_string(),
            None,
            None,
            Some(dir.display().to_string()),
        );
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_diff_rejects_invalid_commit_hash() {
        let dir = unique_dir("diff-bad");
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        let result = git_diff(
            "snapshot".to_string(),
            None,
            Some("abc; rm -rf /".to_string()),
            Some(dir.display().to_string()),
        );
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_from_snapshot_rejects_non_hex_commit() {
        let result =
            restore_from_snapshot(Path::new("/tmp"), "abc; rm -rf /", &["a.txt".to_string()]);
        assert!(result.is_err());
    }

    #[test]
    fn restore_from_snapshot_rejects_path_escape() {
        let result =
            restore_from_snapshot(Path::new("/tmp"), "abc123", &["../etc/passwd".to_string()]);
        assert!(result.is_err());
    }

    #[test]
    fn parse_worktree_porcelain_handles_detached_head() {
        let common = Path::new("/repo/.git");
        let current = Path::new("/repo");
        let input = "worktree /repo\nHEAD abc123\ndetached\n\n";
        let parsed = parse_worktree_porcelain(input, common, current);
        assert_eq!(parsed.len(), 1);
        assert!(parsed[0].is_detached);
        assert!(parsed[0].branch.is_none());
    }
}
