# Operator IDE — PRD (v2)

> **Audience:** author only. Personal scoping doc. Opinionated; captures decisions, not pitches them.
> **Date:** 2026-05-14
> **Status:** Draft — pre-plan. Replaces the scrapped 2026-05-14-claude-operator-gui.md.
> **Working name:** "Operator IDE" (placeholder; rename before any external mention).

---

## 1. Problem

Every credible agentic-coding tool today is one of:

- **A chat sidebar in someone else's editor** (Cursor, Windsurf, Cline, Roo Code, Continue) — agent is bolted onto a chat-first workflow inside VS Code or a fork of it.
- **A fixed-layout dashboard** (Opcode, OpenHands, Nimbalyst, CodexMonitor) — multi-panel but hardcoded; no float / split / popout / saved workspaces.
- **An orchestrator that lives next to your editor** (Vibe Kanban, Conductor, Claude Squad) — kanban over agents, not an editor.

When you actually drive a long-running coding agent — a 30-minute iterate loop, a multi-phase TDD task, a parallel review pass — the terminal or chat sidebar is one-dimensional and the dashboard is rigid. You can't simultaneously: watch tool calls stream live, scrub the diff stack as it grows, read structured verify output, edit memory mid-session, glance at the dev-server preview, and pop the timeline to a second monitor when you walk between rooms.

There is no Adobe-style operator console for agentic coding. That's the gap.

## 2. Solution

A **Tauri 2.x** desktop application — open source (MIT) — built around three load-bearing ideas:

1. **Adobe-style dockable workspace.** Every surface is a panel. Panels float, split, tab-group, popout to second monitors. **Named workspace presets** (Plan / Implement / Review / Debug / Demo) ship as built-ins; users save their own. The shell delivers what JetBrains/VS Code can't — true Photoshop-grade panel composition for code.

2. **Multi-agent via ACP.** The runtime speaks the **Agent Client Protocol** so Claude Agent SDK, Codex, and any other ACP-capable agent slot in equally. A capability registry handles bidirectional graceful degradation; equivalent features (memory dirs, slash-commands/skills, plugins/MCPs) are swappable per active agent.

3. **Unified change-stream timeline.** Every agent tool call AND every human edit lands on one scrubbable, filterable, retry-from-here timeline. This is the wedge — no IDE today exposes mixed agent + human history as a first-class operator surface.

The product is a real coding IDE (file tree, tabs, LSP, diagnostics, terminal, git status) layered with the operator panels (workflow graph, timeline, verify output, knowledge base, preview, extensions). One workspace, one active agent, one open project.

## 3. Scope

### In (MVP)

- Tauri 2.x desktop shell, MIT license, no telemetry
- Dockview-based panel system with named workspaces (built-in + custom + per-project)
- ACP runtime client; auto-detects `claude` and `codex` on PATH
- Full LSP integration (any installed language server); inline squiggles; Problems panel
- All panels listed in §5
- Header strip (workspace / loop status / context indicator / agent picker)
- Bottom status bar (branch / file encoding / cursor pos / agent state)
- Workflow graph with zoom-level drill-down and `report_phase` MCP tool
- Iterate loop with single knob: **max cycles** before pause-and-ask
- Auto-checkpoint via app-DB file snapshots; **never** touches git without explicit user consent
- Per-task PR-description generation; ADR generation when Claude judges the feature large
- Knowledge base with `[[wikilinks]]` (no backlinks panel, no graph view)
- Notifications via OS-native + optional sound
- Tauri auto-updater, single channel
- Git: file-tree status badges + commit-from-diff-stack only
- Theme: dark-first + light + customizable accent
- VS Code-compatible default keybindings, remappable

### Out (explicit defer)

