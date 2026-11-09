//! Binary tiling tree (Hyprland dwindle style). Leaves are terminals or
//! components; both tile, move and resize the same way.

use ratatui::layout::Rect;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Comp {
    /// The adaptive inspector (saved as "overview" in older layouts).
    #[serde(alias = "overview")]
    Inspector,
    Tasks,
    Files,
    Web,
    Commands,
    Subagents,
    Activity,
    Usage,
    Errors,
    Diff,
    Review,
}

impl Comp {
    pub const ALL: [Comp; 11] = [
        Comp::Inspector,
        Comp::Tasks,
        Comp::Files,
        Comp::Activity,
        Comp::Web,
        Comp::Commands,
        Comp::Subagents,
        Comp::Usage,
        Comp::Errors,
        Comp::Diff,
        Comp::Review,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Comp::Inspector => "inspector",
            Comp::Tasks => "tasks",
            Comp::Files => "files",
            Comp::Web => "web",
            Comp::Commands => "commands",
            Comp::Subagents => "subagents",
            Comp::Activity => "activity",
            Comp::Usage => "usage",
            Comp::Errors => "errors",
            Comp::Diff => "diff",
            Comp::Review => "review",
        }
    }

    pub fn blurb(self) -> &'static str {
        match self {
            Comp::Inspector => "everything that matters, only when it has content",
            Comp::Tasks => "the agent's todo list as it checks items off",
            Comp::Files => "the project as a tree; what the agent touched is marked; enter opens a file",
            Comp::Web => "searches and pages fetched, by domain",
            Comp::Commands => "shell commands with exit status and duration",
            Comp::Subagents => "spawned subagents and their state",
            Comp::Activity => "turn-by-turn timeline: prompts, tools, replies",
            Comp::Usage => "context window, tokens, cost, rate limits",
            Comp::Errors => "failed tools, non-zero exits, api errors",
            Comp::Diff => "changes as hunks to stage, revert or edit",
            Comp::Review => "a fresh reviewer's findings on the diff",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Dir {
    #[serde(rename = "h")]
    H,
    #[serde(rename = "v")]
    V,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LeafKind {
    Term(u64),
    Comp(Comp),
}

#[derive(Clone, Debug)]
pub enum Node {
    Leaf { id: u64, kind: LeafKind },
    Split { dir: Dir, ratio: f32, a: Box<Node>, b: Box<Node> },
}

#[derive(Clone, Debug)]
pub struct Handle {
    pub path: Vec<bool>,
    pub dir: Dir,
    pub area: Rect,
    pub line: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Move {
    Left,
    Right,
    Up,
    Down,
}

#[derive(Clone, Debug)]
pub struct Layout {
    pub root: Option<Node>,
    next: u64,
}

impl Layout {
    pub fn empty() -> Layout {
        Layout { root: None, next: 1 }
    }

    fn fresh(&mut self) -> u64 {
        let id = self.next;
        self.next += 1;
        id
    }

    pub fn leaf(&mut self, kind: LeafKind) -> Node {
        Node::Leaf { id: self.fresh(), kind }
    }

    pub fn leaves(&self) -> Vec<(u64, LeafKind)> {
        let mut out = Vec::new();
        fn walk(n: &Node, out: &mut Vec<(u64, LeafKind)>) {
            match n {
                Node::Leaf { id, kind } => out.push((*id, kind.clone())),
                Node::Split { a, b, .. } => {
                    walk(a, out);
                    walk(b, out);
                }
            }
        }
        if let Some(r) = &self.root {
            walk(r, &mut out);
        }
        out
    }

    pub fn kind_of(&self, id: u64) -> Option<LeafKind> {
        self.leaves().into_iter().find(|(i, _)| *i == id).map(|(_, k)| k)
    }

    pub fn leaf_for_term(&self, pane: u64) -> Option<u64> {
        self.leaves().into_iter().find(|(_, k)| *k == LeafKind::Term(pane)).map(|(i, _)| i)
    }

    pub fn terms(&self) -> Vec<u64> {
        self.leaves()
            .into_iter()
            .filter_map(|(_, k)| if let LeafKind::Term(p) = k { Some(p) } else { None })
            .collect()
    }

    fn path_of(&self, id: u64) -> Option<Vec<bool>> {
        fn walk(n: &Node, id: u64, path: &mut Vec<bool>) -> bool {
            match n {
                Node::Leaf { id: i, .. } => *i == id,
                Node::Split { a, b, .. } => {
                    path.push(false);
                    if walk(a, id, path) {
                        return true;
                    }
                    path.pop();
                    path.push(true);
                    if walk(b, id, path) {
                        return true;
                    }
                    path.pop();
                    false
                }
            }
        }
        let mut p = Vec::new();
        let r = self.root.as_ref()?;
        if walk(r, id, &mut p) { Some(p) } else { None }
    }

    fn at_mut(&mut self, path: &[bool]) -> Option<&mut Node> {
        let mut n = self.root.as_mut()?;
        for &side in path {
            match n {
                Node::Split { a, b, .. } => n = if side { b } else { a },
                Node::Leaf { .. } => return None,
            }
        }
        Some(n)
    }

    /// Splits `target` (or the root when empty) and places a new leaf after it.
    pub fn split(&mut self, target: Option<u64>, kind: LeafKind, dir: Dir, ratio: f32) -> u64 {
        let new = self.leaf(kind);
        let Node::Leaf { id: new_id, .. } = new else { unreachable!() };
        let Some(t) = target.and_then(|t| self.path_of(t)) else {
            match self.root.take() {
                None => self.root = Some(new),
                Some(old) => {
                    self.root = Some(Node::Split { dir, ratio, a: Box::new(old), b: Box::new(new) });
                }
            }
            return new_id;
        };
        if let Some(slot) = self.at_mut(&t) {
            let old = std::mem::replace(slot, Node::Leaf { id: 0, kind: LeafKind::Comp(Comp::Inspector) });
            *slot = Node::Split { dir, ratio, a: Box::new(old), b: Box::new(new) };
        }
        new_id
    }

    pub fn remove(&mut self, id: u64) {
        let Some(path) = self.path_of(id) else { return };
        if path.is_empty() {
            self.root = None;
            return;
        }
        let (parent, last) = path.split_at(path.len() - 1);
        let keep_b = !last[0];
        if let Some(slot) = self.at_mut(parent) {
            if let Node::Split { a, b, .. } = slot {
                let sibling = if keep_b { (**b).clone() } else { (**a).clone() };
                *slot = sibling;
            }
        }
    }

    pub fn swap(&mut self, x: u64, y: u64) {
        let (Some(kx), Some(ky)) = (self.kind_of(x), self.kind_of(y)) else { return };
        fn set(n: &mut Node, id: u64, kind: &LeafKind) {
            match n {
                Node::Leaf { id: i, kind: k } if *i == id => *k = kind.clone(),
                Node::Split { a, b, .. } => {
                    set(a, id, kind);
                    set(b, id, kind);
                }
                _ => {}
            }
        }
        if let Some(r) = self.root.as_mut() {
            set(r, x, &ky);
            set(r, y, &kx);
        }
    }

    pub fn replace(&mut self, id: u64, kind: LeafKind) {
        fn set(n: &mut Node, id: u64, kind: &LeafKind) {
            match n {
                Node::Leaf { id: i, kind: k } if *i == id => *k = kind.clone(),
                Node::Split { a, b, .. } => {
                    set(a, id, kind);
                    set(b, id, kind);
                }
                _ => {}
            }
        }
        if let Some(r) = self.root.as_mut() {
            set(r, id, &kind);
        }
    }

    /// Grows (delta > 0) or shrinks the leaf along `dir`.
    /// Moves the nearest divider of the focused pane that runs across
    /// `dir`: a positive delta moves it right (or down), like the arrow
    /// key pressed, whichever side of it the pane is on.
    pub fn resize(&mut self, id: u64, dir: Dir, delta: f32) {
        let Some(path) = self.path_of(id) else { return };
        for depth in (0..path.len()).rev() {
            if let Some(Node::Split { dir: d, ratio, .. }) = self.at_mut(&path[..depth]) {
                if *d == dir {
                    *ratio = (*ratio + delta).clamp(0.1, 0.9);
                    return;
                }
            }
        }
    }

    pub fn set_ratio(&mut self, path: &[bool], ratio: f32) {
        if let Some(Node::Split { ratio: r, .. }) = self.at_mut(path) {
            *r = ratio.clamp(0.08, 0.92);
        }
    }

    pub fn flip(&mut self, id: u64) {
        let Some(path) = self.path_of(id) else { return };
        if path.is_empty() {
            return;
        }
        if let Some(Node::Split { dir, .. }) = self.at_mut(&path[..path.len() - 1]) {
            *dir = if *dir == Dir::H { Dir::V } else { Dir::H };
        }
    }

    /// Computes leaf rectangles. Component leaves are dropped when
    /// `show_comps` is false, and their space goes to the sibling.
    pub fn compute(&self, area: Rect, gap: u16, show_comps: bool) -> (Vec<(u64, Rect)>, Vec<Handle>) {
        let mut rects = Vec::new();
        let mut handles = Vec::new();
        fn visible(n: &Node, show: bool) -> bool {
            match n {
                // The file tree and the diff are about the repo, so they show without an agent.
                Node::Leaf { kind: LeafKind::Comp(c), .. } => show || matches!(c, Comp::Files | Comp::Diff),
                Node::Leaf { .. } => true,
                Node::Split { a, b, .. } => visible(a, show) || visible(b, show),
            }
        }
        fn walk(
            n: &Node,
            area: Rect,
            gap: u16,
            show: bool,
            path: &mut Vec<bool>,
            rects: &mut Vec<(u64, Rect)>,
            handles: &mut Vec<Handle>,
        ) {
            match n {
                Node::Leaf { id, .. } => rects.push((*id, area)),
                Node::Split { dir, ratio, a, b } => {
                    let (va, vb) = (visible(a, show), visible(b, show));
                    if va && !vb {
                        path.push(false);
                        walk(a, area, gap, show, path, rects, handles);
                        path.pop();
                        return;
                    }
                    if vb && !va {
                        path.push(true);
                        walk(b, area, gap, show, path, rects, handles);
                        path.pop();
                        return;
                    }
                    if !va && !vb {
                        return;
                    }
                    let (ra, rb, line) = split_rect(area, *dir, *ratio, gap);
                    handles.push(Handle { path: path.clone(), dir: *dir, area, line });
                    path.push(false);
                    walk(a, ra, gap, show, path, rects, handles);
                    path.pop();
                    path.push(true);
                    walk(b, rb, gap, show, path, rects, handles);
                    path.pop();
                }
            }
        }
        if let Some(r) = &self.root {
            walk(r, area, gap, show_comps, &mut Vec::new(), &mut rects, &mut handles);
        }
        (rects, handles)
    }

    pub fn neighbor(rects: &[(u64, Rect)], from: u64, mv: Move) -> Option<u64> {
        let (_, f) = rects.iter().find(|(i, _)| *i == from)?;
        let fc = (f.x as i32 + f.width as i32 / 2, f.y as i32 + f.height as i32 / 2);
        let mut best: Option<(i64, u64)> = None;
        for (id, r) in rects {
            if *id == from {
                continue;
            }
            let ok = match mv {
                Move::Left => r.x + r.width <= f.x,
                Move::Right => r.x >= f.x + f.width,
                Move::Up => r.y + r.height <= f.y,
                Move::Down => r.y >= f.y + f.height,
            };
            if !ok {
                continue;
            }
            let overlap = match mv {
                Move::Left | Move::Right => overlap(r.y, r.height, f.y, f.height),
                Move::Up | Move::Down => overlap(r.x, r.width, f.x, f.width),
            };
            let rc = (r.x as i32 + r.width as i32 / 2, r.y as i32 + r.height as i32 / 2);
            let dist = ((rc.0 - fc.0).abs() + (rc.1 - fc.1).abs()) as i64;
            let score = dist - overlap as i64 * 4;
            if best.map(|b| score < b.0).unwrap_or(true) {
                best = Some((score, *id));
            }
        }
        best.map(|b| b.1)
    }

    pub fn to_spec(&self, term_slot: impl Fn(u64) -> Option<(usize, String)>) -> Option<NodeSpec> {
        fn walk(n: &Node, f: &dyn Fn(u64) -> Option<(usize, String)>) -> Option<NodeSpec> {
            match n {
                Node::Leaf { kind: LeafKind::Comp(c), .. } => Some(NodeSpec::Comp { comp: *c }),
                Node::Leaf { kind: LeafKind::Term(p), .. } => {
                    let (slot, role) = f(*p)?;
                    Some(NodeSpec::Term { slot, role })
                }
                Node::Split { dir, ratio, a, b } => match (walk(a, f), walk(b, f)) {
                    (Some(x), Some(y)) => Some(NodeSpec::Split {
                        dir: *dir,
                        ratio: (*ratio * 100.0).round() / 100.0,
                        a: Box::new(x),
                        b: Box::new(y),
                    }),
                    (Some(x), None) | (None, Some(x)) => Some(x),
                    _ => None,
                },
            }
        }
        self.root.as_ref().and_then(|r| walk(r, &term_slot))
    }

    /// Builds a layout from a spec. `term` maps a (slot, role) to a pane id,
    /// spawning as needed; returning None drops that leaf.
    pub fn from_spec(spec: &NodeSpec, term: &mut dyn FnMut(usize, &str) -> Option<u64>) -> Layout {
        let mut l = Layout::empty();
        fn build(l: &mut Layout, s: &NodeSpec, term: &mut dyn FnMut(usize, &str) -> Option<u64>) -> Option<Node> {
            match s {
                NodeSpec::Comp { comp } => Some(l.leaf(LeafKind::Comp(*comp))),
                NodeSpec::Term { slot, role } => term(*slot, role).map(|p| l.leaf(LeafKind::Term(p))),
                NodeSpec::Split { dir, ratio, a, b } => match (build(l, a, term), build(l, b, term)) {
                    (Some(x), Some(y)) => Some(Node::Split { dir: *dir, ratio: *ratio, a: Box::new(x), b: Box::new(y) }),
                    (Some(x), None) | (None, Some(x)) => Some(x),
                    _ => None,
                },
            }
        }
        let root = build(&mut l, spec, term);
        l.root = root;
        l
    }
}

fn overlap(a: u16, al: u16, b: u16, bl: u16) -> u16 {
    let s = a.max(b);
    let e = (a + al).min(b + bl);
    e.saturating_sub(s)
}

fn split_rect(area: Rect, dir: Dir, ratio: f32, gap: u16) -> (Rect, Rect, u16) {
    match dir {
        Dir::H => {
            let total = area.width.saturating_sub(gap);
            let wa = ((total as f32) * ratio).round() as u16;
            let wa = wa.clamp(1.min(total), total.saturating_sub(1).max(1));
            let a = Rect { width: wa, ..area };
            let b = Rect { x: area.x + wa + gap, width: total.saturating_sub(wa), ..area };
            (a, b, area.x + wa)
        }
        Dir::V => {
            let total = area.height.saturating_sub(gap);
            let ha = ((total as f32) * ratio).round() as u16;
            let ha = ha.clamp(1.min(total), total.saturating_sub(1).max(1));
            let a = Rect { height: ha, ..area };
            let b = Rect { y: area.y + ha + gap, height: total.saturating_sub(ha), ..area };
            (a, b, area.y + ha)
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum NodeSpec {
    Split { dir: Dir, ratio: f32, a: Box<NodeSpec>, b: Box<NodeSpec> },
    Term { slot: usize, #[serde(default)] role: String },
    Comp { comp: Comp },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LayoutFile {
    pub layout: NodeSpec,
}

/// Default focus layout: agent terminal over a shell split on the left, the
/// overview, files and activity stacked on the right.
/// The agent over a shell, and beside them the inspector, the activity
/// feed and the file tree.
pub fn default_spec() -> NodeSpec {
    use NodeSpec::*;
    Split {
        dir: Dir::H,
        ratio: 0.63,
        a: Box::new(agent_over_shell()),
        b: Box::new(Split {
            dir: Dir::V,
            ratio: 0.4,
            a: Box::new(Comp { comp: crate::layout::Comp::Inspector }),
            b: Box::new(Split {
                dir: Dir::V,
                ratio: 0.55,
                a: Box::new(Comp { comp: crate::layout::Comp::Activity }),
                b: Box::new(Comp { comp: crate::layout::Comp::Files }),
            }),
        }),
    }
}

fn agent_over_shell() -> NodeSpec {
    use NodeSpec::*;
    Split { dir: Dir::V, ratio: 0.75, a: Box::new(Term { slot: 0, role: "agent".into() }), b: Box::new(Term { slot: 1, role: "shell".into() }) }
}

/// The default polypore wrote before the activity feed was in it. A
/// default.toml still holding exactly this was never edited, so it moves
/// up to the current default.
fn old_default_spec() -> NodeSpec {
    use NodeSpec::*;
    Split {
        dir: Dir::H,
        ratio: 0.63,
        a: Box::new(agent_over_shell()),
        b: Box::new(Split { dir: Dir::V, ratio: 0.55, a: Box::new(Comp { comp: crate::layout::Comp::Inspector }), b: Box::new(Comp { comp: crate::layout::Comp::Files }) }),
    }
}

pub fn layouts_dir() -> std::path::PathBuf {
    crate::config::config_dir().join("layouts")
}

pub fn load_template(project_key: &str) -> NodeSpec {
    let dir = layouts_dir();
    if let Ok(text) = std::fs::read_to_string(dir.join(format!("{project_key}.toml"))) {
        if let Ok(f) = toml::from_str::<LayoutFile>(&text) {
            return f.layout;
        }
    }
    let path = dir.join("default.toml");
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(f) = toml::from_str::<LayoutFile>(&text) {
            if f.layout != old_default_spec() {
                return f.layout;
            }
        }
    }
    let spec = default_spec();
    let stale = std::fs::read_to_string(&path).ok().and_then(|t| toml::from_str::<LayoutFile>(&t).ok()).map(|f| f.layout == old_default_spec()).unwrap_or(false);
    if !path.exists() || stale {
        save_default(&spec);
    }
    spec
}

/// Writes the template every project's new sessions start from, unless the
/// project has a layout of its own.
pub fn save_default(spec: &NodeSpec) {
    let dir = layouts_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(body) = toml::to_string_pretty(&LayoutFile { layout: spec.clone() }) {
        let _ = std::fs::write(
            dir.join("default.toml"),
            format!(
                "# Default session layout, for every project without a layout of its own.\n# `:layout default` inside a session saves that session's layout here;\n# `:layout save` saves it for its project only. Or edit this file.\n#\n# Leaves are {{type = \"term\", role = \"agent\"|\"shell\"}}\n# or {{type = \"comp\", comp = \"inspector\"|\"tasks\"|\"files\"|\"activity\"|\"web\"|\"commands\"|\"subagents\"|\"usage\"|\"errors\"|\"diff\"|\"review\"}}.\n# Splits: dir = \"h\" (side by side) or \"v\" (stacked), ratio = share of the first child.\n\n{body}"
            ),
        );
    }
}

pub fn save_template(project_key: &str, spec: &NodeSpec) {
    let dir = layouts_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(body) = toml::to_string_pretty(&LayoutFile { layout: spec.clone() }) {
        let _ = std::fs::write(dir.join(format!("{project_key}.toml")), format!("# Saved by polypore. Edit freely.\n\n{body}"));
    }
}
