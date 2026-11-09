//! The stats page: headline cards, a prompts-per-day chart, a when-you-work
//! heatmap and ranked lists. Drawn on a tall off-screen canvas so it scrolls
//! as one page on short terminals.

use ratatui::Frame;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

use crate::app::App;
use crate::model::fmt_tokens;
use crate::theme::Theme;
use crate::ui::{gauge, pad_rect, plural, put, put_line, rule, spinner, trunc, trunc_left};

/// A 3-row block font for the headline numbers.
fn big_glyph(c: char) -> Option<[&'static str; 3]> {
    Some(match c {
        '0' => ["█▀█", "█ █", "▀▀▀"],
        '1' => ["▀█ ", " █ ", "▀▀▀"],
        '2' => ["▀▀█", "█▀▀", "▀▀▀"],
        '3' => ["▀▀█", " ▀█", "▀▀▀"],
        '4' => ["█ █", "▀▀█", "  ▀"],
        '5' => ["█▀▀", "▀▀█", "▀▀▀"],
        '6' => ["█▀▀", "█▀█", "▀▀▀"],
        '7' => ["▀▀█", "  █", "  ▀"],
        '8' => ["█▀█", "█▀█", "▀▀▀"],
        '9' => ["█▀█", "▀▀█", "▀▀▀"],
        '.' => [" ", " ", "▀"],
        _ => return None,
    })
}

/// Draws "14.0M" as big digits with the unit in small type after them.
/// Returns the width used.
fn big_number(buf: &mut Buffer, x: u16, y: u16, text: &str, style: Style, unit_style: Style) -> u16 {
    let mut cx = x;
    let mut unit = String::new();
    for ch in text.chars() {
        match big_glyph(ch) {
            Some(g) => {
                for (r, row) in g.iter().enumerate() {
                    put(buf, cx, y + r as u16, row, style, row.width() as u16);
                }
                cx += g[0].width() as u16 + 1;
            }
            None => unit.push(ch),
        }
    }
    if !unit.is_empty() {
        put(buf, cx, y + 2, &unit, unit_style, unit.width() as u16);
        cx += unit.width() as u16;
    }
    cx - x
}

fn duration(s: f64) -> String {
    if s < 60.0 {
        format!("{:.0}s", s)
    } else if s < 3600.0 {
        format!("{:.0}m", s / 60.0)
    } else {
        format!("{:.1}h", s / 3600.0)
    }
}

fn card(buf: &mut Buffer, t: &Theme, r: Rect, value: &str, label: &str, sub: &str, color: Color) {
    let border = Style::default().fg(t.faint);
    let w = r.width as usize;
    put(buf, r.x, r.y, &format!("╭{}╮", "─".repeat(w.saturating_sub(2))), border, r.width);
    for dy in 1..r.height.saturating_sub(1) {
        put(buf, r.x, r.y + dy, "│", border, 1);
        put(buf, r.x + r.width - 1, r.y + dy, "│", border, 1);
    }
    put(buf, r.x, r.y + r.height - 1, &format!("╰{}╯", "─".repeat(w.saturating_sub(2))), border, r.width);
    big_number(buf, r.x + 2, r.y + 1, value, Style::default().fg(color), Style::default().fg(color).add_modifier(Modifier::BOLD));
    put(buf, r.x + 2, r.y + 4, label, Style::default().fg(t.fg).add_modifier(Modifier::BOLD), r.width.saturating_sub(4));
    put(buf, r.x + 2, r.y + 5, &trunc(sub, w.saturating_sub(4)), Style::default().fg(t.dim), r.width.saturating_sub(4));
}

