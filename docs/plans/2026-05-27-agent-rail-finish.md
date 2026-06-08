# Finish Agent Page Rail Plan

**Goal:** Make the agent panel's skills/mcp/secrets rail feel complete — discover pre-existing MCPs from claude/codex configs, fix the broken `+ secret` form, replace the `mcp.servers.test` stub with a real probe, and unify the visual chrome.

**Architecture:** Two new Tauri commands (`mcp_discover_external`, `secrets_reveal`) and one Tauri-side override for `mcp.servers.test`. Host RPC gains `mcp.discover`, `secrets.set`, and gates `secrets.reveal` through `confirmDecider`. Override hooks follow the existing `setSecretUser` pattern at `rpc-server.ts:546`. New methods are deliberately omitted from `plugin-loader.ts`'s permission map so iframed plugins cannot reach them — only the loopback renderer route can. The renderer wires discovery on mount, dedupes claude/codex MCPs by name (union → `claude+codex` chip), fills in the secret save handler, and extracts two shared chrome components (`SectionHeader`, `EmptyState`).

**Files:**

```
NEW src-tauri/src/mcp_discover.rs            — parse ~/.claude.json + ~/.codex/config.toml
NEW src-tauri/src/mcp_probe.rs               — HTTP probe for tools/list (stdio: TODO with clear error)
MOD src-tauri/src/secrets.rs                  — add secrets_reveal command
MOD src-tauri/src/main.rs                     — register 3 new commands
MOD src-tauri/Cargo.toml                      — add `toml` crate

MOD packages/host/src/rpc-server.ts           — new hooks (setMcpDiscoverer, setMcpTester, setSecretRevealer);
                                                 new handlers (mcp.discover, secrets.set);
                                                 gate secrets.reveal through confirmDecider
MOD packages/sdk/src/host.ts                  — host.mcp.discover, host.secrets.set
MOD packages/sdk/src/client-runtime.js        — mirror SDK additions

MOD src/App.tsx                                — wire all four Tauri overrides (discoverer, tester, revealer, set)

NEW plugins/agent/SectionHeader.tsx           — h3 + count badge + inline + button (shared chrome)
NEW plugins/agent/EmptyState.tsx              — copy + CTA (mcp + secrets use it)
MOD plugins/agent/component.tsx               — secret save handler;
                                                 discovery hydration on mount;
                                                 mergeDiscoveredMcps helper (dedupe by name);
                                                 swap headers/empty-states to shared components;
                                                 fixed chip + no edit/delete on discovered rows
MOD src/App.css                                — count badge parity, empty-state card styling
```

**Deletion test:**
- `SectionHeader` used 3× (skills already has matching markup, mcp + secrets adopt) — keep.
- `EmptyState` used 2× (mcp + secrets) — borderline, but the CTA logic + ARIA wrap-up makes it worth a component.
- `mcp_probe.rs` could live inside `mcp_super.rs`, but `mcp_super` is for the local polypore-ide MCP supervisor; mixing probes for arbitrary remote servers there muddies the deep module. Keep separate.

---

## Grill — answered before tasks

- **Q: What if `~/.claude.json` or `~/.codex/config.toml` is malformed?**
  A: Return `Ok(vec![])` per file, log a warning to stderr. Silent on UI — empty state still says "Discover from ~/.claude.json". Don't surface JSON parse errors as toasts.

- **Q: Codex MCP entry shape?**
  A: `~/.codex/config.toml` has `[mcp_servers.<name>]` sections with fields like `command`, `args`, `env`. These are stdio servers, not HTTP. Discovery records the command line; the rail shows them as read-only with origin chip. Probe support for stdio is a follow-up (Task 5 punts with clear error message).

- **Q: What if the same name appears in claude (HTTP) and codex (stdio)?**
  A: Still dedupe by name and union chip to `claude+codex`. Surface both transports in the row's tooltip. The merge helper is pure and tested.

- **Q: `confirmDecider` round-trip in renderer-only mode (browser preview)?**
  A: Default decider returns `true` (rpc-server.ts:383). Tauri shell registers the real one. Both work.

