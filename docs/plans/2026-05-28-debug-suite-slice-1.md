# Debug Suite — Slice 1 Plan

**Goal:** Ship the first agentic debugger: the chat agent (claude/codex) can, via `polypore.debug.*` MCP tools, attach a DAP debugger to a JS/TS target, set breakpoints, run to a stop, inspect summarized variables, and `evaluate` — with a `debug` panel that renders the investigation live, a roadblock-handoff banner for manual reproduction, and a "describe an issue → send to chat" starter. Capture route lands as screenshot + console. Spec: `docs/specs/2026-05-28-agentic-debug-suite.md`.

**Architecture:** A Rust DAP client (`dap.rs`) clones the `lsp.rs` `Content-Length` stdio transport and manages sessions + the async-stop→blocking-`continue` semantics. `polypore.debug.*` tools register in the MCP server and route to Rust through a `debug_broker` modeled on `secret_broker.rs`/`host_broker.rs`; the same handlers are exposed on `HostRpcServer` so the renderer-loopback path works in browser mode. Every tool call mutates host `debug` state (new `StateKey`), which the `debug` panel subscribes to (like `host.diagnostics.*`) and renders as the investigation timeline + evidence pane. Breakpoints/stop project into the Monaco gutter via the existing editor. `evaluate` is gated by a per-session trust level and scrubbed. Capture (screenshot+console) reuses `preview_native` capture; DOM/network deferred (no CDP client in slice 1).

**Files:**

```
NEW src-tauri/src/dap.rs                  — DAP client: spawn adapter, Content-Length framing
                                            (mirror lsp.rs), request/response correlation, event
                                            loop, session registry, blocking continue-until-stop
NEW src-tauri/src/debug_broker.rs         — token-authed localhost bridge for debug.* (mirror
                                            secret_broker.rs); injected into the MCP sidecar
NEW src-tauri/src/debug_capture.rs        — screenshot (reuse preview_native) + console capture
MOD src-tauri/src/main.rs                 — register debug_* Tauri commands; start debug_broker
MOD src-tauri/src/mcp_super.rs            — inject POLYPORE_DEBUG_BROKER_URL/TOKEN into sidecar
MOD src-tauri/Cargo.toml                  — DAP types crate (dap) or hand-rolled types

MOD packages/mcp-server/src/server.mjs    — register polypore.debug.* tools; route via broker
                                            (beside polypore.secrets.*); summarize variable dumps
MOD packages/host/src/rpc-server.ts       — debug.* handlers + 'debug' StateKey + setDebugRunner
                                            hook (mirror setSecretRevealer at ~rpc-server.ts:546);
                                            gate evaluate through session trust
MOD packages/sdk/src/host.ts              — host.debug.* surface (start/breakpoints/continue/
                                            stackTrace/variables/evaluate/capture/state/subscribe)
MOD packages/sdk/src/client-runtime.js    — mirror SDK additions
MOD src/App.tsx                           — wire the debug_* Tauri overrides into the host server

NEW plugins/debug/index.ts                — manifest + plugin registration (defaultOrder)
NEW plugins/debug/polypore.json           — panel manifest
NEW plugins/debug/component.tsx           — the panel: timeline + evidence + roadblock banner +
                                            session switcher + describe→send-to-chat (empty state)
NEW plugins/debug/timeline.tsx            — investigation card list (one card per debug.* call)
NEW plugins/debug/evidence.tsx            — variables tree (drill), screenshot viewer, console
MOD plugins/editor/component.tsx          — render agent/human breakpoint glyphs + stop-line deco
MOD src/workspaces/presets.ts             — add `debug` panel to the Debug workspace preset
MOD src/styles/misc.css (or App.css)      — panel chrome consistent with agent/verify panels

REUSE plugins/shared/chat-targets.ts      — the describe→send-to-chat box uses the existing picker
```

