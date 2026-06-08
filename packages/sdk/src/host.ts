import type {
  ChatMessage,
  Diagnostic,
  HistoryEvent,
  PanelManifest,
  PluginRef,
  PreviewTarget,
  Task,
  TextEdit,
  VerifyRun,
} from './types.gen';

export type RpcErrorCode =
  | 'permission_not_declared'
  | 'permission_not_granted'
  | 'method_not_found'
  | 'invalid_params'
  | 'not_found'
  | 'conflict'
  | 'unsupported_capability'
  | 'internal'
  | 'timeout';

export type RpcError = {
  code: RpcErrorCode;
  message: string;
  data?: unknown;
};

export type RpcRequest = {
  kind: 'request';
  id: number;
  method: string;
  params: unknown;
};

export type RpcResponse =
  | { kind: 'response'; id: number; ok: true; result: unknown }
  | { kind: 'response'; id: number; ok: false; error: RpcError };

export type RpcEvent = {
  kind: 'event';
  topic: string;
  payload: unknown;
};

export type RpcEnvelope = RpcRequest | RpcResponse | RpcEvent;

export type NotifyLevel = 'info' | 'success' | 'warning' | 'warn' | 'error';

export type EditorDecoration = {
  line: number;
  col?: number;
  length?: number;
  className?: string;
  message?: string;
  severity?: 'error' | 'warning' | 'info' | 'hint';
};

export type StatusBarItem = {
  id: string;
  pluginId: string;
  text: string;
  tooltip?: string;
};

export type QuickPickItem = {
  label: string;
  description?: string;
  value?: string;
};

export type Unsubscribe = () => void;

export type KnowledgeBaseScope = 'global' | 'project';

export type KnowledgeBase = {
  id: string;
  name: string;
  root: string;
  scope: KnowledgeBaseScope;
  suggestedScope: KnowledgeBaseScope;
};

export type KnowledgeBasePreset = 'blank' | 'basic';

