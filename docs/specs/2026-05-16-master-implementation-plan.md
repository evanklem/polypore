# Polypore — Master Implementation Plan

> **Date:** 2026-05-16
> **Status:** Spine document. Single source of truth for implementation order, contracts, and panel-by-panel behavior.
> **Working name:** Polypore. (Renamed from "Operator IDE".)
> **Replaces nothing.** Lives alongside `docs/specs/2026-05-14-operator-ide-prd.md` (the PRD) and `docs/ui-direction.md` (the visual brief).

---

## 0. Document precedence

Three documents describe the product. They sometimes disagree. Resolve disagreements top-down:

1. **Frozen mockup** at `docs/mockups/2026-05-16-build-workspace/`. Verbatim copy of the React mockup as of 2026-05-16. When the mockup renders something that contradicts any other doc, **the mockup wins.** Drift is a documentation bug, not a mockup bug.
2. **This master plan.** Architecture, contracts, milestones. Resolves how to build what the mockup shows.
3. **PRD** (`2026-05-14-operator-ide-prd.md`). Original product scoping. Useful for "why," superseded by this plan for "how."
4. **UI direction** (`ui-direction.md`). Visual brief. Subordinate to the mockup since the mockup is itself the realized visual direction.

When this plan and the mockup disagree, fix this plan. When the PRD and the mockup disagree, the mockup is right. Do not patch the mockup to match the docs.

---

## 1. North star

A desktop IDE for driving agentic coding sessions. Three load-bearing properties:

1. **Adobe-style modularity.** Every surface is a panel. Panels are runtime-loaded plugins talking to the host through a typed RPC. Built-in panels and third-party panels live under the same contract — there is no privileged tier.
2. **Agent- and language-agnostic.** Skills, orchestration, MCP servers, and the entire IDE-control vocabulary are available to any ACP-capable agent (Claude, Codex, Cursor, future). The IDE never branches on `agent === 'claude'` in a panel.
3. **Agent ↔ IDE coherence.** The agent can add tasks, read problems, see live editor state, drop knowledge docs, open panels, register previews, and read a canonical manual describing the IDE's full capability surface. All through one MCP server.

The final result must look and feel like the frozen mockup. Visual fidelity is a hard requirement, not an aspiration.

---

## 2. Tech stack & migration

| Layer | Choice |
|--|--|
| Desktop shell | **Tauri 2.x** (Rust) |
| Renderer build | **Vite** |
| Renderer framework | **React 18 + TypeScript (strict)** |
| Panel layout | **dockview** |
| Editor | **Monaco** (LSP client) |
| Terminal | **xterm.js (renderer) + `portable-pty` (Rust)** — no Node-side pty bridge |
| Secrets | **OS keyring** via Rust `keyring` crate — never plaintext on disk; never in renderer memory |
| Workflow graph | **React Flow** |
| Persistence | **SQLite** via `tauri-plugin-sql` + JSON files in `<project>/.knowledge/` |
| Agent protocol | **ACP** (Agent Client Protocol) |
| Tool protocol | **MCP** (Model Context Protocol) — both consumed (user-installed servers) and produced (built-in `polypore-ide` server) |
| Plugin sandbox | iframe with `postMessage` RPC (renderer-side); separate Node sidecar for trusted host-process plugins (deferred to phase 3) |

**Migration order** (locked in §16):

1. **Stack swap first.** CRA → Vite. Scaffold Tauri 2.x shell around the existing renderer. Wire dockview as the layout engine (replacing the hand-rolled `dockspace` grid). Lock the integration spine (`src/core/`).
2. **Plugin contract second.** Stand up the manifest, host RPC, and built-in plugin loader. Port one panel (Chat) end-to-end through the new contract as a proof.
3. **Surfaces third.** Port the rest of the mockup's panels one at a time, each as a plugin under the contract.
4. **MCP server fourth.** Build the `polypore-ide` MCP server alongside the panels; wire each tool as the corresponding panel's host API is finalized.
5. **Real integrations last.** Monaco/LSP, xterm + portable-pty, ACP runtime client, SQLite persistence, OS keyring secrets — slotted in once the seams are stable.

No "build everything then plug it in" phase. Each milestone produces a runnable app.

---

## 3. Process topology

```
┌──────────────────────────────────────────────────────────┐
│  Renderer (Tauri webview)                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Host (privileged React app)                       │  │
│  │  - dockview layout                                 │  │
│  │  - panel registry + plugin loader                  │  │
│  │  - event bus (typed)                               │  │
│  │  - capability registry                             │  │
│  │  - host RPC server (postMessage)                   │  │
│  │  - chrome (top bar, bottom bar, tab strip)         │  │
│  │  - overlays (settings, help/manual)                │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │
│  │  panel:chat │  │  panel:edit │  │  panel:...  │  …    │
│  │  (iframe)   │  │  (iframe)   │  │  (iframe)   │       │
│  └─────────────┘  └─────────────┘  └─────────────┘       │
└────────────────▲─────────────────────────────────────────┘
                 │ Tauri events (typed)
┌────────────────┴─────────────────────────────────────────┐
│  Shell (Rust)                                            │
│  - window/process supervision                            │
│  - FS watchers, OS notifications, auto-update            │
│  - ACP runtime client                                    │
│  - SQLite session store                                  │
│  - portable-pty terminals                                │
│  - secrets manager (OS keyring; agent never sees values) │
│  - polypore-ide MCP server supervisor                    │
└──────┬──────────────────────────────────┬────────────────┘
       │ ACP (stdio/IPC)                  │ MCP (stdio)
┌──────┴──────────────┐  ┌────────────────┴───────────────┐
│  Agent process      │  │  polypore-ide MCP server       │
│  (claude/codex/...) │◄─┤  + user-installed MCP servers  │
└─────────────────────┘  └────────────────────────────────┘
```

Key boundaries:

- **The renderer never speaks ACP.** Only the Rust shell does. The shell's ACP runtime client receives the agent's tool-call stream and re-publishes each event onto the renderer's event bus over Tauri IPC. That is how agent tool calls land in `polypore.diff-history` (the history surface).
- **The host never speaks MCP directly to the agent.** The `polypore-ide` MCP server is a separate Node sidecar process. The Rust shell supervises it (spawn, restart, kill). The agent connects to it like any other MCP server (over stdio when the agent is local). The MCP server then forwards each tool call into the renderer host over a private named-pipe socket (Unix domain socket on Linux/macOS, named pipe on Windows) that the shell opens at startup and proxies through to the renderer via Tauri IPC.
- **Three-leg topology, single direction at each hop:**
  1. agent ↔ MCP server: stdio (MCP wire protocol)
  2. MCP server ↔ shell: local socket (JSON envelopes mirroring §21)
  3. shell ↔ renderer: Tauri IPC events
- **Panels never reach into the host directly.** Every panel call is RPC even if both sides are JavaScript.

---

## 4. Panel plugin architecture (the spine)

This is the load-bearing decision. Get the contract right and everything else falls in line. Get it wrong and we relive every "extensions came too late" pain VS Code has spent a decade unwinding.

### 4.1 The principle

**Every panel is a plugin.** Built-in panels (chat, editor, preview, …) are shipped as bundled plugins under the same loader, manifest, and host API that a third-party plugin would use. Internal access shortcuts are forbidden — if a built-in panel can do X, a third-party panel can do X.

### 4.2 Manifest

```ts
// packages/sdk/src/manifest.ts
export type PanelManifest = {
  schemaVersion: 1;
  id: string;                     // unique: "polypore.chat", "com.acme.foo"
  title: string;                  // lowercase display name: "chat"
  icon: string;                   // 2-3 char glyph used in the tab strip
  entry: string;                  // relative path to the plugin's HTML entry
  permissions: HostPermission[];  // declared up front; user prompts on first use
  capabilities: Capability[];     // capabilities the panel REQUIRES of the agent
  category: 'editor' | 'agent' | 'verify' | 'knowledge' | 'runtime' | 'other';
  defaultArea?: 'center' | 'left' | 'right' | 'bottom';
  settings?: PanelSettingSchema;  // rendered by the host in the settings overlay
  manual?: PanelManualContent;    // rendered by the host in the help overlay
};
```

Manifests live at `<plugin-root>/polypore.json`. The host's plugin loader scans:

- `/<app-resources>/plugins/` (bundled built-ins)
- `~/.config/polypore/plugins/` (user-installed)
- `<project>/.polypore/plugins/` (per-project)

### 4.3 Host RPC (the API panels actually use)

Panels load in iframes. They import a thin SDK that wraps `postMessage` in a typed promise-based RPC. The SDK is the only thing a panel imports from the host.

```ts
// packages/sdk/src/host.ts
export interface PolyporeHost {
  // identity
  panel: { id: string; instanceId: string };

  // state observation
  state: {
    subscribe<K extends StateKey>(key: K, fn: (v: StateValue<K>) => void): Unsubscribe;
    get<K extends StateKey>(key: K): Promise<StateValue<K>>;
  };

  // editor
  editor: {
    open(path: string, opts?: { line?: number; col?: number }): Promise<void>;
    read(path: string): Promise<string>;
    applyEdit(path: string, edits: TextEdit[]): Promise<void>;
    onChange(path: string, fn: (content: string) => void): Unsubscribe;
  };

  // knowledge base
  knowledge: {
    list(): Promise<KnowledgeNode[]>;
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    onChange(fn: (path: string) => void): Unsubscribe;
  };

  // tasks
  tasks: {
    list(): Promise<Task[]>;
    add(task: Omit<Task, 'id' | 'createdAt' | 'createdBy'>): Promise<Task>;
    update(id: string, patch: Partial<Pick<Task, 'label' | 'done' | 'parentId' | 'panelHint'>>): Promise<void>;
    onChange(fn: (tasks: Task[]) => void): Unsubscribe;
  };

  // problems & diagnostics
  diagnostics: {
    list(filter?: DiagnosticFilter): Promise<Diagnostic[]>;
    onChange(fn: (d: Diagnostic[]) => void): Unsubscribe;
  };

  // verify
  verify: {
    runs(): Promise<VerifyRun[]>;
    run(id: string): Promise<VerifyRun>;
    onChange(fn: (runs: VerifyRun[]) => void): Unsubscribe;
  };

  // chat / agent
  chat: {
    sessions(): Promise<ChatSession[]>;
    send(sessionId: string, text: string): Promise<void>;
    onMessage(fn: (m: ChatMessage) => void): Unsubscribe;
  };

  // history / timeline (the diff-history surface in the mockup)
  history: {
    events(filter?: HistoryFilter): Promise<HistoryEvent[]>;
    fork(eventId: string): Promise<WorktreeRef>;
    revert(eventId: string): Promise<void>;
    onAppend(fn: (e: HistoryEvent) => void): Unsubscribe;
  };

  // workspace + panels
  workspace: {
    activePanel(): Promise<string>;
    openPanel(panelId: string, opts?: OpenPanelOpts): Promise<string>;
    closePanel(instanceId: string): Promise<void>;
  };

  // preview
  preview: {
    register(target: Omit<PreviewTarget, 'id' | 'registeredAt'>): Promise<PreviewTarget>;
    refresh(): Promise<void>;
    onChange(fn: (target: PreviewTarget | null) => void): Unsubscribe;
  };

  // terminal
  terminal: {
    spawn(cmd?: string): Promise<TerminalRef>;
    write(ref: TerminalRef, data: string): Promise<void>;
    onData(ref: TerminalRef, fn: (data: string) => void): Unsubscribe;
  };

  // ui
  ui: {
    notify(level: 'info' | 'warn' | 'error', msg: string): Promise<void>;
    confirm(msg: string): Promise<boolean>;
    openExternal(url: string): Promise<void>;  // hands URL to system browser (xdg-open / open / start)
  };

  // skills (cross-agent prompt fragments living on the filesystem)
  skills: {
    list(scope?: SkillScope): Promise<SkillRef[]>;
    read(id: string): Promise<Skill>;
    create(skill: Omit<Skill, 'createdAt' | 'updatedAt' | 'scope'> & { scope: SkillScope }): Promise<Skill>;
    update(id: string, patch: Pick<Skill, 'name' | 'summary' | 'body'>): Promise<Skill>;
    delete(id: string): Promise<void>;
    // Load a skill into the active chat session as a header-prefixed message.
    // The agent reads it like any user message; this is how skills "activate."
    invoke(id: string, sessionId: string): Promise<void>;
    onChange(fn: (skills: SkillRef[]) => void): Unsubscribe;
  };

  // secrets (the agent never receives values; only references)
  secrets: {
    list(scope?: SecretScope): Promise<SecretRef[]>;        // names only, never values
    has(id: string, scope?: SecretScope): Promise<boolean>;
    // Use a stored secret to make an authenticated outbound call. The Rust shell
    // substitutes the value at request time; the response is scrubbed of any
    // header or body string that matches the secret before returning.
    use(req: SecretInvoke): Promise<SecretInvokeResult>;
  };

  // mcp invocation (panels can ask the agent's MCP servers to do things; auth
  // resolved via secrets.use under the hood when authRef is set)
  mcp: {
    invoke(req: McpInvoke): Promise<unknown>;
  };

  // subscription management (used by every onChange/onMessage method via the SDK)
  subscription: {
    release(id: string): Promise<void>;
  };
}
```

Every method is async because every call crosses an RPC boundary, even when both sides are in the same process today. This forces panel authors to treat the host as remote from day one — when we shard a panel out to a Worker or move the host to Rust, no panel code changes.

### 4.4 Permissions

Each manifest declares which host surfaces the panel touches:

```ts
type HostPermission =
  | 'state.read'
  | 'editor.read' | 'editor.write'
  | 'knowledge.read' | 'knowledge.write'
  | 'tasks.read' | 'tasks.write'
  | 'diagnostics.read'
  | 'verify.read' | 'verify.run'
  | 'chat.read' | 'chat.send'
  | 'history.read' | 'history.fork' | 'history.revert'
  | 'workspace.read' | 'workspace.write'
  | 'preview.register'
  | 'terminal.spawn'
  | 'ui.notify' | 'ui.confirm' | 'ui.openExternal'
  | 'secrets.list' | 'secrets.use'      // .list returns names only; .use never exposes values
  | 'mcp.invoke'
  | 'skills.read' | 'skills.write' | 'skills.invoke';
```

First-party plugins ship with the permissions they need pre-approved. Third-party plugins prompt the user on first use of a guarded surface.

**There is no `secrets.read` permission.** Reading a secret value is not an operation any plugin or agent can ever perform. The strongest grant is `secrets.use`, which lets you invoke an outbound call where the Rust shell substitutes the value at the network boundary.

### 4.5 Lifecycle

```
discovered → loaded (manifest parsed)
         ↓
       opened (instance created, iframe mounted)
         ↓
       active (handshake complete, host RPC ready)
         ↓
       closed (instance destroyed; manifest stays cached)
```

The host emits panel lifecycle events on the event bus so other panels and the MCP server can react ("agent panel just closed — pause formation updates").

### 4.6 The built-in plugins

The mockup defines exactly these panels (frozen as of 2026-05-16):

