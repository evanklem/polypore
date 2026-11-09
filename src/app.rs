//! Application state, event loop and actions.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ratatui::crossterm::event::{
    self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::Rect;
use serde::{Deserialize, Serialize};

use crate::analysis;
use crate::anim::AnimLib;
use crate::config::{self, Config};
use crate::keys;
use crate::layout::{self, Comp, Dir, Handle, LeafKind, Layout, Move, NodeSpec};
use crate::model::*;
use crate::notify::Notifier;
use crate::pane::{Pane, PaneKind, SpawnSpec};
use crate::procs;
use crate::secrets::{self, Approval, Decision};
use crate::skills;
use crate::sleep::Sleep;
use crate::store::{self, Shared, SharedWants};
use crate::theme::Theme;
use crate::wake::Wake;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    Projects,
    Dash,
    Focus,
    Skills,
    Secrets,
    Stats,
}

impl View {
    pub const ALL: [View; 6] = [View::Projects, View::Dash, View::Focus, View::Skills, View::Secrets, View::Stats];
    pub fn label(self) -> &'static str {
        match self {
            View::Projects => "projects",
            View::Dash => "dash",
            View::Focus => "focus",
            View::Skills => "skills",
            View::Secrets => "secrets",
            View::Stats => "stats",
        }
    }
}

pub struct Workspace {
    pub id: u64,
    pub project: String,
    pub name: String,
    pub layout: Layout,
    pub focus: Option<u64>,
    pub zoom: Option<u64>,
    pub observed: Option<RunKey>,
    pub seen: i64,
    pub layout_dirty: bool,
    /// Built around an agent; only these save the project's layout template.
    pub template: bool,
    /// The session's own git worktree, when it was started in one.
    pub worktree: Option<crate::worktree::Worktree>,
}

/// Where and how a new workspace opens.
#[derive(Default)]
pub struct WsOpts {
    pub cwd: Option<String>,
    pub worktree: Option<crate::worktree::Worktree>,
    /// Leave the dash where it is instead of switching to the new session.
    pub background: bool,
    pub name: Option<String>,
}

#[derive(Clone, Debug)]
pub enum Hit {
    Tab(View),
    Project(usize),
    Card(usize),
    Leaf(u64),
    LeafTitle(u64),
    Attention(usize),
    Sleep,
    Approval(usize, Decision),
    Row(usize),
    Palette(usize),
    TreeRow(u64, usize),
}

#[derive(Clone, Debug)]
pub enum Action {
    Quit,
    CloseWorkspace(u64),
    CloseLeaf(u64),
    ImportEnv(String),
    DeleteSecret(String, String),
    WireProject(String),
    AdoptSkill(String),
    RunAnalysis,
    /// Close a worktree session and merge, keep or delete its branch.
    FinishWorktree(u64, WtEnd),
    RevertHunk(u64, usize),
    /// `claude stop` a background job.
    StopJob(RunKey),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WtEnd {
    Merge,
    Keep,
    Delete,
}

#[derive(Clone, Debug)]
pub enum InputKind {
    AddProject,
    NewSkill,
    SecretName,
    SecretValue(String),
    Filter,
    /// A prompt for these sessions: typed in now, queued after the current
    /// turn, or resuming a closed session with it.
    Prompt(Vec<CardId>),
    Rename(CardId),
    /// Branch name for a new session in its own worktree.
    Worktree(PaneKind, Option<crate::config::Preset>),
}

/// A dash row's identity, stable while rows reorder.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum CardId {
    Run(RunKey),
    Ws(u64),
}

/// Which sessions the dash shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusFilter {
    All,
    Needs,
    Working,
    Ready,
    Closed,
    Archived,
}

impl StatusFilter {
    pub const ORDER: [StatusFilter; 6] = [StatusFilter::All, StatusFilter::Needs, StatusFilter::Working, StatusFilter::Ready, StatusFilter::Closed, StatusFilter::Archived];
    pub fn label(self) -> &'static str {
        match self {
            StatusFilter::All => "all",
            StatusFilter::Needs => "needs you",
            StatusFilter::Working => "working",
            StatusFilter::Ready => "ready",
            StatusFilter::Closed => "closed",
            StatusFilter::Archived => "archived",
        }
    }
    #[cfg(test)]
    pub fn admits_pub(self, group: u8, archived: bool) -> bool {
        self.admits(group, archived)
    }

    fn admits(self, group: u8, archived: bool) -> bool {
        match self {
            StatusFilter::Archived => archived,
            _ if archived => false,
            StatusFilter::All => true,
            StatusFilter::Needs => group == 0,
            StatusFilter::Working => group == 1,
            StatusFilter::Ready => group == 2,
            StatusFilter::Closed => group == 4,
        }
    }
}

#[derive(Clone, Debug)]
pub enum PaletteItem {
    Comp(Comp),
    Term(PaneKind),
}

pub enum Overlay {
    Help,
    Palette { sel: usize, items: Vec<PaletteItem> },
    Confirm { msg: Vec<String>, action: Action },
    /// Global transcript search.
    Search { query: String, sel: usize },
    /// `:` command line with completion.
    Command { value: String, sel: usize },
    /// Which preset to start (the first row is the plain agent).
    Presets { agent: PaneKind, items: Vec<crate::config::Preset>, sel: usize },
    /// Several answers, each on its own key.
    Choice { title: String, msg: Vec<String>, options: Vec<(char, String, Action)> },
    Input { prompt: String, value: String, kind: InputKind, secret: bool },
    Report { scroll: u16 },
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Info,
    Ok,
    Warn,
    Err,
}

pub enum Drag {
    Split { handle: Handle },
    Move { from: u64 },
}

#[derive(Clone, Debug)]
pub enum CardKind {
    Hosted(u64),
    Observed(RunKey),
    Recent(RunKey),
}

#[derive(Clone, Debug)]
pub struct Card {
    pub kind: CardKind,
    pub run: Option<RunKey>,
    pub state: RunState,
    /// 0 needs you, 1 working, 2 ready, 3 open terminals, 4 closed
    pub group: u8,
}

pub const GROUPS: [&str; 5] = ["needs you", "working", "ready", "terminals", "closed"];

#[derive(Serialize, Deserialize, Default)]
struct SavedTerm {
    kind: Option<PaneKind>,
    cwd: String,
    run: Option<String>,
    /// The terminal server's id for this pane; reattached when still running.
    #[serde(default)]
    server: Option<u64>,
}

/// How an agent terminal starts: fresh, resumed, forked, with or without a
/// first prompt.
#[derive(Clone, Debug, Default)]
pub struct Launch {
    pub resume: Option<RunKey>,
    pub fork: bool,
    pub prompt: Option<String>,
    /// Extra agent flags (from a preset), placed after the command.
    pub args: String,
    /// The session runs as a claude background job: open it with
    /// `claude attach` instead of resuming a second copy.
    pub attach: bool,
}

impl Launch {
    pub fn resume(k: RunKey) -> Launch {
        Launch { resume: Some(k), ..Default::default() }
    }
}

#[derive(Serialize, Deserialize)]
struct SavedWorkspace {
    project: String,
    name: String,
    layout: NodeSpec,
    terms: Vec<SavedTerm>,
    #[serde(default)]
    worktree: Option<crate::worktree::Worktree>,
}

pub struct App {
    pub cfg: Config,
    pub theme: Theme,
    pub anims: AnimLib,
    pub shared: Shared,
    pub wants: SharedWants,
    pub view: View,
    pub project: Option<String>,
    pub panes: BTreeMap<u64, Pane>,
    next_pane: u64,
    pub workspaces: Vec<Workspace>,
    next_ws: u64,
    pub active_ws: Option<u64>,
    prefix: (KeyModifiers, KeyCode),
    pub alt_mode: bool,
    pub prefix_armed: Option<Instant>,
    pub sel_project: usize,
    pub filter: String,
    pub show_hidden: bool,
    pub sel_card: usize,
    pub status_filter: StatusFilter,
    /// Marked dash rows (space), for bulk resume, prompt, archive, close.
    pub marks: HashSet<CardId>,
    /// Where `!` is in the round of sessions waiting for you.
    attn_turn: usize,
    /// `y` was pressed; the next key says what to copy.
    pub yank_armed: Option<Instant>,
    /// Quota windows already warned about (agent, window, reset time).
    quota_warned: HashSet<String>,
    pub dash_cols: usize,
    pub cards: Vec<Card>,
    pub project_rows: Vec<usize>,
    pub overlay: Option<Overlay>,
    pub toast: Option<(String, Instant, Tone)>,
    pub sleep: Sleep,
    notifier: Notifier,
    pub quit: bool,
    pub leaf_rects: Vec<(u64, Rect)>,
    pub handles: Vec<Handle>,
    drag: Option<Drag>,
    pub hits: Vec<(Rect, Hit)>,
    pub tick0: Instant,
    proc_scan: Instant,
    pub approvals: Vec<Approval>,
    approvals_scan: Instant,
    pub skills: Vec<skills::Skill>,
    pub skills_sel: usize,
    pub skills_usage: Arc<Mutex<Option<HashMap<String, u32>>>>,
    pub skills_log: Vec<String>,
    pub secrets_sel: usize,
    pub secrets_list: Vec<secrets::SecretMeta>,
    pub env_keys: Vec<(PathBuf, Vec<String>)>,
    pub secrets_log: Vec<String>,
    pub analysis: analysis::Shared,
    pub stats_scroll: u16,
    pub leaf_scroll: HashMap<u64, u16>,
    pub file_lists: Arc<Mutex<HashMap<String, (Instant, Vec<String>)>>>,
    pub trees: HashMap<u64, crate::tree::TreeState>,
    theme_stamp: Option<std::time::SystemTime>,
    theme_check: Instant,
    restored: HashSet<String>,
    saved: Vec<SavedWorkspace>,
    last_save: Instant,
    pub dirty: bool,
    /// Stay-awake state as of this frame.
    pub awake: bool,
    /// Workspace to select in the session list after leaving it.
    reselect: Option<u64>,
    pub size: (u16, u16),
    pub outer_kitty: bool,
    /// The terminal server that owns the ptys, when it could be reached.
    pub server: Option<Arc<crate::server::Conn>>,
    meta_sent: HashMap<u64, String>,
    /// Names and archive marks you gave sessions.
    pub smeta: crate::meta::SessionMeta,
    tracker: crate::cli::Tracker,
    adopt_scan: Instant,
    /// Prompts waiting for a session's current turn to end.
    pub queue: HashMap<RunKey, Vec<String>>,
    /// Claude and codex limits, freshest source first.
    pub quota: crate::quota::Shared,
    /// Handoff workspaces and the session they continue.
    pub origins: HashMap<u64, RunKey>,
    pub reviews: crate::review::Shared,
    /// Per diff panel: which hunk is selected, and whether it shows every
    /// change or only the session's files.
    pub diff_views: HashMap<u64, DiffView>,
    pub hunk_cache: Arc<Mutex<HashMap<String, (Instant, Arc<Vec<crate::hunks::FileDiff>>)>>>,
    pub search: crate::search::Shared,
    /// The hits shown in the search overlay, as of the last draw.
    /// Workspaces already warned about running another project's session.
    pub misplaced_warned: HashSet<u64>,
    pub search_hits: Vec<crate::search::Hit>,
}

#[derive(Default, Clone)]
pub struct DiffView {
    pub sel: usize,
    pub all: bool,
}

impl App {
    pub fn new(cfg: Config, config_error: Option<String>) -> App {
        let theme = Theme::from_config(&cfg);
        let mut names: Vec<String> = ["claude", "codex", "shell"].iter().map(|a| cfg.agent(a).animation).collect();
        names.dedup();
        let anims = AnimLib::load(&names);
        let missing: Vec<String> = names.iter().filter(|n| !crate::anim::exists(n)).cloned().collect();
        let config_error = config_error.or_else(|| (!missing.is_empty()).then(|| format!("unknown animation {}; using spark. built-ins: {}", missing.join(", "), crate::anim::BUILTINS.join(" "))));
        let (shared, wants) = store::spawn(cfg.ui.recent_sessions);
        let quota = crate::quota::spawn(shared.clone(), cfg.quota.claude_probe);
        let prefix = keys::parse_chord(&cfg.keys.prefix);
        let cfg_alt = cfg.keys.mode != "prefix";
        let mut saved = load_saved();
        let _ = std::fs::write(secrets::tui_pid_path(), std::process::id().to_string());
        let (server, server_err) = if cfg.server.enabled {
            match crate::server::Conn::connect(true) {
                Ok(c) => (Some(c), None),
                Err(e) => (None, Some(format!("{e}; terminals will close with polypore"))),
            }
        } else {
            (None, None)
        };
        let config_error = config_error.or(server_err);
        if let Some(c) = &server {
            adopt_orphans(c, &mut saved);
        }
        App {
            cfg,
            theme,
            anims,
            shared,
            wants,
            view: View::Projects,
            project: None,
            panes: BTreeMap::new(),
            next_pane: 1,
            workspaces: Vec::new(),
            next_ws: 1,
            active_ws: None,
            prefix,
            alt_mode: cfg_alt,
            prefix_armed: None,
            sel_project: 0,
            filter: String::new(),
            show_hidden: false,
            sel_card: 0,
            status_filter: StatusFilter::All,
            marks: HashSet::new(),
            attn_turn: 0,
            yank_armed: None,
            quota_warned: HashSet::new(),
            dash_cols: 1,
            cards: Vec::new(),
            project_rows: Vec::new(),
            overlay: None,
            toast: config_error.map(|e| (e, Instant::now(), Tone::Err)),
            sleep: Sleep::new(),
            notifier: Notifier::new(),
            quit: false,
            leaf_rects: Vec::new(),
            handles: Vec::new(),
            drag: None,
            hits: Vec::new(),
            tick0: Instant::now(),
            proc_scan: Instant::now() - Duration::from_secs(10),
            approvals: Vec::new(),
            approvals_scan: Instant::now() - Duration::from_secs(10),
            skills: Vec::new(),
            skills_sel: 0,
            skills_usage: Arc::new(Mutex::new(None)),
            skills_log: Vec::new(),
            secrets_sel: 0,
            secrets_list: Vec::new(),
            env_keys: Vec::new(),
            secrets_log: Vec::new(),
            analysis: Arc::new(Mutex::new(analysis::State::default())),
            stats_scroll: 0,
            leaf_scroll: HashMap::new(),
            file_lists: Arc::new(Mutex::new(HashMap::new())),
            trees: HashMap::new(),
            theme_stamp: crate::theme::system_colors_path().and_then(|p| std::fs::metadata(p).ok()).and_then(|m| m.modified().ok()),
            theme_check: Instant::now(),
            restored: HashSet::new(),
            saved,
            last_save: Instant::now(),
            dirty: true,
            awake: false,
            reselect: None,
            size: (80, 24),
            outer_kitty: false,
            server,
            meta_sent: HashMap::new(),
            smeta: crate::meta::SessionMeta::load(),
            tracker: crate::cli::Tracker::default(),
            adopt_scan: Instant::now(),
            queue: HashMap::new(),
            quota,
            origins: HashMap::new(),
            reviews: crate::review::load_all(),
            diff_views: HashMap::new(),
            hunk_cache: Arc::new(Mutex::new(HashMap::new())),
            search: Arc::new(Mutex::new(crate::search::Index::default())),
            search_hits: Vec::new(),
            misplaced_warned: HashSet::new(),
        }
    }

    /// Projects with terminals still running in the server come back at
    /// once, so the dash and the attention strip see them before you open
    /// the project.
    pub fn restore_running(&mut self) {
        let Some(conn) = self.server.clone() else { return };
        let live: HashSet<u64> = conn.list().unwrap_or_default().into_iter().filter(|p| p.exited.is_none()).map(|p| p.id).collect();
        let roots: Vec<String> = self
            .saved
            .iter()
            .filter(|s| s.terms.iter().any(|t| t.server.map(|id| live.contains(&id)).unwrap_or(false)))
            .map(|s| s.project.clone())
            .collect();
        let mut n = 0;
        for root in roots {
            if self.restored.insert(root.clone()) {
                n += self.restore_workspaces(&root);
            }
        }
        if n > 0 {
            self.say(format!("back in {} that kept running", plural_s(n, "session", "sessions")), Tone::Ok);
        }
    }

    /// Terminals started in the server while the dashboard runs (by
    /// `polypore send`, or another dashboard) get a workspace here too.
    fn adopt_new_panes(&mut self) {
        let Some(conn) = self.server.clone() else { return };
        if !conn.is_alive() {
            return;
        }
        let mut have: HashSet<u64> = self.panes.values().filter_map(|p| p.server_id).collect();
        have.extend(self.saved.iter().flat_map(|s| s.terms.iter().filter_map(|t| t.server)));
        let mut fresh: Vec<SavedWorkspace> = Vec::new();
        {
            // adopt_orphans only adds panes no saved workspace knows.
            let mut known: Vec<SavedWorkspace> = have.iter().map(|id| SavedWorkspace { project: String::new(), name: String::new(), layout: NodeSpec::Term { slot: 0, role: String::new() }, terms: vec![SavedTerm { server: Some(*id), ..Default::default() }], worktree: None }).collect();
            let n = known.len();
            adopt_orphans(&conn, &mut known);
            fresh.extend(known.drain(n..));
        }
        if fresh.is_empty() {
            return;
        }
        let roots: HashSet<String> = fresh.iter().map(|s| s.project.clone()).collect();
        self.saved.extend(fresh);
        let mut n = 0;
        for root in roots {
            // Projects already open take the new workspaces now; others when opened.
            if self.restored.contains(&root) {
                n += self.restore_workspaces(&root);
            }
        }
        if n > 0 {
            self.say(format!("picked up {} started outside the dashboard", plural_s(n, "session", "sessions")), Tone::Ok);
            self.save_workspaces();
        }
    }

    /// Hosted panes still alive in the server, for the quit message.
    pub fn running_in_server(&self) -> usize {
        self.panes.values().filter(|p| p.is_remote() && p.exited.is_none()).count()
    }

    /// A session's title: the name you gave it, else the agent's own.
    pub fn title_of(&self, r: &AgentRun) -> String {
        self.smeta.name(&r.key).map(String::from).unwrap_or_else(|| r.display_title())
    }

    pub fn tick_ms(&self) -> u64 {
        self.tick0.elapsed().as_millis() as u64
    }

    pub fn say(&mut self, msg: impl Into<String>, tone: Tone) {
        self.toast = Some((msg.into(), Instant::now(), tone));
        self.dirty = true;
    }

    // ---------- main loop ----------

