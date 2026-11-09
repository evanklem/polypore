#!/usr/bin/env python3
"""Builds a fake HOME with synthetic claude/codex history for README screenshots.

usage: mkdemo.py <root>    (creates <root>/home, <root>/bin, prints env to source)
"""
import json, os, subprocess, sys, time, shutil, uuid
from datetime import datetime, timezone, timedelta

root = os.path.abspath(sys.argv[1])
H = os.path.join(root, "home")
if os.path.exists(root):
    shutil.rmtree(root)
os.makedirs(H)
NOW = datetime.now(timezone.utc)


def ts(minutes_ago):
    return (NOW - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def w(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def git(cwd, *args):
    subprocess.run(["git", "-C", cwd, *args], check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "demo", "GIT_AUTHOR_EMAIL": "demo@example.com",
                        "GIT_COMMITTER_NAME": "demo", "GIT_COMMITTER_EMAIL": "demo@example.com",
                        "HOME": H})


# ---------- projects on disk ----------
P = {
    "tidepool": os.path.join(H, "code/tidepool"),
    "lumen": os.path.join(H, "code/lumen"),
    "kestrel": os.path.join(H, "code/kestrel"),
    "field-notes": os.path.join(H, "notes/field-notes"),
    "dotfiles": os.path.join(H, "code/dotfiles"),
}

CONFIG_OLD = """use std::collections::HashMap;
use std::path::Path;

/// Settings for the sync daemon.
pub struct Config {
    pub listen: String,
    pub data_dir: String,
    pub peers: Vec<String>,
    pub retry_limit: u32,
}

impl Config {
    pub fn load(path: &Path) -> anyhow::Result<Config> {
        let text = std::fs::read_to_string(path)?;
        let mut map = HashMap::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                map.insert(k.trim().to_string(), v.trim().to_string());
            }
        }
        Ok(Config {
            listen: map.remove("listen").unwrap_or_else(|| "127.0.0.1:7400".into()),
            data_dir: map.remove("data_dir").unwrap_or_else(|| "./data".into()),
            peers: map.remove("peers").map(|p| p.split(',').map(str::to_string).collect()).unwrap_or_default(),
            retry_limit: map.remove("retry_limit").and_then(|v| v.parse().ok()).unwrap_or(5),
        })
    }
}
"""

CONFIG_NEW = """use std::path::Path;

use serde::Deserialize;

/// Settings for the sync daemon.
#[derive(Deserialize)]
#[serde(default)]
pub struct Config {
    pub listen: String,
    pub data_dir: String,
    pub peers: Vec<String>,
    pub retry_limit: u32,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            listen: "127.0.0.1:7400".into(),
            data_dir: "./data".into(),
            peers: Vec::new(),
            retry_limit: 5,
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> anyhow::Result<Config> {
        let text = std::fs::read_to_string(path)?;
        Ok(toml::from_str(&text)?)
    }
}
"""

WORKER = """use crate::backoff::Backoff;
use crate::peer::Peer;

pub async fn run(peers: Vec<Peer>, limit: u32) {
    for peer in peers {
        let mut tries = 0;
        while let Err(e) = peer.sync().await {
            tries += 1;
            if tries >= limit {
                tracing::warn!(%e, peer = %peer.addr, "giving up");
                break;
            }
        }
    }
}
"""

def mkrepo(name, files, branch="main"):
    d = P[name]
    os.makedirs(d, exist_ok=True)
    for rel, text in files.items():
        w(os.path.join(d, rel), text)
    git(d, "init", "-q", "-b", branch)
    git(d, "add", "-A")
    git(d, "commit", "-q", "-m", "initial import")
    return d

mkrepo("tidepool", {
    "Cargo.toml": '[package]\nname = "tidepool"\nversion = "0.4.1"\nedition = "2024"\n\n[dependencies]\nanyhow = "1"\ntokio = { version = "1", features = ["full"] }\ntracing = "0.1"\n',
    "README.md": "# tidepool\n\nA small sync daemon that keeps folders in step across machines.\n",
    "src/main.rs": "mod backoff;\nmod config;\nmod peer;\nmod worker;\n\n#[tokio::main]\nasync fn main() -> anyhow::Result<()> {\n    let cfg = config::Config::load(\"tidepool.conf\".as_ref())?;\n    worker::run(peer::connect(&cfg.peers).await?, cfg.retry_limit).await;\n    Ok(())\n}\n",
    "src/config.rs": CONFIG_OLD,
    "src/worker.rs": WORKER,
    "src/peer.rs": "pub struct Peer { pub addr: String }\n\nimpl Peer {\n    pub async fn sync(&self) -> anyhow::Result<()> { Ok(()) }\n}\n\npub async fn connect(addrs: &[String]) -> anyhow::Result<Vec<Peer>> {\n    Ok(addrs.iter().map(|a| Peer { addr: a.clone() }).collect())\n}\n",
    "src/ingest.rs": "pub fn ingest(_buf: &[u8]) {}\n",
    "migrations/0003_peers.sql": "create table peers (id integer primary key, addr text not null);\n",
    "tests/sync.rs": "#[test]\nfn syncs_two_peers() {}\n",
    ".gitignore": "/target\n",
})
# uncommitted work from the live sessions
w(os.path.join(P["tidepool"], "src/config.rs"), CONFIG_NEW)
with open(os.path.join(P["tidepool"], "Cargo.toml"), "a") as f:
    f.write('serde = { version = "1", features = ["derive"] }\ntoml = "0.9"\n')
w(os.path.join(P["tidepool"], "src/backoff.rs"), """use std::time::Duration;

/// Exponential backoff with full jitter, capped at `max`.
pub struct Backoff {
    base: Duration,
    max: Duration,
    attempt: u32,
}

impl Backoff {
    pub fn new(base: Duration, max: Duration) -> Self {
        Backoff { base, max, attempt: 0 }
    }

    pub fn next_delay(&mut self) -> Duration {
        let exp = self.base.saturating_mul(1 << self.attempt.min(16));
        self.attempt += 1;
        let capped = exp.min(self.max);
        capped.mul_f64(fastrand::f64())
    }
}
""")
w(os.path.join(P["tidepool"], "src/worker.rs"), """use std::time::Duration;

use crate::backoff::Backoff;
use crate::peer::Peer;

pub async fn run(peers: Vec<Peer>, limit: u32) {
    for peer in peers {
        let mut tries = 0;
        let mut backoff = Backoff::new(Duration::from_millis(200), Duration::from_secs(30));
        while let Err(e) = peer.sync().await {
            tries += 1;
            if tries >= limit {
                tracing::warn!(%e, peer = %peer.addr, "giving up");
                break;
            }
            tokio::time::sleep(backoff.next_delay()).await;
        }
    }
}
""")
w(os.path.join(P["tidepool"], "docs/config-migration.md"), "# Moving tidepool.conf to TOML\n\nThe keys are the same. Quote the strings and turn `peers` into a list.\n")

mkrepo("lumen", {
    "package.json": '{\n  "name": "lumen",\n  "version": "1.2.0",\n  "type": "module"\n}\n',
    "src/build.ts": "export async function build() {}\n",
    "src/sitemap.ts": "export function sitemap(pages: string[]) { return pages }\n",
    "theme/docs.css": ":root { --bg: #fff; --fg: #111; }\n",
    "theme/header.tsx": "export const Header = () => null\n",
})
mkrepo("kestrel", {
    "go.mod": "module example.com/kestrel\n\ngo 1.24\n",
    "main.go": "package main\n\nfunc main() {}\n",
    "cmd/status.go": "package cmd\n",
})
mkrepo("field-notes", {"index.md": "# field notes\n", "2026/rust-async.md": "# async notes\n"})
mkrepo("dotfiles", {"hypr/hyprland.conf": "# hyprland\n", "nvim/init.lua": "-- nvim\n"})

# ---------- claude transcripts ----------
CL = os.path.join(H, ".claude")
os.makedirs(os.path.join(CL, "sessions"))


def enc(path):
    return path.replace("/", "-").replace(".", "-")


class Claude:
    def __init__(self, project, title, start_min, branch="main"):
        self.id = str(uuid.uuid4())
        self.cwd = P[project]
        self.branch = branch
        self.lines = []
        self.t = start_min
        self.n = 0
        self.lines.append({"type": "ai-title", "aiTitle": title, "sessionId": self.id})

    def _tick(self, step):
        self.t = max(self.t - step, 0)
        return ts(self.t)

    def user(self, text, step=0.4):
        self.lines.append({"type": "user", "timestamp": self._tick(step), "cwd": self.cwd, "gitBranch": self.branch,
                           "sessionId": self.id, "message": {"role": "user", "content": text}})

    def say(self, text, step=0.3, stop="end_turn", ctx=60000):
        self.n += 1
        self.lines.append({"type": "assistant", "timestamp": self._tick(step), "cwd": self.cwd,
                           "message": {"id": f"msg{self.n}", "model": "claude-opus-5-5", "stop_reason": stop,
                                       "content": [{"type": "text", "text": text}],
                                       "usage": {"input_tokens": 12, "output_tokens": 400,
                                                 "cache_read_input_tokens": ctx}}})

    def tool(self, name, inp, result="ok", error=False, tur=None, step=0.3, ctx=60000, pending=False):
        self.n += 1
        tid = f"toolu_{self.n:04d}"
        self.lines.append({"type": "assistant", "timestamp": self._tick(step), "cwd": self.cwd,
                           "message": {"id": f"msg{self.n}", "model": "claude-opus-5-5", "stop_reason": "tool_use",
                                       "content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}],
                                       "usage": {"input_tokens": 8, "output_tokens": 120,
                                                 "cache_read_input_tokens": ctx}}})
        if pending:
            return
        line = {"type": "user", "timestamp": self._tick(0.1), "cwd": self.cwd,
                "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid,
                                                         "content": result, "is_error": error}]}}
        if tur is not None:
            line["toolUseResult"] = tur
        self.lines.append(line)

    def task(self, subject, active):
        self.ntask = getattr(self, "ntask", 0) + 1
        tid = str(self.ntask)
        self.tool("TaskCreate", {"subject": subject, "activeForm": active},
                  result=f"Task #{tid} created successfully: {subject}", tur={"task": {"id": tid, "subject": subject}})
        return tid

    def status(self, tid, st):
        self.tool("TaskUpdate", {"taskId": tid, "status": st}, result=f"Updated task #{tid} status")

    def edit(self, rel, old, new):
        self.tool("Edit", {"file_path": os.path.join(self.cwd, rel), "old_string": old, "new_string": new},
                  result=f"The file {rel} has been updated.")

    def write(self, rel, text):
        self.tool("Write", {"file_path": os.path.join(self.cwd, rel), "content": text},
                  result=f"File created successfully at: {rel}")

    def read(self, rel):
        self.tool("Read", {"file_path": os.path.join(self.cwd, rel)}, result="(file contents)")

    def bash(self, cmd, out="ok", error=False, desc=""):
        self.tool("Bash", {"command": cmd, "description": desc}, result=out, error=error)

    def done(self, ms=95000):
        self.lines.append({"type": "system", "subtype": "turn_duration", "durationMs": ms, "timestamp": self._tick(0.05)})

    def cost(self, usd, added, removed):
        self.lines.append({"type": "cost-state", "totalCostUSD": usd, "totalLinesAdded": added, "totalLinesRemoved": removed})

    def save(self):
        d = os.path.join(CL, "projects", enc(self.cwd))
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, self.id + ".jsonl")
        with open(p, "w") as f:
            for l in self.lines:
                f.write(json.dumps(l) + "\n")
        mt = (NOW - timedelta(minutes=self.t)).timestamp()
        os.utime(p, (mt, mt))
        return self.id


