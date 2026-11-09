//! User config at `$XDG_CONFIG_HOME/polypore/config.toml`. Every field has a
//! default, so a partial file is fine. A commented default file is written on
//! first run.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Config {
    pub ui: Ui,
    pub keys: Keys,
    pub agents: BTreeMap<String, AgentCfg>,
    pub sleep: Sleep,
    pub skills: Skills,
    pub analysis: Analysis,
    pub projects: Projects,
    pub colors: BTreeMap<String, String>,
    pub server: ServerCfg,
    pub hooks: Hooks,
    pub quota: QuotaCfg,
    pub review: ReviewCfg,
    /// Launch presets (`[[presets]]`); a project can add its own in
    /// `.polypore/presets.toml`.
    pub presets: Vec<Preset>,
}

/// A named way to start a session: agent, extra flags, a first prompt,
/// whether it gets its own worktree, and which projects it is for.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Preset {
    pub name: String,
    /// "claude" or "codex".
    pub agent: String,
    /// Added after the agent command, e.g. "--model opus --permission-mode plan".
    pub args: String,
    pub prompt: String,
    pub worktree: bool,
    /// Project folder or name this preset is for; empty means every project.
    pub project: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct PresetFile {
    presets: Vec<Preset>,
}

impl Config {
    /// Presets for `agent` in the project at `root`: the project's own file
    /// first, then config.toml's.
    pub fn presets_for(&self, root: &str, agent: &str) -> Vec<Preset> {
        let name = Path::new(root).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let local: Vec<Preset> = std::fs::read_to_string(Path::new(root).join(".polypore/presets.toml"))
            .ok()
            .and_then(|t| toml::from_str::<PresetFile>(&t).ok())
            .map(|f| f.presets)
            .unwrap_or_default();
        local
            .into_iter()
            .chain(self.presets.iter().filter(|p| p.project.is_empty() || p.project == name || expand(&p.project).to_string_lossy() == root).cloned())
            .filter(|p| p.agent.is_empty() && agent == "claude" || p.agent == agent)
            .filter(|p| !p.name.is_empty())
            .collect()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct ServerCfg {
    /// Terminals live in a background server and keep running after
    /// polypore closes. Off: they close with it.
    pub enabled: bool,
}

impl Default for ServerCfg {
    fn default() -> Self {
        ServerCfg { enabled: true }
    }
}

/// Shell commands run when a session changes state. They get POLYPORE_*
/// variables (see the generated config).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Hooks {
    pub on_needs_you: String,
    pub on_done: String,
    pub on_working: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct QuotaCfg {
    /// Ask Anthropic for claude's 5h/week limits with claude's own login,
    /// when no fresher source (Omarchy's usage record) is around.
    pub claude_probe: bool,
}

impl Default for QuotaCfg {
    fn default() -> Self {
        QuotaCfg { claude_probe: true }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct ReviewCfg {
    /// Headless command that reviews a session's diff (prompt on stdin).
    pub command: String,
}

impl Default for ReviewCfg {
    fn default() -> Self {
        ReviewCfg { command: "claude -p --no-session-persistence".into() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Ui {
    pub theme: String,
    pub border: String,
    pub gaps: u16,
    pub transparent: bool,
    pub animations: bool,
    pub fps: u16,
    pub recent_sessions: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Keys {
    /// "alt": alt+key runs actions directly. "prefix": press `prefix`, then a key.
    pub mode: String,
    pub prefix: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct AgentCfg {
    pub command: String,
    /// Context window in tokens. Claude does not record it, so polypore
    /// shows absolute tokens unless this is set (e.g. 1000000).
    pub context_window: u64,
    pub animation: String,
    pub color: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Sleep {
    pub what: String,
    pub omarchy_stay_awake: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Skills {
    pub source: String,
    pub targets: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Analysis {
    pub command: String,
    pub wiki: String,
    pub max_extract_kb: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Projects {
    pub pinned: Vec<String>,
    pub hidden: Vec<String>,
    pub extra: Vec<String>,
}

impl Default for Ui {
    fn default() -> Self {
        Ui {
            theme: "auto".into(),
            border: "rounded".into(),
            gaps: 1,
            transparent: true,
            animations: true,
            fps: 10,
            recent_sessions: 24,
        }
    }
}

impl Default for Keys {
    fn default() -> Self {
        Keys { mode: "alt".into(), prefix: "ctrl-space".into() }
    }
}

impl Default for Sleep {
    fn default() -> Self {
        Sleep { what: "sleep".into(), omarchy_stay_awake: true }
    }
}

impl Default for Skills {
    fn default() -> Self {
        Skills {
            source: "~/.config/polypore/skills".into(),
            targets: vec!["~/.claude/skills".into(), "~/.codex/skills".into()],
        }
    }
}

impl Default for Analysis {
    fn default() -> Self {
        Analysis {
            command: "claude -p".into(),
            wiki: "~/Dev/memory/wiki".into(),
            max_extract_kb: 120,
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        let mut agents = BTreeMap::new();
        agents.insert(
            "claude".into(),
            AgentCfg { command: "claude".into(), animation: "spark".into(), color: String::new(), context_window: 0 },
        );
        agents.insert(
            "codex".into(),
            AgentCfg { command: "codex".into(), animation: "orbit".into(), color: String::new(), context_window: 0 },
        );
        agents.insert(
            "shell".into(),
            AgentCfg { command: String::new(), animation: "prompt".into(), color: String::new(), context_window: 0 },
        );
        Config {
            ui: Ui::default(),
            keys: Keys::default(),
            agents,
            sleep: Sleep::default(),
            skills: Skills::default(),
            analysis: Analysis::default(),
            projects: Projects::default(),
            colors: BTreeMap::new(),
            server: ServerCfg::default(),
            hooks: Hooks::default(),
            quota: QuotaCfg::default(),
            review: ReviewCfg::default(),
            presets: Vec::new(),
        }
    }
}

impl Config {
    pub fn agent(&self, name: &str) -> AgentCfg {
        let mut base = Config::default().agents.get(name).cloned().unwrap_or_default();
        if let Some(c) = self.agents.get(name) {
            if !c.command.is_empty() {
                base.command = c.command.clone();
            }
            if !c.animation.is_empty() {
                base.animation = c.animation.clone();
            }
            if !c.color.is_empty() {
                base.color = c.color.clone();
            }
            if c.context_window > 0 {
                base.context_window = c.context_window;
            }
        }
        base
    }

    pub fn load() -> (Config, Option<String>) {
        let path = config_path();
        if !path.exists() {
            let _ = std::fs::create_dir_all(config_dir());
            let _ = std::fs::write(&path, DEFAULT_CONFIG);
            let mut c = Config::default();
            c.load_project_state();
            return (c, None);
        }
        match std::fs::read_to_string(&path) {
            Ok(s) => match toml::from_str::<Config>(&s) {
                Ok(mut c) => {
                    c.load_project_state();
                    (c, None)
                }
                Err(e) => {
                    let mut c = Config::default();
                    c.load_project_state();
                    (c, Some(format!("config.toml has an error, using defaults: {}", e.message())))
                }
            },
            Err(e) => (Config::default(), Some(format!("config.toml: {e}"))),
        }
    }

    /// Pins, hidden projects and hand-added folders are app state, kept in
    /// the state dir so config.toml (and its comments) is never rewritten.
    pub fn load_project_state(&mut self) {
        if let Ok(t) = std::fs::read_to_string(state_dir().join("projects.toml")) {
            if let Ok(p) = toml::from_str::<Projects>(&t) {
                for (dst, src) in [(&mut self.projects.pinned, p.pinned), (&mut self.projects.hidden, p.hidden), (&mut self.projects.extra, p.extra)] {
                    for x in src {
                        if !dst.contains(&x) {
                            dst.push(x);
                        }
                    }
                }
            }
        }
    }

    pub fn save_projects(&self) {
        if let Ok(body) = toml::to_string_pretty(&self.projects) {
            let _ = std::fs::write(state_dir().join("projects.toml"), body);
        }
    }

    /// Updates `theme` and `border` under [ui] in place, keeping every other
    /// line and comment of the user's file.
    pub fn save_ui_theme(&self) {
        let path = config_path();
        let text = std::fs::read_to_string(&path).unwrap_or_else(|_| DEFAULT_CONFIG.to_string());
        let text = set_key(&text, "ui", "theme", &format!("\"{}\"", self.ui.theme));
        let _ = std::fs::write(&path, text);
    }
}

fn set_key(text: &str, section: &str, key: &str, value: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut in_sec = false;
    let mut done = false;
    let header = format!("[{section}]");
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            if in_sec && !done {
                out.push(format!("{key} = {value}"));
                done = true;
            }
            in_sec = t == header;
        } else if in_sec && !done {
            let k = t.split('=').next().unwrap_or("").trim();
            if k == key {
                let comment = line.find(" #").map(|i| line[i..].to_string()).unwrap_or_default();
                out.push(format!("{key} = {value}{comment}"));
                done = true;
                continue;
            }
        }
        out.push(line.to_string());
    }
    if !done {
        if !in_sec {
            out.push(String::new());
            out.push(header);
        }
        out.push(format!("{key} = {value}"));
    }
    out.join("\n") + "\n"
}

pub fn expand(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(h) = dirs::home_dir() {
            return h.join(rest);
        }
    }
    if p == "~" {
        return dirs::home_dir().unwrap_or_default();
    }
    PathBuf::from(p)
}

pub fn config_dir() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("polypore")
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.toml")
}

pub fn state_dir() -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".local/state")))
        .unwrap_or_else(|| PathBuf::from("."));
    let d = base.join("polypore");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn claude_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".claude"))
}

pub fn codex_dir() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".codex"))
}

pub fn display_path(p: &Path) -> String {
    crate::model::rel_path(&p.to_string_lossy(), "")
}

pub const DEFAULT_CONFIG: &str = r##"# polypore config. Every key is optional; see `polypore --help`.

[ui]
# auto: your desktop's colors when polypore can read them (Omarchy), else polypore.
# polypore: the original honey-on-brown look.   system: always the desktop palette.
# terminal: only the 16 colors of your terminal.   Others: catppuccin, gruvbox,
# tokyonight, nord, rose-pine, everforest, kanagawa, mono.   T cycles through them.
theme = "auto"
border = "rounded"        # rounded | plain | thick | double | none
gaps = 1                  # empty cells between panes
transparent = true        # leave the background to the terminal (blur, wallpaper)
animations = true
fps = 10
recent_sessions = 24

[keys]
# alt: alt+key runs polypore actions (alt+? lists them); every other key goes to the terminal.
# prefix: press the prefix chord, then a key (tmux style). Use this if alt is taken.
mode = "alt"
prefix = "ctrl-space"

# Per-agent launch command, ASCII animation and (optionally) context window.
# Claude does not record its window size, so polypore shows context as tokens
# unless you set e.g. context_window = 1000000. Built-in animations:
# spark, orbit, pulse, bars, wave, dna, prompt, dots, moon.
# Drop your own in ~/.config/polypore/anims/<name>.txt (frames split by a line with ---).
[agents.claude]
command = "claude"
animation = "spark"

[agents.codex]
command = "codex"
animation = "orbit"

[agents.shell]
animation = "prompt"

# The stay-awake toggle (S) is remembered: once on, polypore keeps the machine
# awake whenever it is open, until you switch it off.
[sleep]
what = "sleep"            # passed to systemd-inhibit --what (sleep:idle:handle-lid-switch blocks more)
omarchy_stay_awake = true # also flip omarchy's stay-awake flag; its shell ignores systemd inhibitors

[skills]
source = "~/.config/polypore/skills"
targets = ["~/.claude/skills", "~/.codex/skills"]

[analysis]
command = "claude -p"     # run headless on your subscription; "codex exec" also works
wiki = "~/Dev/memory/wiki"
max_extract_kb = 120

# Terminals live in a small background server, so agents keep running when
# polypore closes or crashes; reopening picks them up again.
[server]
enabled = true

# Shell commands run when a session changes state. Each gets POLYPORE_STATE,
# POLYPORE_AGENT, POLYPORE_SESSION, POLYPORE_PROJECT, POLYPORE_TITLE and
# POLYPORE_TEXT (the question, or the last reply) in its environment.
[hooks]
# on_needs_you = 'notify-send -u critical "$POLYPORE_AGENT needs you" "$POLYPORE_TEXT"'
# on_done = ''
# on_working = ''

[quota]
# Read claude's 5h/week limits from Anthropic with claude's own login when
# no fresher source is around (Omarchy's usage record is used first).
claude_probe = true

[review]
command = "claude -p --no-session-persistence"   # reviews a session's diff with a fresh context (R on the dash)

# Launch presets: with any for an agent, c (claude) or x (codex) asks which to
# start. A project can keep its own in <project>/.polypore/presets.toml.
# [[presets]]
# name = "plan first"
# agent = "claude"
# args = "--permission-mode plan"
# prompt = ""
# worktree = false        # true: asks for a branch and starts in its own worktree
# project = ""            # a folder or project name; empty means every project

# [colors]                # override any theme role, e.g.
# accent = "#89b4fa"
# claude = "#d97757"
"##;