- **Q: Plugin permission gating for new methods?**
  A: `mcp.discover`, `secrets.set`, and `secrets.reveal` are deliberately absent from `plugin-loader.ts:225-285`'s `permissionForMethod` switch. Returning `null` means iframed plugins cannot call them. Built-in agent panel uses the loopback host route and bypasses the gate (this is the existing pattern for `host.ui.confirm`).

- **Q: What's the deletion behavior on a discovered MCP if the user removes it from `~/.claude.json` by hand?**
  A: Next mount triggers a fresh `mcp.discover` call — the row vanishes. No file watching needed in this slice (would be nice; defer).

---

## Tasks

### Task 1: Rust `mcp_discover` module

**Files:** `src-tauri/src/mcp_discover.rs` (new), `src-tauri/Cargo.toml`, `src-tauri/src/main.rs`

- [ ] Add `toml = "0.8"` to `src-tauri/Cargo.toml` if absent
- [ ] Failing test: `parses_claude_json_mcp_servers` — fixture `.claude.json` with two entries, asserts both returned with `origin: "claude"`
- [ ] Impl: serde struct for `ClaudeConfig { mcpServers: HashMap<String, ClaudeMcpEntry> }`, parse + collect into `Vec<DiscoveredMcp>`
- [ ] Failing test: `parses_codex_toml_mcp_servers` — fixture `config.toml` with `[mcp_servers.github]` section, asserts `origin: "codex"`, `transport: "stdio"`
- [ ] Impl: serde struct for codex `Config { mcp_servers: HashMap<String, CodexMcpEntry> }`, toml parse
- [ ] Failing test: `missing_files_return_empty_not_error` — both files absent → `Ok(vec![])`
- [ ] Failing test: `malformed_json_returns_empty_with_warning` — invalid JSON → `Ok(vec![])` (warning to stderr)
- [ ] Impl: `discover() -> Result<Vec<DiscoveredMcp>, String>` reads both, merges
- [ ] Expose `#[tauri::command] pub fn mcp_discover_external()` returning serializable struct
- [ ] Register in `main.rs`
- [ ] `cd src-tauri && cargo check`

### Task 2: Host RPC `mcp.discover` + SDK wiring

**Files:** `packages/host/src/rpc-server.ts`, `packages/sdk/src/host.ts`, `packages/sdk/src/client-runtime.js`, `src/spine/hostRpcServer.test.ts`

- [ ] Failing test in `hostRpcServer.test.ts`: `setMcpDiscoverer` registers a fn; `mcp.discover` dispatches to it
- [ ] Impl: `private mcpDiscoverer: McpDiscoverer | null = null;` + `setMcpDiscoverer()` method (mirror `setSecretUser` at line 546)
- [ ] Impl: `registerHandler('mcp.discover', () => this.mcpDiscoverer ? this.mcpDiscoverer() : { servers: [] })`
- [ ] Add `host.mcp.discover()` to `packages/sdk/src/host.ts`
- [ ] Mirror in `packages/sdk/src/client-runtime.js`
- [ ] Do NOT add to `plugin-loader.ts` permission map — renderer-only
- [ ] `npm run typecheck`

### Task 3: Wire discoverer in App.tsx

**Files:** `src/App.tsx`

- [ ] Add `appHostServer.setMcpDiscoverer(...)` near `setSecretUser` at line ~874
- [ ] Body: `tauriInvoke<DiscoveredMcpsResponse>('mcp_discover_external')` → return; if no Tauri shell, return `{ servers: [] }`
- [ ] `npm run typecheck`

### Task 4: Renderer — `mergeDiscoveredMcps` helper + UI integration

**Files:** `plugins/agent/component.tsx`, `plugins/agent/mergeDiscoveredMcps.test.ts` (new)

- [ ] Failing unit test for pure helper:
  - Empty discovered → returns managed unchanged
  - Discovered-only → added with `readonly: true`, `origins: ['claude']` or `['codex']`
  - Same name in claude + codex → single row, `origins: ['claude', 'codex']`
  - Name matches managed → managed wins (treat as if user pulled it into polypore)