ids = {}

# A: tidepool, needs you (live, waiting on a permission prompt)
a = Claude("tidepool", "Retry backoff for the sync worker", 26)
a.user("the sync worker hammers a peer that is down. add exponential backoff with jitter, keep retry_limit")
a.read("src/worker.rs")
t1 = a.task("Read the worker loop", "Reading the worker loop"); a.status(t1, "completed")
t2 = a.task("Add backoff with full jitter", "Adding backoff"); a.status(t2, "in_progress")
t3 = a.task("Cover retries in tests", "Covering retries in tests")
a.write("src/backoff.rs", "pub struct Backoff;")
a.edit("src/worker.rs", "let mut tries = 0;", "let mut tries = 0;\n        let mut backoff = Backoff::new(..);")
a.bash("cargo check", "error[E0425]: cannot find crate `fastrand` in this scope\n --> src/backoff.rs:19:24", error=True, desc="Type-check")
a.tool("WebFetch", {"url": "https://docs.rs/fastrand/latest/fastrand/", "prompt": "f64 api"}, result="fastrand::f64() returns a value in [0, 1)")
a.say("`fastrand` is not a dependency yet. I'll add it, then run the whole test suite, which touches the network fixtures.", stop="tool_use", ctx=84210)
a.status(t2, "completed"); a.status(t3, "in_progress")
a.tool("Bash", {"command": "cargo test --all", "description": "Run every test"}, pending=True, ctx=84210)
ids["A"] = a.save()