    pub fn run(&mut self, term: &mut ratatui::DefaultTerminal) -> anyhow::Result<()> {
        self.restore_awake();
        self.restore_running();
        let mut last_draw = Instant::now() - Duration::from_secs(1);
        let (tx, rx) = std::sync::mpsc::channel();
        crate::wake::install(tx.clone());
        std::thread::Builder::new().name("polypore-input".into()).spawn(move || loop {
            match event::read() {
                Ok(ev) => {
                    if tx.send(Wake::Input(ev)).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Wake::Lost(e.to_string()));
                    break;
                }
            }
        })?;
        // Output-driven redraws are capped at ~200 fps; input and output both
        // wake the loop right away instead of waiting out the idle timeout.
        let min_gap = Duration::from_millis(5);
        while !self.quit {
            crate::wake::clear();
            let mut active = false;
            let ids: Vec<u64> = self.panes.keys().copied().collect();
            let visible_now = self.visible_panes();
            for id in ids {
                let Some(p) = self.panes.get_mut(&id) else { continue };
                if p.pump() {
                    self.dirty = true;
                    active = true;
                }
                let (bell, notify, clip) = p.take_signals();
                if let Some(c) = clip {
                    copy_to_outer_clipboard(&c);
                }
                if bell || notify.is_some() {
                    let visible = visible_now.contains(&id);
                    let msg = notify.clone().unwrap_or_else(|| "bell".into());
                    if !visible {
                        p.attention = Some(msg.clone());
                    }
                    if let Some(n) = notify {
                        let label = p.detected.map(|k| k.label()).unwrap_or("terminal");
                        let proj = Path::new(&p.cwd).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                        self.notifier.send(&format!("pane-{id}"), &format!("{label} · {proj}"), &n);
                    }
                    self.dirty = true;
                }
            }
            self.periodic();
            let animating = self.animating();
            let frame_due = animating && last_draw.elapsed() >= Duration::from_millis(1000 / self.cfg.ui.fps.max(1) as u64);
            let since = last_draw.elapsed();
            if (self.dirty && since >= min_gap) || frame_due || since > Duration::from_secs(1) {
                self.dirty = false;
                term.draw(|f| self.draw(f))?;
                last_draw = Instant::now();
            }
            // `active` covers a pane that hit its drain budget with output
            // still queued and no fresh nudge coming.
            let timeout = if self.dirty || active {
                min_gap.saturating_sub(last_draw.elapsed())
            } else if animating {
                Duration::from_millis(30)
            } else {
                Duration::from_millis(120)
            };
            let mut next = rx.recv_timeout(timeout).ok();
            // Drain a burst of events before redrawing.
            let mut n = 0;
            while let Some(w) = next.take() {
                match w {
                    Wake::Input(ev) => {
                        self.on_event(ev);
                        self.dirty = true;
                    }
                    Wake::Output => {}
                    Wake::Lost(e) => anyhow::bail!("reading the terminal: {e}"),
                }
                n += 1;
                if n > 256 {
                    break;
                }
                next = rx.try_recv().ok();
            }
        }
        self.save_workspaces();
        self.save_layouts();
        let _ = std::fs::remove_file(secrets::tui_pid_path());
        Ok(())
    }

    fn animating(&self) -> bool {
        if !self.cfg.ui.animations {
            return false;
        }
        if self.prefix_armed.is_some() {
            return false;
        }
        let snap = self.shared.lock().unwrap();
        let now = now_ms();
        match self.view {
            View::Dash => self.cards.iter().any(|c| c.state == RunState::Working),
            View::Focus => self
                .active_run()
                .and_then(|k| snap.runs.get(&k).cloned())
                .map(|r| r.state(now) == RunState::Working)
                .unwrap_or(false),
            View::Projects => snap.runs.values().any(|r| r.is_live() && r.state(now) == RunState::Working),
            _ => false,
        }
    }

    fn periodic(&mut self) {
        if self.proc_scan.elapsed() > Duration::from_millis(1500) {
            self.proc_scan = Instant::now();
            self.scan_panes();
            self.check_transitions();
        }
        if self.adopt_scan.elapsed() > Duration::from_secs(4) {
            self.adopt_scan = Instant::now();
            self.adopt_new_panes();
            self.check_quota();
        }
        if let Some(t) = self.yank_armed {
            if t.elapsed() > Duration::from_secs(3) {
                self.yank_armed = None;
                self.dirty = true;
            }
        }
        if self.approvals_scan.elapsed() > Duration::from_millis(700) {
            self.approvals_scan = Instant::now();
            let a = secrets::pending_approvals();
            if a.len() != self.approvals.len() {
                if a.len() > self.approvals.len() {
                    if let Some(x) = a.last() {
                        self.notifier.send("approval", "polypore: approve secret use?", &format!("{} · {}", x.secrets.join(","), x.target));
                    }
                }
                self.dirty = true;
            }
            self.approvals = a;
        }
        if let Some((_, t, _)) = &self.toast {
            if t.elapsed() > Duration::from_secs(5) {
                self.toast = None;
                self.dirty = true;
            }
        }
        if let Some(t) = self.prefix_armed {
            if t.elapsed() > Duration::from_secs(3) {
                self.prefix_armed = None;
                self.dirty = true;
            }
        }
        if self.theme_check.elapsed() > Duration::from_secs(2) && matches!(self.cfg.ui.theme.as_str(), "auto" | "system") {
            self.theme_check = Instant::now();
            let stamp = crate::theme::system_colors_path().and_then(|p| std::fs::metadata(p).ok()).and_then(|m| m.modified().ok());
            if stamp != self.theme_stamp {
                self.theme_stamp = stamp;
                self.theme = Theme::from_config(&self.cfg);
                self.dirty = true;
            }
        }
        if self.last_save.elapsed() > Duration::from_secs(30) {
            self.last_save = Instant::now();
            self.save_workspaces();
        }
        let usage_ready = self.skills_usage.lock().unwrap().is_some();
        if self.view == View::Skills && usage_ready && self.skills.iter().all(|s| s.uses == 0) {
            self.refresh_skills();
        }
    }

    /// Detects agents inside panes and links them to sessions.
    fn scan_panes(&mut self) {
        if self.panes.is_empty() {
            self.wants.lock().unwrap().pinned.clear();
            return;
        }
        let table = procs::table();
        let mut pinned = HashSet::new();
        for p in self.panes.values_mut() {
            if p.exited.is_some() {
                continue;
            }
            let Some(pid) = p.pid else { continue };
            p.fg = procs::foreground(pid, &table).filter(|n| !matches!(n.as_str(), "bash" | "zsh" | "fish" | "sh" | "dash" | "nu" | "xonsh"));
            // The pane's own process (the shell, or the agent it runs) is
            // where the user is. Its newest descendant is often a helper
            // such as an editor's git or LSP child sitting in some file's
            // folder, which would send new splits there.
            #[cfg(target_os = "linux")]
            if let Some(c) = procs::cwd_of(pid) {
                if !c.is_empty() {
                    p.cwd = c;
                }
            }
            match procs::detect(pid, &table, &p.cwd, p.created) {
                Some(d) => {
                    p.detected = Some(d.kind);
                    if let Some(r) = d.run {
                        p.run = Some(r);
                    }
                }
                None => {
                    p.detected = None;
                }
            }
            if let Some(r) = &p.run {
                pinned.insert(r.clone());
            }
        }
        for ws in &self.workspaces {
            if let Some(o) = &ws.observed {
                pinned.insert(o.clone());
            }
        }
        self.wants.lock().unwrap().pinned = pinned;
        self.sync_meta();
    }

    /// Tells the server what each of its panes is (project, workspace name,
    /// agent session), for the CLI and for the next dashboard.
    fn sync_meta(&mut self) {
        let Some(conn) = self.server.clone() else { return };
        for ws in &self.workspaces {
            for t in ws.layout.terms() {
                let Some(p) = self.panes.get(&t) else { continue };
                let Some(sid) = p.server_id else { continue };
                let meta = crate::server::Meta { project: ws.project.clone(), name: ws.name.clone(), run: p.run.clone(), workspace: Some(ws.id.to_string()) };
                let sig = format!("{}|{}|{:?}", meta.project, meta.name, meta.run);
                if self.meta_sent.get(&sid) != Some(&sig) {
                    conn.set_meta(sid, &meta);
                    self.meta_sent.insert(sid, sig);
                }
            }
        }
    }

    fn check_transitions(&mut self) {
        let shared = self.shared.clone();
        let snap = shared.lock().unwrap();
        let now = now_ms();
        let focused = self.active_run();
        let hosted: HashSet<RunKey> = self.panes.values().filter(|p| p.exited.is_none()).filter_map(|p| p.run.clone()).collect();
        let changes = self.tracker.step(&snap, &hosted, now);
        let mut notes = Vec::new();
        let mut queued: Vec<(RunKey, String)> = Vec::new();
        for c in changes {
            let Some(r) = snap.runs.get(&c.key) else { continue };
            let root = snap.sessions.get(&c.key).map(|s| s.root.clone()).unwrap_or_else(|| r.cwd.clone());
            let title = self.title_of(r);
            crate::cli::fire_hooks(&self.cfg, &c, r, &root, &title);
            // A prompt queued for after this turn goes in once it is ready
            // (not into a question it stopped to ask).
            if c.from == RunState::Working && c.to == RunState::Ready {
                if let Some(q) = self.queue.get_mut(&c.key).filter(|q| !q.is_empty()) {
                    queued.push((c.key.clone(), q.remove(0)));
                }
            }
            if focused.as_ref() == Some(&c.key) && self.view == View::Focus {
                continue;
            }
            let proj = Path::new(&r.cwd).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if c.to == RunState::NeedsInput {
                let what = r.question.clone().or(r.approval.clone()).unwrap_or_else(|| "waiting for you".into());
                notes.push((format!("need-{}", c.key.id), format!("{} needs you · {proj}", c.key.kind.label()), what));
            } else if c.from == RunState::Working && c.to == RunState::Ready {
                notes.push((format!("done-{}", c.key.id), format!("{} finished · {proj}", c.key.kind.label()), one_line(&r.last_reply, 120)));
            }
        }
        drop(snap);
        for (key, t, b) in notes {
            self.notifier.send(&key, &t, &b);
        }
        for (key, text) in queued {
            if let Some(p) = self.pane_for_run(&key) {
                if let Some(pane) = self.panes.get_mut(&p) {
                    pane.send_prompt(&text);
                    self.say(format!("sent your queued prompt to {}", short_id(&key.id)), Tone::Ok);
                }
            }
        }
        self.queue.retain(|_, q| !q.is_empty());
    }

    pub fn visible_panes(&self) -> Vec<u64> {
        if self.view != View::Focus {
            return Vec::new();
        }
        self.active().map(|w| w.layout.terms()).unwrap_or_default()
    }

    pub fn active(&self) -> Option<&Workspace> {
        self.active_ws.and_then(|id| self.workspaces.iter().find(|w| w.id == id))
    }

    fn active_mut(&mut self) -> Option<&mut Workspace> {
        let id = self.active_ws?;
        self.workspaces.iter_mut().find(|w| w.id == id)
    }

    /// The agent run a workspace's components bind to: the first agent
    /// terminal in the layout, or the observed run.
    pub fn ws_run(&self, ws: &Workspace) -> Option<RunKey> {
        for t in ws.layout.terms() {
            if let Some(p) = self.panes.get(&t) {
                if p.detected.is_some() {
                    if let Some(r) = &p.run {
                        return Some(r.clone());
                    }
                }
            }
        }
        ws.observed.clone()
    }

    pub fn ws_agent_pane(&self, ws: &Workspace) -> Option<u64> {
        ws.layout.terms().into_iter().find(|t| self.panes.get(t).map(|p| p.detected.is_some()).unwrap_or(false))
    }

    pub fn ws_has_agent(&self, ws: &Workspace) -> bool {
        ws.observed.is_some() || self.ws_agent_pane(ws).is_some()
    }

    pub fn active_run(&self) -> Option<RunKey> {
        self.active().and_then(|w| self.ws_run(w))
    }

    pub fn pane_for_run(&self, k: &RunKey) -> Option<u64> {
        self.panes.iter().find(|(_, p)| p.run.as_ref() == Some(k) && p.exited.is_none()).map(|(i, _)| *i)
    }

    fn ws_for_pane(&self, pane: u64) -> Option<u64> {
        self.workspaces.iter().find(|w| w.layout.terms().contains(&pane)).map(|w| w.id)
    }

    // ---------- projects ----------

    pub fn visible_projects(&self, snap: &store::Snapshot) -> Vec<usize> {
        let state = config::state_dir().to_string_lossy().to_string();
        let f = self.filter.to_lowercase();
        let mut idx: Vec<usize> = (0..snap.projects.len())
            .filter(|&i| {
                let p = &snap.projects[i];
                if p.root.starts_with(&state) {
                    return false;
                }
                if !self.show_hidden && self.cfg.projects.hidden.contains(&p.root) {
                    return false;
                }
                f.is_empty() || p.name.to_lowercase().contains(&f) || p.root.to_lowercase().contains(&f)
            })
            .collect();
        idx.sort_by_key(|&i| {
            let p = &snap.projects[i];
            let pinned = self.cfg.projects.pinned.contains(&p.root);
            (if pinned { 0 } else { 1 }, -p.last)
        });
        // Folders added by hand with no sessions yet.
        idx
    }

    pub fn open_project(&mut self, root: String) {
        self.project = Some(root.clone());
        self.wants.lock().unwrap().project = Some(root.clone());
        self.view = View::Dash;
        self.sel_card = 0;
        self.filter.clear();
        if !self.restored.contains(&root) {
            self.restored.insert(root.clone());
            let n = self.restore_workspaces(&root);
            if n > 0 {
                self.say(format!("restored {n} workspace{}", if n == 1 { "" } else { "s" }), Tone::Ok);
            }
        }
    }

    // ---------- cards ----------

    /// Every session of the open project, grouped by what it needs from
    /// you and sorted by recency inside each group.
    pub fn build_cards(&mut self, snap: &store::Snapshot) {
        let Some(root) = self.project.clone() else {
            self.cards.clear();
            return;
        };
        let now = now_ms();
        let f = self.filter.to_lowercase();
        let mut rows: Vec<(u8, i64, Card)> = Vec::new();
        let mut shown: HashSet<RunKey> = HashSet::new();
        let mut misplaced: Vec<(u64, String)> = Vec::new();
        for ws in self.workspaces.iter().filter(|w| w.project == root) {
            let run = self.ws_run(ws);
            let agent_live = self.ws_agent_pane(ws).is_some();
            let state = match run.as_ref().and_then(|k| snap.runs.get(k)) {
                Some(r) => r.state_hosted(now, agent_live),
                None if agent_live => RunState::Ready,
                None if ws.observed.is_some() => RunState::Closed,
                None => RunState::Ready,
            };
            if let Some(other) = run.as_ref().and_then(|k| snap.sessions.get(k)).map(|s| s.root.clone()).filter(|r| !r.is_empty() && *r != ws.project) {
                if !self.misplaced_warned.contains(&ws.id) {
                    let name = Path::new(&other).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(other.clone());
                    misplaced.push((ws.id, format!("\"{}\" is a {name} session running in this project's folder; d closes it here, then resume it from {name}", ws.name)));
                }
            }
            let shell_only = !agent_live && ws.observed.is_none();
            let group = if shell_only { 3 } else { group_of(state) };
            if let Some(r) = &run {
                shown.insert(r.clone());
            }
            let updated = run.as_ref().and_then(|k| snap.runs.get(k)).map(|r| r.updated).unwrap_or(ws.seen);
            rows.push((group, updated, Card { kind: CardKind::Hosted(ws.id), run, state, group }));
        }
        for (id, msg) in misplaced {
            self.misplaced_warned.insert(id);
            self.say(msg, Tone::Warn);
        }
        if let Some(p) = snap.projects.iter().find(|p| p.root == root) {
            for k in p.sessions.iter().take(self.cfg.ui.recent_sessions.max(8)) {
                if shown.contains(k) {
                    continue;
                }
                let r = snap.runs.get(k);
                let state = r.map(|r| r.state(now)).unwrap_or(RunState::Closed);
                if !f.is_empty() {
                    let title = self
                        .smeta
                        .name(k)
                        .map(String::from)
                        .or_else(|| r.map(|r| r.display_title()))
                        .or_else(|| snap.sessions.get(k).map(|s| s.title.clone()))
                        .unwrap_or_default();
                    if !title.to_lowercase().contains(&f) {
                        continue;
                    }
                }
                shown.insert(k.clone());
                let updated = r.map(|r| r.updated).or_else(|| snap.sessions.get(k).map(|s| s.mtime)).unwrap_or(0);
                let kind = if state == RunState::Closed { CardKind::Recent(k.clone()) } else { CardKind::Observed(k.clone()) };
                rows.push((group_of(state), updated, Card { kind, run: Some(k.clone()), state, group: group_of(state) }));
            }
        }
        // Live sessions in this project that are not in the recent list yet.
        for r in snap.runs.values() {
            if shown.contains(&r.key) || !snap.sessions.get(&r.key).map(|s| s.root == root).unwrap_or(false) {
                continue;
            }
            let state = r.state(now);
            if state == RunState::Closed {
                continue;
            }
            shown.insert(r.key.clone());
            rows.push((group_of(state), r.updated, Card { kind: CardKind::Observed(r.key.clone()), run: Some(r.key.clone()), state, group: group_of(state) }));
        }
        let sf = self.status_filter;
        rows.retain(|(g, _, c)| {
            let archived = c.run.as_ref().map(|k| self.smeta.is_archived(k)).unwrap_or(false) && !matches!(c.kind, CardKind::Hosted(_));
            sf.admits(*g, archived)
        });
        rows.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
        let selected = self.cards.get(self.sel_card).map(|c| (c.run.clone(), card_ws(c)));
        self.cards = rows.into_iter().map(|r| r.2).collect();
        // Keep the selection on the same session when rows reorder.
        if let Some((run, ws)) = selected {
            if let Some(i) = self.cards.iter().position(|c| (run.is_some() && c.run == run) || (ws.is_some() && card_ws(c) == ws)) {
                self.sel_card = i;
            }
        }
        if let Some(ws) = self.reselect.take() {
            if let Some(i) = self.cards.iter().position(|c| card_ws(c) == Some(ws)) {
                self.sel_card = i;
            }
        }
        if self.sel_card >= self.cards.len() {
            self.sel_card = self.cards.len().saturating_sub(1);
        }
    }

    fn open_card(&mut self, i: usize) {
        let Some(card) = self.cards.get(i).cloned() else { return };
        match card.kind {
            CardKind::Hosted(ws) => self.focus_ws(ws),
            CardKind::Observed(k) => {
                if let Some(p) = self.pane_for_run(&k) {
                    if let Some(ws) = self.ws_for_pane(p) {
                        self.focus_ws(ws);
                        return;
                    }
                }
                self.observe(k);
            }
            CardKind::Recent(k) => self.observe(k),
        }
    }

    fn resume_card(&mut self, i: usize) {
        let Some(card) = self.cards.get(i).cloned() else { return };
        if let CardKind::Hosted(ws) = card.kind {
            self.focus_ws(ws);
            return;
        }
        let Some(k) = card.run else { return };
        self.resume_session(k);
    }

    /// Resumes a session in a polypore terminal, in its own project and
    /// folder. One polypore already runs is focused; one a claude
    /// background job holds is attached (`claude attach`); one running in
    /// some other terminal opens read-only, since two agents writing one
    /// transcript would garble it.
    fn resume_session(&mut self, k: RunKey) {
        if let Some(ws) = self.pane_for_run(&k).and_then(|p| self.ws_for_pane(p)) {
            self.focus_ws(ws);
            return;
        }
        let (live, job) = self.shared.lock().unwrap().runs.get(&k).map(|r| (r.is_live(), r.background_job)).unwrap_or((false, false));
        let job = job && k.kind == AgentKind::Claude;
        if live && !job {
            let msg = self.elsewhere_msg(&k);
            self.say(msg, Tone::Warn);
            self.observe(k);
            return;
        }
        let cwd = self.enter_session_project(&k);
        let pk = match k.kind {
            AgentKind::Claude => PaneKind::Claude,
            AgentKind::Codex => PaneKind::Codex,
        };
        // An attached job's observed view is replaced by the terminal.
        if job {
            if let Some(id) = self.workspaces.iter().find(|w| w.observed.as_ref() == Some(&k)).map(|w| w.id) {
                self.close_workspace_now(id);
            }
        }
        self.new_workspace_with(Some(pk), Launch { resume: Some(k), attach: job, ..Default::default() }, WsOpts { cwd, ..Default::default() });
    }

    /// Why polypore won't resume a session, and what to do about it.
    fn elsewhere_msg(&self, k: &RunKey) -> String {
        match self.shared.lock().unwrap().runs.get(k).and_then(|r| r.live_pid) {
            Some(pid) => format!("running in another terminal (pid {pid}); quit it there to resume it here"),
            None => "running in another terminal; quit it there to resume it here".into(),
        }
    }

    /// The project and folder a session belongs to, from its transcript.
    fn session_home(&self, k: &RunKey) -> Option<(String, String)> {
        let snap = self.shared.lock().unwrap();
        let s = snap.sessions.get(k)?;
        (!s.root.is_empty()).then(|| (s.root.clone(), s.cwd.clone()))
    }

    /// Opens a session's own project, so viewing or resuming it never
    /// lands in whichever project happened to be open. Returns the folder
    /// to resume it in.
    fn enter_session_project(&mut self, k: &RunKey) -> Option<String> {
        let (root, cwd) = self.session_home(k)?;
        if self.project.as_deref() != Some(root.as_str()) {
            self.open_project(root);
        }
        Path::new(&cwd).is_dir().then_some(cwd)
    }

    /// `d` on a session polypore does not run: stop it if it is a claude
    /// background job, else say where it runs.
    fn close_unhosted(&mut self, k: RunKey) {
        let (live, job) = self.shared.lock().unwrap().runs.get(&k).map(|r| (r.is_live(), r.background_job)).unwrap_or((false, false));
        if live && job && k.kind == AgentKind::Claude {
            self.overlay = Some(Overlay::Confirm {
                msg: vec![format!("stop background job {}?", job_short(&k.id)), "the conversation is kept; r resumes it later.".into()],
                action: Action::StopJob(k),
            });
        } else if live {
            let msg = self.elsewhere_msg(&k);
            self.say(msg.replace("to resume it here", "to close it"), Tone::Warn);
        } else {
            self.say("that session is already closed; A archives it", Tone::Info);
        }
    }

    fn stop_job(&mut self, k: &RunKey) {
        let cmd = format!("{} stop {}", self.cfg.agent("claude").command, job_short(&k.id));
        let short = job_short(&k.id).to_string();
        match std::process::Command::new("sh").arg("-c").arg(&cmd).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn() {
            Ok(mut child) => {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                self.say(format!("stopping background job {short}"), Tone::Ok);
            }
            Err(e) => self.say(format!("could not run {cmd}: {e}"), Tone::Err),
        }
    }

    fn observe(&mut self, k: RunKey) {
        if let Some(ws) = self.workspaces.iter().find(|w| w.observed.as_ref() == Some(&k)).map(|w| w.id) {
            self.focus_ws(ws);
            return;
        }
        self.enter_session_project(&k);
        let Some(root) = self.project.clone() else { return };
        let mut layout = Layout::empty();
        // Read-only view: the conversation where the terminal would be,
        // the inspector beside it.
        let a = layout.split(None, LeafKind::Comp(Comp::Activity), Dir::H, 0.66);
        layout.split(Some(a), LeafKind::Comp(Comp::Inspector), Dir::H, 0.66);
        let title = self.shared.lock().unwrap().runs.get(&k).map(|r| r.display_title()).unwrap_or_else(|| short_id(&k.id).to_string());
        let id = self.next_ws;
        self.next_ws += 1;
        self.workspaces.push(Workspace {
            id,
            project: root,
            name: one_line(&title, 30),
            layout,
            focus: Some(a),
            zoom: None,
            observed: Some(k.clone()),
            seen: now_ms(),
            layout_dirty: false,
            template: false,
            worktree: None,
        });
        self.wants.lock().unwrap().pinned.insert(k);
        self.focus_ws(id);
    }

    pub fn focus_ws(&mut self, id: u64) {
        // The open project follows the session, so going back, splitting
        // or resuming from here stays in the session's own project.
        if let Some(root) = self.workspaces.iter().find(|w| w.id == id).map(|w| w.project.clone()) {
            if self.project.as_deref() != Some(root.as_str()) {
                self.open_project(root);
            }
        }
        self.active_ws = Some(id);
        self.view = View::Focus;
        let panes = self.workspaces.iter().find(|w| w.id == id).map(|w| w.layout.terms()).unwrap_or_default();
        for p in panes {
            if let Some(p) = self.panes.get_mut(&p) {
                p.attention = None;
            }
        }
        if let Some(w) = self.active_mut() {
            w.seen = now_ms();
            if w.focus.is_none() {
                w.focus = w.layout.leaves().first().map(|l| l.0);
            }
        }
    }

    // ---------- spawning ----------

    pub fn agent_command(&self, kind: PaneKind, launch: &Launch) -> Option<String> {
        agent_command(&self.cfg, kind, launch)
    }

    fn spawn_pane(&mut self, kind: PaneKind, cwd: &str, launch: &Launch) -> Option<u64> {
        let project = self.project.clone().unwrap_or_else(|| cwd.to_string());
        let (rows, cols) = (self.size.1.saturating_sub(4).max(10), self.size.0.saturating_sub(4).max(20));
        let (env_remove, env_set, scrubbed) = match kind {
            PaneKind::Shell => (Vec::new(), secrets::inject_env(&project), false),
            _ => {
                let (r, s) = secrets::scrub(&project);
                (r, s, true)
            }
        };
        let id = self.next_pane;
        self.next_pane += 1;
        let spec = SpawnSpec { kind, cwd: cwd.to_string(), argv: Vec::new(), env_set, env_remove, scrubbed };
        // The agent is typed into a shell, so quitting the agent leaves the
        // terminal open where it was.
        let typed = self.agent_command(kind, launch).map(|c| format!("{c}\r"));
        let meta = crate::server::Meta {
            project: project.clone(),
            name: String::new(),
            run: if launch.fork { None } else { launch.resume.clone() },
            workspace: None,
        };
        let conn = self.server.clone().filter(|c| c.is_alive());
        match Pane::spawn(id, spec, rows, cols, conn.as_ref(), typed, meta) {
            Ok(mut p) => {
                if !launch.fork {
                    if let Some(k) = &launch.resume {
                        p.run = Some(k.clone());
                    }
                }
                self.panes.insert(id, p);
                Some(id)
            }
            Err(e) => {
                self.say(format!("could not start terminal: {e}"), Tone::Err);
                None
            }
        }
    }

    /// Attaches to a terminal the server still runs.
    fn attach_pane(&mut self, server_id: u64) -> Option<u64> {
        let conn = self.server.clone()?;
        let id = self.next_pane;
        match Pane::attach(id, &conn, server_id) {
            Ok(p) => {
                self.next_pane += 1;
                self.panes.insert(id, p);
                Some(id)
            }
            Err(_) => None,
        }
    }

    pub fn project_key(root: &str) -> String {
        let name = Path::new(root).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "root".into());
        let mut h: u64 = 0xcbf29ce484222325;
        for b in root.bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        let clean: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
        format!("{clean}-{:06x}", h & 0xffffff)
    }

    /// Opens a new focus workspace from the project's layout template.
    pub fn new_workspace(&mut self, agent: Option<PaneKind>, launch: Launch) {
        self.new_workspace_with(agent, launch, WsOpts::default());
    }

    pub fn new_workspace_with(&mut self, agent: Option<PaneKind>, launch: Launch, opts: WsOpts) -> Option<u64> {
        let Some(root) = self.project.clone() else {
            self.say("pick a project first", Tone::Warn);
            return None;
        };
        let cwd = opts.cwd.clone().or_else(|| opts.worktree.as_ref().map(|w| w.path.clone())).unwrap_or_else(|| root.clone());
        let spec = layout::load_template(&Self::project_key(&root));
        let mut spawned: Vec<u64> = Vec::new();
        let mut term = |_slot: usize, role: &str| -> Option<u64> {
            match (role, agent) {
                ("agent", Some(k)) => {
                    let id = self.spawn_pane(k, &cwd, &launch)?;
                    spawned.push(id);
                    Some(id)
                }
                ("agent", None) => {
                    let id = self.spawn_pane(PaneKind::Shell, &cwd, &Launch::default())?;
                    spawned.push(id);
                    Some(id)
                }
                (_, None) if spawned.len() >= 1 => None,
                _ => {
                    let id = self.spawn_pane(PaneKind::Shell, &cwd, &Launch::default())?;
                    spawned.push(id);
                    Some(id)
                }
            }
        };
        let layout = Layout::from_spec(&spec, &mut term);
        if layout.root.is_none() {
            return None;
        }
        let focus = spawned.first().and_then(|p| layout.leaf_for_term(*p));
        let name = opts.name.clone().unwrap_or_else(|| match (agent, &launch.resume) {
            (_, Some(k)) => {
                let t = self
                    .shared
                    .lock()
                    .unwrap()
                    .runs
                    .get(k)
                    .map(|r| one_line(&self.title_of(r), 30))
                    .unwrap_or_else(|| format!("{} {}", k.kind.label(), short_id(&k.id)));
                if launch.fork { format!("fork of {t}") } else { t }
            }
            (Some(PaneKind::Claude), None) => "claude".into(),
            (Some(PaneKind::Codex), None) => "codex".into(),
            _ => "shell".into(),
        });
        let id = self.next_ws;
        self.next_ws += 1;
        self.workspaces.push(Workspace {
            id,
            project: root,
            name,
            layout,
            focus,
            zoom: None,
            observed: None,
            seen: now_ms(),
            layout_dirty: false,
            template: agent.is_some(),
            worktree: opts.worktree,
        });
        if opts.background {
            self.reselect = Some(id);
        } else {
            self.focus_ws(id);
        }
        self.save_workspaces();
        Some(id)
    }

    fn split_focused(&mut self, kind: LeafKind) {
        let rects = self.leaf_rects.clone();
        let Some(ws) = self.active_mut() else { return };
        let target = ws.focus;
        let dir = target
            .and_then(|t| rects.iter().find(|(i, _)| *i == t))
            .map(|(_, r)| if r.width as f32 > r.height as f32 * 2.2 { Dir::H } else { Dir::V })
            .unwrap_or(Dir::H);
        let new = ws.layout.split(target, kind, dir, 0.5);
        ws.focus = Some(new);
        ws.zoom = None;
        ws.layout_dirty = true;
    }

    fn add_terminal(&mut self, kind: PaneKind) {
        let Some(ws) = self.active() else {
            self.new_workspace(if kind == PaneKind::Shell { None } else { Some(kind) }, Launch::default());
            return;
        };
        if ws.observed.is_some() {
            self.say("this is a read-only view; r resumes it in a terminal", Tone::Warn);
            return;
        }
        let cwd = ws
            .focus
            .and_then(|f| ws.layout.kind_of(f))
            .and_then(|k| if let LeafKind::Term(p) = k { self.panes.get(&p).map(|p| p.cwd.clone()) } else { None })
            .unwrap_or_else(|| ws.project.clone());
        if let Some(p) = self.spawn_pane(kind, &cwd, &Launch::default()) {
            self.split_focused(LeafKind::Term(p));
        }
    }

    fn close_leaf(&mut self, leaf: u64, confirmed: bool) {
        let Some(ws) = self.active() else { return };
        let kind = ws.layout.kind_of(leaf);
        if let Some(LeafKind::Term(p)) = kind {
            let busy = self.panes.get(&p).map(|p| p.exited.is_none() && p.detected.is_some()).unwrap_or(false);
            if busy && !confirmed {
                self.overlay = Some(Overlay::Confirm {
                    msg: vec!["an agent is running in this terminal.".into(), "close it anyway?".into()],
                    action: Action::CloseLeaf(leaf),
                });
                return;
            }
            if let Some(mut pane) = self.panes.remove(&p) {
                pane.kill();
            }
        }
        let ws_id = self.active_ws;
        let Some(ws) = self.active_mut() else { return };
        ws.layout.remove(leaf);
        ws.layout_dirty = true;
        ws.zoom = None;
        ws.focus = ws.layout.leaves().first().map(|l| l.0);
        let empty = ws.layout.root.is_none() || (ws.layout.terms().is_empty() && ws.observed.is_none());
        if empty {
            if let Some(id) = ws_id {
                self.close_workspace(id, true);
            }
        }
    }

    fn close_workspace(&mut self, id: u64, confirmed: bool) {
        let Some(ws) = self.workspaces.iter().find(|w| w.id == id) else { return };
        let busy = ws.layout.terms().iter().any(|t| self.panes.get(t).map(|p| p.exited.is_none() && p.detected.is_some()).unwrap_or(false));
        if busy && !confirmed {
            self.overlay = Some(Overlay::Confirm {
                msg: vec![format!("close workspace \"{}\"?", ws.name), "its agent will be stopped; the session can be resumed later.".into()],
                action: Action::CloseWorkspace(id),
            });
            return;
        }
        if let Some(wt) = ws.worktree.clone() {
            let (ahead, dirty) = crate::worktree::status(&wt);
            let mut msg = vec![format!("this session worked on {} in its own worktree.", wt.branch)];
            msg.push(match (ahead, dirty) {
                (0, false) => "no commits and nothing uncommitted.".to_string(),
                (a, d) => format!("{} ahead of {}{}.", plural_s(a as usize, "commit", "commits"), wt.base, if d { ", plus uncommitted changes" } else { "" }),
            });
            self.overlay = Some(Overlay::Choice {
                title: "close the session".into(),
                msg,
                options: vec![
                    ('m', format!("merge into {} and remove the worktree", wt.base), Action::FinishWorktree(id, WtEnd::Merge)),
                    ('k', "keep the branch and worktree for later".into(), Action::FinishWorktree(id, WtEnd::Keep)),
                    ('x', "delete the branch and worktree".into(), Action::FinishWorktree(id, WtEnd::Delete)),
                ],
            });
            return;
        }
        self.close_workspace_now(id);
    }

    fn finish_worktree(&mut self, id: u64, end: WtEnd) {
        let Some(wt) = self.workspaces.iter().find(|w| w.id == id).and_then(|w| w.worktree.clone()) else { return };
        if end == WtEnd::Merge {
            // Refuse before stopping anything, so a failed merge loses nothing.
            let (_, dirty) = crate::worktree::status(&wt);
            if dirty {
                self.say(format!("{} has uncommitted changes; commit them in the worktree, or keep it", wt.branch), Tone::Warn);
                return;
            }
        }
        self.close_workspace_now(id);
        let res = match end {
            WtEnd::Merge => crate::worktree::merge(&wt),
            WtEnd::Keep => Ok(format!("kept {} at {}", wt.branch, config::display_path(Path::new(&wt.path)))),
            WtEnd::Delete => crate::worktree::remove(&wt, true).map(|_| format!("deleted {}", wt.branch)),
        };
        match res {
            Ok(m) => self.say(m, Tone::Ok),
            Err(e) => self.say(format!("worktree: {e}"), Tone::Err),
        }
    }

    fn close_workspace_now(&mut self, id: u64) {
        let Some(ws) = self.workspaces.iter().find(|w| w.id == id) else { return };
        if ws.layout_dirty {
            self.save_layout_of(id);
        }
        let terms = ws.layout.terms();
        for t in terms {
            if let Some(mut p) = self.panes.remove(&t) {
                p.kill();
            }
        }
        self.workspaces.retain(|w| w.id != id);
        self.save_workspaces();
        if self.active_ws == Some(id) {
            self.active_ws = None;
            if self.view == View::Focus {
                self.view = View::Dash;
            }
        }
    }

    // ---------- persistence ----------

    fn save_layout_of(&self, id: u64) {
        let Some(ws) = self.workspaces.iter().find(|w| w.id == id) else { return };
        if !ws.template {
            return;
        }
        if let Some(spec) = self.layout_spec_of(id) {
            layout::save_template(&Self::project_key(&ws.project), &spec);
        }
    }

    /// A session's layout as a template: its first terminal is the agent's.
    fn layout_spec_of(&self, id: u64) -> Option<layout::NodeSpec> {
        let ws = self.workspaces.iter().find(|w| w.id == id)?;
        if ws.observed.is_some() {
            return None;
        }
        let slot = std::cell::Cell::new(0usize);
        ws.layout.to_spec(|p| {
            let n = slot.get();
            let role = self.panes.get(&p).map(|x| if x.kind == PaneKind::Shell && n > 0 { "shell" } else { "agent" }).unwrap_or("shell");
            slot.set(n + 1);
            Some((n, role.to_string()))
        })
    }

    fn save_layouts(&self) {
        for ws in self.workspaces.iter().filter(|w| w.layout_dirty) {
            self.save_layout_of(ws.id);
        }
    }

    fn save_workspaces(&mut self) {
        let mut out: Vec<SavedWorkspace> = Vec::new();
        for ws in self.workspaces.iter().filter(|w| w.observed.is_none()) {
            let terms = ws.layout.terms();
            let mut saved_terms = Vec::new();
            for t in &terms {
                let p = self.panes.get(t);
                saved_terms.push(SavedTerm {
                    kind: p.map(|p| match p.detected {
                        Some(AgentKind::Claude) => PaneKind::Claude,
                        Some(AgentKind::Codex) => PaneKind::Codex,
                        None => p.kind,
                    }),
                    cwd: p.map(|p| p.cwd.clone()).unwrap_or_default(),
                    run: p.and_then(|p| p.run.as_ref().map(|r| r.id.clone())),
                    server: p.and_then(|p| p.server_id.filter(|_| p.exited.is_none())),
                });
            }
            let spec = ws.layout.to_spec(|p| terms.iter().position(|x| *x == p).map(|i| (i, String::new())));
            if let Some(spec) = spec {
                out.push(SavedWorkspace { project: ws.project.clone(), name: ws.name.clone(), layout: spec, terms: saved_terms, worktree: ws.worktree.clone() });
            }
        }
        // Keep saved workspaces of projects not restored this run.
        for s in self.saved.drain(..) {
            if !self.restored.contains(&s.project) {
                out.push(s);
            }
        }
        if let Ok(t) = serde_json::to_string_pretty(&out) {
            let _ = std::fs::write(config::state_dir().join("workspaces.json"), t);
        }
        self.saved = out.into_iter().filter(|s| !self.restored.contains(&s.project)).collect();
    }

    fn restore_workspaces(&mut self, root: &str) -> usize {
        // Sessions this project may resume: indexed, and its own. A saved
        // link to another project's session (from a pane linked to the
        // wrong session) must not bring that conversation back here, where
        // its tools would run in the wrong folder.
        let indexed: HashSet<String> = self.shared.lock().unwrap().sessions.values().filter(|s| s.root.is_empty() || s.root == root).map(|s| s.key.id.clone()).collect();
        let live: HashSet<u64> = self
            .server
            .as_ref()
            .and_then(|c| c.list().ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|p| p.exited.is_none())
            .map(|p| p.id)
            .collect();
        let mine: Vec<SavedWorkspace> = {
            let (m, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut self.saved).into_iter().partition(|s| s.project == root);
            self.saved = rest;
            m
        };
        let mut n = 0;
        for s in mine {
            let mut spawned = Vec::new();
            let terms = s.terms;
            let has_agent = terms.iter().any(|t| matches!(t.kind, Some(PaneKind::Claude) | Some(PaneKind::Codex)));
            let mut term = |slot: usize, _role: &str| -> Option<u64> {
                let t = terms.get(slot)?;
                // Still running in the server: pick it up where it is.
                if let Some(sid) = t.server.filter(|id| live.contains(id)) {
                    if let Some(id) = self.attach_pane(sid) {
                        if let (Some(run), Some(p)) = (t.run.as_ref(), self.panes.get_mut(&id)) {
                            if p.run.is_none() {
                                p.run = Some(RunKey { kind: if t.kind == Some(PaneKind::Codex) { AgentKind::Codex } else { AgentKind::Claude }, id: run.clone() });
                            }
                        }
                        spawned.push(id);
                        return Some(id);
                    }
                }
                let kind = t.kind.unwrap_or(PaneKind::Shell);
                let cwd = if t.cwd.is_empty() || !Path::new(&t.cwd).is_dir() { root.to_string() } else { t.cwd.clone() };
                let resume = t.run.as_ref().map(|id| RunKey {
                    kind: if kind == PaneKind::Codex { AgentKind::Codex } else { AgentKind::Claude },
                    id: id.clone(),
                });
                let resume = if kind == PaneKind::Shell { None } else { resume.filter(|k| indexed.contains(&k.id)) };
                let id = self.spawn_pane(kind, &cwd, &Launch { resume, ..Default::default() })?;
                spawned.push(id);
                Some(id)
            };
            let layout = Layout::from_spec(&s.layout, &mut term);
            if layout.root.is_none() {
                continue;
            }
            let focus = spawned.first().and_then(|p| layout.leaf_for_term(*p));
            let id = self.next_ws;
            self.next_ws += 1;
            self.workspaces.push(Workspace {
                id,
                project: root.to_string(),
                name: s.name,
                layout,
                focus,
                zoom: None,
                observed: None,
                seen: now_ms(),
                layout_dirty: false,
                template: has_agent,
                worktree: s.worktree,
            });
            n += 1;
        }
        n
    }

    // ---------- events ----------

    fn on_event(&mut self, ev: Event) {
        match ev {
            Event::Key(k) if k.kind != KeyEventKind::Release => self.on_key(k),
            Event::Mouse(m) => self.on_mouse(m),
            Event::Paste(s) => self.on_paste(s),
            Event::Resize(w, h) => {
                self.size = (w, h);
            }
            _ => {}
        }
    }

    fn on_paste(&mut self, s: String) {
        if let Some(Overlay::Input { value, .. }) = &mut self.overlay {
            value.push_str(s.trim_end_matches(['\n', '\r']));
            return;
        }
        if let Some(Overlay::Search { query, sel }) = &mut self.overlay {
            query.push_str(&one_line(&s, 200));
            *sel = 0;
            return;
        }
        if self.view == View::Focus {
            if let Some(p) = self.focused_pane() {
                if let Some(pane) = self.panes.get_mut(&p) {
                    if pane.bracketed_paste() {
                        let mut b = b"\x1b[200~".to_vec();
                        b.extend(s.as_bytes());
                        b.extend(b"\x1b[201~");
                        pane.write(&b);
                    } else {
                        pane.write(s.replace('\n', "\r").as_bytes());
                    }
                }
            }
        }
    }

    pub fn focused_pane(&self) -> Option<u64> {
        let ws = self.active()?;
        match ws.layout.kind_of(ws.focus?)? {
            LeafKind::Term(p) => Some(p),
            _ => None,
        }
    }

    fn on_key(&mut self, k: KeyEvent) {
        if self.overlay.is_some() {
            self.overlay_key(k);
            return;
        }
        if self.alt_mode && k.modifiers.contains(KeyModifiers::ALT) {
            if let Some(act) = alt_act(&k) {
                self.act(act);
                return;
            }
        }
        let is_prefix = !self.alt_mode && keys::chord_matches(&k, &self.prefix);
        if self.prefix_armed.is_some() {
            self.prefix_armed = None;
            if is_prefix {
                // prefix twice sends the chord through.
                if let Some(p) = self.focused_pane() {
                    let bytes = keys::encode_key(k, false, 0);
                    if let Some(pane) = self.panes.get_mut(&p) {
                        pane.write(&bytes);
                    }
                }
                return;
            }
            if let Some(act) = prefix_act(&k) {
                self.act(act);
            }
            return;
        }
        if is_prefix {
            self.prefix_armed = Some(Instant::now());
            return;
        }
        if self.view == View::Focus {
            if let Some(p) = self.focused_pane() {
                if let Some(pane) = self.panes.get_mut(&p) {
                    if pane.exited.is_some() && k.code == KeyCode::Enter {
                        self.restart_pane(p);
                        return;
                    }
                    let bytes = keys::encode_key(k, pane.app_cursor(), pane.kitty_flags());
                    pane.write(&bytes);
                    return;
                }
            }
            self.focus_component_key(k);
            return;
        }
        self.view_key(k);
    }

    fn restart_pane(&mut self, p: u64) {
        let Some(old) = self.panes.get(&p) else { return };
        let (kind, cwd) = (old.kind, old.cwd.clone());
        let Some(new) = self.spawn_pane(PaneKind::Shell, &cwd, &Launch::default()) else { return };
        let _ = kind;
        if let Some(ws) = self.active_mut() {
            if let Some(leaf) = ws.layout.leaf_for_term(p) {
                ws.layout.replace(leaf, LeafKind::Term(new));
            }
        }
        self.panes.remove(&p);
    }

    fn focus_component_key(&mut self, k: KeyEvent) {
        let leaf = self.active().and_then(|w| w.focus);
        if let (Some(l), Some(LeafKind::Comp(Comp::Files))) = (leaf, leaf.and_then(|l| self.active().and_then(|w| w.layout.kind_of(l)))) {
            if self.files_key(l, k) {
                return;
            }
        }
        if let (Some(l), Some(LeafKind::Comp(Comp::Diff))) = (leaf, leaf.and_then(|l| self.active().and_then(|w| w.layout.kind_of(l)))) {
            if self.diff_key(l, k) {
                return;
            }
        }
        match k.code {
            KeyCode::Char('r') => {
                if let Some(o) = self.active().and_then(|w| w.observed.clone()) {
                    self.resume_session(o);
                }
            }
            KeyCode::Esc => self.act(Act::Back),
            KeyCode::Char('q') => self.ask_quit(),
            KeyCode::Char('j') | KeyCode::Down | KeyCode::Char('k') | KeyCode::Up => {
                if let Some(l) = leaf {
                    // The activity feed is anchored at the bottom; the rest at the top.
                    let bottom_anchored = matches!(self.active().and_then(|w| w.layout.kind_of(l)), Some(LeafKind::Comp(Comp::Activity)));
                    let down = matches!(k.code, KeyCode::Char('j') | KeyCode::Down);
                    let s = self.leaf_scroll.entry(l).or_default();
                    *s = if down != bottom_anchored { s.saturating_add(1) } else { s.saturating_sub(1) };
                }
            }
            KeyCode::Char('h') | KeyCode::Left => self.move_focus(Move::Left),
            KeyCode::Char('l') | KeyCode::Right => self.move_focus(Move::Right),
            KeyCode::Tab => self.cycle_focus(),
            KeyCode::Char('?') => self.overlay = Some(Overlay::Help),
            _ => {}
        }
    }

    fn cycle_focus(&mut self) {
        let rects = self.leaf_rects.clone();
        if let Some(ws) = self.active_mut() {
            if let Some(f) = ws.focus {
                if let Some(i) = rects.iter().position(|(id, _)| *id == f) {
                    ws.focus = Some(rects[(i + 1) % rects.len()].0);
                }
            }
        }
    }

    fn move_focus(&mut self, mv: Move) {
        let rects = self.leaf_rects.clone();
        if let Some(ws) = self.active_mut() {
            if let Some(f) = ws.focus {
                if let Some(n) = Layout::neighbor(&rects, f, mv) {
                    ws.focus = Some(n);
                }
            }
        }
    }

    pub fn act(&mut self, a: Act) {
        match a {
            Act::View(v) => {
                if v == View::Focus && self.active_ws.is_none() {
                    self.say("nothing open yet; pick a session first", Tone::Info);
                } else {
                    self.switch_view(v);
                }
            }
            Act::Back => {
                if self.view == View::Focus {
                    self.reselect = self.active_ws;
                }
                self.view = match self.view {
                    View::Focus => View::Dash,
                    View::Dash => View::Projects,
                    v if v != View::Projects && self.project.is_some() => View::Dash,
                    _ => View::Projects,
                }
            }
            Act::New(kind) => {
                if self.view == View::Focus {
                    self.add_terminal(kind)
                } else {
                    // On the projects list, the highlighted project, not
                    // whichever one was opened last.
                    if self.view == View::Projects {
                        if let Some(root) = self.selected_project_root() {
                            self.open_project(root);
                        }
                    }
                    self.new_workspace(if kind == PaneKind::Shell { None } else { Some(kind) }, Launch::default())
                }
            }
            Act::ClosePane => {
                if let Some(f) = self.active().and_then(|w| w.focus) {
                    self.close_leaf(f, false);
                }
            }
            Act::CloseWorkspace => {
                if let Some(id) = self.active_ws {
                    self.close_workspace(id, false);
                }
            }
            Act::Focus(mv) => {
                if self.view == View::Focus {
                    self.move_focus(mv);
                }
            }
            Act::Swap(mv) => {
                let rects = self.leaf_rects.clone();
                if let Some(ws) = self.active_mut() {
                    if let Some(f) = ws.focus {
                        if let Some(n) = Layout::neighbor(&rects, f, mv) {
                            ws.layout.swap(f, n);
                            ws.focus = Some(n);
                            ws.layout_dirty = true;
                        }
                    }
                }
            }
            Act::Resize(dir, d) => {
                if let Some(ws) = self.active_mut() {
                    if let Some(f) = ws.focus {
                        ws.layout.resize(f, dir, d);
                        ws.layout_dirty = true;
                    }
                }
            }
            Act::Zoom => {
                if let Some(ws) = self.active_mut() {
                    ws.zoom = if ws.zoom.is_some() { None } else { ws.focus };
                }
            }
            Act::Flip => {
                if let Some(ws) = self.active_mut() {
                    if let Some(f) = ws.focus {
                        ws.layout.flip(f);
                        ws.layout_dirty = true;
                    }
                }
            }
            Act::AddPanel => self.open_palette(),
            Act::Sleep => self.toggle_sleep(),
            Act::Theme => self.cycle_theme(),
            Act::Attention => self.next_attention(),
            Act::Approve(c) => self.answer_approval(0, c),
            Act::CycleWs(d) => self.cycle_ws(d),
            Act::Help => self.overlay = Some(Overlay::Help),
            Act::Command => self.open_command(),
            Act::Quit => self.ask_quit(),
            Act::Resume => {
                if self.view == View::Focus {
                    self.focus_component_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE));
                }
            }
        }
    }

    fn cycle_ws(&mut self, d: i32) {
        let mine: Vec<u64> = self.workspaces.iter().filter(|w| Some(&w.project) == self.project.as_ref()).map(|w| w.id).collect();
        if mine.is_empty() {
            return;
        }
        let cur = self.active_ws.and_then(|a| mine.iter().position(|x| *x == a)).unwrap_or(0) as i32;
        let n = mine.len() as i32;
        let next = mine[((cur + d).rem_euclid(n)) as usize];
        self.focus_ws(next);
    }

    fn ask_quit(&mut self) {
        // Terminals in the server keep running; only ones that live in this
        // process would stop.
        let live = self.panes.values().filter(|p| p.exited.is_none() && p.detected.is_some() && !p.is_remote()).count();
        if live == 0 {
            self.quit = true;
            return;
        }
        self.overlay = Some(Overlay::Confirm {
            msg: vec![
                format!("{live} agent{} running in polypore terminals.", if live == 1 { " is" } else { "s are" }),
                "the terminal server is off, so they stop with polypore. quit anyway? they are resumed next time.".into(),
            ],
            action: Action::Quit,
        });
    }

    /// The stay-awake toggle is a saved preference: it stays on across
    /// launches until switched off. The lock itself lives only while
    /// polypore runs, so a closed (or crashed) polypore never pins the machine.
    pub fn toggle_sleep(&mut self) {
        let what = self.cfg.sleep.what.clone();
        match self.sleep.toggle(&what, self.cfg.sleep.omarchy_stay_awake) {
            Ok(true) => {
                save_awake(true);
                self.say("staying awake, every time polypore is open, until you switch it off", Tone::Ok)
            }
            Ok(false) => {
                save_awake(false);
                self.say("sleep allowed again", Tone::Info)
            }
            Err(e) => self.say(format!("stay-awake failed: {e}"), Tone::Err),
        }
    }

    pub fn restore_awake(&mut self) {
        if load_awake() && !self.sleep.active() {
            let what = self.cfg.sleep.what.clone();
            if let Err(e) = self.sleep.toggle(&what, self.cfg.sleep.omarchy_stay_awake) {
                self.say(format!("stay-awake failed: {e}"), Tone::Err);
            }
        }
    }

    fn cycle_theme(&mut self) {
        let mut cfg = self.cfg.clone();
        self.theme.cycle(&mut cfg);
        self.cfg = cfg;
        self.cfg.save_ui_theme();
        let name = self.theme.name.clone();
        self.say(format!("theme: {name}"), Tone::Info);
    }

    fn open_palette(&mut self) {
        if self.view != View::Focus || self.active().is_none() {
            self.say("open a focus view first", Tone::Warn);
            return;
        }
        let mut items: Vec<PaletteItem> = Comp::ALL.iter().map(|c| PaletteItem::Comp(*c)).collect();
        items.push(PaletteItem::Term(PaneKind::Shell));
        items.push(PaletteItem::Term(PaneKind::Claude));
        items.push(PaletteItem::Term(PaneKind::Codex));
        self.overlay = Some(Overlay::Palette { sel: 0, items });
    }

    pub fn attention_items(&self) -> Vec<(String, RunKey, String)> {
        let shared = self.shared.clone();
        let snap = shared.lock().unwrap();
        self.attention_in(&snap)
    }

    /// Same as `attention_items`, for callers that already hold the snapshot.
    pub fn attention_in(&self, snap: &store::Snapshot) -> Vec<(String, RunKey, String)> {
        let now = now_ms();
        let mut v: Vec<(i64, String, RunKey, String)> = snap
            .runs
            .values()
            .filter(|r| (r.is_live() || self.pane_for_run(&r.key).is_some()) && r.state(now) == RunState::NeedsInput)
            .map(|r| {
                let proj = snap.sessions.get(&r.key).map(|s| s.root.clone()).unwrap_or_else(|| r.cwd.clone());
                let what = r.question.clone().or(r.approval.clone()).unwrap_or_else(|| "waiting".into());
                (r.updated, proj, r.key.clone(), what)
            })
            .collect();
        v.sort_by_key(|x| x.0);
        v.into_iter().map(|(_, p, k, w)| (p, k, w)).collect()
    }

    pub fn open_search(&mut self) {
        let stale = {
            let s = self.search.lock().unwrap();
            !s.building && s.built_at.map(|t| t.elapsed() > Duration::from_secs(60)).unwrap_or(true)
        };
        if stale {
            let state = config::state_dir().to_string_lossy().to_string();
            let sessions: Vec<store::SessionInfo> = self.shared.lock().unwrap().sessions.values().filter(|s| !s.root.starts_with(&state)).cloned().collect();
            crate::search::build(self.search.clone(), sessions);
        }
        self.overlay = Some(Overlay::Search { query: String::new(), sel: 0 });
    }

    /// Opens a search hit: its project, then the session (read-only unless
    /// polypore runs it). With `resume`, resumes a closed one instead.
    fn open_hit(&mut self, i: usize, resume: bool) {
        let Some(hit) = self.search_hits.get(i).cloned() else { return };
        let Some(doc) = self.search.lock().unwrap().docs.get(hit.doc).cloned() else { return };
        if self.project.as_deref() != Some(doc.root.as_str()) {
            self.open_project(doc.root.clone());
        }
        let key = doc.key.clone();
        if let Some(p) = self.pane_for_run(&key) {
            if let Some(ws) = self.ws_for_pane(p) {
                self.focus_ws(ws);
                return;
            }
        }
        if resume {
            self.resume_session(key);
        } else {
            self.wants.lock().unwrap().pinned.insert(key.clone());
            self.observe(key);
        }
    }

    /// `!`: each press goes to the next session waiting for you, across
    /// projects, oldest wait first, then around again.
    fn next_attention(&mut self) {
        let n = self.attention_items().len();
        if n == 0 {
            self.attn_turn = 0;
            if self.panes.values().any(|p| p.attention.is_some()) {
                self.jump_attention(0);
            } else {
                self.say("nothing is waiting for you", Tone::Info);
            }
            return;
        }
        let i = self.attn_turn % n;
        self.attn_turn = i + 1;
        if n > 1 {
            self.say(format!("waiting for you: {} of {n} · ! for the next", i + 1), Tone::Info);
        }
        self.jump_attention(i);
    }

    fn jump_attention(&mut self, i: usize) {
        let items = self.attention_items();
        if let Some((root, key, _)) = items.get(i).cloned() {
            if self.project.as_deref() != Some(root.as_str()) {
                self.open_project(root);
            }
            if let Some(p) = self.pane_for_run(&key) {
                if let Some(ws) = self.ws_for_pane(p) {
                    self.focus_ws(ws);
                    return;
                }
            }
            self.observe(key);
            return;
        }
        // Panes that rang the bell.
        let pane = self.panes.iter().find(|(_, p)| p.attention.is_some()).map(|(i, _)| *i);
        if let Some(p) = pane {
            if let Some(ws) = self.ws_for_pane(p) {
                self.focus_ws(ws);
            }
        }
    }

    fn answer_approval(&mut self, i: usize, c: char) {
        let Some(a) = self.approvals.get(i).cloned() else {
            self.say("nothing waiting for approval", Tone::Info);
            return;
        };
        let d = match c {
            'y' => Decision::Once,
            'Y' => Decision::Always,
            _ => Decision::Deny,
        };
        secrets::decide(&a, d);
        self.approvals.remove(i);
        self.say(
            match d {
                Decision::Once => format!("allowed once: {}", a.target),
                Decision::Always => format!("always allowed: {} for {}", a.pattern, a.secrets.join(", ")),
                Decision::Deny => format!("denied: {}", a.target),
            },
            if d == Decision::Deny { Tone::Warn } else { Tone::Ok },
        );
    }

    fn view_key(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        match k.code {
            KeyCode::Char('c') if ctrl => return self.ask_quit(),
            KeyCode::Tab => return self.cycle_view(1),
            KeyCode::BackTab => return self.cycle_view(-1),
            KeyCode::Char('?') => {
                self.overlay = Some(Overlay::Help);
                return;
            }
            KeyCode::Char('q') => return self.ask_quit(),
            KeyCode::Char(c @ '1'..='6') => {
                let v = View::ALL[(c as u8 - b'1') as usize];
                if v == View::Focus && self.active_ws.is_none() {
                    self.say("no focus workspace yet; open a session from the dash", Tone::Info);
                    return;
                }
                self.switch_view(v);
                return;
            }
            // Machine and look settings take a capital: no accidental toggles.
            KeyCode::Char('S') => return self.toggle_sleep(),
            KeyCode::Char('T') => return self.cycle_theme(),
            KeyCode::Char('!') => return self.next_attention(),
            KeyCode::Char('s') if matches!(self.view, View::Projects | View::Dash) => return self.open_search(),
            KeyCode::Char(':') => return self.open_command(),
            KeyCode::Char('y') if !self.approvals.is_empty() => return self.answer_approval(0, 'y'),
            KeyCode::Char('Y') if !self.approvals.is_empty() => return self.answer_approval(0, 'Y'),
            KeyCode::Char('N') if !self.approvals.is_empty() => return self.answer_approval(0, 'N'),
            _ => {}
        }
        if k.code == KeyCode::Esc && matches!(self.view, View::Skills | View::Secrets | View::Stats) {
            return self.act(Act::Back);
        }
        match self.view {
            View::Projects => self.projects_key(k),
            View::Dash => self.dash_key(k),
            View::Skills => self.skills_key(k),
            View::Secrets => self.secrets_key(k),
            View::Stats => self.stats_key(k),
            View::Focus => {}
        }
    }

    fn cycle_view(&mut self, d: i32) {
        let vs: Vec<View> = View::ALL.iter().copied().filter(|v| *v != View::Focus || self.active_ws.is_some()).collect();
        let i = vs.iter().position(|v| *v == self.view).unwrap_or(0) as i32;
        let n = vs.len() as i32;
        self.switch_view(vs[((i + d).rem_euclid(n)) as usize]);
    }

    pub fn switch_view(&mut self, v: View) {
        if v == View::Dash && self.project.is_none() {
            self.say("pick a project first", Tone::Info);
            self.view = View::Projects;
            return;
        }
        self.view = v;
        match v {
            View::Skills => self.refresh_skills(),
            View::Secrets => self.refresh_secrets(),
            View::Stats => {
                let has = self.analysis.lock().unwrap().stats.is_some();
                if !has {
                    self.start_stats();
                }
            }
            _ => {}
        }
    }

    fn projects_key(&mut self, k: KeyEvent) {
        let n = self.project_rows.len();
        match k.code {
            KeyCode::Char('j') | KeyCode::Down => self.sel_project = (self.sel_project + 1).min(n.saturating_sub(1)),
            KeyCode::Char('k') | KeyCode::Up => self.sel_project = self.sel_project.saturating_sub(1),
            KeyCode::Char('G') | KeyCode::End => self.sel_project = n.saturating_sub(1),
            KeyCode::Char('g') | KeyCode::Home => self.sel_project = 0,
            KeyCode::Enter | KeyCode::Char('l') | KeyCode::Right => {
                if let Some(root) = self.selected_project_root() {
                    self.open_project(root);
                }
            }
            KeyCode::Char('/') => {
                self.overlay = Some(Overlay::Input { prompt: "filter projects".into(), value: self.filter.clone(), kind: InputKind::Filter, secret: false })
            }
            KeyCode::Esc => self.filter.clear(),
            KeyCode::Char('p') => {
                if let Some(root) = self.selected_project_root() {
                    let pins = &mut self.cfg.projects.pinned;
                    if let Some(i) = pins.iter().position(|p| *p == root) {
                        pins.remove(i);
                    } else {
                        pins.push(root);
                    }
                    self.cfg.save_projects();
                }
            }
            KeyCode::Char('H') => {
                if let Some(root) = self.selected_project_root() {
                    let hid = &mut self.cfg.projects.hidden;
                    if let Some(i) = hid.iter().position(|p| *p == root) {
                        hid.remove(i);
                    } else {
                        hid.push(root);
                    }
                    self.cfg.save_projects();
                }
            }
            KeyCode::Char('.') => self.show_hidden = !self.show_hidden,
            KeyCode::Char('a') => {
                self.overlay = Some(Overlay::Input { prompt: "project folder (missing folders are created)".into(), value: "~/".into(), kind: InputKind::AddProject, secret: false })
            }
            KeyCode::Char('n') | KeyCode::Char('c') | KeyCode::Char('x') => {
                if let Some(root) = self.selected_project_root() {
                    self.open_project(root);
                    match k.code {
                        KeyCode::Char('c') => self.start_agent(PaneKind::Claude),
                        KeyCode::Char('x') => self.start_agent(PaneKind::Codex),
                        _ => self.new_workspace(None, Launch::default()),
                    }
                }
            }
            _ => {}
        }
    }

    pub fn selected_project_root(&self) -> Option<String> {
        let snap = self.shared.lock().unwrap();
        let i = *self.project_rows.get(self.sel_project)?;
        if i >= snap.projects.len() {
            let extra = i - snap.projects.len();
            return self.cfg.projects.extra.get(extra).cloned();
        }
        snap.projects.get(i).map(|p| p.root.clone())
    }

    fn dash_key(&mut self, k: KeyEvent) {
        if self.yank_armed.take().is_some() {
            if let KeyCode::Char(c) = k.code {
                self.yank(c);
            }
            return;
        }
        let n = self.cards.len();
        match k.code {
            KeyCode::Char('j') | KeyCode::Down => self.sel_card = (self.sel_card + 1).min(n.saturating_sub(1)),
            KeyCode::Char('k') | KeyCode::Up => self.sel_card = self.sel_card.saturating_sub(1),
            KeyCode::Char('G') | KeyCode::End => self.sel_card = n.saturating_sub(1),
            KeyCode::Char('g') | KeyCode::Home => self.sel_card = 0,
            KeyCode::Char('l') | KeyCode::Right => self.open_card(self.sel_card),
            KeyCode::Char('h') | KeyCode::Left => self.view = View::Projects,
            KeyCode::Enter => self.open_card(self.sel_card),
            KeyCode::Char('r') => {
                let targets = self.targets();
                if targets.len() > 1 {
                    let mut n = 0;
                    for c in targets {
                        if matches!(c.kind, CardKind::Recent(_)) {
                            if let Some(k) = c.run.clone() {
                                let pk = if k.kind == AgentKind::Codex { PaneKind::Codex } else { PaneKind::Claude };
                                if self.new_workspace_with(Some(pk), Launch::resume(k), WsOpts { background: true, ..Default::default() }).is_some() {
                                    n += 1;
                                }
                            }
                        }
                    }
                    self.marks.clear();
                    self.say(format!("resumed {} in the background", plural_s(n, "session", "sessions")), Tone::Ok);
                } else {
                    self.resume_card(self.sel_card)
                }
            }
            KeyCode::Char('n') => self.new_workspace(None, Launch::default()),
            KeyCode::Char('c') => self.start_agent(PaneKind::Claude),
            KeyCode::Char('x') => self.start_agent(PaneKind::Codex),
            KeyCode::Char('y') => {
                self.yank_armed = Some(Instant::now());
            }
            KeyCode::Char('<') => self.failover_card(),
            KeyCode::Char('w') | KeyCode::Char('W') => {
                let kind = if k.code == KeyCode::Char('W') { PaneKind::Codex } else { PaneKind::Claude };
                self.overlay = Some(Overlay::Input {
                    prompt: format!("branch for a new {} session in its own worktree", if kind == PaneKind::Codex { "codex" } else { "claude" }),
                    value: String::new(),
                    kind: InputKind::Worktree(kind, None),
                    secret: false,
                });
            }
            KeyCode::Char('i') => self.ask_prompt(),
            KeyCode::Char('F') => self.fork_card(),
            KeyCode::Char('>') => self.handoff_card(),
            KeyCode::Char('R') => self.review_card(),
            KeyCode::Char('D') => self.changes_card(),
            KeyCode::Char('e') => {
                if let Some(c) = self.cards.get(self.sel_card).cloned() {
                    let current = self.card_title(&c);
                    self.overlay = Some(Overlay::Input { prompt: "rename (empty goes back to the agent's title)".into(), value: current, kind: InputKind::Rename(card_id(&c)), secret: false });
                }
            }
            KeyCode::Char('A') => {
                let targets = self.targets();
                let keys: Vec<RunKey> = targets.iter().filter(|c| !matches!(c.kind, CardKind::Hosted(_))).filter_map(|c| c.run.clone()).collect();
                if keys.is_empty() {
                    self.say("open sessions are not archived; close them first (d)", Tone::Info);
                    return;
                }
                let to = !self.smeta.is_archived(&keys[0]);
                for k in &keys {
                    if self.smeta.is_archived(k) != to {
                        self.smeta.toggle_archived(k);
                    }
                }
                self.marks.clear();
                let what = plural_s(keys.len(), "session", "sessions");
                if to {
                    self.say(format!("archived {what}; f cycles to the archived list"), Tone::Ok);
                } else {
                    self.say(format!("{what} back from the archive"), Tone::Ok);
                }
            }
            KeyCode::Char(' ') => {
                if let Some(c) = self.cards.get(self.sel_card) {
                    let id = card_id(c);
                    if !self.marks.remove(&id) {
                        self.marks.insert(id);
                    }
                    self.sel_card = (self.sel_card + 1).min(n.saturating_sub(1));
                }
            }
            KeyCode::Char('f') => {
                let i = StatusFilter::ORDER.iter().position(|x| *x == self.status_filter).unwrap_or(0);
                self.status_filter = StatusFilter::ORDER[(i + 1) % StatusFilter::ORDER.len()];
                self.sel_card = 0;
            }
            KeyCode::Char('d') => {
                let targets = self.targets();
                for c in targets {
                    match c.kind {
                        CardKind::Hosted(id) => self.close_workspace(id, false),
                        CardKind::Observed(k) | CardKind::Recent(k) => {
                            if let Some(id) = self.workspaces.iter().find(|w| w.observed.as_ref() == Some(&k)).map(|w| w.id) {
                                self.close_workspace(id, true);
                            } else if self.marks.is_empty() {
                                self.close_unhosted(k);
                            }
                        }
                    }
                    if self.overlay.is_some() {
                        break;
                    }
                }
                self.marks.clear();
            }
            KeyCode::Char('/') => {
                self.overlay = Some(Overlay::Input { prompt: "filter sessions".into(), value: self.filter.clone(), kind: InputKind::Filter, secret: false })
            }
            KeyCode::Esc | KeyCode::Backspace => {
                if !self.marks.is_empty() {
                    self.marks.clear();
                } else if !self.filter.is_empty() {
                    self.filter.clear();
                } else if self.status_filter != StatusFilter::All {
                    self.status_filter = StatusFilter::All;
                } else {
                    self.view = View::Projects;
                }
            }
            _ => {}
        }
    }

    /// The marked rows, or the selected one when nothing is marked.
    fn targets(&self) -> Vec<Card> {
        if self.marks.is_empty() {
            return self.cards.get(self.sel_card).cloned().into_iter().collect();
        }
        self.cards.iter().filter(|c| self.marks.contains(&card_id(c))).cloned().collect()
    }

    pub fn card_title(&self, c: &Card) -> String {
        let snap = self.shared.lock().unwrap();
        if let CardKind::Hosted(id) = c.kind {
            if c.run.is_none() {
                return self.workspaces.iter().find(|w| w.id == id).map(|w| w.name.clone()).unwrap_or_default();
            }
        }
        let Some(k) = &c.run else { return String::new() };
        if let Some(n) = self.smeta.name(k) {
            return n.to_string();
        }
        snap.runs.get(k).map(|r| r.display_title()).or_else(|| snap.sessions.get(k).map(|s| if s.title.is_empty() { one_line(&s.first_prompt, 60) } else { s.title.clone() })).unwrap_or_default()
    }

    fn ask_prompt(&mut self) {
        let targets = self.targets();
        if targets.is_empty() {
            return;
        }
        let ids: Vec<CardId> = targets.iter().map(card_id).collect();
        let prompt = if targets.len() > 1 {
            format!("prompt for {} (working ones get it after their turn)", plural_s(targets.len(), "session", "sessions"))
        } else {
            let c = &targets[0];
            match (c.state, &c.kind) {
                (RunState::Working, _) => "prompt, sent when this turn ends".to_string(),
                (RunState::NeedsInput, _) => format!("it is asking: {}. your text goes to its input", one_line(&self.card_activity(c), 50)),
                (_, CardKind::Recent(_)) => "prompt; resumes the session in the background with it".to_string(),
                (_, CardKind::Observed(_)) => {
                    self.say("that session runs in a terminal polypore does not own; type it there", Tone::Warn);
                    return;
                }
                _ => "prompt".to_string(),
            }
        };
        self.overlay = Some(Overlay::Input { prompt, value: String::new(), kind: InputKind::Prompt(ids), secret: false });
    }

    fn card_activity(&self, c: &Card) -> String {
        let snap = self.shared.lock().unwrap();
        c.run.as_ref().and_then(|k| snap.runs.get(k)).map(|r| r.activity(c.state)).unwrap_or_default()
    }

    /// The agent terminal of a card, if polypore runs it.
    fn card_agent_pane(&self, c: &Card) -> Option<u64> {
        match &c.kind {
            CardKind::Hosted(id) => self.workspaces.iter().find(|w| w.id == *id).and_then(|w| self.ws_agent_pane(w)),
            _ => c.run.as_ref().and_then(|k| self.pane_for_run(k)),
        }
    }

    fn send_prompts(&mut self, ids: Vec<CardId>, text: String) {
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }
        let (mut sent, mut queued, mut resumed, mut skipped) = (0, 0, 0, 0);
        let cards: Vec<Card> = self.cards.iter().filter(|c| ids.contains(&card_id(c))).cloned().collect();
        for c in cards {
            if let Some(p) = self.card_agent_pane(&c) {
                if c.state == RunState::Working {
                    if let Some(k) = c.run.clone() {
                        self.queue.entry(k).or_default().push(text.clone());
                        queued += 1;
                        continue;
                    }
                }
                if let Some(pane) = self.panes.get_mut(&p) {
                    pane.send_prompt(&text);
                    sent += 1;
                }
                continue;
            }
            match (&c.kind, c.run.clone()) {
                (CardKind::Recent(_), Some(k)) => {
                    let pk = if k.kind == AgentKind::Codex { PaneKind::Codex } else { PaneKind::Claude };
                    let launch = Launch { resume: Some(k), prompt: Some(text.clone()), ..Default::default() };
                    if self.new_workspace_with(Some(pk), launch, WsOpts { background: true, ..Default::default() }).is_some() {
                        resumed += 1;
                    }
                }
                _ => skipped += 1,
            }
        }
        self.marks.clear();
        let mut parts = Vec::new();
        if sent > 0 {
            parts.push(format!("sent to {}", plural_s(sent, "session", "sessions")));
        }
        if queued > 0 {
            parts.push(format!("queued for {} after this turn", plural_s(queued, "session", "sessions")));
        }
        if resumed > 0 {
            parts.push(format!("resumed {} with it", plural_s(resumed, "session", "sessions")));
        }
        if skipped > 0 {
            parts.push(format!("{skipped} skipped (running outside polypore)"));
        }
        self.say(parts.join(" · "), if skipped > 0 && sent + queued + resumed == 0 { Tone::Warn } else { Tone::Ok });
    }

    fn fork_card(&mut self) {
        let Some(c) = self.cards.get(self.sel_card).cloned() else { return };
        let Some(k) = c.run.clone() else {
            self.say("nothing to fork yet: send the first prompt", Tone::Info);
            return;
        };
        let pk = if k.kind == AgentKind::Codex { PaneKind::Codex } else { PaneKind::Claude };
        self.new_workspace(Some(pk), Launch { resume: Some(k), fork: true, ..Default::default() });
        self.say("forked: a new session with the same history; the original is untouched", Tone::Ok);
    }

    /// A fresh session that starts from a written handoff of this one.
    fn handoff_card(&mut self) {
        self.handoff_to(None);
    }

    /// Quota failover: the same handoff, into the other agent.
    fn failover_card(&mut self) {
        let Some(k) = self.cards.get(self.sel_card).and_then(|c| c.run.clone()) else {
            self.say("nothing to hand over yet", Tone::Info);
            return;
        };
        let other = if k.kind == AgentKind::Codex { PaneKind::Claude } else { PaneKind::Codex };
        self.handoff_to(Some(other));
    }

    fn handoff_to(&mut self, to: Option<PaneKind>) {
        let Some(c) = self.cards.get(self.sel_card).cloned() else { return };
        let Some(k) = c.run.clone() else {
            self.say("nothing to hand off yet", Tone::Info);
            return;
        };
        let Some(run) = self.shared.lock().unwrap().runs.get(&k).cloned() else {
            self.say("still reading that session; try again in a moment", Tone::Info);
            return;
        };
        let title = self.title_of(&run);
        let path = match crate::handoff::write(&run, &title) {
            Ok(p) => p,
            Err(e) => {
                self.say(format!("could not write the handoff: {e}"), Tone::Err);
                return;
            }
        };
        let prompt = crate::handoff::prompt(&run, &path);
        let pk = to.unwrap_or(if k.kind == AgentKind::Codex { PaneKind::Codex } else { PaneKind::Claude });
        let cwd = if Path::new(&run.cwd).is_dir() { Some(run.cwd.clone()) } else { None };
        let name = if to.is_some() { format!("{} continues {}", kind_label(pk), one_line(&title, 20)) } else { format!("handoff of {}", one_line(&title, 24)) };
        if let Some(ws) = self.new_workspace_with(Some(pk), Launch { prompt: Some(prompt), ..Default::default() }, WsOpts { cwd, name: Some(name), ..Default::default() }) {
            self.origins.insert(ws, k);
        }
        self.say(format!("handed off; the notes are in {}", config::display_path(&path)), Tone::Ok);
    }

    /// A clean-context reviewer over the session's uncommitted changes.
    fn review_card(&mut self) {
        let Some(c) = self.cards.get(self.sel_card).cloned() else { return };
        let Some(k) = c.run.clone() else {
            self.say("nothing to review yet", Tone::Info);
            return;
        };
        let Some(run) = self.shared.lock().unwrap().runs.get(&k).cloned() else { return };
        let title = self.title_of(&run);
        match crate::review::start(self.reviews.clone(), &run, &title, &self.cfg.review.command) {
            Ok(n) => {
                let who = self.cfg.review.command.split_whitespace().next().and_then(|w| Path::new(w).file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "agent".into());
                self.say(format!("reviewing {} with a fresh {who}; findings show beside the session", plural_s(n, "changed file", "changed files")), Tone::Ok)
            }
            Err(e) => self.say(e, Tone::Warn),
        }
        // Pin the findings beside the session when polypore runs it.
        if let CardKind::Hosted(id) = c.kind {
            self.add_panel_to(id, Comp::Review);
        }
    }

    /// Opens the session's changes as hunks to stage, revert or edit.
    fn changes_card(&mut self) {
        let Some(c) = self.cards.get(self.sel_card).cloned() else { return };
        match (&c.kind, c.run.clone()) {
            (CardKind::Hosted(id), _) => {
                let id = *id;
                self.focus_ws(id);
                self.add_panel_to(id, Comp::Diff);
            }
            (_, Some(k)) => {
                self.observe(k);
                if let Some(id) = self.active_ws {
                    if let Some(ws) = self.active_mut() {
                        if let Some(a) = ws.layout.leaves().iter().find(|(_, kind)| *kind == LeafKind::Comp(Comp::Activity)).map(|l| l.0) {
                            ws.layout.replace(a, LeafKind::Comp(Comp::Diff));
                            ws.focus = Some(a);
                        }
                    }
                    let _ = id;
                }
            }
            _ => {}
        }
    }

    /// Adds a component panel to a workspace (beside the inspector when
    /// there is one), or focuses it when it is already there.
    fn add_panel_to(&mut self, ws_id: u64, comp: Comp) {
        let Some(ws) = self.workspaces.iter_mut().find(|w| w.id == ws_id) else { return };
        if let Some(l) = ws.layout.leaves().iter().find(|(_, k)| *k == LeafKind::Comp(comp)).map(|l| l.0) {
            ws.focus = Some(l);
            return;
        }
        let anchor = ws.layout.leaves().iter().find(|(_, k)| *k == LeafKind::Comp(Comp::Inspector)).map(|l| l.0).or(ws.focus);
        let new = ws.layout.split(anchor, LeafKind::Comp(comp), Dir::V, 0.5);
        ws.focus = Some(new);
        ws.layout_dirty = true;
    }

    /// `c` / `x`: the plain agent, or a picker when the project has presets.
    pub fn start_agent(&mut self, kind: PaneKind) {
        let Some(root) = self.project.clone() else {
            self.say("pick a project first", Tone::Warn);
            return;
        };
        let items = self.cfg.presets_for(&root, kind_label(kind));
        if items.is_empty() {
            self.new_workspace(Some(kind), Launch::default());
        } else {
            self.overlay = Some(Overlay::Presets { agent: kind, items, sel: 0 });
        }
    }

    fn start_preset(&mut self, kind: PaneKind, p: Option<crate::config::Preset>) {
        match p {
            Some(p) if p.worktree => {
                self.overlay = Some(Overlay::Input { prompt: format!("branch for \"{}\" in its own worktree", p.name), value: String::new(), kind: InputKind::Worktree(kind, Some(p)), secret: false });
            }
            Some(p) => {
                let name = p.name.clone();
                self.new_workspace_with(Some(kind), preset_launch(Some(&p)), WsOpts { name: Some(one_line(&name, 30)), ..Default::default() });
            }
            None => self.new_workspace(Some(kind), Launch::default()),
        }
    }

    /// `y` then a letter copies something about the selected session.
    fn yank(&mut self, c: char) {
        let Some(card) = self.cards.get(self.sel_card).cloned() else { return };
        let snap = self.shared.clone();
        let snap = snap.lock().unwrap();
        let run = card.run.as_ref().and_then(|k| snap.runs.get(k)).cloned();
        let info = card.run.as_ref().and_then(|k| snap.sessions.get(k)).cloned();
        drop(snap);
        let Some(key) = card.run.clone() else {
            self.say("nothing to copy yet: the session has no id until its first prompt", Tone::Info);
            return;
        };
        let cwd = run.as_ref().map(|r| r.cwd.clone()).filter(|c| !c.is_empty()).or_else(|| info.as_ref().map(|i| i.cwd.clone())).unwrap_or_default();
        let (what, text) = match c {
            'r' => {
                let pk = if key.kind == AgentKind::Codex { PaneKind::Codex } else { PaneKind::Claude };
                ("the resume command", format!("cd {} && {}", shell_words::quote(&cwd), self.agent_command(pk, &Launch::resume(key.clone())).unwrap_or_default()))
            }
            'i' => ("the session id", key.id.clone()),
            'c' => ("its folder", cwd.clone()),
            't' => ("the title", self.card_title(&card)),
            'l' => ("the last reply", run.as_ref().map(|r| r.last_reply.clone()).unwrap_or_default()),
            'f' => {
                let root = store::work_root(Path::new(&cwd)).unwrap_or(cwd.clone());
                let mut v: Vec<&FileTouch> = run.as_ref().map(|r| r.files.values().filter(|f| f.edits + f.writes > 0).collect()).unwrap_or_default();
                v.sort_by(|a, b| a.path.cmp(&b.path));
                ("the changed files", v.iter().map(|f| rel_path(&f.path, &root)).collect::<Vec<_>>().join("\n"))
            }
            'p' => {
                let r = run.as_ref();
                let tasks = r.map(|r| r.tasks.iter().map(|t| format!("- [{}] {}", match t.status { TaskStatus::Done => "x", TaskStatus::InProgress => "~", TaskStatus::Pending => " " }, t.subject)).collect::<Vec<_>>().join("\n")).unwrap_or_default();
                let goal = r.map(|r| r.goal.clone()).filter(|g| !g.is_empty()).map(|g| format!("goal: {g}\n")).unwrap_or_default();
                ("the plan", format!("{goal}{tasks}"))
            }
            _ => {
                self.say("y then r resume command, i id, c folder, t title, l last reply, f changed files, p plan", Tone::Info);
                return;
            }
        };
        if text.trim().is_empty() {
            self.say(format!("nothing to copy: {what} is empty"), Tone::Info);
            return;
        }
        copy_text(&text);
        self.say(format!("copied {what}"), Tone::Ok);
    }

    /// Warns once per window when an agent is about to hit its limit.
    fn check_quota(&mut self) {
        let now = now_ms();
        let quotas = self.quota.lock().unwrap().clone();
        for q in quotas {
            for w in q.current(now) {
                let short = matches!(w.pace(now), crate::quota::Pace::RunsOut(_));
                if w.used < 90.0 && !(short && w.used >= 70.0) {
                    continue;
                }
                let key = format!("{}-{}-{}", q.agent.label(), w.name, w.resets_at);
                if !self.quota_warned.insert(key) {
                    continue;
                }
                let other = if q.agent == AgentKind::Claude { "codex" } else { "claude" };
                let msg = format!("{} {} limit at {:.0}%; < on a session continues it in {other}", q.agent.label(), w.name, w.used);
                self.notifier.send(&format!("quota-{}", q.agent.label()), &format!("{} is near its {} limit", q.agent.label(), w.name), &msg);
                self.say(msg, Tone::Warn);
            }
        }
    }

    pub fn open_command(&mut self) {
        self.overlay = Some(Overlay::Command { value: String::new(), sel: 0 });
    }

    /// Completions for the command line as it stands: commands, or the
    /// arguments of the one typed.
    pub fn completions(&self, value: &str) -> Vec<(String, String)> {
        let (cmd, rest) = value.split_once(' ').map(|(a, b)| (a, Some(b))).unwrap_or((value, None));
        match rest {
            None => COMMANDS
                .iter()
                .filter(|(n, _, _)| n.starts_with(cmd))
                .chain(COMMANDS.iter().filter(|(n, _, _)| !n.starts_with(cmd) && n.contains(cmd)))
                .map(|(n, a, d)| (n.to_string(), if a.is_empty() { d.to_string() } else { format!("{a} · {d}") }))
                .collect(),
            Some(arg) => {
                let opts: Vec<String> = match cmd {
                    "theme" => crate::theme::PRESETS.iter().map(|s| s.to_string()).collect(),
                    "filter" => StatusFilter::ORDER.iter().map(|f| f.label().replace(' ', "-")).collect(),
                    "new" => vec!["claude".into(), "codex".into(), "terminal".into()],
                    "worktree" => vec!["claude".into(), "codex".into()],
                    "yank" => ["resume", "id", "folder", "title", "reply", "files", "plan"].iter().map(|s| s.to_string()).collect(),
                    "layout" => vec!["save".into(), "default".into(), "reset".into()],
                    "preset" => self.project.as_ref().map(|r| [self.cfg.presets_for(r, "claude"), self.cfg.presets_for(r, "codex")].concat().into_iter().map(|p| p.name).collect()).unwrap_or_default(),
                    "project" => {
                        let snap = self.shared.lock().unwrap();
                        snap.projects.iter().map(|p| p.name.clone()).collect()
                    }
                    _ => Vec::new(),
                };
                opts.into_iter().filter(|o| o.starts_with(arg)).map(|o| (format!("{cmd} {o}"), String::new())).collect()
            }
        }
    }

    /// Runs a `:` command.
    pub fn run_command(&mut self, line: &str) {
        let line = line.trim();
        let (cmd, arg) = line.split_once(' ').map(|(a, b)| (a, b.trim())).unwrap_or((line, ""));
        // Session commands act on the selected row, or on the open session.
        if self.view == View::Focus {
            if let Some(ws) = self.active_ws {
                let run = self.active_run();
                if let Some(i) = self.cards.iter().position(|c| card_ws(c) == Some(ws) || (run.is_some() && c.run == run)) {
                    self.sel_card = i;
                }
            }
        }
        match cmd {
            "" => {}
            "open" => self.open_card(self.sel_card),
            "resume" => self.resume_card(self.sel_card),
            "prompt" if !arg.is_empty() => {
                let ids: Vec<CardId> = self.targets().iter().map(card_id).collect();
                self.send_prompts(ids, arg.to_string());
            }
            "prompt" => self.ask_prompt(),
            "new" => match arg {
                "codex" => self.start_agent(PaneKind::Codex),
                "terminal" | "shell" => self.new_workspace(None, Launch::default()),
                _ => self.start_agent(PaneKind::Claude),
            },
            "preset" => {
                let Some(root) = self.project.clone() else { return };
                let all = [self.cfg.presets_for(&root, "claude"), self.cfg.presets_for(&root, "codex")].concat();
                match all.into_iter().find(|p| p.name == arg) {
                    Some(p) => {
                        let kind = if p.agent == "codex" { PaneKind::Codex } else { PaneKind::Claude };
                        self.start_preset(kind, Some(p));
                    }
                    None => self.say(format!("no preset called \"{arg}\" for this project"), Tone::Warn),
                }
            }
            "fork" => self.fork_card(),
            "handoff" => self.handoff_card(),
            "failover" => self.failover_card(),
            "review" => self.review_card(),
            "diff" | "hunks" => self.changes_card(),
            "rename" => {
                if let Some(c) = self.cards.get(self.sel_card).cloned() {
                    self.submit_input(InputKind::Rename(card_id(&c)), arg.to_string());
                }
            }
            "archive" => self.dash_key(KeyEvent::new(KeyCode::Char('A'), KeyModifiers::SHIFT)),
            "close" => self.dash_key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::NONE)),
            "filter" => match StatusFilter::ORDER.iter().find(|f| f.label().replace(' ', "-") == arg || f.label() == arg) {
                Some(f) => {
                    self.status_filter = *f;
                    self.sel_card = 0;
                    if self.project.is_some() {
                        self.view = View::Dash;
                    }
                }
                None => self.say("filter all, needs-you, working, ready, closed or archived", Tone::Info),
            },
            "search" => {
                self.open_search();
                if let Some(Overlay::Search { query, .. }) = &mut self.overlay {
                    *query = arg.to_string();
                }
            }
            "yank" | "copy" => {
                let c = match arg {
                    "resume" => 'r',
                    "id" => 'i',
                    "folder" | "path" => 'c',
                    "title" => 't',
                    "reply" => 'l',
                    "files" => 'f',
                    "plan" => 'p',
                    _ => '?',
                };
                self.yank(c);
            }
            "theme" => {
                if crate::theme::PRESETS.contains(&arg) {
                    self.cfg.ui.theme = arg.to_string();
                    self.theme = Theme::from_config(&self.cfg);
                    self.cfg.save_ui_theme();
                    self.say(format!("theme: {arg}"), Tone::Info);
                } else if arg.is_empty() {
                    self.cycle_theme();
                } else {
                    self.say(format!("themes: {}", crate::theme::PRESETS.join(" ")), Tone::Info);
                }
            }
            "awake" | "sleep" => self.toggle_sleep(),
            "worktree" => {
                let (kind, branch) = match arg.split_once(' ') {
                    Some(("codex", b)) => (PaneKind::Codex, b),
                    Some(("claude", b)) => (PaneKind::Claude, b),
                    _ if arg == "codex" => (PaneKind::Codex, ""),
                    _ if arg == "claude" => (PaneKind::Claude, ""),
                    _ => (PaneKind::Claude, arg),
                };
                self.start_worktree(kind, branch, None);
            }
            "project" => {
                let root = {
                    let snap = self.shared.lock().unwrap();
                    snap.projects.iter().find(|p| p.name == arg || p.root == arg).map(|p| p.root.clone())
                };
                match root {
                    Some(r) => self.open_project(r),
                    None => self.say(format!("no project called {arg}"), Tone::Warn),
                }
            }
            "next" => self.next_attention(),
            "projects" => self.switch_view(View::Projects),
            "dash" | "sessions" => self.switch_view(View::Dash),
            "skills" => self.switch_view(View::Skills),
            "secrets" => self.switch_view(View::Secrets),
            "stats" => self.switch_view(View::Stats),
            "layout" => match (arg, self.active_ws) {
                ("save", Some(id)) => {
                    if let Some(ws) = self.workspaces.iter_mut().find(|w| w.id == id) {
                        ws.template = true;
                    }
                    self.save_layout_of(id);
                    self.say("saved this layout for the project's new sessions", Tone::Ok);
                }
                ("default", Some(id)) => match self.layout_spec_of(id) {
                    Some(spec) => {
                        layout::save_default(&spec);
                        self.say("saved this layout as the default for new sessions everywhere", Tone::Ok);
                    }
                    None => self.say("a read-only view has no layout to save; open a running session", Tone::Info),
                },
                ("reset", _) => {
                    if let Some(root) = self.project.clone() {
                        let _ = std::fs::remove_file(layout::layouts_dir().join(format!("{}.toml", Self::project_key(&root))));
                        self.say("new sessions here use the default layout again", Tone::Ok);
                    }
                }
                _ => self.say("inside a session: layout save (this project) or layout default (everywhere); layout reset", Tone::Info),
            },
            "help" | "keys" => self.overlay = Some(Overlay::Help),
            "quit" | "q" => self.ask_quit(),
            other => self.say(format!("no command \"{other}\"; : then tab lists them"), Tone::Warn),
        }
    }

    fn start_worktree(&mut self, kind: PaneKind, name: &str, preset: Option<crate::config::Preset>) {
        let Some(root) = self.project.clone() else { return };
        let name = if name.trim().is_empty() { format!("{}-{}", kind_label(kind), chrono::Local::now().format("%m%d-%H%M")) } else { name.to_string() };
        match crate::worktree::create(&root, &name, &Self::project_key(&root)) {
            Ok(wt) => {
                let label = format!("{} on {}", kind_label(kind), wt.branch);
                let branch = wt.branch.clone();
                self.new_workspace_with(Some(kind), preset_launch(preset.as_ref()), WsOpts { worktree: Some(wt), name: Some(label), ..Default::default() });
                self.say(format!("new branch {branch} in its own worktree; closing the session asks whether to merge it"), Tone::Ok);
            }
            Err(e) => self.say(format!("worktree: {e}"), Tone::Err),
        }
    }

    pub fn skill_dirs(&self) -> (PathBuf, Vec<PathBuf>) {
        (config::expand(&self.cfg.skills.source), self.cfg.skills.targets.iter().map(|t| config::expand(t)).collect())
    }

    pub fn refresh_skills(&mut self) {
        let (src, targets) = self.skill_dirs();
        let usage = self.skills_usage.lock().unwrap().clone();
        if usage.is_none() {
            let slot = self.skills_usage.clone();
            std::thread::spawn(move || {
                let u = skills::usage_counts();
                *slot.lock().unwrap() = Some(u);
            });
        }
        self.skills = skills::inventory(&src, &targets, &usage.unwrap_or_default());
        self.skills.sort_by(|a, b| b.uses.cmp(&a.uses).then(a.name.cmp(&b.name)));
        if self.skills_sel >= self.skills.len() {
            self.skills_sel = self.skills.len().saturating_sub(1);
        }
    }

    fn skills_key(&mut self, k: KeyEvent) {
        let n = self.skills.len();
        let (src, targets) = self.skill_dirs();
        match k.code {
            KeyCode::Char('j') | KeyCode::Down => self.skills_sel = (self.skills_sel + 1).min(n.saturating_sub(1)),
            KeyCode::Char('k') | KeyCode::Up => self.skills_sel = self.skills_sel.saturating_sub(1),
            KeyCode::Char('r') => {
                *self.skills_usage.lock().unwrap() = None;
                self.refresh_skills();
                self.say("refreshing skills and recounting usage", Tone::Info);
            }
            KeyCode::Char('g') | KeyCode::Home => self.skills_sel = 0,
            KeyCode::Char('G') | KeyCode::End => self.skills_sel = n.saturating_sub(1),
            KeyCode::Char('s') => {
                self.skills_log = skills::sync(&src, &targets);
                self.refresh_skills();
            }
            KeyCode::Char('a') => {
                if let Some(s) = self.skills.get(self.skills_sel) {
                    let copies: Vec<String> = s
                        .installs
                        .iter()
                        .filter(|(_, (st, _))| matches!(st, skills::Status::CopySame | skills::Status::Drift | skills::Status::Unmanaged | skills::Status::Missing))
                        .map(|(t, (st, _))| format!("{t}: {}", st.label()))
                        .collect();
                    if copies.is_empty() && s.in_source {
                        self.say("already managed", Tone::Info);
                        return;
                    }
                    self.overlay = Some(Overlay::Confirm {
                        msg: vec![
                            format!("adopt {}?", s.name),
                            format!("it moves into {} and every CLI gets a symlink.", config::display_path(&src)),
                            "real-directory copies are backed up under ~/.local/state/polypore/skill-backups.".into(),
                            copies.join(" · "),
                        ],
                        action: Action::AdoptSkill(s.name.clone()),
                    });
                }
            }
            KeyCode::Char('d') => {
                if let Some(s) = self.skills.get(self.skills_sel) {
                    self.skills_log = skills::remove_broken(&s.name, &targets);
                    if self.skills_log.is_empty() {
                        self.skills_log.push("no broken links for that skill".into());
                    }
                    self.refresh_skills();
                }
            }
            KeyCode::Char('n') => {
                self.overlay = Some(Overlay::Input { prompt: "new skill name".into(), value: String::new(), kind: InputKind::NewSkill, secret: false })
            }
            KeyCode::Char('e') | KeyCode::Enter => {
                if let Some(s) = self.skills.get(self.skills_sel).cloned() {
                    let dir = if s.in_source {
                        src.join(&s.name)
                    } else {
                        targets.iter().map(|t| t.join(&s.name)).find(|p| p.exists()).unwrap_or_else(|| src.join(&s.name))
                    };
                    self.edit_file(&dir.join("SKILL.md"));
                }
            }
            _ => {}
        }
    }

    fn edit_file(&mut self, path: &Path) {
        let editor = std::env::var("VISUAL").or_else(|_| std::env::var("EDITOR")).unwrap_or_else(|_| "nvim".into());
        let dir = path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        if self.project.is_none() {
            self.project = Some(dir.clone());
        }
        let Some(p) = self.spawn_pane(PaneKind::Shell, &dir, &Launch::default()) else { return };
        if let Some(pane) = self.panes.get_mut(&p) {
            pane.write(format!("{} {}\r", editor, shell_words::quote(&path.to_string_lossy())).as_bytes());
        }
        let mut layout = Layout::empty();
        let leaf = layout.split(None, LeafKind::Term(p), Dir::H, 0.5);
        let id = self.next_ws;
        self.next_ws += 1;
        let project = self.project.clone().unwrap_or(dir);
        self.workspaces.push(Workspace {
            id,
            project,
            name: format!("edit {}", path.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default()),
            layout,
            focus: Some(leaf),
            zoom: None,
            observed: None,
            seen: now_ms(),
            layout_dirty: false,
            template: false,
            worktree: None,
        });
        self.focus_ws(id);
    }

    pub fn refresh_secrets(&mut self) {
        let Some(root) = self.project.clone() else {
            self.secrets_list.clear();
            self.env_keys.clear();
            return;
        };
        self.secrets_list = secrets::list(&root);
        self.env_keys = secrets::env_file_keys(Path::new(&root));
        if self.secrets_sel >= self.secrets_list.len() {
            self.secrets_sel = self.secrets_list.len().saturating_sub(1);
        }
    }

    fn secrets_key(&mut self, k: KeyEvent) {
        let Some(root) = self.project.clone() else {
            if matches!(k.code, KeyCode::Enter) {
                self.view = View::Projects;
            }
            return;
        };
        let n = self.secrets_list.len();
        match k.code {
            KeyCode::Char('j') | KeyCode::Down => self.secrets_sel = (self.secrets_sel + 1).min(n.saturating_sub(1)),
            KeyCode::Char('k') | KeyCode::Up => self.secrets_sel = self.secrets_sel.saturating_sub(1),
            KeyCode::Char('i') => {
                if self.env_keys.is_empty() {
                    self.say("no .env files with keys in this project", Tone::Info);
                    return;
                }
                let mut msg = vec!["import these into the OS keyring and remove them from the files?".to_string()];
                for (p, keys) in &self.env_keys {
                    msg.push(format!("{}: {}", p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), keys.join(", ")));
                }
                msg.push("each line becomes a comment. polypore terminals and `polypore run` inject the values.".into());
                self.overlay = Some(Overlay::Confirm { msg, action: Action::ImportEnv(root) });
            }
            KeyCode::Char('a') => {
                self.overlay = Some(Overlay::Input { prompt: "secret name (e.g. STRIPE_API_KEY)".into(), value: String::new(), kind: InputKind::SecretName, secret: false })
            }
            KeyCode::Char('d') => {
                if let Some(s) = self.secrets_list.get(self.secrets_sel) {
                    self.overlay = Some(Overlay::Confirm {
                        msg: vec![format!("delete {} from the keyring?", s.name), "this cannot be undone.".into()],
                        action: Action::DeleteSecret(s.project.clone(), s.name.clone()),
                    });
                }
            }
            KeyCode::Char('w') => {
                let mut msg = vec!["wire this project so agents use the broker:".to_string()];
                msg.extend(secrets::wire_preview(Path::new(&root)).into_iter().map(|l| format!("· {l}")));
                self.overlay = Some(Overlay::Confirm { msg, action: Action::WireProject(root) });
            }
            KeyCode::Char('r') => self.refresh_secrets(),
            _ => {}
        }
    }

    pub fn start_stats(&mut self) {
        let sessions: Vec<store::SessionInfo> = self.shared.lock().unwrap().sessions.values().cloned().collect();
        let state = config::state_dir().to_string_lossy().to_string();
        let sessions = sessions.into_iter().filter(|s| !s.root.starts_with(&state)).collect();
        analysis::start_stats(self.analysis.clone(), sessions, 30);
    }

    fn stats_key(&mut self, k: KeyEvent) {
        match k.code {
            KeyCode::Char('r') => self.start_stats(),
            KeyCode::Char('m') => {
                let cmd = self.cfg.analysis.command.clone();
                self.overlay = Some(Overlay::Confirm {
                    msg: vec![
                        format!("run `{cmd}` over an extract of the last 30 days?"),
                        format!("about {} KB of your prompts and errors goes to the model. it uses your subscription quota.", self.cfg.analysis.max_extract_kb),
                        format!("the report is saved to {} when that folder exists.", self.cfg.analysis.wiki),
                    ],
                    action: Action::RunAnalysis,
                });
            }
            KeyCode::Char('o') | KeyCode::Enter => {
                if self.analysis.lock().unwrap().report.is_some() {
                    self.overlay = Some(Overlay::Report { scroll: 0 });
                } else {
                    let latest = latest_report();
                    if let Some((p, body)) = latest {
                        let mut a = self.analysis.lock().unwrap();
                        a.report = Some(body);
                        a.report_path = Some(p);
                        drop(a);
                        self.overlay = Some(Overlay::Report { scroll: 0 });
                    } else {
                        self.say("no report yet; m runs one", Tone::Info);
                    }
                }
            }
            KeyCode::Char('j') | KeyCode::Down => self.stats_scroll = self.stats_scroll.saturating_add(1),
            KeyCode::Char('k') | KeyCode::Up => self.stats_scroll = self.stats_scroll.saturating_sub(1),
            KeyCode::PageDown | KeyCode::Char(' ') => self.stats_scroll = self.stats_scroll.saturating_add(15),
            KeyCode::PageUp => self.stats_scroll = self.stats_scroll.saturating_sub(15),
            KeyCode::Char('g') | KeyCode::Home => self.stats_scroll = 0,
            KeyCode::Char('G') | KeyCode::End => self.stats_scroll = u16::MAX,
            _ => {}
        }
    }

    fn overlay_key(&mut self, k: KeyEvent) {
        let Some(ov) = self.overlay.take() else { return };
        match ov {
            Overlay::Help => {
                if !matches!(k.code, KeyCode::Esc | KeyCode::Char('q') | KeyCode::Char('?') | KeyCode::Enter) {
                    self.overlay = Some(Overlay::Help);
                }
            }
            Overlay::Report { scroll } => match k.code {
                KeyCode::Esc | KeyCode::Char('q') => {}
                KeyCode::Char('j') | KeyCode::Down => self.overlay = Some(Overlay::Report { scroll: scroll + 1 }),
                KeyCode::Char('k') | KeyCode::Up => self.overlay = Some(Overlay::Report { scroll: scroll.saturating_sub(1) }),
                KeyCode::PageDown | KeyCode::Char(' ') => self.overlay = Some(Overlay::Report { scroll: scroll + 20 }),
                KeyCode::PageUp => self.overlay = Some(Overlay::Report { scroll: scroll.saturating_sub(20) }),
                _ => self.overlay = Some(Overlay::Report { scroll }),
            },
            Overlay::Palette { sel, items } => match k.code {
                KeyCode::Esc => {}
                KeyCode::Char('j') | KeyCode::Down | KeyCode::Tab => {
                    self.overlay = Some(Overlay::Palette { sel: (sel + 1) % items.len(), items })
                }
                KeyCode::Char('k') | KeyCode::Up | KeyCode::BackTab => {
                    self.overlay = Some(Overlay::Palette { sel: (sel + items.len() - 1) % items.len(), items })
                }
                KeyCode::Enter => self.apply_palette(&items[sel]),
                _ => self.overlay = Some(Overlay::Palette { sel, items }),
            },
            Overlay::Search { mut query, sel } => {
                let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
                let n = self.search_hits.len();
                match k.code {
                    KeyCode::Esc => {}
                    KeyCode::Enter => self.open_hit(sel, false),
                    KeyCode::Char('r') if ctrl => self.open_hit(sel, true),
                    KeyCode::Down | KeyCode::Tab => self.overlay = Some(Overlay::Search { query, sel: (sel + 1).min(n.saturating_sub(1)) }),
                    KeyCode::Char('j') | KeyCode::Char('n') if ctrl => self.overlay = Some(Overlay::Search { query, sel: (sel + 1).min(n.saturating_sub(1)) }),
                    KeyCode::Up | KeyCode::BackTab => self.overlay = Some(Overlay::Search { query, sel: sel.saturating_sub(1) }),
                    KeyCode::Char('k') | KeyCode::Char('p') if ctrl => self.overlay = Some(Overlay::Search { query, sel: sel.saturating_sub(1) }),
                    KeyCode::Char('u') if ctrl => self.overlay = Some(Overlay::Search { query: String::new(), sel: 0 }),
                    KeyCode::Char('w') if ctrl => {
                        let t = query.trim_end();
                        let cut = t.rfind(' ').map(|i| i + 1).unwrap_or(0);
                        query.truncate(cut);
                        self.overlay = Some(Overlay::Search { query, sel: 0 });
                    }
                    KeyCode::Backspace => {
                        query.pop();
                        self.overlay = Some(Overlay::Search { query, sel: 0 });
                    }
                    KeyCode::Char(c) if !ctrl => {
                        query.push(c);
                        self.overlay = Some(Overlay::Search { query, sel: 0 });
                    }
                    _ => self.overlay = Some(Overlay::Search { query, sel }),
                }
            }
            Overlay::Presets { agent, items, sel } => {
                let n = items.len() + 1;
                match k.code {
                    KeyCode::Esc | KeyCode::Char('q') => {}
                    KeyCode::Char('j') | KeyCode::Down | KeyCode::Tab => self.overlay = Some(Overlay::Presets { agent, items, sel: (sel + 1) % n }),
                    KeyCode::Char('k') | KeyCode::Up | KeyCode::BackTab => self.overlay = Some(Overlay::Presets { agent, items, sel: (sel + n - 1) % n }),
                    KeyCode::Enter => {
                        let p = if sel == 0 { None } else { items.get(sel - 1).cloned() };
                        self.start_preset(agent, p);
                    }
                    KeyCode::Char(c @ '1'..='9') if ((c as u8 - b'1') as usize) < n => {
                        let i = (c as u8 - b'1') as usize;
                        let p = if i == 0 { None } else { items.get(i - 1).cloned() };
                        self.start_preset(agent, p);
                    }
                    _ => self.overlay = Some(Overlay::Presets { agent, items, sel }),
                }
            }
            Overlay::Command { mut value, sel } => {
                let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
                let comps = self.completions(&value);
                match k.code {
                    KeyCode::Esc => {}
                    KeyCode::Enter => {
                        // Something half typed runs the highlighted completion.
                        let typed_cmd = value.split(' ').next().unwrap_or("");
                        let exact = COMMANDS.iter().any(|(n, _, _)| *n == typed_cmd);
                        let line = match comps.get(sel) {
                            Some((c, _)) if !value.contains(' ') && !exact => c.clone(),
                            Some((c, _)) if value.contains(' ') && c.starts_with(value.trim_end()) => c.clone(),
                            _ => value,
                        };
                        self.run_command(&line);
                    }
                    KeyCode::Tab => {
                        if let Some((c, _)) = comps.get(sel) {
                            value = if value.contains(' ') || COMMANDS.iter().any(|(n, a, _)| n == c && a.is_empty()) { c.clone() } else { format!("{c} ") };
                        }
                        self.overlay = Some(Overlay::Command { value, sel: 0 });
                    }
                    KeyCode::Down => self.overlay = Some(Overlay::Command { value, sel: (sel + 1).min(comps.len().saturating_sub(1)) }),
                    KeyCode::Char('n') | KeyCode::Char('j') if ctrl => self.overlay = Some(Overlay::Command { value, sel: (sel + 1).min(comps.len().saturating_sub(1)) }),
                    KeyCode::Up | KeyCode::BackTab => self.overlay = Some(Overlay::Command { value, sel: sel.saturating_sub(1) }),
                    KeyCode::Char('p') | KeyCode::Char('k') if ctrl => self.overlay = Some(Overlay::Command { value, sel: sel.saturating_sub(1) }),
                    KeyCode::Char('u') if ctrl => self.overlay = Some(Overlay::Command { value: String::new(), sel: 0 }),
                    KeyCode::Backspace => {
                        if value.is_empty() {
                            return;
                        }
                        value.pop();
                        self.overlay = Some(Overlay::Command { value, sel: 0 });
                    }
                    KeyCode::Char(c) if !ctrl => {
                        value.push(c);
                        self.overlay = Some(Overlay::Command { value, sel: 0 });
                    }
                    _ => self.overlay = Some(Overlay::Command { value, sel }),
                }
            }
            Overlay::Choice { title, msg, options } => match k.code {
                KeyCode::Esc | KeyCode::Char('q') => {}
                KeyCode::Char(c) if options.iter().any(|o| o.0 == c) => {
                    let a = options.into_iter().find(|o| o.0 == c).map(|o| o.2).unwrap();
                    self.run_action(a);
                }
                _ => self.overlay = Some(Overlay::Choice { title, msg, options }),
            },
            Overlay::Confirm { msg, action } => match k.code {
                KeyCode::Char('y') | KeyCode::Enter => self.run_action(action),
                KeyCode::Char('n') | KeyCode::Esc | KeyCode::Char('q') => {}
                _ => self.overlay = Some(Overlay::Confirm { msg, action }),
            },
            Overlay::Input { prompt, mut value, kind, secret } => match k.code {
                KeyCode::Esc => {
                    if matches!(kind, InputKind::Filter) {
                        self.filter.clear();
                    }
                }
                KeyCode::Enter => self.submit_input(kind, value),
                KeyCode::Backspace => {
                    value.pop();
                    if matches!(kind, InputKind::Filter) {
                        self.filter = value.clone();
                    }
                    self.overlay = Some(Overlay::Input { prompt, value, kind, secret });
                }
                KeyCode::Char('u') if k.modifiers.contains(KeyModifiers::CONTROL) => {
                    value.clear();
                    self.overlay = Some(Overlay::Input { prompt, value, kind, secret });
                }
                KeyCode::Char(c) => {
                    value.push(c);
                    if matches!(kind, InputKind::Filter) {
                        self.filter = value.clone();
                        self.sel_project = 0;
                        self.sel_card = 0;
                    }
                    self.overlay = Some(Overlay::Input { prompt, value, kind, secret });
                }
                _ => self.overlay = Some(Overlay::Input { prompt, value, kind, secret }),
            },
        }
    }

    fn apply_palette(&mut self, item: &PaletteItem) {
        match item {
            PaletteItem::Comp(c) => self.split_focused(LeafKind::Comp(*c)),
            PaletteItem::Term(k) => self.add_terminal(*k),
        }
    }

    fn submit_input(&mut self, kind: InputKind, value: String) {
        match kind {
            InputKind::Filter => self.filter = value,
            InputKind::Prompt(ids) => self.send_prompts(ids, value),
            InputKind::Worktree(kind, preset) => self.start_worktree(kind, &value, preset),
            InputKind::Rename(id) => match id {
                CardId::Run(k) => {
                    self.smeta.rename(&k, &value);
                    if let Some(ws) = self.workspaces.iter_mut().find(|w| self.panes.values().any(|p| p.run.as_ref() == Some(&k) && w.layout.terms().contains(&p.id)) || w.observed.as_ref() == Some(&k)) {
                        if !value.trim().is_empty() {
                            ws.name = one_line(value.trim(), 30);
                        }
                    }
                }
                CardId::Ws(id) => {
                    let run = self.workspaces.iter().find(|w| w.id == id).and_then(|w| self.ws_run(w));
                    if let Some(k) = run {
                        self.smeta.rename(&k, &value);
                    }
                    if let Some(ws) = self.workspaces.iter_mut().find(|w| w.id == id) {
                        if !value.trim().is_empty() {
                            ws.name = one_line(value.trim(), 30);
                        }
                    }
                }
            },
            InputKind::AddProject => {
                let p = project_path(value.trim());
                if p.as_os_str().is_empty() {
                    return;
                }
                if p.exists() && !p.is_dir() {
                    self.say(format!("{} is a file, not a folder", config::display_path(&p)), Tone::Err);
                    return;
                }
                if !p.exists() {
                    if let Err(e) = std::fs::create_dir_all(&p) {
                        self.say(format!("could not create {}: {e}", config::display_path(&p)), Tone::Err);
                        return;
                    }
                    self.say(format!("created {}", config::display_path(&p)), Tone::Ok);
                }
                let root = store::git_root(&p).unwrap_or_else(|| p.to_string_lossy().to_string());
                if !self.cfg.projects.extra.contains(&root) {
                    self.cfg.projects.extra.push(root.clone());
                    self.cfg.save_projects();
                }
                self.open_project(root);
            }
            InputKind::NewSkill => {
                let (src, targets) = self.skill_dirs();
                match skills::create(value.trim(), &src, &targets) {
                    Ok(md) => {
                        self.refresh_skills();
                        self.edit_file(&md);
                    }
                    Err(e) => self.say(e, Tone::Err),
                }
            }
            InputKind::SecretName => {
                let name = value.trim().to_string();
                if !secrets::valid_name(&name) {
                    self.say("use letters, digits and _, not starting with a digit", Tone::Err);
                    return;
                }
                self.overlay = Some(Overlay::Input { prompt: format!("value for {name} (hidden)"), value: String::new(), kind: InputKind::SecretValue(name), secret: true });
            }
            InputKind::SecretValue(name) => {
                let Some(root) = self.project.clone() else { return };
                match secrets::set(&root, &name, &value, "manual") {
                    Ok(_) => self.say(format!("{name} saved to the keyring"), Tone::Ok),
                    Err(e) => self.say(format!("keyring: {e}"), Tone::Err),
                }
                self.refresh_secrets();
            }
        }
    }

    fn run_action(&mut self, a: Action) {
        match a {
            Action::Quit => self.quit = true,
            Action::FinishWorktree(id, end) => self.finish_worktree(id, end),
            Action::RevertHunk(leaf, i) => self.revert_hunk(leaf, i),
            Action::CloseWorkspace(id) => self.close_workspace(id, true),
            Action::CloseLeaf(l) => self.close_leaf(l, true),
            Action::StopJob(k) => self.stop_job(&k),
            Action::ImportEnv(root) => {
                match secrets::import_env(Path::new(&root)) {
                    Ok(keys) => self.say(format!("moved {} key{} into the keyring", keys.len(), if keys.len() == 1 { "" } else { "s" }), Tone::Ok),
                    Err(e) => self.say(format!("import failed, files untouched: {e}"), Tone::Err),
                }
                self.refresh_secrets();
            }
            Action::DeleteSecret(project, name) => {
                match secrets::remove(&project, &name) {
                    Ok(_) => self.say(format!("deleted {name}"), Tone::Ok),
                    Err(e) => self.say(e, Tone::Err),
                }
                self.refresh_secrets();
            }
            Action::WireProject(root) => {
                let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("polypore"));
                let (src, targets) = self.skill_dirs();
                self.secrets_log = secrets::wire_project(Path::new(&root), &exe, &src, &targets);
                self.say("project wired; see the log", Tone::Ok);
            }
            Action::AdoptSkill(name) => {
                let (src, targets) = self.skill_dirs();
                match skills::adopt(&name, &src, &targets) {
                    Ok(log) => self.skills_log = log,
                    Err(e) => self.say(e, Tone::Err),
                }
                self.refresh_skills();
            }
            Action::RunAnalysis => {
                let wiki = config::expand(&self.cfg.analysis.wiki);
                analysis::start_llm(self.analysis.clone(), self.cfg.analysis.command.clone(), wiki, self.cfg.analysis.max_extract_kb);
            }
        }
    }

    // ---------- mouse ----------

    fn hit_at(&self, x: u16, y: u16) -> Option<Hit> {
        self.hits.iter().rev().find(|(r, _)| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height).map(|(_, h)| h.clone())
    }

    fn on_mouse(&mut self, m: MouseEvent) {
        let (x, y) = (m.column, m.row);
        if let Some(Drag::Split { handle }) = &self.drag {
            match m.kind {
                MouseEventKind::Drag(_) => {
                    let h = handle.clone();
                    let ratio = match h.dir {
                        Dir::H => (x.saturating_sub(h.area.x)) as f32 / h.area.width.max(1) as f32,
                        Dir::V => (y.saturating_sub(h.area.y)) as f32 / h.area.height.max(1) as f32,
                    };
                    if let Some(ws) = self.active_mut() {
                        ws.layout.set_ratio(&h.path, ratio);
                        ws.layout_dirty = true;
                    }
                    return;
                }
                MouseEventKind::Up(_) => {
                    self.drag = None;
                    return;
                }
                _ => {}
            }
        }
        if let Some(Drag::Move { from }) = &self.drag {
            let from = *from;
            if let MouseEventKind::Up(_) = m.kind {
                self.drag = None;
                if let Some(Hit::Leaf(to) | Hit::LeafTitle(to)) = self.hit_at(x, y) {
                    if to != from {
                        if let Some(ws) = self.active_mut() {
                            ws.layout.swap(from, to);
                            ws.focus = Some(to);
                            ws.layout_dirty = true;
                        }
                    }
                }
                return;
            }
            if let MouseEventKind::Drag(_) = m.kind {
                return;
            }
        }
        if self.overlay.is_some() {
            if let MouseEventKind::Down(MouseButton::Left) = m.kind {
                if let Some(Hit::Palette(i)) = self.hit_at(x, y) {
                    if let Some(Overlay::Palette { items, .. }) = self.overlay.take() {
                        if let Some(it) = items.get(i) {
                            self.apply_palette(&it.clone());
                        }
                    }
                }
            }
            return;
        }
        // Split handles: a press on the gap line between panes.
        if self.view == View::Focus {
            if let MouseEventKind::Down(MouseButton::Left) = m.kind {
                for h in self.handles.clone() {
                    let on = match h.dir {
                        Dir::H => x >= h.line.saturating_sub(0) && x <= h.line + self.theme.gaps.max(1) - 1 + 0 && y >= h.area.y && y < h.area.y + h.area.height,
                        Dir::V => y >= h.line && y <= h.line + self.theme.gaps.max(1) - 1 && x >= h.area.x && x < h.area.x + h.area.width,
                    };
                    if on && self.theme.gaps > 0 {
                        self.drag = Some(Drag::Split { handle: h });
                        return;
                    }
                }
                // With no gaps, grab a shared border edge.
                if self.theme.gaps == 0 {
                    for h in self.handles.clone() {
                        let on = match h.dir {
                            Dir::H => (x == h.line || x + 1 == h.line) && y > h.area.y && y + 1 < h.area.y + h.area.height,
                            Dir::V => (y == h.line || y + 1 == h.line) && x > h.area.x && x + 1 < h.area.x + h.area.width,
                        };
                        if on {
                            self.drag = Some(Drag::Split { handle: h });
                            return;
                        }
                    }
                }
            }
        }
        let hit = self.hit_at(x, y);
        match (m.kind, hit) {
            (MouseEventKind::Down(MouseButton::Left), Some(h)) => self.click(h, m),
            (MouseEventKind::ScrollUp | MouseEventKind::ScrollDown, Some(Hit::Leaf(leaf))) => self.wheel(leaf, m),
            (MouseEventKind::ScrollDown, _) => match self.view {
                View::Projects => self.sel_project = (self.sel_project + 1).min(self.project_rows.len().saturating_sub(1)),
                View::Dash => self.sel_card = (self.sel_card + self.dash_cols.max(1)).min(self.cards.len().saturating_sub(1)),
                View::Stats => self.stats_scroll += 2,
                View::Skills => self.skills_sel = (self.skills_sel + 1).min(self.skills.len().saturating_sub(1)),
                _ => {}
            },
            (MouseEventKind::ScrollUp, _) => match self.view {
                View::Projects => self.sel_project = self.sel_project.saturating_sub(1),
                View::Dash => self.sel_card = self.sel_card.saturating_sub(self.dash_cols.max(1)),
                View::Stats => self.stats_scroll = self.stats_scroll.saturating_sub(2),
                View::Skills => self.skills_sel = self.skills_sel.saturating_sub(1),
                _ => {}
            },
            (MouseEventKind::Up(_) | MouseEventKind::Drag(_) | MouseEventKind::Moved, Some(Hit::Leaf(leaf))) => {
                self.forward_mouse(leaf, m);
            }
            _ => {}
        }
    }

    fn click(&mut self, h: Hit, m: MouseEvent) {
        match h {
            Hit::Tab(v) => {
                if v == View::Focus && self.active_ws.is_none() {
                    return;
                }
                self.switch_view(v)
            }
            Hit::Project(i) => {
                if self.sel_project == i {
                    if let Some(root) = self.selected_project_root() {
                        self.open_project(root);
                    }
                } else {
                    self.sel_project = i;
                }
            }
            Hit::Card(i) => {
                if self.sel_card == i {
                    self.open_card(i);
                } else {
                    self.sel_card = i;
                }
            }
            Hit::LeafTitle(leaf) => {
                if let Some(ws) = self.active_mut() {
                    ws.focus = Some(leaf);
                }
                self.drag = Some(Drag::Move { from: leaf });
            }
            Hit::Leaf(leaf) => {
                if let Some(ws) = self.active_mut() {
                    ws.focus = Some(leaf);
                }
                self.forward_mouse(leaf, m);
            }
            Hit::Attention(i) => self.jump_attention(i),
            Hit::Sleep => self.toggle_sleep(),
            Hit::Approval(i, d) => self.answer_approval(i, match d {
                Decision::Once => 'y',
                Decision::Always => 'Y',
                Decision::Deny => 'N',
            }),
            Hit::Row(i) => match self.view {
                View::Skills => self.skills_sel = i,
                View::Secrets => self.secrets_sel = i,
                _ => {}
            },
            Hit::Palette(_) => {}
            Hit::TreeRow(leaf, i) => {
                if let Some(ws) = self.active_mut() {
                    ws.focus = Some(leaf);
                }
                let st = self.trees.entry(leaf).or_default();
                if st.sel == i {
                    self.files_key(leaf, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
                } else {
                    st.sel = i;
                }
            }
        }
    }

    fn leaf_inner(&self, leaf: u64) -> Option<Rect> {
        let r = self.leaf_rects.iter().find(|(i, _)| *i == leaf)?.1;
        Some(if self.theme.border.is_some() {
            Rect { x: r.x + 1, y: r.y + 1, width: r.width.saturating_sub(2), height: r.height.saturating_sub(2) }
        } else {
            Rect { y: r.y + 1, height: r.height.saturating_sub(1), ..r }
        })
    }

    fn forward_mouse(&mut self, leaf: u64, m: MouseEvent) {
        let Some(LeafKind::Term(p)) = self.active().and_then(|w| w.layout.kind_of(leaf)) else { return };
        let Some(inner) = self.leaf_inner(leaf) else { return };
        if m.column < inner.x || m.row < inner.y || m.column >= inner.x + inner.width || m.row >= inner.y + inner.height {
            return;
        }
        let Some(pane) = self.panes.get_mut(&p) else { return };
        let (mode, enc) = pane.mouse_mode();
        if let Some(bytes) = keys::encode_mouse(&m, m.column - inner.x, m.row - inner.y, mode, enc) {
            pane.write(&bytes);
        }
    }

    fn wheel(&mut self, leaf: u64, m: MouseEvent) {
        let up = matches!(m.kind, MouseEventKind::ScrollUp);
        match self.active().and_then(|w| w.layout.kind_of(leaf)) {
            Some(LeafKind::Term(p)) => {
                let inner = self.leaf_inner(leaf);
                let Some(pane) = self.panes.get_mut(&p) else { return };
                let (mode, enc) = pane.mouse_mode();
                if mode != vt100::MouseProtocolMode::None {
                    if let Some(inner) = inner {
                        if let Some(b) = keys::encode_mouse(&m, m.column.saturating_sub(inner.x), m.row.saturating_sub(inner.y), mode, enc) {
                            pane.write(&b);
                        }
                    }
                } else if pane.alternate() {
                    let seq: &[u8] = if up { b"\x1b[A" } else { b"\x1b[B" };
                    for _ in 0..3 {
                        pane.write(seq);
                    }
                } else {
                    pane.scroll_by(if up { 3 } else { -3 });
                }
            }
            Some(LeafKind::Comp(c)) => {
                let bottom_anchored = c == Comp::Activity;
                let s = self.leaf_scroll.entry(leaf).or_default();
                *s = if up == bottom_anchored { s.saturating_add(2) } else { s.saturating_sub(2) };
            }
            None => {}
        }
    }

    /// Project files for the tree, listed in the background and cached.
    pub fn project_files(&self, root: &str) -> Vec<String> {
        let mut map = self.file_lists.lock().unwrap();
        let stale = map.get(root).map(|(t, _)| t.elapsed() > Duration::from_secs(15)).unwrap_or(true);
        if stale {
            let entry = map.entry(root.to_string()).or_insert_with(|| (Instant::now(), Vec::new()));
            entry.0 = Instant::now();
            let r = root.to_string();
            let slot = self.file_lists.clone();
            std::thread::spawn(move || {
                let files = crate::tree::list_files(&r);
                if let Ok(mut m) = slot.lock() {
                    m.insert(r, (Instant::now(), files));
                }
            });
        }
        map.get(root).map(|(_, v)| v.clone()).unwrap_or_default()
    }

    /// The tree rows for a files panel, plus the project root they are under.
    pub fn tree_rows(&mut self, leaf: u64, run: Option<&AgentRun>) -> (Vec<crate::tree::Row>, String) {
        let root = match run {
            Some(r) if !r.cwd.is_empty() => store::work_root(Path::new(&r.cwd)).unwrap_or(r.cwd.clone()),
            _ => self.active().map(|w| w.worktree.as_ref().map(|t| t.path.clone()).unwrap_or_else(|| w.project.clone())).unwrap_or_default(),
        };
        let files = self.project_files(&root);
        let mut marks: HashMap<String, crate::tree::Mark> = HashMap::new();
        if let Some(run) = run {
            for f in run.files.values() {
                let Some(rel) = f.path.strip_prefix(&root).map(|p| p.trim_start_matches('/').to_string()) else { continue };
                if rel.is_empty() {
                    continue;
                }
                marks.insert(rel, crate::tree::Mark { added: f.added, removed: f.removed, changed: f.edits + f.writes > 0, read: f.reads > 0 });
            }
        }
        // Without an agent there is nothing "touched": start on every file.
        let st = self.trees.entry(leaf).or_insert_with(|| crate::tree::TreeState { all: run.is_none(), ..Default::default() });
        let rows = crate::tree::rows(&files, &marks, st);
        if st.sel >= rows.len() {
            st.sel = rows.len().saturating_sub(1);
        }
        (rows, root)
    }

    /// Keys for a focused files panel. Returns false for keys it ignores.
    fn files_key(&mut self, leaf: u64, k: KeyEvent) -> bool {
        let run = {
            let key = self.active().and_then(|w| self.ws_run(w));
            key.and_then(|k| self.shared.lock().unwrap().runs.get(&k).cloned())
        };
        let (rows, root) = self.tree_rows(leaf, run.as_deref());
        let st = self.trees.entry(leaf).or_default();
        let n = rows.len();
        let cur = rows.get(st.sel).cloned();
        match k.code {
            KeyCode::Char('j') | KeyCode::Down => st.sel = (st.sel + 1).min(n.saturating_sub(1)),
            KeyCode::Char('k') | KeyCode::Up => st.sel = st.sel.saturating_sub(1),
            KeyCode::Char('g') | KeyCode::Home => st.sel = 0,
            KeyCode::Char('G') | KeyCode::End => st.sel = n.saturating_sub(1),
            KeyCode::Char('a') => {
                st.all = !st.all;
                st.sel = 0;
                let msg = if st.all { "showing every file in the project" } else { "showing only files the agent touched" };
                self.say(msg, Tone::Info);
            }
            KeyCode::Enter | KeyCode::Char('l') | KeyCode::Right | KeyCode::Char('o') => match cur {
                Some(r) if r.dir => {
                    st.open.insert(r.rel, !r.open);
                }
                Some(r) => {
                    let path = Path::new(&root).join(&r.rel);
                    self.open_in_editor(&path);
                }
                None => {}
            },
            KeyCode::Char('h') | KeyCode::Left => match cur {
                Some(r) if r.dir && r.open => {
                    st.open.insert(r.rel, false);
                }
                Some(r) => {
                    // jump to the parent folder
                    let parent = r.rel.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default();
                    if let Some(i) = rows.iter().position(|x| x.dir && (x.rel == parent || parent.ends_with(&x.rel) && parent.starts_with(&x.rel))) {
                        st.sel = i;
                    }
                }
                None => {}
            },
            _ => return false,
        }
        true
    }

    /// Opens a file in $EDITOR in a terminal split beside the focused pane.
    pub fn open_in_editor(&mut self, path: &Path) {
        self.open_in_editor_at(path, 0)
    }

    /// Same, at a line (`+N`, which vi, nvim, emacs, nano, helix and kak take).
    pub fn open_in_editor_at(&mut self, path: &Path, line: u32) {
        let editor = std::env::var("VISUAL").or_else(|_| std::env::var("EDITOR")).unwrap_or_else(|_| "nvim".into());
        let at = if line > 0 { format!(" +{line}") } else { String::new() };
        let cwd = path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let cwd = self.active().map(|w| w.project.clone()).filter(|p| !p.is_empty()).unwrap_or(cwd);
        let Some(p) = self.spawn_pane(PaneKind::Shell, &cwd, &Launch::default()) else { return };
        if let Some(pane) = self.panes.get_mut(&p) {
            pane.write(format!("{editor}{at} {}\r", shell_words::quote(&path.to_string_lossy())).as_bytes());
        }
        // Open beside the biggest terminal, not inside a narrow side panel.
        let rects = self.leaf_rects.clone();
        if let Some(ws) = self.active_mut() {
            let biggest = rects
                .iter()
                .filter(|(id, _)| matches!(ws.layout.kind_of(*id), Some(LeafKind::Term(_))))
                .max_by_key(|(_, r)| r.width as u32 * r.height as u32)
                .map(|(id, r)| (*id, *r));
            match biggest {
                Some((leaf, r)) => {
                    let dir = if r.width as f32 > r.height as f32 * 2.2 { Dir::H } else { Dir::V };
                    let new = ws.layout.split(Some(leaf), LeafKind::Term(p), dir, 0.5);
                    ws.focus = Some(new);
                    ws.layout_dirty = true;
                }
                None => self.split_focused(LeafKind::Term(p)),
            }
        }
    }

    /// The repo's changes as files and hunks, refreshed in the background.
    pub fn hunk_files(&self, root: &str) -> Arc<Vec<crate::hunks::FileDiff>> {
        let mut map = self.hunk_cache.lock().unwrap();
        let stale = map.get(root).map(|(t, _)| t.elapsed() > Duration::from_secs(3)).unwrap_or(true);
        if stale {
            let first = !map.contains_key(root);
            let entry = map.entry(root.to_string()).or_insert_with(|| (Instant::now(), Arc::new(Vec::new())));
            entry.0 = Instant::now();
            if first {
                // First look: load now so the panel never opens blank.
                entry.1 = Arc::new(crate::hunks::load(root));
            } else {
                let r = root.to_string();
                let slot = self.hunk_cache.clone();
                std::thread::spawn(move || {
                    let files = Arc::new(crate::hunks::load(&r));
                    if let Ok(mut m) = slot.lock() {
                        m.insert(r, (Instant::now(), files));
                    }
                });
            }
        }
        map.get(root).map(|(_, v)| v.clone()).unwrap_or_default()
    }

    fn reload_hunks(&self, root: &str) {
        let files = Arc::new(crate::hunks::load(root));
        self.hunk_cache.lock().unwrap().insert(root.to_string(), (Instant::now(), files));
    }

    /// What a diff panel shows: root, files, the rows, and the paths it is
    /// limited to (the session's changed files) unless `all` is on.
    pub fn diff_rows(&mut self, leaf: u64, run: Option<&AgentRun>) -> (String, Arc<Vec<crate::hunks::FileDiff>>, Vec<crate::hunks::Item>, Option<Vec<String>>) {
        let root = match run {
            Some(r) if !r.cwd.is_empty() => store::work_root(Path::new(&r.cwd)).unwrap_or(r.cwd.clone()),
            _ => self.active().map(|w| w.worktree.as_ref().map(|t| t.path.clone()).unwrap_or_else(|| w.project.clone())).unwrap_or_default(),
        };
        let files = self.hunk_files(&root);
        let mine: Vec<String> = run
            .map(|r| r.files.values().filter(|f| f.edits + f.writes > 0).filter_map(|f| f.path.strip_prefix(&root).map(|p| p.trim_start_matches('/').to_string())).collect())
            .unwrap_or_default();
        let view = self.diff_views.entry(leaf).or_default();
        let only = if view.all || mine.is_empty() || !files.iter().any(|f| mine.contains(&f.path)) { None } else { Some(mine) };
        let items = crate::hunks::items(&files, only.as_deref());
        let hunks = items.iter().filter(|i| matches!(i, crate::hunks::Item::Hunk(..))).count();
        if view.sel >= hunks {
            view.sel = hunks.saturating_sub(1);
        }
        (root, files, items, only)
    }

    fn selected_hunk(&mut self, leaf: u64) -> Option<(String, crate::hunks::FileDiff, crate::hunks::Hunk)> {
        let run = self.active().and_then(|w| self.ws_run(w)).and_then(|k| self.shared.lock().unwrap().runs.get(&k).cloned());
        let (root, files, items, _) = self.diff_rows(leaf, run.as_deref());
        let sel = self.diff_views.get(&leaf).map(|v| v.sel).unwrap_or(0);
        let (fi, hi) = items.iter().filter_map(|i| if let crate::hunks::Item::Hunk(f, h) = i { Some((*f, *h)) } else { None }).nth(sel)?;
        let f = files.get(fi)?.clone();
        let h = f.hunks.get(hi)?.clone();
        Some((root, f, h))
    }

    /// Keys for a focused diff panel. Returns false for keys it ignores.
    fn diff_key(&mut self, leaf: u64, k: KeyEvent) -> bool {
        let run = self.active().and_then(|w| self.ws_run(w)).and_then(|k| self.shared.lock().unwrap().runs.get(&k).cloned());
        let (root, _, items, _) = self.diff_rows(leaf, run.as_deref());
        let n = items.iter().filter(|i| matches!(i, crate::hunks::Item::Hunk(..))).count();
        match k.code {
            KeyCode::Char('j') | KeyCode::Down => {
                let v = self.diff_views.entry(leaf).or_default();
                v.sel = (v.sel + 1).min(n.saturating_sub(1));
            }
            KeyCode::Char('k') | KeyCode::Up => {
                let v = self.diff_views.entry(leaf).or_default();
                v.sel = v.sel.saturating_sub(1);
            }
            KeyCode::Char('g') | KeyCode::Home => self.diff_views.entry(leaf).or_default().sel = 0,
            KeyCode::Char('G') | KeyCode::End => self.diff_views.entry(leaf).or_default().sel = n.saturating_sub(1),
            KeyCode::Char('a') => {
                let v = self.diff_views.entry(leaf).or_default();
                v.all = !v.all;
                v.sel = 0;
                let msg = if v.all { "showing every uncommitted change" } else { "showing only this session's files" };
                self.say(msg, Tone::Info);
            }
            KeyCode::Char('r') => {
                self.reload_hunks(&root);
            }
            KeyCode::Char(' ') => {
                if let Some((root, f, h)) = self.selected_hunk(leaf) {
                    match crate::hunks::toggle_stage(&root, &f, &h) {
                        Ok(m) => self.say(m, Tone::Ok),
                        Err(e) => self.say(format!("git apply: {e}"), Tone::Err),
                    }
                    self.reload_hunks(&root);
                }
            }
            KeyCode::Char('d') => {
                if let Some((_, f, h)) = self.selected_hunk(leaf) {
                    let sel = self.diff_views.get(&leaf).map(|v| v.sel).unwrap_or(0);
                    let what = if f.untracked { format!("delete the new file {}?", f.path) } else { format!("throw away this hunk in {} (+{} −{})?", f.path, h.added, h.removed) };
                    self.overlay = Some(Overlay::Confirm { msg: vec![what, "the change is gone from the working tree; git cannot bring it back.".into()], action: Action::RevertHunk(leaf, sel) });
                }
            }
            KeyCode::Enter | KeyCode::Char('o') | KeyCode::Char('e') => {
                if let Some((root, f, h)) = self.selected_hunk(leaf) {
                    let line = h.lines.iter().position(|l| l.starts_with('+') || l.starts_with('-')).map(|i| h.new_start + i as u32).unwrap_or(h.new_start);
                    self.open_in_editor_at(&Path::new(&root).join(&f.path), line);
                }
            }
            _ => return false,
        }
        true
    }

    fn revert_hunk(&mut self, leaf: u64, sel: usize) {
        if let Some(v) = self.diff_views.get_mut(&leaf) {
            v.sel = sel;
        }
        if let Some((root, f, h)) = self.selected_hunk(leaf) {
            match crate::hunks::revert(&root, &f, &h) {
                Ok(m) => self.say(m, Tone::Ok),
                Err(e) => self.say(format!("git apply: {e}"), Tone::Err),
            }
            self.reload_hunks(&root);
        }
    }
}

