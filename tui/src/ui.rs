//! Drawing. Every screen is a list on the left and the selection's details
//! on the right; words over glyphs; sections appear only when they have
//! something to say.

use std::sync::Arc;

use ratatui::Frame;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use unicode_width::UnicodeWidthStr;

use crate::app::*;
use crate::layout::{Comp, LeafKind};
use crate::model::*;
use crate::pane::PaneKind;
use crate::secrets::Decision;
use crate::skills::Status;
use crate::store::Snapshot;
use crate::theme::Theme;

// ---------- small helpers ----------

pub fn trunc(s: &str, w: usize) -> String {
    if s.width() <= w {
        return s.to_string();
    }
    if w == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut used = 0;
    for ch in s.chars() {
        let cw = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + cw + 1 > w {
            break;
        }
        out.push(ch);
        used += cw;
    }
    out.push('…');
    out
}

pub(crate) fn trunc_left(s: &str, w: usize) -> String {
    if s.width() <= w || w < 4 {
        return trunc(s, w);
    }
    let mut out: Vec<char> = Vec::new();
    let mut used = 1;
    for ch in s.chars().rev() {
        let cw = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + cw > w {
            break;
        }
        out.push(ch);
        used += cw;
    }
    out.reverse();
    format!("…{}", out.into_iter().collect::<String>())
}

pub(crate) fn put(buf: &mut Buffer, x: u16, y: u16, s: &str, style: Style, maxw: u16) {
    if maxw > 0 {
        buf.set_stringn(x, y, s, maxw as usize, style);
    }
}

pub(crate) fn put_line(buf: &mut Buffer, x: u16, y: u16, line: &Line, maxw: u16) {
    if maxw > 0 {
        buf.set_line(x, y, line, maxw);
    }
}

pub(crate) fn gauge(frac: f64, w: usize, on: Color, off: Color) -> Vec<Span<'static>> {
    let frac = frac.clamp(0.0, 1.0);
    let full = (frac * w as f64).round() as usize;
    vec![Span::styled("━".repeat(full), Style::default().fg(on)), Span::styled("━".repeat(w.saturating_sub(full)), Style::default().fg(off))]
}


fn frame_block<'a>(t: &Theme, title: Line<'a>, focused: bool) -> Block<'a> {
    let color = if focused { t.accent } else { t.faint };
    let b = Block::default().title(title).border_style(Style::default().fg(color));
    match t.border {
        Some(bt) => b.borders(Borders::ALL).border_type(bt),
        None => b.borders(Borders::NONE),
    }
}

fn inner(t: &Theme, r: Rect) -> Rect {
    if t.border.is_some() {
        Rect { x: r.x + 1, y: r.y + 1, width: r.width.saturating_sub(2), height: r.height.saturating_sub(2) }
    } else {
        Rect { y: r.y + 1, height: r.height.saturating_sub(1), ..r }
    }
}

pub(crate) fn pad_rect(r: Rect, x: u16, y: u16) -> Rect {
    Rect { x: r.x + x, y: r.y + y, width: r.width.saturating_sub(x * 2), height: r.height.saturating_sub(y * 2) }
}

fn centered(area: Rect, w: u16, h: u16) -> Rect {
    let w = w.min(area.width);
    let h = h.min(area.height);
    Rect { x: area.x + (area.width - w) / 2, y: area.y + (area.height - h) / 2, width: w, height: h }
}

fn proj_name(root: &str) -> String {
    std::path::Path::new(root).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| root.to_string())
}

fn short_model(m: &str) -> String {
    let m = m.trim_start_matches("claude-");
    m.split('[').next().unwrap_or(m).to_string()
}

fn path_of_url(u: &str) -> String {
    let s = u.split("://").nth(1).unwrap_or(u);
    s.find('/').map(|i| s[i..].to_string()).unwrap_or_default()
}

/// A section heading: `label ────────── meta`.
pub(crate) fn rule(t: &Theme, label: &str, meta: &str, w: usize, color: Color) -> Line<'static> {
    // label, a space, the fill, then " meta": exactly `w` columns.
    let fill = w.saturating_sub(label.width() + 1 + if meta.is_empty() { 0 } else { meta.width() + 1 });
    let mut spans = vec![
        Span::styled(label.to_string(), Style::default().fg(color).add_modifier(Modifier::BOLD)),
        Span::styled(format!(" {}", "─".repeat(fill)), Style::default().fg(t.faint)),
    ];
    if !meta.is_empty() {
        spans.push(Span::styled(format!(" {meta}"), Style::default().fg(t.dim)));
    }
    Line::from(spans)
}

pub(crate) fn spinner(tick: u64) -> &'static str {
    ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][(tick / 90 % 10) as usize]
}

fn state_dot(t: &Theme, s: RunState, tick: u64) -> Span<'static> {
    match s {
        RunState::Working => Span::styled(spinner(tick).to_string(), Style::default().fg(t.accent)),
        RunState::NeedsInput => Span::styled("●".to_string(), Style::default().fg(t.warn).add_modifier(Modifier::BOLD)),
        RunState::Ready => Span::styled("●".to_string(), Style::default().fg(t.ok)),
        RunState::Closed => Span::styled("○".to_string(), Style::default().fg(t.faint)),
    }
}

pub fn wrap(s: &str, w: usize) -> Vec<String> {
    let w = w.max(8);
    let mut out = Vec::new();
    for para in s.lines() {
        let mut line = String::new();
        let mut lw = 0;
        for word in para.split_whitespace() {
            let ww = word.width();
            if lw > 0 && lw + ww + 1 > w {
                out.push(std::mem::take(&mut line));
                lw = 0;
            }
            if ww > w {
                out.push(trunc(word, w));
                continue;
            }
            if lw > 0 {
                line.push(' ');
                lw += 1;
            }
            line.push_str(word);
            lw += ww;
        }
        if !line.is_empty() {
            out.push(line);
        }
    }
    out
}

/// The dash peek shows the last reply; focus does not, because the
/// terminal beside it already does.
#[derive(Clone, Copy)]
struct InspectOpts {
    last_reply: bool,
    in_focus: bool,
    /// A review panel is open beside it, so the inspector leaves findings out.
    review_panel: bool,
}

/// A path with the folder part dimmed and the file name in `name`,
/// trimmed from the left so the file name always shows.
fn path_spans(t: &Theme, rel: &str, w: usize, name: Style) -> Vec<Span<'static>> {
    let shown = trunc_left(rel, w);
    match shown.rfind('/') {
        Some(i) => vec![
            Span::styled(shown[..=i].to_string(), Style::default().fg(t.faint)),
            Span::styled(shown[i + 1..].to_string(), name),
        ],
        None => vec![Span::styled(shown, name)],
    }
}

/// "+12 −3", leaving out a side that is zero.
fn diff_text(add: u32, del: u32) -> String {
    match (add, del) {
        (0, 0) => String::new(),
        (a, 0) => format!("+{a}"),
        (0, d) => format!("−{d}"),
        (a, d) => format!("+{a} −{d}"),
    }
}

fn diff_spans(t: &Theme, add: u32, del: u32) -> Vec<Span<'static>> {
    let mut v = Vec::new();
    if add > 0 {
        v.push(Span::styled(format!("+{add}"), Style::default().fg(t.ok)));
    }
    if del > 0 {
        v.push(Span::styled(format!("{}−{del}", if add > 0 { " " } else { "" }), Style::default().fg(t.err)));
    }
    v
}

/// Spans cut to `w` columns, ending in `…` when something was cut.
pub(crate) fn fit_spans(spans: Vec<Span<'static>>, w: usize) -> Line<'static> {
    let mut out = Vec::new();
    let mut used = 0;
    for sp in spans {
        let sw = sp.content.width();
        if used + sw <= w {
            used += sw;
            out.push(sp);
            continue;
        }
        let rest = w.saturating_sub(used);
        if rest > 0 {
            out.push(Span::styled(trunc(&sp.content, rest), sp.style));
        } else if let Some(last) = out.pop() {
            // The previous span filled the line exactly: end it in `…`.
            let lw = last.content.width();
            out.push(Span::styled(trunc(&format!("{}…", last.content), lw), last.style));
        }
        break;
    }
    Line::from(out)
}

/// A review's markdown as lines: bullets wrapped, severities colored.
fn review_lines(t: &Theme, text: &str, w: usize) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let l = raw.trim_end();
        if l.trim().is_empty() {
            continue;
        }
        let (bullet, body) = match l.trim_start().strip_prefix("- ").or_else(|| l.trim_start().strip_prefix("* ")) {
            Some(b) => (true, b.to_string()),
            None => (false, l.trim_start_matches('#').trim().to_string()),
        };
        let body = body.replace("**", "").replace('`', "");
        let sev = body.split_whitespace().next().unwrap_or("").trim_end_matches(':').to_lowercase();
        let col = match sev.as_str() {
            "bug" => t.err,
            "risk" => t.warn,
            "nit" => t.dim,
            _ => t.fg,
        };
        for (i, part) in wrap(&body, w.saturating_sub(2)).into_iter().enumerate() {
            let lead = if bullet && i == 0 { "• " } else { "  " };
            out.push(Line::from(vec![Span::styled(lead, Style::default().fg(col)), Span::styled(part, Style::default().fg(if i == 0 && bullet { col } else { t.fg }))]));
        }
    }
    out
}

/// Text with every occurrence of the search terms picked out.
fn highlight(t: &Theme, text: &str, terms: &[String]) -> Vec<Span<'static>> {
    let mut marks: Vec<(usize, usize)> = Vec::new();
    for term in terms.iter().filter(|x| !x.is_empty()) {
        let mut from = 0;
        while let Some(i) = crate::search::find_ci(&text[from..], term) {
            let s = from + i;
            let mut e = s + term.len();
            while !text.is_char_boundary(e) {
                e += 1;
            }
            marks.push((s, e));
            from = e;
            if from >= text.len() {
                break;
            }
        }
    }
    marks.sort();
    let mut out = Vec::new();
    let mut at = 0;
    for (s, e) in marks {
        if s < at {
            continue;
        }
        if s > at {
            out.push(Span::styled(text[at..s].to_string(), Style::default().fg(t.fg)));
        }
        out.push(Span::styled(text[s..e].to_string(), Style::default().fg(t.accent).add_modifier(Modifier::BOLD | Modifier::UNDERLINED)));
        at = e;
    }
    if at < text.len() {
        out.push(Span::styled(text[at..].to_string(), Style::default().fg(t.fg)));
    }
    out
}

pub(crate) fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

impl App {
    pub fn key_label(&self, k: &str) -> String {
        if self.alt_mode {
            format!("alt-{k}")
        } else {
            format!("{} {k}", crate::keys::chord_label(&self.cfg.keys.prefix))
        }
    }

    fn ctx_window(&self, run: &AgentRun) -> u64 {
        let cfg = self.cfg.agent(run.key.kind.label()).context_window;
        if cfg > 0 { cfg } else { run.ctx_window }
    }

    fn run_state(&self, run: &AgentRun, now: i64) -> RunState {
        let hosted = self.pane_for_run(&run.key).is_some();
        run.state_hosted(now, hosted)
    }

    pub fn draw(&mut self, f: &mut Frame) {
        let area = f.area();
        self.size = (area.width, area.height);
        self.hits.clear();
        self.awake = self.sleep.active();
        if !self.theme.transparent {
            f.buffer_mut().set_style(area, Style::default().bg(self.theme.bg).fg(self.theme.fg));
        }
        if area.width < 60 || area.height < 16 {
            put(f.buffer_mut(), area.x + 1, area.y, "polypore needs at least 60×16", self.theme.dim(), area.width.saturating_sub(1));
            return;
        }
        let shared = self.shared.clone();
        let snap = shared.lock().unwrap();
        let top = Rect { height: 1, ..area };
        let bottom = Rect { y: area.y + area.height - 1, height: 1, ..area };
        let main = Rect { y: area.y + 1, height: area.height.saturating_sub(2), ..area };
        match self.view {
            View::Projects => self.draw_projects(f, main, &snap),
            View::Dash => {
                self.build_cards(&snap);
                self.draw_dash(f, main, &snap)
            }
            View::Focus => self.draw_focus(f, main, &snap),
            View::Skills => self.draw_skills(f, main),
            View::Secrets => self.draw_secrets(f, main),
            View::Stats => self.draw_stats_page(f, main),
        }
        self.draw_top(f, top, &snap);
        self.draw_bottom(f, bottom, &snap);
        drop(snap);
        self.draw_toast(f, main);
        self.draw_overlay(f, area);
    }

    // ---------- chrome ----------

    fn draw_top(&mut self, f: &mut Frame, r: Rect, snap: &Snapshot) {
        let t = self.theme.clone();
        let buf = f.buffer_mut();
        let mut x = r.x + 1;
        put(buf, x, r.y, "⁂", Style::default().fg(t.accent), 1);
        x += 2;
        let needs = self.attention_in(snap).len();
        let awake = self.awake;
        let clock = chrono::Local::now().format("%H:%M").to_string();
        let mut right: Vec<(String, Style, Option<Hit>)> = Vec::new();
        if needs > 0 {
            right.push((format!("● {needs} need{} you", if needs == 1 { "s" } else { "" }), Style::default().fg(t.warn).add_modifier(Modifier::BOLD), Some(Hit::Attention(0))));
        }
        for v in [View::Skills, View::Secrets, View::Stats] {
            let style = if self.view == v { Style::default().fg(t.fg).add_modifier(Modifier::BOLD) } else { t.dim() };
            right.push((v.label().to_string(), style, Some(Hit::Tab(v))));
        }
        right.push((
            if awake { "awake".into() } else { "sleep ok".into() },
            if awake { Style::default().fg(t.warn) } else { t.faint() },
            Some(Hit::Sleep),
        ));
        right.push((clock, t.dim(), None));
        let total: u16 = right.iter().map(|(s, _, _)| s.width() as u16 + 3).sum();
        // Breadcrumb: the project stays as context on its sub-screens, but
        // not on the projects list itself. Labels get the room that is free.
        let mut crumbs: Vec<(String, View)> = vec![("projects".into(), View::Projects)];
        if let Some(p) = &self.project {
            if self.view != View::Projects {
                crumbs.push((proj_name(p), View::Dash));
            }
        }
        if self.view == View::Focus {
            if let Some(ws) = self.active() {
                crumbs.push((ws.name.clone(), View::Focus));
            }
        }
        let crumb_end = (r.x + r.width).saturating_sub(total + 2);
        for (i, (label, v)) in crumbs.iter().enumerate() {
            if i > 0 {
                put(buf, x, r.y, "›", t.faint(), 1);
                x += 2;
            }
            let active = self.view == *v;
            let style = if active { Style::default().fg(t.fg).add_modifier(Modifier::BOLD) } else { t.dim() };
            let room = crumb_end.saturating_sub(x) as usize;
            if room < 4 {
                break;
            }
            let label = trunc(label, room.min(80));
            let w = label.width() as u16;
            put(buf, x, r.y, &label, style, w);
            self.hits.push((Rect { x, y: r.y, width: w, height: 1 }, Hit::Tab(*v)));
            x += w + 1;
        }
        let mut rx = (r.x + r.width).saturating_sub(total);
        for (s, style, hit) in right {
            let w = s.width() as u16;
            put(buf, rx, r.y, &s, style, w);
            if let Some(h) = hit {
                self.hits.push((Rect { x: rx, y: r.y, width: w, height: 1 }, h));
            }
            rx += w + 3;
        }
    }

