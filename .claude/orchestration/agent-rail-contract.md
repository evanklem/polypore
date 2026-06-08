# Agent Rail — Cohesion Contract

**Plan:** `docs/plans/2026-05-27-agent-rail-finish.md`
**Coders:** A (mcp discovery), B (mcp probe), C (secrets fix), D (shared chrome)
**Repo conventions:** see `CLAUDE.md`. Verify with `npm run typecheck` + `cd src-tauri && cargo check`. Do NOT auto-run vitest.

---

## Shared Types

### `DiscoveredMcp` (new, owned by Coder A)

Location: `packages/host/src/rpc-server.ts` (export alongside `McpServerRecord`)

```ts
export type DiscoveredMcp = {
  /* the user-given name from claude/codex config (e.g. "github"). */
  name: string;
  /* which agent(s) declared it. union when same name appears in both. */
  origins: Array<'claude' | 'codex'>;
  /* HTTP servers have url; stdio servers have command/args/env. */
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

export type DiscoverMcpResponse = { servers: DiscoveredMcp[] };
export type McpDiscoverer = () => DiscoverMcpResponse | Promise<DiscoverMcpResponse>;
```

### `McpTesterInput` / `McpTesterResult` (new, owned by Coder B)

Location: `packages/host/src/rpc-server.ts`

```ts
export type McpTesterInput = {
  url?: string;
  transport: 'http' | 'sse' | 'stdio';
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
};
export type McpTesterResult = { ok: boolean; status?: number; error?: string };
export type McpTester = (input: McpTesterInput) => McpTesterResult | Promise<McpTesterResult>;
```

### `SecretWriter` / `SecretRevealer` (new, owned by Coder C)

Location: `packages/host/src/rpc-server.ts`

```ts
export type SecretWriterInput = {
  id: string;
  value: string;
  scope?: 'user' | 'project';
  service?: string;
};
export type SecretWriter = (input: SecretWriterInput) => SecretEntry | Promise<SecretEntry>;

export type SecretRevealerInput = { id: string; scope?: 'user' | 'project' };
export type SecretRevealerResult = { value: string | null; configured: boolean };
export type SecretRevealer = (input: SecretRevealerInput) => SecretRevealerResult | Promise<SecretRevealerResult>;
```

`SecretEntry` already exists at `packages/host/src/secret-store.ts:1`. Re-use it.

### `SectionHeaderProps` / `EmptyStateProps` (new, owned by Coder D)

Location: `plugins/agent/SectionHeader.tsx` / `plugins/agent/EmptyState.tsx`

```ts
export type SectionHeaderProps = {
  title: string;
  count?: number;
  addLabel?: string;        // omit to hide the inline + button
  onAdd?: () => void;       // required when addLabel set
};
export type EmptyStateProps = {
  message: string;
  ctaLabel: string;
  onAction: () => void;
};
```

---

## Naming Conventions

- **Override hooks:** `setMcpDiscoverer`, `setMcpTester`, `setSecretRevealer`, `setSecretWriter`. Each is `(fn: T | null) => void`. Default state `null` → handler returns sensible empty.
- **Tauri commands:** snake_case (`mcp_discover_external`, `mcp_server_probe`, `secrets_reveal`). Existing convention from `src-tauri/src/secrets.rs`.
- **RPC method names:** dot-namespaced (`mcp.discover`, `secrets.set`). Existing convention from `rpc-server.ts`.
- **Rust modules:** `mcp_discover.rs`, `mcp_probe.rs`. Snake-case file per existing src-tauri layout.
- **Test files:** `<name>.test.ts(x)` per existing repo pattern (e.g. `hostRpcServer.test.ts`).

---

## Invariants

1. **Override-hook pattern:** every new host RPC capability lives in a `setXxx(fn)` method on `PolyporeHostRpcServer`. Default value `null`. The handler does a null-check and returns a sensible empty/false result if no hook is registered. Reference: `setSecretUser` at `rpc-server.ts:546`.

2. **Plugin gate:** new RPC methods MUST NOT appear in `permissionForMethod` in `packages/host/src/plugin-loader.ts:225-285`. Returning `null` from that switch is the deny path. Verify with grep after merge — finding any of `'mcp.discover'`, `'secrets.set'`, `'secrets.reveal'` in plugin-loader.ts is a contract violation.

3. **Renderer-only mode degrades cleanly:** when no Tauri shell is present (`tauriInvoke` returns `undefined`), every new feature must still render and not crash. Empty results, no thrown promises, no console errors. Test this by setting the override hook to `null` and verifying handler returns empty.

4. **Confirm-gated reveal:** `secrets.reveal` MUST call `this.confirmDecider({ kind: 'secret-reveal', message, details })` before returning a non-null value. If decider returns false, return `{ value: null, configured: <true|false based on store> }`. The existing 30-sec auto-hide in `plugins/agent/component.tsx:795` stays.

5. **Discovered MCPs are read-only in renderer:** rows with `origins` populated (i.e. came from discovery) render WITHOUT the × delete button and WITHOUT a scope-cycle chip. The chip is fixed at `claude`, `codex`, or `claude+codex`. The test button stays IF transport is HTTP/SSE (probe can run); hidden if transport is stdio.