export interface PolyporeHost {
  registerManifest(manifest: PanelManifest): Promise<{ registered: boolean; panelId: string }>;
  ui: {
    notify(level: NotifyLevel, msg: string): Promise<{ shown: boolean }>;
    confirm(msg: string): Promise<{ confirmed: boolean }>;
    openExternal(url: string): Promise<{ opened: boolean }>;
    inputBox(opts?: { prompt?: string; placeholder?: string; value?: string }): Promise<{ value: string | null }>;
    quickPick(items: Array<string | QuickPickItem>): Promise<{ selected: string | null }>;
    statusBar: {
      add(text: string, tooltip?: string): Promise<{ id: string }>;
      update(id: string, opts?: { text?: string; tooltip?: string }): Promise<{ updated: boolean }>;
      remove(id: string): Promise<{ removed: boolean }>;
      onChange(fn: (event: { items: StatusBarItem[] }) => void): Unsubscribe;
    };
    panel: {
      setTitle(instanceId: string, title: string): Promise<{ ok: boolean }>;
      setBadge(instanceId: string, count: number | null): Promise<{ ok: boolean }>;
      focus(instanceId: string): Promise<{ ok: boolean }>;
    };
  };
  state: {
    get(key: string): Promise<{ key: string; value: unknown }>;
    subscribe(key: string, fn: (value: unknown) => void): Unsubscribe;
  };
  tasks: {
    list(): Promise<{ tasks: Task[] }>;
    add(task: { label: string; panelHint?: string; done?: boolean; parentId?: string; createdBy?: 'user' | 'agent' }): Promise<{ task: Task }>;
    update(id: string, patch: Partial<Task>): Promise<{ task: Task }>;
    onChange(fn: (event: { tasks: Task[] }) => void): Unsubscribe;
  };
  diagnostics: {
    list(filter?: { severity?: string; file?: string; source?: string }): Promise<{ diagnostics: Diagnostic[] }>;
    document(path: string, content: string): Promise<{ diagnostics: Diagnostic[] }>;
    deepScan(): Promise<{ diagnostics: Diagnostic[] }>;
    onChange(fn: (event: { diagnostics: Diagnostic[] }) => void): Unsubscribe;
  };
  verify: {
    runs(): Promise<{ runs: VerifyRun[] }>;
    run(id: string): Promise<{ run: VerifyRun }>;
    onChange(fn: (event: { runs: VerifyRun[] }) => void): Unsubscribe;
  };
  iterate: {
    run(params: {
      taskId: string;
      prompt: string;
      maxCycles?: number;
      verifyCommands: Array<{ id: string; label: string; command: string; required: boolean }>;
    }): Promise<{
      result: {
        taskId: string;
        status: string;
        cycle: number;
        maxCycles: number;
        runs: Array<{ id: string; label: string; command: string; required: boolean; exitCode: number | null; output: string }>;
      };
    }>;
  };
  knowledge: {
    bases(): Promise<{ bases: KnowledgeBase[] }>;
    openFolder(): Promise<{ base: KnowledgeBase | null }>;
    createBase(input: {
      name: string;
      scope: KnowledgeBaseScope;
      preset: KnowledgeBasePreset;
      root?: string;
      /* override the preset's default folder list — each entry becomes
         "<folder>/index.md" seeded with a heading. empty list = no folders. */
      folders?: string[];
    }): Promise<{ base: KnowledgeBase }>;
    suggestBaseLocation(input: { name: string; scope: KnowledgeBaseScope }): Promise<{ location: string }>;
    pickBaseLocation(): Promise<{ location: string | null; scope?: KnowledgeBaseScope }>;
    setBaseScope(id: string, scope: KnowledgeBaseScope): Promise<{ base: KnowledgeBase }>;
    renameBase(id: string, name: string): Promise<{ base: KnowledgeBase }>;
    deleteBase(id: string): Promise<{ deleted: boolean }>;
    createFolder(path: string, baseId?: string): Promise<{ created: boolean }>;
    renameFolder(from: string, to: string, baseId?: string): Promise<{ renamed: boolean }>;
    deleteFolder(path: string, baseId?: string): Promise<{ deleted: boolean }>;
    deleteDoc(path: string, baseId?: string): Promise<{ deleted: boolean }>;
    list(baseId?: string): Promise<{ nodes: Array<{ kind: 'doc' | 'folder'; path: string }> }>;
    read(path: string, baseId?: string): Promise<{ path: string; content: string }>;
    write(path: string, content: string, baseId?: string): Promise<{ written: boolean; path: string }>;
    recordAdr(input: { title: string; body?: string; baseId?: string }): Promise<{ recorded: boolean; path: string }>;
    onChange(fn: (event: { path: string }) => void): Unsubscribe;
  };
  editor: {
    tree(): Promise<{ tree: FileTreeNode[] }>;
    open(path: string, opts?: { line?: number; col?: number }): Promise<{ opened: boolean; path: string }>;
    onOpen(fn: (event: { path: string }) => void): Unsubscribe;
    read(path: string): Promise<{ path: string; content: string }>;
    applyEdit(path: string, edits: TextEdit[]): Promise<{ applied: number }>;
    onChange(path: string, fn: (event: { path: string; kind: string }) => void): Unsubscribe;
    setDecorations(path: string, decorations: EditorDecoration[]): Promise<{ applied: number; path: string }>;
    cursor(path: string): Promise<{ path: string; cursor: { line: number; column: number } | null }>;
    selection(path: string): Promise<{ path: string; selection: { start: { line: number; column: number }; end: { line: number; column: number } } | null }>;
    revealLine(path: string, line: number): Promise<{ ok: boolean }>;
    language(path: string): Promise<{ path: string; language: string }>;
    onDidChangeCursor(fn: (event: { path: string; line: number; column: number }) => void): Unsubscribe;
    onDidChangeSelection(fn: (event: { path: string; start: { line: number; column: number }; end: { line: number; column: number } }) => void): Unsubscribe;
    onDidSave(path: string, fn: (event: { path: string }) => void): Unsubscribe;
  };
  chat: {
    sessions(): Promise<{ sessions: Array<{ id: string; agent: string; title: string; createdAt: number; worktreeId?: string }> }>;
    history(sessionId: string): Promise<{ sessionId: string; messages: ChatMessage[] }>;
    send(sessionId: string, text: string, opts?: { worktreeId?: string }): Promise<{ message: ChatMessage }>;
    stream(sessionId: string, text: string, opts?: { worktreeId?: string; onChunk?: (msg: ChatMessage) => void }): Promise<{ message: ChatMessage; unsubscribe: () => void }>;
    interrupt(sessionId: string): Promise<{ interrupted: boolean; sessionId: string }>;
    context: {
      list(sessionId: string): Promise<{ sessionId: string; paths: string[] }>;
      add(sessionId: string, path: string): Promise<{ added: boolean; sessionId: string; path: string }>;
      remove(sessionId: string, path: string): Promise<{ removed: boolean; sessionId: string; path: string }>;
    };
    onMessage(fn: (event: { sessionId: string; message: ChatMessage; adapter?: string }) => void): Unsubscribe;
    onTool(sessionId: string, fn: (event: unknown) => void): Unsubscribe;
  };
  history: {
    events(filter?: { limit?: number; worktreeId?: string }): Promise<{ events: HistoryEvent[] }>;
    diff(request: HistoryDiffRequest): Promise<{ diff: GitDiffResult }>;
    fork(eventId: string): Promise<{ worktree: WorktreeRef }>;
    revert(params: {
      eventId?: string;
      files?: string[];
      snapshotCommit?: string;
      worktreePath?: string;
    }): Promise<{ reverted: RevertResult }>;
    onEvent(fn: (event: HistoryEvent) => void): Unsubscribe;
  };
  worktrees: {
    list(): Promise<{ worktrees: WorktreeListEntry[] }>;
    create(params?: { branch?: string; path?: string; fromRef?: string }): Promise<{ worktree: WorktreeRef }>;
  };
  snapshots: {
    take(params: { worktreeId?: string; worktreePath?: string; kind?: string }): Promise<{
      snapshot: SnapshotRecord;
    }>;
    signalTurnEnd(params: { worktreeId?: string }): Promise<{ ok: boolean }>;
  };
  preview: {
    list(): Promise<{ targets: PreviewTarget[] }>;
    register(target: Partial<PreviewTarget> & { command: string; target: string; kind?: PreviewTarget['kind'] }): Promise<{ target: PreviewTarget }>;
    refresh(id?: string): Promise<{ refreshed: boolean; id?: string }>;
  };
  terminal: {
    spawn(command?: string, size?: { cols: number; rows: number }): Promise<{ session: { id: string; command: string; status: string; output: string; pid?: number | null; exitCode?: number | null } }>;
    stop(id: string): Promise<{ stopped: boolean; id: string }>;
    write(id: string, data: string): Promise<{ written: boolean; id: string }>;
    resize(id: string, cols: number, rows: number): Promise<{ resized: boolean; id: string }>;
    list(): Promise<{ sessions: Array<{ id: string; command: string; status: string; output: string; pid?: number | null; exitCode?: number | null }> }>;
    read(id: string): Promise<{ id: string; output: string }>;
    onEvent(fn: (event: { id: string; command: string; kind: string; data?: string | null; exitCode?: number | null }) => void): Unsubscribe;
    onOutput(id: string, fn: (chunk: string) => void): Unsubscribe;
    onExit(id: string, fn: (event: { exitCode: number | null }) => void): Unsubscribe;
  };
  panels: {
    open(id: string, opts?: { area?: 'center' | 'left' | 'right' | 'bottom' }): Promise<{ instanceId: string; area?: string }>;
    close(instanceId: string): Promise<{ closed: boolean }>;
    list(): Promise<{ manifests: PanelManifest[] }>;
  };
  fs: {
    write(path: string, content: string): Promise<{ written: boolean; path: string }>;
    delete(path: string): Promise<{ deleted: boolean; path: string }>;
    rename(from: string, to: string): Promise<{ renamed: boolean; from: string; to: string }>;
    mkdir(path: string): Promise<{ created: boolean; path: string }>;
    exists(path: string): Promise<{ exists: boolean }>;
    stat(path: string): Promise<{ size: number; mtime: number; isDirectory: boolean }>;
    watch(glob: string, fn: (event: { kind: string; path: string }) => void): Unsubscribe;
  };
  storage: {
    get(key: string): Promise<{ value: unknown }>;
    set(key: string, value: unknown): Promise<{ written: boolean }>;
    delete(key: string): Promise<{ deleted: boolean }>;
    list(): Promise<{ keys: string[] }>;
  };
  git: {
    status(): Promise<{ entries: Array<{ path: string; status: string }>; branch: string }>;
    log(opts?: { limit?: number; file?: string }): Promise<{ events: unknown[] }>;
    blame(path: string): Promise<{ entries: unknown[] }>;
    branches(): Promise<{ current: string; all: string[] }>;
    stash(): Promise<{ stashed: boolean }>;
    unstash(): Promise<{ unstashed: boolean }>;
    onBranchChange(fn: (event: { branch: string }) => void): Unsubscribe;
  };
  http: {
    fetch(opts: { url: string; method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  };
  clipboard: {
    read(): Promise<{ text: string }>;
    write(text: string): Promise<{ written: boolean }>;
  };
  bus: {
    on(topic: string, fn: (payload: unknown) => void): Unsubscribe;
    publish(topic: string, payload: unknown): Promise<{ published: boolean; topic: string }>;
  };
  plugins: {
    list(): Promise<{ plugins: PluginRef[] }>;
    install(plugin: Partial<PluginRef> & { id: string }): Promise<{ installed: boolean; plugin: PluginRef }>;
    uninstall(id: string): Promise<{ uninstalled: boolean; id: string }>;
    enable(id: string): Promise<{ enabled: boolean; id: string }>;
    disable(id: string): Promise<{ disabled: boolean; id: string }>;
    toggle(id: string): Promise<{ enabled: boolean; id: string }>;
  };
  skills: {
    list(): Promise<{ skills: SkillRecord[] }>;
    read(id: string): Promise<{ skill: SkillRecord }>;
    write(skill: Partial<SkillRecord>): Promise<{ skill: SkillRecord; written: boolean }>;
    delete(id: string): Promise<{ deleted: boolean; id: string }>;
    invoke(id: string, args?: Record<string, unknown>): Promise<{ invoked: boolean }>;
    publish(id: string, agents: Array<'claude' | 'codex'>): Promise<{ skill: SkillRecord }>;
  };
  secrets: {
    list(scope?: 'user' | 'project'): Promise<{ secrets: MaskedSecret[] }>;
    has(id: string, scope?: 'user' | 'project'): Promise<{ id: string; scope?: 'user' | 'project'; has: boolean }>;
    use(req: SecretInvoke): Promise<SecretInvokeResult>;
    /* reveal a secret's raw value. host-side confirmDecider gates this
       before the value leaves the host. UI should bound lifetime with an
       auto-hide timer. never log or persist the returned value. */
    reveal(id: string, scope?: 'user' | 'project'): Promise<{ value: string | null; configured: boolean }>;
    /* set a secret. routes to the Tauri keyring when available, falls back
       to the in-process store otherwise. */
    set(input: { id: string; value: string; scope?: 'user' | 'project'; service?: string }): Promise<{ secret: { id: string; scope: 'user' | 'project'; service: string; hint: string; configured: boolean; updatedAt: number } }>;
    /* delete a secret handle. routes to the Tauri keyring when available,
       falls back to the in-process store otherwise. */
    delete(id: string, scope?: 'user' | 'project'): Promise<{ removed: boolean }>;
  };
  mcp: {
    invoke(req: McpInvoke): Promise<{ ok: boolean; body?: unknown; status?: number; error?: string }>;
    servers: {
      list(scope?: McpServerScope): Promise<{ servers: McpServerRecord[] }>;
      upsert(server: Partial<McpServerRecord> & { name: string; url: string }): Promise<{ server: McpServerRecord }>;
      delete(id: string): Promise<{ deleted: boolean; id: string }>;
      test(id: string): Promise<{ ok: boolean; status?: number; error?: string }>;
    };
    /* discover MCPs declared in claude/codex configs (~/.claude.json,
       ~/.codex/config.toml). read-only — the renderer renders these as
       a separate row class with no edit/delete. */
    discover(): Promise<{ servers: Array<{ name: string; origins: Array<'claude' | 'codex'>; transport: 'http' | 'sse' | 'stdio'; url?: string; command?: string; args?: string[]; env?: Record<string, string> }> }>;
    /* install — write an MCP entry into agent config files. */
    install(spec: { name: string; transport: 'stdio' | 'http' | 'sse'; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; agents: Array<'claude-project' | 'claude-user' | 'codex'> }): Promise<{ installed: boolean; targets: string[] }>;
  };
  skillsets: {
    list(): Promise<{ skillsets: SkillsetRecord[] }>;
    read(id: string): Promise<{ skillset: SkillsetRecord; skills: SkillRecord[] }>;
    upsert(skillset: Partial<SkillsetRecord> & { title: string }): Promise<{ skillset: SkillsetRecord }>;
    delete(id: string): Promise<{ deleted: boolean; id: string }>;
  };
  formation: {
    upsert(spec: { nodes: FormationNodeSpec[]; edges: FormationEdgeSpec[] }): Promise<{ upserted: boolean; nodes: number; edges: number }>;
  };
  debug: {
    probe(params: {
      adapter?: string;
      config?: Record<string, unknown>;
    }): Promise<DebugAdapterProbe>;
    start(params: {
      scenario: DebugScenario;
      adapter?: string;
      config?: Record<string, unknown>;
      trust?: DebugTrust;
    }): Promise<{ session: DebugSessionInfo; blocked?: boolean; ask?: string }>;
    setBreakpoints(params: {
      file: string;
      breakpoints: DebugBreakpointSpec[];
      setBy?: 'agent' | 'human';
    }): Promise<{ breakpoints: DebugBreakpointRecord[] }>;
    /* arm/clear a single breakpoint — works with no active session (the human
       can set breakpoints for the AI before debugging starts). */
    addBreakpoint(params: { file: string; line: number; condition?: string; setBy?: 'agent' | 'human' }): Promise<{ breakpoints: DebugBreakpointRecord[] }>;
    removeBreakpoint(params: { file: string; line: number }): Promise<{ breakpoints: DebugBreakpointRecord[] }>;
    continue(params?: { threadId?: number }): Promise<DebugStopResult>;
    stepOver(params?: { threadId?: number }): Promise<DebugStopResult>;
    stepIn(params?: { threadId?: number }): Promise<DebugStopResult>;
    stepOut(params?: { threadId?: number }): Promise<DebugStopResult>;
    pause(params?: { threadId?: number }): Promise<DebugStopResult>;
    stackTrace(params?: { threadId?: number }): Promise<{ frames: DapFrame[]; total: number }>;
    scopes(params: { frameId: number }): Promise<{ scopes: DapScope[] }>;
    variables(params: { variablesReference: number }): Promise<{ variables: SummarizedVariable[]; total: number; truncated: boolean }>;
    evaluate(params: { expression: string; frameId?: number }): Promise<{ result: string; type?: string; ref?: number; more?: boolean }>;
    setTrust(trust: DebugTrust): Promise<{ trust: DebugTrust }>;
    capture: {
      screenshot(params?: { target?: string }): Promise<{ screenshot: { mimeType: string; dataBase64: string } }>;
      console(params?: { limit?: number }): Promise<{ entries: Array<{ level: string; text: string; ts?: number }> }>;
      dom(params?: { selector?: string }): Promise<{ dom: unknown }>;
      network(): Promise<{ network: unknown }>;
    };
    /* web auto-nav (phase 1.5, optional) — driving methods degrade to a
       roadblock when capabilities.webAutoNav is false. */
    capabilities(): Promise<DebugCapabilities>;
    navigate(url: string): Promise<{ url?: string; ok?: boolean; blocked?: boolean; ask?: string }>;
    click(selector: string): Promise<{ ok?: boolean; blocked?: boolean; ask?: string }>;
    fill(selector: string, text: string): Promise<{ ok?: boolean; blocked?: boolean; ask?: string }>;
    login(params: {
      url?: string;
      usernameSelector: string;
      passwordSelector: string;
      usernameSecret: string;
      passwordSecret: string;
      submitSelector?: string;
      scope?: 'user' | 'project';
    }): Promise<{ ok?: boolean; blocked?: boolean; ask?: string }>;
    roadblock(ask: string): Promise<{ blocked: boolean; ask?: string }>;
    resolveRoadblock(): Promise<{ resolved: boolean }>;
    rootCause(params: { summary: string; file?: string; line?: number }): Promise<{ rootCause: DebugRootCause }>;
    sessions(): Promise<{ sessions: DebugSessionInfo[]; activeId: string | null }>;
    select(id: string): Promise<{ session: DebugSessionInfo }>;
    state(): Promise<DebugState>;
    stop(): Promise<{ stopped: boolean }>;
    onChange(fn: (state: DebugState) => void): Unsubscribe;
  };
  workspace: {
    activePanel(): Promise<{ panelId: string | null; instanceId: string | null }>;
    openPanel(panelId: string, opts?: { area?: 'center' | 'left' | 'right' | 'bottom' }): Promise<{ instanceId: string; area?: 'center' | 'left' | 'right' | 'bottom' }>;
    closePanel(instanceId: string): Promise<{ closed: boolean }>;
  };
  subscription: {
    release(topic: string): Promise<{ unsubscribed: boolean; topic: string }>;
  };
  raw(request: Omit<RpcRequest, 'kind' | 'id'>): Promise<RpcResponse>;
}

export type SecretInvoke = {
  id: string;
  scope?: 'user' | 'project';
  request: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
    allowInsecure?: boolean;
  };
};

export type SecretInvokeResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type McpInvoke = {
  server: string;
  method: string;
  args?: Record<string, unknown>;
  authRef?: string;
};

export type MaskedSecret = {
  id: string;
  scope: 'user' | 'project';
  service: string;
  hint: string;
  configured: boolean;
};

export type FileTreeNode =
  | { kind: 'file'; name: string; path: string; subtitle?: string }
  | { kind: 'folder'; name: string; children: FileTreeNode[] };

export type SkillRecord = {
  id: string;
  name: string;
  summary: string;
  body?: string;
  skillsetId?: string;
  origin?: 'polypore' | 'builtin' | 'claude' | 'codex';
  publishedTo?: Array<'claude' | 'codex'>;
};
export type SkillsetRecord = {
  id: string;
  title: string;
  version: string;
  builtin?: boolean;
  source?: string;
  summary?: string;
  skills: string[];
};
export type McpServerScope = 'project' | 'user' | 'polypore';
export type McpServerRecord = {
  id: string;
  name: string;
  url: string;
  scope: McpServerScope;
  headers?: Record<string, string>;
  authRef?: string;
  allowInsecure?: boolean;
  timeoutMs?: number;
  lastTest?: { ok: boolean; ts: number; status?: number; error?: string };
};
export type FormationNodeSpec = {
  id?: string;
  role: string;
  detail?: string;
  prompt?: string;
  model?: string;
  skills?: string[];
  tools?: string[];
  status?: 'idle' | 'waiting' | 'running' | 'missing';
  root?: boolean;
  x?: number;
  y?: number;
};
export type FormationEdgeSpec = { from: string; to: string };

export type GitDiffResult = {
  mode: string;
  file: string | null;
  baseRef?: string | null;
  targetRef?: string | null;
  changedFiles: string[];
  diff: string;
  exitCode?: number | null;
};
export type WorktreeRef = { id: string; path: string; branch: string; forkedFromEventId: string };
export type RevertResult = { files: string[]; output: string; exitCode?: number | null };
export type WorktreeListEntry = {
  id: string;
  path: string;
  branch: string | null;
  head: string | null;
  isCurrent: boolean;
  isLocked: boolean;
  isDetached: boolean;
};
export type SnapshotRecord = {
  worktreeId: string;
  commitHash: string;
  parentCommit: string | null;
  ts: number;
  kind: string;
  refName: string;
};
export type HistoryDiffRequest = {
  mode: 'working' | 'branch' | 'snapshot';
  file?: string;
  snapshotCommit?: string;
  worktreePath?: string;
};

/* ─── debug suite (mirrors packages/host/src/rpc-server.ts shapes) ──────── */
export type DebugTrust = 'observe' | 'evaluate' | 'off';
export type DebugStatus = 'idle' | 'starting' | 'inspecting' | 'paused' | 'blocked' | 'root-caused' | 'failed';
export type DebugScenario = { title: string; whatsWrong?: string };
export type DebugStop = {
  reason: string;
  threadId?: number;
  frameId?: number;
  file?: string;
  line?: number;
  initiatedBy?: 'agent' | 'human';
};
export type DebugStopResult = { stop?: DebugStop | null; terminated?: boolean; blocked?: boolean; ask?: string };
export type DebugBreakpointSpec = { line: number; condition?: string; hitCondition?: string; logMessage?: string };
export type DebugBreakpointRecord = DebugBreakpointSpec & { file: string; setBy: 'agent' | 'human'; verified?: boolean };
export type DebugCardKind =
  | 'start' | 'setBreakpoints' | 'continue' | 'stepOver' | 'stepIn' | 'stepOut' | 'pause'
  | 'stackTrace' | 'scopes' | 'variables' | 'evaluate' | 'screenshot' | 'console' | 'dom'
  | 'network' | 'navigate' | 'click' | 'fill' | 'login' | 'roadblock' | 'rootCause';
export type DebugCapabilities = { webAutoNav: boolean };
export type DebugAdapterProbe = { adapter: string; command: string; available: boolean; detail: string };
export type DebugCard = {
  id: string;
  ts: number;
  kind: DebugCardKind;
  title: string;
  status: 'running' | 'done' | 'failed';
  initiatedBy?: 'agent' | 'human';
  payload?: unknown;
  error?: string;
};
export type DebugSessionInfo = {
  id: string;
  dapSessionId?: string;
  adapter: string;
  scenario: DebugScenario;
  trust: DebugTrust;
  status: DebugStatus;
  createdAt: number;
};
export type DebugRootCause = { summary: string; file?: string; line?: number };
export type DebugState = {
  session: DebugSessionInfo | null;
  sessions: DebugSessionInfo[];
  timeline: DebugCard[];
  roadblock: { ask: string; askedAt: number } | null;
  status: DebugStatus;
  stop: DebugStop | null;
  breakpoints: DebugBreakpointRecord[];
  rootCause: DebugRootCause | null;
  capabilities: DebugCapabilities;
};
export type DapFrame = { id: number; name: string; file?: string; line?: number; column?: number };
export type DapScope = { name: string; variablesReference: number; expensive?: boolean };
export type SummarizedVariable = {
  name: string;
  value: string;
  type?: string;
  valueTruncated?: boolean;
  ref?: number;
  more?: boolean;
};

export function createLoopbackHost(
  transport: (request: RpcRequest) => Promise<RpcResponse>,
  subscribe?: (topic: string, fn: (payload: unknown) => void) => Unsubscribe,
): PolyporeHost {
  let nextId = 1;

  async function raw(request: Omit<RpcRequest, 'kind' | 'id'>) {
    return transport({ kind: 'request', id: nextId++, ...request });
  }

  async function expectOk<T>(response: RpcResponse): Promise<T> {
    if (!response.ok) throw response.error;
    return response.result as T;
  }

  const call = <T>(method: string, params: unknown): Promise<T> =>
    raw({ method, params }).then((response) => expectOk<T>(response));

  return {
    raw,
    registerManifest: (manifest) => call<{ registered: boolean; panelId: string }>('manifest.register', { manifest }),
    ui: {
      notify: (level, msg) => call<{ shown: boolean }>('ui.notify', { level, msg }),
      confirm: (msg) => call<{ confirmed: boolean }>('ui.confirm', { msg }),
      openExternal: (url) => call<{ opened: boolean }>('ui.openExternal', { url }),
      inputBox: (opts) => call<{ value: string | null }>('ui.inputBox', opts ?? {}),
      quickPick: (items) => call<{ selected: string | null }>('ui.quickPick', { items }),
      statusBar: {
        add: (text, tooltip) => call<{ id: string }>('ui.statusBar.add', { text, tooltip }),
        update: (id, opts) => call<{ updated: boolean }>('ui.statusBar.update', { id, ...opts }),
        remove: (id) => call<{ removed: boolean }>('ui.statusBar.remove', { id }),
        onChange: (fn) => subscribe?.('ui:statusBar-changed', (payload) => fn(payload as { items: StatusBarItem[] })) ?? (() => {}),
      },
      panel: {
        setTitle: (instanceId, title) => call<{ ok: boolean }>('ui.panel.setTitle', { instanceId, title }),
        setBadge: (instanceId, count) => call<{ ok: boolean }>('ui.panel.setBadge', { instanceId, count }),
        focus: (instanceId) => call<{ ok: boolean }>('ui.panel.focus', { instanceId }),
      },
    },
    state: {
      get: (key) => call<{ key: string; value: unknown }>('state.get', { key }),
      subscribe: (key, fn) => subscribe?.(`state:${key}`, fn) ?? (() => {}),
    },
    tasks: {
      list: () => call<{ tasks: Task[] }>('tasks.list', {}),
      add: (task) => call<{ task: Task }>('tasks.add', task),
      update: (id, patch) => call<{ task: Task }>('tasks.update', { id, patch }),
      onChange: (fn) => subscribe?.('tasks:changed', (payload) => fn(payload as { tasks: Task[] })) ?? (() => {}),
    },
    diagnostics: {
      list: (filter) => call<{ diagnostics: Diagnostic[] }>('diagnostics.list', filter ?? {}),
      document: (path, content) => call<{ diagnostics: Diagnostic[] }>('diagnostics.document', { path, content }),
      deepScan: () => call<{ diagnostics: Diagnostic[] }>('diagnostics.deepScan', {}),
      onChange: (fn) => subscribe?.('diagnostics:changed', (payload) => fn(payload as { diagnostics: Diagnostic[] })) ?? (() => {}),
    },
    verify: {
      runs: () => call<{ runs: VerifyRun[] }>('verify.runs', {}),
      run: (id) => call<{ run: VerifyRun }>('verify.run', { id }),
      onChange: (fn) => subscribe?.('verify:changed', (payload) => fn(payload as { runs: VerifyRun[] })) ?? (() => {}),
    },
    iterate: {
      run: (params) => call<{
        result: {
          taskId: string;
          status: string;
          cycle: number;
          maxCycles: number;
          runs: Array<{ id: string; label: string; command: string; required: boolean; exitCode: number | null; output: string }>;
        };
      }>('iterate.run', params),
    },
    knowledge: {
      bases: () => call<{ bases: KnowledgeBase[] }>('knowledge.bases', {}),
      openFolder: () => call<{ base: KnowledgeBase | null }>('knowledge.openFolder', {}),
      createBase: (input) => call<{ base: KnowledgeBase }>('knowledge.createBase', input),
      suggestBaseLocation: (input) => call<{ location: string }>('knowledge.suggestBaseLocation', input),
      pickBaseLocation: () => call<{ location: string | null; scope?: KnowledgeBaseScope }>('knowledge.pickBaseLocation', {}),
      setBaseScope: (id, scope) => call<{ base: KnowledgeBase }>('knowledge.setBaseScope', { id, scope }),
      renameBase: (id, name) => call<{ base: KnowledgeBase }>('knowledge.renameBase', { id, name }),
      deleteBase: (id) => call<{ deleted: boolean }>('knowledge.deleteBase', { id }),
      createFolder: (path, baseId) => call<{ created: boolean }>('knowledge.createFolder', { path, baseId }),
      renameFolder: (from, to, baseId) => call<{ renamed: boolean }>('knowledge.renameFolder', { from, to, baseId }),
      deleteFolder: (path, baseId) => call<{ deleted: boolean }>('knowledge.deleteFolder', { path, baseId }),
      deleteDoc: (path, baseId) => call<{ deleted: boolean }>('knowledge.deleteDoc', { path, baseId }),
      list: (baseId) => call<{ nodes: Array<{ kind: 'doc' | 'folder'; path: string }> }>('knowledge.list', { baseId }),
      read: (path, baseId) => call<{ path: string; content: string }>('knowledge.read', { path, baseId }),
      write: (path, content, baseId) => call<{ written: boolean; path: string }>('knowledge.write', { path, content, baseId }),
      recordAdr: (input) => call<{ recorded: boolean; path: string }>('adr.record', input),
      onChange: (fn) => subscribe?.('knowledge:changed', (payload) => fn(payload as { path: string })) ?? (() => {}),
    },
    editor: {
      tree: () => call<{ tree: FileTreeNode[] }>('editor.tree', {}),
      open: (path, opts) => call<{ opened: boolean; path: string }>('editor.open', { path, opts }),
      onOpen: (fn) => subscribe?.('editor:opened', (payload) => fn(payload as { path: string })) ?? (() => {}),
      read: (path) => call<{ path: string; content: string }>('editor.read', { path }),
      applyEdit: (path, edits) => call<{ applied: number }>('editor.applyEdit', { path, edits }),
      onChange: (path, fn) => subscribe?.(`editor:${path}`, (payload) => fn(payload as { path: string; kind: string })) ?? (() => {}),
      setDecorations: (path, decorations) => call<{ applied: number; path: string }>('editor.setDecorations', { path, decorations }),
      cursor: (path) => call<{ path: string; cursor: { line: number; column: number } | null }>('editor.cursor', { path }),
      selection: (path) => call<{ path: string; selection: { start: { line: number; column: number }; end: { line: number; column: number } } | null }>('editor.selection', { path }),
      revealLine: (path, line) => call<{ ok: boolean }>('editor.revealLine', { path, line }),
      language: (path) => call<{ path: string; language: string }>('editor.language', { path }),
      onDidChangeCursor: (fn) => subscribe?.('state:editorCursor', (payload) => fn(payload as { path: string; line: number; column: number })) ?? (() => {}),
      onDidChangeSelection: (fn) => subscribe?.('state:editorSelection', (payload) => fn(payload as { path: string; start: { line: number; column: number }; end: { line: number; column: number } })) ?? (() => {}),
      onDidSave: (path, fn) => subscribe?.(`editor:saved:${path}`, (payload) => fn(payload as { path: string })) ?? (() => {}),
    },
    chat: {
      sessions: () => call<{ sessions: Array<{ id: string; agent: string; title: string; createdAt: number }> }>('chat.sessions', {}),
      history: (sessionId) => call<{ sessionId: string; messages: ChatMessage[] }>('chat.history', { sessionId }),
      send: (sessionId, text, opts) => call<{ message: ChatMessage }>('chat.send', { sessionId, text, worktreeId: opts?.worktreeId }),
      stream: (sessionId, text, opts) => {
        const onChunk = opts?.onChunk;
        const unsub = onChunk
          ? (subscribe?.('chat:message', (payload) => {
              const p = payload as { sessionId: string; message: ChatMessage };
              if (p.sessionId === sessionId && p.message?.by === 'agent') onChunk(p.message);
            }) ?? (() => {}))
          : (() => {});
        return call<{ message: ChatMessage }>('chat.send', { sessionId, text, worktreeId: opts?.worktreeId })
          .then((result) => ({ ...result, unsubscribe: unsub }))
          .catch((err) => { unsub(); throw err; }) as Promise<{ message: ChatMessage; unsubscribe: () => void }>;
      },
      interrupt: (sessionId) => call<{ interrupted: boolean; sessionId: string }>('chat.interrupt', { sessionId }),
      context: {
        list: (sessionId) => call<{ sessionId: string; paths: string[] }>('chat.context.list', { sessionId }),
        add: (sessionId, path) => call<{ added: boolean; sessionId: string; path: string }>('chat.context.add', { sessionId, path }),
        remove: (sessionId, path) => call<{ removed: boolean; sessionId: string; path: string }>('chat.context.remove', { sessionId, path }),
      },
      onMessage: (fn) => subscribe?.('chat:message', (payload) => fn(payload as { sessionId: string; message: ChatMessage; adapter?: string })) ?? (() => {}),
      onTool: (sessionId, fn) => subscribe?.('agent:tool-call', (payload) => {
        const p = payload as { payload?: { sessionId?: string } };
        if (p?.payload?.sessionId === sessionId) fn(payload);
      }) ?? (() => {}),
    },
    history: {
      events: (filter) => call<{ events: HistoryEvent[] }>('history.events', filter ?? {}),
      diff: (request) => call<{ diff: GitDiffResult }>('history.diff', request),
      fork: (eventId) => call<{ worktree: WorktreeRef }>('history.fork', { eventId }),
      revert: (params) => call<{ reverted: RevertResult }>('history.revert', params),
      onEvent: (fn) => subscribe?.('history:event', (payload) => fn(payload as HistoryEvent)) ?? (() => {}),
    },
    worktrees: {
      list: () => call<{ worktrees: WorktreeListEntry[] }>('worktrees.list', {}),
      create: (params) => call<{ worktree: WorktreeRef }>('worktrees.create', params ?? {}),
    },
    snapshots: {
      take: (params) => call<{ snapshot: SnapshotRecord }>('snapshots.take', params),
      signalTurnEnd: (params) => call<{ ok: boolean }>('snapshots.signalTurnEnd', params),
    },
    preview: {
      list: () => call<{ targets: PreviewTarget[] }>('preview.list', {}),
      register: (target) => call<{ target: PreviewTarget }>('preview.register', target),
      refresh: (id) => call<{ refreshed: boolean; id?: string }>('preview.refresh', { id }),
    },
    terminal: {
      spawn: (command, size) => call<{ session: { id: string; command: string; status: string; output: string; pid?: number | null; exitCode?: number | null } }>('terminal.spawn', {
        command,
        cols: size?.cols,
        rows: size?.rows,
      }),
      stop: (id) => call<{ stopped: boolean; id: string }>('terminal.stop', { id }),
      write: (id, data) => call<{ written: boolean; id: string }>('terminal.write', { id, data }),
      resize: (id, cols, rows) => call<{ resized: boolean; id: string }>('terminal.resize', { id, cols, rows }),
      list: () => call<{ sessions: Array<{ id: string; command: string; status: string; output: string; pid?: number | null; exitCode?: number | null }> }>('terminal.list', {}),
      read: (id) => call<{ id: string; output: string }>('terminal.read', { id }),
      onEvent: (fn) => subscribe?.('terminal:event', (payload) => fn(payload as { id: string; command: string; kind: string; data?: string | null; exitCode?: number | null })) ?? (() => {}),
      onOutput: (id, fn) => subscribe?.(`terminal:output:${id}`, (payload) => fn((payload as { chunk?: string })?.chunk ?? '')) ?? (() => {}),
      onExit: (id, fn) => subscribe?.(`terminal:exit:${id}`, (payload) => fn(payload as { exitCode: number | null })) ?? (() => {}),
    },
    panels: {
      open: (id, opts) => call<{ instanceId: string; area?: string }>('panel.open', { id, area: opts?.area }),
      close: (instanceId) => call<{ closed: boolean }>('panel.close', { instanceId }),
      list: () => call<{ manifests: PanelManifest[] }>('panel.list', {}),
    },
    fs: {
      write: (path, content) => call<{ written: boolean; path: string }>('fs.write', { path, content }),
      delete: (path) => call<{ deleted: boolean; path: string }>('fs.delete', { path }),
      rename: (from, to) => call<{ renamed: boolean; from: string; to: string }>('fs.rename', { from, to }),
      mkdir: (path) => call<{ created: boolean; path: string }>('fs.mkdir', { path }),
      exists: (path) => call<{ exists: boolean }>('fs.exists', { path }),
      stat: (path) => call<{ size: number; mtime: number; isDirectory: boolean }>('fs.stat', { path }),
      watch: (glob, fn) => subscribe?.('fs:event', (payload) => {
        const p = payload as { kind: string; path: string };
        if (!glob || glob === '*' || glob === '**' || p.path === glob
          || (glob.endsWith('*') && p.path.startsWith(glob.slice(0, -1)))
          || (glob.startsWith('*') && p.path.endsWith(glob.slice(1)))) {
          fn(p);
        }
      }) ?? (() => {}),
    },
    storage: {
      get: (key) => call<{ value: unknown }>('storage.get', { pluginId: '__host__', key }),
      set: (key, value) => call<{ written: boolean }>('storage.set', { pluginId: '__host__', key, value }),
      delete: (key) => call<{ deleted: boolean }>('storage.delete', { pluginId: '__host__', key }),
      list: () => call<{ keys: string[] }>('storage.list', { pluginId: '__host__' }),
    },
    git: {
      status: () => call<{ entries: Array<{ path: string; status: string }>; branch: string }>('git.status', {}),
      log: (opts) => call<{ events: unknown[] }>('git.log', opts ?? {}),
      blame: (path) => call<{ entries: unknown[] }>('git.blame', { path }),
      branches: () => call<{ current: string; all: string[] }>('git.branches', {}),
      stash: () => call<{ stashed: boolean }>('git.stash', {}),
      unstash: () => call<{ unstashed: boolean }>('git.unstash', {}),
      onBranchChange: (fn) => subscribe?.('state:branch', (payload) => fn(payload as { branch: string })) ?? (() => {}),
    },
    http: {
      fetch: (opts) => call<{ status: number; headers: Record<string, string>; body: string }>('http.fetch', opts),
    },
    clipboard: {
      read: () => call<{ text: string }>('clipboard.read', {}),
      write: (text) => call<{ written: boolean }>('clipboard.write', { text }),
    },
    bus: {
      on: (topic, fn) => subscribe?.(topic, fn) ?? (() => {}),
      publish: (topic, payload) => call<{ published: boolean; topic: string }>('bus.publish', { topic, payload }),
    },
    plugins: {
      list: () => call<{ plugins: PluginRef[] }>('plugins.list', {}),
      install: (plugin) => call<{ installed: boolean; plugin: PluginRef }>('plugins.install', { plugin }),
      uninstall: (id) => call<{ uninstalled: boolean; id: string }>('plugins.uninstall', { id }),
      enable: (id) => call<{ enabled: boolean; id: string }>('plugins.enable', { id }),
      disable: (id) => call<{ disabled: boolean; id: string }>('plugins.disable', { id }),
      toggle: (id) => call<{ enabled: boolean; id: string }>('plugins.toggle', { id }),
    },
    skills: {
      list: () => call<{ skills: SkillRecord[] }>('skills.list', {}),
      read: (id) => call<{ skill: SkillRecord }>('skills.read', { id }),
      write: (skill) => call<{ skill: SkillRecord; written: boolean }>('skills.write', skill),
      delete: (id) => call<{ deleted: boolean; id: string }>('skills.delete', { id }),
      invoke: (id, args) => call<{ invoked: boolean }>('skills.invoke', { id, args }),
      publish: (id, agents) => call<{ skill: SkillRecord }>('skills.publish', { id, agents }),
    },
    secrets: {
      list: (scope) => call<{ secrets: MaskedSecret[] }>('secrets.list', scope ? { scope } : {}),
      has: (id, scope) => call<{ id: string; scope?: 'user' | 'project'; has: boolean }>('secrets.has', scope ? { id, scope } : { id }),
      use: (req) => call<SecretInvokeResult>('secrets.use', req),
      reveal: (id, scope) => call<{ value: string | null; configured: boolean }>('secrets.reveal', scope ? { id, scope } : { id }),
      set: (input) => call<{ secret: { id: string; scope: 'user' | 'project'; service: string; hint: string; configured: boolean; updatedAt: number } }>('secrets.set', input),
      delete: (id, scope) => call<{ removed: boolean }>('secrets.delete', scope ? { id, scope } : { id }),
    },
    mcp: {
      invoke: (req) => call<{ ok: boolean; body?: unknown; status?: number; error?: string }>('mcp.invoke', req),
      servers: {
        list: (scope) => call<{ servers: McpServerRecord[] }>('mcp.servers.list', scope ? { scope } : {}),
        upsert: (server) => call<{ server: McpServerRecord }>('mcp.servers.upsert', server),
        delete: (id) => call<{ deleted: boolean; id: string }>('mcp.servers.delete', { id }),
        test: (id) => call<{ ok: boolean; status?: number; error?: string }>('mcp.servers.test', { id }),
      },
      discover: () => call<{ servers: Array<{ name: string; origins: Array<'claude' | 'codex'>; transport: 'http' | 'sse' | 'stdio'; url?: string; command?: string; args?: string[]; env?: Record<string, string> }> }>('mcp.discover', {}),
      install: (spec) => call<{ installed: boolean; targets: string[] }>('mcp.install', spec),
    },
    skillsets: {
      list: () => call<{ skillsets: SkillsetRecord[] }>('skillsets.list', {}),
      read: (id) => call<{ skillset: SkillsetRecord; skills: SkillRecord[] }>('skillsets.read', { id }),
      upsert: (skillset) => call<{ skillset: SkillsetRecord }>('skillsets.upsert', skillset),
      delete: (id) => call<{ deleted: boolean; id: string }>('skillsets.delete', { id }),
    },
    formation: {
      upsert: (spec) => call<{ upserted: boolean; nodes: number; edges: number }>('formation.upsert', spec),
    },
    debug: {
      probe: (params) => call<DebugAdapterProbe>('debug.probe', params),
      start: (params) => call<{ session: DebugSessionInfo; blocked?: boolean; ask?: string }>('debug.start', params),
      setBreakpoints: (params) => call<{ breakpoints: DebugBreakpointRecord[] }>('debug.setBreakpoints', params),
      addBreakpoint: (params) => call<{ breakpoints: DebugBreakpointRecord[] }>('debug.addBreakpoint', params),
      removeBreakpoint: (params) => call<{ breakpoints: DebugBreakpointRecord[] }>('debug.removeBreakpoint', params),
      continue: (params) => call<DebugStopResult>('debug.continue', params ?? {}),
      stepOver: (params) => call<DebugStopResult>('debug.stepOver', params ?? {}),
      stepIn: (params) => call<DebugStopResult>('debug.stepIn', params ?? {}),
      stepOut: (params) => call<DebugStopResult>('debug.stepOut', params ?? {}),
      pause: (params) => call<DebugStopResult>('debug.pause', params ?? {}),
      stackTrace: (params) => call<{ frames: DapFrame[]; total: number }>('debug.stackTrace', params ?? {}),
      scopes: (params) => call<{ scopes: DapScope[] }>('debug.scopes', params),
      variables: (params) => call<{ variables: SummarizedVariable[]; total: number; truncated: boolean }>('debug.variables', params),
      evaluate: (params) => call<{ result: string; type?: string; ref?: number; more?: boolean }>('debug.evaluate', params),
      setTrust: (trust) => call<{ trust: DebugTrust }>('debug.setTrust', { trust }),
      capture: {
        screenshot: (params) => call<{ screenshot: { mimeType: string; dataBase64: string } }>('debug.capture.screenshot', params ?? {}),
        console: (params) => call<{ entries: Array<{ level: string; text: string; ts?: number }> }>('debug.capture.console', params ?? {}),
        dom: (params) => call<{ dom: unknown }>('debug.capture.dom', params ?? {}),
        network: () => call<{ network: unknown }>('debug.capture.network', {}),
      },
      capabilities: () => call<DebugCapabilities>('debug.capabilities', {}),
      navigate: (url) => call<{ url?: string; ok?: boolean; blocked?: boolean; ask?: string }>('debug.navigate', { url }),
      click: (selector) => call<{ ok?: boolean; blocked?: boolean; ask?: string }>('debug.click', { selector }),
      fill: (selector, text) => call<{ ok?: boolean; blocked?: boolean; ask?: string }>('debug.fill', { selector, text }),
      login: (params) => call<{ ok?: boolean; blocked?: boolean; ask?: string }>('debug.login', params),
      roadblock: (ask) => call<{ blocked: boolean; ask?: string }>('debug.roadblock', { ask }),
      resolveRoadblock: () => call<{ resolved: boolean }>('debug.roadblock.resolve', {}),
      rootCause: (params) => call<{ rootCause: DebugRootCause }>('debug.rootCause', params),
      sessions: () => call<{ sessions: DebugSessionInfo[]; activeId: string | null }>('debug.sessions', {}),
      select: (id) => call<{ session: DebugSessionInfo }>('debug.select', { id }),
      state: () => call<DebugState>('debug.state', {}),
      stop: () => call<{ stopped: boolean }>('debug.stop', {}),
      onChange: (fn) => subscribe?.('state:debug', (payload) => fn(payload as DebugState)) ?? (() => {}),
    },
    workspace: {
      activePanel: () => call<{ panelId: string | null; instanceId: string | null }>('workspace.activePanel', {}),
      openPanel: (panelId, opts) => call<{ instanceId: string; area?: 'center' | 'left' | 'right' | 'bottom' }>('panel.open', { id: panelId, area: opts?.area }),
      closePanel: (instanceId) => call<{ closed: boolean }>('panel.close', { instanceId }),
    },
    subscription: {
      release: (topic) => call<{ unsubscribed: boolean; topic: string }>('host.unsubscribe', { topic }),
    },
  };
}