/// Where a typed project folder lives: `~` expands, and a relative path
/// like `Dev/new-thing` is taken from home, not from wherever polypore
/// happened to start.
pub fn project_path(typed: &str) -> PathBuf {
    let typed = typed.trim_end_matches('/');
    if typed.is_empty() {
        return PathBuf::new();
    }
    let p = config::expand(typed);
    if p.is_absolute() {
        return p;
    }
    dirs::home_dir().map(|h| h.join(&p)).unwrap_or(p)
}

fn group_of(s: RunState) -> u8 {
    match s {
        RunState::NeedsInput => 0,
        RunState::Working => 1,
        RunState::Ready => 2,
        RunState::Closed => 4,
    }
}

/// The command line that starts an agent the way `launch` says.
pub fn agent_command(cfg: &Config, kind: PaneKind, launch: &Launch) -> Option<String> {
    let q = |p: &String| format!(" {}", shell_words::quote(p));
    let prompt = launch.prompt.as_ref().map(q).unwrap_or_default();
    let launch = &Launch { resume: launch.resume.as_ref().map(|k| RunKey { kind: k.kind, id: shell_words::quote(&k.id).to_string() }), ..launch.clone() };
    let extra = if launch.args.trim().is_empty() { String::new() } else { format!(" {}", launch.args.trim()) };
    match kind {
        PaneKind::Claude => {
            let base = format!("{}{extra}", cfg.agent("claude").command);
            Some(match &launch.resume {
                Some(k) if launch.attach => format!("{} attach {}", cfg.agent("claude").command, job_short(&k.id)),
                Some(k) if launch.fork => format!("{base} --resume {} --fork-session{prompt}", k.id),
                Some(k) => format!("{base} --resume {}{prompt}", k.id),
                None => format!("{base}{prompt}"),
            })
        }
        PaneKind::Codex => {
            // codex takes its flags before the subcommand too.
            let base = cfg.agent("codex").command;
            Some(match &launch.resume {
                Some(k) if launch.fork => format!("{base} fork {}{extra}{prompt}", k.id),
                Some(k) => format!("{base} resume {}{extra}{prompt}", k.id),
                None => format!("{base}{extra}{prompt}"),
            })
        }
        PaneKind::Shell => None,
    }
}