| Plugin id | Panel role |
|--|--|
| `polypore.chat` | Conversation surface with multi-session tab strip |
| `polypore.preview` | Active runtime output (web, cli, mobile, game, test) |
| `polypore.editor` | Monaco editor with file tree, fuzzy finder, LSP |
| `polypore.diff-history` | Diff stack fused with history rail; fork/revert from any restore point |
| `polypore.terminal` | xterm shell |
| `polypore.verify` | Problems + checks + drag-to-fix queue |
| `polypore.memory` | Context list + knowledge-base tree + document pane |
| `polypore.agent` | Activity + tasks + formation hierarchy canvas |
| `polypore.problems` | Aggregated LSP diagnostics (sub-surface; may fold into verify) |

Each gets its own per-panel section in §11.

---

## 5. Agent ↔ IDE: the `polypore-ide` MCP server

### 5.1 Why one server

A single MCP server exposes the entire IDE-control vocabulary. Reasons:

- **Race-free.** Reads and writes share one channel; the host can serialize.
- **Agent-agnostic by construction.** Any agent that speaks MCP gets the same powers. Claude, Codex, Cursor, future. No per-agent adapter to maintain.
- **One audit log.** Every IDE action the agent takes lands in one place.
- **Discoverable.** One `polypore.manual` tool returns a canonical, agent-readable description of the IDE — so any model can self-orient.

### 5.2 Tool surface (v1)

Grouped by host capability. Each tool is a thin shim over the corresponding host RPC.

**Awareness**
- `polypore.manual()` → markdown describing the entire IDE: panels, what they do, what tools to use for what. Cached; cheap.
- `polypore.workspace.describe()` → currently active workspace, open panels, active panel.
- `polypore.state.get(key)` → arbitrary state key read.

**Editor**
- `polypore.editor.open({path, line?, col?})`
- `polypore.editor.read({path})`
- `polypore.editor.apply_edit({path, edits: TextEdit[]})` — live updates the user sees immediately
- `polypore.editor.search({query, regex?, glob?})` — rg-backed

**Tasks**
- `polypore.tasks.list()`
- `polypore.tasks.add({label, parentId?, panelHint?})`
- `polypore.tasks.update({id, done?, label?})`

**Problems & verify**
- `polypore.diagnostics.list({severity?, file?})`
- `polypore.verify.run({id})`
- `polypore.verify.results()`
- `polypore.verify.declare({commands})` — replaces the PRD's `verify_commands`

**Knowledge base (Obsidian-like)**
- `polypore.memory.list()`
- `polypore.memory.read({path})`
- `polypore.memory.write({path, content})`
- `polypore.memory.link({from, to})` — explicit wikilink injection
- `polypore.memory.handoff({summary, nextSteps})` — writes a self-handoff doc when context is full (replaces compaction in §7)

**Workflow & phase**
- `polypore.phase.report({phase, status})` — replaces PRD's `report_phase`
- `polypore.workflow.update({nodes, edges})`

**Panels & UI**
- `polypore.panel.open({id, area?})`
- `polypore.panel.close({instanceId})`
- `polypore.ui.notify({level, msg})`

**Preview**
- `polypore.preview.register({kind, command, target})` — replaces PRD's `register_preview`
- `polypore.preview.refresh()`

**History**
- `polypore.history.events({since?, kind?})`
- `polypore.history.fork({eventId})`

**Records**
- `polypore.adr.record({title, body})` — replaces PRD's `record_adr`

**Plugins (community install pipeline)**
- `polypore.plugins.fetch({url, ref?})` — clones a GitHub repo to a sandboxed staging directory; pins to a specific commit
- `polypore.plugins.scan({stagingPath})` — finds every valid `polypore.json` manifest in the staging tree
- `polypore.plugins.inspect({stagingPath, manifestPath})` — returns manifest + file list + warnings
- `polypore.plugins.install({stagingPath, manifestPath, scope})` — installs, **always** behind a user-confirmation modal
- `polypore.plugins.list({scope?})`
- `polypore.plugins.enable({id})` / `polypore.plugins.disable({id})`
- `polypore.plugins.uninstall({id})` — also behind a user-confirmation modal

**Skills (cross-agent prompt fragments)**
- `polypore.skills.list({scope?})` → returns `SkillRef[]` (name + summary + scope)
- `polypore.skills.read({id})` → full skill body
- `polypore.skills.invoke({id, sessionId, args?})` — injects the skill's body into the named chat session as a header-prefixed message
- `polypore.skills.create / update / delete` — also exposed for agent-driven skill authoring; create + delete require host confirmation modals (same pattern as plugin install)

**Secrets (agent never receives values)**
- `polypore.secrets.list({scope?})` → returns `[{id, scope, configured}]` — names only
- `polypore.secrets.has({id, scope?})` → boolean
- `polypore.secrets.use({id, request})` — performs an authenticated outbound HTTP call; Rust shell substitutes the value at the network boundary and scrubs the response before returning
- There is no `polypore.secrets.read`. Reading values is structurally impossible from any agent or plugin context.
- `polypore.mcp.invoke({server, method, args, authRef?})` — invokes a method on a connected MCP server, with optional secret-handle for auth

**Naming convention.** TypeScript host RPC methods use camelCase (`editor.applyEdit`). MCP tool names use dotted snake_case (`polypore.editor.apply_edit`). The MCP server is a thin shim that maps tool names to host RPC methods using a fixed translation. Schemas in §22 are MCP-side; the matching host RPC signature is in §4.3.

### 5.3 The manual tool is the wedge

`polypore.manual()` returns markdown. That markdown is *generated* from the same per-panel manual content that powers the help overlay in the mockup (see `PANEL_MANUAL` in the frozen mockup). One source, two consumers:

- humans pressing the `?` button on a panel
- agents calling `polypore.manual()` at the start of a session

This is how the agent gains "good knowledge of the IDE" — it reads the manual the user reads, written once. Skills authoring a new panel append to the manual automatically through the manifest's `manual` field.

### 5.4 Skills are cross-agent prompt fragments

A "skill" is just a markdown prompt that tells *any* agent how to accomplish a workflow using the `polypore-ide` MCP tools. Skills live at `<project>/.polypore/skills/<name>.md` and at `~/.config/polypore/skills/`. Loading a skill = injecting its text into the active chat session prefixed with a header.

Skills no longer need per-agent variants. The vocabulary is the MCP tool set; every supported agent has the same vocabulary; the same skill works everywhere. This is what makes "skills available to any model" concrete.

---

## 6. Capability registry

Some agent-side features are not universally available (e.g., long-context compaction, subagent spawning, native phase reporting). The capability registry maps **internal capability names** to **per-agent implementations**.

```ts
type Capability =
  | 'memory-dir' | 'slash-commands' | 'tool-servers'
  | 'compaction' | 'phase-reporting' | 'permission-flow'
  | 'subagent-spawn' | 'streaming' | 'tool-use';
```

Panels declare required capabilities in the manifest. On agent switch:

1. Host queries the active agent via ACP capability discovery.
2. Registry resolves each panel's required capabilities against what the active agent provides.
3. Missing capabilities → panel disables itself with a tooltip explaining why.
4. **Graceful degradation is bidirectional.** Neither agent is privileged. Claude lacking some future Codex-specific capability degrades the same way Codex lacking phase reporting does today.

Already wired in `src/core/capabilityRegistry.ts` for `claude`, `codex`, `cursor`. Carry that forward; expand as ACP server matures.

---

## 7. Domain object model (object thinking)

The host owns a small set of long-lived domain objects. Panels and the MCP server both manipulate them through the host. Each has a stable identity, a typed schema, persistence, and an event signature on the bus.

| Object | Identity | Persisted to | Lifecycle owner |
|--|--|--|--|
| `Project` | absolute path | settings + SQLite | shell |
| `Workspace` | name + project | `<project>/.polypore/layouts/<name>.json` | host |
| `PanelInstance` | uuid | not persisted | host (workspace serializes ids only) |
| `ChatSession` | uuid, agent | SQLite | chat panel; host emits events |
| `Task` | uuid | `<project>/.polypore/state/tasks.json` + SQLite | host |
| `KnowledgeDoc` | path under `.knowledge/` | filesystem (markdown) | filesystem; host indexes |
| `File` | absolute path | filesystem | filesystem; editor opens |
| `Diagnostic` | file + range + source | not persisted | LSP client |
| `VerifyRun` | uuid | SQLite | shell |
| `HistoryEvent` | autoincrement id | SQLite | shell |
| `FileSnapshot` | content hash | SQLite (BLOB dedup) | shell |
| `FormationNode` | uuid | `<project>/.polypore/formation/<task>.json` | agent panel |
| `PreviewTarget` | uuid | not persisted (declared by agent) | preview panel |

These are the nouns. Tools, panels, and the MCP server are verbs on these nouns. When designing a new feature: identify the object, identify the verbs, then decide which surface exposes which verb.

---

## 8. Event bus & state model

Already prototyped in `src/core/eventBus.ts`. Keep the shape; harden the types.

```ts
type AppEvent =
  | { type: 'history:event'; event: HistoryEvent }
  | { type: 'workflow:update'; nodes: WorkflowNode[]; edges: WorkflowEdge[] }
  | { type: 'verify:run-recorded'; run: VerifyRun }
  | { type: 'agent:connection-changed'; connected: boolean; agent: AgentId }
  | { type: 'agent:tool-call'; sessionId: string; toolCall: ToolCall }
  | { type: 'chat:message'; sessionId: string; message: ChatMessage }
  | { type: 'tasks:changed'; tasks: Task[] }
  | { type: 'editor:opened'; path: string }
  | { type: 'editor:edited'; path: string; edits: TextEdit[] }
  | { type: 'diagnostics:changed'; diagnostics: Diagnostic[] }
  | { type: 'knowledge:changed'; path: string }
  | { type: 'panel:opened'; instanceId: string; panelId: string }
  | { type: 'panel:closed'; instanceId: string }
  | { type: 'preview:registered'; target: PreviewTarget }
  | { type: 'preview:refresh-requested' }
  | { type: 'formation:updated'; formation: Formation }
  | { type: 'state:changed'; key: StateKey; value: unknown }
  | { type: 'plugins:changed'; plugins: PluginRef[] };
```

Rules:
- Ring buffer holds the last N events for replay-on-subscribe (already done at N=250).
- Panels never publish events directly. They mutate state through host RPC; the host emits.
- The MCP server is a special subscriber — it receives events and forwards them as MCP-side notifications when the active agent supports streaming.

---

## 9. Workspaces & layout persistence

Only one workspace ships built-in: **Build**. (Confirmed in `src/workspaces/presets.ts`.) Users save their own later. No Plan/Implement/Review/Debug/Demo preset bundle — that was a PRD aspiration the mockup deliberately rejected.

`Build` layout (from the mockup):

- Resizable chat on the left, defaulting to ~33vw, range 22vw–48vw.
- Stage on the right with a tab strip; default tabs in order: `preview, editor, diff-stack, terminal, verify, memory, agent`.
- Top bar above, bottom bar below.
- Stage tabs are dockview tab groups. Splits and floats become available as users invoke them; the default is a single tab group.

Layout file:

```ts
// <project>/.polypore/layouts/<name>.json
type Workspace = {
  schemaVersion: 1;
  name: string;
  dockview: object;  // dockview's serialized layout
  panelInstances: Record<string, { panelId: string; props: Record<string, unknown> }>;
};
```

The `Build` workspace ships in app resources and is copied to `.polypore/layouts/` on first project open.

**Chat is a plugin, not chrome.** The mockup renders chat as a fixed left region with a custom resizer. The implementation keeps the same visual outcome but treats chat as a regular plugin docked into a left dockview group. dockview's standard splitter replaces the hand-rolled resizer. No panel is privileged: chat lives under the exact contract every other plugin uses.

---

## 10. Persistence

### 10.1 SQLite (via `tauri-plugin-sql`)

Single DB per user: `~/.local/share/polypore/sessions.db`. Tables:

```sql
CREATE TABLE projects(
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  last_opened INTEGER
);

CREATE TABLE chat_sessions(
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  agent TEXT NOT NULL,
  title TEXT,
  created_at INTEGER
);

CREATE TABLE chat_messages(
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id),
  ts INTEGER NOT NULL,
  role TEXT NOT NULL,           -- 'user' | 'agent' | 'tool'
  body TEXT NOT NULL,
  tool_call_id INTEGER
);

CREATE TABLE history_events(
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  agent_id TEXT,
  tool_name TEXT,
  phase TEXT,
  affected_files TEXT,          -- JSON
  payload TEXT,                 -- JSON
  snapshot_id INTEGER REFERENCES file_snapshots(id)
);

CREATE TABLE file_snapshots(
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content BLOB
);
CREATE UNIQUE INDEX idx_snapshot_hash ON file_snapshots(content_hash);

CREATE TABLE verify_runs(
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER,
  ran_at INTEGER,
  required INTEGER,
  output TEXT
);

CREATE TABLE tasks(
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  parent_id TEXT,
  label TEXT NOT NULL,
  done INTEGER,
  created_at INTEGER
);
```

### 10.2 Filesystem artifacts

- `<project>/.polypore/layouts/<name>.json` — workspace layouts
- `<project>/.polypore/skills/<name>.md` — project skills
- `<project>/.polypore/plugins/` — project-local plugins
- `<project>/.polypore/formation/<task-id>.json` — formation hierarchy
- `<project>/.knowledge/docs/**/*.md` — knowledge docs
- `<project>/.knowledge/adrs/**/*.md` — ADRs
- `<project>/.knowledge/agents/**/*.md` — agent conventions
- `<project>/.claude/verify.json` — verify commands (PRD-compat path; may relocate to `.polypore/`)

User-scope mirrors:
- `~/.config/polypore/settings.json`
- `~/.config/polypore/skills/`
- `~/.config/polypore/plugins/`
- `~/.claude/projects/<encoded-cwd>/memory/` — global memory (already populated by Claude Code; we read it)

### 10.3 Secrets storage (OS keyring, not filesystem)

Secret values live in the OS keyring via the Rust `keyring` crate:

- **macOS:** Keychain Services
- **Linux:** Secret Service / libsecret (GNOME Keyring, KWallet, etc.)
- **Windows:** Windows Credential Manager

Keyring entry naming: `polypore.<scope>.<projectFingerprint?>.<secretId>`, where:
- `<scope>` is `user` or `project`
- `<projectFingerprint>` is a hash of the project's absolute path (only present for project-scope entries)
- `<secretId>` is the user-chosen handle

The renderer never reads keyring entries. Only the Rust shell has the keyring binding. A separate SQLite table holds **metadata only** (no values):

```sql
CREATE TABLE secret_refs(
  id TEXT NOT NULL,
  scope TEXT NOT NULL,              -- 'user' | 'project'
  project_id INTEGER REFERENCES projects(id),  -- null for user-scope
  service TEXT,                     -- optional canonical service name
  hint TEXT,                        -- masked preview, e.g. "sk-ant-•••42a3"
  created_at INTEGER,
  last_used_at INTEGER,
  PRIMARY KEY (id, scope, project_id)
);
```

`.env` import: when a project is opened and a `.env` file is detected, the IDE offers a one-time prompt to import its entries into the secrets manager. Accepting moves each key into the keyring, replaces the `.env` value with `${secret:<id>}`, and offers to add `.env` to `.gitignore` if it isn't already. Declining leaves the file untouched.