# B: tidepool, working inside a polypore terminal (the focus screenshot)
b = Claude("tidepool", "Port the config loader to TOML", 14)
b.user("tidepool.conf is a hand-rolled ini format. move it to toml with serde and keep Config's fields as they are")
b.read("src/config.rs"); b.read("src/main.rs")
s1 = b.task("Swap the INI parser for toml", "Swapping the parser"); b.status(s1, "in_progress")
s2 = b.task("Keep Config's public shape", "Checking callers")
s3 = b.task("Write a migration note", "Writing the migration note")
b.tool("WebFetch", {"url": "https://docs.rs/toml/latest/toml/", "prompt": "from_str"}, result="toml::from_str deserializes any T: Deserialize")
b.edit("Cargo.toml", 'tracing = "0.1"', 'tracing = "0.1"\nserde = { version = "1", features = ["derive"] }\ntoml = "0.9"')
b.edit("src/config.rs", "let mut map = HashMap::new();", "Ok(toml::from_str(&text)?)")
b.status(s1, "completed"); b.status(s2, "in_progress")
b.bash("cargo test config", "running 6 tests\ntest result: ok. 6 passed; 0 failed", desc="Run config tests")
b.status(s2, "completed"); b.status(s3, "in_progress")
b.write("docs/config-migration.md", "# Moving tidepool.conf to TOML")
b.say("The loader now goes through serde, and the six config tests pass unchanged. Writing a short migration note for existing tidepool.conf files.", stop="tool_use", ctx=61840)
ids["B"] = b.save()