/// The id claude's background jobs go by (`claude agents`, `attach`,
/// `stop`): the session id's first eight characters.
pub fn job_short(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

fn preset_launch(p: Option<&crate::config::Preset>) -> Launch {
    match p {
        Some(p) => Launch { args: p.args.clone(), prompt: Some(p.prompt.clone()).filter(|s| !s.trim().is_empty()), ..Default::default() },
        None => Launch::default(),
    }
}

/// Copies to the clipboard of the terminal polypore runs in (OSC 52, so it
/// works over ssh and in tmux with set-clipboard on).
fn copy_text(text: &str) {
    use base64::Engine;
    copy_to_outer_clipboard(base64::engine::general_purpose::STANDARD.encode(text.as_bytes()).as_bytes());
}

/// `:` commands: name, what it takes, what it does.
pub const COMMANDS: &[(&str, &str, &str)] = &[
    ("open", "", "open the selected session"),
    ("resume", "", "resume it in a terminal"),
    ("prompt", "text", "type a prompt into it (queued if working)"),
    ("new", "claude|codex|terminal", "start a session"),
    ("preset", "name", "start a launch preset"),
    ("worktree", "claude|codex branch", "a session on its own branch"),
    ("fork", "", "a new session with the same history"),
    ("handoff", "", "a fresh session from a written handoff"),
    ("failover", "", "continue it in the other agent"),
    ("review", "", "a fresh reviewer on its diff"),
    ("diff", "", "its changes as hunks"),
    ("rename", "name", "rename it (empty: the agent's title)"),
    ("archive", "", "archive or unarchive it"),
    ("close", "", "close it"),
    ("yank", "resume|id|folder|title|reply|files|plan", "copy something about it"),
    ("filter", "all|needs-you|working|ready|closed|archived", "what the list shows"),
    ("search", "text", "search every transcript"),
    ("next", "", "the next session waiting for you"),
    ("project", "name", "open a project"),
    ("theme", "name", "switch the theme"),
    ("awake", "", "stay awake on or off"),
    ("layout", "save|default|reset", "this layout for the project's new sessions, for every project's, or back to the default"),
    ("projects", "", "the project list"),
    ("dash", "", "this project's sessions"),
    ("skills", "", "the skills screen"),
    ("secrets", "", "the secrets screen"),
    ("stats", "", "the stats screen"),
    ("help", "", "all keys"),
    ("quit", "", "quit"),
];

pub fn card_id(c: &Card) -> CardId {
    match (&c.kind, &c.run) {
        (CardKind::Hosted(id), _) => CardId::Ws(*id),
        (_, Some(k)) => CardId::Run(k.clone()),
        (CardKind::Observed(k) | CardKind::Recent(k), None) => CardId::Run(k.clone()),
    }
}

fn kind_label(k: PaneKind) -> &'static str {
    match k {
        PaneKind::Claude => "claude",
        PaneKind::Codex => "codex",
        PaneKind::Shell => "terminal",
    }
}

