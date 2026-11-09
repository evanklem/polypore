//! Color roles, presets and glyph sets. The `terminal` preset uses only the
//! 16 ANSI colors so it follows whatever palette the terminal is running
//! (omarchy themes, pywal, base16 shells).

use ratatui::style::{Color, Style};
use ratatui::widgets::BorderType;
use std::collections::BTreeMap;

use crate::model::{AgentKind, RunState};

#[derive(Clone, Debug)]
pub struct Theme {
    pub name: String,
    pub bg: Color,
    pub fg: Color,
    pub dim: Color,
    pub faint: Color,
    pub accent: Color,
    pub accent2: Color,
    pub ok: Color,
    pub warn: Color,
    pub err: Color,
    pub info: Color,
    pub claude: Color,
    pub codex: Color,
    pub shell: Color,
    pub sel: Color,
    pub transparent: bool,
    pub border: Option<BorderType>,
    pub gaps: u16,
}

pub const PRESETS: &[&str] = &[
    "auto", "polypore", "system", "terminal", "catppuccin", "gruvbox", "tokyonight", "nord", "rose-pine", "everforest", "kanagawa", "mono",
];

/// Omarchy 4.5 writes the active theme's palette here.
pub fn system_colors_path() -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    [".local/state/omarchy/current/theme/colors.toml", ".config/omarchy/current/theme/colors.toml"]
        .iter()
        .map(|p| home.join(p))
        .find(|p| p.is_file())
}

/// Builds a theme from the desktop's palette (Omarchy colors.toml).
fn system_theme() -> Option<Theme> {
    let text = std::fs::read_to_string(system_colors_path()?).ok()?;
    let table: toml::Table = text.parse().ok()?;
    let get = |k: &str| table.get(k).and_then(|v| v.as_str()).and_then(parse_color);
    let bg = get("background")?;
    let fg = get("foreground")?;
    let accent = get("accent").or_else(|| get("blue"))?;
    let faint = get("muted").unwrap_or(Color::DarkGray);
    let dim = match (fg, bg) {
        (Color::Rgb(a, b, c), Color::Rgb(x, y, z)) => {
            let mix = |p: u8, q: u8| ((p as u16 * 6 + q as u16 * 4) / 10) as u8;
            Color::Rgb(mix(a, x), mix(b, y), mix(c, z))
        }
        _ => Color::Gray,
    };
    Some(Theme {
        name: "system".into(),
        bg,
        fg,
        dim,
        faint,
        accent,
        accent2: get("light_foreground").filter(|c| *c != fg).or_else(|| get("cyan")).unwrap_or(accent),
        ok: get("green").unwrap_or(Color::Green),
        warn: get("yellow").or_else(|| get("orange")).unwrap_or(Color::Yellow),
        err: get("red").unwrap_or(Color::Red),
        info: get("blue").or_else(|| get("cyan")).unwrap_or(Color::Cyan),
        claude: get("orange").or_else(|| get("yellow")).unwrap_or(Color::LightRed),
        codex: get("cyan").or_else(|| get("blue")).unwrap_or(Color::LightCyan),
        shell: dim,
        sel: get("selection").unwrap_or(Color::DarkGray),
        transparent: true,
        border: Some(BorderType::Rounded),
        gaps: 1,
    })
}


fn hex(s: &str) -> Color {
    parse_color(s).unwrap_or(Color::Reset)
}