    fn draw_bottom(&mut self, f: &mut Frame, r: Rect, snap: &Snapshot) {
        let t = self.theme.clone();
        let mut x = r.x + 1;
        let maxx = r.x + r.width;
        if self.prefix_armed.is_some() {
            let buf = f.buffer_mut();
            put(buf, x, r.y, "then ", Style::default().fg(t.warn).add_modifier(Modifier::BOLD), 5);
            put(buf, x + 5, r.y, "d back  hjkl move  n terminal  c claude  x codex  a add panel  w close  z zoom  s awake  ? all keys", t.dim(), r.width.saturating_sub(6));
            return;
        }
        if self.yank_armed.is_some() {
            let buf = f.buffer_mut();
            put(buf, x, r.y, "copy ", Style::default().fg(t.warn).add_modifier(Modifier::BOLD), 5);
            put(buf, x + 5, r.y, "r resume command  i id  c folder  t title  l last reply  f changed files  p plan", t.dim(), r.width.saturating_sub(6));
            return;
        }
        if let Some(a) = self.approvals.first().cloned() {
            let buf = f.buffer_mut();
            let text = format!("allow {} for `{}`?  ", a.secrets.join(", "), trunc(&a.target, 50));
            put(buf, x, r.y, &text, Style::default().fg(t.warn).add_modifier(Modifier::BOLD), maxx.saturating_sub(x));
            x += text.width() as u16;
            for (label, d) in [("y once", Decision::Once), ("Y always", Decision::Always), ("N deny", Decision::Deny)] {
                let w = label.width() as u16 + 3;
                put(buf, x, r.y, label, Style::default().fg(if d == Decision::Deny { t.err } else { t.ok }), w);
                self.hits.push((Rect { x, y: r.y, width: w, height: 1 }, Hit::Approval(0, d)));
                x += w;
            }
            return;
        }
        let k = |s: &str| self.key_label(s);
        let hidden = self.cfg.projects.hidden.len();
        let hidden_hint = if self.show_hidden { "hide hidden".to_string() } else { format!("show {hidden} hidden") };
        let keys: Vec<(String, &str)> = match self.view {
            View::Projects => {
                let mut v: Vec<(String, &str)> = vec![
                    ("j k".into(), "move"),
                    ("enter".into(), "open"),
                    ("c".into(), "new claude"),
                    ("x".into(), "new codex"),
                    ("n".into(), "terminal"),
                    ("s".into(), "search"),
                    ("p".into(), "pin"),
                    ("H".into(), "hide"),
                    ("a".into(), "add a folder"),
                ];
                if hidden > 0 || self.show_hidden {
                    v.push((".".into(), hidden_hint.as_str()));
                }
                v
            }
            View::Dash if !self.marks.is_empty() => vec![("i".into(), "prompt all"), ("r".into(), "resume all"), ("A".into(), "archive"), ("d".into(), "close"), ("space".into(), "mark"), ("esc".into(), "clear marks")],
            View::Dash => {
                let mut v: Vec<(String, &str)> = vec![("enter".into(), "open"), ("i".into(), "prompt"), ("r".into(), "resume"), ("c".into(), "new claude")];
                if !self.attention_in(snap).is_empty() {
                    v.insert(0, ("!".into(), "next waiting"));
                }
                v.push(("f".into(), "filter"));
                v.push(("s".into(), "search"));
                v.push(("space".into(), "mark"));
                v
            }
            View::Focus => vec![(k("q"), "back"), (k("hjkl"), "move"), (k("n"), "split"), (k("a"), "add panel")],
            View::Skills => vec![("s".into(), "link all"), ("a".into(), "adopt"), ("n".into(), "new"), ("e".into(), "edit"), ("d".into(), "drop broken"), ("esc".into(), "back")],
            View::Secrets => vec![("a".into(), "add"), ("i".into(), "import .env"), ("w".into(), "set up agents"), ("d".into(), "delete"), ("esc".into(), "back")],
            View::Stats => vec![("j k".into(), "scroll"), ("r".into(), "refresh"), ("m".into(), "ask a model"), ("o".into(), "open report"), ("esc".into(), "back")],
        };
        // Limits on the right, only while they describe now.
        let now = now_ms();
        let quotas = self.quota.lock().unwrap().clone();
        let mut limits_w = 0u16;
        let buf = f.buffer_mut();
        let mut spans: Vec<Span> = Vec::new();
        for q in &quotas {
            let cur = q.current(now);
            if cur.is_empty() {
                continue;
            }
            spans.push(Span::styled(format!("{} ", q.agent.label()), Style::default().fg(t.agent(Some(q.agent))).add_modifier(Modifier::DIM)));
            for w in cur {
                let short = matches!(w.pace(now), crate::quota::Pace::RunsOut(_));
                let col = if w.used > 85.0 || short { t.err } else if w.used > 60.0 { t.warn } else { t.dim };
                spans.push(Span::styled(format!("{} {:.0}%{} ", w.name, w.used, if short { "!" } else { "" }), Style::default().fg(col)));
            }
            spans.push(Span::raw(" "));
        }
        if !spans.is_empty() {
            let line = Line::from(spans);
            let w = line.width() as u16;
            if r.width > w + 60 {
                put_line(buf, maxx - w, r.y, &line, w);
                limits_w = w + 2;
            }
        }
        // Keys left to right in order of importance; the help key always
        // shows, so whatever does not fit is one keypress away. Inside a
        // session plain `?` goes to the terminal, so it carries the modifier.
        let help = if self.view == View::Focus { k("?") } else { "?".to_string() };
        let help_w = (help.width() + "keys".width() + 4) as u16;
        let limit = maxx.saturating_sub(limits_w + help_w);
        for (key, what) in keys.iter() {
            let w = (key.width() + what.width() + 4) as u16;
            if x + w > limit {
                break;
            }
            put(buf, x, r.y, key, Style::default().fg(t.accent), key.width() as u16);
            put(buf, x + key.width() as u16 + 1, r.y, what, t.dim(), what.width() as u16);
            x += w;
        }
        put(buf, x, r.y, &help, Style::default().fg(t.accent), help.width() as u16);
        put(buf, x + help.width() as u16 + 1, r.y, "keys", t.dim(), 4);
    }

    fn draw_toast(&self, f: &mut Frame, main: Rect) {
        let Some((msg, _, tone)) = &self.toast else { return };
        let t = &self.theme;
        let col = match tone {
            Tone::Info => t.info,
            Tone::Ok => t.ok,
            Tone::Warn => t.warn,
            Tone::Err => t.err,
        };
        let w = (msg.width() as u16 + 4).min(main.width.saturating_sub(4));
        let r = Rect { x: main.x + main.width.saturating_sub(w + 1), y: main.y + main.height.saturating_sub(3), width: w, height: 3 };
        f.render_widget(Clear, r);
        let b = Block::default().borders(Borders::ALL).border_type(t.border.unwrap_or(ratatui::widgets::BorderType::Rounded)).border_style(Style::default().fg(col));
        f.render_widget(Paragraph::new(Line::from(Span::styled(trunc(msg, w.saturating_sub(4) as usize), Style::default().fg(t.fg)))).block(b), r);
    }

    // ---------- projects: list + preview ----------

    fn draw_projects(&mut self, f: &mut Frame, area: Rect, snap: &Snapshot) {
        let t = self.theme.clone();
        let now = now_ms();
        let tick = self.tick_ms();
        let wide = area.width >= 110;
        let list_w = if wide { (area.width * 45 / 100).max(48) } else { area.width };
        // The preview column starts here; the brand band's right half
        // starts on the same column so the screen reads as one grid.
        let pv_x = area.x + list_w + 2;
        let head_h: u16 = if area.height >= 30 { 8 } else { 0 };
        if head_h > 0 {
            let band = Rect { x: area.x + 2, y: area.y + 1, width: area.width.saturating_sub(4), height: head_h };
            self.draw_brand(f, band, snap, tick, now, wide.then_some(pv_x));
        }
        let mut rows = self.visible_projects(snap);
        for (i, root) in self.cfg.projects.extra.iter().enumerate() {
            if !snap.projects.iter().any(|p| &p.root == root) {
                rows.push(snap.projects.len() + i);
            }
        }
        // Wide: list and preview side by side. Narrow (a half-width tile):
        // the preview stacks under the list instead of disappearing.
        let avail_h = area.height.saturating_sub(1 + head_h);
        let list_h = if wide || avail_h < 18 { avail_h } else { (rows.len() as u16 + 3).min(avail_h * 45 / 100).max(6) };
        let list = Rect { x: area.x + 2, y: area.y + 1 + head_h, width: list_w.saturating_sub(3), height: list_h };
        let pv = if wide {
            Some(Rect { x: pv_x, y: list.y, width: area.width.saturating_sub(list_w + 4), height: list_h })
        } else if list_h < avail_h {
            Some(Rect { x: list.x, y: list.y + list_h, width: list.width, height: avail_h - list_h })
        } else {
            None
        };
        self.project_rows = rows.clone();
        if self.sel_project >= rows.len() {
            self.sel_project = rows.len().saturating_sub(1);
        }
        let mut live_by: std::collections::HashMap<String, (usize, usize, usize)> = std::collections::HashMap::new();
        for r in snap.runs.values() {
            let s = self.run_state(r, now);
            if s == RunState::Closed {
                continue;
            }
            if let Some(si) = snap.sessions.get(&r.key) {
                let e = live_by.entry(si.root.clone()).or_default();
                match s {
                    RunState::NeedsInput => e.0 += 1,
                    RunState::Working => e.1 += 1,
                    _ => e.2 += 1,
                }
            }
        }
        let buf = f.buffer_mut();
        let meta = if self.filter.is_empty() { format!("{}", rows.len()) } else { format!("matching \"{}\"", self.filter) };
        put_line(buf, list.x, list.y, &rule(&t, "projects", &meta, list.width as usize, t.accent2), list.width);
        let body = Rect { y: list.y + 2, height: list.height.saturating_sub(3), ..list };
        let h = body.height as usize;
        let offset = if self.sel_project >= h { self.sel_project + 1 - h } else { 0 };
        for (row, &pi) in rows.iter().enumerate().skip(offset).take(h) {
            let y = body.y + (row - offset) as u16;
            let sel = row == self.sel_project;
            let (root, name, last) = if pi < snap.projects.len() {
                let p = &snap.projects[pi];
                (p.root.clone(), p.name.clone(), p.last)
            } else {
                let root = self.cfg.projects.extra[pi - snap.projects.len()].clone();
                (root.clone(), proj_name(&root), 0)
            };
            if sel {
                buf.set_style(Rect { x: body.x.saturating_sub(1), y, width: body.width + 1, height: 1 }, Style::default().bg(t.sel));
            }
            let (needs, working, ready) = live_by.get(&root).copied().unwrap_or_default();
            let hosted = self.workspaces.iter().any(|w| w.project == root);
            let dot = if needs > 0 {
                state_dot(&t, RunState::NeedsInput, tick)
            } else if working > 0 {
                state_dot(&t, RunState::Working, tick)
            } else if ready > 0 || hosted {
                state_dot(&t, RunState::Ready, tick)
            } else {
                Span::raw(" ")
            };
            put_line(buf, body.x, y, &Line::from(dot), 1);
            let right = if needs > 0 {
                Span::styled(format!("{needs} need{} you", if needs == 1 { "s" } else { "" }), Style::default().fg(t.warn))
            } else if working > 0 {
                Span::styled(format!("{working} working"), Style::default().fg(t.accent))
            } else if last == 0 {
                Span::styled("new".to_string(), t.faint())
            } else {
                Span::styled(ago(now, last), t.faint())
            };
            let rw = right.width() as u16;
            let pinned = self.cfg.projects.pinned.contains(&root);
            let name = if pinned { format!("{name} ★") } else { name };
            let nm = trunc(&name, 28.min(body.width.saturating_sub(rw + 6) as usize));
            put(buf, body.x + 2, y, &nm, Style::default().fg(if sel { t.accent } else { t.fg }).add_modifier(Modifier::BOLD), nm.width() as u16);
            let px = body.x + 3 + nm.width() as u16;
            let pw = body.width.saturating_sub(px - body.x + rw + 2);
            if pw > 8 {
                put(buf, px, y, &trunc_left(&rel_path(&root, ""), pw as usize), t.faint(), pw);
            }
            put_line(buf, body.x + body.width - rw, y, &Line::from(right), rw);
            self.hits.push((Rect { x: body.x, y, width: body.width, height: 1 }, Hit::Project(row)));
        }
        if rows.is_empty() {
            let msg = if snap.indexed { "no projects yet. run claude or codex in a folder, or press a to add one." } else { "reading ~/.claude and ~/.codex…" };
            put(buf, body.x, body.y, msg, t.dim(), body.width);
        }
        let Some(pv) = pv else { return };
        let Some(&pi) = rows.get(self.sel_project) else {
            self.draw_welcome(f, pv, snap);
            return;
        };
        let (root, sessions) = if pi < snap.projects.len() {
            (snap.projects[pi].root.clone(), snap.projects[pi].sessions.clone())
        } else {
            (self.cfg.projects.extra[pi - snap.projects.len()].clone(), Vec::new())
        };
        let buf = f.buffer_mut();
        let w = pv.width as usize;
        let mut y = pv.y;
        let pv_bottom = pv.y + pv.height;
        put_line(buf, pv.x, y, &rule(&t, &proj_name(&root), &rel_path(&root, ""), w, t.fg), pv.width);
        y += 2;
        let (cl, cx) = sessions.iter().fold((0, 0), |a, k| if k.kind == AgentKind::Claude { (a.0 + 1, a.1) } else { (a.0, a.1 + 1) });
        let mut days = [0u64; 14];
        for k in &sessions {
            if let Some(s) = snap.sessions.get(k) {
                let d = (now - s.mtime) / 86_400_000;
                if (0..14).contains(&d) {
                    days[13 - d as usize] += 1;
                }
            }
        }
        let recent14: u64 = days.iter().sum();
        put_line(buf, pv.x, y, &Line::from(vec![
            Span::styled(format!("{cl} claude · {cx} codex sessions"), t.dim()),
            Span::styled(format!("   {recent14} in the last two weeks"), t.faint()),
        ]), pv.width);
        y += 2;
        let mut live: Vec<Arc<AgentRun>> = snap
            .runs
            .values()
            .filter(|r| snap.sessions.get(&r.key).map(|s| s.root == root).unwrap_or(false) && self.run_state(r, now) != RunState::Closed)
            .cloned()
            .collect();
        live.sort_by_key(|r| (self.run_state(r, now), -r.updated));
        if !live.is_empty() {
            put_line(buf, pv.x, y, &rule(&t, "open now", &live.len().to_string(), w, t.accent2), pv.width);
            y += 1;
            for r in live.iter().take(6) {
                if y >= pv_bottom {
                    break;
                }
                let s = self.run_state(r, now);
                let label = s.label();
                let tw = w.saturating_sub(label.width() + 4);
                put_line(buf, pv.x, y, &Line::from(vec![state_dot(&t, s, tick), Span::raw(" "), Span::styled(trunc(&r.display_title(), tw), Style::default().fg(t.fg))]), pv.width);
                put(buf, pv.x + pv.width - label.width() as u16, y, label, Style::default().fg(t.state(s)), label.width() as u16);
                y += 1;
            }
            y += 1;
        }
        let older = sessions.len().saturating_sub(live.len());
        if y + 1 >= pv_bottom {
            return;
        }
        let shown = older.min(10).min((pv_bottom - y - 1) as usize);
        put_line(buf, pv.x, y, &rule(&t, "recent sessions", &if older > shown { format!("{shown} of {older}") } else { String::new() }, w, t.accent2), pv.width);
        y += 1;
        for k in sessions.iter().filter(|k| !live.iter().any(|r| &r.key == *k)).take(shown) {
            let info = snap.sessions.get(k);
            let title = snap
                .runs
                .get(k)
                .map(|r| r.display_title())
                .or_else(|| info.map(|i| if i.title.is_empty() { i.first_prompt.clone() } else { i.title.clone() }))
                .unwrap_or_default();
            let when = ago(now, info.map(|i| i.mtime).unwrap_or(0));
            put_line(buf, pv.x, y, &Line::from(vec![
                Span::styled(format!("{:<7}", k.kind.label()), Style::default().fg(t.agent(Some(k.kind)))),
                Span::styled(trunc(if title.is_empty() { "untitled" } else { &title }, w.saturating_sub(13)), t.dim()),
            ]), pv.width.saturating_sub(5));
            put(buf, pv.x + pv.width.saturating_sub(4), y, &format!("{when:>4}"), t.faint(), 4);
            y += 1;
        }
    }