fn card_ws(c: &Card) -> Option<u64> {
    if let CardKind::Hosted(id) = c.kind { Some(id) } else { None }
}

fn dir_of(c: char) -> Move {
    match c {
        'h' => Move::Left,
        'l' => Move::Right,
        'k' => Move::Up,
        _ => Move::Down,
    }
}

fn awake_path() -> PathBuf {
    config::state_dir().join("awake")
}

fn save_awake(on: bool) {
    if on {
        let _ = std::fs::write(awake_path(), "on\n");
    } else {
        let _ = std::fs::remove_file(awake_path());
    }
}

fn load_awake() -> bool {
    awake_path().exists()
}

/// Server panes that no saved workspace knows about (started by
/// `polypore send`, or left by a dashboard that crashed before saving) each
/// get a workspace of their own.
fn adopt_orphans(conn: &crate::server::Conn, saved: &mut Vec<SavedWorkspace>) {
    let Ok(list) = conn.list() else { return };
    let known: HashSet<u64> = saved.iter().flat_map(|s| s.terms.iter().filter_map(|t| t.server)).collect();
    for p in list.into_iter().filter(|p| p.exited.is_none() && !known.contains(&p.id)) {
        let project = if p.meta.project.is_empty() { store::git_root(Path::new(&p.cwd)).unwrap_or(p.cwd.clone()) } else { p.meta.project.clone() };
        let agent = p.kind != PaneKind::Shell;
        let term = NodeSpec::Term { slot: 0, role: "agent".into() };
        let layout = if agent {
            NodeSpec::Split {
                dir: Dir::H,
                ratio: 0.63,
                a: Box::new(term),
                b: Box::new(NodeSpec::Split { dir: Dir::V, ratio: 0.55, a: Box::new(NodeSpec::Comp { comp: Comp::Inspector }), b: Box::new(NodeSpec::Comp { comp: Comp::Files }) }),
            }
        } else {
            term
        };
        let name = if p.meta.name.is_empty() { p.kind_label().to_string() } else { p.meta.name.clone() };
        saved.push(SavedWorkspace {
            project,
            name,
            layout,
            terms: vec![SavedTerm { kind: Some(p.kind), cwd: p.cwd.clone(), run: p.meta.run.as_ref().map(|r| r.id.clone()), server: Some(p.id) }],
            worktree: None,
        });
    }
}