If the OS keyring is unavailable (rare; some headless Linux setups), the shell **refuses to store secrets** rather than fall back to plaintext. The UI shows a banner with the failure reason and a link to OS keyring setup docs.

---

## 11. Panel specs (the mockup, panel by panel)

For each panel: **what the mockup shows**, **host RPCs used**, **MCP tools backing it**, **capabilities required**, **open questions**.

Reference the frozen mockup at `docs/mockups/2026-05-16-build-workspace/App.tsx` for exact layout, copy, and interaction.

### 11.1 `polypore.chat`

**Mockup behavior.** Left-docked panel, full height between top/bottom bars, resizable via vertical splitter (22vw–48vw). Multi-session tab strip across the top: each tab is a chat session bound to one agent (codex 1, claude 1, claude 2, …). `+` opens an add picker (agents + panels). Messages are subtle hybrid blocks; tool-call cards are compact (`shell`, `browser`) and clicking one focuses the agent panel. Composer at the bottom with send button. Panel header has settings (cog) and help (?) buttons.

**Host RPCs used.** `chat.sessions`, `chat.send`, `chat.onMessage`, `workspace.openPanel` (to focus agent panel from tool cards), `state.subscribe('activeAgent')`.

**MCP tools backing it.** None directly. Agents inject messages via the runtime channel; tool calls land here because the host bus forwards them.

**Capabilities required.** `streaming`, `tool-use`.

**Open questions.** Does the composer support slash-commands for skills directly (`/skill-name`)? Default: yes — slash autocomplete from the skill registry. Confirm with usage.

### 11.2 `polypore.preview`

**Mockup behavior.** Generic active runtime output. Mockup defines six target kinds: `site`, `desktop`, `mobile`, `cli`, `game`, `test`. Each has a command, a target field, and a hint. Embedded xterm for cli, image surface for desktop/mobile screenshot capture, structured test runner for test. For `site` / `game` and any other URL-rendering target, the rendering backend depends on platform per §27.2 — **embed by default on macOS/Windows, external system browser by default on Linux.** Per-project setting can override. Manual refresh button in the header. When external mode is active, the panel renders a control surface (URL display, restart/refresh/stop buttons, last 20 lines of stdout) and an "open preview" button that hands the URL to the system browser via Tauri's `shell.open` API.

**Host RPCs used.** `preview.register`, `preview.refresh`, `preview.onChange`, `terminal.spawn` (cli mode), `state.subscribe('preview')`. New: `ui.openExternal(url)` for external-browser mode.

**MCP tools backing it.** `polypore.preview.register`, `polypore.preview.refresh`. Agents register a preview on first run; user can override the target kind from the panel header.

**Capabilities required.** None.

### 11.3 `polypore.editor`

**Mockup behavior.** File picker bar at the top: folder-glyph + "select file" on the left, current file name centered. Picker opens an inline tree. File tree + tabs + Monaco editor body. Diagnostics inline. Status badges on tree entries (M/A/D).

**Host RPCs used.** `editor.open`, `editor.read`, `editor.applyEdit`, `editor.onChange`, `diagnostics.list`, `diagnostics.onChange`.

**MCP tools backing it.** `polypore.editor.open`, `polypore.editor.read`, `polypore.editor.apply_edit`. **Live update is non-negotiable:** when the agent calls `apply_edit`, the editor's Monaco buffer receives the diff and updates without losing cursor/selection where possible.

**Capabilities required.** None (editor works without an agent).

**Open questions.** Monaco bundle size in Tauri (~3MB). Lazy-load on first editor panel open.

### 11.4 `polypore.diff-history` (the wedge — fused)

**Mockup behavior.** This is where the mockup diverges most from the PRD. Diff and timeline are **one panel**. Left rail has three stacked sections: comparison-mode chips (`working tree | branch | agent task`), changed-files list, and the agent-snapshots history rail. Right pane shows side-by-side diff. Selecting a history entry scrubs both file list and diff to that point. Actions: `open in editor`, `compare` (base/target picker), `fork from here`, `revert...` (with a confirmation dialog).

The PRD's `timeline` panel is **subsumed** by this one. We do not ship a separate timeline.

**Host RPCs used.** `history.events`, `history.fork`, `history.revert`, `editor.open`.

**MCP tools backing it.** `polypore.history.events`, `polypore.history.fork`.

**Capabilities required.** `tool-use`.

**Open questions.** `fork from here` creates a git worktree — does that require the project to be a git repo? Spec: yes for git fork, no for in-DB snapshot revert. Tooltip clarifies.

### 11.5 `polypore.terminal`

**Mockup behavior.** Single xterm pane with bash shell and a prompt input. Multi-tab support flagged as planned.

**Host RPCs used.** `terminal.spawn`, `terminal.write`, `terminal.onData`.

**MCP tools backing it.** None directly — terminal is for humans. Agents use the agent's own shell tool (e.g., `Bash`).

**Capabilities required.** None.

### 11.6 `polypore.verify`

**Mockup behavior.** Two-column layout. **Left:** problems list (severity-tagged) + checks list (typecheck/tests/lint with status chips). **Right:** drag-to-fix queue. Drag a problem or check onto the queue; it appears as a pending item. Run-queue button walks each item `pending → fixing → done`. Custom items can be authored with `+`. Drag-drop uses custom MIME types (`application/x-fix-item`, `application/x-queue-item`).

**Host RPCs used.** `diagnostics.list`, `verify.runs`, `verify.run`, `tasks.add` (for queue items that escalate to real tasks).

**MCP tools backing it.** `polypore.diagnostics.list`, `polypore.verify.run`, `polypore.verify.results`, `polypore.verify.declare`.

**Capabilities required.** `tool-servers`.

### 11.7 `polypore.memory`

**Mockup behavior.** Three columns. **Left (`memory-context`):** "loaded context" header, then a context-meter card showing `active context {N}%` with a progress bar and the hint "recommend handoff at 80%". Below that, the context list — buttons listing each loaded file (e.g., `included: src/app.tsx`); accepts drops of MIME `application/x-knowledge-file` from the KB tree. Bottom-row actions: `write handoff` and `compress`. **Middle (`memory-library`):** knowledge base tree under a header showing folder count. Folders styled prominently; documents indented below. Groups: `docs/`, `agents/`, `adrs/`. `+ new note` at the bottom. **Right (`memory-document`):** "selected note" header + `load note` button + the rendered markdown pane with `[[wikilinks]]` shown inline. Panel header meta: `context {N}% · {M} loaded · {K} folders`.