- [ ] Impl pure helper
- [ ] On mount: after `host.mcp.servers.list()` resolves, call `host.mcp.discover()` and `setMcpServers(mergeDiscoveredMcps(managed, discovered))`
- [ ] Render: read-only rows show fixed chip (no scope cycle), no × button, no test button (or test button works if transport is HTTP)
- [ ] `npm run typecheck`

### Task 5: Real `mcp.servers.test` via Tauri probe

**Files:** `src-tauri/src/mcp_probe.rs` (new), `src-tauri/src/main.rs`, `packages/host/src/rpc-server.ts`, `src/App.tsx`

- [ ] Failing Rust test: probe against a stubbed local HTTP server returning a valid `tools/list` response → `ProbeResult { ok: true, status: 200 }`
- [ ] Failing Rust test: non-200 status → `ok: false, status, error`
- [ ] Failing Rust test: stdio transport → returns `ok: false, error: "stdio probe not yet implemented"` (clear, not crashing)
- [ ] Impl: reqwest POST with 5s timeout, JSON-RPC envelope `{ jsonrpc, id, method: "tools/list", params: {} }`, parse for `result` vs `error`
- [ ] Expose `#[tauri::command] pub fn mcp_server_probe(url: String, headers: Option<HashMap<String, String>>)` 
- [ ] Host: add `setMcpTester(fn)` hook + change `mcp.servers.test` handler to use it when present (preserve fallback)
- [ ] App.tsx: wire setMcpTester to `tauriInvoke('mcp_server_probe', ...)`
- [ ] `npm run typecheck && cd src-tauri && cargo check`

### Task 6: Rust `secrets_reveal` command

**Files:** `src-tauri/src/secrets.rs`, `src-tauri/src/main.rs`

- [ ] Failing test: `reveal_returns_value_after_set` — `secrets_set` then `secrets_reveal` returns same value
- [ ] Failing test: `reveal_returns_none_when_missing` — never set → `Ok(None)` (not Err)
- [ ] Failing test: `reveal_respects_scope` — set with `scope=project, project_path=X` only reveals when caller provides matching project_path
- [ ] Impl: `#[tauri::command] pub fn secrets_reveal(id: String, scope: Option<String>, project_path: Option<String>) -> Result<Option<String>, String>` reading from keyring
- [ ] Register in main.rs
- [ ] `cd src-tauri && cargo check`

### Task 7: Host `secrets.set` + confirm-gated `secrets.reveal`

**Files:** `packages/host/src/rpc-server.ts`, `packages/sdk/src/host.ts`, `packages/sdk/src/client-runtime.js`, `src/App.tsx`, `src/spine/hostRpcServer.test.ts`

- [ ] Failing test: calling `secrets.set` writes to `secretStore` and republishes `secrets:changed`
- [ ] Impl: `registerHandler('secrets.set', ...)` — calls `this.secretStore.set(...)`; throws if no store
- [ ] Failing test: `secrets.reveal` calls `confirmDecider({ kind: 'secret-reveal', ... })` before returning value; rejection → `{ value: null, configured: true }`
- [ ] Impl: gate the existing handler (rpc-server.ts:1493)
- [ ] Add `setSecretRevealer(fn)` override hook; when set, handler proxies through it instead of `secretStore.reveal()`
- [ ] Add `host.secrets.set(...)` to SDK + client-runtime.js (NOT in plugin-loader permission map)
- [ ] App.tsx: register `setSecretRevealer` to call `tauriInvoke('secrets_reveal')`; register `setSecretSetter` to call `tauriInvoke('secrets_set')` first then mirror into `appSecretStore` for optimistic UI (or write a `setSecretWriter` hook for cleanliness)
- [ ] `npm run typecheck`

### Task 8: Fix `+ secret` form (renderer)

**Files:** `plugins/agent/component.tsx`, `plugins/agent/secretSaveForm.test.tsx` (new)