pub fn parse_color(s: &str) -> Option<Color> {
    let s = s.trim();
    if let Some(h) = s.strip_prefix('#') {
        if h.len() == 6 {
            let r = u8::from_str_radix(&h[0..2], 16).ok()?;
            let g = u8::from_str_radix(&h[2..4], 16).ok()?;
            let b = u8::from_str_radix(&h[4..6], 16).ok()?;
            return Some(Color::Rgb(r, g, b));
        }
        return None;
    }
    if let Ok(n) = s.parse::<u8>() {
        return Some(Color::Indexed(n));
    }
    Some(match s.to_ascii_lowercase().replace(['-', '_', ' '], "").as_str() {
        "reset" | "default" => Color::Reset,
        "black" => Color::Black,
        "red" => Color::Red,
        "green" => Color::Green,
        "yellow" => Color::Yellow,
        "blue" => Color::Blue,
        "magenta" => Color::Magenta,
        "cyan" => Color::Cyan,
        "gray" | "grey" => Color::Gray,
        "darkgray" | "darkgrey" | "brightblack" => Color::DarkGray,
        "lightred" | "brightred" => Color::LightRed,
        "lightgreen" | "brightgreen" => Color::LightGreen,
        "lightyellow" | "brightyellow" => Color::LightYellow,
        "lightblue" | "brightblue" => Color::LightBlue,
        "lightmagenta" | "brightmagenta" => Color::LightMagenta,
        "lightcyan" | "brightcyan" => Color::LightCyan,
        "white" | "brightwhite" => Color::White,
        _ => return None,
    })
}

#[allow(clippy::too_many_arguments)]
fn palette(
    name: &str,
    bg: &str,
    fg: &str,
    dim: &str,
    faint: &str,
    accent: &str,
    accent2: &str,
    ok: &str,
    warn: &str,
    err: &str,
    info: &str,
    claude: &str,
    codex: &str,
    sel: &str,
) -> Theme {
    Theme {
        name: name.into(),
        bg: hex(bg),
        fg: hex(fg),
        dim: hex(dim),
        faint: hex(faint),
        accent: hex(accent),
        accent2: hex(accent2),
        ok: hex(ok),
        warn: hex(warn),
        err: hex(err),
        info: hex(info),
        claude: hex(claude),
        codex: hex(codex),
        shell: hex(dim),
        sel: hex(sel),
        transparent: true,
        border: Some(BorderType::Rounded),
        gaps: 1,
    }
}

impl Theme {
    pub fn preset(name: &str) -> Theme {
        match name {
            "auto" => {
                let mut t = system_theme().unwrap_or_else(|| Theme::preset("polypore"));
                t.name = "auto".into();
                t
            }
            "system" => system_theme().unwrap_or_else(|| {
                let mut t = Theme::preset("polypore");
                t.name = "system".into();
                t
            }),
            // The original Polypore look: honey on warm near-black.
            "polypore" => palette(
                name, "#0a0807", "#f4efe8", "#a09e9b", "#4a3a2a", "#f0b35a", "#f7d4a3", "#8be996", "#ffb86b",
                "#ec665e", "#9cc3d5", "#e8956a", "#9cc3d5", "#2a1c12",
            ),
            "catppuccin" => palette(
                name, "#1e1e2e", "#cdd6f4", "#a6adc8", "#45475a", "#89b4fa", "#cba6f7", "#a6e3a1", "#f9e2af",
                "#f38ba8", "#89dceb", "#fab387", "#94e2d5", "#313244",
            ),
            "gruvbox" => palette(
                name, "#282828", "#ebdbb2", "#a89984", "#504945", "#83a598", "#d3869b", "#b8bb26", "#fabd2f",
                "#fb4934", "#8ec07c", "#fe8019", "#8ec07c", "#3c3836",
            ),
            "tokyonight" => palette(
                name, "#1a1b26", "#c0caf5", "#9aa5ce", "#3b4261", "#7aa2f7", "#bb9af7", "#9ece6a", "#e0af68",
                "#f7768e", "#7dcfff", "#ff9e64", "#2ac3de", "#292e42",
            ),
            "nord" => palette(
                name, "#2e3440", "#d8dee9", "#a4adbb", "#434c5e", "#88c0d0", "#b48ead", "#a3be8c", "#ebcb8b",
                "#bf616a", "#81a1c1", "#d08770", "#8fbcbb", "#3b4252",
            ),
            "rose-pine" => palette(
                name, "#191724", "#e0def4", "#908caa", "#403d52", "#c4a7e7", "#ebbcba", "#9ccfd8", "#f6c177",
                "#eb6f92", "#31748f", "#ebbcba", "#9ccfd8", "#26233a",
            ),
            "everforest" => palette(
                name, "#2d353b", "#d3c6aa", "#9da9a0", "#475258", "#7fbbb3", "#d699b6", "#a7c080", "#dbbc7f",
                "#e67e80", "#83c092", "#e69875", "#83c092", "#3d484d",
            ),
            "kanagawa" => palette(
                name, "#1f1f28", "#dcd7ba", "#a6a69c", "#54546d", "#7e9cd8", "#957fb8", "#98bb6c", "#e6c384",
                "#e46876", "#7fb4ca", "#ffa066", "#7aa89f", "#2a2a37",
            ),
            "mono" => Theme {
                name: name.into(),
                bg: Color::Reset,
                fg: Color::Reset,
                dim: Color::Gray,
                faint: Color::DarkGray,
                accent: Color::White,
                accent2: Color::Gray,
                ok: Color::White,
                warn: Color::White,
                err: Color::White,
                info: Color::Gray,
                claude: Color::White,
                codex: Color::Gray,
                shell: Color::DarkGray,
                sel: Color::DarkGray,
                transparent: true,
                border: Some(BorderType::Rounded),
                gaps: 1,
            },
            _ => Theme {
                name: "terminal".into(),
                bg: Color::Reset,
                fg: Color::Reset,
                dim: Color::Gray,
                faint: Color::DarkGray,
                accent: Color::Blue,
                accent2: Color::Magenta,
                ok: Color::Green,
                warn: Color::Yellow,
                err: Color::Red,
                info: Color::Cyan,
                claude: Color::LightRed,
                codex: Color::LightCyan,
                shell: Color::Gray,
                sel: Color::DarkGray,
                transparent: true,
                border: Some(BorderType::Rounded),
                gaps: 1,
            },
        }
    }