Handoff is the preferred response to context pressure, but the `compress` button exists as a fallback (calls the active agent's own compaction routine when supported). The agent self-writes a handoff doc into `.knowledge/handoffs/`; the next cleared session reads it on startup.

**Host RPCs used.** `knowledge.list`, `knowledge.read`, `knowledge.write`, `knowledge.onChange`, `state.subscribe('context')`, `state.subscribe('contextUsedPct')`.

**MCP tools backing it.** `polypore.memory.list`, `polypore.memory.read`, `polypore.memory.write`, `polypore.memory.link`, `polypore.memory.handoff`.

**Capabilities required.** `memory-dir`.

### 11.8 `polypore.agent` (the cockpit)

**Mockup behavior.** Resizable grid. **Top-left (resizable height, default ~48%):** `skills` section. Lists local skill cards (name + one-line summary). Header has a `+ skill` button that opens an inline create form (name input → enter to create). Each skill card is the cross-agent prompt fragment described in §5.4. **Bottom-left:** `tasks` section. Plain checkbox list. **Right (resizable width, default ~67%):** `formation` canvas. SVG wires connect parent-to-child nodes; each node renders role + status + detail + a gear glyph. Defaults: overseer (root) with children frontend, cybersecurity, qa. `+ node` button at the bottom of the canvas creates a new node. Panel header meta reads `{N} agents · {M} running · {K} tasks open`. Both internal splits are resizable (`detailsWidth` clamped 24–45%, `activityHeight` 30–70%).

**Host RPCs used.** `tasks.list`, `tasks.add`, `tasks.update`, `tasks.onChange`, `state.subscribe('formation')`, `skills.list`, `skills.read`, `skills.create`, `skills.update`, `skills.delete`, `skills.invoke`, `skills.onChange`.

**MCP tools backing it.** `polypore.tasks.add`, `polypore.tasks.update`, `polypore.phase.report`, `polypore.skills.*`.

**Capabilities required.** `tool-use`, `subagent-spawn` (for formation node spawning).

**Open question.** Are formation nodes actual subagents at runtime, or just configuration scaffolding? MVP: configuration only. v2: live subagent processes one per node.

### 11.9 `polypore.problems`

**Mockup behavior.** Subsumed by `polypore.verify`'s left column in the mockup. Ship as a separate panel only if a user wants a standalone problems surface — manifest exists, points at the same host RPCs as verify's left column.

---

## 12. Global chrome

Exact segment order from the frozen mockup. All chrome lives in the host shell — not in plugins. Plugins never render outside their dock region.

**Top bar** (`TopBar`), left to right:

1. **Project name segment** — current project name (e.g., `polypore`).
2. **Git branch button** with chevron — drops a menu containing a `branch` header with the active branch name, a clean/dirty status line with the tracking remote, and the action list: `commit...`, `pull`, `push`, `fetch`, `new branch...`, `checkout...`, `merge...`, `rebase...`, `show log`.
3. **Workspace dropdown** — `workspace <name>` with chevron. Menu lists each preset with panel-count + emphasis summary, then actions: `save current workspace...`, `reset workspace`, `manage workspaces...`.
4. **Context meter** — `ctx [bar] N%` plus a `/handoff` button immediately to the right that writes a handoff doc.
5. **Permission-mode dropdown** — `mode <label>` with chevron. Menu items: `plan` (ask before changes), `default` (standard approvals), `accept edits` (apply file edits), `auto` (run trusted actions), `bypass` (full local autonomy).
6. **Settings button** — opens the global settings page.
7. **Help button** — opens global help.
8. **Brand** — `polypore v{version}` (right-aligned).

**Bottom bar** (`BottomBar`), left to right:

1. `branch:<name>`
2. `file:<filename>`
3. `ln:<N> col:<N>`
4. `verify:<status> · <N> problem(s)`

Bottom-bar items are spans, not buttons. (Mockup-faithful — earlier drafts incorrectly listed an "agent state" segment that isn't present.)

**Stage tab strip:** horizontally-scrollable tab list with drag-to-reorder, per-tab close (`x`) affordance, `+` add picker on the right. Add picker (`addItem` in the mockup) offers two parallel lists: panels (preview, editor, diff, terminal, verify, memory, agent) and agents (codex, claude). Picking a panel adds a tab; picking an agent creates a new chat session.

**Per-panel header** (`PanelHeader`): every panel gets a host-rendered header with the panel title, an optional metadata strip (e.g., `5 files · +80 -12`), a settings cog (opens `PanelSettingsOverlay`), and a help `?` (opens `PanelHelpOverlay`). Plugins never render their own panel header — the host wraps the iframe.

**Per-panel overlays:**
- Settings overlay (`PanelSettingsOverlay`): scoped slice of project settings for that panel, with a link to the full settings page and a `reset {panel} defaults` action.
- Help/manual overlay (`PanelHelpOverlay`): renders the manifest's `manual.summary` + `manual.tips` list, plus an `open full docs →` action. Same content the agent reads through `polypore.manual()`.

**Settings page → Credentials section** (host-rendered, not a panel):

The credentials table is the primary UX for secret management. Reached from the top-bar `settings` button → `credentials` tab. Columns: `id` (the handle), `service` (canonical name), `scope` (user/project chip), `hint` (masked preview), and per-row actions: `test`, `rotate`, `delete`. A `+ credential` button opens a form with: `id`, `scope` toggle, `service` (autocomplete from known services), and `value` (masked input). The value never leaves the form; the host sends it to the Rust shell over a single IPC call that writes to the keyring and returns. The renderer does not retain the value.

**Inline chat prompts.** When the agent calls `polypore.secrets.has` and gets `false`, OR when `polypore.secrets.use` returns a `secret_not_configured` error, the chat panel renders a compact inline card: "this provider needs a key — configure now?" with a button that opens the credentials form pre-filled with the missing `id`.

**Key-detection middleware in chat.** Before any user message is delivered to the agent, the chat panel scans the text for patterns that look like API keys (`sk-ant-...`, `sk-...`, `ghp_...`, `xoxb-...`, AWS-style `AKIA...`, generic `Bearer ...` headers). On a hit, the message is **not sent**. A modal asks: "this looks like a credential — store it as a secret and remove from the message, or send anyway?" Storing opens the credentials form pre-filled.

**MCP server / formation node hover.** Hovering the gear glyph on an MCP server entry in the agent panel, or on a formation node, shows which `authRef` that entity uses (if any). Lets the user audit "which key is this thing burning?" without leaving the panel.

---

## 13. Workflow loop (iterate)

**Orchestrator: the IDE, not the agent.** The Rust shell hosts the iterate state machine. The agent only does the work; the IDE drives the cycle. The shell:

1. Sends the agent the task prompt.
2. Awaits agent declaration of done (the agent sends a message or invokes `polypore.phase.report({phase: 'iterate', status: 'done'})`).
3. Runs the declared verify commands via `polypore.verify.run` for each required entry.
4. If all required entries are clean → loop exits; emits `verify:run-recorded` with final state.
5. Otherwise → assembles a context summary (failed runs + outputs) and re-prompts the agent for the next cycle.
6. Repeats until clean OR cycle count hits `max` (default 5).

One configuration knob: **max cycles** (default 5). On hitting the cap, loop pauses; OS notification fires; top bar shows "paused at cycle 5/5 — continue?". User chooses continue / abort / change-max.

Loop state lives in the shell's SQLite (`iterate_state` row keyed by task_id) and is mirrored to the `loopCycle` state key (§20). The top bar reads `loopCycle` and renders the cycle indicator + chips described in the mockup.

Soft-stop ("pause after current cycle"): toggles a flag in the shell; checked at step 4 before re-prompting. Hard abort (hold-to-confirm) interrupts the agent process via the ACP runtime client.

Auto-checkpoint at end of each cycle = file snapshot to SQLite (`file_snapshots` table). **Git is never touched automatically.**

---

## 14. Failure modes

(Pulled from PRD §9 and §10, edited for the mockup.)

- **Project is non-git.** File-tree badges hidden; diff stack still works against snapshots; `fork from here` disabled.
- **No LSP server.** Editor works; problems empty; tooltip on tree row notes "no LSP."
- **Agent missing on PATH.** Persistent install banner; empty workspace still usable.
- **Agent crashes mid-loop.** Auto-restart up to 3×/min; status bar reflects; modal after 3 fails.
- **Iterate hits max cycles.** Pause; OS notification; top bar shows continue/abort/change-max.
- **User dismisses inline permission.** Treated as deny; logged in chat.
- **Tool output > 10MB.** Truncate to head+tail; full payload available in viewer.
- **Diff > 50k lines.** Monaco lazy virtual model; large-diff indicator.
- **Memory/knowledge dir missing.** Lazy-create on first save.
- **Settings JSON malformed.** Load defaults; banner with "open in editor."
- **Subagent spawned.** Renders as a normal tool call in chat/history; nesting handled by the parent agent.
- **Workspace JSON references unknown panel.** Drop silently with console warning; one-time toast.
- **Float window off-screen on monitor disconnect.** Re-snap on next launch.
- **Capability changed mid-session.** Reconnect; re-discover; re-render affected panels.
- **Plugin manifest invalid.** Skip load; show in extensions panel with the parse error.
- **Plugin RPC hung.** Host kills the iframe after timeout; panel auto-restarts once.
- **Two ACP agents on PATH.** Agent picker in top bar lists both; switching swaps the capability map.
- **OS keyring unavailable / locked.** Refuse to store secrets; banner with OS-specific setup link. On macOS/Windows this is almost never hit; on Linux it requires a running Secret Service implementation.
- **Secret used in `polypore.secrets.use` doesn't exist.** Return `secret_not_configured`; the chat panel renders the inline configure-now card.
- **Agent attempts to echo a secret value in chat.** Response-scrubbing in the Rust shell strips it on the way back from `polypore.secrets.use`. If the agent reconstructs the value some other way (string concatenation, base64 decode), there is no scrub — this is why the manual prompts agents not to.
- **User pastes an API key directly into chat.** Key-detection middleware (§12) blocks the send and offers to store it as a secret.
- **Project moved or renamed.** Project-scope secrets are keyed by project fingerprint (hash of absolute path). On project-path change, secrets appear missing; offer to migrate from the previous fingerprint via a one-time prompt.

### GUI-internal pitfalls (carry forward)

1. Re-rendering on every event-bus message → refs + manual flush; coalesce.
2. Layout state in React Context only → persistence is its own store.
3. Capability registry leaking into panels → panels declare requirements only.
4. Workflow runtime state contaminating the graph file → graph file pure definition; runtime in SQLite.
5. Coupling panels to bus shape → typed props per panel.
6. LSP crashes → resilient client, backoff restart, syntax-only fallback.
7. Snapshot DB ballooning → content-hash dedup; periodic GC.
8. MCP version drift → pin MCP suite to app version; reject incompatible.

---

## 15. Visual fidelity contract

The frozen mockup at `docs/mockups/2026-05-16-build-workspace/` is the visual acceptance test. For every panel:

1. **Pixel-level reference.** When implementing a panel, open the corresponding section of the frozen `App.tsx` and `App.css` side-by-side with the live implementation. The implementation matches.
2. **Copy and lowercase rule.** All visible UI copy is lowercase.
3. **Accent.** Honey/amber/brown. Translucent dark panels. Active panel/tab visibly frostier and brighter.
4. **Monospace.** Most UI is monospace.
5. **Compact title bars.** Visible panel borders. Small radii.
6. **Background.** Tasteful dark mycology placeholder; user-provided fungus photo eventually.
7. **No emoji.** Glyph icons are 2-3 ASCII chars (`/>`, `{}`, `+-`, `$`, `vf`, `kb`, `ai`, `!`, `ts`).

Any deviation gets caught in implementation review by diffing against the frozen mockup.

---

## 16. Implementation order

Milestones are vertical slices. Each ends with a runnable app and one observable new behavior.

### M0 — Stack swap (no behavior change)

- CRA → Vite migration. Same `App.tsx`, new build system.
- Tauri 2.x shell scaffolding. App opens in a native window.
- TypeScript strict mode on all of `src/core/` and `src/workspaces/`.
- Rename project shell strings from `operator-ide` to `polypore` wherever the mockup already uses `operator-ide` *as content* — do not change content the mockup intends to render.

**Exit criterion:** the existing mockup runs identically inside a Tauri window, built by Vite.

### M1 — Spine (schemas + event bus + capability registry + manifest)

- **Transcribe §20 into JSON Schema files** under `schemas/` per §27.1. This is the first task. Every type referenced anywhere in this doc gets a schema file.
- Set up the codegen pipeline (§27.1): `pnpm codegen` produces `packages/sdk/src/types.gen.ts`, `validators.gen.ts`, and `apps/desktop/src-tauri/src/types_gen.rs`. Verify generated TS matches §20 by inspection.
- Lock the event-bus types (`AppEvent`) — schema first, then codegen.
- Lock the capability-registry shape.
- `PanelManifest` and `HostPermission` types are now generated from `schemas/manifest.schema.json`.
- Stand up the host RPC server with a no-op postMessage implementation, plus an in-process loopback shim so panels can call it before iframes exist. Host validates every incoming request envelope against the matching schema via the generated Ajv validator.

**Exit criterion:** (a) `pnpm codegen && pnpm typecheck` is green from a clean checkout. (b) a hand-written test panel registers a manifest, gets loaded by the host, calls `host.ui.notify('info', 'hello')`, and the host shows the notification. (c) sending a malformed RPC request returns `invalid_params` with the schema validation error attached. No real iframe yet.

### M2 — dockview + plugin loader

- Replace the mockup's hand-rolled grid with dockview as the layout engine.
- Build the plugin loader: discover `polypore.json` manifests, mount iframes, complete handshake.
- Migrate `polypore.chat` from in-tree React to a plugin under the contract. **One panel, end-to-end through the new boundary.** This is the proof.

**Exit criterion:** chat works exactly like the mockup, running as an iframe plugin.

### M3 — Built-in panels (parallelizable after M2 lands)

Port each remaining panel from the mockup into a plugin. Each is independent once M2 is done, but implementation should stay sequential unless the user explicitly asks to split the work. Use the rename map in §26.1 — mockup helper names (e.g., `AgentSurface`) become plugin packages (`plugins/agent/`) under the new id (`polypore.agent`).

- `polypore.editor` (Monaco minimal, no LSP yet)
- `polypore.preview` (mock targets only, no real runtime; six kinds from `previewTargetKinds`)
- `polypore.terminal` (UI only, no pty yet)
- `polypore.verify` (drag-to-fix queue with the three custom MIME types from §26.3, no real runs)
- `polypore.memory` (KB tree + document pane + drag-to-context, FS-backed)
- `polypore.diff-history` (mock data; three-section left rail + diff pane + fork/revert)
- `polypore.agent` (skills + tasks + formation canvas, mock activity)

The `host.skills.*` RPC group (§4.3) and the `polypore.skills.*` MCP tools (§22.13) are already spec'd; M3 implements them when porting the agent panel.

**Exit criterion:** every panel in the mockup renders through the plugin contract, with mock data where integrations don't exist yet. Each ported panel passes a side-by-side diff against the frozen mockup section.

### M4 — `polypore-ide` MCP server + secrets manager

- Node-based MCP server sidecar process.
- Tool surface from §5.2, each tool a shim over the corresponding host RPC.
- `polypore.manual()` returns markdown assembled from manifest `manual` fields.
- Shell supervises the process; restart on crash.
- **Secrets manager** (§10.3, §22.12) ships with this milestone — the MCP server can't host `polypore.secrets.*` until the Rust keyring binding + scrubbing layer exists. Settings → Credentials page goes live. Key-detection middleware activates in chat.
- `polypore.mcp.invoke` works for connected user-installed MCP servers, with secret-handle resolution.

**Exit criterion:** (a) running `polypore-ide` MCP locally and pointing Claude Code at it lets Claude call every tool successfully against a real Polypore window. (b) The user can configure an Anthropic API key in Settings → Credentials, the agent can call `polypore.secrets.list` and see the masked entry, and the agent can call an authenticated endpoint via `polypore.secrets.use` without the renderer or agent ever seeing the value.

### M5 — Agent runtime: stdio adapter first, ACP probe second

**The M5 default is the stdio adapter, not native ACP.** This is a committed decision, not a fallback. Native ACP is opt-in once it's proven mature per agent. Rationale: the stdio adapter works against whatever the agent CLI ships today, with no dependency on upstream protocol maturity.

Build order inside M5:

1. **Common adapter trait** (`apps/desktop/src-tauri/src/agent/mod.rs`):
   ```rust
   #[async_trait]
   pub trait AgentRuntime: Send + Sync {
     async fn send_user_message(&self, session_id: &str, text: &str) -> anyhow::Result<()>;
     async fn interrupt(&self, session_id: &str) -> anyhow::Result<()>;
     fn events(&self) -> Receiver<AgentEvent>;   // tokio::sync::broadcast
     fn capabilities(&self) -> AgentCapabilityMap;
   }
   ```
   Every agent integration implements this trait. Events flow into the renderer event bus via Tauri IPC.

2. **Stdio adapters** (one per agent), in `apps/desktop/src-tauri/src/agent/`:
   - `claude_stdio.rs` — spawns `claude` with stream-json output mode, parses each line, emits `AgentEvent::ToolCall`, `AgentEvent::Message`, `AgentEvent::Permission`. Permission prompts surface inline in chat per the mockup. Capabilities reported: `streaming`, `tool-use`, `memory-dir`, `slash-commands`, `tool-servers`, `compaction`, `phase-reporting`, `permission-flow`, `subagent-spawn`.
   - `codex_stdio.rs` — same shape, against the `codex` CLI's native output. Capabilities reported per §6 codex column (no `phase-reporting`).

3. **ACP probe.** At agent connect, the shell spawns the agent with `--acp` (or equivalent flag) and waits 2s for a valid ACP handshake on stdout. If it succeeds, the shell mounts the **`acp` adapter** (`apps/desktop/src-tauri/src/agent/acp.rs`) — same `AgentRuntime` trait, but the implementation routes through the ACP wire protocol. If the handshake fails or times out, the shell falls back to stdio silently. The user sees the result on the top-bar status segment: `claude · stdio` or `claude · acp`.

4. **Agent tool-call observation.** Both adapters emit `AgentEvent::ToolCall` for every tool the agent invokes — including non-`polypore-ide` ones (Bash, Read, Write, plus user-installed MCP servers). The shell republishes each as a `history:event` and an `agent:tool-call` AppEvent on the renderer bus. This is what makes the agent's own tools visible in `polypore.diff-history`.

5. **Top-bar agent picker** switches the active `AgentRuntime` and rebinds the capability registry.

**Exit criterion:** (a) sending a message in chat reaches a real Claude or Codex agent via the stdio adapter and the response streams into chat. (b) A tool call from the agent (e.g., Claude's `Read` or `Bash`) lands in `polypore.diff-history`. (c) The ACP probe runs at agent connect; if it succeeds for the active agent, the runtime swaps to ACP without a restart and the status segment updates. (d) Switching agents from the picker hot-swaps the `AgentRuntime` instance without losing chat history.

### M6 — Real integrations

In parallel, once M5 is stable:

- Monaco LSP client (rust-analyzer, tsserver, pyright, gopls)
- xterm renderer + `portable-pty` in Rust (no Node-side pty bridge)
- SQLite persistence end-to-end
- Iterate loop with verify integration
- OS notifications
- Tauri auto-updater

**Exit criterion:** a real iterate-loop on a real project, with real verify runs and real diagnostics.

### M7 — Plugin install pipeline + hardening (third-party readiness)

- Implement the `polypore.plugins.*` MCP tool group (§22.11): fetch, scan, inspect, install, list, enable, disable, uninstall.
- Build the host-side install confirmation modal (manifest summary + permissions + commit hash + scope toggle). Modal cannot be bypassed.
- Permission-prompt UX for third-party plugins at install time.
- Plugin signing (optional).
- Per-plugin sandbox CSP (each plugin iframe gets its own origin via the `plugin://<id>/` custom protocol from §21.1).
- Plugin marketplace stub in the agent (extensions) panel — lists installed plugins with enable/disable, plus a "paste a GitHub URL" affordance that round-trips through the agent.

**Exit criterion:** the user pastes `https://github.com/<user>/<panel-repo>` into chat, the agent fetches and scans it, summarizes the candidate plugin and its permissions, the user accepts the install modal, and the plugin shows up in the agent panel ready to enable.

---

## 17. Open questions

All structural questions are resolved. The items remaining are product/UX choices that need data, not implementation blockers:

1. **Permission UX for third-party plugins.** Up-front bundle prompt is the committed default (§24.5); revisit if user research shows confusion.
2. **Formation node = live subagent?** MVP: configuration only. v2: live processes. Decision deferred to user feedback after MVP.
3. **Compaction vs. handoff.** Handoff is the recommended path (§11.7) with `compress` as a fallback. Whether to actively suppress agent-side compaction commands needs measurement.
4. **High-frequency MCP polling.** If agents poll `polypore.diagnostics.list` aggressively, add a streaming variant. Measure first.

None of these blocks M0–M7.

---

## 18. Decision log (delta over PRD)

| Date | Decision | Why |
|--|--|--|
| 2026-05-16 | Mockup wins over PRD and ui-direction when they conflict | Mockup is the realized truth; docs are inferences |
| 2026-05-16 | Rename "Operator IDE" → "Polypore" | Directory name; matches `polypore-ide` MCP server name |
| 2026-05-16 | Every panel is a plugin, no privileged tier | Adobe modularity requires the built-ins live under the same contract third-parties get |
| 2026-05-16 | One `polypore-ide` MCP server for all agent ↔ IDE traffic | Coherence over multi-channel; agent-agnostic by construction |
| 2026-05-16 | Skills are MCP-vocabulary prompts, agent-agnostic | One skill works for every agent because the verbs are MCP tools |
| 2026-05-16 | `diff-history` is one panel, not two | Mockup fused them; PRD's separate `timeline` panel is dropped |
| 2026-05-16 | Context-limit response is handoff, not compaction | Mockup explicitly rejects compaction; handoff doc is the mechanism |
| 2026-05-16 | One built-in workspace: Build | Mockup ships only Build; PRD's five-preset bundle is dropped |
| 2026-05-16 | Vite + Tauri + dockview adopted before porting panels | Avoid a re-platform after surfaces exist |
| 2026-05-16 | Migrate `.claude/verify.json` path under `.polypore/` over time | Single namespace; keep `.claude/` read-compat for now |

---

## 19. What this document is not

- It is not a sprint plan. Milestones are sized; cadence is up to the operator.
- It is not a full schema reference. Inline schemas show shape; full ones live with the code (`packages/sdk/src/types.ts`).
- It is not a UX spec for content copy. The mockup owns copy and tone.
- It is not a marketing brief. The PRD's Problem and Solution sections still cover that.

When in doubt: open the frozen mockup, then this plan, in that order.

---

## 20. Complete SDK type reference

Every type referenced anywhere in this document. **As of M1, this section is documentation only — the canonical source is `schemas/` and the generated `packages/sdk/src/types.gen.ts` (see §27.1).** The TypeScript below is the initial authoring input: M1 begins by transcribing this section into JSON Schema files, then runs codegen. After that, this section is reference material; all updates land in `schemas/`.

```ts
// ============================================================================
// Identity & primitives
// ============================================================================

export type AgentId = 'claude' | 'codex' | 'cursor' | string;

export type Unsubscribe = () => void;

export type ISODateString = string;

export type Position = { line: number; column: number };
export type Range = { start: Position; end: Position };

export type TextEdit = {
  range: Range;
  newText: string;
};

// ============================================================================
// Capabilities (agent-side features)
// ============================================================================

export type Capability =
  | 'memory-dir'
  | 'slash-commands'
  | 'tool-servers'
  | 'compaction'
  | 'phase-reporting'
  | 'permission-flow'
  | 'subagent-spawn'
  | 'streaming'
  | 'tool-use';

export type AgentImpl = {
  agent: AgentId;
  description: string;
  available: boolean;
  docsUrl?: string;
};

export type AgentCapabilityMap = Record<Capability, AgentImpl | null>;

// ============================================================================
// Panels & manifests
// ============================================================================

export type PanelCategory = 'editor' | 'agent' | 'verify' | 'knowledge' | 'runtime' | 'other';

export type HostPermission =
  | 'state.read'
  | 'editor.read' | 'editor.write'
  | 'knowledge.read' | 'knowledge.write'
  | 'tasks.read' | 'tasks.write'
  | 'diagnostics.read'
  | 'verify.read' | 'verify.run'
  | 'chat.read' | 'chat.send'
  | 'history.read' | 'history.fork' | 'history.revert'
  | 'workspace.read' | 'workspace.write'
  | 'preview.register'
  | 'terminal.spawn'
  | 'ui.notify' | 'ui.confirm' | 'ui.openExternal'
  | 'plugins.read' | 'plugins.write';

export type PanelSettingSchema = {
  fields: Array<
    | { kind: 'toggle'; id: string; label: string; default: boolean }
    | { kind: 'text'; id: string; label: string; default: string; placeholder?: string }
    | { kind: 'select'; id: string; label: string; options: Array<{ value: string; label: string }>; default: string }
  >;
};

export type PanelManualContent = {
  summary: string;
  tips: string[];
  externalDocsUrl?: string;
};

export type PanelManifest = {
  schemaVersion: 1;
  id: string;                       // "polypore.chat", "com.acme.foo"
  title: string;                    // lowercase display name
  icon: string;                     // 2-3 char glyph
  version: string;                  // semver
  author?: { name: string; url?: string };
  description?: string;
  entry: string;                    // relative path to HTML entry, e.g. "dist/index.html"
  permissions: HostPermission[];
  capabilities: Capability[];       // required of the active agent
  category: PanelCategory;
  defaultArea?: 'center' | 'left' | 'right' | 'bottom';
  settings?: PanelSettingSchema;
  manual?: PanelManualContent;
};

// ============================================================================
// Workspaces & layouts
// ============================================================================

export type WorkspaceName = 'Build' | string;

export type Workspace = {
  schemaVersion: 1;
  name: WorkspaceName;
  dockview: object;                 // dockview.toJSON() blob
  panelInstances: Record<string, { panelId: string; props: Record<string, unknown> }>;
};

// ============================================================================
// Files, editor, diagnostics
// ============================================================================

export type FileNodeKind = 'file' | 'folder';

export type FileNode =
  | { kind: 'file'; name: string; path: string; subtitle?: string }
  | { kind: 'folder'; name: string; path: string; children: FileNode[] };

export type DiagnosticSeverity = 'error' | 'warn' | 'info' | 'hint';

export type Diagnostic = {
  id: string;
  severity: DiagnosticSeverity;
  source: string;                   // "tsserver", "rust-analyzer", ...
  file: string;
  range: Range;
  message: string;
  code?: string | number;
};

export type DiagnosticFilter = {
  severity?: DiagnosticSeverity;
  file?: string;
  source?: string;
};

// ============================================================================
// Tasks
// ============================================================================

export type Task = {
  id: string;
  label: string;
  done: boolean;
  parentId?: string;
  panelHint?: string;               // suggested panel to act on this task
  createdAt: number;
  createdBy: 'user' | 'agent';
};

// ============================================================================
// Verify
// ============================================================================

export type VerifyStatus = 'ok' | 'fail' | 'pending';

export type VerifyRun = {
  id: string;
  label: 'typecheck' | 'tests' | 'lint' | string;
  command: string;
  cwd?: string;
  required: boolean;
  status: VerifyStatus;
  exitCode: number | null;
  ranAt: number | null;
  output: string;
  durationMs: number | null;
};

export type VerifyConfig = {
  schemaVersion: 1;
  commands: Array<{
    id: string;
    label: string;
    cmd: string;
    cwd?: string;
    required: boolean;
  }>;
};

// ============================================================================
// History (the diff-history wedge)
// ============================================================================

export type HistoryEventKind = 'tool-call' | 'file-write' | 'file-edit' | 'message' | 'phase-change';

export type HistoryEvent = {
  id: string;
  ts: number;
  taskId: string;
  source: 'agent' | 'human';
  kind: HistoryEventKind;
  agentId?: AgentId;
  toolName?: string;
  phase?: string;
  affectedFiles: string[];
  summary: string;
  payload?: Record<string, unknown>;
  snapshotId?: number;
};

export type HistoryFilter = {
  source?: 'agent' | 'human';
  kind?: HistoryEventKind;
  toolName?: string;
  file?: string;
  since?: number;
  until?: number;
};

export type WorktreeRef = {
  id: string;
  path: string;                     // absolute path of the new worktree
  branch: string;
  forkedFromEventId: string;
};

// ============================================================================
// Knowledge base
// ============================================================================

export type KnowledgeNode =
  | { kind: 'doc'; path: string; title: string; updatedAt: number }
  | { kind: 'folder'; path: string; name: string; children: KnowledgeNode[] };

export type Handoff = {
  summary: string;
  nextSteps: string[];
  context: string[];                // paths of files included in current context
};

// ============================================================================
// Chat
// ============================================================================

export type ChatMessage = {
  id: string;
  sessionId: string;
  by: 'user' | 'agent' | 'tool';
  ts: number;
  text: string;
  toolCallId?: string;
};

export type ToolCall = {
  id: string;
  sessionId: string;
  agentId: AgentId;
  toolName: string;
  summary: string;
  status: 'ok' | 'live' | 'fail';
  ts: number;
  historyEventId?: string;
};

export type ChatSession = {
  id: string;
  agent: AgentId;
  title: string;
  createdAt: number;
};

// ============================================================================
// Workflow graph
// ============================================================================

export type WorkflowNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'paused';

export type WorkflowNode = {
  id: string;
  label: string;
  level: 'phase' | 'sub';
  status: WorkflowNodeStatus;
  parentId?: string;
  position?: { x: number; y: number };
  todoItems?: Array<{ id: string; label: string; done: boolean }>;
};

export type WorkflowEdge = { id: string; source: string; target: string };

export type WorkflowGraph = {
  schemaVersion: 1;
  taskId: string;
  title: string;
  enabled: boolean;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

// ============================================================================
// Preview
// ============================================================================

export type PreviewKind = 'site' | 'desktop' | 'mobile' | 'cli' | 'game' | 'test';

export type PreviewTarget = {
  id: string;
  kind: PreviewKind;
  label: string;
  command: string;
  cwd?: string;
  target: string;                   // URL, device id, etc.
  registeredAt: number;
  agentId?: AgentId;
};

// ============================================================================
// Terminal
// ============================================================================

export type TerminalRef = {
  id: string;
  pid: number;
  shell: string;
  cwd: string;
};

// ============================================================================
// Formation (agent cockpit)
// ============================================================================

export type FormationRole = 'overseer' | 'frontend' | 'backend' | 'cybersecurity' | 'qa' | 'docs' | string;

export type FormationNode = {
  id: string;
  role: FormationRole;
  detail: string;
  parentId?: string;
  modelId?: string;
  toolAccess?: string[];
  scope?: string;
  mcps?: string[];
  plugins?: string[];
  constraints?: string;
  handoffRules?: string;
  position?: { x: number; y: number };
  root: boolean;
  status: 'idle' | 'running' | 'waiting' | 'done' | 'failed';
};

export type Formation = {
  schemaVersion: 1;
  taskId: string;
  nodes: FormationNode[];
  edges: Array<{ id: string; source: string; target: string }>;
};

// ============================================================================
// Skills (cross-agent prompt fragments)
// ============================================================================

export type SkillScope = 'project' | 'user' | 'builtin';

export type SkillRef = {
  id: string;                        // slugified name, unique within scope
  name: string;                      // display name (lowercase per ui rule)
  scope: SkillScope;
  summary: string;                   // one-line description shown on the card
  path: string;                      // absolute path on disk
  updatedAt: number;
};

export type Skill = SkillRef & {
  body: string;                      // full markdown body; injected on invoke
  frontmatter?: {
    capabilities?: Capability[];     // required agent capabilities; if missing, skill greys out
    arguments?: Array<{ id: string; label: string; required?: boolean }>;
  };
  createdAt: number;
};

// ============================================================================
// Secrets (the agent never receives values; only references)
// ============================================================================

export type SecretScope = 'user' | 'project';

export type SecretRef = {
  id: string;                        // user-chosen handle, e.g. "anthropic-prod"
  scope: SecretScope;
  service?: string;                  // optional canonical service name (e.g. "anthropic")
  hint?: string;                     // masked preview like "sk-ant-•••42a3"
  configured: boolean;               // false means a slot was reserved but the value is missing
  lastUsedAt?: number;
};

// Spec for an outbound HTTP call that uses a secret. The Rust shell injects
// the secret value at request time, runs the call, and scrubs anything that
// matches the secret out of the response (headers AND body) before returning.
export type SecretInvoke = {
  id: string;                        // SecretRef.id
  request: {
    url: string;                     // must use https; http rejected unless `allowInsecure` is set
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    headers?: Record<string, string>;  // value `"${secret}"` is replaced with the resolved secret
    body?: string | Record<string, unknown>;
    timeoutMs?: number;              // default 30s, max 120s
    allowInsecure?: boolean;         // dev-only, requires user.confirm
  };
};

export type SecretInvokeResult = {
  status: number;
  headers: Record<string, string>;   // scrubbed
  body: string;                      // scrubbed
};

export type McpInvoke = {
  server: string;                    // connected MCP server id
  method: string;                    // server-defined method/tool name
  args: Record<string, unknown>;
  authRef?: string;                  // SecretRef.id; resolved by Rust before forwarding
  timeoutMs?: number;
};

// ============================================================================
// Plugins (agent-driven install pipeline)
// ============================================================================

export type PluginRef = {
  id: string;
  version: string;
  scope: 'project' | 'user';
  enabled: boolean;
  installedAt: number;
  source?: { kind: 'github'; url: string; commit: string };
};

export type PluginStaging = {
  stagingPath: string;
  source: { kind: 'github'; url: string; commit: string; ref?: string };
  fileTree: FileNode[];
  candidates: Array<{
    manifestPath: string;
    rootPath: string;
    manifest: PanelManifest;
  }>;
};

// ============================================================================
// Open-panel options
// ============================================================================

export type OpenPanelOpts = {
  area?: 'center' | 'left' | 'right' | 'bottom';
  group?: string;                   // dockview group id to dock into
  active?: boolean;                 // focus on open (default true)
  props?: Record<string, unknown>;  // initial props passed to the panel
};

// ============================================================================
// State keys (host pub-sub)
// ============================================================================

export type StateKey =
  | 'activeAgent'
  | 'agentConnected'
  | 'workspace'
  | 'activePanel'
  | 'branch'
  | 'contextUsedPct'
  | 'context'
  | 'permissionMode'
  | 'loopCycle'
  | 'preview'
  | 'formation'
  | 'tasks'
  | 'diagnostics'
  | 'verifyRuns';

export type StateValueMap = {
  activeAgent: AgentId;
  agentConnected: boolean;
  workspace: WorkspaceName;
  activePanel: string;
  branch: string;
  contextUsedPct: number;
  context: string[];                // list of file paths included in agent context
  permissionMode: 'plan' | 'default' | 'acceptEdits' | 'auto' | 'bypass';
  loopCycle: { cycle: number; max: number; status: 'idle' | 'running' | 'paused' | 'clean' };
  preview: PreviewTarget | null;    // currently registered preview, if any
  formation: Formation | null;      // current task's formation hierarchy
  tasks: Task[];                    // full task list for the active project
  diagnostics: Diagnostic[];        // aggregated LSP diagnostics
  verifyRuns: VerifyRun[];          // latest verify-run snapshot
};

export type StateValue<K extends StateKey> = StateValueMap[K];
```

---

## 21. Host RPC wire protocol

Every panel runs in an iframe. The iframe and the host talk over `window.postMessage`. This section is the wire-level contract — message envelope, handshake, subscriptions, errors.

### 21.1 Origin & transport

- Host serves the renderer at a fixed Tauri origin (e.g., `tauri://localhost`).
- Each plugin iframe is sourced from a per-plugin origin (`plugin://<plugin-id>/`) routed by a Tauri custom protocol handler. The shell rewrites file reads for that origin to the plugin's installation directory.
- The host **always** validates `event.origin` against the expected plugin origin before processing any message.
- Each iframe instance has a unique `instanceId`. The host generates it at mount; the plugin learns its own `instanceId` during the handshake.

### 21.2 Envelope

All messages are JSON. Three top-level kinds: `request`, `response`, `event`.

```ts
type RpcEnvelope = RpcRequest | RpcResponse | RpcEvent;

type RpcRequest = {
  kind: 'request';
  id: number;                       // monotonically incremented per-direction
  method: string;                   // dotted, e.g. "editor.applyEdit"
  params: unknown;                  // method-specific
};

type RpcResponse = {
  kind: 'response';
  id: number;                       // matches a prior request id
  ok: true;
  result: unknown;
} | {
  kind: 'response';
  id: number;
  ok: false;
  error: RpcError;
};

type RpcEvent = {
  kind: 'event';
  topic: string;                    // e.g. "editor:edited", "subscription:<id>"
  payload: unknown;
};

type RpcError = {
  code: string;                     // see §21.6
  message: string;
  data?: unknown;
};
```

Request ids are per-direction. The host has its own counter; each plugin has its own counter. The id namespace is local to that direction; the responder echoes the id verbatim.

### 21.3 Handshake

Mandatory four-message sequence before any other call. If the plugin sends any non-handshake message before completing handshake, the host kills the iframe.

```
host                                            plugin
  │                                                │
  │ kind:'request' method:'hello' params:{          │
  │   instanceId, panelId, hostVersion,             │
  │   permissionsGranted: HostPermission[],         │
  │   sdkProtocolVersion: 1                         │
  │ }                                               │
  │ ─────────────────────────────────────────────► │
  │                                                │
  │ ◄───────────────────────────────────────────── │
  │ kind:'response' ok:true result:{               │
  │   sdkProtocolVersion: 1,                       │
  │   pluginVersion: string,                       │
  │   ready: boolean                               │
  │ }                                              │
  │                                                │
  │ kind:'event' topic:'lifecycle' payload:{       │
  │   phase:'active'                               │
  │ }                                              │
  │ ─────────────────────────────────────────────► │
  │                                                │
  │ ◄───────────────────────────────────────────── │
  │ kind:'request' method:'panel.subscribe'        │
  │ ... (normal traffic)                           │
```

Handshake timeout: 5 seconds. Iframe is killed and restarted once on timeout; second failure surfaces as an error in the extensions panel.

### 21.4 Subscriptions

`*.onChange` / `*.onMessage` / `*.subscribe` methods return a subscription id. The host then emits `kind:'event'` envelopes with `topic: "subscription:<id>"` until the plugin calls `subscription.release({ id })`.

```ts
// plugin asks
{ kind:'request', id: 7, method: 'editor.onChange', params: { path: 'src/foo.ts' } }
// host responds
{ kind:'response', id: 7, ok: true, result: { subscriptionId: 'sub_42' } }
// host emits, possibly many times
{ kind:'event', topic: 'subscription:sub_42', payload: { content: '...' } }
// plugin releases
{ kind:'request', id: 8, method: 'subscription.release', params: { id: 'sub_42' } }
{ kind:'response', id: 8, ok: true, result: null }
```

The host garbage-collects subscriptions on iframe unload, panel close, or handshake timeout.

### 21.5 Permission gating

Every method's first argument is implicitly gated against the plugin's granted permissions (declared in the manifest, accepted by the user at install time). The host enforces:

- Plugin calls method requiring permission `editor.write` but didn't declare it → response `ok: false`, error code `permission_not_declared`.
- Plugin declared it but user never granted it (third-party install, modal dismissed) → response `ok: false`, error code `permission_not_granted`. Host may prompt for elevation if `interactive: true` is set on the request — UX is a host modal.
- Built-in plugins ship with all required permissions pre-granted (still declared in their manifest).

### 21.6 Error codes

| code | meaning |
|--|--|
| `permission_not_declared` | Manifest does not declare the required permission. |
| `permission_not_granted` | User has not granted the declared permission. |
| `method_not_found` | Host does not implement this method (probably an SDK/host version mismatch). |
| `invalid_params` | Params did not match the method's expected schema. |
| `not_found` | Target object (file, task, panel instance) does not exist. |
| `conflict` | State changed between read and write; retry. |
| `unsupported_capability` | Required agent capability is missing for this call. |
| `internal` | Host bug. Includes a request id reference for logs. |
| `timeout` | Host method exceeded its budget (10s default for synchronous, no budget for subscriptions). |

### 21.7 Reconnection

Iframe crash, hang, or reload → host treats as fatal. State and subscriptions are dropped. Host re-mounts the iframe and replays the handshake. The plugin is responsible for re-subscribing to anything it needs. No automatic restore of subscription state.

### 21.8 Reference implementation (SDK shim)

A second agent can copy the following into `packages/sdk/src/host.ts` as the client-side adapter:

```ts
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
const subscriptions = new Map<string, (payload: any) => void>();

function send(env: RpcEnvelope) {
  window.parent.postMessage(env, '*');  // host validates origin
}

function call<T>(method: string, params: unknown): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ kind: 'request', id, method, params });
  });
}

window.addEventListener('message', (event) => {
  const env = event.data as RpcEnvelope;
  if (env.kind === 'response') {
    const p = pending.get(env.id);
    if (!p) return;
    pending.delete(env.id);
    env.ok ? p.resolve(env.result) : p.reject(env.error);
  } else if (env.kind === 'event' && env.topic.startsWith('subscription:')) {
    const id = env.topic.slice('subscription:'.length);
    subscriptions.get(id)?.(env.payload);
  }
});
```

The full `PolyporeHost` interface from §4.3 is implemented as named wrappers over `call(...)`. Subscription methods register a callback in `subscriptions` and return an `Unsubscribe` that calls `subscription.release`.

---

## 22. MCP tool schemas (`polypore-ide` server)

Every tool the server exposes. Conventions:

- All inputs are JSON objects (never bare positional args).
- All outputs are JSON-serializable.
- Errors throw with the same code set as §21.6.
- Tools that mutate state always return the post-mutation entity (or a confirmation envelope).

### 22.1 Awareness

**`polypore.manual`**

```json
// input
{}
// output
{ "manual": "string (markdown)" }
```

Returns the canonical IDE manual assembled from manifest `manual` fields plus the master-doc precedence rules. Agents are expected to call this at session start.

**`polypore.workspace.describe`**

```json
// input
{}
// output
{
  "workspace": "Build",
  "activePanel": "polypore.editor:instance-7",
  "panels": [
    { "instanceId": "polypore.chat:instance-1", "panelId": "polypore.chat", "area": "left" },
    { "instanceId": "polypore.editor:instance-7", "panelId": "polypore.editor", "area": "center" }
  ]
}
```

**`polypore.state.get`**

```json
// input
{ "key": "activeAgent" }
// output
{ "value": "claude" }
```

### 22.2 Editor

**`polypore.editor.open`**

```json
// input
{ "path": "src/foo.ts", "line": 42, "column": 0 }
// output
{ "opened": true, "path": "src/foo.ts" }
```

**`polypore.editor.read`**

```json
// input
{ "path": "src/foo.ts" }
// output
{ "path": "src/foo.ts", "content": "...", "language": "typescript" }
```

**`polypore.editor.apply_edit`**

```json
// input
{
  "path": "src/foo.ts",
  "edits": [
    { "range": { "start": { "line": 10, "column": 0 }, "end": { "line": 10, "column": 0 } },
      "newText": "// new comment\n" }
  ]
}
// output
{ "applied": true, "path": "src/foo.ts" }
```

The editor's Monaco buffer applies the edits live. Cursor and selection are preserved where possible.

**`polypore.editor.search`**

```json
// input
{ "query": "TODO", "regex": false, "glob": "src/**/*.ts" }
// output
{
  "matches": [
    { "path": "src/foo.ts", "line": 12, "column": 3, "lineText": "// TODO: handle null" }
  ]
}
```

### 22.3 Tasks

**`polypore.tasks.list`** — input `{}`, output `{ "tasks": Task[] }`.

**`polypore.tasks.add`**

```json
// input
{ "label": "wire up the verify queue", "parentId": null, "panelHint": "polypore.verify" }
// output
{ "task": { "id": "...", "label": "...", "done": false, "createdAt": 0, "createdBy": "agent" } }
```

**`polypore.tasks.update`**

```json
// input
{ "id": "task-id", "done": true }
// output
{ "task": { ... } }
```

### 22.4 Diagnostics & verify

**`polypore.diagnostics.list`**

```json
// input
{ "severity": "error", "file": "src/foo.ts" }
// output
{ "diagnostics": [ { "id": "...", "severity": "error", "source": "tsserver", "file": "src/foo.ts", "range": {...}, "message": "..." } ] }
```

**`polypore.verify.run`** — input `{ "id": "typecheck" }`, output `{ "run": VerifyRun }`.

**`polypore.verify.results`** — input `{}`, output `{ "runs": VerifyRun[] }`.

**`polypore.verify.declare`**

```json
// input
{
  "commands": [
    { "id": "typecheck", "label": "typecheck", "cmd": "npm run build", "required": true },
    { "id": "tests", "label": "tests", "cmd": "npm test -- --watchAll=false", "required": true }
  ]
}
// output
{ "declared": true, "path": "<project>/.polypore/verify.json" }
```

### 22.5 Knowledge base

**`polypore.memory.list`** — input `{ "path": "" }` (optional subtree root), output `{ "nodes": KnowledgeNode[] }`.

**`polypore.memory.read`** — input `{ "path": ".knowledge/docs/index.md" }`, output `{ "path": "...", "content": "..." }`.

**`polypore.memory.write`**

```json
// input
{ "path": ".knowledge/docs/notes.md", "content": "# notes\n..." }
// output
{ "written": true, "path": "..." }
```

**`polypore.memory.link`**

```json
// input
{ "from": ".knowledge/docs/a.md", "to": ".knowledge/docs/b.md", "displayText": "see b" }
// output
{ "linked": true }
```

**`polypore.memory.handoff`**

```json
// input
{
  "summary": "started porting chat panel to plugin contract; stuck on handshake timeout",
  "nextSteps": ["check origin validation", "investigate iframe srcdoc"],
  "context": ["packages/host/src/loader.ts", "packages/sdk/src/host.ts"]
}
// output
{ "path": ".knowledge/handoffs/2026-05-16-chat-port.md" }
```

### 22.6 Workflow & phase

**`polypore.phase.report`** — input `{ "phase": "green", "status": "running" }`, output `{ "reported": true }`.

**`polypore.workflow.update`** — input `{ "nodes": WorkflowNode[], "edges": WorkflowEdge[] }`, output `{ "updated": true }`.

### 22.7 Panels & UI

**`polypore.panel.open`** — input `{ "id": "polypore.diff-history", "area": "center" }`, output `{ "instanceId": "..." }`.

**`polypore.panel.close`** — input `{ "instanceId": "..." }`, output `{ "closed": true }`.

**`polypore.ui.notify`** — input `{ "level": "info", "msg": "build complete" }`, output `{ "shown": true }`.

### 22.8 Preview

**`polypore.preview.register`**

```json
// input
{ "kind": "site", "command": "npm start", "target": "http://localhost:3000" }
// output
{ "target": PreviewTarget }
```

**`polypore.preview.refresh`** — input `{}`, output `{ "refreshed": true }`.

### 22.9 History

**`polypore.history.events`** — input `HistoryFilter`, output `{ "events": HistoryEvent[] }`.

**`polypore.history.fork`** — input `{ "eventId": "..." }`, output `{ "worktree": WorktreeRef }`.

### 22.10 Records

**`polypore.adr.record`**

```json
// input
{ "title": "every panel is a plugin", "body": "## context\n..." }
// output
{ "path": ".knowledge/adrs/2026-05-16-every-panel-is-a-plugin.md" }
```

### 22.11 Plugin install pipeline (agent-driven)

This group is the load-bearing feature for community plugins. **Hard rule: `polypore.plugins.install` always shows a user-confirmation modal in the host UI, even when called by the agent. The agent cannot install plugins silently.**

**`polypore.plugins.fetch`**

```json
// input
{ "url": "https://github.com/someone/cool-panel", "ref": "main" }
// output
{
  "stagingPath": "~/.cache/polypore/staging/abc123/",
  "source": { "kind": "github", "url": "https://github.com/someone/cool-panel", "commit": "abc123def456", "ref": "main" },
  "fileTree": FileNode[]
}
```

Always resolves `ref` to a specific commit before returning. Even if the user provided a branch, the staging record pins to the commit at fetch time. No silent updates.

**`polypore.plugins.scan`**

```json
// input
{ "stagingPath": "~/.cache/polypore/staging/abc123/" }
// output
{
  "candidates": [
    {
      "manifestPath": "panels/timeline-pro/polypore.json",
      "rootPath": "panels/timeline-pro/",
      "manifest": PanelManifest
    }
  ]
}
```

Walks the staging dir to any depth, finds every valid `polypore.json`, validates the schema, returns candidates. Invalid manifests are dropped with reasons available via `inspect`.

**`polypore.plugins.inspect`**

```json
// input
{ "stagingPath": "~/.cache/polypore/staging/abc123/", "manifestPath": "panels/timeline-pro/polypore.json" }
// output
{
  "manifest": PanelManifest,
  "files": [{ "path": "...", "sizeBytes": 0 }],
  "totalSizeBytes": 0,
  "errors": [],
  "warnings": []
}
```

**`polypore.plugins.install`**

```json
// input
{
  "stagingPath": "~/.cache/polypore/staging/abc123/",
  "manifestPath": "panels/timeline-pro/polypore.json",
  "scope": "project"
}
// output
{ "installed": true, "plugin": PluginRef }
// or
{ "installed": false, "reason": "user_declined" }
```

Host always renders a modal showing manifest summary, declared permissions, commit hash, scope. Modal cannot be bypassed. If the user declines, the call returns `installed: false` with reason; not an error.

**`polypore.plugins.list`** — input `{ "scope": "project" }` (optional, defaults to all), output `{ "plugins": PluginRef[] }`.

**`polypore.plugins.enable`** / **`polypore.plugins.disable`** — input `{ "id": "polypore.timeline-pro" }`, output `{ "enabled": true|false }`. May trigger a host modal for permission re-grant if the plugin's declared permissions changed since last grant.

**`polypore.plugins.uninstall`** — input `{ "id": "polypore.timeline-pro" }`, output `{ "uninstalled": true }`. Always triggers a host modal.

### 22.12 Secrets (agent never receives values)

The most security-critical tool group in the entire surface. **Invariant: no MCP tool exists that returns a secret value. There is no read.** Reading by any agent or plugin is structurally impossible.

**`polypore.secrets.list`**

```json
// input
{ "scope": "user" }
// output
{
  "secrets": [
    { "id": "anthropic-prod", "scope": "user", "service": "anthropic", "hint": "sk-ant-•••42a3", "configured": true, "lastUsedAt": 1747400000000 },
    { "id": "github-pat", "scope": "user", "service": "github", "hint": "ghp_•••xyz1", "configured": true }
  ]
}
```

`scope` is optional. Omitted → returns user-scope plus project-scope for the active project. Result entries never contain the secret value, only the hint (masked preview).

**`polypore.secrets.has`**

```json
// input
{ "id": "anthropic-prod" }
// output
{ "configured": true }
```

**`polypore.secrets.use`**

```json
// input
{
  "id": "anthropic-prod",
  "request": {
    "url": "https://api.anthropic.com/v1/messages",
    "method": "POST",
    "headers": {
      "x-api-key": "${secret}",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    "body": { "model": "claude-opus-4-7", "max_tokens": 1024, "messages": [{"role":"user","content":"hi"}] }
  }
}
// output
{
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": "{\"id\":\"msg_01...\",\"content\":[{\"type\":\"text\",\"text\":\"...\"}]}"
}
```

Semantics:
- The literal string `"${secret}"` in any header value is replaced by the resolved secret at request time, inside the Rust process.
- The Rust shell scrubs the response of any byte sequence equal to the secret before returning. This catches accidental echoes.
- `url` must be `https://` unless `allowInsecure: true` is set, which triggers a host-modal user confirmation before sending.
- Default timeout 30s, hard ceiling 120s.
- Logging: the request URL and method are logged to history; the headers and body are **not** logged.

**`polypore.mcp.invoke`**

```json
// input
{
  "server": "anthropic-api",
  "method": "messages.create",
  "args": { "model": "claude-opus-4-7", "messages": [...] },
  "authRef": "anthropic-prod"
}
// output
// whatever the MCP server returns (already scrubbed if authRef was used)
```

For invoking other MCP servers from inside the IDE without exposing keys to the renderer or the agent.

**`polypore.secrets.install` / `.rotate` / `.delete`** are intentionally **not** part of the agent-facing MCP surface. Configuration happens through the host UI only (Settings → Credentials). If we ever expose write-side tools, they would call `polypore.ui.confirm` for every operation and store nothing the user didn't physically type.

### 22.13 Skills (cross-agent prompt fragments)

Skills are markdown files. Storage paths (precedence: project > user > builtin):

- `<project>/.polypore/skills/<id>.md` (project scope)
- `~/.config/polypore/skills/<id>.md` (user scope)
- `<app-resources>/skills/<id>.md` (builtin scope; ships with the app)

Frontmatter (optional YAML at the top of each file):

```yaml
---
name: evanflow-tdd
summary: vertical-slice tdd loop for any production code
capabilities: [tool-use]
arguments:
  - id: focus
    label: which file to start with
    required: false
---
# body of the skill follows; markdown
```

**`polypore.skills.list`**

```json
// input
{ "scope": "project" }
// output
{
  "skills": [
    { "id": "evanflow-tdd", "name": "evanflow-tdd", "scope": "user", "summary": "vertical-slice tdd...", "path": "/home/u/.config/polypore/skills/evanflow-tdd.md", "updatedAt": 1747000000000 }
  ]
}
```

`scope` is optional; omitted returns all three scopes merged with precedence applied (project hides user hides builtin if `id` collides).

**`polypore.skills.read`**

```json
// input
{ "id": "evanflow-tdd" }
// output
{
  "skill": {
    "id": "evanflow-tdd",
    "name": "evanflow-tdd",
    "scope": "user",
    "summary": "vertical-slice tdd...",
    "path": "...",
    "body": "# evanflow-tdd\n\n...",
    "frontmatter": { "capabilities": ["tool-use"] },
    "createdAt": 1747000000000,
    "updatedAt": 1747000000000
  }
}
```

**`polypore.skills.invoke`**

```json
// input
{ "id": "evanflow-tdd", "sessionId": "chat-1", "args": { "focus": "src/foo.ts" } }
// output
{ "invoked": true }
```

Semantics:
- The host injects the skill body into the named chat session as a new message with role `user` and a `[skill: <name>]` prefix.
- If `args` is provided and the skill declares `arguments` in frontmatter, the host substitutes `{{argId}}` placeholders in the body before injection.
- If the skill requires a capability the active agent lacks, the call returns `unsupported_capability` and the host shows a tooltip on the skill card.

**`polypore.skills.create` / `.update` / `.delete`**

```json
// create input
{ "scope": "project", "name": "release-notes", "summary": "draft release notes from the diff stack", "body": "## context\n..." }
// create output
{ "skill": Skill }
```

`create` and `delete` trigger a host-modal confirmation when called by the agent. `update` does not (existing files; the user already approved them).

**Builtin skills** ship in `<app-resources>/skills/` and cannot be modified by the agent. They appear in `list` with `scope: 'builtin'`. Users can override them with same-`id` files in user or project scope; the override wins.

### 22.14 Documentation

Every tool above must also be listed in the output of `polypore.manual` so the agent learns about them on first call. The MCP server reads its own tool registry to generate the manual section about tools.

The `polypore.secrets.*` and `polypore.mcp.invoke` tools, when listed, **carry an explicit warning in their description that the agent must never repeat a secret value back, even one it constructed itself (e.g., concatenated header strings)**. The Rust shell's response-scrubbing layer is a safety net, not the only line of defense.

---

## 23. Repo layout, build, dev, test

### 23.1 Top-level layout

```
polypore/
├── apps/
│   └── desktop/                 # Tauri app, renderer entry, dockview shell
│       ├── src/                 # main React renderer (host UI, chrome)
│       ├── src-tauri/           # Rust shell crate
│       │   ├── Cargo.toml
│       │   ├── tauri.conf.json
│       │   └── src/
│       │       ├── main.rs
│       │       ├── agent/
│       │       │   ├── mod.rs           # AgentRuntime trait + ACP probe
│       │       │   ├── claude_stdio.rs  # stdio adapter for claude
│       │       │   ├── codex_stdio.rs   # stdio adapter for codex
│       │       │   └── acp.rs           # native ACP adapter (upgrade target)
│       │       ├── pty.rs       # portable-pty terminal supervisor
│       │       ├── fs_watch.rs
│       │       ├── secrets.rs   # keyring read/write + response scrubbing
│       │       └── mcp_super.rs # polypore-ide MCP server supervisor
│       ├── public/
│       ├── index.html
│       ├── vite.config.ts
│       └── package.json
├── packages/
│   ├── sdk/                     # PanelManifest, PolyporeHost (§20, §27.1)
│   │   ├── src/
│   │   │   ├── types.gen.ts     # GENERATED from schemas/; do not edit
│   │   │   ├── validators.gen.ts # GENERATED Ajv validators
│   │   │   ├── host.ts          # client-side RPC adapter (hand-written)
│   │   │   ├── manifest.ts
│   │   │   └── index.ts
│   │   └── package.json
│   ├── host/                    # host-side RPC server + plugin loader + event bus
│   │   ├── src/
│   │   │   ├── loader.ts
│   │   │   ├── rpc-server.ts
│   │   │   ├── event-bus.ts
│   │   │   ├── capability-registry.ts
│   │   │   ├── permissions.ts
│   │   │   └── index.ts
│   │   └── package.json
│   ├── mcp-server/              # polypore-ide MCP server (Node)
│   │   ├── src/
│   │   │   ├── server.ts        # @modelcontextprotocol/sdk entry
│   │   │   ├── tools/           # one file per tool group
│   │   │   ├── host-socket.ts   # talks to renderer host over a private socket
│   │   │   └── manual.ts        # generates polypore.manual output
│   │   └── package.json
│   └── ui/                      # shared CSS, fonts, glyphs
│       └── src/
│           ├── tokens.css
│           ├── chrome.css
│           └── glyphs.css
├── plugins/
│   ├── chat/
│   │   ├── polypore.json
│   │   ├── src/
│   │   └── package.json
│   ├── editor/
│   ├── preview/
│   ├── diff-history/
│   ├── terminal/
│   ├── verify/
│   ├── memory/
│   ├── agent/
│   └── problems/
├── schemas/                       # JSON Schema canonical source (§27.1)
│   ├── manifest.schema.json
│   ├── rpc/                       # one file per host RPC group
│   ├── mcp-tools.schema.json
│   ├── events.schema.json
│   └── persistence.schema.json
├── scripts/
│   └── codegen-ts.mjs             # runs json-schema-to-typescript + ajv-cli
├── docs/
│   ├── mockups/2026-05-16-build-workspace/   # frozen mockup
│   ├── specs/2026-05-14-operator-ide-prd.md
│   ├── specs/2026-05-16-master-implementation-plan.md  # this file
│   └── ui-direction.md
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
└── README.md
```

### 23.2 Workspace manifest

```yaml
# pnpm-workspace.yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'plugins/*'
```

### 23.3 Root `package.json`

```json
{
  "name": "polypore",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "codegen": "node scripts/codegen-ts.mjs",
    "predev": "pnpm codegen",
    "prebuild": "pnpm codegen",
    "dev": "pnpm -r --parallel run dev",
    "dev:desktop": "pnpm --filter @polypore/desktop dev",
    "dev:mcp": "pnpm --filter @polypore/mcp-server dev",
    "build": "pnpm -r run build",
    "build:plugins": "pnpm --filter './plugins/*' run build",
    "test": "pnpm -r run test",
    "test:rust": "cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml",
    "lint": "pnpm -r run lint",
    "typecheck": "pnpm codegen && pnpm -r run typecheck",
    "tauri": "pnpm --filter @polypore/desktop tauri"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2",
    "typescript": "^5",
    "vite": "^5",
    "vitest": "^1",
    "@playwright/test": "^1",
    "ajv": "^8",
    "ajv-cli": "^5",
    "json-schema-to-typescript": "^15"
  }
}
```

### 23.4 `apps/desktop/package.json` (renderer)

```json
{
  "name": "@polypore/desktop",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@polypore/sdk": "workspace:*",
    "@polypore/host": "workspace:*",
    "@polypore/ui": "workspace:*",
    "dockview": "^1",
    "react": "^18",
    "react-dom": "^18",
    "react-flow-renderer": "^11",
    "monaco-editor": "^0",
    "xterm": "^5"
  }
}
```

### 23.5 `apps/desktop/vite.config.ts`

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@polypore/sdk': path.resolve(__dirname, '../../packages/sdk/src'),
      '@polypore/host': path.resolve(__dirname, '../../packages/host/src'),
      '@polypore/ui': path.resolve(__dirname, '../../packages/ui/src'),
    },
  },
  server: { port: 1420, strictPort: true },
  build: { target: 'esnext' },
});
```

### 23.6 `apps/desktop/src-tauri/tauri.conf.json` (skeleton)

```json
{
  "productName": "Polypore",
  "version": "0.1.0",
  "identifier": "dev.polypore.app",
  "build": {
    "beforeDevCommand": "pnpm dev",
    "beforeBuildCommand": "pnpm build",
    "devUrl": "http://localhost:1420",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "Polypore",
        "width": 1400,
        "height": 900,
        "minWidth": 1100,
        "minHeight": 700,
        "decorations": true
      }
    ],
    "security": {
      "csp": "default-src 'self' tauri://localhost; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ipc: tauri:; frame-src plugin:"
    }
  },
  "plugins": {
    "sql": { "preload": ["sqlite:sessions.db"] },
    "shell": {
      "open": "^https?://.+"
    }
  }
}
```

### 23.7 `apps/desktop/src-tauri/Cargo.toml` (skeleton)

```toml
[package]
name = "polypore-shell"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }
typify = "0.1"        # generates types_gen.rs from schemas/

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-sql = { version = "2", features = ["sqlite"] }
tauri-plugin-shell = "2"            # ui.openExternal (system browser handoff)
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
anyhow = "1"
notify = "6"          # FS watcher
portable-pty = "0.8"  # pty (no node-pty)
which = "6"           # PATH lookup for claude/codex
keyring = "2"         # OS keyring for secrets (Keychain/Secret Service/Credential Manager)
reqwest = { version = "0.12", features = ["rustls-tls", "json", "stream"] }  # outbound HTTP for polypore.secrets.use
zeroize = "1"         # zero out secret values in memory after use
jsonschema = "0.18"   # runtime validation of incoming IPC envelopes against schemas/

