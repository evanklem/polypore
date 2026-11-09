//! Claude's and codex's 5-hour and weekly limits, from whichever source is
//! freshest, never shown once a window has reset.
//!
//! Sources, newest wins:
//! - codex: the rate limits in its own rollouts (written on every turn)
//! - Omarchy's usage records (`~/.local/state/omarchy/agents/usage/*.json`)
//! - claude: Anthropic's usage endpoint, asked with claude's own login
//!   (`[quota] claude_probe`), at most every five minutes

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::model::*;

#[derive(Clone, Debug, PartialEq)]
pub struct QWindow {
    /// "5h", "week", "30d".
    pub name: String,
    /// 0 to 100.
    pub used: f64,
    /// Milliseconds since the epoch.
    pub resets_at: i64,
    pub window_ms: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Pace {
    /// Not enough of the window has passed to say.
    Unknown,
    /// At this rate the window resets before it runs out.
    Fine,
    /// Runs out this many ms from now, before the reset.
    RunsOut(i64),
}

impl QWindow {
    /// At the rate used so far in this window, does it last until reset?
    pub fn pace(&self, now: i64) -> Pace {
        if self.window_ms <= 0 || self.resets_at <= now {
            return Pace::Unknown;
        }
        let start = self.resets_at - self.window_ms;
        let elapsed = (now - start).max(0);
        if elapsed < self.window_ms / 20 || self.used <= 0.0 {
            return Pace::Unknown;
        }
        if self.used >= 100.0 {
            return Pace::RunsOut(0);
        }
        let rate = self.used / elapsed as f64;
        let left = ((100.0 - self.used) / rate) as i64;
        if now + left < self.resets_at { Pace::RunsOut(left) } else { Pace::Fine }
    }
}

#[derive(Clone, Debug)]
pub struct Quota {
    pub agent: AgentKind,
    pub plan: String,
    pub windows: Vec<QWindow>,
    /// When the numbers were measured.
    pub fetched: i64,
    pub source: &'static str,
}

impl Quota {
    /// The windows that still describe now.
    pub fn current(&self, now: i64) -> Vec<&QWindow> {
        self.windows.iter().filter(|w| w.resets_at > now).collect()
    }
}

pub type Shared = Arc<Mutex<Vec<Quota>>>;

/// A window's length from its label ("Session (5-hour)", "Weekly (7-day)",
/// "720h window").
pub fn window_from_label(label: &str) -> Option<(String, i64)> {
    let l = label.to_lowercase();
    let num: String = l.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
    let n: i64 = num.parse().ok()?;
    let after = l[l.find(&num)? + num.len()..].trim_start_matches(['-', ' ']).to_string();
    let hours = if after.starts_with('h') {
        n
    } else if after.starts_with('d') {
        n * 24
    } else if after.starts_with('w') {
        n * 24 * 7
    } else {
        return None;
    };
    Some((window_name(hours * 60), hours * 3_600_000))
}

pub fn window_name(minutes: i64) -> String {
    match minutes {
        m if m == 7 * 24 * 60 => "week".into(),
        m if m >= 24 * 60 && m % (24 * 60) == 0 => format!("{}d", m / (24 * 60)),
        m => format!("{}h", (m / 60).max(1)),
    }
}

/// An Omarchy usage record (`claude.json`, `codex.json`).
pub fn parse_omarchy(text: &str, agent: AgentKind) -> Option<Quota> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    if v.get("limitsStale").and_then(|b| b.as_bool()).unwrap_or(false) {
        return None;
    }
    let fetched = v.get("limitsFetchedAt").and_then(|n| n.as_i64()).unwrap_or(0);
    let mut windows = Vec::new();
    for l in v.get("limits")?.as_array()? {
        let label = l.get("label").and_then(|s| s.as_str()).unwrap_or("");
        // Per-model side buckets ("Fable Weekly") are not the account's limit.
        if l.get("title").is_some() {
            continue;
        }
        let Some((name, window_ms)) = window_from_label(label) else { continue };
        let used = l.get("percent").and_then(|p| p.as_f64()).unwrap_or(0.0) * 100.0;
        let resets_at = l.get("resetsAt").and_then(|s| s.as_str()).map(parse_ts).unwrap_or(0);
        windows.push(QWindow { name, used, resets_at, window_ms });
    }
    if windows.is_empty() {
        return None;
    }
    let plan = v.get("tierLabel").and_then(|s| s.as_str()).unwrap_or("").to_string();
    Some(Quota { agent, plan, windows, fetched, source: "omarchy" })
}