/// Stacked bars, one column per day, in eighth-blocks.
fn chart(buf: &mut Buffer, t: &Theme, r: Rect, days: &[(String, u32, u32)]) {
    let blocks = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    let max = days.iter().map(|d| d.1 + d.2).max().unwrap_or(0).max(1);
    let axis_w = max.to_string().len() as u16 + 1;
    let plot = Rect { x: r.x + axis_w + 1, y: r.y, width: r.width.saturating_sub(axis_w + 1), height: r.height.saturating_sub(1) };
    let n = days.len().max(1) as u16;
    let col = (plot.width / n).max(1);
    let bar = if col >= 3 { col - 1 } else { col };
    let rows = plot.height as u32;
    // y axis: max at the top, 0 at the bottom, faint guide lines between
    put(buf, r.x, plot.y, &format!("{max:>w$}", w = axis_w as usize - 1), Style::default().fg(t.dim), axis_w);
    put(buf, r.x, plot.y + plot.height - 1, &format!("{:>w$}", 0, w = axis_w as usize - 1), Style::default().fg(t.dim), axis_w);
    for gy in [0, plot.height / 2] {
        for x in plot.x..plot.x + n * col {
            put(buf, x, plot.y + gy, "┄", Style::default().fg(t.faint), 1);
        }
    }
    for (i, (_, cl, cx)) in days.iter().enumerate() {
        let total = (cl + cx) as f64 / max as f64 * rows as f64 * 8.0;
        let claude = *cl as f64 / max as f64 * rows as f64 * 8.0;
        let total = total.round() as u32;
        let claude = claude.round() as u32;
        let x = plot.x + i as u16 * col;
        for row in 0..rows {
            let lo = row * 8;
            if total <= lo {
                break;
            }
            let fill = (total - lo).min(8) as usize;
            let color = if claude > lo + 4 || (claude > lo && *cx == 0) { t.claude } else { t.codex };
            let y = plot.y + plot.height - 1 - row as u16;
            let s: String = std::iter::repeat_n(blocks[fill], bar as usize).collect();
            put(buf, x, y, &s, Style::default().fg(color), bar);
        }
    }
    // x axis labels: first day, middle, today
    let ly = r.y + r.height - 1;
    if let Some(first) = days.first() {
        put(buf, plot.x, ly, &first.0, Style::default().fg(t.dim), 6);
    }
    if days.len() > 10 {
        let mid = &days[days.len() / 2].0;
        put(buf, plot.x + (days.len() as u16 / 2) * col, ly, mid, Style::default().fg(t.dim), 6);
    }
    let end = plot.x + n * col;
    put(buf, end.saturating_sub(5), ly, "today", Style::default().fg(t.dim), 5);
}

fn heatmap(buf: &mut Buffer, t: &Theme, r: Rect, heat: &[[u32; 24]; 7]) {
    let max = heat.iter().flat_map(|d| d.iter()).copied().max().unwrap_or(0).max(1);
    let days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    let cell = if r.width >= 4 + 24 * 3 { 3u16 } else { 2 };
    for (d, row) in heat.iter().enumerate() {
        let y = r.y + d as u16;
        put(buf, r.x, y, days[d], Style::default().fg(t.dim), 4);
        for (h, v) in row.iter().enumerate() {
            let x = r.x + 4 + h as u16 * cell;
            let level = if *v == 0 { 0 } else { 1 + ((*v as f64 / max as f64) * 3.0).round() as usize };
            let (ch, color) = match level {
                0 => ("·", t.faint),
                1 => ("░", t.accent),
                2 => ("▒", t.accent),
                3 => ("▓", t.accent),
                _ => ("█", t.accent),
            };
            let s: String = std::iter::repeat_n(ch, (cell - 1) as usize).collect();
            put(buf, x, y, &s, Style::default().fg(color), cell);
        }
    }
    let ly = r.y + 7;
    for h in [0u16, 6, 12, 18] {
        put(buf, r.x + 4 + h * cell, ly, &format!("{h}h"), Style::default().fg(t.dim), 3);
    }
}

/// A ranked list: name, a proportional bar, the count.
fn ranked(buf: &mut Buffer, t: &Theme, r: Rect, title: &str, meta: &str, rows: &[(String, u32)], color: Color, limit: usize) -> u16 {
    put_line(buf, r.x, r.y, &rule(t, title, meta, r.width as usize, t.accent2), r.width);
    if rows.is_empty() {
        put(buf, r.x, r.y + 1, "nothing yet", Style::default().fg(t.faint), r.width);
        return 3;
    }
    let max = rows.iter().map(|x| x.1).max().unwrap_or(1).max(1);
    let name_w = (r.width as usize * 45 / 100).max(12);
    let count_w = rows.iter().map(|x| x.1.to_string().len()).max().unwrap_or(1) + 1;
    let bar_w = (r.width as usize).saturating_sub(name_w + count_w + 2);
    for (i, (name, n)) in rows.iter().take(limit).enumerate() {
        let y = r.y + 1 + i as u16;
        let label = if name.contains('/') { trunc_left(name, name_w) } else { trunc(name, name_w) };
        put(buf, r.x, y, &label, Style::default().fg(t.fg), name_w as u16);
        let filled = ((*n as f64 / max as f64) * bar_w as f64).round().max(1.0) as usize;
        let mut spans = gauge(filled as f64 / bar_w.max(1) as f64, bar_w, color, t.faint);
        if spans.len() == 2 {
            spans[1] = Span::styled(" ".repeat(bar_w.saturating_sub(filled)), Style::default());
        }
        put_line(buf, r.x + name_w as u16 + 1, y, &Line::from(spans), bar_w as u16);
        put(buf, r.x + r.width - count_w as u16, y, &format!("{n:>w$}", w = count_w), Style::default().fg(t.dim), count_w as u16);
    }
    rows.len().min(limit) as u16 + 2
}

