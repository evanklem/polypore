# Agentic Debug Suite — Design

> **Audience:** author + implementers. Opinionated; captures decisions reached in the 2026-05-28 design grill, not pitches them.
> **Date:** 2026-05-28
> **Status:** Draft — pre-plan. Companion plan: `docs/plans/2026-05-28-debug-suite-slice-1.md`.
> **Working name:** "Debug Suite" (the `debug` panel plugin + `polypore.debug.*` MCP tools).

---

## 1. Problem

Agents debug **blind**. Today claude/codex read static code, sprinkle `console.log`/`print`, re-run, and *guess* from output. They reason about code instead of observing execution. The one tool that would change that — a debugger — is the largest missing IDE function in Polypore (see the assessment: no DAP, no breakpoints, no runtime inspection).

But a classic human step-debugger is the wrong target for an agent-first IDE. The win isn't a breakpoint gutter for the human; it's **giving the agent ground-truth runtime state** so it stops guessing.

## 2. Solution — reproduce-then-inspect, driven by the chat agent

Debugging is two universal phases, regardless of language or app type:

1. **Reach the broken state** (reproduction) — log in, click through, run the command, hit the endpoint.
2. **Inspect it** (introspection) — call stack, variables, expression evaluation (logic); screenshot, DOM/CSS, console, network (visual).

The suite is built around those two phases. Critically:

**There is no separate "debug agent." The debugger is a set of `polypore.debug.*` MCP tools that the existing claude/codex chat agent calls** when it decides debugging will help. The `debug` panel is a **near-passive live visualizer** of that tool activity. You control it the way you control any agent task — Esc in the chat terminal — and the agent proposes fixes **in chat**, not via panel buttons.

This is the Polypore thesis applied to debugging: the agent and human share one investigation, surfaced in the cockpit, but the agent is the actor and chat is the control surface.

## 3. Architecture

Reuses three things Polypore already has:

- **Transport:** `src-tauri/src/lsp.rs` already speaks `Content-Length`-framed JSON-RPC over a spawned subprocess's stdio. **DAP uses identical framing** — `dap.rs` is largely that module with DAP message types.
- **MCP↔Rust bridge:** the secrets broker (`secret_broker.rs`) and host broker (`host_broker.rs`) already route MCP tool calls over a token-authed localhost bridge. `polypore.debug.*` rides the same rails.
- **Capture:** `preview_native.rs` already does webview/native capture and runs dev commands.

```
chat agent (claude/codex CLI, already running in a terminal)
  │  calls MCP tool, e.g. polypore.debug.evaluate { frameId, expr }
  ▼
packages/mcp-server/src/server.mjs   (register beside polypore.secrets.*)
  │  routes via broker (clone secret_broker/host_broker pattern)
  ▼
src-tauri/src/dap.rs            ── DAP client (clone lsp.rs transport)
src-tauri/src/debug_capture.rs  ── screenshot / console / DOM / network
  │  spawns + drives
  ▼
debug adapter (vscode-js-debug · lldb-dap · debugpy · delve)  →  the debuggee
  │  results stream back to the agent (summarized) AND
  ▼
host state `debug` → the `debug` panel renders the investigation live
```

The agent never touches a UI. The panel subscribes to host `debug` state (like `host.diagnostics.*`) and renders.

## 4. Phase 1 — Reproduction (all surfaces, manual in slice 1)

There is **no universal automated driver** — driving is inherently per-surface (web=Playwright, native GUI=per-OS accessibility, CLI=pty). So slice 1 makes the **human the universal driver** and builds **zero cross-platform GUI automation**:

- The agent drives what it trivially can later (web/CLI); for everything — and at every login/wall — it raises a **roadblock handoff**: the tool returns `{ blocked, ask }`, the panel shows a banner with `[ I'm ready ▸ continue ]`, the agent also asks in chat, and the human reproduces the state in the app's **own window** (never embedded — embedding an OS- and language-agnostic interactive app is infeasible; see the preview panel's limits) then continues.
- **Web auto-nav (headed Playwright + secrets-injected login) is phase 1.5**, layered on top without rework.