- Multi-project tabs in one window (open another window)
- Multi-agent simultaneity (one active agent per workspace)
- Mobile companion / push notifications
- Webhook / Slack / Discord integration
- Full Obsidian features (backlinks panel, graph view)
- Beta release channel
- Subagent dedicated UI (parent handles its own subagents inline)
- Cloud sync of layouts / settings / sessions
- Cost-cap and per-cycle timeout knobs (revisit if max-cycles proves insufficient)
- Approval-gate panel (rely on agent CLI's own permission flow surfaced inline in chat)
- Plugin system for third-party panels
- Web build / remote runtime
- Source-control panel beyond minimal lightweight UI
- LSP server bundling / managed install (rely on user-installed servers)

## 4. Architecture

| # | Module | Responsibility | Deletion test |
|---|--------|---------------|---------------|
| 1 | **shell** (Tauri main, Rust) | Window mgmt, native menu, process supervision, FS watchers, OS notifications, auto-update | Can't delete — Tauri entrypoint |
| 2 | **runtime-client** (Rust, in shell) | ACP client; spawns/connects to agent processes; routes events | Earns — protocol boundary |
| 3 | **capability-registry** (TS shared types) | Declares per-agent capabilities; resolves "which implementation backs this feature?" per active agent | Earns — multi-agent abstraction lives or dies here |
| 4 | **event-bus** (Rust + TS shared types) | Typed protocol shell ↔ renderer; backpressure ring buffer | Could fold into shell — typed boundary earns it |
| 5 | **panel-system** (TS, renderer) | Wraps dockview; registers panel types; persists named workspaces | Earns — substitution point for layout engine |
| 6 | **chat-panel** | Conversation stream; one-line tool-call chips that link to timeline; input | Earns |
| 7 | **workflow-panel** | React Flow graph (top); zoom-level drill-down; TodoWrite as sub-checklist; user disable toggle | Earns |
| 8 | **editor-panel** | Monaco + LSP client + tabs + file tree + Ctrl+P fuzzy finder | Earns |
| 9 | **problems-panel** | Aggregated LSP diagnostics; click-to-jump | Earns |
| 10 | **diff-stack-panel** | Per-file changed list → Monaco diff; filter by turn/phase/task | Earns |
| 11 | **preview-panel** | Embedded webview for URLs OR embedded run-output for CLI; agent registers via MCP | Earns |
| 12 | **verify-panel** | Structured test/typecheck/lint output; commands from `.claude/verify.json` | Earns |
| 13 | **memory-panel** | Knowledge-base UI: auto-memory dir + ADRs + PR drafts; `[[wikilinks]]`; FS-watch hot-reload | Earns |
| 14 | **timeline-panel** | Unified agent + human edit stream; scrub; filter; retry-from-here forks worktree | Earns — the wedge lives here |
| 15 | **terminal-panel** | xterm.js + node-pty; multi-tab | Earns |
| 16 | **extensions-panel** | Tabs for Skills / MCP servers / Codex plugins; install / configure / enable | Earns |
| 17 | **search-overlay** | Ctrl+Shift+F popup; ripgrep-backed find / replace | Earns — distinct interaction model from a panel |
| 18 | **header-strip** + **status-bar** | Persistent top + bottom UI: workspace dropdown, loop status, context indicator, agent picker; branch/encoding/cursor/agent state | Folded into shell — small surface |
| 19 | **session-store** (SQLite via `tauri-plugin-sql`) | Conversation, timeline events, file snapshots, audit log | Earns — durability |
| 20 | **settings** (per-user + per-project layered) | Theme, keybindings, accent, project registry, agent overrides, verify commands | Folded into shell |
| 21 | **artifacts** | PR description + ADR generation; file output + knowledge-base entry | Earns — distinct generator pipeline |
| 22 | **mcp-suite** (Node, ships with app) | Built-in MCP servers: `report_phase`, `register_preview`, `verify_commands`, `record_adr` | Earns — owned tool surface |

22 modules, two folded (header-strip+status-bar, settings).

### Process topology

```
┌─────────────────────────────────────┐
│  Renderer (React + TS)              │
│  - dockview                         │
│  - panels (5..17)                   │
│  - capability-registry client       │
└────────────────▲────────────────────┘
                 │ Tauri events (typed)
┌────────────────┴────────────────────┐
│  Shell (Rust, Tauri main)           │
│  - window + workspace mgmt          │
│  - FS watchers                      │
│  - ACP runtime client               │
│  - event-bus router                 │
│  - SQLite session store             │
│  - OS notifications + auto-update   │
└──────┬───────────────────┬──────────┘
       │ ACP (stdio/IPC)    │ MCP (stdio)
┌──────┴────────────┐  ┌────┴──────────────┐
│  Agent process    │  │  Built-in MCP     │
│  (claude / codex) │  │  servers (Node)   │
└───────────────────┘  └───────────────────┘
```

The renderer never speaks ACP directly. The shell's runtime-client owns the agent connection and translates events through the capability registry before publishing on the event bus. The MCP suite is a sidecar Node process that hosts the IDE's own tool surface (`report_phase`, etc.) — agents connect to it as they would to any user-installed MCP server.

## 5. Panels (the meat)

All panels are dockable / floatable / popout-able / tab-groupable / split-able via dockview. Listed below with role and the most surprising decisions baked in.

### 5.1 Chat
- Conversation stream: user + agent text only.
- Tool calls render as **one-line summaries** ("3 tool calls — see timeline ↗") that link the corresponding timeline entries. **No collapsible cards inline.** This is deliberate: chat stays human-readable; timeline is the inspection surface.
- Permission / approval requests from the underlying agent CLI surface as inline interactive messages in chat (same as Claude Code's auto mode does today). No separate approval gate panel.
- Defaults to left dock; movable like any other panel.

### 5.2 Workflow graph
- Lives at the top by default; movable.
- React Flow editor; nodes are "step" type only for MVP (status: pending / running / done / failed).
- **Zoom-level overview → drill-down**: top-level shows phase nodes (brainstorm / plan / red / green / refactor / iterate / ship); clicking or entering a phase expands its sub-checklist.
- Claude generates the graph for the current task and amends it as work evolves. Reports phase progress via the built-in `report_phase` MCP tool. **TodoWrite items become the live sub-checklist under the active node.**
- User can disable workflow tracking entirely per task to save tokens. Disabled = no `report_phase` calls, no graph render.
- User can edit the graph at any zoom level; mid-run revisions are an explicit interrupt.

### 5.3 Editor (file tree + tabs + Ctrl+P)
- File tree (left of tabs by default), with git status badges (M/A/D/U).
- Multiple files open as Monaco editor tabs in the same pane. Tabs split-able and popout-able.
- Ctrl+P fuzzy file finder (overlay).
- **Full LSP integration** — connects to user-installed language servers (rust-analyzer, tsserver, pyright, gopls, …). Inline squiggles, hover, go-to-def, autocomplete. The IDE does not bundle or install language servers.

### 5.4 Problems
- Aggregated LSP diagnostics across the project.
- Filter by severity / file / source. Click to jump.
- Distinct from Verify (5.7) — Problems is live LSP feedback; Verify is structured run results.

### 5.5 Diff stack
- Per-file list of every changed path in the active task; +/- counts; status badges.
- Click a file → opens Monaco side-by-side diff in the main work surface.
- Filter chips: changed this turn / this phase / whole task.
- "Commit selected files" affordance with message input — the **only** GUI-driven git mutation. Asks the user to confirm.

### 5.6 Preview
- Hidden by default until the agent registers a preview via the `register_preview` MCP tool.
- Two modes: embedded webview pointed at a URL (web/dev-server projects), OR embedded interactive run output for CLI projects (xterm-driven sub-process).
- Manual refresh button; agent can also push refresh signals.

### 5.7 Verify output
- Structured display of test / typecheck / lint runs.
- Verify commands declared by Claude on first iterate via the `verify_commands` MCP tool, written to `<project>/.claude/verify.json`. User-editable.
- Each row: command, exit code, ran-at, expand for output. Summary chips (✓ typecheck / ✗ tests / ✓ lint).
- Iterate loop reads these rows to decide "clean."

### 5.8 Memory / knowledge base
- File tree over `~/.claude/projects/<encoded-cwd>/memory/` AND `<project>/.knowledge/` (project-local synthesized docs).
- `MEMORY.md` rendered as the index for the global section.
- ADRs (one per "big" task) and PR-description drafts live under `<project>/.knowledge/`.
- Markdown editor with `[[wikilinks]]` between knowledge-base files. Click a wikilink → jump.
- **No backlinks panel, no graph view in MVP.** Wikilinks-as-citations is the only structural feature.
- Hot-reload via FS watcher.
- Why ADRs matter: they're stored as plain markdown so any agent (Claude, Codex, future) can read them via Read tools. They give the agent the **why of code** when revisiting a file later.

### 5.9 Timeline (the wedge)
- One scrollable, scrubbable stream of every agent tool call AND every human edit (file save) for the active task.
- Each entry: timestamp, source (agent / human), action (tool call / file-write / file-edit), affected file(s), expandable input/output.
- Filter chips: by source, by tool, by file, by phase.
- **Retry from here**: click an agent entry → IDE creates a new git worktree at the file state from that point (using app-DB snapshots) and forks the agent session there. Original timeline preserved; new timeline begins in the new worktree. Non-destructive.
- Backed by app-DB file snapshots taken on every change event; **no git operations triggered automatically**.

### 5.10 Terminal
- xterm.js + node-pty backend.
- Multi-tab, dockable, popout-able.
- Distinct from Verify (Verify shows structured agent runs; Terminal is for ad-hoc human shell commands).

### 5.11 Extensions
- One panel, three tabs:
  - **Skills** (slash commands like `/loop`, `/security-review`, custom)
  - **MCP servers** (Claude-side tool servers; built-ins listed first, then user-installed, then add-by-URL)
  - **Codex plugins** (Codex's equivalent capability registry)
- Per-project enable/disable; install pulls from official registry (defaults) or user-supplied source.

### 5.12 Search overlay
- Ctrl+Shift+F (and a header button) → popup overlay; not a docked panel.
- Ripgrep-backed; query, regex toggle, case toggle, include/exclude globs.
- Find-and-replace mode.
- Result list with click-to-jump; closes the overlay on jump.

### 5.13 Persistent header strip
- Workspace dropdown (Plan / Implement / Review / Debug / Demo / + custom).
- Loop status: cycle N/max, verify checks (✓/✗ chips), seconds-in-cycle, soft-stop button (pause-after-current-cycle), hold-to-confirm hard abort.
- Context indicator: percent used, tokens-remaining, color shifts green→amber→red. Suggests `/compact` at configurable threshold (default 80%).
- Active agent picker (one active per workspace).

### 5.14 Bottom status bar
- Branch, file encoding, cursor line/col, agent connection state.
- Click to open the relevant panel.

## 6. Multi-agent abstraction (ACP)

The runtime-client speaks ACP to whichever agent is active. Each agent declares its capabilities via the protocol; the **capability registry** maps panels/features to backing implementations.

Examples of capability mappings:

| Feature | Claude impl | Codex impl |
|--|--|--|
| Memory dir | `~/.claude/projects/<enc>/memory/` | Codex memory mechanism (whatever it ships) |
| Slash commands | Claude skills | Codex prompt templates |
| Tool servers | MCP servers | Codex plugins |
| Compaction | `/compact` | Codex equivalent |
| Phase reporting | `report_phase` MCP tool | `report_phase` shimmed via Codex plugin (if available) |

If the active agent lacks the capability a panel needs and there's no equivalent, the panel disables itself with a tooltip explaining why. **Bidirectional graceful degradation** — neither agent is the privileged implementation.

## 7. Iterate loop

- **Single configuration knob: max cycles** (default 5). On hitting the cap, the loop pauses and asks the user to continue / abort / change scope.
- Each cycle: agent works → runs the verify suite → reads results → either declares "clean" (loop ends) or starts the next cycle.
- Loop state always visible in the header strip (cycle N/max, current verify result, soft-stop available).
- Soft-stop: "pause after current cycle" — completes whatever the agent is mid-doing, then halts gracefully. Hard abort (hold-to-confirm) interrupts immediately and may leave the worktree in a partial state.
- Auto-checkpoint: end of each cycle, IDE writes a file snapshot to the app DB. Used by timeline retry-from-here.
- **Git is never touched automatically.** If the user wants per-cycle commits to a scratch branch, they opt in per project; default is snapshots-in-DB only.

## 8. Schemas

### 8.1 Workspace layout — `<project>/.knowledge/layouts/<name>.json`
```ts
type Workspace = {
  schemaVersion: 1
  name: string
  dockview: object              // dockview's own toJSON() blob
  panelInstances: Record<string, { panelType: PanelType; props: Record<string, unknown> }>
}
```
Built-in workspaces ship in app resources and are copied to `.knowledge/layouts/` on first use of a project so users can customize them.

### 8.2 Workflow graph — `<project>/.knowledge/workflows/<task-id>.json`
```ts
type WorkflowGraph = {
  schemaVersion: 1
  taskId: string
  title: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  enabled: boolean              // user can disable to save tokens
}

type WorkflowNode = {
  id: string
  position: { x: number; y: number }
  label: string
  level: 'phase' | 'sub'        // top-level vs drill-down
  parentId?: string             // sub nodes belong to a phase
  todoItems?: TodoItem[]        // mirrors current TodoWrite state
}

type WorkflowEdge = { id: string; source: string; target: string }
```
Runtime state (current node, completed, failed, paused) is **separate** and lives in SQLite — never written into the graph file.

### 8.3 Verify commands — `<project>/.claude/verify.json`
```ts
type VerifyConfig = {
  schemaVersion: 1
  commands: VerifyCommand[]
}

type VerifyCommand = {
  id: string
  label: string                 // e.g. "typecheck", "tests", "lint"
  cmd: string                   // shell string
  cwd?: string                  // defaults to project root
  required: boolean             // does iterate-clean require this to pass?
}
```
Claude declares this on first iterate; user-editable thereafter.

### 8.4 Settings — layered
- User: `~/.config/operator-ide/settings.json` (theme, accent, keybindings, default agent, OS-notification opt-ins, sound opt-in, update channel)
- Project: `<project>/.knowledge/settings.json` (overrides above + project-specific: agent choice, max-cycles, enabled MCPs, knowledge-base location)
- Resolution: project overrides user; missing keys fall through.

### 8.5 Capability registry (in-memory)
```ts
type Capability =
  | 'memory-dir' | 'slash-commands' | 'tool-servers'
  | 'compaction' | 'phase-reporting' | 'permission-flow'
  | 'subagent-spawn' | 'streaming' | 'tool-use'

type AgentCapabilityMap = Record<Capability, AgentImpl | null>

type AgentImpl = {
  agent: 'claude' | 'codex' | string
  invoke: (...args: unknown[]) => Promise<unknown>
  meta: { description: string; docsUrl?: string }
}
```
Populated on agent connect via ACP capability discovery + a small per-agent adapter that knows how to map our internal Capability names onto the agent's actual surface.

### 8.6 Timeline event — SQLite row
```sql
CREATE TABLE timeline_events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  source TEXT NOT NULL,         -- 'agent' | 'human'
  kind TEXT NOT NULL,           -- 'tool-call' | 'file-write' | 'file-edit' | 'message' | 'phase-change'
  agent_id TEXT,                -- 'claude' | 'codex' | null
  tool_name TEXT,
  affected_files TEXT,          -- JSON array of paths
  payload TEXT,                 -- JSON: tool input/output, edit diff, etc.
  snapshot_id INTEGER           -- FK to file_snapshots; null when no file change
);

CREATE TABLE file_snapshots (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content BLOB                  -- raw bytes; dedup by hash
);
```

## 9. Edge cases

- **Project dir is non-git**: file-tree status badges hidden; diff stack still works (compares against task-start snapshot); commit-from-diff-stack disabled with tooltip.
- **No language server installed for a file's language**: editor still works; Problems panel shows nothing for that file; tooltip on file-tree row notes "no LSP."
- **Active agent missing on PATH at launch**: first-run prompt (or persistent banner if not first run) with install link + "paste path" override.
- **Agent process crashes mid-loop**: shell auto-restarts up to 3× per minute; surfaces in status bar; after 3 fails, modal.
- **Iterate hits max cycles**: loop pauses, OS notification fires, header strip shows "paused at cycle 5/5 — continue?" with Continue / Abort / Change-Max buttons.
- **User dismisses an inline permission request**: treated as deny; logged in chat.
- **Tool output > 10 MB**: truncate in renderer to 10 MB head + 10 MB tail; full payload available in SQLite via "open in viewer."
- **Diff > 50k lines**: Monaco lazy virtual model; "large diff" indicator.
- **Memory or `.knowledge/` directory missing**: lazy-create on first save.
- **Settings JSON malformed**: load defaults; surface a banner with "open in editor" affordance.
- **Subagent spawned by parent**: appears as a normal tool call entry in chat / timeline; nesting handled by the parent agent's own rendering, not by us.
- **Workspace JSON references a panel type the build doesn't know**: drop silently with a console warning; surface a one-time toast.
- **Float-window off-screen on monitor disconnect**: re-snap to main window on next launch.
- **Agent CLI updated mid-session and capabilities changed**: reconnect; re-discover capabilities; re-render any panels affected.
- **Workflow disabled mid-task by user**: stop emitting `report_phase` calls; freeze graph state at last update; graph panel shows "paused" badge.
- **Two ACP agents on PATH (e.g. user has both claude and codex)**: agent picker in header lists both; user chooses; capability registry switches.
- **Project search via Ctrl+Shift+F while editor is in a popout window**: overlay opens in the main window; jump-to-result focuses main window if needed.

## 10. Failure modes for the GUI itself

1. **Re-rendering on every event-bus message.** Tool calls and timeline events arrive at high frequency. Use refs + manual flush; coalesce text deltas; profile early.
2. **Layout state in React Context only.** Persistence must be its own store (SQLite + JSON files). Context is for delivery.
3. **Capability registry leaking implementation details into panels.** Panels declare *required capabilities*; the registry resolves *backing impls*. Panels must never branch on `agent === 'claude'` directly.
4. **Workflow runtime state contaminating the graph file.** Graph files are pure definition; runtime in SQLite. Audit at save time.
5. **Coupling panels to the event-bus shape.** Each panel takes typed props; an adapter maps events → props.
6. **LSP server crashes blocking the editor.** LSP client must be resilient; restart with backoff; editor falls back to syntax-only.
7. **Auto-checkpoint snapshots ballooning the DB.** Content-hash dedup; periodic GC of snapshots beyond the most recent N per task or older than X.
8. **Built-in MCP suite version drift vs. agent expectations.** Pin MCP suite to app version; reject connections from agents declaring incompatible MCP protocol versions.

## 11. Open questions

1. **`report_phase` adoption by the agent in practice.** Claude has to actually call it. Default approach: prepend a system-prompt addendum at session start documenting the tool. Spike to confirm reliable usage before depending on it for workflow advancement.
2. **Codex ACP support maturity.** ACP is the bet; if Codex's ACP server ships incomplete, we may need a custom adapter for v1. Re-evaluate at build time.
3. **Webview engine for the preview panel on Linux.** Tauri default is WebKitGTK; do most dev-server pages render? Spike before committing.
4. **Monaco bundle size in a Tauri build.** ~3MB minified; acceptable but worth measuring cold-start impact.
5. **Knowledge-base sync between `~/.claude/projects/<enc>/memory/` (global) and `<project>/.knowledge/` (project).** Are these two views in one panel, or two tabs? Default: two top-level sections in the same tree.
6. **Multi-monitor float persistence.** Dockview supports float; the disconnect/reconnect story needs validation.
7. **First-run agent picker UX when neither `claude` nor `codex` is on PATH.** Do we link to install docs and quit, or let the user explore the empty workspace? Default: empty workspace with a persistent install banner.
8. **TodoWrite mirroring frequency.** Polling vs. push-via-MCP-tool. Push is cleaner; needs the agent to call a built-in `sync_todos` tool (or we observe TodoWrite via SDK hooks).
9. **PR-description quality.** Templates per project? Free-form? Default: free-form draft, user edits in the knowledge-base panel.
10. **What constitutes "big enough" for an ADR.** Heuristic for Claude. Default: agent self-judges; user can manually request one anytime.

## 12. Decision log

| Date | Decision | Why |
|------|----------|-----|
| 2026-05-14 | **Tauri 2.x** desktop shell | Lighter binary; native webview; Rust process boundary as natural sandbox |
| 2026-05-14 | **dockview** for panel system | Only TS lib shipping true float/tab/split/popout with serializable state |
| 2026-05-14 | **MIT** license, **no telemetry** | Maximally permissive; cleanest privacy story |
| 2026-05-14 | **ACP** for multi-agent (not custom adapters) | Emerging standard; Zed and Goose already adopting; lets future agents plug in |
| 2026-05-14 | **One active agent per workspace** | MVP-tractable; multi-agent simultaneity deferred |
| 2026-05-14 | **Capability registry** with bidirectional graceful degradation | Neither agent is privileged; swappable equivalents |
| 2026-05-14 | **Full LSP integration**, not Monaco-only | This is a real coding IDE, not just an operator console |
| 2026-05-14 | **Unified change-stream timeline** (agent + human edits, retry-from-here forks worktree) | The wedge; gap #5 from the landscape research |
| 2026-05-14 | **Workflow graph at top, zoom-level drill-down** with Claude updating via `report_phase` | User can disable to save tokens |
| 2026-05-14 | **TodoWrite items become sub-checklist under active workflow node** | One mental model, two zoom levels |
| 2026-05-14 | **Auto-checkpoint = app-DB file snapshots, not git** | Never modify user's git without explicit consent |
| 2026-05-14 | **No approval-gate panel**; rely on agent CLI's permission flow surfaced inline in chat | User judgment: that's solved at the CLI layer |
| 2026-05-14 | **One iterate knob: max-cycles** | Avoid premature configuration surface |
| 2026-05-14 | **Knowledge base = memory + ADRs + PR drafts + `[[wikilinks]]`**; no backlinks/graph view in MVP | ADRs feed back into agent context for "why of code" |
| 2026-05-14 | **Chat shows text + one-line tool-call summary chips**, not inline cards | Forces the timeline to be the inspection surface |
| 2026-05-14 | **Subagents handled by parent agent**, no special UI | Mirror Claude Code's existing model |
| 2026-05-14 | **Skills + MCPs + Codex plugins** in one Extensions panel with tabs | One install surface |
| 2026-05-14 | **Project search = Ctrl+Shift+F overlay**, not a docked panel | Lighter; matches user mental model |
| 2026-05-14 | **VS Code-compatible default keybindings**, remappable | Lowest migration friction |
| 2026-05-14 | **Tauri auto-updater, single channel for MVP** | No beta channel until we have real users |
| 2026-05-14 | **Lightweight git UI**: file-tree badges + commit-from-diff-stack only | "Don't mess with git without permission" |
| 2026-05-14 | **Dark-first Adobe-pro theme + light + customizable accent** | Distinctive; matches operator-console positioning |
| 2026-05-14 | **One project per window** | Multi-project = multiple windows |
| 2026-05-14 | **First-run = project picker → agent picker → "Plan" workspace** | Fastest path to value |
| 2026-05-14 | **OS-native notifications + optional sound** for unattended events | Mobile / webhook / Slack deferred to v2 |
| 2026-05-14 | **Status bar at bottom**: branch / encoding / cursor / agent state | Familiar; minimal scope |
| 2026-05-14 | **Built-in MCP suite** ships with the app: `report_phase`, `register_preview`, `verify_commands`, `record_adr` | Owned tool surface; not user-managed |
| 2026-05-14 | **Worktree-fork on retry-from-here** | Non-destructive; preserves original timeline |

---

## Next step

Hand off to the planning step (file-structure-first) with this PRD as input. The plan should:

- Name every file in §4's module table with a one-liner; deletion-test each.
- Stand up the **event-bus + capability registry contract first** as the integration spine; everything else slots in.
- Identify which modules can parallelize via coder/overseer pairs once the spine is fixed — likely candidates: memory-panel, terminal-panel, search-overlay (largely independent UI surfaces with no cross-deps once event-bus types are frozen).
- First vertical slice per module: the smallest end-to-end behavior (e.g., panel-system v0 = one panel, drag, persist; chat-panel v0 = render hardcoded messages, send to event bus).
- Defer LSP, knowledge-base wikilinks, and the timeline retry-from-here mechanic to slice 2 — they require slice 1's primitives to exist.