impl App {
    pub fn draw_stats_page(&mut self, f: &mut Frame, area: Rect) {
        let t = self.theme.clone();
        let a = pad_rect(area, 2, 1);
        let (stats, running, progress, llm_running, message, report_path) = {
            let st = self.analysis.lock().unwrap();
            (st.stats.clone(), st.running, st.progress, st.llm_running, st.message.clone(), st.report_path.clone())
        };
        let w = a.width;
        let Some(s) = stats else {
            let buf = f.buffer_mut();
            put_line(buf, a.x, a.y, &rule(&t, "stats", &message, w as usize, t.accent2), w);
            put(buf, a.x, a.y + 2, crate::art::SPROUT, Style::default().fg(t.accent), w);
            if running {
                let (d, n) = progress;
                let mut spans = gauge(if n > 0 { d as f64 / n as f64 } else { 0.0 }, 30, t.accent, t.faint);
                spans.push(Span::styled(format!("  reading {d} of {n} sessions"), Style::default().fg(t.dim)));
                put_line(buf, a.x, a.y + 4, &Line::from(spans), w);
            } else {
                put(buf, a.x, a.y + 4, "r reads the last 30 days of your sessions. nothing leaves this machine.", Style::default().fg(t.dim), w);
            }
            return;
        };
        // Lay everything out on a tall canvas, then show the scrolled slice.
        let mut canvas = Buffer::empty(Rect::new(0, 0, w, 220));
        let buf = &mut canvas;
        let mut y = 0u16;
        let meta = if running { format!("refreshing… {} of {}", progress.0, progress.1) } else { format!("last {} days", s.days) };
        put_line(buf, 0, y, &rule(&t, "stats", &meta, w as usize, t.accent2), w);
        y += 2;

        // headline cards
        let per_row: u16 = if w >= 130 { 5 } else if w >= 80 { 3 } else { 2 };
        let cw = (w + 1) / per_row - 1;
        let ch = 8u16;
        let fails_pct = if s.cmds > 0 { s.errors as f64 / s.cmds as f64 * 100.0 } else { 0.0 };
        let prompts_a_day = if s.active_days > 0 { s.turns as f64 / s.active_days as f64 } else { 0.0 };
        let cards: Vec<(String, &str, String, Color)> = vec![
            (s.turns.to_string(), "prompts", format!("{prompts_a_day:.0} a day on {} active days", s.active_days), t.accent),
            (s.sessions.to_string(), "sessions", format!("claude {} · codex {}", s.claude, s.codex), t.accent2),
            (fmt_tokens(s.tokens_out), "tokens written", format!("{} read", fmt_tokens(s.tokens_in)), t.info),
            (duration(s.avg_turn_s), "per turn", format!("on average · {} compacted", plural(s.compactions as usize, "time", "times")), t.ok),
            (s.errors.to_string(), "failures", format!("{fails_pct:.0}% of {} commands", s.cmds), t.err),
        ];
        for (i, (value, label, sub, color)) in cards.iter().enumerate() {
            let col = i as u16 % per_row;
            let row = i as u16 / per_row;
            card(buf, &t, Rect::new(col * (cw + 1), y + row * ch, cw, ch - 1), value, label, sub, *color);
        }
        y += ch * ((cards.len() as u16 + per_row - 1) / per_row) + 1;

        // prompts per day
        let legend = "■ claude   ■ codex".to_string();
        put_line(buf, 0, y, &rule(&t, "prompts per day", "", w as usize - legend.width() - 2, t.accent2), w);
        put_line(buf, w - legend.width() as u16, y, &Line::from(vec![
            Span::styled("■ ", Style::default().fg(t.claude)),
            Span::styled("claude   ", Style::default().fg(t.dim)),
            Span::styled("■ ", Style::default().fg(t.codex)),
            Span::styled("codex", Style::default().fg(t.dim)),
        ]), legend.width() as u16);
        y += 2;
        chart(buf, &t, Rect::new(0, y, w, 10), &s.prompts_per_day);
        y += 12;

        // when you work + stuck / model review
        let wide = w >= 120;
        let left_w = if wide { 4 + 24 * 3 } else { w };
        put_line(buf, 0, y, &rule(&t, "when you prompt", "by hour · less ░▒▓█ more", left_w as usize, t.accent2), left_w);
        heatmap(buf, &t, Rect::new(0, y + 2, left_w, 8), &s.heat);
        let (rx, ry, rw) = if wide { (left_w + 4, y, w - left_w - 4) } else { (0, y + 11, w) };
        // review card
        put_line(buf, rx, ry, &rule(&t, "ask a model", "", rw as usize, t.accent2), rw);
        let last = report_path
            .as_ref()
            .and_then(|p| p.file_stem())
            .map(|n| n.to_string_lossy().trim_start_matches("report-").to_string())
            .or_else(|| latest_report_date());
        let review = if llm_running {
            Line::from(vec![Span::styled(format!("{} reading your sessions…", spinner(self.tick_ms())), Style::default().fg(t.accent2))])
        } else {
            Line::from(vec![
                Span::styled("m ", Style::default().fg(t.accent)),
                Span::styled("finds what you keep correcting and what to put in CLAUDE.md", Style::default().fg(t.dim)),
            ])
        };
        put_line(buf, rx, ry + 2, &review, rw);
        put_line(buf, rx, ry + 3, &Line::from(vec![
            Span::styled("o ", Style::default().fg(t.accent)),
            Span::styled(match &last {
                Some(d) => format!("opens the last report ({d})"),
                None => "no report yet".to_string(),
            }, Style::default().fg(t.dim)),
        ]), rw);
        if !s.loops.is_empty() {
            put_line(buf, rx, ry + 5, &rule(&t, "where agents got stuck", &s.loops.len().to_string(), rw as usize, t.warn), rw);
            for (i, (p, l)) in s.loops.iter().take(3).enumerate() {
                put_line(buf, rx, ry + 6 + i as u16, &Line::from(vec![
                    Span::styled(format!("{} ", trunc(p, 16)), Style::default().fg(t.dim)),
                    Span::styled(l.clone(), Style::default().fg(t.fg)),
                ]), rw);
            }
        }
        y += if wide { 11 } else { 21 };

        // ranked lists in two columns
        let gap = 4u16;
        let (cols, colw) = if w >= 110 { (2u16, (w - gap) / 2) } else { (1, w) };
        let lists: Vec<(&str, &str, &Vec<(String, u32)>, Color)> = vec![
            ("tools used", "calls", &s.tools, t.accent),
            ("commands that fail", "failures", &s.failing, t.err),
            ("files edited most", "edits", &s.files, t.ok),
            ("skills used", "times", &s.skills, t.accent2),
            ("projects", "sessions", &s.projects, t.info),
        ];
        let mut col_y = [y, y];
        for (i, (title, meta, rows, color)) in lists.iter().enumerate() {
            let c = if cols == 2 { (i % 2) as usize } else { 0 };
            let x = c as u16 * (colw + gap);
            let used = ranked(buf, &t, Rect::new(x, col_y[c], colw, 12), title, meta, rows, *color, 8);
            col_y[c] += used + 1;
        }
        let total_h = col_y[0].max(col_y[1]);
        let _ = message;

        // copy the visible slice
        let max_scroll = total_h.saturating_sub(a.height);
        self.stats_scroll = self.stats_scroll.min(max_scroll);
        let out = f.buffer_mut();
        for dy in 0..a.height.min(total_h) {
            for dx in 0..w {
                let src = &canvas[(dx, dy + self.stats_scroll)];
                if let Some(cell) = out.cell_mut((a.x + dx, a.y + dy)) {
                    *cell = src.clone();
                }
            }
        }
        if max_scroll > 0 {
            let more = if self.stats_scroll < max_scroll { "j/k scroll ↓" } else { "j/k scroll ↑" };
            put(out, a.x + w - more.width() as u16, a.y + a.height.saturating_sub(1), more, Style::default().fg(t.faint), more.width() as u16);
        }
    }
}

fn latest_report_date() -> Option<String> {
    let dir = crate::config::state_dir().join("analysis");
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(String::from))
        .filter(|n| n.starts_with("report-"))
        .collect();
    v.sort();
    v.pop().map(|n| n.trim_start_matches("report-").trim_end_matches(".md").to_string())
}