6. **CLAUDE.md secrets handling:** the contract from `CLAUDE.md` ("never read raw secrets, only call polypore.secrets.use") applies to spawned agents, not to the renderer itself. The renderer is allowed to reveal because the user clicked through a confirm. Plugin iframes are NOT renderer — they're gated by invariant 2.

---

## Per-Coder Test Specifications

### Coder A — MCP discovery (8 tests + 1 integration)

Files: NEW `src-tauri/src/mcp_discover.rs`, MOD `src-tauri/src/main.rs`, MOD `src-tauri/Cargo.toml`, MOD `packages/host/src/rpc-server.ts`, MOD `packages/sdk/src/host.ts`, MOD `packages/sdk/src/client-runtime.js`, MOD `src/App.tsx`, MOD `plugins/agent/component.tsx`, NEW `plugins/agent/mergeDiscoveredMcps.test.ts`

| # | Test name | Assertion | Surface |
|---|-----------|-----------|---------|
| A1 | `mcp_discover_parses_claude_json` | Fixture `~/.claude.json`-shaped with two `mcpServers` entries → returns 2 results, each `origin="claude"`, transport derived from presence of `url` vs `command` | `mcp_discover.rs::discover()` |
| A2 | `mcp_discover_parses_codex_toml` | Fixture `config.toml` with `[mcp_servers.github]` containing `command`/`args` → returns 1 result, `origin="codex"`, `transport="stdio"` | `mcp_discover.rs::discover()` |
| A3 | `mcp_discover_missing_files_returns_empty` | Both files absent → `Ok(vec![])`, NOT Err | `mcp_discover.rs::discover()` |
| A4 | `mcp_discover_malformed_returns_empty` | Invalid JSON in fixture → `Ok(vec![])` (warning to stderr, no panic) | `mcp_discover.rs::discover()` |
| A5 | `host_mcp_discover_dispatches_to_registered_discoverer` | `setMcpDiscoverer(fn)` then call `mcp.discover` → fn invoked, result returned | `PolyporeHostRpcServer` (via `hostRpcServer.test.ts`) |
| A6 | `host_mcp_discover_returns_empty_when_no_discoverer` | No discoverer set → `{ servers: [] }` | `PolyporeHostRpcServer` |
| A7 | `merge_discovered_mcps_dedupes_by_name_with_union_origins` | claude entry `name=github` + codex entry `name=github` → single row with `origins: ['claude','codex']` | `mergeDiscoveredMcps()` pure helper |
| A8 | `merge_discovered_mcps_managed_wins_on_name_collision` | Managed (polypore) entry shares name with discovered → managed kept, discovered dropped | `mergeDiscoveredMcps()` |
| A-INT | `agent_panel_renders_discovered_mcp_rows_on_mount` | Mount agent panel with stubbed `host.mcp.discover` returning 2 rows → rows appear in DOM with fixed chip, no × button | RTL on `plugins/agent/component.tsx` (touchpoint with D) |

### Coder B — MCP probe (5 tests + 1 integration)

Files: NEW `src-tauri/src/mcp_probe.rs`, MOD `src-tauri/src/main.rs`, MOD `packages/host/src/rpc-server.ts`, MOD `src/App.tsx`

| # | Test name | Assertion | Surface |
|---|-----------|-----------|---------|
| B1 | `mcp_probe_http_ok_returns_ok_true` | Local stub HTTP server returns valid JSON-RPC `tools/list` result → `ProbeResult { ok: true, status: 200 }` | `mcp_probe.rs::probe()` |
| B2 | `mcp_probe_http_non_200_returns_ok_false` | Stub returns 503 → `{ ok: false, status: 503, error }` | `mcp_probe.rs::probe()` |
| B3 | `mcp_probe_http_timeout_returns_ok_false` | Stub doesn't respond → `{ ok: false, error: contains "timeout" }`. Use 1s test timeout. | `mcp_probe.rs::probe()` |
| B4 | `mcp_probe_stdio_returns_unimplemented_error` | Input with `transport: "stdio"` → `{ ok: false, error: contains "stdio" }`. NOT a panic. | `mcp_probe.rs::probe()` |
| B5 | `host_mcp_test_uses_registered_tester` | `setMcpTester(fn)` + call `mcp.servers.test(id)` → fn called with server's input, result stored on server's `lastTest` | `PolyporeHostRpcServer` |
| B-INT | `agent_panel_test_button_invokes_tester` | Render component with a managed MCP, click its test button → registered tester called with that server's url/transport | RTL on `plugins/agent/component.tsx` |

### Coder C — Secrets fix (9 tests + 1 integration)

Files: MOD `src-tauri/src/secrets.rs`, MOD `src-tauri/src/main.rs`, MOD `packages/host/src/rpc-server.ts`, MOD `packages/sdk/src/host.ts`, MOD `packages/sdk/src/client-runtime.js`, MOD `src/App.tsx`, MOD `plugins/agent/component.tsx`, NEW `plugins/agent/secretCreateForm.test.tsx`