[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

### 23.8 `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "jsx": "react-jsx",
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  }
}
```

### 23.9 Plugin scaffold (one per panel)

Each plugin under `plugins/<name>/`:

```
plugins/chat/
├── polypore.json            # the manifest
├── index.html               # iframe entry
├── src/
│   └── main.tsx             # imports @polypore/sdk and renders
├── vite.config.ts           # builds to dist/ (loaded by index.html)
├── tsconfig.json
└── package.json
```

Example `polypore.json`:

```json
{
  "schemaVersion": 1,
  "id": "polypore.chat",
  "title": "chat",
  "icon": "/>",
  "version": "0.1.0",
  "entry": "dist/index.html",
  "permissions": ["chat.read", "chat.send", "workspace.read", "ui.notify"],
  "capabilities": ["streaming", "tool-use"],
  "category": "agent",
  "defaultArea": "left",
  "manual": {
    "summary": "conversation surface for the active agent...",
    "tips": ["enter sends; shift-enter for newline", "+ opens an agent picker"]
  }
}
```

### 23.10 Test strategy

- **Renderer (TypeScript):** Vitest + React Testing Library. Per-package `test:` script. Snapshot tests for static panels; behavioral tests for interaction-heavy ones.
- **Shell (Rust):** `cargo test`. Focus on ACP routing, pty supervision, FS watch dedup, snapshot dedup.
- **MCP server:** Vitest + a stub host socket. Each tool gets at least one happy-path and one error-path test.
- **Integration:** Playwright runs the full Tauri app in dev mode and exercises end-to-end flows (open project → open panel → run tool → see history event).
- **Visual regression (optional, deferred):** Playwright screenshot diff against snapshots stored under `docs/mockups/2026-05-16-build-workspace/screenshots/`.

### 23.11 Local dev commands

```bash
# install
pnpm install