**Deletion test:**
- `dap.rs` vs folding into `lsp.rs`: shared *transport*, but DAP's session/stop/event model is distinct behavior behind a distinct interface — keep separate; optionally extract the framing into a tiny shared `jsonrpc_stdio` helper both use (only if the duplication is real, not speculative).
- `debug_broker.rs` vs reusing `host_broker.rs`: debug needs its own token + injected env var; the broker bodies are near-identical, so **extract a shared broker primitive** rather than a third copy (same lesson as `chat-targets.ts` today).
- `timeline.tsx`/`evidence.tsx` split from `component.tsx`: each is non-trivial and independently testable — keep. If either stays <40 lines, inline it.
- `debug_capture.rs` vs `preview_native.rs`: capture *reuses* preview_native primitives but the debug-session framing differs; thin wrapper, keep adjacent.

**Tasks** (ordered vertical slices; each starts with a failing seam test — `evanflow-tdd`):

0. **Contract + RED.** Define `polypore.debug.*` tool schemas, the `debug` host-state shape (`{ session, timeline[], roadblock?, status }`), the card type, and the summarization contract. Failing test: `host.debug.start` returns a session id and publishes `debug` state.
1. **Thin end-to-end slice.** `dap.rs` transport + spawn `vscode-js-debug` `dapDebugServer` + `debug.start`/`setBreakpoints`/`continue` (blocking until `stopped`, with attribution) → emits one timeline card → panel renders the timeline + status pill. *Proves the whole pipe.* RED: setting a breakpoint and continuing yields a `stopped` card with `{ reason, initiatedBy }`.
2. **Inspect + summarize + trust.** `stackTrace`/`scopes`/`variables` with the depth/budget caps + `{ ref, more }` drill; `evaluate` gated by session trust (`observe` default) + scrub + card log. Evidence pane renders the variables tree with click-to-drill. RED: a deep object returns ≤ caps and a `more` ref; `evaluate` in `observe` mode is refused.
3. **Editor integration.** Breakpoint glyphs (agent vs human distinct) + stop-line decoration in `plugins/editor/component.tsx`. RED: an agent breakpoint shows a distinct gutter glyph at the right line.
4. **Roadblock handoff.** Blocked protocol: a tool returns `{ blocked, ask }` → `debug` state carries `roadblock` → panel banner `[ I'm ready ▸ continue ]` + `roadblock.resolve` resumes; reuse `host.ui.confirm`/chat. RED: a blocked session shows the banner; resolve clears it and the agent's call resumes.
5. **Capture route.** `debug_capture.rs` screenshot (via `preview_native`) + console → `capture.*` tools → capture cards + evidence viewer (image, console excerpt). RED: `capture.screenshot` produces an image card whose payload renders in EVIDENCE. *(DOM/network = noted TODO with a clear "needs CDP" error, mirroring `mcp_probe.rs`'s stdio stub.)*
6. **Panel shell + sessions + starter.** Empty state with the describe→send-to-chat box (reuse `chat-targets.ts`), one active session + header switcher, root-cause read-only mirror with jump-to-line, Debug-workspace preset entry. RED: the describe box sends a debug-framed prompt to the picked chat target; switcher follows the active session.

**Verification:** `npm run typecheck` after each task; `cd src-tauri && cargo check` for every Rust task; per-task vitest run on the touched files only (the full suite is the user's to run — see the project memory). Manual smoke in the dev server: start a session against a tiny Node fixture, hit a breakpoint, drill a variable, trigger and resolve a roadblock.

**Out of scope (this plan):** web auto-nav / Playwright, secrets-injected auto-login, DOM + network capture, `debugpy`/`lldb-dap`/`delve` adapters, saved-scenario library, time-travel, full human step-toolbar / co-drive. (See spec §10.)

**First shippable midpoint:** Tasks 0–4 = a working DAP logic-debugger the agent drives end-to-end (no capture yet). Tasks 5–6 add the visual route and the panel polish. Natural place to pause and re-grill before widening.