    /// The mascot's mood follows your agents.
    fn mood(&self, snap: &Snapshot, now: i64) -> crate::art::Mood {
        use crate::art::Mood;
        let mut working = false;
        for r in snap.runs.values() {
            match self.run_state(r, now) {
                RunState::NeedsInput => return Mood::Alert,
                RunState::Working => working = true,
                _ => {}
            }
        }
        if working {
            Mood::Busy
        } else if self.sleep_on() {
            Mood::Watch
        } else {
            Mood::Idle
        }
    }

    fn sleep_on(&self) -> bool {
        self.awake
    }

    /// Mushroom, wordmark and a one-line status, above the project list.
    /// `col`: where the preview column starts; the cross-project summary
    /// lines up with it. None on narrow screens, where it is left out.
    fn draw_brand(&mut self, f: &mut Frame, r: Rect, snap: &Snapshot, tick: u64, now: i64, col: Option<u16>) {
        use crate::art::{mascot, Mood, Part, MASCOT_W, WORDMARK};
        let t = self.theme.clone();
        let mood = self.mood(snap, now);
        let buf = f.buffer_mut();
        for (i, (part, row)) in mascot(mood, tick).into_iter().enumerate() {
            let style = match part {
                Part::Spores => Style::default().fg(if mood == Mood::Alert { t.warn } else { t.accent2 }),
                Part::Cap => Style::default().fg(t.accent),
                Part::Stem => Style::default().fg(t.accent2),
            };
            put(buf, r.x, r.y + i as u16, &row, style, MASCOT_W);
        }
        let x = r.x + MASCOT_W + 3;
        let w = r.width.saturating_sub(MASCOT_W + 3);
        for (i, row) in WORDMARK.iter().enumerate() {
            put(buf, x, r.y + 2 + i as u16, row, Style::default().fg(t.accent).add_modifier(Modifier::BOLD), w);
        }
        put(buf, x, r.y + 4, "a dash for your coding agents", t.dim(), w);
        let mut counts = [0usize; 3];
        for run in snap.runs.values() {
            match self.run_state(run, now) {
                RunState::NeedsInput => counts[0] += 1,
                RunState::Working => counts[1] += 1,
                RunState::Ready => counts[2] += 1,
                RunState::Closed => {}
            }
        }
        let line = match mood {
            Mood::Alert => Line::from(Span::styled(format!("{} waiting on you", plural(counts[0], "session is", "sessions are")), Style::default().fg(t.warn).add_modifier(Modifier::BOLD))),
            Mood::Busy => Line::from(Span::styled(format!("{} at work", plural(counts[1], "agent", "agents")), Style::default().fg(t.accent))),
            Mood::Watch => Line::from(Span::styled("keeping the machine awake", t.faint())),
            Mood::Idle if counts[2] > 0 => Line::from(Span::styled(format!("{} waiting for a prompt", plural(counts[2], "session", "sessions")), t.faint())),
            Mood::Idle => Line::from(Span::styled("all quiet", t.faint())),
        };
        put_line(buf, x, r.y + 5, &line, w);
        // right side: activity across every project
        if let Some(rx) = col.filter(|&c| c > x + 32 && c < r.x + r.width) {
            let rw = r.x + r.width - rx;
            let mut days = [0u64; 14];
            for si in snap.sessions.values() {
                let d = (now - si.mtime) / 86_400_000;
                if (0..14).contains(&d) {
                    days[13 - d as usize] += 1;
                }
            }
            let today = days[13];
            let week: u64 = days[7..].iter().sum();
            let active_projects = snap.projects.iter().filter(|p| now - p.last < 7 * 86_400_000).count();
            put_line(buf, rx, r.y + 1, &rule(&t, "across all projects", "", rw as usize, t.accent2), rw);
            let stat = |n: String, label: &str| vec![Span::styled(n, Style::default().fg(t.fg).add_modifier(Modifier::BOLD)), Span::styled(format!(" {label}     "), t.dim())];
            let mut l = stat(today.to_string(), "sessions today");
            l.extend(stat(week.to_string(), "this week"));
            l.extend(stat(active_projects.to_string(), if active_projects == 1 { "active project" } else { "active projects" }));
            put_line(buf, rx, r.y + 3, &Line::from(l), rw);
            let max = days.iter().copied().max().unwrap_or(0).max(1);
            let bars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
            let mut chart = String::new();
            for v in days {
                let c = if v == 0 { '·' } else { bars[((v as f64 / max as f64) * 7.0).round() as usize] };
                chart.push(c);
                chart.push(' ');
            }
            put_line(buf, rx, r.y + 5, &Line::from(vec![
                Span::styled(chart, Style::default().fg(t.accent)),
                Span::styled(" sessions, last 14 days", t.faint()),
            ]), rw);
        }
    }

    /// The files panel: the project as a navigable tree.
    fn draw_files(&mut self, f: &mut Frame, r: Rect, leaf: u64, run: Option<&AgentRun>, focused: bool) {
        let t = self.theme.clone();
        let (rows, _root) = self.tree_rows(leaf, run);
        let st = self.trees.get(&leaf).cloned().unwrap_or_default();
        let w = r.width as usize;
        let buf = f.buffer_mut();
        let changed = rows.iter().filter(|x| !x.dir && x.mark.changed).count();
        let head = if st.all {
            format!("project files{}", if changed > 0 { format!(" · {} changed", changed) } else { String::new() })
        } else {
            "files the agent touched".to_string()
        };
        put_line(buf, r.x, r.y, &Line::from(vec![
            Span::styled(head, Style::default().fg(t.accent2)),
            Span::styled(
                if !focused || run.is_none() { "" } else if st.all { "   a: only touched" } else { "   a: all files" }.to_string(),
                t.faint(),
            ),
        ]), r.width);
        let body = Rect { y: r.y + 1, height: r.height.saturating_sub(1), ..r };
        if rows.is_empty() {
            let msg = if st.all { "no files found" } else { "nothing touched yet. a shows the whole project." };
            put(buf, body.x, body.y, msg, t.faint(), body.width);
            return;
        }
        let h = body.height as usize;
        let offset = if st.sel >= h { st.sel + 1 - h } else { 0 };
        for (i, row) in rows.iter().enumerate().skip(offset).take(h) {
            let y = body.y + (i - offset) as u16;
            let sel = i == st.sel;
            if sel {
                let bg = if focused { t.sel } else { t.bg };
                if focused || !t.transparent {
                    buf.set_style(Rect { x: body.x, y, width: body.width, height: 1 }, Style::default().bg(bg));
                }
            }
            let indent = "  ".repeat(row.depth);
            let x = body.x + indent.width() as u16;
            let avail = w.saturating_sub(indent.width());
            if row.dir {
                let arrow = if row.open { "▾ " } else { "▸ " };
                let mut spans = vec![
                    Span::styled(arrow, t.faint()),
                    Span::styled(trunc(&format!("{}/", row.name), avail.saturating_sub(8)), Style::default().fg(t.accent2).add_modifier(Modifier::BOLD)),
                ];
                if !row.open && row.changed_below > 0 {
                    spans.push(Span::styled(format!("  {} changed", row.changed_below), Style::default().fg(t.ok)));
                }
                put_line(buf, x, y, &Line::from(spans), avail as u16);
            } else {
                let (style, tail): (Style, Vec<Span>) = if row.mark.changed {
                    (Style::default().fg(t.fg).add_modifier(Modifier::BOLD), diff_spans(&t, row.mark.added, row.mark.removed))
                } else if row.mark.read {
                    (Style::default().fg(t.dim), vec![Span::styled("read", t.faint())])
                } else {
                    (Style::default().fg(t.dim), Vec::new())
                };
                let tail_w: usize = tail.iter().map(|s| s.width()).sum();
                let name = trunc(&row.name, avail.saturating_sub(tail_w + 3));
                put(buf, x + 2, y, &name, if sel && focused { style.fg(t.accent) } else { style }, name.width() as u16);
                if tail_w > 0 {
                    put_line(buf, body.x + body.width - tail_w as u16, y, &Line::from(tail), tail_w as u16);
                }
            }
            self.hits.push((Rect { x: body.x, y, width: body.width, height: 1 }, Hit::TreeRow(leaf, i)));
        }
    }

    fn draw_welcome(&self, f: &mut Frame, r: Rect, snap: &Snapshot) {
        let t = &self.theme;
        let buf = f.buffer_mut();
        for (i, row) in crate::art::WORDMARK.iter().enumerate() {
            put(buf, r.x, r.y + i as u16, row, Style::default().fg(t.accent).add_modifier(Modifier::BOLD), r.width);
        }
        put(buf, r.x, r.y + 3, &format!("{} sessions indexed. pick a project on the left.", snap.sessions.len()), t.faint(), r.width);
    }

    // ---------- dash: sessions + details ----------