/// Anthropic's `/api/oauth/usage` answer.
pub fn parse_claude_usage(text: &str, now: i64) -> Option<Quota> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let mut windows = Vec::new();
    for (key, name, ms) in [("five_hour", "5h", 5 * 3_600_000i64), ("seven_day", "week", 7 * 86_400_000)] {
        let Some(b) = v.get(key).filter(|b| b.is_object()) else { continue };
        let Some(used) = b.get("utilization").and_then(|u| u.as_f64().or_else(|| u.as_str().and_then(|s| s.parse().ok()))) else { continue };
        let resets_at = match b.get("resets_at") {
            Some(serde_json::Value::String(s)) => parse_ts(s),
            Some(serde_json::Value::Number(n)) => n.as_i64().map(|t| if t < 1_000_000_000_000 { t * 1000 } else { t }).unwrap_or(0),
            _ => 0,
        };
        windows.push(QWindow { name: name.into(), used: used.clamp(0.0, 100.0), resets_at, window_ms: ms });
    }
    if windows.is_empty() {
        return None;
    }
    Some(Quota { agent: AgentKind::Claude, plan: String::new(), windows, fetched: now, source: "anthropic" })
}

pub fn from_rollout(r: &RateLimits) -> Quota {
    let windows = [&r.primary, &r.secondary]
        .into_iter()
        .flatten()
        .filter(|w| w.window_minutes > 0)
        .map(|w| {
            let resets_at = if w.resets_at > 0 { w.resets_at * 1000 } else { r.ts + w.window_minutes as i64 * 60_000 };
            QWindow { name: window_name(w.window_minutes as i64), used: w.used_percent, resets_at, window_ms: w.window_minutes as i64 * 60_000 }
        })
        .collect();
    Quota { agent: AgentKind::Codex, plan: r.plan.clone(), windows, fetched: r.ts, source: "codex" }
}

fn omarchy_dir() -> PathBuf {
    std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".local/state"))
        .join("omarchy/agents/usage")
}

/// Asks Anthropic with claude's own login. The token goes to curl on stdin,
/// never on a command line.
fn probe_claude() -> Option<String> {
    use std::io::Write;
    let creds = std::fs::read_to_string(crate::config::claude_dir().join(".credentials.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&creds).ok()?;
    let login = v.get("claudeAiOauth")?;
    let token = login.get("accessToken")?.as_str()?;
    let expires = login.get("expiresAt").and_then(|n| n.as_i64()).unwrap_or(i64::MAX);
    if token.is_empty() || expires < now_ms() {
        return None;
    }
    let mut child = std::process::Command::new("curl")
        .args(["-sS", "-m", "10", "-K", "-", "https://api.anthropic.com/api/oauth/usage"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    {
        let mut si = child.stdin.take()?;
        let _ = writeln!(si, "header = \"Authorization: Bearer {token}\"");
        let _ = writeln!(si, "header = \"anthropic-beta: oauth-2025-04-20\"");
        let _ = writeln!(si, "header = \"Accept: application/json\"");
    }
    let out = child.wait_with_output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).to_string())
}

/// Picks the freshest record per agent.
pub fn freshest(cands: Vec<Quota>) -> Vec<Quota> {
    let mut out: Vec<Quota> = Vec::new();
    for q in cands {
        match out.iter_mut().find(|x| x.agent == q.agent) {
            Some(x) if x.fetched >= q.fetched => {}
            Some(x) => *x = q,
            None => out.push(q),
        }
    }
    out.sort_by_key(|q| q.agent.label());
    out
}

/// Refreshes the shared quota every 30 seconds in the background.
pub fn spawn(store: crate::store::Shared, probe: bool) -> Shared {
    let shared: Shared = Arc::new(Mutex::new(Vec::new()));
    let out = shared.clone();
    std::thread::Builder::new()
        .name("polypore-quota".into())
        .spawn(move || {
            let mut last_probe: Option<(Instant, Option<Quota>)> = None;
            loop {
                let now = now_ms();
                let mut cands = Vec::new();
                for (file, agent) in [("claude.json", AgentKind::Claude), ("codex.json", AgentKind::Codex)] {
                    if let Some(q) = std::fs::read_to_string(omarchy_dir().join(file)).ok().and_then(|t| parse_omarchy(&t, agent)) {
                        cands.push(q);
                    }
                }
                if let Some(r) = store.lock().unwrap().rate_limits.clone() {
                    cands.push(from_rollout(&r));
                }
                // Probe claude only when nothing measured it in the last 10 minutes.
                let claude_fresh = cands.iter().any(|q| q.agent == AgentKind::Claude && now - q.fetched < 10 * 60_000);
                if probe && !claude_fresh {
                    let due = last_probe.as_ref().map(|(t, _)| t.elapsed() > Duration::from_secs(300)).unwrap_or(true);
                    if due {
                        let q = probe_claude().and_then(|t| parse_claude_usage(&t, now_ms()));
                        last_probe = Some((Instant::now(), q));
                    }
                    if let Some((_, Some(q))) = &last_probe {
                        cands.push(q.clone());
                    }
                }
                *out.lock().unwrap() = freshest(cands);
                std::thread::sleep(Duration::from_secs(30));
            }
        })
        .expect("spawn quota thread");
    shared
}

/// "in 3h 20m", "in 12m".
pub fn span(ms: i64) -> String {
    let m = (ms / 60_000).max(0);
    if m < 60 {
        format!("{m}m")
    } else if m < 48 * 60 {
        if m % 60 == 0 { format!("{}h", m / 60) } else { format!("{}h {}m", m / 60, m % 60) }
    } else {
        format!("{}d {}h", m / 1440, (m % 1440) / 60)
    }
}