# D: tidepool, closed yesterday
d = Claude("tidepool", "Profile the ingest hot path", 60 * 22)
d.user("ingest is slow on big batches, find out why")
d.read("src/ingest.rs")
d.bash("cargo flamegraph --bin tidepool -- ingest fixtures/big.bin", "wrote flamegraph.svg")
d.say("68% of ingest is spent re-allocating the frame buffer. Reusing one `Vec` per worker cut the big-batch fixture from 4.1s to 1.3s.", ctx=40210)
d.done(); d.cost(1.84, 22, 9)
ids["D"] = d.save()

# F: lumen, ready (live, idle)
f = Claude("lumen", "Dark mode for the docs theme", 9, branch="dark-mode")
f.user("add a dark mode to the docs theme that follows the system setting, with a toggle in the header")
f.read("theme/docs.css")
f.edit("theme/docs.css", ":root {", "@media (prefers-color-scheme: dark) { :root {")
f.edit("theme/header.tsx", "null", "<ThemeToggle />")
f.bash("npm run build", "built 214 pages in 3.2s")
f.say("Done. The theme follows prefers-color-scheme and the header toggle overrides it, remembered per browser. All 214 pages build.", ctx=52300)
f.done()
ids["F"] = f.save()

# H: lumen, closed
h = Claude("lumen", "Speed up incremental builds", 60 * 50)
h.user("incremental builds rebuild every page when one changes")
h.read("src/build.ts")
h.say("Pages now hash their inputs and skip when nothing changed. A one-page edit rebuilds in 180ms instead of 3s.", ctx=30100)
h.done()
ids["H"] = h.save()