A reproduction is described as a **Scenario** `{ title, whatsWrong }`, derived from how the agent started the session (or seeded by the panel's "describe an issue → send to chat" box). Scenarios are replayable — they tie into the existing verify/iterate loop (re-run to confirm a fix).

## 5. Phase 2 — Inspection (both routes, all surfaces)

Inspection **is** universal, unlike driving:

- **DAP route (logic; every language/OS):** breakpoints (incl. conditional/logpoints), step, `stackTrace`/`scopes`/`variables`, `evaluate`. Adapters eat OS differences. Slice 1 ships `vscode-js-debug`; `debugpy`/`lldb-dap`/`delve` are config additions, not rework — that's how "all-language" is kept.
- **Capture route (visual/context):** see **§5a** for the full design — CDP for web (delivers all four capabilities at once), OS window capture for native, the pty stream for CLI, and an opt-in masking proxy for cross-surface network.

Breakpoints and the current-stop line render in the **Monaco gutter** (agent-set vs human-set visually distinct) — no code view is rebuilt in the panel.

## 6. MCP surface — `polypore.debug.*`

| Tool | Purpose |
|---|---|
| `debug.start` | begin a session from a Scenario (adapter, launch/attach config) |
| `debug.setBreakpoints` | set/clear breakpoints (condition, hitCount, logMessage) |
| `debug.continue` / `.stepOver` / `.stepIn` / `.stepOut` / `.pause` | execution control (blocking — see §7) |
| `debug.stackTrace` / `.scopes` / `.variables` | inspect the paused frame (summarized — §7) |
| `debug.evaluate` | run an expression in a frame (trust-gated — §8) |
| `debug.capture.screenshot` / `.console` / `.dom` / `.network` | visual/context capture |
| `debug.roadblock.resolve` | (host→agent) the human reproduced the state; resume |
| `debug.sessions` / `.state` | list sessions / current stop |

The **investigation timeline is the rendered log of these calls** — one card per call. The agent doesn't "write" the log; the log *is* its tool activity, so panel and chat never drift.

## 7. Protocol decisions

- **Single driver = the agent.** No human/agent wheel-arbitration (we cut shared co-drive). The human observes and interrupts via chat.
- **Async↔sync bridge:** MCP is request/response; DAP stops are async events. `continue`/`step*` **block until the next `stopped`/`terminated` event or a timeout**, returning the new stop location + a compact state summary + **attribution** `{ reason: breakpoint|step|pause|exception, initiatedBy: agent|human }` (a human-hit breakpoint can resolve the agent's blocking call).
- **State summarization (mandatory — raw DAP dumps blow the context window):** default depth 2, max 50 children/node, collections show first 20 + total count, strings truncated ~2 KB, response soft-capped ~8 KB; every truncation carries `{ ref, more: true }` the agent drills via a follow-up `variables`/`evaluate`. Agent *pulls* detail; it is never *pushed* the heap.

## 8. Safety

`evaluate` runs **arbitrary, possibly side-effecting code** in the debuggee — purity is unenforceable at the protocol level. So this is a **trust model, not a purity switch**, reusing the secrets philosophy:

- Per-session, human-set level: **`observe`** (read stack/variables, no evaluate — default for a fresh session) · **`evaluate`** (side effects possible; every call scrubbed per `POLYPORE_AGENT_SCRUBBED` so debuggee secrets don't leak back through dumps, and logged live as a timeline card) · **`off`**.
- **Not** per-evaluate confirm — that murders the autonomous loop. The live tool-card log + the session kill switch are the guardrails.
- Roadblock handoffs reuse `host.ui.confirm`.

## 9. The panel (UX — decided to wireframe)

Layout: **investigation timeline + evidence pane**. Near-passive visualizer. One active session + a header switcher (`[claude ⌄]`) when multiple agents debug. Status pill: `blocked · inspecting · root-caused · failed · paused`.

**Empty:**
```
┌ debug ──────────────────────────────────────────────┐
│ no active debug session                              │
│ describe an issue and send it to a chat to start:    │
│ ┌──────────────────────────────────────────────────┐│
│ │ what's wrong + how to reproduce…                  ││
│ └──────────────────────────────────────────────────┘│
│                          [ send to ▸ claude ⌄ ]      │  reuses chat-targets picker
│  …or just ask claude/codex to debug it in chat       │
└──────────────────────────────────────────────────────┘
```

**Active:**
```
┌ debug · avatar missing on /settings  [claude ⌄] ● inspecting ┐
├──────────────────────────┬───────────────────────────────────┤
│ INVESTIGATION            │ EVIDENCE                          │
│ 📸 /settings screenshot  │  props.user                       │
│ 🌐 GET /api/me → 200     │   id: "u_42"  name: "Ada"         │
│ 🔴 bp UserCard.tsx:18    │   avatarUrl: undefined ◀          │
│ ⏸  stopped at :18        │   …(click to drill)               │
│ 🔍 eval avatarUrl→undef  │                                   │
│ ▸ proposed fix → in chat │                                   │
└──────────────────────────┴───────────────────────────────────┘
```

**Blocked:**
```
┌ debug · avatar missing on /settings  [claude ⌄] ● blocked ┐
│ 🚧 needs the app at /settings — reproduce it, then        │
│    [ I'm ready ▸ continue ]        (or reply in chat)     │
├──────────────────────────┬────────────────────────────────┤
│ INVESTIGATION            │ EVIDENCE                       │
│ 📸 home screenshot       │ (waiting for you to reach the  │
│ ⏸ blocked: reach /settings│  broken state…)               │
└──────────────────────────┴────────────────────────────────┘
```

Behaviors: cards stream in live with per-card status (running → done/failed); clicking a card shows its payload in EVIDENCE (variables tree w/ drill, screenshot viewer, network/console detail); root cause is mirrored **read-only** with jump-to-line — the fix decision happens in chat; no separate pause control (a header `● debugging… ⃠` just fires the same chat interrupt).

## 10. Scope

**Slice 1:** manual reproduction (roadblock handoffs, human-driven, all surfaces) · DAP route interactive (vscode-js-debug) · capture route (screenshot + console first) · the `debug` panel (3 states, timeline+evidence, switcher, describe→send-to-chat) · Monaco gutter integration · `evaluate` trust + scrub.

**Phased out:** web auto-nav (Playwright) → 1.5 · secrets-injected auto-login → 1.5 · DOM/network capture depth · `debugpy`/`lldb-dap`/`delve` adapters · saved-scenario library · time-travel · full human step-toolbar / co-drive.

## 11. Open questions / risks

1. **Capture transport without Playwright.** Web DOM/console/network needs a CDP attachment. Options: minimal `cdp.rs` (JSON-over-WS) · reuse the preview panel's webview JS bridge · screenshot-only via OS/`preview_native` in slice 1. **Lean:** screenshot+console in slice 1 via existing capture; defer a real CDP client. *Decide in the plan.*
2. **DAP-vs-CDP contention** when debugging client-side JS *and* capturing the same browser over CDP — derisk early. Often dodged because logic (DAP→Node server) and visual (capture→browser) are different targets.
3. **Native window screenshot is per-OS** — bounded but not free; lean on `preview_native` patterns.
4. **Adapter bundling/discovery** — ship/spawn `vscode-js-debug`'s standalone `dapDebugServer.js`; discover others on PATH (mirror the agent PATH-probe in `project.rs`).