    pub fn from_config(cfg: &crate::config::Config) -> Theme {
        let mut t = Theme::preset(&cfg.ui.theme);
        t.transparent = cfg.ui.transparent;
        t.gaps = cfg.ui.gaps.min(4);
        t.border = match cfg.ui.border.as_str() {
            "plain" => Some(BorderType::Plain),
            "thick" => Some(BorderType::Thick),
            "double" => Some(BorderType::Double),
            "none" => None,
            _ => Some(BorderType::Rounded),
        };
        apply_overrides(&mut t, &cfg.colors);
        for (agent, slot) in [("claude", 0), ("codex", 1), ("shell", 2)] {
            let c = cfg.agent(agent).color;
            if let Some(col) = parse_color(&c) {
                match slot {
                    0 => t.claude = col,
                    1 => t.codex = col,
                    _ => t.shell = col,
                }
            }
        }
        t
    }

    pub fn dim(&self) -> Style {
        Style::default().fg(self.dim)
    }

    pub fn faint(&self) -> Style {
        Style::default().fg(self.faint)
    }

    pub fn agent(&self, kind: Option<AgentKind>) -> Color {
        match kind {
            Some(AgentKind::Claude) => self.claude,
            Some(AgentKind::Codex) => self.codex,
            None => self.shell,
        }
    }

    pub fn state(&self, s: RunState) -> Color {
        match s {
            RunState::NeedsInput => self.warn,
            RunState::Working => self.accent,
            RunState::Ready => self.ok,
            RunState::Closed => self.faint,
        }
    }

    pub fn cycle(&mut self, cfg: &mut crate::config::Config) {
        let idx = PRESETS.iter().position(|p| *p == self.name).unwrap_or(0);
        cfg.ui.theme = PRESETS[(idx + 1) % PRESETS.len()].to_string();
        *self = Theme::from_config(cfg);
    }
}

fn apply_overrides(t: &mut Theme, colors: &BTreeMap<String, String>) {
    for (k, v) in colors {
        let Some(c) = parse_color(v) else { continue };
        match k.as_str() {
            "bg" => t.bg = c,
            "fg" => t.fg = c,
            "dim" => t.dim = c,
            "faint" | "border" => t.faint = c,
            "accent" => t.accent = c,
            "accent2" => t.accent2 = c,
            "ok" => t.ok = c,
            "warn" => t.warn = c,
            "err" | "error" => t.err = c,
            "info" => t.info = c,
            "claude" => t.claude = c,
            "codex" => t.codex = c,
            "shell" => t.shell = c,
            "sel" | "selection" => t.sel = c,
            _ => {}
        }
    }
}