    fn draw_dash(&mut self, f: &mut Frame, area: Rect, snap: &Snapshot) {
        let t = self.theme.clone();
        let Some(root) = self.project.clone() else { return };
        let now = now_ms();
        let tick = self.tick_ms();
        let wide = area.width >= 100;
        let list_w = if wide { (area.width * 42 / 100).max(46) } else { area.width };
        // Narrow (a half-width tile): the detail stacks under the list
        // instead of disappearing.
        let avail_h = area.height.saturating_sub(1);
        let stacked = !wide && avail_h >= 18;
        let list_h = if stacked { (avail_h * 45 / 100).max(7) } else { avail_h };
        let list = Rect { x: area.x + 2, y: area.y + 1, width: list_w.saturating_sub(3), height: list_h };
        self.dash_cols = 1;
        let buf = f.buffer_mut();
        // The dash lists the latest sessions (`recent_sessions`); say so
        // when the project has more than that.
        let total = snap.projects.iter().find(|p| p.root == root).map(|p| p.sessions.len()).unwrap_or(0);
        let agent_cards = self.cards.iter().filter(|c| c.run.is_some()).count();
        let mut meta = if total > agent_cards { format!("latest {agent_cards} of {total}") } else { plural(self.cards.len(), "session", "sessions") };
        if snap.parse_queue > 0 {
            meta = format!("loading {}…", plural(snap.parse_queue, "session", "sessions"));
        }
        if !self.filter.is_empty() {
            meta = format!("matching \"{}\"", self.filter);
        }
        if self.status_filter != StatusFilter::All {
            meta = format!("{} only · f for more", self.status_filter.label());
        }
        if !self.marks.is_empty() {
            meta = format!("{} marked", self.marks.len());
        }
        put_line(buf, list.x, list.y, &rule(&t, &proj_name(&root), &meta, list.width as usize, t.accent2), list.width);
        if self.cards.is_empty() && self.status_filter != StatusFilter::All {
            put(buf, list.x, list.y + 2, &format!("nothing {} here. f shows the next group, esc shows everything.", if self.status_filter == StatusFilter::Archived { "archived".to_string() } else { format!("\"{}\"", self.status_filter.label()) }), t.dim(), list.width);
            return;
        }
        if self.cards.is_empty() {
            put(buf, list.x, list.y + 2, crate::art::SPROUT, Style::default().fg(t.accent), list.width);
            for (i, l) in ["nothing growing here yet", "", "c  start claude here", "x  start codex here", "n  open a terminal"].iter().enumerate() {
                put(buf, list.x, list.y + 4 + i as u16, l, t.dim(), list.width);
            }
            return;
        }
        let mut items: Vec<(Option<usize>, u8)> = Vec::new();
        let mut last_group = 255u8;
        for (i, c) in self.cards.iter().enumerate() {
            if c.group != last_group {
                if last_group != 255 {
                    items.push((None, 254));
                }
                items.push((None, c.group));
                last_group = c.group;
            }
            items.push((Some(i), c.group));
        }
        let body = Rect { y: list.y + 2, height: list.height.saturating_sub(2), ..list };
        let mut ys: Vec<u16> = Vec::new();
        let mut y = 0u16;
        for (idx, _) in &items {
            ys.push(y);
            y += if idx.is_some() { 2 } else { 1 };
        }
        let sel_pos = items.iter().position(|(i, _)| *i == Some(self.sel_card)).unwrap_or(0);
        let sel_y = ys.get(sel_pos).copied().unwrap_or(0);
        let offset = if sel_y + 3 > body.height { sel_y + 3 - body.height } else { 0 };
        let counts: Vec<usize> = (0..5u8).map(|g| self.cards.iter().filter(|c| c.group == g).count()).collect();
        for (n, (idx, g)) in items.iter().enumerate() {
            let iy = ys[n];
            if iy < offset || iy - offset >= body.height {
                continue;
            }
            let yy = body.y + iy - offset;
            match idx {
                None if *g == 254 => {}
                None => {
                    let col = match g {
                        0 => t.warn,
                        1 => t.accent,
                        2 => t.ok,
                        3 => t.info,
                        _ => t.dim,
                    };
                    put(f.buffer_mut(), body.x, yy, &format!("{}  {}", GROUPS[*g as usize], counts[*g as usize]), Style::default().fg(col).add_modifier(Modifier::BOLD), body.width);
                }
                Some(i) => {
                    let card = self.cards[*i].clone();
                    let sel = *i == self.sel_card;
                    let r = Rect { x: body.x.saturating_sub(1), y: yy, width: body.width + 1, height: if yy + 1 < body.y + body.height { 2 } else { 1 } };
                    self.draw_row(f, r, &card, sel, snap, tick, now);
                    self.hits.push((r, Hit::Card(*i)));
                }
            }
        }
        let detail = if wide {
            Rect { x: area.x + list_w + 2, y: area.y + 1, width: area.width.saturating_sub(list_w + 4), height: avail_h }
        } else if stacked {
            let sep = list.y + list_h;
            put(f.buffer_mut(), list.x, sep, &"─".repeat(list.width as usize), t.faint(), list.width);
            Rect { x: list.x, y: sep + 1, width: list.width, height: avail_h - list_h - 1 }
        } else {
            return;
        };
        if let Some(card) = self.cards.get(self.sel_card).cloned() {
            self.draw_detail(f, detail, &card, snap, tick, now);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_row(&mut self, f: &mut Frame, r: Rect, card: &Card, sel: bool, snap: &Snapshot, tick: u64, now: i64) {
        let t = self.theme.clone();
        let run = card.run.as_ref().and_then(|k| snap.runs.get(k)).cloned();
        let info = card.run.as_ref().and_then(|k| snap.sessions.get(k));
        let shell_pane = match card.kind {
            CardKind::Hosted(id) if card.group == 3 => self.workspaces.iter().find(|w| w.id == id).and_then(|w| w.layout.terms().first().copied()),
            _ => None,
        };
        let (title, line2): (String, Vec<Span>) = if let Some(p) = shell_pane.and_then(|p| self.panes.get(&p)) {
            ("terminal".to_string(), vec![Span::styled(format!("{} · {}", rel_path(&p.cwd, ""), if p.exited.is_some() { "exited" } else { "open" }), t.faint())])
        } else {
            // A new session has no id yet; its terminal says what agent it is.
            let kind = card.run.as_ref().map(|k| k.kind).or_else(|| match card.kind {
                CardKind::Hosted(id) => self.workspaces.iter().find(|w| w.id == id).and_then(|w| self.ws_agent_pane(w)).and_then(|p| self.panes.get(&p)).and_then(|p| p.detected),
                _ => None,
            });
            let title = card
                .run
                .as_ref()
                .and_then(|k| self.smeta.name(k).map(String::from))
                .or_else(|| run.as_ref().map(|r| r.display_title()))
                .or_else(|| info.map(|i| if i.title.is_empty() { i.first_prompt.clone() } else { i.title.clone() }))
                .unwrap_or_default();
            let act = run.as_ref().map(|r| r.activity(card.state)).unwrap_or_default();
            let act_style = match card.state {
                RunState::NeedsInput => Style::default().fg(t.warn),
                RunState::Working => Style::default().fg(t.dim),
                _ => t.faint(),
            };
            let mut l2 = vec![Span::styled(format!("{} ", kind.map(|k| k.label()).unwrap_or("")), Style::default().fg(t.agent(kind)).add_modifier(Modifier::DIM))];
            let wt = match card.kind {
                CardKind::Hosted(id) => self.workspaces.iter().find(|w| w.id == id).and_then(|w| w.worktree.as_ref()).map(|w| w.branch.clone()),
                _ => None,
            };
            if let Some(b) = wt {
                l2.push(Span::styled(format!("on {b} · "), Style::default().fg(t.accent2)));
            }
            let queued = card.run.as_ref().and_then(|k| self.queue.get(k)).map(|q| q.len()).unwrap_or(0);
            if queued > 0 {
                l2.push(Span::styled(format!("{queued} queued · "), Style::default().fg(t.info)));
            }
            if !act.is_empty() {
                l2.push(Span::styled(act, act_style));
            }
            let fresh = matches!(card.kind, CardKind::Hosted(_)) && run.is_none();
            // A workspace named for what it is (a handoff, a worktree branch)
            // keeps that name until the agent has a title of its own.
            let ws_name = match card.kind {
                CardKind::Hosted(id) => self.workspaces.iter().find(|w| w.id == id).map(|w| w.name.clone()).filter(|n| !matches!(n.as_str(), "claude" | "codex" | "shell")),
                _ => None,
            };
            let title = if !title.is_empty() {
                title
            } else if let Some(n) = ws_name.filter(|_| fresh) {
                n
            } else if fresh {
                format!("new {} session", kind.map(|k| k.label()).unwrap_or("agent"))
            } else {
                "untitled".into()
            };
            if fresh && l2.len() == 1 {
                l2.push(Span::styled("waiting for your first prompt", t.faint()));
            }
            (title, l2)
        };
        let buf = f.buffer_mut();
        if sel {
            buf.set_style(r, Style::default().bg(t.sel));
            for dy in 0..r.height {
                put(buf, r.x, r.y + dy, "▌", Style::default().fg(t.accent), 1);
            }
        }
        put_line(buf, r.x + 1, r.y, &Line::from(state_dot(&t, card.state, tick)), 1);
        let when = run.as_ref().map(|r| r.updated).or_else(|| info.map(|i| i.mtime)).unwrap_or(0);
        let when = if card.state == RunState::Working || when <= 0 { String::new() } else { ago(now, when) };
        let ww = when.width() as u16;
        let tw = r.width.saturating_sub(5 + ww);
        let tstyle = match card.state {
            RunState::Closed => Style::default().fg(t.dim),
            _ => Style::default().fg(t.fg).add_modifier(Modifier::BOLD),
        };
        let marked = self.marks.contains(&card_id(card));
        if marked {
            put(buf, r.x + 3, r.y, "◆ ", Style::default().fg(t.accent2).add_modifier(Modifier::BOLD), 2);
            let tw = tw.saturating_sub(2);
            put(buf, r.x + 5, r.y, &trunc(&title, tw as usize), tstyle.fg(t.accent2), tw);
        } else {
            put(buf, r.x + 3, r.y, &trunc(&title, tw as usize), tstyle, tw);
        }
        put(buf, r.x + r.width.saturating_sub(ww), r.y, &when, t.faint(), ww);
        if r.height > 1 {
            let w = r.width.saturating_sub(4);
            put_line(buf, r.x + 3, r.y + 1, &fit_spans(line2, w as usize), w);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_detail(&mut self, f: &mut Frame, r: Rect, card: &Card, snap: &Snapshot, tick: u64, now: i64) {
        let t = self.theme.clone();
        if card.group == 3 {
            let CardKind::Hosted(id) = card.kind else { return };
            let Some(ws) = self.workspaces.iter().find(|w| w.id == id) else { return };
            let buf = f.buffer_mut();
            put_line(buf, r.x, r.y, &rule(&t, "terminal", "no agent running", r.width as usize, t.fg), r.width);
            let mut y = r.y + 2;
            for p in ws.layout.terms() {
                if let Some(p) = self.panes.get(&p) {
                    let what = if p.exited.is_some() { "exited".to_string() } else { p.title().map(String::from).unwrap_or_default() };
                    put(buf, r.x, y, &format!("{}   {}", rel_path(&p.cwd, ""), trunc(&what, 50)), t.dim(), r.width);
                    y += 1;
                }
            }
            put(buf, r.x, y + 1, "enter to switch to it", t.faint(), r.width);
            return;
        }
        let Some(key) = card.run.clone() else { return };
        let Some(run) = snap.runs.get(&key).cloned() else {
            let buf = f.buffer_mut();
            if matches!(card.kind, CardKind::Hosted(_)) {
                put_line(buf, r.x, r.y, &rule(&t, &format!("new {} session", key.kind.label()), "", r.width as usize, t.fg), r.width);
                put(buf, r.x, r.y + 2, "nothing to show until you send the first prompt.", t.dim(), r.width);
                put(buf, r.x, r.y + 3, "enter switches to it.", t.faint(), r.width);
            } else {
                let title = snap.sessions.get(&key).map(|i| i.title.clone()).filter(|s| !s.is_empty()).unwrap_or_else(|| "loading this session…".into());
                put(buf, r.x, r.y, &title, Style::default().fg(t.fg).add_modifier(Modifier::BOLD), r.width);
            }
            return;
        };
        let where_ = match card.kind {
            CardKind::Hosted(_) => "open in polypore · enter switches to it",
            CardKind::Observed(_) => "running in another terminal · enter watches it here",
            CardKind::Recent(_) => "closed · enter reads it · r resumes it in a terminal",
        };
        self.draw_header(f, r, &run, card.state, tick, now);
        if let CardKind::Hosted(id) = card.kind {
            if let Some(from) = self.origins.get(&id).cloned() {
                let title = snap.runs.get(&from).map(|r| self.title_of(r)).or_else(|| self.smeta.name(&from).map(String::from)).unwrap_or_else(|| short_id(&from.id).to_string());
                put(f.buffer_mut(), r.x + 9, r.y + 3, &format!("continues {}", trunc(&title, r.width.saturating_sub(20) as usize)), Style::default().fg(t.info), r.width.saturating_sub(9));
            }
        }
        // Near the limit: say that the other agent can carry on.
        let tight = self.quota.lock().unwrap().iter().find(|q| q.agent == key.kind).and_then(|q| {
            q.current(now).into_iter().filter(|w| w.used >= 90.0 || matches!(w.pace(now), crate::quota::Pace::RunsOut(_)) && w.used >= 70.0).map(|w| format!("{} {} at {:.0}%", q.agent.label(), w.name, w.used)).next()
        });
        if let Some(msg) = tight {
            let other = if key.kind == AgentKind::Claude { "codex" } else { "claude" };
            put(f.buffer_mut(), r.x + 9, r.y + 3, &format!("{msg} · < continues this in {other}"), Style::default().fg(t.warn), r.width.saturating_sub(9));
        }
        let body = Rect { y: r.y + 5, height: r.height.saturating_sub(7), ..r };
        self.draw_inspector(f, body, &run, card.state, InspectOpts { last_reply: true, in_focus: false, review_panel: false }, tick, now);
        put(f.buffer_mut(), r.x, r.y + r.height - 1, where_, t.faint(), r.width);
    }

    /// Animation, title and state: the three lines at the top of a detail
    /// panel or the inspector.
    fn draw_header(&mut self, f: &mut Frame, r: Rect, run: &AgentRun, state: RunState, tick: u64, now: i64) {
        let t = self.theme.clone();
        let acol = t.agent(Some(run.key.kind));
        let anim_name = self.cfg.agent(run.key.kind.label()).animation;
        let anim = self.anims.get(&anim_name).clone();
        let playing = state == RunState::Working;
        let frame = anim.frame(tick, playing);
        let astyle = if playing { Style::default().fg(acol) } else { Style::default().fg(acol).add_modifier(Modifier::DIM) };
        let buf = f.buffer_mut();
        let top = (3u16.saturating_sub(anim.height.min(3))) / 2;
        for (i, l) in frame.iter().enumerate().take(3) {
            put(buf, r.x, r.y + top + i as u16, l, astyle, anim.width);
        }
        let tx = r.x + anim.width.max(7) + 2;
        let tw = r.width.saturating_sub(tx - r.x);
        put(buf, tx, r.y, &trunc(&self.title_of(run), tw as usize), Style::default().fg(t.fg).add_modifier(Modifier::BOLD), tw);
        let mut meta = vec![
            Span::styled(state.label().to_string(), Style::default().fg(t.state(state)).add_modifier(Modifier::BOLD)),
            Span::styled(format!("   {}", run.key.kind.label()), Style::default().fg(acol)),
        ];
        if !run.model.is_empty() {
            meta.push(Span::styled(format!(" {}", short_model(&run.model)), t.dim()));
        }
        if state != RunState::Working {
            meta.push(Span::styled(format!("   {} ago", ago(now, run.updated)), t.faint()));
        }
        put_line(buf, tx, r.y + 1, &Line::from(meta), tw);
        let mut sub = Vec::new();
        if !run.branch.is_empty() {
            sub.push(format!("on {}", run.branch));
        }
        if run.turns > 0 {
            sub.push(plural(run.turns as usize, "prompt", "prompts"));
        }
        put(buf, tx, r.y + 2, &sub.join(" · "), t.faint(), tw);
    }

    // ---------- inspector ----------

    /// Everything worth knowing about a run that its own terminal does not
    /// show well, in priority order, each section only when it has content.
    #[allow(clippy::too_many_arguments)]
    fn draw_inspector(&mut self, f: &mut Frame, r: Rect, run: &AgentRun, state: RunState, opts: InspectOpts, tick: u64, now: i64) {
        let t = self.theme.clone();
        let w = r.width as usize;
        let mut y = r.y;
        let bottom = r.y + r.height;
        let mut lines: Vec<Line<'static>> = Vec::new();
        let act = run.activity(state);
        match state {
            RunState::NeedsInput => {
                for (i, l) in wrap(&act, w.saturating_sub(2)).into_iter().take(4).enumerate() {
                    lines.push(Line::from(vec![
                        Span::styled(if i == 0 { "● " } else { "  " }, Style::default().fg(t.warn)),
                        Span::styled(l, Style::default().fg(t.warn).add_modifier(Modifier::BOLD)),
                    ]));
                }
                lines.push(Line::from(Span::styled(if opts.in_focus { "  answer it in the terminal" } else { "  enter opens it so you can answer" }, t.faint())));
                lines.push(Line::from(""));
            }
            RunState::Working => {
                lines.push(Line::from(vec![
                    Span::styled(format!("{} ", spinner(tick)), Style::default().fg(t.accent)),
                    Span::styled(trunc(&act, w.saturating_sub(2)), Style::default().fg(t.fg)),
                ]));
                lines.push(Line::from(""));
            }
            _ => {}
        }
        let mut sections: Vec<Vec<Line<'static>>> = Vec::new();
        // plan
        if !run.tasks.is_empty() || !run.goal.is_empty() {
            let (done, total) = run.tasks_done();
            let mut s = vec![rule(&t, "plan", &if total > 0 { format!("{done} of {total} done") } else { String::new() }, w, t.accent2)];
            if !run.goal.is_empty() {
                s.push(Line::from(vec![Span::styled("goal  ", t.faint()), Span::styled(trunc(&run.goal, w.saturating_sub(6)), Style::default().fg(t.fg))]));
            }
            if done > 2 {
                s.push(Line::from(Span::styled(format!("✓ {done} done"), Style::default().fg(t.ok))));
            }
            let mut pending_shown = 0;
            let mut more = 0;
            for task in &run.tasks {
                match task.status {
                    TaskStatus::Done if done <= 2 => s.push(Line::from(vec![
                        Span::styled("✓ ", Style::default().fg(t.ok)),
                        Span::styled(trunc(&task.subject, w.saturating_sub(2)), Style::default().fg(t.dim).add_modifier(Modifier::CROSSED_OUT)),
                    ])),
                    TaskStatus::Done => {}
                    TaskStatus::InProgress => {
                        let label = if task.active.is_empty() { &task.subject } else { &task.active };
                        s.push(Line::from(vec![
                            Span::styled("▸ ", Style::default().fg(t.accent)),
                            Span::styled(trunc(label, w.saturating_sub(2)), Style::default().fg(t.fg).add_modifier(Modifier::BOLD)),
                        ]));
                    }
                    TaskStatus::Pending => {
                        if pending_shown < 4 {
                            s.push(Line::from(vec![Span::styled("○ ", t.faint()), Span::styled(trunc(&task.subject, w.saturating_sub(2)), Style::default().fg(t.dim))]));
                            pending_shown += 1;
                        } else {
                            more += 1;
                        }
                    }
                }
            }
            if more > 0 {
                s.push(Line::from(Span::styled(format!("  and {more} more"), t.faint())));
            }
            sections.push(s);
        }
        // changes this session made
        let root = crate::store::work_root(std::path::Path::new(&run.cwd)).unwrap_or(run.cwd.clone());
        let mut changed: Vec<&FileTouch> = run.files.values().filter(|f| f.edits + f.writes > 0).collect();
        changed.sort_by(|a, b| b.last.cmp(&a.last));
        let reads = run.files.values().filter(|f| f.edits + f.writes == 0).count();
        if !changed.is_empty() {
            let add: u32 = changed.iter().map(|f| f.added).sum();
            let del: u32 = changed.iter().map(|f| f.removed).sum();
            let mut s = vec![rule(&t, "changed", &format!("{}  {}", plural(changed.len(), "file", "files"), diff_text(add, del)), w, t.ok)];
            for ft in changed.iter().take(8) {
                let nums = diff_text(ft.added, ft.removed);
                let fresh = now - ft.last < 30_000;
                let pw = w.saturating_sub(nums.width() + 2);
                let name_style = if fresh { Style::default().fg(t.accent).add_modifier(Modifier::BOLD) } else { Style::default().fg(t.fg) };
                let mut row = path_spans(&t, &rel_path(&ft.path, &root), pw, name_style);
                let used: usize = row.iter().map(|s| s.width()).sum();
                row.push(Span::raw(" ".repeat(w.saturating_sub(used + nums.width()))));
                row.extend(diff_spans(&t, ft.added, ft.removed));
                s.push(Line::from(row));
            }
            if changed.len() > 8 {
                s.push(Line::from(Span::styled(format!("  and {} more", changed.len() - 8), t.faint())));
            }
            if reads > 0 {
                s.push(Line::from(Span::styled(format!("also read {}", plural(reads, "file", "files")), t.faint())));
            }
            sections.push(s);
        } else if reads > 0 {
            sections.push(vec![rule(&t, "changed", "nothing yet", w, t.ok), Line::from(Span::styled(format!("read {}", plural(reads, "file", "files")), t.faint()))]);
        }
        // problems
        let mut fails: Vec<(String, u32, i64)> = Vec::new();
        for c in run.cmds.iter().rev().take(40).filter(|c| c.ok == Some(false)) {
            let key = trunc(&c.cmd, 60);
            if let Some(e) = fails.iter_mut().find(|e| e.0 == key) {
                e.1 += 1;
            } else {
                fails.push((key, 1, c.ts));
            }
        }
        let api_errors: Vec<&Event> = run.errors.iter().rev().filter(|e| e.text.starts_with("api error")).take(2).collect();
        if !fails.is_empty() || !api_errors.is_empty() {
            let n: u32 = fails.iter().map(|f| f.1).sum();
            let mut s = vec![rule(&t, "problems", &format!("{} failed recently", plural(n as usize, "command", "commands")), w, t.err)];
            for (cmd, n, ts) in fails.iter().take(4) {
                let tail = if *n > 1 { format!("  {n}×") } else { format!("  {}", ago(now, *ts)) };
                s.push(Line::from(vec![
                    Span::styled("✗ ", Style::default().fg(t.err)),
                    Span::styled(trunc(cmd, w.saturating_sub(tail.width() + 2)), Style::default().fg(t.fg)),
                    Span::styled(tail, t.faint()),
                ]));
            }
            if let Some((_, n, _)) = fails.iter().find(|f| f.1 >= 3) {
                s.push(Line::from(Span::styled(format!("the same command failed {n} times; it may be going in circles"), Style::default().fg(t.warn))));
            }
            for e in api_errors {
                s.push(Line::from(vec![Span::styled("✗ ", Style::default().fg(t.err)), Span::styled(trunc(&e.text, w.saturating_sub(2)), Style::default().fg(t.fg))]));
            }
            sections.push(s);
        }
        // reviewer findings
        if let Some(rv) = self.reviews.lock().unwrap().get(&run.key).cloned().filter(|_| !opts.review_panel) {
            let meta = if rv.running { format!("reading {}", plural(rv.files, "file", "files")) } else if !rv.error.is_empty() { "failed".to_string() } else { format!("{} ago", ago(now, rv.finished)) };
            let mut s = vec![rule(&t, "review", &meta, w, t.info)];
            if rv.running {
                s.push(Line::from(vec![Span::styled(format!("{} ", spinner(tick)), Style::default().fg(t.accent)), Span::styled("a fresh-context reviewer is reading the diff", t.dim())]));
            } else if !rv.error.is_empty() {
                s.push(Line::from(Span::styled(trunc(&rv.error, w), Style::default().fg(t.err))));
            } else {
                let body = review_lines(&t, &rv.text, w);
                let n = body.len();
                s.extend(body.into_iter().take(5));
                if n > 5 {
                    s.push(Line::from(Span::styled("  the review panel has the rest", t.faint())));
                }
            }
            sections.push(s);
        }
        // subagents
        let running: Vec<&Subagent> = run.subagents.iter().filter(|s| !s.done).collect();
        if !running.is_empty() {
            let done = run.subagents.len() - running.len();
            let mut s = vec![rule(&t, "helpers", &format!("{} running{}", running.len(), if done > 0 { format!(", {done} finished") } else { String::new() }), w, t.info)];
            for a in running.iter().take(4) {
                s.push(Line::from(vec![
                    Span::styled(format!("{} ", spinner(tick)), Style::default().fg(t.accent)),
                    Span::styled(trunc(&a.desc, w.saturating_sub(a.kind.width() + 4)), Style::default().fg(t.fg)),
                    Span::styled(format!("  {}", a.kind), t.faint()),
                ]));
            }
            sections.push(s);
        }
        // web
        if !run.web.is_empty() {
            let mut domains: Vec<(String, u32)> = Vec::new();
            let mut searches = 0;
            for h in &run.web {
                if h.kind == WebKind::Search {
                    searches += 1;
                    continue;
                }
                let d = domain_of(&h.target);
                if let Some(e) = domains.iter_mut().find(|e| e.0 == d) {
                    e.1 += 1;
                } else {
                    domains.push((d, 1));
                }
            }
            domains.sort_by(|a, b| b.1.cmp(&a.1));
            let pages: u32 = domains.iter().map(|d| d.1).sum();
            let mut s = vec![rule(&t, "web", &format!("{} · {}", plural(searches, "search", "searches"), plural(pages as usize, "page", "pages")), w, t.info)];
            if let Some(q) = run.web.iter().rev().find(|h| h.kind == WebKind::Search) {
                s.push(Line::from(vec![Span::styled("searched  ", t.faint()), Span::styled(trunc(&q.target, w.saturating_sub(10)), Style::default().fg(t.accent2))]));
            }
            let list: Vec<String> = domains.iter().take(5).map(|(d, n)| if *n > 1 { format!("{d} {n}×") } else { d.clone() }).collect();
            if !list.is_empty() {
                for l in wrap(&list.join("   "), w.saturating_sub(10)).into_iter().take(2) {
                    s.push(Line::from(vec![Span::styled("read      ", t.faint()), Span::styled(l, Style::default().fg(t.info))]));
                }
            }
            sections.push(s);
        }
        // last reply (dash peek and read-only views)
        if opts.last_reply && state != RunState::Working && !run.last_reply.is_empty() {
            let mut s = vec![rule(&t, "last reply", run.key.kind.label(), w, t.agent(Some(run.key.kind)))];
            let full = run.events.iter().rev().find(|e| e.kind == EvKind::Reply).map(|e| plain(&e.text)).unwrap_or_else(|| plain(&run.last_reply));
            for l in wrap(&full, w.saturating_sub(2)).into_iter().take(6) {
                s.push(Line::from(vec![Span::styled("▎ ", Style::default().fg(t.agent(Some(run.key.kind)))), Span::styled(l, Style::default().fg(t.fg))]));
            }
            sections.push(s);
        }
        // footer: context and limits, pinned to the bottom
        let mut footer: Vec<Line<'static>> = Vec::new();
        let window = self.ctx_window(run);
        if run.ctx_tokens > 0 {
            let mut spans = vec![Span::styled("context  ", t.faint())];
            match run.ctx_percent_with(window) {
                Some(p) => {
                    let c = if p > 85.0 { t.err } else if p > 65.0 { t.warn } else { t.ok };
                    spans.extend(gauge(p / 100.0, 12, c, t.faint));
                    spans.push(Span::styled(format!(" {p:.0}% full"), Style::default().fg(c)));
                }
                None => spans.push(Span::styled(format!("{} tokens", fmt_tokens(run.ctx_tokens)), Style::default().fg(t.dim))),
            }
            if run.compactions > 0 {
                spans.push(Span::styled(format!(" · compacted {}×", run.compactions), t.faint()));
            }
            footer.push(Line::from(spans));
        }
        if let Some(q) = self.quota.lock().unwrap().iter().find(|q| q.agent == run.key.kind).cloned() {
            let cur = q.current(now);
            if !cur.is_empty() {
                let mut spans = vec![Span::styled("limits   ", t.faint())];
                for wd in cur {
                    let pace = wd.pace(now);
                    let short = matches!(pace, crate::quota::Pace::RunsOut(_));
                    let c = if wd.used > 85.0 || short { t.err } else if wd.used > 60.0 { t.warn } else { t.dim };
                    let tail = match pace {
                        crate::quota::Pace::RunsOut(ms) => format!(" · out in {}", crate::quota::span(ms)),
                        _ => format!(" · resets {}", crate::quota::span(wd.resets_at - now)),
                    };
                    spans.push(Span::styled(format!("{} {:.0}%{tail}   ", wd.name, wd.used), Style::default().fg(c)));
                }
                footer.push(Line::from(spans));
            }
        }
        if sections.is_empty() && lines.is_empty() {
            lines.push(Line::from(Span::styled("nothing to show yet: no plan, no changes, no problems.", t.faint())));
        }
        let footer_h = footer.len() as u16;
        let avail_bottom = bottom.saturating_sub(footer_h + if footer_h > 0 { 1 } else { 0 });
        let buf = f.buffer_mut();
        for l in &lines {
            if y >= avail_bottom {
                break;
            }
            put_line(buf, r.x, y, l, r.width);
            y += 1;
        }
        let mut hidden: Vec<String> = Vec::new();
        for s in sections {
            let label = s[0].spans.first().map(|sp| sp.content.to_string()).unwrap_or_default();
            let room = avail_bottom.saturating_sub(y) as usize;
            if room < 3 {
                hidden.push(label);
                continue;
            }
            let take = s.len().min(room.saturating_sub(1));
            for (i, l) in s.iter().take(take).enumerate() {
                if i == take - 1 && take < s.len() {
                    put_line(buf, r.x, y, &Line::from(Span::styled(format!("  and {} more", s.len() - take + 1), t.faint())), r.width);
                } else {
                    put_line(buf, r.x, y, l, r.width);
                }
                y += 1;
            }
            y += 1;
        }
        if !hidden.is_empty() && y < avail_bottom {
            put(buf, r.x, y, &format!("no room for {}", hidden.join(", ")), t.faint(), r.width);
        }
        let mut fy = bottom.saturating_sub(footer_h);
        for l in footer {
            put_line(buf, r.x, fy, &l, r.width);
            fy += 1;
        }
    }

    // ---------- focus ----------

    fn draw_focus(&mut self, f: &mut Frame, area: Rect, snap: &Snapshot) {
        let t = self.theme.clone();
        let Some(ws_id) = self.active_ws else {
            self.view = View::Dash;
            return;
        };
        let Some(ws) = self.workspaces.iter().find(|w| w.id == ws_id) else { return };
        let run_key = self.ws_run(ws);
        let run: Option<Arc<AgentRun>> = run_key.as_ref().and_then(|k| snap.runs.get(k).cloned());
        let show_comps = self.ws_has_agent(ws);
        let gx = t.gaps.min(1);
        // keys for focused component panes go to them, so a terminal is not needed
        let area = Rect { x: area.x + gx, width: area.width.saturating_sub(gx * 2), ..area };
        let (mut rects, handles) = ws.layout.compute(area, t.gaps, show_comps);
        if let Some(z) = ws.zoom {
            rects.retain(|(id, _)| *id == z);
            if let Some(r) = rects.first_mut() {
                r.1 = area;
            }
        }
        let focus = ws.focus;
        let observed = ws.observed.is_some();
        let leaves = ws.layout.leaves();
        self.leaf_rects = rects.clone();
        self.handles = if ws.zoom.is_some() { Vec::new() } else { handles };
        let mut cursor: Option<(u16, u16)> = None;
        let tick = self.tick_ms();
        let now = now_ms();
        let state = run.as_ref().map(|r| self.run_state(r, now)).unwrap_or(RunState::Ready);
        for (leaf, r) in rects {
            let Some(kind) = leaves.iter().find(|(i, _)| *i == leaf).map(|(_, k)| k.clone()) else { continue };
            let focused = focus == Some(leaf);
            self.hits.push((r, Hit::Leaf(leaf)));
            self.hits.push((Rect { height: 1, ..r }, Hit::LeafTitle(leaf)));
            match kind {
                LeafKind::Term(p) => {
                    let Some(pane) = self.panes.get(&p) else { continue };
                    let agent = pane.detected;
                    let name = agent.map(|a| a.label().to_string()).or_else(|| pane.fg.clone()).unwrap_or_else(|| "terminal".into());
                    let title = vec![
                        Span::styled(format!(" {name} "), Style::default().fg(t.agent(agent)).add_modifier(Modifier::BOLD)),
                        Span::styled(format!("{} ", trunc(&rel_path(&pane.cwd, ""), 40)), t.faint()),
                    ];
                    let mut right: Vec<Span> = Vec::new();
                    if agent.is_some() && !pane.scrubbed {
                        right.push(Span::styled(" can see your secrets ", Style::default().fg(t.warn)));
                    }
                    if pane.scroll > 0 {
                        right.push(Span::styled(format!(" scrolled up {} lines ", pane.scroll), Style::default().fg(t.info)));
                    }
                    if let Some(c) = pane.exited {
                        right.push(Span::styled(format!(" exited ({c}) · enter restarts "), Style::default().fg(t.err)));
                    }
                    let b = frame_block(&t, Line::from(title), focused).title_top(Line::from(right).right_aligned());
                    let ir = inner(&t, r);
                    f.render_widget(b, r);
                    if let Some(pane) = self.panes.get_mut(&p) {
                        pane.resize(ir.height, ir.width);
                        let c = pane.render(ir, f.buffer_mut(), false);
                        if focused {
                            cursor = c;
                        }
                    }
                }
                LeafKind::Comp(c) => {
                    let scroll = self.leaf_scroll.get(&leaf).copied().unwrap_or(0);
                    let mut title = vec![Span::styled(format!(" {} ", c.label()), Style::default().fg(if focused { t.accent } else { t.dim }).add_modifier(Modifier::BOLD))];
                    if observed && c == Comp::Activity {
                        title.push(Span::styled("read-only · r resumes it in a terminal ", Style::default().fg(t.info)));
                    }
                    let b = frame_block(&t, Line::from(title), focused);
                    let ir = pad_rect(inner(&t, r), 1, 0);
                    f.render_widget(b, r);
                    match &run {
                        _ if c == Comp::Files => {
                            let body = ir;
                            self.draw_files(f, body, leaf, run.as_deref(), focused);
                        }
                        _ if c == Comp::Diff => self.draw_diff(f, ir, leaf, run.as_deref(), focused),
                        Some(run) if c == Comp::Review => self.draw_review(f, ir, run, scroll, tick, now),
                        Some(run) if c == Comp::Inspector => {
                            let body = Rect { y: ir.y + 1, height: ir.height.saturating_sub(1), ..ir };
                            self.draw_header(f, body, run, state, tick, now);
                            let rest = Rect { y: body.y + 4, height: body.height.saturating_sub(4), ..body };
                            let review_panel = leaves.iter().any(|(_, k)| *k == LeafKind::Comp(Comp::Review));
                            self.draw_inspector(f, rest, run, state, InspectOpts { last_reply: observed, in_focus: true, review_panel }, tick, now);
                        }
                        Some(run) => self.draw_comp(f, ir, c, run, scroll, now),
                        None => put(f.buffer_mut(), ir.x, ir.y + 1, "fills in after the first prompt", t.faint(), ir.width),
                    }
                }
            }
        }
        if let Some((x, y)) = cursor {
            if self.overlay.is_none() {
                f.set_cursor_position((x, y));
            }
        }
    }

    /// Single-purpose panels for people who want them as separate panes.
    fn draw_comp(&mut self, f: &mut Frame, r: Rect, c: Comp, run: &AgentRun, scroll: u16, now: i64) {
        let t = self.theme.clone();
        let w = r.width as usize;
        let mut lines: Vec<Line<'static>> = Vec::new();
        let root = crate::store::work_root(std::path::Path::new(&run.cwd)).unwrap_or(run.cwd.clone());
        match c {
            Comp::Inspector => {}
            Comp::Tasks => {
                for task in &run.tasks {
                    let (icon, st) = match task.status {
                        TaskStatus::Done => ("✓ ", Style::default().fg(t.dim).add_modifier(Modifier::CROSSED_OUT)),
                        TaskStatus::InProgress => ("▸ ", Style::default().fg(t.fg).add_modifier(Modifier::BOLD)),
                        TaskStatus::Pending => ("○ ", Style::default().fg(t.fg)),
                    };
                    lines.push(Line::from(vec![Span::styled(icon, Style::default().fg(t.accent)), Span::styled(trunc(&task.subject, w.saturating_sub(2)), st)]));
                }
                if lines.is_empty() {
                    lines.push(Line::from(Span::styled("no plan yet", t.faint())));
                }
            }
            Comp::Files => {
                for ft in run.recent_files(400) {
                    let tag = if ft.edits + ft.writes > 0 { format!("+{} −{}", ft.added, ft.removed) } else { "read".to_string() };
                    let pw = w.saturating_sub(tag.width() + 1);
                    let mut row = path_spans(&t, &rel_path(&ft.path, &root), pw, Style::default().fg(if ft.edits + ft.writes > 0 { t.fg } else { t.dim }));
                    let used: usize = row.iter().map(|s| s.width()).sum();
                    row.push(Span::raw(" ".repeat(w.saturating_sub(used + tag.width()))));
                    row.push(Span::styled(tag, t.faint()));
                    lines.push(Line::from(row));
                }
            }
            Comp::Activity => {
                // A conversation, grouped into turns: your prompt with the
                // time you sent it, then the agent's work with how long it took.
                let agent = run.key.kind.label();
                let acol = t.agent(Some(run.key.kind));
                let bar = |c: Color| Span::styled("▎ ", Style::default().fg(c));
                let mut turns: Vec<(Option<&Event>, Vec<&Event>)> = Vec::new();
                for e in run.events.iter() {
                    match e.kind {
                        EvKind::Prompt => turns.push((Some(e), Vec::new())),
                        EvKind::Thinking => {}
                        _ => {
                            if turns.is_empty() {
                                turns.push((None, Vec::new()));
                            }
                            turns.last_mut().unwrap().1.push(e);
                        }
                    }
                }
                let today = chrono::Local::now().date_naive();
                let clock = |ts: i64| -> String {
                    chrono::DateTime::from_timestamp_millis(ts)
                        .map(|d| {
                            let d = d.with_timezone(&chrono::Local);
                            if d.date_naive() == today { d.format("%H:%M").to_string() } else { d.format("%b %-d %H:%M").to_string() }
                        })
                        .unwrap_or_default()
                };
                let took = |ms: i64| -> String {
                    let s = (ms / 1000).max(0);
                    if s < 60 { format!("{s}s") } else if s < 3600 { format!("{}m {:02}s", s / 60, s % 60) } else { format!("{}h {:02}m", s / 3600, (s % 3600) / 60) }
                };
                let n_turns = turns.len();
                for (ti, (prompt, items)) in turns.iter().enumerate() {
                    if let Some(p) = prompt {
                        lines.push(Line::from(""));
                        lines.push(Line::from(vec![
                            Span::styled("you", Style::default().fg(t.accent).add_modifier(Modifier::BOLD)),
                            Span::styled(format!("  {}", clock(p.ts)), t.faint()),
                        ]));
                        for l in wrap(&p.text, w.saturating_sub(2)).into_iter().take(8) {
                            lines.push(Line::from(vec![bar(t.accent), Span::styled(l, Style::default().fg(t.accent))]));
                        }
                    }
                    if items.is_empty() {
                        continue;
                    }
                    let start = prompt.map(|p| p.ts).unwrap_or_else(|| items[0].ts);
                    let end = items.last().map(|e| e.ts).unwrap_or(start);
                    let live = ti + 1 == n_turns && run.turn_open;
                    let steps = items.iter().filter(|e| e.kind == EvKind::Tool).count();
                    let mut head = vec![Span::styled(agent.to_string(), Style::default().fg(acol).add_modifier(Modifier::BOLD))];
                    let meta = match (live, steps) {
                        (true, _) => format!("  working for {}", took(now - start)),
                        (false, 0) => format!("  took {}", took(end - start)),
                        (false, n) => format!("  took {} · {}", took(end - start), plural(n, "step", "steps")),
                    };
                    head.push(Span::styled(meta, t.faint()));
                    lines.push(Line::from(""));
                    lines.push(Line::from(head));
                    for e in items {
                        match e.kind {
                            EvKind::Reply => {
                                for l in wrap(&plain(&e.text), w.saturating_sub(2)).into_iter().take(12) {
                                    lines.push(Line::from(vec![bar(acol), Span::styled(l, Style::default().fg(t.fg))]));
                                }
                            }
                            EvKind::Tool => lines.push(Line::from(vec![bar(t.faint), Span::styled(trunc(&e.text, w.saturating_sub(2)), t.faint())])),
                            EvKind::Error => lines.push(Line::from(vec![bar(t.err), Span::styled(trunc(&e.text, w.saturating_sub(2)), Style::default().fg(t.err))])),
                            _ => lines.push(Line::from(vec![bar(t.faint), Span::styled("context compacted", t.faint())])),
                        }
                    }
                }
                let h = r.height as usize;
                let end = lines.len().saturating_sub(scroll as usize).max(h.min(lines.len()));
                let start = end.saturating_sub(h);
                let buf = f.buffer_mut();
                for (i, l) in lines[start..end].iter().enumerate() {
                    put_line(buf, r.x, r.y + i as u16, l, r.width);
                }
                return;
            }
            Comp::Web => {
                for h in run.web.iter().rev() {
                    let (k, text) = match h.kind {
                        WebKind::Search => ("searched", h.target.clone()),
                        WebKind::Fetch => ("read", format!("{}{}", domain_of(&h.target), path_of_url(&h.target))),
                        WebKind::Browse => ("browsed", format!("{}{}", domain_of(&h.target), path_of_url(&h.target))),
                    };
                    lines.push(Line::from(vec![
                        Span::styled(format!("{k:<9}"), t.faint()),
                        Span::styled(trunc(&text, w.saturating_sub(14)), Style::default().fg(t.fg)),
                        Span::styled(format!(" {:>4}", ago(now, h.ts)), t.faint()),
                    ]));
                }
            }
            Comp::Commands => {
                for cmd in run.cmds.iter().rev() {
                    let (icon, col) = match cmd.ok {
                        Some(true) => ("✓ ", t.ok),
                        Some(false) => ("✗ ", t.err),
                        None => ("… ", t.accent),
                    };
                    let text = if cmd.background { format!("{} (in background)", cmd.cmd) } else { cmd.cmd.clone() };
                    lines.push(Line::from(vec![Span::styled(icon, Style::default().fg(col)), Span::styled(trunc(&text, w.saturating_sub(2)), Style::default().fg(t.fg))]));
                    if !cmd.desc.is_empty() {
                        lines.push(Line::from(Span::styled(format!("  {}", trunc(&cmd.desc.to_lowercase(), w.saturating_sub(2))), t.faint())));
                    }
                }
            }
            Comp::Subagents => {
                for a in run.subagents.iter().rev() {
                    let (icon, col) = if !a.done { ("… ", t.accent) } else if a.ok { ("✓ ", t.ok) } else { ("✗ ", t.err) };
                    lines.push(Line::from(vec![
                        Span::styled(icon, Style::default().fg(col)),
                        Span::styled(trunc(&a.desc, w.saturating_sub(a.kind.width() + 9)), Style::default().fg(t.fg)),
                        Span::styled(format!("  {} {}", a.kind, ago(now, a.ts)), t.faint()),
                    ]));
                }
            }
            Comp::Usage => {
                let window = self.ctx_window(run);
                let kv = |k: &str, v: String| Line::from(vec![Span::styled(format!("{k:<10}"), t.faint()), Span::styled(v, Style::default().fg(t.fg))]);
                lines.push(kv(
                    "context",
                    match run.ctx_percent_with(window) {
                        Some(p) => format!("{p:.0}% of {}", fmt_tokens(window)),
                        None => format!("{} tokens", fmt_tokens(run.ctx_tokens)),
                    },
                ));
                lines.push(kv("tokens", format!("{} in · {} out · {} cached", fmt_tokens(run.tokens_in), fmt_tokens(run.tokens_out), fmt_tokens(run.tokens_cache_read))));
                if run.cost_usd > 0.0 {
                    lines.push(kv("api cost", format!("${:.2} at api prices", run.cost_usd)));
                }
                let avg = if run.turns > 0 { run.turn_ms_total as f64 / run.turns as f64 / 1000.0 } else { 0.0 };
                lines.push(kv("prompts", format!("{} · {:.0}s per turn · compacted {}×", run.turns, avg, run.compactions)));
                let quota = self.quota.lock().unwrap().iter().find(|q| q.agent == run.key.kind).cloned();
                if let Some(q) = quota {
                    if !q.plan.is_empty() {
                        lines.push(kv("plan", q.plan.clone()));
                    }
                    for wd in q.current(now) {
                        let pace = match wd.pace(now) {
                            crate::quota::Pace::RunsOut(ms) => format!(" · runs out in {} at this pace", crate::quota::span(ms)),
                            crate::quota::Pace::Fine => " · lasts until then at this pace".into(),
                            crate::quota::Pace::Unknown => String::new(),
                        };
                        lines.push(kv("limit", format!("{} {:.0}% used, resets in {}{pace}", wd.name, wd.used, crate::quota::span(wd.resets_at - now))));
                    }
                    lines.push(kv("measured", format!("{} ago, from {}", ago(now, q.fetched), q.source)));
                }
            }
            Comp::Errors => {
                for e in run.errors.iter().rev() {
                    lines.push(Line::from(vec![Span::styled(format!("{:>4} ", ago(now, e.ts)), t.faint()), Span::styled(trunc(&e.text, w.saturating_sub(5)), Style::default().fg(t.err))]));
                }
            }
            Comp::Diff | Comp::Review => {}
        }
        if lines.is_empty() {
            lines.push(Line::from(Span::styled("nothing yet", t.faint())));
        }
        let buf = f.buffer_mut();
        for (i, l) in lines.iter().skip(scroll as usize).take(r.height as usize).enumerate() {
            put_line(buf, r.x, r.y + i as u16, l, r.width);
        }
    }

    /// The working tree's changes as hunks (lazygit style). The selected
    /// hunk is marked; space stages, d reverts, enter opens the editor.
    fn draw_diff(&mut self, f: &mut Frame, r: Rect, leaf: u64, run: Option<&AgentRun>, focused: bool) {
        let t = self.theme.clone();
        let (_root, files, items, only) = self.diff_rows(leaf, run);
        let sel = self.diff_views.get(&leaf).map(|v| v.sel).unwrap_or(0);
        let w = r.width as usize;
        let shown: Vec<&crate::hunks::FileDiff> = items.iter().filter_map(|i| if let crate::hunks::Item::File(fi) = i { files.get(*fi) } else { None }).collect();
        let add: u32 = shown.iter().map(|f| f.added()).sum();
        let del: u32 = shown.iter().map(|f| f.removed()).sum();
        let meta = format!("{}{}  {}", if only.is_some() { "this session · " } else { "" }, plural(shown.len(), "file", "files"), diff_text(add, del));
        let buf = f.buffer_mut();
        put_line(buf, r.x, r.y, &rule(&t, "changes", &meta, w, t.ok), r.width);
        if items.is_empty() {
            put(buf, r.x, r.y + 2, "nothing uncommitted. the working tree matches HEAD.", t.faint(), r.width);
            return;
        }
        let mut lines: Vec<Line<'static>> = Vec::new();
        let mut sel_at = 0usize;
        let mut hunk_no = 0usize;
        for it in &items {
            match it {
                crate::hunks::Item::File(fi) => {
                    let fd = &files[*fi];
                    let tag = if fd.untracked { "new" } else if fd.staged { "staged" } else { "" };
                    let nums = diff_text(fd.added(), fd.removed());
                    let pw = w.saturating_sub(nums.width() + tag.width() + 3);
                    let mut row = path_spans(&t, &fd.path, pw, Style::default().fg(t.fg).add_modifier(Modifier::BOLD));
                    let used: usize = row.iter().map(|s| s.width()).sum();
                    row.push(Span::raw(" ".repeat(w.saturating_sub(used + nums.width() + tag.width() + 1))));
                    row.push(Span::styled(format!("{tag} "), Style::default().fg(if fd.staged { t.ok } else { t.info })));
                    row.extend(diff_spans(&t, fd.added(), fd.removed()));
                    if !lines.is_empty() {
                        lines.push(Line::from(""));
                    }
                    lines.push(Line::from(row));
                }
                crate::hunks::Item::Hunk(fi, hi) => {
                    let h = &files[*fi].hunks[*hi];
                    let is_sel = hunk_no == sel;
                    if is_sel {
                        sel_at = lines.len();
                    }
                    hunk_no += 1;
                    let bar = if is_sel { Span::styled("▌", Style::default().fg(t.accent)) } else { Span::raw(" ") };
                    lines.push(Line::from(vec![
                        bar.clone(),
                        Span::styled(trunc(&h.header, w.saturating_sub(1)), if is_sel { Style::default().fg(t.accent).add_modifier(Modifier::BOLD) } else { t.faint() }),
                    ]));
                    for l in &h.lines {
                        let (col, body) = match l.chars().next() {
                            Some('+') => (t.ok, l.as_str()),
                            Some('-') => (t.err, l.as_str()),
                            Some('\\') => (t.faint, l.as_str()),
                            _ => (t.dim, l.as_str()),
                        };
                        let body = body.replace('\t', "    ");
                        lines.push(Line::from(vec![bar.clone(), Span::styled(trunc(&body, w.saturating_sub(1)), Style::default().fg(col))]));
                    }
                }
            }
        }
        let hint_h = if focused { 1 } else { 0 };
        let body = Rect { y: r.y + 2, height: r.height.saturating_sub(2 + hint_h), ..r };
        let h = body.height as usize;
        let offset = sel_at.saturating_sub(h / 4).min(lines.len().saturating_sub(h));
        let buf = f.buffer_mut();
        for (i, l) in lines.iter().skip(offset).take(h).enumerate() {
            put_line(buf, body.x, body.y + i as u16, l, body.width);
        }
        if focused {
            let hint = format!("j k hunk · space stage · d revert · enter edit · a {}", if only.is_some() { "everything" } else { "session only" });
            put(buf, r.x, r.y + r.height - 1, &trunc(&hint, w), t.faint(), r.width);
        }
    }

    /// The reviewer's findings for this session.
    fn draw_review(&mut self, f: &mut Frame, r: Rect, run: &AgentRun, scroll: u16, tick: u64, now: i64) {
        let t = self.theme.clone();
        let w = r.width as usize;
        let review = self.reviews.lock().unwrap().get(&run.key).cloned();
        let buf = f.buffer_mut();
        let Some(rv) = review else {
            put_line(buf, r.x, r.y, &rule(&t, "findings", "", w, t.info), r.width);
            put(buf, r.x, r.y + 2, "no review yet. R on the session list starts one.", t.faint(), r.width);
            return;
        };
        let meta = if rv.running { format!("{} · {}s", plural(rv.files, "file", "files"), (now - rv.started) / 1000) } else { format!("{} ago", ago(now, rv.finished)) };
        put_line(buf, r.x, r.y, &rule(&t, "findings", &meta, w, t.info), r.width);
        let mut lines: Vec<Line<'static>> = Vec::new();
        if rv.running {
            lines.push(Line::from(vec![Span::styled(format!("{} ", spinner(tick)), Style::default().fg(t.accent)), Span::styled("a fresh-context reviewer is reading the diff", Style::default().fg(t.fg))]));
        }
        if !rv.error.is_empty() {
            lines.push(Line::from(Span::styled(format!("review failed: {}", rv.error), Style::default().fg(t.err))));
        }
        lines.extend(review_lines(&t, &rv.text, w));
        if let Some(p) = &rv.path {
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled(format!("saved in {}", crate::config::display_path(p)), t.faint())));
        }
        let body = Rect { y: r.y + 2, height: r.height.saturating_sub(2), ..r };
        for (i, l) in lines.iter().skip(scroll as usize).take(body.height as usize).enumerate() {
            put_line(buf, body.x, body.y + i as u16, l, body.width);
        }
    }

    // ---------- skills ----------

    fn draw_skills(&mut self, f: &mut Frame, area: Rect) {
        let t = self.theme.clone();
        let (src, targets) = self.skill_dirs();
        let a = pad_rect(area, 2, 1);
        let w = a.width as usize;
        let buf = f.buffer_mut();
        put_line(buf, a.x, a.y, &rule(&t, "skills", &format!("{} found", self.skills.len()), w, t.accent2), a.width);
        put(
            buf,
            a.x,
            a.y + 1,
            &format!("one folder, linked into every agent: {}{}", crate::config::display_path(&src), if src.is_dir() { "" } else { " (made when you adopt or add a skill)" }),
            t.faint(),
            a.width,
        );
        let labels: Vec<String> = targets.iter().map(|p| crate::skills::target_label(p)).collect();
        let longest = self.skills.iter().map(|s| s.name.width()).max().unwrap_or(5);
        let name_w = (longest + 2).clamp(12, w / 3);
        let col_w = 11u16;
        let hy = a.y + 3;
        put(buf, a.x + 2, hy, "skill", t.faint(), name_w as u16);
        let mut x = a.x + 2 + name_w as u16;
        for l in &labels {
            put(buf, x, hy, l, t.faint(), col_w);
            x += col_w;
        }
        put(buf, x, hy, "used", t.faint(), 7);
        put(buf, x + 7, hy, "what it does", t.faint(), 20);
        let log_h = self.skills_log.len().min(4) as u16;
        let list_h = a.height.saturating_sub(5 + log_h) as usize;
        let offset = if self.skills_sel >= list_h { self.skills_sel + 1 - list_h } else { 0 };
        let loading = self.skills_usage.lock().unwrap().is_none();
        for (row, s) in self.skills.iter().enumerate().skip(offset).take(list_h) {
            let y = hy + 1 + (row - offset) as u16;
            if row == self.skills_sel {
                buf.set_style(Rect { x: a.x, y, width: a.width, height: 1 }, Style::default().bg(t.sel));
                put(buf, a.x, y, "▌", Style::default().fg(t.accent), 1);
            }
            put(buf, a.x + 2, y, &trunc(&s.name, name_w - 1), Style::default().fg(t.fg).add_modifier(Modifier::BOLD), name_w as u16);
            let mut x = a.x + 2 + name_w as u16;
            for l in &labels {
                let (txt, col) = match s.installs.get(l) {
                    Some((st, _)) => match st {
                        Status::Synced => ("linked", t.ok),
                        Status::CopySame => ("copy", t.dim),
                        Status::Drift => ("differs", t.warn),
                        Status::Unmanaged => ("local", t.dim),
                        Status::External => ("external", t.info),
                        Status::Broken => ("broken", t.err),
                        Status::Missing => ("missing", t.warn),
                        Status::Vendor => ("claude.ai", t.info),
                    },
                    None => ("·", t.faint),
                };
                put(buf, x, y, txt, Style::default().fg(col), col_w);
                x += col_w;
            }
            let uses = if loading && s.uses == 0 { "…".to_string() } else if s.uses == 0 { "never".into() } else { format!("{}×", s.uses) };
            put(buf, x, y, &uses, Style::default().fg(if s.uses > 0 { t.accent2 } else { t.faint }), 7);
            let dw = a.width.saturating_sub(x + 7 - a.x);
            put(buf, x + 7, y, &trunc(&s.description, dw as usize), t.dim(), dw);
            self.hits.push((Rect { x: a.x, y, width: a.width, height: 1 }, Hit::Row(row)));
        }
        let ly = a.y + a.height - log_h;
        for (i, l) in self.skills_log.iter().rev().take(log_h as usize).enumerate() {
            put(buf, a.x, ly + i as u16, l, t.dim(), a.width);
        }
    }

    // ---------- secrets ----------

    fn draw_secrets(&mut self, f: &mut Frame, area: Rect) {
        let t = self.theme.clone();
        let a = pad_rect(area, 2, 1);
        let w = a.width as usize;
        let buf = f.buffer_mut();
        let Some(root) = self.project.clone() else {
            put_line(buf, a.x, a.y, &rule(&t, "secrets", "", w, t.accent2), a.width);
            put(buf, a.x, a.y + 2, "pick a project first. secrets belong to a project.", t.dim(), a.width);
            return;
        };
        put_line(buf, a.x, a.y, &rule(&t, "secrets", &proj_name(&root), w, t.accent2), a.width);
        let mut y = a.y + 2;
        for l in [
            "agents started from polypore never see these values. your own terminals do.",
            "agents use them through the polypore-secrets tools, and you approve each new use.",
            "any program running as you can still read the keyring: a guard rail, not a vault.",
        ] {
            put(buf, a.x, y, l, t.faint(), a.width);
            y += 1;
        }
        y += 1;
        if !self.env_keys.is_empty() {
            let files: Vec<String> = self.env_keys.iter().map(|(p, k)| format!("{} ({} keys)", p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), k.len())).collect();
            put(buf, a.x, y, &format!("● plain-text secrets on disk: {}. i moves them into the keyring.", files.join(", ")), Style::default().fg(t.warn).add_modifier(Modifier::BOLD), a.width);
            y += 2;
        }
        put_line(buf, a.x, y, &rule(&t, "in the keyring", &self.secrets_list.len().to_string(), w, t.accent2), a.width);
        y += 1;
        if self.secrets_list.is_empty() {
            put(buf, a.x, y, "none yet. a adds one.", t.faint(), a.width);
        }
        let log_n = self.secrets_log.len().min(6) as u16;
        for (i, s) in self.secrets_list.iter().enumerate() {
            if y >= a.y + a.height.saturating_sub(log_n + 1) {
                break;
            }
            if i == self.secrets_sel {
                buf.set_style(Rect { x: a.x, y, width: a.width, height: 1 }, Style::default().bg(t.sel));
                put(buf, a.x, y, "▌", Style::default().fg(t.accent), 1);
            }
            put(buf, a.x + 2, y, &trunc(&s.name, 28), Style::default().fg(t.fg).add_modifier(Modifier::BOLD), 28);
            let allow = if s.allow.is_empty() && s.hosts.is_empty() {
                "no approved uses yet".to_string()
            } else {
                let mut v = s.allow.clone();
                v.extend(s.hosts.iter().cloned());
                format!("approved for {}", v.join(", "))
            };
            put(buf, a.x + 31, y, &allow, t.dim(), a.width.saturating_sub(31));
            self.hits.push((Rect { x: a.x, y, width: a.width, height: 1 }, Hit::Row(i)));
            y += 1;
        }
        let ly = a.y + a.height - log_n;
        for (i, l) in self.secrets_log.iter().take(6).enumerate() {
            put(buf, a.x, ly + i as u16, l, t.dim(), a.width);
        }
    }

    // ---------- overlays ----------

    fn draw_overlay(&mut self, f: &mut Frame, area: Rect) {
        let t = self.theme.clone();
        let Some(ov) = &self.overlay else { return };
        let bt = t.border.unwrap_or(ratatui::widgets::BorderType::Rounded);
        let frame = |title: &str| {
            Block::default()
                .borders(Borders::ALL)
                .border_type(bt)
                .border_style(Style::default().fg(t.accent))
                .title(Line::from(Span::styled(format!(" {title} "), Style::default().fg(t.accent).add_modifier(Modifier::BOLD))))
        };
        match ov {
            Overlay::Help => {
                let k = |s: &str| self.key_label(s);
                let sec = |s: &str| Line::from(Span::styled(s.to_string(), Style::default().fg(t.accent2).add_modifier(Modifier::BOLD)));
                let row = |key: String, v: &str| Line::from(vec![Span::styled(format!("  {key:<20}"), Style::default().fg(t.accent)), Span::styled(v.to_string(), Style::default().fg(t.fg))]);
                let left = vec![
                    sec("every list"),
                    row("j k  g G".into(), "move · top, bottom"),
                    row("enter  esc".into(), "open · back"),
                    row("/".into(), "filter this list"),
                    row("s  :".into(), "search transcripts · command line"),
                    row("c  x  n".into(), "new claude, codex, terminal"),
                    row("!".into(), "next session waiting for you"),
                    row("S  T".into(), "stay awake on/off · next theme"),
                    row("q".into(), if self.server.is_some() { "quit (terminals keep running)" } else { "quit" }),
                    Line::from(""),
                    sec("projects"),
                    row("p  H  a  .".into(), "pin · hide · add a folder · hidden"),
                    Line::from(""),
                    sec("sessions"),
                    row("i".into(), "prompt it without opening it"),
                    row("r".into(), "resume a closed session"),
                    row("f".into(), "show needs you, working, ready…"),
                    row("space  esc".into(), "mark for i r A d · clear marks"),
                    row("e  A".into(), "rename · archive"),
                    row("F  >  <".into(), "fork · hand off · to the other agent"),
                    row("y then r i c t l f p".into(), "copy resume cmd, id, folder, title…"),
                    row("w  W".into(), "claude, codex on a new worktree"),
                    row("R  D".into(), "review its diff · stage its hunks"),
                    row("d".into(), "close (asks about a worktree)"),
                ];
                let mut right = vec![
                    sec(&format!("in a session (keys go to the terminal{})", if self.alt_mode { " but alt" } else { " but the prefix" })),
                    row(k("q"), "back to the session list"),
                    row(k("h j k l"), "move between panes"),
                    row(k("H J K L"), "swap with the pane there"),
                    row(if self.alt_mode { "alt-shift-arrows".into() } else { k("< > - +") }, "resize"),
                    row(format!("{} {} {}", k("n"), k("c"), k("x")), "split: terminal, claude, codex"),
                    row(format!("{} {} {}", k("a"), k("w"), k("W")), "add panel · close pane · session"),
                    row(format!("{} {}", k("z"), k("o")), "zoom · turn the split around"),
                    row(if self.alt_mode { "alt-pgup alt-pgdn".into() } else { k("[ ]") }, "previous / next open session"),
                    row(format!("{} {}", k("g"), k("s")), "next waiting · stay awake"),
                    row(k(":"), "command line"),
                    Line::from(""),
                    sec("diff panel"),
                    row("j k  space".into(), "hunks · stage or unstage"),
                    row("d  enter".into(), "revert the hunk · edit at line"),
                    row("a".into(), "this session's files / everything"),
                    Line::from(""),
                    sec("from any shell"),
                    row("polypore ls".into(), "open sessions (--json, --all)"),
                    row("polypore send".into(), "type a prompt into one"),
                    row("polypore watch".into(), "a line per state change"),
                    Line::from(""),
                    sec("mouse"),
                    row("click, again".into(), "select, then open"),
                    row("drag gap · title".into(), "resize · swap panes"),
                ];
                if !self.alt_mode {
                    right.insert(1, row(format!("{} twice", crate::keys::chord_label(&self.cfg.keys.prefix)), "send the prefix key itself"));
                }
                let two = area.width >= 124;
                let (w, h) = if two { (124u16, left.len().max(right.len()) as u16 + 2) } else { (62u16, (left.len() + right.len() + 1) as u16 + 2) };
                let r = centered(area, w, h.min(area.height));
                f.render_widget(Clear, r);
                f.render_widget(frame("keys · esc closes"), r);
                let ir = inner(&t, r);
                if two {
                    let half = ir.width / 2;
                    f.render_widget(Paragraph::new(left), Rect { x: ir.x + 1, width: half - 2, ..ir });
                    f.render_widget(Paragraph::new(right), Rect { x: ir.x + half, width: ir.width - half, ..ir });
                } else {
                    let mut all = left;
                    all.push(Line::from(""));
                    all.extend(right);
                    f.render_widget(Paragraph::new(all), ir);
                }
            }
            Overlay::Search { query, sel } => {
                let r = Rect { x: area.x + 2, y: area.y + 1, width: area.width.saturating_sub(4), height: area.height.saturating_sub(2) };
                f.render_widget(Clear, Rect { y: area.y + 1, height: area.height.saturating_sub(2), ..area });
                let now = now_ms();
                let building = self.search.lock().unwrap().building;
                let (hits, docs, status) = {
                    let idx = self.search.lock().unwrap();
                    let hits = crate::search::query(&idx.docs, query, now, 200);
                    let docs: Vec<crate::search::Doc> = hits.iter().filter_map(|h| idx.docs.get(h.doc).cloned()).collect();
                    let status = if idx.building {
                        format!("reading transcripts {} of {}", idx.done, idx.total)
                    } else {
                        format!("{} in {}", plural(hits.len(), "match", "matches"), plural(idx.docs.len(), "session", "sessions"))
                    };
                    (hits, docs, status)
                };
                self.search_hits = hits.clone();
                f.render_widget(frame("search every transcript · enter opens · ctrl-r resumes · esc"), r);
                let ir = pad_rect(inner(&t, r), 1, 0);
                let buf = f.buffer_mut();
                put_line(buf, ir.x, ir.y, &Line::from(vec![Span::styled("❯ ", Style::default().fg(t.accent)), Span::styled(query.clone(), Style::default().fg(t.fg).add_modifier(Modifier::BOLD))]), ir.width);
                let sw = status.width() as u16;
                put(buf, ir.x + ir.width.saturating_sub(sw), ir.y, &status, t.faint(), sw);
                let cursor = (ir.x + 2 + query.width() as u16, ir.y);
                let wide = ir.width >= 100;
                let list_w = if wide { ir.width * 45 / 100 } else { ir.width };
                let list = Rect { x: ir.x, y: ir.y + 2, width: list_w, height: ir.height.saturating_sub(2) };
                let rows = (list.height / 2) as usize;
                let offset = sel.saturating_sub(rows.saturating_sub(1));
                let terms: Vec<String> = query.split_whitespace().map(|q| q.to_lowercase()).collect();
                for (i, d) in docs.iter().enumerate().skip(offset).take(rows) {
                    let y = list.y + ((i - offset) * 2) as u16;
                    let selected = i == *sel;
                    if selected {
                        buf.set_style(Rect { x: list.x, y, width: list.width, height: 2 }, Style::default().bg(t.sel));
                        put(buf, list.x, y, "▌", Style::default().fg(t.accent), 1);
                        put(buf, list.x, y + 1, "▌", Style::default().fg(t.accent), 1);
                    }
                    let title = self.smeta.name(&d.key).map(String::from).unwrap_or_else(|| d.title.clone());
                    let when = ago(now, d.mtime);
                    let tw = list.width.saturating_sub(4 + when.width() as u16);
                    put(buf, list.x + 2, y, &trunc(&title, tw as usize), Style::default().fg(t.fg).add_modifier(Modifier::BOLD), tw);
                    put(buf, list.x + list.width.saturating_sub(when.width() as u16), y, &when, t.faint(), when.width() as u16);
                    let l2 = vec![
                        Span::styled(format!("{} ", d.key.kind.label()), Style::default().fg(t.agent(Some(d.key.kind))).add_modifier(Modifier::DIM)),
                        Span::styled(proj_name(&d.root), t.dim()),
                        Span::styled(hits[i].snippets.first().map(|s| format!("  {}", s.1)).unwrap_or_default(), t.faint()),
                    ];
                    put_line(buf, list.x + 2, y + 1, &fit_spans(l2, list.width.saturating_sub(3) as usize), list.width.saturating_sub(3));
                }
                if docs.is_empty() {
                    let msg = if building {
                        "still reading transcripts; results appear as soon as that is done"
                    } else if query.is_empty() {
                        "type to search titles, prompts, replies and files"
                    } else {
                        "nothing matches every word"
                    };
                    put(buf, list.x + 2, list.y, msg, t.faint(), list.width);
                }
                if wide {
                    if let (Some(d), Some(h)) = (docs.get(*sel), hits.get(*sel)) {
                        let pv = Rect { x: ir.x + list_w + 3, y: ir.y + 2, width: ir.width.saturating_sub(list_w + 3), height: ir.height.saturating_sub(2) };
                        let pw = pv.width as usize;
                        let mut y = pv.y;
                        let title = self.smeta.name(&d.key).map(String::from).unwrap_or_else(|| d.title.clone());
                        for l in wrap(&title, pw).into_iter().take(2) {
                            put(buf, pv.x, y, &l, Style::default().fg(t.fg).add_modifier(Modifier::BOLD), pv.width);
                            y += 1;
                        }
                        put(buf, pv.x, y, &format!("{} · {} · {}", d.key.kind.label(), rel_path(&d.cwd, ""), short_id(&d.key.id)), t.dim(), pv.width);
                        y += 2;
                        let blocks: Vec<(&str, String)> = if h.snippets.is_empty() {
                            vec![("you", d.prompts.split("\n\n").next().unwrap_or("").to_string())]
                        } else {
                            h.snippets.iter().map(|(n, s)| (*n, s.clone())).collect()
                        };
                        for (name, text) in blocks {
                            if y + 2 >= pv.y + pv.height {
                                break;
                            }
                            let col = match name {
                                "you" => t.accent,
                                "file" => t.info,
                                _ => t.agent(Some(d.key.kind)),
                            };
                            put(buf, pv.x, y, if name == "you" { "you wrote" } else if name == "file" { "files" } else { "it replied" }, Style::default().fg(col).add_modifier(Modifier::BOLD), pv.width);
                            y += 1;
                            for l in wrap(&text, pw.saturating_sub(2)).into_iter().take(4) {
                                let mut spans = vec![Span::styled("▎ ", Style::default().fg(col))];
                                spans.extend(highlight(&t, &l, &terms));
                                put_line(buf, pv.x, y, &Line::from(spans), pv.width);
                                y += 1;
                            }
                            y += 1;
                        }
                        if !d.files.is_empty() && y + 2 < pv.y + pv.height {
                            put(buf, pv.x, y, &format!("touched {}", plural(d.files.len(), "file", "files")), t.faint(), pv.width);
                        }
                    }
                }
                f.set_cursor_position(cursor);
            }
            Overlay::Command { value, sel } => {
                // A vim/k9s style command line over the footer, completions above it.
                let comps = self.completions(value);
                let shown = comps.len().min(10) as u16;
                let w = area.width.saturating_sub(4).min(96);
                let r = Rect { x: area.x + 1, y: area.y + area.height.saturating_sub(shown + 4), width: w, height: shown + 3 };
                f.render_widget(Clear, r);
                f.render_widget(frame("command · tab completes · enter runs · esc"), r);
                let ir = pad_rect(inner(&t, r), 1, 0);
                let buf = f.buffer_mut();
                let offset = sel.saturating_sub(shown.saturating_sub(1) as usize);
                for (i, (c, d)) in comps.iter().enumerate().skip(offset).take(shown as usize) {
                    let y = ir.y + (i - offset) as u16;
                    if i == *sel {
                        buf.set_style(Rect { x: ir.x, y, width: ir.width, height: 1 }, Style::default().bg(t.sel));
                    }
                    put(buf, ir.x, y, c, Style::default().fg(if i == *sel { t.accent } else { t.fg }).add_modifier(Modifier::BOLD), 30);
                    let dw = ir.width.saturating_sub(31);
                    put(buf, ir.x + 31, y, &trunc(d, dw as usize), t.dim(), dw);
                }
                if comps.is_empty() {
                    put(buf, ir.x, ir.y, "no command starts like that", t.faint(), ir.width);
                }
                let ly = ir.y + ir.height.saturating_sub(1);
                put_line(buf, ir.x, ly, &Line::from(vec![Span::styled(":", Style::default().fg(t.accent).add_modifier(Modifier::BOLD)), Span::styled(value.clone(), Style::default().fg(t.fg))]), ir.width);
                f.set_cursor_position((ir.x + 1 + value.width() as u16, ly));
            }
            Overlay::Presets { agent, items, sel } => {
                let label = match agent {
                    PaneKind::Codex => "codex",
                    _ => "claude",
                };
                let rows = items.len() as u16 + 1;
                let r = centered(area, 78, rows + 2);
                f.render_widget(Clear, r);
                f.render_widget(frame(&format!("start {label} · enter or a number")), r);
                let ir = inner(&t, r);
                let buf = f.buffer_mut();
                for i in 0..rows as usize {
                    let y = ir.y + i as u16;
                    let (name, what) = if i == 0 {
                        (format!("plain {label}"), "no preset".to_string())
                    } else {
                        let p = &items[i - 1];
                        let mut bits = Vec::new();
                        if !p.args.is_empty() {
                            bits.push(p.args.clone());
                        }
                        if p.worktree {
                            bits.push("own worktree".into());
                        }
                        if !p.prompt.is_empty() {
                            bits.push(format!("starts with \"{}\"", one_line(&p.prompt, 30)));
                        }
                        (p.name.clone(), bits.join(" · "))
                    };
                    if i == *sel {
                        buf.set_style(Rect { x: ir.x, y, width: ir.width, height: 1 }, Style::default().bg(t.sel));
                    }
                    put(buf, ir.x + 1, y, &format!("{}", i + 1), t.faint(), 2);
                    put(buf, ir.x + 4, y, &trunc(&name, 22), Style::default().fg(if i == *sel { t.accent } else { t.fg }).add_modifier(Modifier::BOLD), 22);
                    let dw = ir.width.saturating_sub(28);
                    put(buf, ir.x + 27, y, &trunc(&what, dw as usize), t.dim(), dw);
                }
            }
            Overlay::Choice { title, msg, options } => {
                let w = msg.iter().map(|m| m.width()).chain(options.iter().map(|o| o.1.width() + 4)).max().unwrap_or(20).clamp(30, 96) as u16 + 6;
                let r = centered(area, w, (msg.len() + options.len()) as u16 + 5);
                f.render_widget(Clear, r);
                let mut lines: Vec<Line> = msg
                    .iter()
                    .enumerate()
                    .map(|(i, m)| Line::from(Span::styled(m.clone(), if i == 0 { Style::default().fg(t.fg).add_modifier(Modifier::BOLD) } else { t.dim() })))
                    .collect();
                lines.push(Line::from(""));
                for (c, label, _) in options {
                    lines.push(Line::from(vec![Span::styled(format!("{c}  "), Style::default().fg(t.accent).add_modifier(Modifier::BOLD)), Span::styled(label.clone(), Style::default().fg(t.fg))]));
                }
                lines.push(Line::from(Span::styled("esc  cancel", t.faint())));
                f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }).block(frame(title)), r);
            }
            Overlay::Palette { sel, items } => {
                let h = items.len() as u16 + 2;
                let r = centered(area, 78, h);
                f.render_widget(Clear, r);
                f.render_widget(frame("add a panel"), r);
                let ir = inner(&t, r);
                let buf = f.buffer_mut();
                for (i, it) in items.iter().enumerate() {
                    let y = ir.y + i as u16;
                    let (name, blurb) = match it {
                        PaletteItem::Comp(c) => (c.label().to_string(), c.blurb().to_string()),
                        PaletteItem::Term(k) => {
                            let (name, blurb) = match k {
                                PaneKind::Shell => ("terminal", "a shell beside the focused pane"),
                                PaneKind::Claude => ("claude", "a new claude session beside the focused pane"),
                                PaneKind::Codex => ("codex", "a new codex session beside the focused pane"),
                            };
                            (name.to_string(), blurb.to_string())
                        }
                    };
                    let selected = i == *sel;
                    if selected {
                        buf.set_style(Rect { x: ir.x, y, width: ir.width, height: 1 }, Style::default().bg(t.sel));
                    }
                    put(buf, ir.x + 1, y, &name, Style::default().fg(if selected { t.accent } else { t.fg }).add_modifier(Modifier::BOLD), 16);
                    let bw = ir.width.saturating_sub(19);
                    put(buf, ir.x + 18, y, &trunc(&blurb, bw as usize), t.dim(), bw);
                    self.hits.push((Rect { x: ir.x, y, width: ir.width, height: 1 }, Hit::Palette(i)));
                }
            }
            Overlay::Confirm { msg, .. } => {
                let w = msg.iter().map(|m| m.width()).max().unwrap_or(20).clamp(30, 96) as u16 + 6;
                let r = centered(area, w, msg.len() as u16 + 4);
                f.render_widget(Clear, r);
                let mut lines: Vec<Line> = msg
                    .iter()
                    .enumerate()
                    .map(|(i, m)| Line::from(Span::styled(m.clone(), if i == 0 { Style::default().fg(t.fg).add_modifier(Modifier::BOLD) } else { t.dim() })))
                    .collect();
                lines.push(Line::from(""));
                lines.push(Line::from(vec![
                    Span::styled("y", Style::default().fg(t.ok).add_modifier(Modifier::BOLD)),
                    Span::styled(" yes    ", t.dim()),
                    Span::styled("n", Style::default().fg(t.err).add_modifier(Modifier::BOLD)),
                    Span::styled(" no", t.dim()),
                ]));
                f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }).block(frame("are you sure?")), r);
            }
            Overlay::Input { prompt, value, secret, .. } => {
                let r = centered(area, 70, 5);
                f.render_widget(Clear, r);
                let shown = if *secret { "•".repeat(value.chars().count()) } else { value.clone() };
                let lines = vec![
                    Line::from(Span::styled(prompt.clone(), t.dim())),
                    Line::from(vec![Span::styled("❯ ", Style::default().fg(t.accent)), Span::styled(shown.clone(), Style::default().fg(t.fg).add_modifier(Modifier::BOLD))]),
                ];
                f.render_widget(Paragraph::new(lines).block(frame("enter confirms · esc cancels")), r);
                let ir = inner(&t, r);
                f.set_cursor_position((ir.x + 2 + shown.width() as u16, ir.y + 1));
            }
            Overlay::Report { scroll } => {
                let r = centered(area, area.width.saturating_sub(8).min(110), area.height.saturating_sub(4));
                f.render_widget(Clear, r);
                let body = self.analysis.lock().unwrap().report.clone().unwrap_or_default();
                let lines: Vec<Line> = body
                    .lines()
                    .map(|l| {
                        if let Some(h) = l.strip_prefix("# ").or_else(|| l.strip_prefix("## ")).or_else(|| l.strip_prefix("### ")) {
                            Line::from(Span::styled(h.to_string(), Style::default().fg(t.accent).add_modifier(Modifier::BOLD)))
                        } else if l.trim_start().starts_with("- ") || l.trim_start().starts_with("* ") {
                            Line::from(vec![Span::styled("  • ", Style::default().fg(t.accent2)), Span::styled(l.trim_start()[2..].to_string(), Style::default().fg(t.fg))])
                        } else {
                            Line::from(Span::styled(l.to_string(), Style::default().fg(t.fg)))
                        }
                    })
                    .collect();
                f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }).scroll((*scroll, 0)).block(frame("report · j/k scroll · esc closes")), r);
            }
        }
    }
}
