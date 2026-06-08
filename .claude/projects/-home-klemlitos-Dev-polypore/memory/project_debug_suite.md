---
name: project-debug-suite
description: Agentic Debug Suite implementation — architecture decision and slice progress
metadata:
  type: project
---

Implementing the Agentic Debug Suite (spec `docs/specs/2026-05-28-agentic-debug-suite.md`, plan `docs/plans/2026-05-28-debug-suite-slice-1.md`). Started 2026-05-29.

**Key routing decision (diverges from plan's `debug_broker.rs`):** `polypore.debug.*` MCP tools route through the EXISTING host RPC rail (`host_broker` → renderer → `HostRpcServer`), exactly like every other entry in `hostRpcTools` in `server.mjs`. The `HostRpcServer` owns the `debug` state (new StateKey), timeline, trust-gating, and summarization — all unit-testable in vitest. It delegates actual DAP/capture ops to a `DebugRunner` adapter set via `setDebugRunner`, wired in `App.tsx` to Tauri `debug_*` commands → `dap.rs`/`debug_capture.rs`. Browser mode → null runner → blocked/unavailable stubs. This reuses the generic host route rather than copying a third broker (the plan's own deletion test flagged that near-duplication). Constraint: `host_broker` has a 30s timeout, so blocking continue-until-stop in `dap.rs` caps DAP wait ~25s (matches spec's async↔sync open risk).

**Roadblock is non-blocking:** a tool returns `{ blocked, ask }` immediately; panel shows banner; `debug.roadblock.resolve` clears state; agent re-issues. Not a long-held blocked call.

Live `vscode-js-debug` end-to-end and dev-server visual smoke can't be exercised in this env — those stay as the user's manual verification steps. Verifiable here: `npm run typecheck`, vitest on touched files, `cd src-tauri && cargo check`/`cargo test`.