# run the full app in dev
pnpm dev:desktop          # renderer
# in another terminal:
pnpm tauri dev            # native shell

# run the MCP server standalone (point Claude Code at it)
pnpm dev:mcp

# tests
pnpm test                 # all TS
pnpm test:rust            # all Rust

# production build
pnpm build
pnpm tauri build
```

---

## 24. Resolved micro-decisions

A list of small calls that were left ambiguous in earlier sections. Resolved now so a second agent doesn't have to invent them.

### 24.1 Layout boundary: chat is a plugin

Chat is a normal plugin docked into a left dockview group with a default width of ~33% of the window. The mockup's hand-rolled left-pane grid is replaced by dockview's standard splitter. No privileged "chrome" panels.

### 24.2 Styling system

Plain CSS, one file per component or per panel. Class names follow the BEM-ish flavor used in the frozen mockup (`.diff-files__entry--active`). The frozen mockup's `App.css` is copy-able and survives migration with cosmetic edits as panels split out of `App.tsx`. **No Tailwind, no CSS-in-JS, no styled-components.** Shared design tokens live in `packages/ui/src/tokens.css`.

### 24.3 State management

Three layers:

1. **Local state** lives in panel components via `useState`. Most state should be here.
2. **Cross-panel state** lives in the host. Panels never reach into the host directly; they observe via `host.state.subscribe(...)` and mutate via host RPC.
3. **Persistent state** lives in SQLite or filesystem (§10). Host reads on load, writes on mutation.

No Redux. No Zustand at this layer — the event bus + state subscription model in §8 covers it. The host's internal store is a tiny ref-and-emit class (`packages/host/src/state.ts`) — same shape as `eventBus.ts`.

### 24.4 Agent runtime: stdio adapter is the default

The M5 default is the stdio adapter, not native ACP. Each agent (claude, codex) has a dedicated stdio adapter under `apps/desktop/src-tauri/src/agent/`. All adapters implement the `AgentRuntime` trait (§16 M5). At agent connect, the shell runs an ACP probe; if it succeeds, the runtime upgrades to the ACP adapter automatically without a restart. If the probe fails, the stdio adapter keeps serving. This means: no feature flag, no manual switch, no broken state if upstream ACP changes. The status segment in the top bar surfaces which adapter is live (`claude · stdio` vs `claude · acp`).

### 24.5 Plugin permission grants

- Built-in plugins ship pre-granted.
- Third-party plugins prompt at install time, showing all declared permissions in one modal.
- A plugin requesting an undeclared permission at runtime gets `permission_not_declared`. No silent escalation.
- A plugin can request elevation interactively via `host.ui.confirm` if the manifest allows.

### 24.6 File path conventions

- `<project>/.polypore/` for the new namespace.
- `<project>/.knowledge/` for KB content (docs, ADRs, handoffs, agent conventions).
- `<project>/.claude/verify.json` is read for backward compatibility but the canonical location is `<project>/.polypore/verify.json`. If both exist, `.polypore/` wins.
- `~/.config/polypore/` for user-scope settings, skills, plugins.
- `~/.cache/polypore/staging/` for plugin fetch staging.
- `~/.local/share/polypore/sessions.db` for SQLite.

### 24.7 ID conventions

- Built-in plugins: `polypore.<short>` (`polypore.chat`, `polypore.editor`).
- Third-party: reverse-domain (`com.acme.timeline-pro`).
- Panel instance ids: `<pluginId>:<incrementing>` (`polypore.chat:1`).
- Task ids, chat session ids, history event ids: ULID or UUIDv7.

### 24.8 Versioning

- The SDK has a `sdkProtocolVersion` integer (currently 1). Host and plugin must agree at handshake.
- Manifests carry a `schemaVersion` integer. Host validates and rejects unknown versions.
- MCP server pins its protocol to the app version. Agents connecting to a mismatched MCP server get a startup warning in chat.

### 24.9 Lowercase rule

All visible UI copy is lowercase, including this doc's mockup-rendered strings (per ui-direction.md). Plugin authors must follow this; the host does **not** auto-lowercase user-provided content (file paths, KB doc titles, etc.). Display-only chrome (panel titles, button labels, menu items) is lowercase.

### 24.10 Iconography

Glyphs are 2–3 character ASCII strings (`/>`, `{}`, `+-`, `$`, `vf`, `kb`, `ai`, `!`, `ts`, `www`, `mob`, `pad`, `ok`, `win`, `$_`). No emoji. No SVG icon sets. Plugin manifests declare an `icon` field that follows this convention; the host does not validate beyond requiring 1–4 characters.

### 24.11 Color tokens

Lifted from the mockup CSS. Specifics live in `packages/ui/src/tokens.css`; reference only:

- accent: honey/amber/brown (`--accent-honey`, `--accent-amber`, `--accent-rust`)
- bg base: dark translucent (`--bg-panel`, `--bg-stage`)
- active panel: frostier and brighter than inactive
- monospace stack: system mono first, then a bundled IBM Plex Mono fallback

### 24.12 Secrets model

- Storage: OS keyring (§10.3). No plaintext on disk, ever.
- Scope: user-default, project-override. Project wins when both exist for the same `id`.
- The renderer never holds a secret value. Even the credentials-form value field sends to the Rust shell over a single IPC call and is dropped from React state immediately on send.
- The agent never receives a secret value. The strongest grant it has is `polypore.secrets.use`, which performs an authenticated outbound call mediated by the Rust shell.
- Response scrubbing in the Rust shell is a safety net. The primary defense is that the value never enters renderer or agent memory in the first place.
- `.env` files: import-and-replace, not edit-in-place. The IDE never offers a "edit .env" affordance — keys belong in the keyring.

### 24.13 Routing of mockup behaviors to plugins

The mockup contains many helper components (`PanelHeader`, `ResizeHandle`, `TabStrip`, `BuildSurface`, etc.). When porting:

- `TopBar`, `BottomBar`, `TabStrip` → host chrome (in `apps/desktop/src/chrome/`).
- `PanelSettingsOverlay`, `PanelHelpOverlay` → host chrome, driven by manifest fields. **Plugins do not render these overlays themselves.**
- `PanelHeader` → host chrome rendered around each plugin's iframe. Plugin only renders the body.
- Every other surface (chat region, editor, preview, diff-history, …) → ports into a plugin.

The plugin iframe never renders its own panel chrome (title bar, settings/help buttons). The host wraps it. This guarantees consistent affordances across built-ins and third-party panels.

---

## 25. Hand-off checklist (for an agent picking this up cold)

If you are an agent given this document, do these things in order before writing any code:

1. **Read the frozen mockup** at `docs/mockups/2026-05-16-build-workspace/App.tsx` end-to-end. This is the source of truth for visual and interaction behavior.
2. **Open `docs/mockups/2026-05-16-build-workspace/App.css`** alongside it. Skim. Note the color tokens and class-name conventions.
3. **Read this master plan** sections 0–24.
4. **Read `src/core/types.ts`, `src/core/eventBus.ts`, `src/core/capabilityRegistry.ts`, `src/workspaces/presets.ts`** — these are the surviving spine fragments. Carry them into the new layout (§23.1).
5. **Read `docs/specs/2026-05-14-operator-ide-prd.md`** only when this document explicitly references it. Treat the PRD as background; this plan supersedes it.
6. **Begin at M0** (§16). Do not skip ahead. Each milestone produces a runnable app.
7. **Before any panel work, complete M1 and M2.** The plugin contract has to exist before you port a single panel into it.
8. **Re-validate against the mockup after each milestone.** Pixel-level deviation is a bug.
9. **Never edit `docs/mockups/2026-05-16-build-workspace/`.** When the mockup and any other doc disagree, file an update to the doc, not the mockup.
10. **Stop and ask the user** when: a host RPC method is needed that isn't in §4.3, a permission isn't in §20, an MCP tool is needed that isn't in §22, a domain object is needed that isn't in §7, or any visual element in the mockup is unclear after reading the CSS.

If those ten steps are completed, the rest of the work is execution against committed specs. There should be no architectural decisions left to invent.

---

## 26. Naming map, conventions, and final consistency notes

### 26.1 Mockup → plugin-id rename map

The frozen mockup uses short `PanelType` strings in `src/core/types.ts` (e.g., `extensions`, `diff-stack`). The new plugin contract uses dotted plugin ids. The mapping is fixed:

| Mockup `PanelType` | Mockup display label | Plugin id |
|--|--|--|
| `chat` | `chat` | `polypore.chat` |
| `preview` | `preview` | `polypore.preview` |
| `editor` | `editor` | `polypore.editor` |
| `diff-stack` | `diff` | `polypore.diff-history` |
| `terminal` | `terminal` | `polypore.terminal` |
| `verify` | `verify` | `polypore.verify` |
| `memory` | `memory` | `polypore.memory` |
| `extensions` | `agent` | `polypore.agent` |
| `problems` | `problems` | `polypore.problems` |
| `timeline` | `history` | folded into `polypore.diff-history` |

The display label is what the panel header shows. The plugin id is what the manifest declares. The mockup's `PANEL_META` table is the source of truth for both.

The mockup also calls the project "operator-ide" inside `TopBar`. After migration, that string is the live project name (read from `package.json`'s `name`); the chrome reads it from state, doesn't hardcode it.

### 26.2 Calling convention summary

| Layer | Naming | Argument style |
|--|--|--|
| Host RPC (TypeScript, §4.3) | `camelCase` (`editor.applyEdit`) | Native function args; the SDK packages them into the wire envelope's `params` object |
| Wire envelope (§21) | Method string is `camelCase` matching host RPC | Single `params: unknown` field; always an object |
| MCP tool name (§22) | `dotted.snake_case` (`polypore.editor.apply_edit`) | Single JSON object input; MCP server translates to host RPC |
| Event bus (§8) | `subject:action` (`history:event`, `tasks:changed`) | Strongly-typed discriminated union |
| State key (§20) | `camelCase` (`activeAgent`, `contextUsedPct`) | Indexed by `StateKey` |
| Permission (§4.4) | `subject.action` (`editor.write`) | Static string union |

The MCP server is a thin translator: it accepts MCP-named tools, validates the input against the schema in §22, and dispatches to the matching host RPC. Adding a tool is two lines in the server registry plus a schema entry — no separate logic.

### 26.3 Custom drag-drop MIME types

The mockup uses three custom MIME types for in-app drag-drop. Ports must preserve these:

- `application/x-fix-item` — dragging a problem/check from the verify panel's left column onto the queue
- `application/x-queue-item` — reordering queue items
- `application/x-knowledge-file` — dragging a KB tree entry onto the memory panel's context list

Any other interactive drag-drop (e.g., tab reorder in the stage strip) uses native HTML5 drag-drop with a per-mockup `dataTransfer` payload — see the corresponding mockup function (`reorderTab` for tabs).

### 26.4 Resize ranges (from the mockup)

| Splitter | Range | Default |
|--|--|--|
| Chat region width | 22vw–48vw | 33vw |
| Agent panel details width | 24%–45% | 33% |
| Agent panel skills vs tasks height | 30%–70% | 48% |
| Stage vertical splits / dockview splits | dockview defaults | n/a |

These ranges are *minimums*. dockview's standard splitter replaces the hand-rolled ones in M2; the host clamps to these ranges via dockview's `minimumWidth` / `minimumHeight` settings.

### 26.5 What was deliberately renamed or dropped vs. the PRD

For anyone cross-referencing the PRD: this plan renames `report_phase` → `polypore.phase.report`, `register_preview` → `polypore.preview.register`, `verify_commands` → `polypore.verify.declare`, `record_adr` → `polypore.adr.record`. The PRD's `timeline` panel is folded into `polypore.diff-history`. The PRD's compaction-first behavior is replaced by handoff-first (with `compress` retained as a fallback button). The PRD's five built-in workspaces (Plan/Implement/Review/Debug/Demo) are reduced to one: Build.

### 26.6 Open items

**None.** Every architectural decision is closed. Items resolved across drafts:

- **Skills host group** — §4.3, §20, §22.13, §11.8.
- **ACP maturity** — stdio adapter is M5 default; ACP probe upgrades automatically (§16 M5, §24.4).
- **Type generation strategy** — JSON Schema is the canonical source; TS and Rust types are codegen'd (§27).
- **Preview backend reliability** — embed-when-reliable, auto-fallback to system browser; Linux defaults to external (§27.2, §11.2).

---

## 27. Final commitments: schema source and preview backend

These two decisions were the last open items. Both are now closed.

### 27.1 JSON Schema is the canonical type source

Hand-maintained TypeScript in §20 was the first-draft solution. Going forward, **JSON Schema is the source of truth for every cross-process type**, and TypeScript/Rust types are generated.

**Why JSON Schema (not Rust-first via `ts-rs`/`specta`):**

- Most of our cross-process surface is TS ↔ TS: panel iframe ↔ host renderer (§21 wire protocol), Node MCP server ↔ agent (§22). Rust is only involved at the shell boundary, which is the smaller surface.
- The MCP protocol itself uses JSON Schema for tool input validation — the `@modelcontextprotocol/sdk` Node SDK ingests it natively.
- Third-party plugins ship `polypore.json` manifests in JSON; their authors are already in a JSON-Schema mindset.
- We can validate at runtime cheaply via Ajv on the host side and `jsonschema` crate on the Rust side. Same source feeds the validators on both sides.
- Rust-first would force every host RPC method to be authored in Rust first, then have its TS binding generated — wrong directional pressure for a primarily TS app.

**Repo layout:**

```
polypore/
├── schemas/                      # canonical JSON Schema files
│   ├── manifest.schema.json      # PanelManifest (§4.2)
│   ├── rpc/
│   │   ├── editor.schema.json    # all editor.* method params/results
│   │   ├── tasks.schema.json
│   │   ├── knowledge.schema.json
│   │   ├── diagnostics.schema.json
│   │   ├── verify.schema.json
│   │   ├── chat.schema.json
│   │   ├── history.schema.json
│   │   ├── workspace.schema.json
│   │   ├── preview.schema.json
│   │   ├── terminal.schema.json
│   │   ├── ui.schema.json
│   │   ├── secrets.schema.json
│   │   ├── mcp.schema.json
│   │   ├── skills.schema.json
│   │   ├── plugins.schema.json
│   │   └── state.schema.json
│   ├── mcp-tools.schema.json     # every polypore.* MCP tool input/output
│   ├── events.schema.json        # AppEvent union (§8)
│   └── persistence.schema.json   # SQLite row shapes + filesystem artifacts
├── packages/
│   └── sdk/
│       ├── src/
│       │   ├── types.gen.ts      # GENERATED from schemas/; do not edit
│       │   ├── validators.gen.ts # GENERATED Ajv validators
│       │   ├── host.ts           # client-side RPC adapter (hand-written)
│       │   └── index.ts          # re-exports
└── apps/desktop/src-tauri/src/
    └── types_gen.rs              # GENERATED from schemas/; do not edit