fn plural_s(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn load_saved() -> Vec<SavedWorkspace> {
    std::fs::read_to_string(config::state_dir().join("workspaces.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn latest_report() -> Option<(PathBuf, String)> {
    let dir = config::state_dir().join("analysis");
    let mut v: Vec<PathBuf> = std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with("report-")).unwrap_or(false))
        .collect();
    v.sort();
    let p = v.pop()?;
    let body = std::fs::read_to_string(&p).ok()?;
    Some((p, body))
}

fn copy_to_outer_clipboard(data: &[u8]) {
    use std::io::Write;
    // vt100 hands over the payload still base64-encoded.
    let _ = write!(std::io::stdout(), "\x1b]52;c;{}\x07", String::from_utf8_lossy(data));
    let _ = std::io::stdout().flush();
}

#[derive(Clone, Copy, Debug)]
pub enum Act {
    View(View),
    Back,
    New(PaneKind),
    ClosePane,
    CloseWorkspace,
    Focus(Move),
    Swap(Move),
    Resize(Dir, f32),
    Zoom,
    Flip,
    AddPanel,
    Sleep,
    Theme,
    Attention,
    Approve(char),
    CycleWs(i32),
    Help,
    Command,
    Quit,
    Resume,
}

fn mv_of(c: char) -> Move {
    dir_of(c.to_ascii_lowercase())
}

/// alt+key bindings. Left free on purpose: alt+b/f/d/./u/t (readline,
/// shells), alt+p and alt+t (claude: model picker, thinking).
pub fn alt_act(k: &KeyEvent) -> Option<Act> {
    let shift = k.modifiers.contains(KeyModifiers::SHIFT);
    Some(match k.code {
        KeyCode::Left | KeyCode::Right | KeyCode::Up | KeyCode::Down => {
            let (c, dir, d) = match k.code {
                KeyCode::Left => ('h', Dir::H, -0.05),
                KeyCode::Right => ('l', Dir::H, 0.05),
                KeyCode::Up => ('k', Dir::V, -0.05),
                _ => ('j', Dir::V, 0.05),
            };
            if shift { Act::Resize(dir, d) } else { Act::Focus(mv_of(c)) }
        }
        KeyCode::PageUp => Act::CycleWs(-1),
        KeyCode::PageDown => Act::CycleWs(1),
        KeyCode::Char(c) => match c {
            'h' | 'j' | 'k' | 'l' => Act::Focus(mv_of(c)),
            'H' | 'J' | 'K' | 'L' => Act::Swap(mv_of(c)),
            'q' => Act::Back,
            'n' => Act::New(PaneKind::Shell),
            'c' => Act::New(PaneKind::Claude),
            'x' => Act::New(PaneKind::Codex),
            'a' => Act::AddPanel,
            'w' => Act::ClosePane,
            'W' => Act::CloseWorkspace,
            'z' => Act::Zoom,
            'o' => Act::Flip,
            's' => Act::Sleep,
            'g' => Act::Attention,
            'y' => Act::Approve('y'),
            'Y' => Act::Approve('Y'),
            'N' => Act::Approve('N'),
            '?' | '/' => Act::Help,
            ':' | ';' => Act::Command,
            '[' => Act::CycleWs(-1),
            ']' => Act::CycleWs(1),
            '1'..='6' => Act::View(View::ALL[(c as u8 - b'1') as usize]),
            _ => return None,
        },
        _ => return None,
    })
}

/// Prefix-mode bindings (`[keys] mode = "prefix"`): prefix, then a key.
pub fn prefix_act(k: &KeyEvent) -> Option<Act> {
    let shift_arrow = k.modifiers.contains(KeyModifiers::SHIFT);
    Some(match k.code {
        KeyCode::Left | KeyCode::Right | KeyCode::Up | KeyCode::Down => {
            let c = match k.code {
                KeyCode::Left => 'h',
                KeyCode::Right => 'l',
                KeyCode::Up => 'k',
                _ => 'j',
            };
            if shift_arrow { Act::Swap(mv_of(c)) } else { Act::Focus(mv_of(c)) }
        }
        KeyCode::Char(c) => match c {
            'd' => Act::View(View::Dash),
            'p' => Act::View(View::Projects),
            'f' => Act::View(View::Focus),
            'n' => Act::New(PaneKind::Shell),
            'c' => Act::New(PaneKind::Claude),
            'x' => Act::New(PaneKind::Codex),
            'w' => Act::ClosePane,
            'W' => Act::CloseWorkspace,
            'h' | 'j' | 'k' | 'l' => Act::Focus(mv_of(c)),
            'H' | 'J' | 'K' | 'L' => Act::Swap(mv_of(c)),
            '<' => Act::Resize(Dir::H, -0.05),
            '>' => Act::Resize(Dir::H, 0.05),
            '-' | '_' => Act::Resize(Dir::V, -0.05),
            '+' | '=' => Act::Resize(Dir::V, 0.05),
            'z' => Act::Zoom,
            'o' => Act::Flip,
            'a' => Act::AddPanel,
            's' => Act::Sleep,
            't' => Act::Theme,
            'g' => Act::Attention,
            'y' | 'Y' | 'N' => Act::Approve(c),
            '[' => Act::CycleWs(-1),
            ']' => Act::CycleWs(1),
            '1'..='6' => Act::View(View::ALL[(c as u8 - b'1') as usize]),
            '?' => Act::Help,
            ':' => Act::Command,
            'q' => Act::Quit,
            'r' => Act::Resume,
            _ => return None,
        },
        _ => return None,
    })
}