| # | Test name | Assertion | Surface |
|---|-----------|-----------|---------|
| C1 | `secrets_reveal_returns_value_after_set` | `secrets_set("foo","bar")` then `secrets_reveal("foo")` → `Ok(Some("bar"))` | Rust `secrets.rs` |
| C2 | `secrets_reveal_returns_none_when_missing` | Never set → `Ok(None)`, NOT Err | Rust `secrets.rs` |
| C3 | `secrets_reveal_respects_project_scope` | Set with `scope="project", project_path="X"`; reveal without project_path → `Ok(None)`. With matching path → `Ok(Some(...))`. | Rust `secrets.rs` |
| C4 | `host_secrets_set_writes_to_store_and_publishes` | `secrets.set` call → `secretStore.set()` invoked, `secrets:changed` published | `PolyporeHostRpcServer` |
| C5 | `host_secrets_set_throws_when_no_store` | No store set → handler throws clear error | `PolyporeHostRpcServer` |
| C6 | `host_secrets_reveal_calls_confirm_decider` | `secrets.reveal` invoked → confirmDecider called once with `kind: 'secret-reveal'` | `PolyporeHostRpcServer` |
| C7 | `host_secrets_reveal_rejection_returns_null_value` | Decider returns false → response `{ value: null, configured: <bool> }` (still reports configured-state truthfully) | `PolyporeHostRpcServer` |
| C8 | `host_secrets_reveal_uses_registered_revealer_when_set` | `setSecretRevealer(fn)` + call reveal (with decider true) → fn called, value returned | `PolyporeHostRpcServer` |
| C9 | `secret_create_form_save_calls_host_secrets_set` | Fill id+value+scope, click save → `host.secrets.set` called with those args; form clears + closes | RTL on `plugins/agent/component.tsx` |
| C-INT | `revealing_configured_secret_returns_value_through_gate` | Full path: set via `host.secrets.set`, then reveal (decider true) → value returned. Decider false → null. | RTL on `plugins/agent/component.tsx` |

### Coder D — Shared chrome (5 tests + 2 integration)

Files: NEW `plugins/agent/SectionHeader.tsx`, NEW `plugins/agent/SectionHeader.test.tsx`, NEW `plugins/agent/EmptyState.tsx`, NEW `plugins/agent/EmptyState.test.tsx`, MOD `plugins/agent/component.tsx`, MOD `src/App.css`

| # | Test name | Assertion | Surface |
|---|-----------|-----------|---------|
| D1 | `section_header_renders_title_and_count_when_provided` | `<SectionHeader title="mcp" count={3} />` → h3 contains "mcp", badge shows "3" | `SectionHeader.tsx` |
| D2 | `section_header_omits_count_when_undefined` | `count` prop absent → no badge element in DOM | `SectionHeader.tsx` |
| D3 | `section_header_renders_add_button_when_label_and_handler_provided` | Both `addLabel` and `onAdd` set → button with that label calls onAdd | `SectionHeader.tsx` |
| D4 | `empty_state_renders_message_and_cta_button` | Renders message text + button with ctaLabel | `EmptyState.tsx` |
| D5 | `empty_state_cta_calls_onaction` | Click CTA → onAction called once | `EmptyState.tsx` |
| D-INT-A | `mcp_empty_state_cta_invokes_host_mcp_discover` | Mount component with no MCPs (managed or discovered), click mcp empty CTA → `host.mcp.discover` called | RTL — TOUCHPOINT WITH CODER A |
| D-INT-C | `secrets_empty_state_cta_opens_create_form` | Mount with no secrets, click secrets empty CTA → form expands with id/value inputs visible | RTL — TOUCHPOINT WITH CODER C |

---

## Integration Touchpoints (Integration Overseer Verifies)

| ID | Touchpoint | Verifying test | Owners |
|----|-----------|----------------|--------|
| T1 | D's mcp `EmptyState` CTA → calls A's `host.mcp.discover` | `D-INT-A` | D + A |
| T2 | D's `SectionHeader` wraps mcp section that A renders discovered rows inside | `A-INT` (also asserts SectionHeader+count present) | A + D |
| T3 | B's `setMcpTester` invoked by existing call site inside the mcp list A renders | `B-INT` | A + B |
| T4 | D's secrets `EmptyState` CTA → opens C's create form | `D-INT-C` | C + D |
| T5 | C's save handler → C's `host.secrets.set` → publishes change → list re-renders | `C-INT` | C |

Integration overseer must run these 5 tests (Vitest names exactly as above) and confirm they pass against the merged tree.

---

## Out of Scope (do NOT do)

- Outbound publish (writing polypore-managed MCPs into `~/.claude.json` / `~/.codex/config.toml`)
- Skill symlinking into `~/.claude/skills/` / `~/.codex/skills/`
- Persisting `mcpServers` (renderer-only mode keeps in-memory; Tauri shell uses discovery + new save form)
- Touching skills' empty-state or body (only its header chrome via SectionHeader if Coder D chooses)
- Modifying `polypore.secrets.use` handler at `rpc-server.ts:1480`
- Any git operation (stage, commit, push) — orchestrator + user own those