```

**Codegen pipeline:**

- TS types: `json-schema-to-typescript` runs over every file in `schemas/` and writes `packages/sdk/src/types.gen.ts`.
- TS validators: `ajv-cli` compiles each schema to a standalone validator function in `validators.gen.ts`.
- Rust types: `typify` (or `schemars`-reverse via a `build.rs` script) emits `apps/desktop/src-tauri/src/types_gen.rs`.

**Build integration.** Root `package.json` gets a `codegen` script that runs all three. `pnpm dev` and `pnpm build` depend on `codegen` running first; a missing-or-stale generated file is a build error, not a silent fallback. Cargo's `build.rs` runs the Rust codegen automatically.

```json
// root package.json additions
{
  "scripts": {
    "codegen": "pnpm codegen:ts && pnpm codegen:rust",
    "codegen:ts": "node scripts/codegen-ts.mjs",
    "codegen:rust": "echo 'rust codegen runs via build.rs at cargo invocation'",
    "predev": "pnpm codegen",
    "prebuild": "pnpm codegen"
  },
  "devDependencies": {
    "ajv": "^8",
    "ajv-cli": "^5",
    "json-schema-to-typescript": "^15"
  }
}
```

**Migration of §20:** the inline TypeScript in §20 becomes the **initial authoring** of `schemas/`. An implementer's first codegen task in M1 is to transcribe §20 into JSON Schema files, run codegen, and verify `types.gen.ts` matches §20 line-for-line. After that, **§20 in this doc is documentation only — the schemas are the source.** Future updates land in `schemas/`, not §20.

**Validation discipline.**

- Host RPC server validates every incoming request against the matching schema before dispatching (Ajv compiled validators, no runtime parse cost after first call).
- MCP server validates every tool call input against the matching schema (same Ajv validators).
- Rust shell validates every incoming Tauri IPC envelope (jsonschema crate or serde-derived deserialization, which gives 99% of the same protection).

**A wire boundary without schema validation is a bug.**

### 27.2 Preview backend: reliability-first cross-platform strategy

The goal stated by the user: **stable and functional on any hardware.** The trade-off is between rendering fidelity (embedded webview matches the visual brief) and reliability (system browser renders every modern page correctly). Reliability wins where they conflict.

**Per-platform default backend:**

| Platform | Default | Reason |
|--|--|--|
| macOS | Embedded (WKWebView) | WKWebView is Safari's engine; renders modern dev-server output reliably. |
| Windows | Embedded (WebView2) | WebView2 is Chromium-backed; renders everything. |
| Linux | **External system browser** (xdg-open via `ui.openExternal`) | WebKitGTK has gaps with modern web features (WebGPU, certain CSS, newer JS). User's actual browser is guaranteed-compatible. |

**Mode switching is per-project, per-target, with sensible auto-detection:**

1. **Default behavior:** the panel uses the platform default backend.
2. **User override:** per-project setting `preview.backend` accepts `embedded` / `external` / `auto`. Default is `auto`.
3. **Auto-fallback:** in `auto` mode, when the embedded webview fails to render (detected via the webview's `failedLoad` event, or via a content-shape heuristic — page has a `<canvas>` element with WebGL2/WebGPU context and the platform is Linux), the panel auto-switches to external for that target and shows a one-line banner: "this target is rendering in your system browser; the panel shows controls."
4. **Manual override:** the panel header has an `external ↗` toggle that hands the URL to `ui.openExternal` and switches the panel to its control-surface mode for that target.

**Control surface (when external mode is active):**

- URL display with copy button.
- Status: `running` / `stopped` / `errored`.
- Process actions: `restart`, `stop`, `refresh signal` (sends SIGUSR1 or HUP if the agent declared a refresh signal).
- Last 20 lines of the process's stdout/stderr (live-tailed, scrollback).
- Big `open preview ↗` button that calls `ui.openExternal(url)`.

**External mode is not a regression.** It's a usability win for most workflows: users can put the live preview on a second monitor (or full-screen on their primary) while the IDE panel becomes a control surface. The mockup's `preview` panel already implies this dual nature — for `cli`, `desktop`, `mobile`, and `test` target kinds, the panel is *already* a control surface, not an embedded render.

**No bundled Chromium.** We deliberately do not ship CEF or a Chromium fork. Reasons: binary size cost (~150MB), maintenance burden (security patching), and the system-browser fallback makes it unnecessary. If a user needs guaranteed embedded rendering on Linux, they can run a Chromium-based Tauri build via the experimental `verso` engine when it's production-ready — but that's a future capability, not an MVP commitment.

**Tauri capability allowlist additions** for `tauri.conf.json`:

```json
"app": {
  "security": {
    "csp": "...",
    "freezePrototype": true
  }
},
"plugins": {
  "shell": {
    "open": "^https?://.+"   // allow opening http(s) URLs; nothing else
  }
}
```

`ui.openExternal` calls into the Tauri shell plugin with a strict URL allowlist. Plugin requests to `openExternal` go through the standard permission gate (`ui.openExternal` permission, declared in manifest).

---

This closes every open architectural item in the document.