- [ ] Failing test (RTL): fill id + value + scope, click save → `host.secrets.set` called with those args; form clears and closes
- [ ] Failing test: save with empty id or value disables the button
- [ ] Impl: add `value` input (`type="password"`), `scope` toggle (radio: user/project, default project), `service` field already exists
- [ ] Replace the `close` button at component.tsx:1697 with `cancel` + `save`; save calls a new `createSecret` handler that invokes `host.secrets.set(...)` and refreshes via `host.secrets.list()`
- [ ] Update hint copy: "stored securely in the system keyring; polypore never displays the raw value without confirmation"
- [ ] `npm run typecheck`

### Task 9: Shared `SectionHeader` + `EmptyState` components

**Files:** `plugins/agent/SectionHeader.tsx` (new), `plugins/agent/EmptyState.tsx` (new), `plugins/agent/component.tsx`, `src/App.css`

- [ ] Failing test for SectionHeader: renders `<h3>`, count badge when `count` defined, inline `+` button calling `onAdd`
- [ ] Impl `SectionHeader({ title, count, addLabel, onAdd })`
- [ ] Failing test for EmptyState: renders copy + CTA button calling `onAction`
- [ ] Impl `EmptyState({ icon?, message, ctaLabel, onAction })`
- [ ] Swap mcp section header (component.tsx:1619-1625) → `<SectionHeader title="mcp" count={mcpServers.length + discoveredCount} addLabel="+ server" onAdd={...} />`
- [ ] Swap secrets section header (component.tsx:1674-1681) similarly
- [ ] Skills header (component.tsx:1469-1473) ALSO swap to `SectionHeader` to drive the parity — but keep its existing add button (folder vs skill is contextual; pass `onAdd={null}` and let the existing inline + button stay below)
  - Actually: skills has two + buttons (folder, skill); leave its body alone but use SectionHeader purely for the `<h3 /> + count` chrome. Pass `addLabel={undefined}` to hide the header-level + button.
- [ ] Swap mcp empty (`<li className="mcp-list__empty">` at 1649) → `<EmptyState message="no remote MCPs configured" ctaLabel="discover from ~/.claude.json" onAction={() => host.mcp.discover().then(...)} />`
- [ ] Swap secrets empty (`<li className="secret-list__empty">` at 1702) → `<EmptyState message="no secret handles configured" ctaLabel="add a project secret" onAction={() => setCreatingSecret(true)} />`
- [ ] CSS: count badge styling at `.section-header__count` mirroring `.skillset__count` (line ~8181 of App.css); empty-state card styling
- [ ] `npm run typecheck`

### Task 10: Visual verification

**Files:** none (manual)

- [ ] Run `npm run dev`, open the agent panel
- [ ] Verify: skills section unchanged visually; mcp + secrets headers now show count + inline +; empty states show CTA buttons
- [ ] Verify: clicking mcp empty-state CTA triggers discovery (in browser preview returns empty, which is correct)
- [ ] Verify: + secret form has value input, scope toggle, save button; saving creates a row
- [ ] Per CLAUDE.md: do NOT auto-run vitest. Report and stop.

### Hand-off

After Task 10 verifies clean: hand off to `evanflow-iterate` for a fresh-eyes pass on the touched files. On clean iterate, stop and report. User decides whether to commit.

---

## Parallelization

This plan has **4 independent tracks** sharing the `packages/host/src/rpc-server.ts` interface contract:

- **Track A (MCP discovery):** Tasks 1 → 2 → 3 → 4
- **Track B (Real MCP probe):** Task 5
- **Track C (Secrets fix):** Tasks 6 → 7 → 8
- **Track D (Shared chrome):** Task 9

Tracks A, B, C, D don't import each other's new files. They DO all touch `rpc-server.ts`, `App.tsx`, and `plugins/agent/component.tsx` — so merge conflicts are likely without coordination.

Parallel implementation was considered here, but the conflict surface on 3 shared files is real. Keep this plan sequential unless the user explicitly asks to split the work.

Recommended path: **sequential via `evanflow-executing-plans`** unless you specifically want parallel speed-up. The grill above is the spec; tasks are scoped tight enough to run cleanly back-to-back.