# I: kestrel, closed
i = Claude("kestrel", "Add --json output to status", 60 * 30)
i.user("kestrel status should take --json for scripts")
i.edit("cmd/status.go", "package cmd", "package cmd // json")
i.bash("go test ./...", "ok  	example.com/kestrel/cmd	0.41s")
i.say("`kestrel status --json` prints one object per job. Tests cover both formats.", ctx=21000)
i.done()
ids["I"] = i.save()

# notes, closed
n = Claude("field-notes", "Summarise the async cancellation notes", 60 * 100)
n.user("tidy up 2026/rust-async.md into something I can reread")
n.edit("2026/rust-async.md", "# async notes", "# Cancellation in async Rust")
n.say("Rewrote it as three sections: what drops, what doesn't, and the patterns that make cancellation safe.", ctx=15000)
n.done()
ids["N"] = n.save()

# live session records for A (waiting) and F (idle): pids of placeholder processes
holders = []
def holder():
    p = subprocess.Popen(["sleep", "7200"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    holders.append(p.pid)
    return p.pid

for key, status, extra in [("A", "waiting", {"waitingFor": "approve Bash: cargo test --all"}), ("F", "idle", {})]:
    pid = holder()
    rec = {"pid": pid, "sessionId": ids[key], "cwd": {"A": P["tidepool"], "F": P["lumen"]}[key],
           "status": status, "kind": "interactive", "name": "", **extra}
    w(os.path.join(CL, "sessions", f"{pid}.json"), json.dumps(rec))
w(os.path.join(root, "holders.pid"), "\n".join(map(str, holders)) + "\n")

# ---------- codex rollouts ----------
CX = os.path.join(H, ".codex")
titles = []
reset5 = int((NOW + timedelta(hours=2, minutes=40)).timestamp())
resetw = int((NOW + timedelta(days=3, hours=5)).timestamp())


def codex(project, title, start_min, items, open_turn=False, branch="main", limits=False):
    cid = str(uuid.uuid4())
    t0 = NOW - timedelta(minutes=start_min)
    d = os.path.join(CX, "sessions", t0.strftime("%Y/%m/%d"))
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"rollout-{t0.strftime('%Y-%m-%dT%H-%M-%S')}-{cid}.jsonl")
    m = start_min
    out = []
    def ev(payload, typ="event_msg"):
        nonlocal m
        m = max(m - 0.3, 0)
        out.append({"timestamp": ts(m), "type": typ, "payload": payload})
    ev({"id": cid, "cwd": P[project], "git": {"branch": branch}, "model": "gpt-5.5-codex"}, "session_meta")
    ev({"type": "task_started", "model_context_window": 258400})
    for it in items:
        if it[0] == "prompt":
            ev({"type": "user_message", "message": it[1]})
        elif it[0] == "cmd":
            ev({"type": "item_completed", "item": {"type": "CommandExecution", "command": ["bash", "-lc", it[1]],
                                                    "exit_code": it[2], "aggregated_output": it[3] if len(it) > 3 else "",
                                                    "duration": {"secs": 2, "nanos": 0}}})
        elif it[0] == "edit":
            ev({"type": "item_completed", "item": {"type": "FileChange", "changes": {
                os.path.join(P[project], it[1]): {"type": "update", "unified_diff": it[2]}}}})
        elif it[0] == "plan":
            ev({"type": "function_call", "name": "update_plan", "call_id": "p" + str(len(out)),
                "arguments": json.dumps({"plan": [{"step": s, "status": st} for s, st in it[1]]})}, "response_item")
        elif it[0] == "reply":
            ev({"type": "agent_message", "message": it[1]})
    ev({"type": "token_count", "info": {"last_token_usage": {"input_tokens": 71200}, "model_context_window": 258400},
        **({"rate_limits": {"primary": {"used_percent": 41.0, "window_minutes": 300, "resets_at": reset5},
                            "secondary": {"used_percent": 63.0, "window_minutes": 10080, "resets_at": resetw}}} if limits else {})})
    if not open_turn:
        last = [x[1] for x in items if x[0] == "reply"]
        ev({"type": "task_complete", "last_agent_message": last[-1] if last else "done", "duration_ms": 240000})
    with open(path, "w") as f:
        for l in out:
            f.write(json.dumps(l) + "\n")
    mt = (NOW - timedelta(minutes=m)).timestamp()
    os.utime(path, (mt, mt))
    titles.append({"id": cid, "thread_name": title, "updated_at": ts(m)})
    return cid

codex("tidepool", "Write the events table migration", 60 * 46, [
    ("prompt", "add an events table with a peer foreign key and an index on created_at"),
    ("plan", [("Write 0004_events.sql", "completed"), ("Run the migration", "completed")]),
    ("edit", "migrations/0004_events.sql", "@@\n+create table events (\n+  id integer primary key,\n+  peer_id integer references peers(id),\n+  created_at integer not null\n+);\n"),
    ("cmd", "sqlx migrate run", 0, "Applied 4/migrate events"),
    ("reply", "Added 0004_events.sql with the foreign key and the index; migrations run clean on a fresh database."),
])
codex("tidepool", "Tighten clippy lints", 12, [
    ("prompt", "turn on clippy pedantic for the crate and fix what it finds, skip the doc lints"),
    ("cmd", "cargo clippy -- -W clippy::pedantic", 101, "warning: 23 warnings emitted"),
    ("edit", "src/peer.rs", "@@\n-pub struct Peer { pub addr: String }\n+#[derive(Debug)]\n+pub struct Peer { pub addr: String }\n"),
    ("cmd", "cargo clippy -- -W clippy::pedantic", 0, ""),
    ("reply", "Clippy pedantic is clean except the doc lints you asked me to skip. 23 fixes, all mechanical."),
])
codex("lumen", "Fix broken anchor links in the sitemap", 4, [
    ("prompt", "the sitemap links to anchors that no longer exist. find and fix them"),
    ("plan", [("Collect every anchor the pages define", "completed"), ("Match sitemap links against them", "in_progress"), ("Fix the generator", "pending")]),
    ("cmd", "rg -o 'href=\"#[^\"]+' dist/ | sort -u | wc -l", 0, "412"),
    ("cmd", "node scripts/check-anchors.mjs", 1, "17 broken anchors"),
], open_turn=True, branch="dark-mode", limits=True)
codex("kestrel", "Retry flaky upload test", 60 * 70, [
    ("prompt", "TestUpload fails one run in ten on CI"),
    ("cmd", "go test -run TestUpload -count 50 ./...", 0, "ok"),
    ("reply", "The test raced a goroutine against the server shutdown. It now waits on the done channel; 50 runs pass."),
])
codex("dotfiles", "Move waybar config to the new layout", 60 * 140, [
    ("prompt", "split hyprland.conf into per-topic files"),
    ("reply", "Split into binds, windows and looks, sourced from hyprland.conf."),
])
with open(os.path.join(CX, "session_index.jsonl"), "w") as f:
    for t in titles:
        f.write(json.dumps(t) + "\n")

# ---------- quota (Omarchy-style usage record for claude) ----------
st = os.path.join(root, "state")
w(os.path.join(st, "omarchy/agents/usage/claude.json"), json.dumps({
    "limits": [
        {"label": "Session (5-hour)", "percent": 0.52, "resetsAt": (NOW + timedelta(hours=1, minutes=55)).isoformat()},
        {"label": "Weekly (7-day)", "percent": 0.34, "resetsAt": (NOW + timedelta(days=4, hours=2)).isoformat()},
    ],
    "limitsFetchedAt": int(NOW.timestamp() * 1000), "limitsStale": False, "tierLabel": "Max"}))

# ---------- stand-in agents ----------
bindir = os.path.join(root, "bin")
os.makedirs(bindir)
claude_stub = f"""#!/bin/bash
# stand-in for claude: links itself to session B and draws a static screen
sid={ids['B']}
cat > "{CL}/sessions/$$.json" <<EOF
{{"pid": $$, "sessionId": "$sid", "cwd": "$PWD", "status": "busy", "kind": "interactive"}}
EOF
trap 'rm -f "{CL}/sessions/$$.json"' EXIT
printf '\\e[2J\\e[H\\e[?25l'
cat "{root}/claude-screen.txt"
while :; do sleep 60; done
"""
w(os.path.join(bindir, "claude"), claude_stub)
os.chmod(os.path.join(bindir, "claude"), 0o755)
w(os.path.join(bindir, "codex"), "#!/bin/bash\necho codex stand-in\nsleep 3600\n")
os.chmod(os.path.join(bindir, "codex"), 0o755)
w(os.path.join(bindir, "review"), "#!/bin/bash\ncat >/dev/null\necho 'No blocking issues.'\n")
os.chmod(os.path.join(bindir, "review"), 0o755)

O = "\x1b[38;2;217;119;87m"  # claude orange
D = "\x1b[2m"; R = "\x1b[0m"; B = "\x1b[1m"; G = "\x1b[32m"
screen = f"""{D}>{R} tidepool.conf is a hand-rolled ini format. move it to toml
  with serde and keep Config's fields as they are

{O}●{R} Read(src/config.rs)
  {D}⎿  Read 34 lines{R}

{O}●{R} Update(Cargo.toml)
  {D}⎿  Added 2 lines{R}

{O}●{R} Update(src/config.rs)
  {D}⎿  Added 17 lines, removed 19 lines{R}

{O}●{R} Bash(cargo test config)
  {D}⎿{R}  test result: {G}ok{R}. 6 passed; 0 failed

{O}●{R} The loader now goes through serde, and the six config
  tests pass unchanged. Writing a short migration note for
  existing tidepool.conf files.

{O}●{R} Write(docs/config-migration.md)

{O}✻ Writing the migration note…{R} {D}(18s · esc to interrupt){R}

{D}╭──────────────────────────────────────────────────────────╮{R}
{D}│{R} >                                                        {D}│{R}
{D}╰──────────────────────────────────────────────────────────╯{R}
"""
w(os.path.join(root, "claude-screen.txt"), screen.replace("\n", "\r\n"))

w(os.path.join(H, ".bashrc"), "PS1='\\[\\e[2m\\]\\w\\[\\e[0m\\] \\$ '\n")
# ---------- polypore config ----------
cfg = os.path.join(root, "config/polypore/config.toml")
w(cfg, f"""[ui]
theme = "polypore"
transparent = false

[agents.claude]
command = "{bindir}/claude"

[agents.codex]
command = "{bindir}/codex"

[quota]
claude_probe = false

[review]
command = "{bindir}/review"

[analysis]
wiki = "{H}/nowhere"
""")

print(f"""export HOME={H}
export XDG_CONFIG_HOME={root}/config
export XDG_STATE_HOME={st}
export CLAUDE_CONFIG_DIR={CL}
export CODEX_HOME={CX}
unset DBUS_SESSION_BUS_ADDRESS
export COLORTERM=truecolor
export TERM=tmux-256color
export SHELL=/bin/bash
export EDITOR=nvim
""")
