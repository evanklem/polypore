import type {
  ChatMessage,
  Diagnostic,
  HistoryEvent,
  PanelManifest,
  PluginRef,
  PreviewTarget,
  Task,
  VerifyRun,
} from '../../sdk/src';
import type { RpcError, RpcRequest, RpcResponse } from '../../sdk/src/host';
import { validateRef, validateSchema } from '../../sdk/src/validators.gen';
import type { ValidationResult } from '../../sdk/src/validators.gen';
import type { SecretEntry, SecretStore } from './secret-store';
import type { HostInternals } from './handlers/internals';
import { registerKnowledgeHandlers } from './handlers/knowledge';
import { registerSecretsHandlers } from './handlers/secrets';
import { registerDebugHandlers } from './handlers/debug';
import { registerPluginsHandlers } from './handlers/plugins';
import { registerSkillsHandlers } from './handlers/skills';
import { registerMcpHandlers } from './handlers/mcp';

const PERF_KEY = 'polypore.perf';

function hostPerfEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const win = window as Window & { __POLYPORE_PERF__?: boolean };
  if (win.__POLYPORE_PERF__ === true) return true;
  if (win.__POLYPORE_PERF__ === false) return false;
  try {
    return window.sessionStorage?.getItem(PERF_KEY) === '1'
      || window.localStorage?.getItem(PERF_KEY) === '1';
  } catch {
    return false;
  }
}

/* inline perf helper. mirrors plugins/shared/perfPoint but the host
   package can't depend on plugins. */
function hostPerfPoint(label: string) {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
  if (!hostPerfEnabled()) return;
  try { performance.mark(`polypore:${label}`); } catch { /* ignore */ }
  if (typeof console !== 'undefined' && typeof performance.now === 'function') {
    /* eslint-disable-next-line no-console */
    console.debug(`[perf] ${performance.now().toFixed(1)}ms-abs  ${label}`);
  }
}

export type HostNotification = {
  id: string;
  level: 'info' | 'success' | 'warning' | 'warn' | 'error';
  msg: string;
};

export type RpcHandler = (params: unknown) => Promise<unknown> | unknown;
type EventListener = (payload: unknown) => void;
const RPC_ERROR_CODES = new Set<RpcError['code']>([
  'permission_not_declared',
  'permission_not_granted',
  'method_not_found',
  'invalid_params',
  'not_found',
  'conflict',
  'unsupported_capability',
  'internal',
  'timeout',
]);

function rpcErrorCode(err: unknown): RpcError['code'] {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && RPC_ERROR_CODES.has(code as RpcError['code'])
    ? code as RpcError['code']
    : 'internal';
}

function rpcErrorData(err: unknown): unknown {
  return err && typeof err === 'object' ? (err as { data?: unknown }).data : undefined;
}

function invalidParamsError(message: string) {
  return Object.assign(new Error(message), { code: 'invalid_params' as const });
}

export type ConfirmRequest = {
  kind: 'generic' | 'plugin-install' | 'plugin-uninstall' | 'secret-reveal' | 'secret-write' | 'secret-delete';
  message: string;
  details?: unknown;
};
export type ConfirmDecision = boolean | { confirmed: boolean; scope?: 'project' | 'user' };

export type StateKey =
  | 'activeAgent'
  | 'agentConnected'
  | 'project'
  | 'workspace'
  | 'activePanel'
  | 'agentPanels'
  | 'branch'
  | 'contextUsedPct'
  | 'context'
  | 'permissionMode'
  | 'loopCycle'
  | 'preview'
  | 'formation'
  | 'workflow'
  | 'phase'
  | 'tasks'
  | 'diagnostics'
  | 'verifyRuns'
  | 'debug'
  | 'editorCursor'
  | 'editorSelection';

export type HostState = Partial<Record<StateKey, unknown>>;

export type ChatSession = {
  id: string;
  agent: string;
  title: string;
  createdAt: number;
  worktreeId?: string;
};

/* opaque file-tree shape — matches FileNode from plugins/shared without
   forcing the host package to depend on the plugins/ tree. plugins pass in
   their initial tree; the host hands it back via editor.tree. */
export type FileTreeNode =
  | { kind: 'file'; name: string; path: string; subtitle?: string }
  | { kind: 'folder'; name: string; children: FileTreeNode[] };

export type SkillRecord = {
  id: string;
  name: string;
  summary: string;
  body?: string;
  /* skillset this skill belongs to. omit/undefined = loose (top-level). */
  skillsetId?: string;
  /* where this skill was discovered. polypore = native store, builtin = bundled (e.g. polyflow),
     claude/codex = mirrored from another agent's directory. */
  origin?: 'polypore' | 'builtin' | 'claude' | 'codex';
  /* agents this skill is published to via symlink. empty = polypore-only.
     ['claude', 'codex'] = global. only meaningful for polypore-origin skills;
     discovered claude/codex skills are scoped by where they were found. */
  publishedTo?: Array<'claude' | 'codex'>;
};

export type SkillsetRecord = {
  id: string;
  title: string;
  version: string;
  builtin?: boolean;
  source?: string;
  summary?: string;
  /* ordered list of skill ids contained in this skillset. */
  skills: string[];
};

export type McpServerRecord = {
  id: string;
  name: string;
  url: string;
  scope: 'project' | 'user' | 'polypore';
  headers?: Record<string, string>;
  authRef?: string;
  allowInsecure?: boolean;
  timeoutMs?: number;
  /* last connection-test result, if any. */
  lastTest?: { ok: boolean; ts: number; status?: number; error?: string };
};

/* MCP servers discovered from external agent configs (~/.claude.json,
   ~/.codex/config.toml). read-only in the rail. */
export type DiscoveredMcp = {
  name: string;
  origins: Array<'claude' | 'codex' | 'project'>;
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};
export type DiscoverMcpResponse = { servers: DiscoveredMcp[] };
export type McpDiscoverer = () => DiscoverMcpResponse | Promise<DiscoverMcpResponse>;

/* MCP server probe — Tauri shell overrides with a real tools/list probe. */
export type McpTesterInput = {
  url?: string;
  transport: 'http' | 'sse' | 'stdio';
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
};
export type McpTesterResult = { ok: boolean; status?: number; error?: string };
export type McpTester = (input: McpTesterInput) => McpTesterResult | Promise<McpTesterResult>;

export type McpInstallInput = {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  agents: Array<'claude-project' | 'claude-user' | 'codex'>;
};
export type McpInstallResult = { installed: boolean; targets: string[] };
export type McpInstaller = (input: McpInstallInput) => McpInstallResult | Promise<McpInstallResult>;

/* secret write/reveal hooks — Tauri shell wires them to the keyring;
   renderer-only mode falls back to the in-process SecretStore. */
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

export type SecretDeleterInput = { id: string; scope?: 'user' | 'project' };
export type SecretDeleter = (input: SecretDeleterInput) => boolean | Promise<boolean>;

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

export type AgentSlashEntry = {
  command: string;
  title: string;
  detail: string;
  source: 'agent' | 'skill' | 'polypore';
  agent?: string;
};
export type AgentDispatchEvent =
  | { kind: 'message'; text: string }
  | { kind: 'tool-call'; toolName: string; summary: string }
  | { kind: 'permission'; summary: string };
export type AgentDispatchResult = {
  adapter: string;
  responseText: string;
  events: AgentDispatchEvent[];
  streamed?: boolean;
};
export type AgentDispatcher = (params: {
  agent: string;
  sessionId: string;
  worktreeId: string;
  text: string;
  transcript: Array<{ by: 'user' | 'agent' | 'tool'; text: string }>;
}) => Promise<AgentDispatchResult>;
export type AgentCommandProvider = (agent: string) => Promise<AgentSlashEntry[]> | AgentSlashEntry[];
export type PersistenceWriter = {
  chatMessage?: (params: {
    sessionId: string;
    agent: string;
    title?: string;
    role: 'user' | 'agent' | 'tool';
    body: string;
    toolCallId?: number;
  }) => Promise<void>;
  historyEvent?: (event: HistoryEvent) => Promise<void>;
};
export type TerminalSpawnResult = {
  id: string;
  command: string;
  status: string;
  output: string;
  pid?: number | null;
  exitCode?: number | null;
};
export type TerminalRunner = {
  spawn(command: string, size?: { cols: number; rows: number }): Promise<TerminalSpawnResult>;
  stop?(id: string): Promise<boolean>;
  write?(id: string, data: string): Promise<boolean>;
  resize?(id: string, cols: number, rows: number): Promise<boolean>;
  /* registers a chunk listener; returns an unsubscribe fn. the shell wires
     this to the pty output stream so plugins can read buffered output. */
  onOutput?: (id: string, fn: (chunk: string) => void) => (() => void);
};
export type ExternalOpener = (url: string) => Promise<boolean> | boolean;
export type EditorSearchMatch = { file: string; line: number; text: string };
export type FileSystemAdapter = {
  listTree?: () => Promise<FileTreeNode[]>;
  readText?: (path: string) => Promise<string>;
  writeText?: (path: string, content: string) => Promise<void>;
  search?: (opts: { query: string; regex?: boolean; glob?: string; limit?: number }) => Promise<EditorSearchMatch[]>;
  deleteFile?: (path: string) => Promise<void>;
  renameFile?: (from: string, to: string) => Promise<void>;
  createDir?: (path: string) => Promise<void>;
  exists?: (path: string) => Promise<boolean>;
  stat?: (path: string) => Promise<{ size: number; mtime: number; isDirectory: boolean }>;
};
export type SkillPublisher = {
  publish: (id: string, name: string, body: string, agents: string[]) => Promise<{ published: string[] }>;
  unpublish: (id: string) => Promise<{ unpublished: string[] }>;
  delete: (id: string) => Promise<void>;
};
export type TaskAdapter = {
  list?: () => Promise<Task[]>;
  add?: (task: Partial<Task> & { label: string }) => Promise<Task>;
  update?: (id: string, patch: Partial<Task>) => Promise<Task>;
};
export type VerifyAdapter = {
  runs?: () => Promise<VerifyRun[]>;
  run?: (id: string) => Promise<VerifyRun>;
};
export type KnowledgeBaseScope = 'global' | 'project';
export type KnowledgeBasePreset = 'blank' | 'basic';
export type KnowledgeBaseRef = {
  id: string;
  name: string;
  root: string;
  scope: KnowledgeBaseScope;
  suggestedScope: KnowledgeBaseScope;
};
type BrowserFileHandle = {
  kind: 'file';
  name: string;
  getFile?: () => Promise<{ text: () => Promise<string> }>;
  createWritable?: () => Promise<{ write: (content: string) => Promise<void> | void; close: () => Promise<void> | void }>;
};
export type BrowserDirectoryHandle = {
  kind: 'directory';
  name: string;
  entries?: () => AsyncIterable<[string, BrowserDirectoryHandle | BrowserFileHandle]>;
  getFileHandle?: (name: string, opts?: { create?: boolean }) => Promise<BrowserFileHandle>;
  getDirectoryHandle?: (name: string, opts?: { create?: boolean }) => Promise<BrowserDirectoryHandle>;
};
export type KnowledgeAdapter = {
  bases?: () => Promise<KnowledgeBaseRef[]>;
  openFolder?: () => Promise<KnowledgeBaseRef | null>;
  createBase?: (input: {
    name: string;
    scope: KnowledgeBaseScope;
    preset: KnowledgeBasePreset;
    root?: string;
    folders?: string[];
  }) => Promise<KnowledgeBaseRef>;
  suggestBaseLocation?: (input: {
    name: string;
    scope: KnowledgeBaseScope;
  }) => Promise<string>;
  pickBaseLocation?: () => Promise<{ location: string | null; scope?: KnowledgeBaseScope }>;
  setBaseScope?: (id: string, scope: KnowledgeBaseScope) => Promise<KnowledgeBaseRef>;
  renameBase?: (id: string, name: string) => Promise<KnowledgeBaseRef>;
  deleteBase?: (id: string) => Promise<void>;
  createFolder?: (path: string, baseId?: string) => Promise<void>;
  renameFolder?: (from: string, to: string, baseId?: string) => Promise<void>;
  deleteFolder?: (path: string, baseId?: string) => Promise<void>;
  deleteDoc?: (path: string, baseId?: string) => Promise<void>;
  list?: (baseId?: string) => Promise<Array<{ kind: 'doc' | 'folder'; path: string }>>;
  read?: (path: string, baseId?: string) => Promise<string>;
  write?: (path: string, content: string, baseId?: string) => Promise<void>;
};
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
export type HistoryAdapter = {
  events?: (filter?: { worktreeId?: string; limit?: number }) => Promise<HistoryEvent[]>;
  diff?: (request: HistoryDiffRequest) => Promise<GitDiffResult>;
  fork?: (eventId: string) => Promise<WorktreeRef>;
  revert?: (eventId: string, files: string[]) => Promise<RevertResult>;
  restoreFromSnapshot?: (params: {
    snapshotCommit: string;
    files: string[];
    worktreePath?: string;
  }) => Promise<RevertResult>;
  takeSnapshot?: (params: {
    worktreeId: string;
    worktreePath?: string;
    kind?: string;
  }) => Promise<SnapshotRecord>;
  signalWrite?: (worktreeId: string) => void;
  signalTurnEnd?: (worktreeId: string) => void;
  listWorktrees?: () => Promise<WorktreeListEntry[]>;
  createWorktree?: (params: { branch?: string; path?: string; fromRef?: string }) => Promise<WorktreeRef>;
};
export type DiagnosticsProvider = () => Promise<Diagnostic[]>;
export type DiagnosticsDocumentProvider = (path: string, content: string) => Promise<Diagnostic[]>;
export type DiagnosticsDeepScanner = () => Promise<Diagnostic[]>;
export type SecretUseResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
};
export type SecretUser = (params: {
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
}) => Promise<SecretUseResult>;
export type IterateRunResult = {
  taskId: string;
  status: string;
  cycle: number;
  maxCycles: number;
  runs: Array<{
    id: string;
    label: string;
    command: string;
    required: boolean;
    exitCode: number | null;
    output: string;
  }>;
};
export type IterateRunner = (params: {
  taskId: string;
  prompt: string;
  maxCycles?: number;
  verifyCommands: Array<{ id: string; label: string; command: string; required: boolean }>;
}) => Promise<IterateRunResult>;

/* ─── Agentic Debug Suite ────────────────────────────────────────────────
   The host owns the investigation: session/timeline/trust/summarization all
   live here so they are unit-testable and so the `debug` panel renders from a
   single host-state shape. The DebugRunner is the thin seam to the Tauri
   shell (dap.rs / debug_capture.rs); browser mode leaves it null. See
   docs/specs/2026-05-28-agentic-debug-suite.md §6–§8. */
export type DebugTrust = 'observe' | 'evaluate' | 'off';
export type DebugStatus =
  | 'idle'
  | 'starting'
  | 'inspecting'
  | 'paused'
  | 'blocked'
  | 'root-caused'
  | 'failed';
export type DebugScenario = { title: string; whatsWrong?: string };
export type DebugStopReason = 'breakpoint' | 'step' | 'pause' | 'exception' | 'entry';
export type DebugStop = {
  reason: DebugStopReason | string;
  threadId?: number;
  frameId?: number;
  file?: string;
  line?: number;
  /* attribution — a human-hit breakpoint can resolve the agent's call. */
  initiatedBy?: 'agent' | 'human';
};
export type DebugBreakpointSpec = {
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
};
export type DebugBreakpointRecord = {
  file: string;
  line: number;
  setBy: 'agent' | 'human';
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  verified?: boolean;
};
export type DebugCardKind =
  | 'start'
  | 'setBreakpoints'
  | 'continue'
  | 'stepOver'
  | 'stepIn'
  | 'stepOut'
  | 'pause'
  | 'stackTrace'
  | 'scopes'
  | 'variables'
  | 'evaluate'
  | 'screenshot'
  | 'console'
  | 'dom'
  | 'network'
  | 'navigate'
  | 'click'
  | 'fill'
  | 'login'
  | 'roadblock'
  | 'rootCause';
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
/* per-session reproduction capabilities — web auto-nav is on only when the
   shell detected playwright (phase 1.5). Absent → driving degrades to the
   roadblock handoff, so there is no second code path. */
export type DebugCapabilities = { webAutoNav: boolean };
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

/* Raw DAP-shaped payloads the runner returns; the host summarizes them. */
export type DapFrame = { id: number; name: string; file?: string; line?: number; column?: number };
export type DapScope = { name: string; variablesReference: number; expensive?: boolean };
export type DapVariable = {
  name: string;
  value: string;
  type?: string;
  variablesReference?: number;
  namedVariables?: number;
  indexedVariables?: number;
};
export type DebugStopResult = { stop: DebugStop | null; terminated?: boolean; blocked?: boolean; ask?: string };
export type DebugConsoleEntry = { level: string; text: string; ts?: number };
export type DebugAdapterProbe = { adapter: string; command: string; available: boolean; detail: string };
export type DebugCaptureRunner = {
  screenshot(params: { sessionId: string; target?: string }): Promise<{ mimeType: string; dataBase64: string }>;
  console(params: { sessionId: string; limit?: number }): Promise<{ entries: DebugConsoleEntry[] }>;
  /* DOM/network need a CDP attachment — slice 1 returns a clear "needs CDP"
     error, mirroring mcp_probe.rs's stdio stub. */
  dom?(params: { sessionId: string; selector?: string }): Promise<unknown>;
  network?(params: { sessionId: string }): Promise<unknown>;
};
export type DebugRunner = {
  probe?(params: { adapter: string; config: Record<string, unknown> }): Promise<DebugAdapterProbe>;
  start(params: { adapter: string; config: Record<string, unknown> }): Promise<{ sessionId: string; blocked?: boolean; ask?: string }>;
  setBreakpoints(params: {
    sessionId: string;
    file: string;
    breakpoints: DebugBreakpointSpec[];
  }): Promise<{ breakpoints: Array<{ verified?: boolean; line?: number }> }>;
  continue(params: { sessionId: string; threadId?: number }): Promise<DebugStopResult>;
  stepOver(params: { sessionId: string; threadId?: number }): Promise<DebugStopResult>;
  stepIn(params: { sessionId: string; threadId?: number }): Promise<DebugStopResult>;
  stepOut(params: { sessionId: string; threadId?: number }): Promise<DebugStopResult>;
  pause(params: { sessionId: string; threadId?: number }): Promise<DebugStopResult>;
  stackTrace(params: { sessionId: string; threadId?: number }): Promise<{ frames: DapFrame[] }>;
  scopes(params: { sessionId: string; frameId: number }): Promise<{ scopes: DapScope[] }>;
  variables(params: { sessionId: string; variablesReference: number }): Promise<{ variables: DapVariable[] }>;
  evaluate(params: {
    sessionId: string;
    expression: string;
    frameId?: number;
  }): Promise<{ result: string; type?: string; variablesReference?: number }>;
  capture: DebugCaptureRunner;
  stop?(params: { sessionId: string }): Promise<void>;
  /* web auto-nav (phase 1.5) — optional. Present only when the shell detected
     playwright; the host gates on capabilities() and degrades to a roadblock
     when this is absent. Secret-injected login takes HANDLES, never values —
     the shell resolves them so the agent never sees the secret. */
  capabilities?(params: { sessionId: string }): Promise<DebugCapabilities>;
  drive?: DebugDriveRunner;
};
export type DebugDriveRunner = {
  navigate(params: { sessionId: string; url: string }): Promise<{ url: string; ok: boolean }>;
  click(params: { sessionId: string; selector: string }): Promise<{ ok: boolean }>;
  fill(params: { sessionId: string; selector: string; text: string }): Promise<{ ok: boolean }>;
  login(params: {
    sessionId: string;
    url?: string;
    usernameSelector: string;
    passwordSelector: string;
    usernameSecret: string;
    passwordSecret: string;
    submitSelector?: string;
    scope?: 'user' | 'project';
  }): Promise<{ ok: boolean }>;
};
/* scrubber applied to evaluate output so debuggee secrets don't leak back
   through dumps (POLYPORE_AGENT_SCRUBBED). Tauri wires this to secrets_scrub
   (async, host-side); default is identity. */
export type DebugScrubber = (text: string) => string | Promise<string>;

/* ─── Extension adapter types ──────────────────────────────────────────── */

export type GitStatusEntry = { path: string; status: string; staged: boolean };
export type GitBlameEntry = { line: number; commit: string; author: string; date: string; summary: string };
export type GitAdapter = {
  status?: () => Promise<{ entries: GitStatusEntry[]; branch: string }>;
  log?: (opts?: { limit?: number; file?: string }) => Promise<HistoryEvent[]>;
  blame?: (path: string) => Promise<GitBlameEntry[]>;
  branches?: () => Promise<{ current: string; all: string[] }>;
  stash?: () => Promise<{ ok: boolean }>;
  unstash?: () => Promise<{ ok: boolean }>;
};

export type HttpFetchInput = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};
export type HttpFetchResult = { status: number; headers: Record<string, string>; body: string };
export type HttpFetchAdapter = (input: HttpFetchInput) => HttpFetchResult | Promise<HttpFetchResult>;

export type ClipboardAdapter = {
  read?: () => Promise<string>;
  write?: (text: string) => Promise<void>;
};

export type InputBoxAdapter = (opts: {
  prompt: string;
  placeholder?: string;
  value?: string;
}) => Promise<string | null>;

export type QuickPickItem = { label: string; description?: string; value: unknown };
export type QuickPickAdapter = (items: QuickPickItem[]) => Promise<unknown | null>;

export type AgentInterrupter = (sessionId: string) => Promise<void>;

export type StatusBarItem = { id: string; pluginId: string; text: string; tooltip?: string };

export type EditorDecoration = {
  range: { start: { line: number; column: number }; end: { line: number; column: number } };
  style: 'error' | 'warning' | 'info' | 'highlight';
  message?: string;
};

export type HostStoreInitialState = {
  state?: HostState;
  tasks?: Task[];
  diagnostics?: Diagnostic[];
  verifyRuns?: VerifyRun[];
  chatSessions?: ChatSession[];
  chatMessages?: Record<string, ChatMessage[]>;
  historyEvents?: HistoryEvent[];
  knowledge?: Record<string, string>;
  files?: Record<string, string>;
  previewTargets?: PreviewTarget[];
  plugins?: PluginRef[];
  fileTree?: FileTreeNode[];
  skills?: SkillRecord[];
  skillsets?: SkillsetRecord[];
  mcpServers?: McpServerRecord[];
};

type FileTreeBucket = {
  files: string[];
  dirs: Map<string, FileTreeBucket>;
};

function fileTreeFromPaths(paths: string[]): FileTreeNode[] {
  const root: FileTreeBucket = { files: [], dirs: new Map() };
  for (const rawPath of paths) {
    const parts = rawPath.split(/[\\/]+/).filter(Boolean);
    if (parts.length === 0) continue;
    let bucket = root;
    for (const part of parts.slice(0, -1)) {
      let next = bucket.dirs.get(part);
      if (!next) {
        next = { files: [], dirs: new Map() };
        bucket.dirs.set(part, next);
      }
      bucket = next;
    }
    bucket.files.push(parts.at(-1)!);
  }

  const materialize = (bucket: FileTreeBucket, prefix = ''): FileTreeNode[] => {
    const folders = [...bucket.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, child]) => ({
        kind: 'folder' as const,
        name,
        children: materialize(child, prefix ? `${prefix}/${name}` : name),
      }));
    const files = [...new Set(bucket.files)]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        kind: 'file' as const,
        name,
        path: prefix ? `${prefix}/${name}` : name,
      }));
    return [...folders, ...files];
  };

  return materialize(root);
}

export class HostRpcServer {
  private handlers = new Map<string, RpcHandler>();
  private manifests = new Map<string, PanelManifest>();
  private notifications: HostNotification[] = [];
  private nextNotificationId = 1;

  private state: HostState = {};
  private tasks: Task[] = [];
  private diagnostics: Diagnostic[] = [];
  private verifyRuns: VerifyRun[] = [];
  private chatSessions: ChatSession[] = [];
  private chatMessages: Map<string, ChatMessage[]> = new Map();
  private sessionWorktreeIds: Map<string, string> = new Map();
  private historyEvents: HistoryEvent[] = [];
  private activeWorktreeId: string = 'main';
  private knowledge: Map<string, string> = new Map();
  private knowledgeBases: KnowledgeBaseRef[] = [];
  private browserKnowledgeHandles: Map<string, BrowserDirectoryHandle> = new Map();
  private files: Map<string, string> = new Map();
  private previewTargets: PreviewTarget[] = [];
  private plugins: PluginRef[] = [];
  private fileTree: FileTreeNode[] = [];
  private skills: SkillRecord[] = [];
  private skillsets: SkillsetRecord[] = [];
  private mcpServers: McpServerRecord[] = [];

  private subscribers = new Map<string, Set<EventListener>>();
  private confirmDecider: (request: ConfirmRequest) => ConfirmDecision | Promise<ConfirmDecision> = () => false;
  private agentDispatcher: AgentDispatcher | null = null;
  private agentCommandProvider: AgentCommandProvider | null = null;
  private persistenceWriter: PersistenceWriter | null = null;
  private terminalRunner: TerminalRunner | null = null;
  private externalOpener: ExternalOpener | null = null;
  private fileSystemAdapter: FileSystemAdapter | null = null;
  private skillPublisher: SkillPublisher | null = null;
  private taskAdapter: TaskAdapter | null = null;
  private verifyAdapter: VerifyAdapter | null = null;
  private knowledgeAdapter: KnowledgeAdapter | null = null;
  private historyAdapter: HistoryAdapter | null = null;
  private diagnosticsProvider: DiagnosticsProvider | null = null;
  private diagnosticsDocumentProvider: DiagnosticsDocumentProvider | null = null;
  private diagnosticsDeepScanner: DiagnosticsDeepScanner | null = null;
  private diagnosticsInFlight: Promise<Diagnostic[]> | null = null;
  private diagnosticsCacheExpiresAt = 0;
  private iterateRunner: IterateRunner | null = null;
  private secretStore: SecretStore | null = null;
  private secretUser: SecretUser | null = null;
  private secretWriter: SecretWriter | null = null;
  private secretRevealer: SecretRevealer | null = null;
  private secretDeleter: SecretDeleter | null = null;
  private mcpDiscoverer: McpDiscoverer | null = null;
  private mcpTester: McpTester | null = null;
  private mcpInstaller: McpInstaller | null = null;
  private debugRunner: DebugRunner | null = null;
  private debugScrubber: DebugScrubber | null = null;
  private debugCardSeq = 0;
  private debugSessionSeq = 0;
  private debug: DebugState = emptyDebugState();

  /* extension adapters */
  private gitAdapter: GitAdapter | null = null;
  private httpFetchAdapter: HttpFetchAdapter | null = null;
  private clipboardAdapter: ClipboardAdapter | null = null;
  private inputBoxAdapter: InputBoxAdapter | null = null;
  private quickPickAdapter: QuickPickAdapter | null = null;
  private agentInterrupter: AgentInterrupter | null = null;

  /* extension state */
  private terminalSessions = new Map<string, TerminalSpawnResult>();
  private terminalOutputBuffers = new Map<string, string>();
  private terminalOutputUnsubs = new Map<string, () => void>();
  private pluginStorage = new Map<string, Map<string, unknown>>();
  private statusBarItems = new Map<string, StatusBarItem>();
  private editorDecorations = new Map<string, Record<string, EditorDecoration[]>>();
  private chatContexts = new Map<string, string[]>();

  constructor(initialState: HostStoreInitialState = {}) {
    if (initialState.state) this.state = { ...initialState.state };
    if (initialState.tasks) this.tasks = [...initialState.tasks];
    if (initialState.diagnostics) this.diagnostics = [...initialState.diagnostics];
    if (initialState.verifyRuns) this.verifyRuns = [...initialState.verifyRuns];
    if (initialState.chatSessions) {
      this.chatSessions = [...initialState.chatSessions];
      for (const session of this.chatSessions) {
        if (session.worktreeId) this.sessionWorktreeIds.set(session.id, session.worktreeId);
      }
    }
    if (initialState.chatMessages) {
      for (const [k, v] of Object.entries(initialState.chatMessages)) this.chatMessages.set(k, [...v]);
    }
    if (initialState.historyEvents) this.historyEvents = [...initialState.historyEvents];
    if (initialState.knowledge) for (const [k, v] of Object.entries(initialState.knowledge)) this.knowledge.set(k, v);
    if (initialState.files) for (const [k, v] of Object.entries(initialState.files)) this.files.set(k, v);
    if (initialState.previewTargets) this.previewTargets = [...initialState.previewTargets];
    if (initialState.plugins) this.plugins = [...initialState.plugins];
    if (initialState.fileTree) this.fileTree = [...initialState.fileTree];
    else if (initialState.files) this.fileTree = fileTreeFromPaths(Object.keys(initialState.files));
    if (initialState.skills) this.skills = [...initialState.skills];
    if (initialState.skillsets) this.skillsets = [...initialState.skillsets];
    if (initialState.mcpServers) this.mcpServers = [...initialState.mcpServers];

    this.registerBuiltinHandlers();
  }

  resetProjectState(initialState: HostStoreInitialState = {}) {
    this.notifications = [];
    this.nextNotificationId = 1;
    this.state = { ...(initialState.state ?? {}) };
    this.tasks = [...(initialState.tasks ?? [])];
    this.diagnostics = [...(initialState.diagnostics ?? [])];
    this.verifyRuns = [...(initialState.verifyRuns ?? [])];
    this.chatSessions = [...(initialState.chatSessions ?? [])];
    this.chatMessages = new Map();
    this.sessionWorktreeIds = new Map();
    for (const session of this.chatSessions) {
      if (session.worktreeId) this.sessionWorktreeIds.set(session.id, session.worktreeId);
    }
    if (initialState.chatMessages) {
      for (const [k, v] of Object.entries(initialState.chatMessages)) this.chatMessages.set(k, [...v]);
    }
    this.historyEvents = [...(initialState.historyEvents ?? [])];
    this.activeWorktreeId = 'main';
    this.knowledge = new Map();
    if (initialState.knowledge) for (const [k, v] of Object.entries(initialState.knowledge)) this.knowledge.set(k, v);
    this.knowledgeBases = [];
    this.browserKnowledgeHandles = new Map();
    this.files = new Map();
    if (initialState.files) for (const [k, v] of Object.entries(initialState.files)) this.files.set(k, v);
    this.previewTargets = [...(initialState.previewTargets ?? [])];
    this.fileTree = initialState.fileTree
      ? [...initialState.fileTree]
      : initialState.files
        ? fileTreeFromPaths(Object.keys(initialState.files))
        : [];
    if (initialState.plugins) this.plugins = [...initialState.plugins];
    if (initialState.skills) this.skills = [...initialState.skills];
    if (initialState.skillsets) this.skillsets = [...initialState.skillsets];
    if (initialState.mcpServers) this.mcpServers = [...initialState.mcpServers];
    this.diagnosticsInFlight = null;
    this.diagnosticsCacheExpiresAt = 0;
    this.debugCardSeq = 0;
    this.debugSessionSeq = 0;
    this.debug = emptyDebugState();

    this.publish('project:state-reset', { ts: Date.now() });
    this.publish('chat:sessions', { sessions: [...this.chatSessions] });
    this.publish('diagnostics:changed', { diagnostics: [...this.diagnostics] });
    this.publish('verify:changed', { runs: [...this.verifyRuns] });
    this.publish('tasks:changed', { tasks: [...this.tasks] });
    this.publish('history:events-loaded', { count: this.historyEvents.length });
    this.publishDebug();
  }

  registerHandler(method: string, handler: RpcHandler) {
    this.handlers.set(method, handler);
  }

  registeredMethods() {
    return [...this.handlers.keys()];
  }

  listManifests() {
    return [...this.manifests.values()];
  }

  listNotifications() {
    return [...this.notifications];
  }

  getState<K extends StateKey>(key: K): HostState[K] {
    return this.state[key];
  }

  setState(key: StateKey, value: unknown) {
    this.state[key] = value;
    this.publish(`state:${key}`, value);
  }

  publish(topic: string, payload: unknown) {
    if (topic === 'fs:event' || topic.startsWith('editor:')) {
      hostPerfPoint(`host:publish-${topic}-invalidates-cache`);
      this.invalidateDiagnosticsCache();
    }
    const set = this.subscribers.get(topic);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch {
        /* host swallows subscriber errors so one bad listener doesn't poison the bus */
      }
    }
  }

  subscribe(topic: string, fn: EventListener): () => void {
    let set = this.subscribers.get(topic);
    if (!set) {
      set = new Set();
      this.subscribers.set(topic, set);
    }
    set.add(fn);
    return () => {
      const current = this.subscribers.get(topic);
      if (!current) return;
      current.delete(fn);
      if (current.size === 0) this.subscribers.delete(topic);
    };
  }

  setConfirmDecider(decider: (request: ConfirmRequest) => ConfirmDecision | Promise<ConfirmDecision>) {
    this.confirmDecider = decider;
  }

  setAgentDispatcher(dispatcher: AgentDispatcher | null) {
    this.agentDispatcher = dispatcher;
  }

  setAgentCommandProvider(provider: AgentCommandProvider | null) {
    this.agentCommandProvider = provider;
  }

  setPersistenceWriter(writer: PersistenceWriter | null) {
    this.persistenceWriter = writer;
  }

  setTerminalRunner(runner: TerminalRunner | null) {
    this.terminalRunner = runner;
  }

  setExternalOpener(opener: ExternalOpener | null) {
    this.externalOpener = opener;
  }

  setFileSystemAdapter(adapter: FileSystemAdapter | null) {
    this.fileSystemAdapter = adapter;
  }

  setSkillPublisher(publisher: SkillPublisher | null) {
    this.skillPublisher = publisher;
  }

  setTaskAdapter(adapter: TaskAdapter | null) {
    this.taskAdapter = adapter;
  }

  setVerifyAdapter(adapter: VerifyAdapter | null) {
    this.verifyAdapter = adapter;
  }

  setKnowledgeAdapter(adapter: KnowledgeAdapter | null) {
    this.knowledgeAdapter = adapter;
  }

  setHistoryAdapter(adapter: HistoryAdapter | null) {
    this.historyAdapter = adapter;
  }

  setDiagnosticsProvider(provider: DiagnosticsProvider | null) {
    this.diagnosticsProvider = provider;
    this.invalidateDiagnosticsCache();
  }

  setDiagnosticsDocumentProvider(provider: DiagnosticsDocumentProvider | null) {
    this.diagnosticsDocumentProvider = provider;
  }

  setDiagnosticsDeepScanner(scanner: DiagnosticsDeepScanner | null) {
    this.diagnosticsDeepScanner = scanner;
  }

  setIterateRunner(runner: IterateRunner | null) {
    this.iterateRunner = runner;
  }

  setSecretStore(store: SecretStore | null) {
    this.secretStore = store;
    if (store) {
      store.onChange(() => this.publish('secrets:changed', { secrets: store.list() }));
    }
  }

  setSecretUser(user: SecretUser | null) {
    this.secretUser = user;
  }

  setSecretWriter(fn: SecretWriter | null) {
    this.secretWriter = fn;
  }

  setSecretRevealer(fn: SecretRevealer | null) {
    this.secretRevealer = fn;
  }

  setSecretDeleter(fn: SecretDeleter | null) {
    this.secretDeleter = fn;
  }

  setMcpDiscoverer(fn: McpDiscoverer | null) {
    this.mcpDiscoverer = fn;
  }

  setMcpTester(fn: McpTester | null) {
    this.mcpTester = fn;
  }

  setMcpInstaller(fn: McpInstaller | null) {
    this.mcpInstaller = fn;
  }

  setDebugRunner(runner: DebugRunner | null) {
    this.debugRunner = runner;
  }

  setDebugScrubber(fn: DebugScrubber | null) {
    this.debugScrubber = fn;
  }

  setGitAdapter(adapter: GitAdapter | null) {
    this.gitAdapter = adapter;
  }

  setHttpFetchAdapter(adapter: HttpFetchAdapter | null) {
    this.httpFetchAdapter = adapter;
  }

  setClipboardAdapter(adapter: ClipboardAdapter | null) {
    this.clipboardAdapter = adapter;
  }

  setInputBoxAdapter(adapter: InputBoxAdapter | null) {
    this.inputBoxAdapter = adapter;
  }

  setQuickPickAdapter(adapter: QuickPickAdapter | null) {
    this.quickPickAdapter = adapter;
  }

  setAgentInterrupter(interrupter: AgentInterrupter | null) {
    this.agentInterrupter = interrupter;
  }

  private pluginStorageFor(pluginId: string): Map<string, unknown> {
    let store = this.pluginStorage.get(pluginId);
    if (!store) {
      store = new Map();
      this.pluginStorage.set(pluginId, store);
    }
    return store;
  }

  private requireDebugRunner(): DebugRunner {
    if (!this.debugRunner) throw new Error('debug is not available without the desktop shell');
    return this.debugRunner;
  }

  private activeDebugSession(): DebugSessionInfo {
    if (!this.debug.session) throw new Error('no active debug session — call debug.start first');
    return this.debug.session;
  }

  private dapSessionId(session: DebugSessionInfo): string {
    return session.dapSessionId ?? session.id;
  }

  private openDebugSession(
    adapter: string,
    scenario: DebugScenario,
    trust: DebugTrust,
    dapSessionId: string,
  ): DebugSessionInfo {
    const session: DebugSessionInfo = {
      id: `dbg-${++this.debugSessionSeq}`,
      dapSessionId,
      adapter,
      scenario,
      trust,
      status: 'starting',
      createdAt: Date.now(),
    };
    this.debug.sessions = [...this.debug.sessions, session];
    this.debug.session = session;
    this.debug.status = 'starting';
    this.debug.stop = null;
    this.debug.rootCause = null;
    this.debug.capabilities = { webAutoNav: false };
    this.publishDebug();
    return session;
  }

  private newDebugCard(kind: DebugCardKind, title: string, initiatedBy?: 'agent' | 'human'): DebugCard {
    const card: DebugCard = {
      id: `dbg-card-${++this.debugCardSeq}`,
      ts: Date.now(),
      kind,
      title,
      status: 'running',
      initiatedBy,
    };
    this.debug.timeline = [...this.debug.timeline, card];
    this.publishDebug();
    return card;
  }

  private finishDebugCard(card: DebugCard, patch: Partial<DebugCard>): DebugCard {
    const updated: DebugCard = { ...card, ...patch };
    this.debug.timeline = this.debug.timeline.map((item) => (item.id === card.id ? updated : item));
    this.publishDebug();
    return updated;
  }

  private raiseRoadblock(ask: string) {
    this.debug.roadblock = { ask, askedAt: Date.now() };
    this.debug.status = 'blocked';
    if (this.debug.session) this.debug.session.status = 'blocked';
    const card = this.newDebugCard('roadblock', ask, 'agent');
    this.finishDebugCard(card, { status: 'done', payload: { ask, resolved: false } });
  }

  private async execDebugStop(
    kind: DebugCardKind,
    params: unknown,
    exec: (args: { sessionId: string; threadId?: number }) => Promise<DebugStopResult>,
  ) {
    const session = this.activeDebugSession();
    const p = (params as { threadId?: number }) ?? {};
    const card = this.newDebugCard(kind, kind, 'agent');
    try {
      const res = await exec({ sessionId: this.dapSessionId(session), threadId: p.threadId });
      if (res.blocked) {
        this.raiseRoadblock(res.ask ?? 'reproduce the broken state, then continue');
        this.finishDebugCard(card, { status: 'done', payload: { blocked: true, ask: res.ask } });
        return { blocked: true, ask: res.ask };
      }
      if (res.terminated || !res.stop) {
        this.debug.stop = null;
        this.debug.status = 'inspecting';
        session.status = 'inspecting';
        this.finishDebugCard(card, { status: 'done', payload: { terminated: Boolean(res.terminated) } });
        return { terminated: Boolean(res.terminated), stop: null };
      }
      const stop: DebugStop = { ...res.stop, initiatedBy: res.stop.initiatedBy ?? 'agent' };
      this.debug.stop = stop;
      this.debug.status = 'paused';
      session.status = 'paused';
      this.finishDebugCard(card, { status: 'done', initiatedBy: stop.initiatedBy, payload: { stop } });
      return { stop };
    } catch (err) {
      this.finishDebugCard(card, { status: 'failed', error: debugErrMessage(err) });
      throw err;
    }
  }

  private async execDrive(
    kind: DebugCardKind,
    title: string,
    roadblockAsk: string,
    cardPayload: Record<string, unknown>,
    run: (drive: DebugDriveRunner, session: DebugSessionInfo) => Promise<unknown>,
  ) {
    const session = this.activeDebugSession();
    const runner = this.requireDebugRunner();
    /* the graceful-degrade hinge: no auto-nav → same roadblock seam a login
       wall or a non-web surface would raise. one path, not two. */
    if (!this.debug.capabilities.webAutoNav || !runner.drive) {
      this.raiseRoadblock(roadblockAsk);
      return { blocked: true, ask: roadblockAsk };
    }
    const card = this.newDebugCard(kind, title, 'agent');
    try {
      const result = await run(runner.drive, session);
      this.finishDebugCard(card, { status: 'done', payload: cardPayload });
      return result ?? { ok: true };
    } catch (err) {
      this.finishDebugCard(card, { status: 'failed', error: debugErrMessage(err) });
      throw err;
    }
  }

  /* push the current breakpoints for one file to the adapter (when a session
     is live). Used by add/removeBreakpoint so human edits take effect mid-run. */
  private async syncBreakpointsForFile(file: string) {
    const session = this.debug.session;
    if (!session || !this.debugRunner) return;
    const records = this.debug.breakpoints.filter((bp) => bp.file === file);
    try {
      await this.debugRunner.setBreakpoints({
        sessionId: this.dapSessionId(session),
        file,
        breakpoints: records.map((bp) => ({ line: bp.line, condition: bp.condition, hitCondition: bp.hitCondition, logMessage: bp.logMessage })),
      });
    } catch {
      /* best effort — the breakpoint stays armed in state and shows in the gutter */
    }
  }

  /* replay every armed breakpoint to a freshly-started adapter, grouped by file. */
  private async replayBreakpoints(runner: DebugRunner, dapSessionId: string) {
    const byFile = new Map<string, DebugBreakpointRecord[]>();
    for (const bp of this.debug.breakpoints) {
      byFile.set(bp.file, [...(byFile.get(bp.file) ?? []), bp]);
    }
    for (const [file, records] of byFile) {
      try {
        await runner.setBreakpoints({
          sessionId: dapSessionId,
          file,
          breakpoints: records.map((bp) => ({ line: bp.line, condition: bp.condition, hitCondition: bp.hitCondition, logMessage: bp.logMessage })),
        });
      } catch {
        /* best effort */
      }
    }
  }

  private debugSnapshot(): DebugState {
    return {
      session: this.debug.session ? { ...this.debug.session } : null,
      sessions: this.debug.sessions.map((session) => ({ ...session })),
      timeline: this.debug.timeline.map((card) => ({ ...card })),
      roadblock: this.debug.roadblock ? { ...this.debug.roadblock } : null,
      status: this.debug.status,
      stop: this.debug.stop ? { ...this.debug.stop } : null,
      breakpoints: this.debug.breakpoints.map((bp) => ({ ...bp })),
      rootCause: this.debug.rootCause ? { ...this.debug.rootCause } : null,
      capabilities: { ...this.debug.capabilities },
    };
  }

  private publishDebug() {
    this.setState('debug', this.debugSnapshot());
  }

  recordAgentRuntimeEvent(params: {
    agent: string;
    adapter: string;
    sessionId: string;
    event: AgentDispatchEvent;
  }) {
    const { agent, adapter, sessionId, event } = params;
    const worktreeId = this.worktreeIdForSession(sessionId);
    if (event.kind === 'message') {
      const message: ChatMessage = {
        id: `msg-${Date.now()}-stream`,
        sessionId,
        by: 'agent',
        ts: Date.now(),
        text: event.text,
      };
      this.chatMessages.set(sessionId, [...(this.chatMessages.get(sessionId) ?? []), message]);
      this.publish('chat:message', { sessionId, message, adapter });
      void this.persistChatMessage(sessionId, agent, message);
      return;
    }
    if (event.kind === 'permission') {
      const message: ChatMessage = {
        id: `msg-${Date.now()}-permission`,
        sessionId,
        by: 'agent',
        ts: Date.now(),
        text: `permission requested: ${event.summary}`,
      };
      this.chatMessages.set(sessionId, [...(this.chatMessages.get(sessionId) ?? []), message]);
      this.publish('chat:message', { sessionId, message, adapter });
      void this.persistChatMessage(sessionId, agent, message);
      return;
    }
    const historyEvent = this.recordHistoryEvent({
      ts: Date.now(),
      taskId: 'active',
      source: 'agent',
      kind: 'tool-call',
      agentId: agent,
      toolName: event.toolName,
      summary: event.summary,
      affectedFiles: [],
      worktreeId,
      payload: { sessionId },
    });
    this.publish('agent:tool-call', historyEvent);
    this.notifyWriteForCurrentWorktree(historyEvent);
  }

  /* Centralized history event ingestion: assigns id if missing, prepends
  to the in-memory cache, publishes the bus event, and write-through to
  persistence. Returns the canonical event so callers can react. */
  recordHistoryEvent(partial: Omit<HistoryEvent, 'id'> & { id?: string }): HistoryEvent {
    const event: HistoryEvent = {
      id: partial.id ?? `ev-${partial.ts}-${this.historyEvents.length}`,
      ts: partial.ts,
      taskId: partial.taskId,
      source: partial.source,
      kind: partial.kind,
      agentId: partial.agentId,
      toolName: partial.toolName,
      phase: partial.phase,
      affectedFiles: partial.affectedFiles ?? [],
      summary: partial.summary,
      payload: partial.payload,
      snapshotId: partial.snapshotId,
      worktreeId: partial.worktreeId ?? this.activeWorktreeId,
      snapshotCommit: partial.snapshotCommit,
    };
    this.historyEvents = [event, ...this.historyEvents];
    this.publish('history:event', event);
    if (this.persistenceWriter?.historyEvent) {
      void this.persistenceWriter.historyEvent(event).catch((err) => {
        console.warn('history event persist failed', err);
      });
    }
    return event;
  }

  /* Replace the in-memory cache with persisted events (e.g., on startup). */
  loadHistoryEvents(events: HistoryEvent[]) {
    this.historyEvents = [...events].sort((a, b) => b.ts - a.ts);
    this.publish('history:events-loaded', { count: this.historyEvents.length });
  }

  setActiveWorktreeId(worktreeId: string | null) {
    this.activeWorktreeId = worktreeId ?? 'main';
  }

  getActiveWorktreeId(): string {
    return this.activeWorktreeId;
  }

  private bindSessionWorktree(sessionId: string, worktreeId: string) {
    this.sessionWorktreeIds.set(sessionId, worktreeId);
    let changed = false;
    this.chatSessions = this.chatSessions.map((session) => {
      if (session.id !== sessionId || session.worktreeId === worktreeId) return session;
      changed = true;
      return { ...session, worktreeId };
    });
    if (changed) this.publish('chat:sessions', { sessions: this.chatSessions });
  }

  private worktreeIdForSession(sessionId: string, requestedWorktreeId?: string | null): string {
    const requested = requestedWorktreeId?.trim();
    if (requested) {
      this.bindSessionWorktree(sessionId, requested);
      return requested;
    }
    const existing = this.sessionWorktreeIds.get(sessionId)
      ?? this.chatSessions.find((session) => session.id === sessionId)?.worktreeId;
    if (existing) {
      this.bindSessionWorktree(sessionId, existing);
      return existing;
    }
    this.bindSessionWorktree(sessionId, this.activeWorktreeId);
    return this.activeWorktreeId;
  }

  /* shared read/write path for knowledge docs across adapter / browser-handle
     / in-memory backings, so link/handoff/adr don't each re-derive it. */
  private async readKnowledgeRaw(path: string, baseId?: string): Promise<string> {
    if (this.knowledgeAdapter?.read) return this.knowledgeAdapter.read(path, baseId);
    const handle = baseId ? this.browserKnowledgeHandles.get(baseId) : null;
    if (handle) return readBrowserKnowledge(handle, path).catch(() => '');
    return this.knowledge.get(path) ?? '';
  }

  private async writeKnowledgeRaw(path: string, content: string, baseId?: string): Promise<void> {
    if (this.knowledgeAdapter?.write) {
      await this.knowledgeAdapter.write(path, content, baseId);
      return;
    }
    const handle = baseId ? this.browserKnowledgeHandles.get(baseId) : null;
    if (handle) {
      await writeBrowserKnowledge(handle, path, content);
      return;
    }
    this.knowledge.set(path, content);
  }

  private notifyWriteForCurrentWorktree(event: HistoryEvent) {
    if (!event.worktreeId) return;
    if (event.kind === 'tool-call' || event.kind === 'file-edit' || event.kind === 'file-write') {
      this.historyAdapter?.signalWrite?.(event.worktreeId);
    }
  }

  async handle(request: RpcRequest): Promise<RpcResponse> {
    const envelope = validateSchema('rpc/envelope.schema.json', request);
    if (!envelope.ok) return this.error(request.id, 'invalid_params', 'invalid rpc envelope', envelope.errors);

    const paramsValidation = validateMethodParams(request.method, request.params);
    if (!paramsValidation.ok) {
      return this.error(request.id, 'invalid_params', 'params failed schema validation', paramsValidation.errors);
    }

    const handler = this.handlers.get(request.method);
    if (!handler) return this.error(request.id, 'method_not_found', `method not found: ${request.method}`);

    try {
      return { kind: 'response', id: request.id, ok: true, result: await handler(request.params) };
    } catch (err) {
      return this.error(
        request.id,
        rpcErrorCode(err),
        err instanceof Error ? err.message : 'internal host error',
        rpcErrorData(err),
      );
    }
  }

  private error(id: number, code: RpcError['code'], message: string, data?: unknown): RpcResponse {
    return { kind: 'response', id, ok: false, error: { code, message, data } };
  }

  private invalidateDiagnosticsCache() {
    if (this.diagnosticsCacheExpiresAt !== 0) {
      hostPerfPoint('host:diagnostics-cache-invalidated');
    }
    this.diagnosticsCacheExpiresAt = 0;
  }

  private async getDiagnostics(): Promise<Diagnostic[]> {
    if (!this.diagnosticsProvider) return this.diagnostics;

    const now = Date.now();
    if (now < this.diagnosticsCacheExpiresAt) {
      hostPerfPoint('host:diagnostics-cache-HIT');
      return this.diagnostics;
    }
    if (this.diagnosticsInFlight) {
      hostPerfPoint('host:diagnostics-await-in-flight');
      return this.diagnosticsInFlight;
    }
    hostPerfPoint('host:diagnostics-cache-MISS-start-fetch');
    this.diagnosticsInFlight = this.diagnosticsProvider()
      .then((diagnostics) => {
        this.diagnostics = diagnostics;
        this.diagnosticsCacheExpiresAt = Date.now() + 30_000;
        this.publish('diagnostics:changed', { diagnostics });
        return diagnostics;
      })
      .finally(() => {
        this.diagnosticsInFlight = null;
      });
    return this.diagnosticsInFlight;
  }

  private updateDiagnostics(diagnostics: Diagnostic[]) {
    this.diagnostics = dedupeHostDiagnostics(diagnostics);
    this.diagnosticsCacheExpiresAt = Date.now() + 30_000;
    this.publish('diagnostics:changed', { diagnostics: this.diagnostics });
    return this.diagnostics;
  }

  private registerBuiltinHandlers() {
    /* baseline — same surface the loopback test panel uses */
    this.registerHandler('manifest.register', (params) => {
      const manifest = (params as { manifest: PanelManifest }).manifest;
      this.manifests.set(manifest.id, manifest);
      return { registered: true, panelId: manifest.id };
    });

    this.registerHandler('plugin.ready', (params) => {
      const { manifestId } = params as { manifestId: string };
      this.publish('plugin:ready', { manifestId });
      return { ack: true, manifestId };
    });

    this.registerHandler('host.subscribe', (params) => {
      const { topic } = params as { topic: string };
      return { subscribed: true, topic };
    });
    this.registerHandler('host.unsubscribe', (params) => {
      const { topic } = params as { topic: string };
      return { unsubscribed: true, topic };
    });

    this.registerHandler('ui.notify', (params) => {
      const { level, msg } = params as { level: HostNotification['level']; msg: string };
      this.notifications = [
        { id: `note-${this.nextNotificationId++}`, level, msg },
        ...this.notifications,
      ];
      return { shown: true };
    });
    this.registerHandler('ui.confirm', async (params) => {
      const { msg, confirmLabel, files } = params as { msg: string; confirmLabel?: string; files?: string[] };
      return normalizeConfirmDecision(await this.confirmDecider({
        kind: 'generic',
        message: msg,
        details: confirmLabel || files?.length
          ? { confirmLabel, files: files?.map((path) => ({ path })) }
          : undefined,
      }));
    });
    this.registerHandler('ui.openExternal', async (params) => {
      const { url } = params as { url: string };
      if (!this.externalOpener) return { opened: false };
      return { opened: await this.externalOpener(url) };
    });

    /* §4.3 state */
    this.registerHandler('state.get', (params) => {
      const { key } = params as { key: StateKey };
      return { key, value: this.state[key] ?? null };
    });

    /* editor — in-memory map of file contents + a file tree the panel can
       render in its explorer. real M6 swaps both for FS-backed reads. */
    this.registerHandler('editor.tree', async () => {
      if (this.fileSystemAdapter?.listTree) {
        return { tree: await this.fileSystemAdapter.listTree() };
      }
      return { tree: this.fileTree };
    });
    this.registerHandler('editor.open', (params) => {
      const { path } = params as { path: string };
      this.publish('editor:opened', { path });
      return { opened: true, path };
    });
    this.registerHandler('editor.read', async (params) => {
      const { path } = params as { path: string };
      const content = this.files.get(path);
      if (content == null && this.fileSystemAdapter?.readText) {
        return { path, content: await this.fileSystemAdapter.readText(path) };
      }
      if (content == null) throw new Error(`file not found: ${path}`);
      return { path, content };
    });
    this.registerHandler('editor.applyEdit', async (params) => {
      const { path, edits } = params as { path: string; edits: unknown[] };
      const current = this.files.get(path) ?? (this.fileSystemAdapter?.readText ? await this.fileSystemAdapter.readText(path).catch(() => '') : '');
      const nextContent = applyTextEdits(current, edits);
      if (this.fileSystemAdapter?.writeText) {
        await this.fileSystemAdapter.writeText(path, nextContent);
      }
      this.files.set(path, nextContent);
      this.publish(`editor:${path}`, { path, edits });
      return { applied: edits.length };
    });
    this.registerHandler('editor.search', async (params) => {
      const { query, regex, glob, limit } = params as { query: string; regex?: boolean; glob?: string; limit?: number };
      const cap = Math.min(limit ?? 200, 1000);
      if (this.fileSystemAdapter?.search) {
        return { matches: await this.fileSystemAdapter.search({ query, regex, glob, limit: cap }), query };
      }
      /* renderer-only fallback: scan the in-memory editor buffers. */
      const matcher = regex ? safeRegExp(query) : null;
      const matches: EditorSearchMatch[] = [];
      for (const [file, content] of this.files) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          const hit = matcher ? matcher.test(lines[i]) : lines[i].includes(query);
          if (hit) {
            matches.push({ file, line: i + 1, text: lines[i].slice(0, 400) });
            if (matches.length >= cap) return { matches, query };
          }
        }
      }
      return { matches, query };
    });

    /* knowledge — project-backed when the shell provides a filesystem adapter,
       otherwise in-memory for renderer-only tests. */
    registerKnowledgeHandlers(this as unknown as HostInternals);
    this.registerHandler('tasks.list', async () => {
      if (this.taskAdapter?.list) {
        this.tasks = await this.taskAdapter.list();
      }
      return { tasks: [...this.tasks] };
    });
    this.registerHandler('tasks.add', async (params) => {
      const partial = params as Partial<Task> & { label: string };
      if (this.taskAdapter?.add) {
        const task = await this.taskAdapter.add(partial);
        this.tasks = [...this.tasks.filter((item) => item.id !== task.id), task];
        this.publish('tasks:changed', { tasks: this.tasks });
        return { task };
      }
      const task: Task = {
        id: `t-${Date.now()}-${this.tasks.length}`,
        label: partial.label,
        done: partial.done ?? false,
        parentId: partial.parentId,
        panelHint: partial.panelHint,
        createdAt: Date.now(),
        createdBy: partial.createdBy ?? 'user',
      };
      this.tasks = [...this.tasks, task];
      this.publish('tasks:changed', { tasks: this.tasks });
      return { task };
    });
    this.registerHandler('tasks.update', async (params) => {
      const { id, patch } = params as { id: string; patch: Partial<Task> };
      if (this.taskAdapter?.update) {
        const task = await this.taskAdapter.update(id, patch);
        this.tasks = this.tasks.map((item) => (item.id === id ? task : item));
        if (!this.tasks.some((item) => item.id === id)) this.tasks = [...this.tasks, task];
        this.publish('tasks:changed', { tasks: this.tasks });
        return { task };
      }
      const idx = this.tasks.findIndex((t) => t.id === id);
      if (idx < 0) throw new Error(`task not found: ${id}`);
      this.tasks = this.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));
      this.publish('tasks:changed', { tasks: this.tasks });
      return { task: this.tasks[idx] };
    });

    /* diagnostics */
    this.registerHandler('diagnostics.list', async (params) => {
      const filter = (params as { severity?: string; file?: string; source?: string }) ?? {};
      const diagnostics = await this.getDiagnostics();
      const filtered = diagnostics.filter((d) => {
        if (filter.severity && d.severity !== filter.severity) return false;
        if (filter.file && d.file !== filter.file) return false;
        if (filter.source && d.source !== filter.source) return false;
        return true;
      });
      return { diagnostics: filtered };
    });
    this.registerHandler('diagnostics.document', async (params) => {
      const { path, content } = params as { path: string; content: string };
      if (!path || typeof content !== 'string') return { diagnostics: [] };
      const diagnostics = this.diagnosticsDocumentProvider
        ? await this.diagnosticsDocumentProvider(path, content)
        : [];
      return { diagnostics: dedupeHostDiagnostics(diagnostics) };
    });
    this.registerHandler('diagnostics.deepScan', async () => {
      const deep = this.diagnosticsDeepScanner ? await this.diagnosticsDeepScanner() : this.diagnostics;
      const diagnostics = this.updateDiagnostics(deep);
      return { diagnostics };
    });

    /* verify */
    this.registerHandler('verify.runs', async () => {
      if (this.verifyAdapter?.runs) {
        this.verifyRuns = await this.verifyAdapter.runs();
      }
      return { runs: [...this.verifyRuns] };
    });
    this.registerHandler('verify.run', async (params) => {
      const { id } = params as { id: string };
      if (this.verifyAdapter?.run) {
        const run = await this.verifyAdapter.run(id);
        this.verifyRuns = [run, ...this.verifyRuns.filter((item) => item.id !== id)];
        this.publish('verify:changed', { runs: this.verifyRuns });
        return { run };
      }
      const run = this.verifyRuns.find((r) => r.id === id);
      if (!run) throw new Error(`verify command not found: ${id}`);
      const updated: VerifyRun = { ...run, status: 'pending', ranAt: Date.now() };
      this.verifyRuns = this.verifyRuns.map((r) => (r.id === id ? updated : r));
      this.publish('verify:changed', { runs: this.verifyRuns });
      return { run: updated };
    });
    this.registerHandler('iterate.run', async (params) => {
      const input = params as {
        taskId: string;
        prompt: string;
        maxCycles?: number;
        verifyCommands: Array<{ id: string; label: string; command: string; required: boolean }>;
      };
      if (this.iterateRunner) return { result: await this.iterateRunner(input) };
      return {
        result: {
          taskId: input.taskId,
          status: 'unavailable',
          cycle: 0,
          maxCycles: input.maxCycles ?? 5,
          runs: input.verifyCommands.map((command) => ({
            id: `${command.id}-${Date.now()}`,
            label: command.label,
            command: command.command,
            required: command.required,
            exitCode: null,
            output: 'iterate runner unavailable without the desktop shell',
          })),
        },
      };
    });

    /* chat */
    this.registerHandler('chat.sessions', () => ({ sessions: [...this.chatSessions] }));
    this.registerHandler('chat.history', (params) => {
      const { sessionId } = params as { sessionId: string };
      return { sessionId, messages: this.chatMessages.get(sessionId) ?? [] };
    });
    this.registerHandler('agent.commands', async (params) => {
      const { agent } = params as { agent?: string };
      const agentId = agent && agent.trim() ? agent.trim() : 'codex';
      const provided = this.agentCommandProvider ? await this.agentCommandProvider(agentId) : [];
      const skillEntries: AgentSlashEntry[] = this.skills.map((skill) => ({
        command: `/${skill.id}`,
        title: skill.name || skill.id,
        detail: skill.summary || 'project skill',
        source: 'skill',
        agent: agentId,
      }));
      return { agent: agentId, commands: [...provided, ...skillEntries] };
    });
    this.registerHandler('chat.send', async (params) => {
      const { sessionId, text, agent, worktreeId } = params as { sessionId: string; text: string; agent?: string; worktreeId?: string };
      const agentId = agent ?? inferAgentFromSession(sessionId);
      const turnWorktreeId = this.worktreeIdForSession(sessionId, worktreeId);
      if (!this.chatSessions.some((session) => session.id === sessionId)) {
        this.chatSessions = [
          {
            id: sessionId,
            agent: agentId,
            title: `${agentId} ${this.chatSessions.filter((session) => session.agent === agentId).length + 1}`,
            createdAt: Date.now(),
            worktreeId: turnWorktreeId,
          },
          ...this.chatSessions,
        ];
        this.publish('chat:sessions', { sessions: this.chatSessions });
      }
      const message: ChatMessage = {
        id: `msg-${Date.now()}`,
        sessionId,
        by: 'user',
        ts: Date.now(),
        text,
      };
      const existing = this.chatMessages.get(sessionId) ?? [];
      const next = [...existing, message];
      this.chatMessages.set(sessionId, next);
      this.publish('chat:message', { sessionId, message });
      void this.persistChatMessage(sessionId, agentId, message);

      if (!this.agentDispatcher) return { message, agentQueued: false };

      const transcript = [...existing, message].map((item) => ({ by: item.by, text: item.text }));
      void (async () => {
        let result: AgentDispatchResult;
        try {
          result = await this.agentDispatcher!({ agent: agentId, sessionId, worktreeId: turnWorktreeId, text, transcript });
        } catch (err) {
          const agentMessage: ChatMessage = {
            id: `msg-${Date.now()}-agent-error`,
            sessionId,
            by: 'agent',
            ts: Date.now(),
            text: `chat send failed: ${err instanceof Error ? err.message : String(err)}`,
          };
          this.chatMessages.set(sessionId, [...(this.chatMessages.get(sessionId) ?? []), agentMessage]);
          this.publish('chat:message', { sessionId, message: agentMessage, adapter: 'error' });
          void this.persistChatMessage(sessionId, agentId, agentMessage);
          return;
        }
        for (const event of result.events) {
          if (event.kind === 'permission') {
            const permissionMessage: ChatMessage = {
              id: `msg-${Date.now()}-permission`,
              sessionId,
              by: 'agent',
              ts: Date.now(),
              text: `permission requested: ${event.summary}`,
            };
            this.chatMessages.set(sessionId, [...(this.chatMessages.get(sessionId) ?? []), permissionMessage]);
            this.publish('chat:message', { sessionId, message: permissionMessage, adapter: result.adapter });
            void this.persistChatMessage(sessionId, agentId, permissionMessage);
            continue;
          }
          if (event.kind !== 'tool-call') continue;
          const historyEvent = this.recordHistoryEvent({
            ts: Date.now(),
            taskId: 'active',
            source: 'agent',
            kind: 'tool-call',
            agentId,
            toolName: event.toolName,
            summary: event.summary,
            affectedFiles: [],
            worktreeId: turnWorktreeId,
            payload: { sessionId },
          });
          this.publish('agent:tool-call', historyEvent);
          this.notifyWriteForCurrentWorktree(historyEvent);
        }

        if (!result.streamed) {
          const agentMessage: ChatMessage = {
            id: `msg-${Date.now()}-agent`,
            sessionId,
            by: 'agent',
            ts: Date.now(),
            text: result.responseText || `${agentId} returned no text.`,
          };
          this.chatMessages.set(sessionId, [...(this.chatMessages.get(sessionId) ?? []), agentMessage]);
          this.publish('chat:message', { sessionId, message: agentMessage, adapter: result.adapter });
          void this.persistChatMessage(sessionId, agentId, agentMessage);
        }
        /* Turn boundary: agent done responding. Signal the snapshotter so an
        interactive-kind snapshot can land at a clean conversational seam. */
        this.publish('task:turn-end', { sessionId, worktreeId: turnWorktreeId });
        this.historyAdapter?.signalTurnEnd?.(turnWorktreeId);
      })();
      return { message, agentQueued: true };
    });

    /* history */
    this.registerHandler('history.events', async (params) => {
      const filter = (params as { limit?: number; worktreeId?: string }) ?? {};
      if (this.historyAdapter?.events) {
        try {
          const fresh = await this.historyAdapter.events(filter);
          if (Array.isArray(fresh)) {
            this.loadHistoryEvents(fresh);
          }
        } catch (err) {
          console.warn('history.events adapter failed; falling back to memory', err);
        }
      }
      let events = this.historyEvents;
      if (filter.worktreeId) {
        events = events.filter((e) => (e.worktreeId ?? 'main') === filter.worktreeId);
      }
      const limit = typeof filter.limit === 'number' ? filter.limit : events.length;
      return { events: events.slice(0, limit) };
    });
    this.registerHandler('history.diff', async (params) => {
      const { mode, file, snapshotCommit, worktreePath } = (params as {
        mode?: string;
        file?: string;
        snapshotCommit?: string;
        worktreePath?: string;
      }) ?? {};
      const requestedMode = (mode as HistoryDiffRequest['mode']) ?? 'working';
      if (this.historyAdapter?.diff) {
        return {
          diff: await this.historyAdapter.diff({
            mode: requestedMode,
            file,
            snapshotCommit,
            worktreePath,
          }),
        };
      }
      return {
        diff: {
          mode: requestedMode,
          file: file ?? null,
          changedFiles: [],
          diff: '',
          exitCode: null,
        },
      };
    });
    this.registerHandler('history.fork', (params) => {
      const { eventId } = params as { eventId: string };
      const ev = this.historyEvents.find((e) => e.id === eventId);
      if (!ev) throw new Error(`history event not found: ${eventId}`);
      if (this.historyAdapter?.fork) return this.historyAdapter.fork(eventId).then((worktree) => ({ worktree }));
      return { worktree: { id: `wt-${Date.now()}`, path: `/tmp/wt-${eventId}`, branch: `fork/${eventId}`, forkedFromEventId: eventId } };
    });
    this.registerHandler('history.revert', (params) => {
      const { eventId, files, snapshotCommit, worktreePath } = params as {
        eventId?: string;
        files?: string[];
        snapshotCommit?: string;
        worktreePath?: string;
      };
      let resolvedFiles = files ?? [];
      if (eventId) {
        const ev = this.historyEvents.find((e) => e.id === eventId);
        if (!ev) throw new Error(`history event not found: ${eventId}`);
        if (resolvedFiles.length === 0) resolvedFiles = ev.affectedFiles;
      }
      if (snapshotCommit && this.historyAdapter?.restoreFromSnapshot) {
        return this.historyAdapter
          .restoreFromSnapshot({ snapshotCommit, files: resolvedFiles, worktreePath })
          .then((reverted) => ({ reverted }));
      }
      if (eventId && this.historyAdapter?.revert) {
        return this.historyAdapter.revert(eventId, resolvedFiles).then((reverted) => ({ reverted }));
      }
      return { reverted: { files: resolvedFiles, output: 'history revert unavailable without the desktop shell', exitCode: 1 } };
    });
    this.registerHandler('worktrees.list', async () => {
      if (this.historyAdapter?.listWorktrees) {
        const worktrees = await this.historyAdapter.listWorktrees();
        return { worktrees };
      }
      return { worktrees: [] as WorktreeListEntry[] };
    });
    this.registerHandler('worktrees.create', async (params) => {
      const { branch, path, fromRef } = (params as { branch?: string; path?: string; fromRef?: string }) ?? {};
      if (this.historyAdapter?.createWorktree) {
        const worktree = await this.historyAdapter.createWorktree({ branch, path, fromRef });
        return { worktree };
      }
      const ts = Date.now();
      const slug = (branch?.trim() || `worktree-${ts}`).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `worktree-${ts}`;
      return {
        worktree: {
          id: `wt-${ts}`,
          path: path?.trim() || `/tmp/${slug}`,
          branch: branch?.trim() || `polypore/worktree/${slug}`,
          forkedFromEventId: 'manual',
        },
      };
    });
    this.registerHandler('snapshots.take', async (params) => {
      const { worktreeId, worktreePath, kind } = (params as {
        worktreeId?: string;
        worktreePath?: string;
        kind?: string;
      }) ?? {};
      const id = worktreeId ?? this.activeWorktreeId;
      if (!this.historyAdapter?.takeSnapshot) {
        throw new Error('snapshots are unavailable without the desktop shell');
      }
      /* The shell emits a `polypore://snapshot-taken` event that App.tsx
      forwards to recordHistoryEvent, so we do NOT record here — otherwise
      every manual autosave would land in the rail twice. */
      const record = await this.historyAdapter.takeSnapshot({ worktreeId: id, worktreePath, kind });
      return { snapshot: record };
    });
    this.registerHandler('snapshots.signalTurnEnd', (params) => {
      const { worktreeId } = (params as { worktreeId?: string }) ?? {};
      const id = worktreeId ?? this.activeWorktreeId;
      this.historyAdapter?.signalTurnEnd?.(id);
      return { ok: true };
    });

    /* preview */
    this.registerHandler('preview.list', () => ({ targets: [...this.previewTargets] }));
    this.registerHandler('preview.register', (params) => {
      const partial = params as Partial<PreviewTarget>;
      const target: PreviewTarget = {
        id: partial.id || `pv-${Date.now()}`,
        kind: (partial.kind as PreviewTarget['kind']) ?? 'site',
        label: partial.label ?? partial.command ?? 'preview',
        command: partial.command ?? '',
        target: partial.target ?? '',
        registeredAt: Date.now(),
        ...(partial.cwd ? { cwd: partial.cwd } : {}),
        ...(partial.agentId ? { agentId: partial.agentId } : {}),
      };
      this.previewTargets = [...this.previewTargets, target];
      this.publish('preview:registered', { target });
      return { target };
    });
    this.registerHandler('preview.refresh', (params) => {
      const { id } = (params as { id?: string }) ?? {};
      this.publish('preview:refresh-requested', { id });
      return { refreshed: true, id };
    });

    /* terminal */
    this.registerHandler('terminal.spawn', async (params) => {
      const { command, cols, rows } = (params as { command?: string; cols?: number; rows?: number }) ?? {};
      const size = typeof cols === 'number' && typeof rows === 'number' ? { cols, rows } : undefined;
      const session = this.terminalRunner
        ? await this.terminalRunner.spawn(command ?? '', size)
        : {
            id: `pty-${Date.now()}`,
            command: command ?? '',
            status: 'exited',
            output: 'terminal bridge unavailable without the desktop shell\n',
            exitCode: 1,
          };
      this.terminalSessions.set(session.id, session);
      this.terminalOutputBuffers.set(session.id, session.output ?? '');
      if (this.terminalRunner?.onOutput) {
        const unsub = this.terminalRunner.onOutput(session.id, (chunk) => {
          const current = this.terminalOutputBuffers.get(session.id) ?? '';
          this.terminalOutputBuffers.set(session.id, current + chunk);
          this.publish(`terminal:output:${session.id}`, { id: session.id, chunk });
          this.publish('terminal:event', { id: session.id, kind: 'output', data: chunk, command: session.command });
        });
        this.terminalOutputUnsubs.set(session.id, unsub);
      }
      return { session };
    });
    this.registerHandler('terminal.stop', async (params) => {
      const { id } = params as { id: string };
      const stopped = await this.terminalRunner?.stop?.(id);
      this.terminalOutputUnsubs.get(id)?.();
      this.terminalOutputUnsubs.delete(id);
      this.publish(`terminal:exit:${id}`, { id, exitCode: null });
      this.publish('terminal:event', { id, command: '', kind: 'exited', data: null, exitCode: null });
      return { stopped: !!stopped, id };
    });
    this.registerHandler('terminal.write', async (params) => {
      const { id, data } = params as { id: string; data: string };
      const written = await this.terminalRunner?.write?.(id, data);
      return { written: !!written, id };
    });
    this.registerHandler('terminal.resize', async (params) => {
      const { id, cols, rows } = params as { id: string; cols: number; rows: number };
      const resized = await this.terminalRunner?.resize?.(id, cols, rows);
      return { resized: !!resized, id };
    });
    this.registerHandler('terminal.list', () => {
      return { sessions: [...this.terminalSessions.values()] };
    });
    this.registerHandler('terminal.read', (params) => {
      const { id } = params as { id: string };
      const output = this.terminalOutputBuffers.get(id);
      if (output === undefined) throw Object.assign(new Error(`terminal session not found: ${id}`), { code: 'not_found' as const });
      return { id, output };
    });

    /* mcp.invoke is the bridge to user-installed MCP servers. without the
       Tauri shell + host_broker we have no transport, so the renderer-side
       loopback returns a graceful "no broker" error. */
    this.registerHandler('mcp.invoke', (params) => {
      const { server, method } = params as { server: string; method: string };
      return {
        ok: false,
        error: 'mcp broker unavailable in renderer-only mode',
        server,
        method,
      };
    });

    /* workspace queries — informational only on the renderer side. */
    this.registerHandler('workspace.activePanel', () => {
      return { panelId: this.state.activePanel ?? null, instanceId: null };
    });
    this.registerHandler('workspace.describe', () => {
      /* agent self-orientation: what workspace is loaded, which panels are
         available, and which one the human is looking at. */
      const agentPanels = Array.isArray(this.state.agentPanels) ? (this.state.agentPanels as unknown[]) : [];
      return {
        workspace: this.state.workspace ?? 'Default',
        activePanel: this.state.activePanel ?? null,
        panels: [...this.manifests.values()].map((manifest) => ({
          id: manifest.id,
          title: manifest.title,
          category: manifest.category,
        })),
        agentPanels,
      };
    });

    /* panels — purely informational; the actual layout is owned by the host UI */
    this.registerHandler('panel.list', () => ({ manifests: [...this.manifests.values()] }));
    this.registerHandler('panel.open', (params) => {
      const { id, area } = params as { id: string; area?: 'center' | 'left' | 'right' | 'bottom' };
      if (!this.manifests.has(id)) throw new Error(`panel manifest not found: ${id}`);
      const instanceId = `inst-${Date.now()}`;
      this.publish('panel:opened', { instanceId, panelId: id, area });
      return { instanceId, area };
    });
    this.registerHandler('panel.close', (params) => {
      const { instanceId } = params as { instanceId: string };
      this.publish('panel:closed', { instanceId });
      return { closed: true };
    });

    /* secrets — host returns masked entries; values never traverse rpc.
       the SecretStore lives host-side (renderer Settings page writes to it
       directly, not via RPC). plugins can only see masks + configured bit. */
    registerSecretsHandlers(this as unknown as HostInternals);
    registerDebugHandlers(this as unknown as HostInternals);
    registerPluginsHandlers(this as unknown as HostInternals);
    registerSkillsHandlers(this as unknown as HostInternals);
    registerMcpHandlers(this as unknown as HostInternals);
    this.registerHandler('formation.upsert', (params) => {
      const { nodes, edges } = params as { nodes: FormationNodeSpec[]; edges: FormationEdgeSpec[] };
      const value = { nodes, edges, ts: Date.now() };
      this.setState('formation', value);
      this.publish('formation:upserted', value);
      return { upserted: true, nodes: nodes.length, edges: edges.length };
    });
    this.registerHandler('workflow.update', (params) => {
      const { nodes, edges } = params as { nodes: unknown[]; edges: unknown[] };
      const value = { nodes: nodes ?? [], edges: edges ?? [], ts: Date.now() };
      this.setState('workflow', value);
      this.publish('workflow:update', value);
      return { updated: true, nodes: value.nodes.length, edges: value.edges.length };
    });
    this.registerHandler('phase.report', (params) => {
      const { phase, status } = params as { phase: string; status: string };
      const prior = Array.isArray((this.state.phase as { phases?: unknown[] } | undefined)?.phases)
        ? ((this.state.phase as { phases: Array<{ phase: string; status: string; ts: number }> }).phases)
        : [];
      const phases = [...prior.filter((entry) => entry.phase !== phase), { phase, status, ts: Date.now() }];
      const value = { current: phase, status, phases };
      this.setState('phase', value);
      this.publish('phase:report', value);
      return { reported: true, phase, status };
    });

    /* ─── fs — file creation / deletion / rename beyond applyEdit ────── */
    this.registerHandler('fs.write', async (params) => {
      const { path, content } = params as { path: string; content: string };
      if (this.fileSystemAdapter?.writeText) await this.fileSystemAdapter.writeText(path, content);
      this.files.set(path, content);
      this.publish('fs:event', { kind: 'write', path });
      this.publish(`editor:${path}`, { path, kind: 'write' });
      return { written: true, path };
    });
    this.registerHandler('fs.delete', async (params) => {
      const { path } = params as { path: string };
      if (this.fileSystemAdapter?.deleteFile) await this.fileSystemAdapter.deleteFile(path);
      this.files.delete(path);
      this.publish('fs:event', { kind: 'delete', path });
      return { deleted: true, path };
    });
    this.registerHandler('fs.rename', async (params) => {
      const { from, to } = params as { from: string; to: string };
      if (this.fileSystemAdapter?.renameFile) {
        await this.fileSystemAdapter.renameFile(from, to);
        /* mirror into the in-memory map so read() sees the new path */
        const content = this.files.get(from);
        if (content !== undefined) { this.files.delete(from); this.files.set(to, content); }
      } else {
        const content = this.files.get(from);
        if (content === undefined) throw Object.assign(new Error(`file not found: ${from}`), { code: 'not_found' as const });
        this.files.delete(from);
        this.files.set(to, content);
      }
      this.publish('fs:event', { kind: 'rename', from, to });
      return { renamed: true, from, to };
    });
    this.registerHandler('fs.mkdir', async (params) => {
      const { path } = params as { path: string };
      if (this.fileSystemAdapter?.createDir) await this.fileSystemAdapter.createDir(path);
      return { created: true, path };
    });
    this.registerHandler('fs.exists', async (params) => {
      const { path } = params as { path: string };
      if (this.fileSystemAdapter?.exists) return { exists: await this.fileSystemAdapter.exists(path) };
      return { exists: this.files.has(path) };
    });
    this.registerHandler('fs.stat', async (params) => {
      const { path } = params as { path: string };
      if (this.fileSystemAdapter?.stat) return this.fileSystemAdapter.stat(path);
      const content = this.files.get(path);
      if (content === undefined) throw Object.assign(new Error(`file not found: ${path}`), { code: 'not_found' as const });
      return { size: content.length, mtime: Date.now(), isDirectory: false };
    });

    /* ─── editor surface extensions ─────────────────────────────────── */
    this.registerHandler('editor.setDecorations', (params) => {
      const { path, decorations, pluginId } = params as { path: string; decorations: EditorDecoration[]; pluginId?: string };
      const key = pluginId ?? 'default';
      let perPath = this.editorDecorations.get(path);
      if (!perPath) { perPath = {}; this.editorDecorations.set(path, perPath); }
      perPath[key] = decorations;
      const all = Object.values(perPath).flat();
      this.publish(`editor:decorations:${path}`, { path, decorations: all });
      this.publish('editor:decorations-changed', { path, pluginId: key });
      return { applied: decorations.length, path };
    });
    this.registerHandler('editor.cursor', (params) => {
      const { path } = params as { path: string };
      const cursor = (this.state.editorCursor ?? null) as { path: string; line: number; column: number } | null;
      if (!cursor || cursor.path !== path) return { path, cursor: null };
      return { path, cursor: { line: cursor.line, column: cursor.column } };
    });
    this.registerHandler('editor.selection', (params) => {
      const { path } = params as { path: string };
      const sel = (this.state.editorSelection ?? null) as {
        path: string; start: { line: number; column: number }; end: { line: number; column: number };
      } | null;
      if (!sel || sel.path !== path) return { path, selection: null };
      return { path, selection: { start: sel.start, end: sel.end } };
    });
    this.registerHandler('editor.revealLine', (params) => {
      const { path, line } = params as { path: string; line: number };
      this.publish('editor:revealLine', { path, line });
      return { ok: true };
    });
    this.registerHandler('editor.language', (params) => {
      const { path } = params as { path: string };
      return { path, language: languageFromPath(path) };
    });

    /* ─── ui extensions ─────────────────────────────────────────────── */
    this.registerHandler('ui.statusBar.add', (params) => {
      const { text, tooltip, pluginId } = params as { text: string; tooltip?: string; pluginId?: string };
      const id = `sb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const item: StatusBarItem = { id, pluginId: pluginId ?? 'unknown', text, tooltip };
      this.statusBarItems.set(id, item);
      this.publish('ui:statusBar-changed', { items: [...this.statusBarItems.values()] });
      return { id };
    });
    this.registerHandler('ui.statusBar.update', (params) => {
      const { id, text, tooltip } = params as { id: string; text?: string; tooltip?: string };
      const existing = this.statusBarItems.get(id);
      if (!existing) throw Object.assign(new Error(`status bar item not found: ${id}`), { code: 'not_found' as const });
      const updated: StatusBarItem = {
        ...existing,
        ...(text !== undefined ? { text } : {}),
        ...(tooltip !== undefined ? { tooltip } : {}),
      };
      this.statusBarItems.set(id, updated);
      this.publish('ui:statusBar-changed', { items: [...this.statusBarItems.values()] });
      return { updated: true };
    });
    this.registerHandler('ui.statusBar.remove', (params) => {
      const { id } = params as { id: string };
      const removed = this.statusBarItems.delete(id);
      if (removed) this.publish('ui:statusBar-changed', { items: [...this.statusBarItems.values()] });
      return { removed };
    });
    this.registerHandler('ui.panel.setTitle', (params) => {
      const { instanceId, title } = params as { instanceId: string; title: string };
      this.publish('panel:titleChanged', { instanceId, title });
      return { ok: true };
    });
    this.registerHandler('ui.panel.setBadge', (params) => {
      const { instanceId, count } = params as { instanceId: string; count: number | null };
      this.publish('panel:badgeChanged', { instanceId, count });
      return { ok: true };
    });
    this.registerHandler('ui.panel.focus', (params) => {
      const { instanceId } = params as { instanceId: string };
      this.publish('panel:focusRequested', { instanceId });
      return { ok: true };
    });
    this.registerHandler('ui.inputBox', async (params) => {
      const { prompt, placeholder, value } = params as { prompt: string; placeholder?: string; value?: string };
      if (!this.inputBoxAdapter) {
        throw Object.assign(new Error('ui.inputBox is not available without a shell binding'), { code: 'unsupported_capability' as const });
      }
      const result = await this.inputBoxAdapter({ prompt, placeholder, value });
      return { value: result };
    });
    this.registerHandler('ui.quickPick', async (params) => {
      const { items } = params as { items: QuickPickItem[] };
      if (!this.quickPickAdapter) {
        throw Object.assign(new Error('ui.quickPick is not available without a shell binding'), { code: 'unsupported_capability' as const });
      }
      const selected = await this.quickPickAdapter(items);
      return { selected };
    });

    /* ─── plugin storage — per-plugin scoped key-value ───────────────── */
    this.registerHandler('storage.get', (params) => {
      const { pluginId, key } = params as { pluginId: string; key: string };
      const store = this.pluginStorageFor(pluginId);
      return { value: store.has(key) ? store.get(key) : null };
    });
    this.registerHandler('storage.set', (params) => {
      const { pluginId, key, value } = params as { pluginId: string; key: string; value: unknown };
      this.pluginStorageFor(pluginId).set(key, value);
      return { written: true };
    });
    this.registerHandler('storage.delete', (params) => {
      const { pluginId, key } = params as { pluginId: string; key: string };
      const deleted = this.pluginStorageFor(pluginId).delete(key);
      return { deleted };
    });
    this.registerHandler('storage.list', (params) => {
      const { pluginId } = params as { pluginId: string };
      return { keys: [...this.pluginStorageFor(pluginId).keys()] };
    });

    /* ─── git ──────────────────────────────────────────────────────── */
    this.registerHandler('git.status', async () => {
      if (!this.gitAdapter?.status) return { entries: [], branch: 'unknown' };
      return this.gitAdapter.status();
    });
    this.registerHandler('git.log', async (params) => {
      const { limit, file } = (params as { limit?: number; file?: string }) ?? {};
      if (!this.gitAdapter?.log) return { events: [] };
      return { events: await this.gitAdapter.log({ limit, file }) };
    });
    this.registerHandler('git.blame', async (params) => {
      const { path } = params as { path: string };
      if (!this.gitAdapter?.blame) return { entries: [] };
      return { entries: await this.gitAdapter.blame(path) };
    });
    this.registerHandler('git.branches', async () => {
      if (!this.gitAdapter?.branches) return { current: 'unknown', all: [] };
      return this.gitAdapter.branches();
    });
    this.registerHandler('git.stash', async () => {
      if (!this.gitAdapter?.stash) {
        throw Object.assign(new Error('git.stash is not available without a shell binding'), { code: 'unsupported_capability' as const });
      }
      return this.gitAdapter.stash();
    });
    this.registerHandler('git.unstash', async () => {
      if (!this.gitAdapter?.unstash) {
        throw Object.assign(new Error('git.unstash is not available without a shell binding'), { code: 'unsupported_capability' as const });
      }
      return this.gitAdapter.unstash();
    });

    /* ─── inter-plugin bus ──────────────────────────────────────────── */
    this.registerHandler('bus.publish', (params) => {
      const { topic, payload } = params as { topic: string; payload: unknown };
      this.publish(topic, payload);
      return { published: true, topic };
    });

    /* ─── chat extensions ───────────────────────────────────────────── */
    this.registerHandler('chat.interrupt', async (params) => {
      const { sessionId } = params as { sessionId: string };
      if (!this.agentInterrupter) {
        throw Object.assign(new Error('chat.interrupt is not available without a shell binding'), { code: 'unsupported_capability' as const });
      }
      await this.agentInterrupter(sessionId);
      return { interrupted: true, sessionId };
    });
    this.registerHandler('chat.context.list', (params) => {
      const { sessionId } = params as { sessionId: string };
      return { sessionId, paths: this.chatContexts.get(sessionId) ?? [] };
    });
    this.registerHandler('chat.context.add', (params) => {
      const { sessionId, path } = params as { sessionId: string; path: string };
      const current = this.chatContexts.get(sessionId) ?? [];
      if (!current.includes(path)) this.chatContexts.set(sessionId, [...current, path]);
      this.publish('chat:context-changed', { sessionId, paths: this.chatContexts.get(sessionId) });
      return { added: true, sessionId, path };
    });
    this.registerHandler('chat.context.remove', (params) => {
      const { sessionId, path } = params as { sessionId: string; path: string };
      const current = this.chatContexts.get(sessionId) ?? [];
      this.chatContexts.set(sessionId, current.filter((item) => item !== path));
      this.publish('chat:context-changed', { sessionId, paths: this.chatContexts.get(sessionId) });
      return { removed: true, sessionId, path };
    });

    /* ─── http proxy ────────────────────────────────────────────────── */
    this.registerHandler('http.fetch', async (params) => {
      if (!this.httpFetchAdapter) {
        throw Object.assign(new Error('http.fetch is not available without a shell binding'), { code: 'unsupported_capability' as const });
      }
      return this.httpFetchAdapter(params as HttpFetchInput);
    });

    /* ─── clipboard ─────────────────────────────────────────────────── */
    this.registerHandler('clipboard.read', async () => {
      if (!this.clipboardAdapter?.read) {
        throw Object.assign(new Error('clipboard.read is not available without a shell binding'), { code: 'unsupported_capability' as const });
      }
      return { text: await this.clipboardAdapter.read() };
    });
    this.registerHandler('clipboard.write', async (params) => {
      const { text } = params as { text: string };
      if (!this.clipboardAdapter?.write) {
        throw Object.assign(new Error('clipboard.write is not available without a shell binding'), { code: 'unsupported_capability' as const });
      }
      await this.clipboardAdapter.write(text);
      return { written: true };
    });

    /* plugins — write side helpers used by settings and plugin management
       surfaces. full package staging happens before plugins.install calls
       this host boundary. */
    this.registerHandler('plugins.toggle', (params) => {
      const { id } = params as { id: string };
      const existing = this.plugins.find((p) => p.id === id);
      if (!existing) {
        const next: PluginRef = {
          id,
          version: '0.1.0',
          scope: 'project',
          enabled: true,
          installedAt: Date.now(),
        };
        this.plugins = [...this.plugins, next];
        this.publish('plugins:changed', { plugins: this.plugins });
        return { enabled: true, id };
      }
      this.plugins = this.plugins.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p));
      this.publish('plugins:changed', { plugins: this.plugins });
      return { enabled: !existing.enabled, id };
    });
  }

  private async persistChatMessage(sessionId: string, agent: string, message: ChatMessage) {
    if (!this.persistenceWriter?.chatMessage) return;
    try {
      await this.persistenceWriter.chatMessage({
        sessionId,
        agent,
        title: sessionId,
        role: message.by,
        body: message.text,
        toolCallId: message.toolCallId ? Number(message.toolCallId) : undefined,
      });
    } catch {
      /* persistence is best-effort from the renderer host; the Rust shell logs the durable error path. */
    }
  }
}

type ParamValidator = (params: unknown) => ValidationResult;
type ParamObject = Record<string, unknown>;
type FieldRule = {
  required?: boolean;
  check: (value: unknown) => boolean;
  message: string;
};

const STATE_KEYS = new Set<string>([
  'activeAgent',
  'agentConnected',
  'project',
  'workspace',
  'activePanel',
  'agentPanels',
  'branch',
  'contextUsedPct',
  'context',
  'permissionMode',
  'loopCycle',
  'preview',
  'formation',
  'workflow',
  'phase',
  'tasks',
  'diagnostics',
  'verifyRuns',
  'debug',
  'editorCursor',
  'editorSelection',
]);

const okValidation = { ok: true } as const;

function validationError(instancePath: string, message: string): ValidationResult {
  return {
    ok: false,
    errors: [{
      instancePath,
      schemaPath: '',
      keyword: 'type',
      params: {},
      message,
    }],
  };
}

function isPlainObject(value: unknown): value is ParamObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: ParamObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function objectShape(fields: Record<string, FieldRule>, opts: { allowUnknown?: boolean } = {}): ParamValidator {
  return (params) => {
    if (!isPlainObject(params)) return validationError('', 'params must be an object');
    if (!opts.allowUnknown) {
      const allowed = new Set(Object.keys(fields));
      const unknown = Object.keys(params).find((key) => !allowed.has(key));
      if (unknown) return validationError(`/${unknown}`, 'unknown param');
    }
    for (const [key, rule] of Object.entries(fields)) {
      const present = hasOwn(params, key) && params[key] !== undefined;
      if (!present) {
        if (rule.required) return validationError(`/${key}`, `${key} is required`);
        continue;
      }
      if (!rule.check(params[key])) return validationError(`/${key}`, rule.message);
    }
    return okValidation;
  };
}

const emptyParams = objectShape({});
const stringValue = (value: unknown): value is string => typeof value === 'string';
const numberValue = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const integerValue = (value: unknown): value is number => Number.isInteger(value);
const positiveInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1;
const booleanValue = (value: unknown): value is boolean => typeof value === 'boolean';
const looseObject = (value: unknown) => isPlainObject(value);
const stringArray = (value: unknown) => Array.isArray(value) && value.every(stringValue);
const isUnknownArray = (value: unknown) => Array.isArray(value);
const objectArray = (value: unknown) => Array.isArray(value) && value.every(isPlainObject);
const optionalAny = () => true;
const enumValue = (values: readonly string[]) => (value: unknown) => typeof value === 'string' && values.includes(value);
const scopeValue = enumValue(['user', 'project']);
const knowledgeScopeValue = enumValue(['global', 'project']);
const mcpScopeValue = enumValue(['user', 'project', 'polypore']);
const areaValue = enumValue(['center', 'left', 'right', 'bottom']);
const previewKindValue = enumValue(['site', 'desktop', 'mobile', 'cli', 'game', 'test']);
const debugTrustValue = enumValue(['observe', 'evaluate', 'off']);
const debugSetByValue = enumValue(['agent', 'human']);
const agentValue = enumValue(['claude', 'codex']);
const skillOriginValue = enumValue(['polypore', 'builtin', 'claude', 'codex']);
const historyModeValue = enumValue(['working', 'snapshot', 'branch', 'event']);
const createdByValue = enumValue(['user', 'agent']);
const notifyLevelValue = enumValue(['info', 'success', 'warning', 'warn', 'error']);

function recordOfString(value: unknown): boolean {
  return isPlainObject(value) && Object.values(value).every(stringValue);
}

function stringArrayOf(value: unknown, pred: (item: unknown) => boolean = stringValue): boolean {
  return Array.isArray(value) && value.every(pred);
}

function isPosition(value: unknown): boolean {
  return objectShape({
    line: { required: true, check: numberValue, message: 'line must be a number' },
    column: { required: true, check: numberValue, message: 'column must be a number' },
  })(value).ok;
}

function isRange(value: unknown): boolean {
  return objectShape({
    start: { required: true, check: isPosition, message: 'start must be a position' },
    end: { required: true, check: isPosition, message: 'end must be a position' },
  })(value).ok;
}

function isTextEditArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((edit) => objectShape({
    range: { required: true, check: isRange, message: 'range must be a text range' },
    newText: { required: true, check: stringValue, message: 'newText must be a string' },
  })(edit).ok);
}

function isVerifyCommandArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((command) => objectShape({
    id: { required: true, check: stringValue, message: 'id must be a string' },
    label: { required: true, check: stringValue, message: 'label must be a string' },
    command: { required: true, check: stringValue, message: 'command must be a string' },
    required: { required: true, check: booleanValue, message: 'required must be a boolean' },
  })(command).ok);
}

function isSecretRequest(value: unknown): boolean {
  return objectShape({
    url: { required: true, check: stringValue, message: 'url must be a string' },
    method: { check: stringValue, message: 'method must be a string' },
    headers: { check: recordOfString, message: 'headers must be a string map' },
    body: { check: optionalAny, message: 'body may be any json value' },
    timeoutMs: { check: numberValue, message: 'timeoutMs must be a number' },
    allowInsecure: { check: booleanValue, message: 'allowInsecure must be a boolean' },
  })(value).ok;
}

function isBreakpointSpecArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((breakpoint) => objectShape({
    line: { required: true, check: positiveInteger, message: 'line must be a positive integer' },
    condition: { check: stringValue, message: 'condition must be a string' },
    hitCondition: { check: stringValue, message: 'hitCondition must be a string' },
    logMessage: { check: stringValue, message: 'logMessage must be a string' },
  })(breakpoint).ok);
}

function isDebugScenario(value: unknown): boolean {
  return objectShape({
    title: { required: true, check: stringValue, message: 'title must be a string' },
    whatsWrong: { check: stringValue, message: 'whatsWrong must be a string' },
  })(value).ok;
}

function isPluginRefInput(value: unknown): boolean {
  return objectShape({
    id: { required: true, check: stringValue, message: 'id must be a string' },
    version: { check: stringValue, message: 'version must be a string' },
    scope: { check: enumValue(['builtin', 'project', 'user']), message: 'scope must be builtin, project, or user' },
    enabled: { check: booleanValue, message: 'enabled must be a boolean' },
    installedAt: { check: numberValue, message: 'installedAt must be a number' },
    source: { check: stringValue, message: 'source must be a string' },
    permissions: { check: stringArray, message: 'permissions must be strings' },
  })(value).ok;
}

function isMcpLastTest(value: unknown): boolean {
  return objectShape({
    ok: { required: true, check: booleanValue, message: 'ok must be a boolean' },
    ts: { required: true, check: numberValue, message: 'ts must be a number' },
    status: { check: numberValue, message: 'status must be a number' },
    error: { check: stringValue, message: 'error must be a string' },
  })(value).ok;
}

function isFilesList(value: unknown): boolean {
  return Array.isArray(value) && value.every((file) => objectShape({
    path: { required: true, check: stringValue, message: 'path must be a string' },
    sizeBytes: { required: true, check: numberValue, message: 'sizeBytes must be a number' },
  })(file).ok);
}

const RPC_PARAM_VALIDATORS: Record<string, ParamValidator> = {
  'manifest.register': (params) => validateRef('https://polypore.dev/schemas/rpc/manifest.schema.json#/definitions/manifest.register.params', params),
  'plugin.ready': objectShape({ manifestId: { required: true, check: stringValue, message: 'manifestId must be a string' } }),
  'host.subscribe': objectShape({ topic: { required: true, check: stringValue, message: 'topic must be a string' } }),
  'host.unsubscribe': objectShape({ topic: { required: true, check: stringValue, message: 'topic must be a string' } }),
  'ui.notify': (params) => validateRef('https://polypore.dev/schemas/rpc/ui.schema.json#/definitions/ui.notify.params', params),
  'ui.confirm': (params) => validateRef('https://polypore.dev/schemas/rpc/ui.schema.json#/definitions/ui.confirm.params', params),
  'ui.openExternal': (params) => validateRef('https://polypore.dev/schemas/rpc/ui.schema.json#/definitions/ui.openExternal.params', params),
  'state.get': objectShape({ key: { required: true, check: (value) => stringValue(value) && STATE_KEYS.has(value), message: 'key must be a known state key' } }),
  'editor.tree': emptyParams,
  'editor.open': objectShape({
    path: { required: true, check: stringValue, message: 'path must be a string' },
    opts: { check: looseObject, message: 'opts must be an object' },
  }),
  'editor.read': objectShape({ path: { required: true, check: stringValue, message: 'path must be a string' } }),
  'editor.search': objectShape({
    query: { required: true, check: stringValue, message: 'query must be a string' },
    regex: { check: booleanValue, message: 'regex must be a boolean' },
    glob: { check: stringValue, message: 'glob must be a string' },
    limit: { check: numberValue, message: 'limit must be a number' },
  }),
  'editor.applyEdit': objectShape({
    path: { required: true, check: stringValue, message: 'path must be a string' },
    edits: { required: true, check: isTextEditArray, message: 'edits must be text edits' },
  }),
  'workspace.describe': emptyParams,
  'knowledge.link': objectShape({
    from: { required: true, check: stringValue, message: 'from must be a string' },
    to: { required: true, check: stringValue, message: 'to must be a string' },
    displayText: { check: stringValue, message: 'displayText must be a string' },
    baseId: { check: stringValue, message: 'baseId must be a string' },
  }),
  'knowledge.handoff': objectShape({
    summary: { required: true, check: stringValue, message: 'summary must be a string' },
    nextSteps: { check: stringArray, message: 'nextSteps must be strings' },
    context: { check: stringArray, message: 'context must be strings' },
    baseId: { check: stringValue, message: 'baseId must be a string' },
  }),
  'adr.record': objectShape({
    title: { required: true, check: stringValue, message: 'title must be a string' },
    body: { check: stringValue, message: 'body must be a string' },
    baseId: { check: stringValue, message: 'baseId must be a string' },
  }),
  'phase.report': objectShape({
    phase: { required: true, check: stringValue, message: 'phase must be a string' },
    status: { required: true, check: stringValue, message: 'status must be a string' },
  }),
  'workflow.update': objectShape({
    nodes: { required: true, check: isUnknownArray, message: 'nodes must be an array' },
    edges: { required: true, check: isUnknownArray, message: 'edges must be an array' },
  }),
  'knowledge.bases': emptyParams,
  'knowledge.openFolder': emptyParams,
  'knowledge.suggestBaseLocation': objectShape({
    name: { required: true, check: stringValue, message: 'name must be a string' },
    scope: { required: true, check: knowledgeScopeValue, message: 'scope must be global or project' },
  }),
  'knowledge.pickBaseLocation': emptyParams,
  'knowledge.createBase': objectShape({
    name: { required: true, check: stringValue, message: 'name must be a string' },
    scope: { required: true, check: knowledgeScopeValue, message: 'scope must be global or project' },
    preset: { required: true, check: enumValue(['blank', 'basic']), message: 'preset must be blank or basic' },
    root: { check: stringValue, message: 'root must be a string' },
    folders: { check: stringArray, message: 'folders must be strings' },
  }),
  'knowledge.setBaseScope': objectShape({
    id: { required: true, check: stringValue, message: 'id must be a string' },
    scope: { required: true, check: knowledgeScopeValue, message: 'scope must be global or project' },
  }),
  'knowledge.renameBase': objectShape({
    id: { required: true, check: stringValue, message: 'id must be a string' },
    name: { required: true, check: stringValue, message: 'name must be a string' },
  }),
  'knowledge.deleteBase': objectShape({ id: { required: true, check: stringValue, message: 'id must be a string' } }),
  'knowledge.createFolder': objectShape({
    path: { required: true, check: stringValue, message: 'path must be a string' },
    baseId: { check: stringValue, message: 'baseId must be a string' },
  }),
  'knowledge.renameFolder': objectShape({
    from: { required: true, check: stringValue, message: 'from must be a string' },
    to: { required: true, check: stringValue, message: 'to must be a string' },
    baseId: { check: stringValue, message: 'baseId must be a string' },
  }),
  'knowledge.deleteFolder': objectShape({
    path: { required: true, check: stringValue, message: 'path must be a string' },
    baseId: { check: stringValue, message: 'baseId must be a string' },
  }),
  'knowledge.deleteDoc': objectShape({
    path: { required: true, check: stringValue, message: 'path must be a string' },
    baseId: { check: stringValue, message: 'baseId must be a string' },
  }),
  'knowledge.list': objectShape({ baseId: { check: stringValue, message: 'baseId must be a string' } }),
  'knowledge.read': objectShape({
    path: { required: true, check: stringValue, message: 'path must be a string' },
    baseId: { check: stringValue, message: 'baseId must be a string' },
  }),
  'knowledge.write': objectShape({
    path: { required: true, check: stringValue, message: 'path must be a string' },
    content: { required: true, check: stringValue, message: 'content must be a string' },
    baseId: { check: stringValue, message: 'baseId must be a string' },
  }),
  'tasks.list': emptyParams,
  'tasks.add': objectShape({
    label: { required: true, check: stringValue, message: 'label must be a string' },
    panelHint: { check: stringValue, message: 'panelHint must be a string' },
    done: { check: booleanValue, message: 'done must be a boolean' },
    parentId: { check: stringValue, message: 'parentId must be a string' },
    createdBy: { check: createdByValue, message: 'createdBy must be user or agent' },
  }),
  'tasks.update': objectShape({
    id: { required: true, check: stringValue, message: 'id must be a string' },
    patch: { required: true, check: looseObject, message: 'patch must be an object' },
  }),
  'diagnostics.list': objectShape({
    severity: { check: enumValue(['error', 'warning', 'info']), message: 'severity must be error, warning, or info' },
    file: { check: stringValue, message: 'file must be a string' },
    source: { check: stringValue, message: 'source must be a string' },
  }),
  'diagnostics.document': objectShape({
    path: { required: true, check: stringValue, message: 'path must be a string' },
    content: { required: true, check: stringValue, message: 'content must be a string' },
  }),
  'diagnostics.deepScan': emptyParams,
  'verify.runs': emptyParams,
  'verify.run': objectShape({ id: { required: true, check: stringValue, message: 'id must be a string' } }),
  'iterate.run': objectShape({
    taskId: { required: true, check: stringValue, message: 'taskId must be a string' },
    prompt: { required: true, check: stringValue, message: 'prompt must be a string' },
    maxCycles: { check: numberValue, message: 'maxCycles must be a number' },
    verifyCommands: { required: true, check: isVerifyCommandArray, message: 'verifyCommands must be verify command objects' },
  }),
  'chat.sessions': emptyParams,
  'chat.history': objectShape({ sessionId: { required: true, check: stringValue, message: 'sessionId must be a string' } }),
  'agent.commands': objectShape({ agent: { check: stringValue, message: 'agent must be a string' } }),
  'chat.send': objectShape({
    sessionId: { required: true, check: stringValue, message: 'sessionId must be a string' },
    text: { required: true, check: stringValue, message: 'text must be a string' },
    agent: { check: stringValue, message: 'agent must be a string' },
    worktreeId: { check: stringValue, message: 'worktreeId must be a string' },
  }),
  'history.events': objectShape({
    limit: { check: numberValue, message: 'limit must be a number' },
    worktreeId: { check: stringValue, message: 'worktreeId must be a string' },
  }),
  'history.diff': objectShape({
    mode: { check: historyModeValue, message: 'mode must be working, snapshot, branch, or event' },
    file: { check: stringValue, message: 'file must be a string' },
    snapshotCommit: { check: stringValue, message: 'snapshotCommit must be a string' },
    worktreePath: { check: stringValue, message: 'worktreePath must be a string' },
  }),
  'history.fork': objectShape({ eventId: { required: true, check: stringValue, message: 'eventId must be a string' } }),
  'history.revert': objectShape({
    eventId: { check: stringValue, message: 'eventId must be a string' },
    files: { check: stringArray, message: 'files must be strings' },
    snapshotCommit: { check: stringValue, message: 'snapshotCommit must be a string' },
    worktreePath: { check: stringValue, message: 'worktreePath must be a string' },
  }),
  'worktrees.list': emptyParams,
  'worktrees.create': objectShape({
    branch: { check: stringValue, message: 'branch must be a string' },
    path: { check: stringValue, message: 'path must be a string' },
    fromRef: { check: stringValue, message: 'fromRef must be a string' },
  }),
  'snapshots.take': objectShape({
    worktreeId: { check: stringValue, message: 'worktreeId must be a string' },
    worktreePath: { check: stringValue, message: 'worktreePath must be a string' },
    kind: { check: stringValue, message: 'kind must be a string' },
  }),
  'snapshots.signalTurnEnd': objectShape({ worktreeId: { check: stringValue, message: 'worktreeId must be a string' } }),
  'preview.list': emptyParams,
  'preview.register': objectShape({
    id: { check: stringValue, message: 'id must be a string' },
    kind: { check: previewKindValue, message: 'kind must be a preview kind' },
    label: { check: stringValue, message: 'label must be a string' },
    command: { check: stringValue, message: 'command must be a string' },
    cwd: { check: stringValue, message: 'cwd must be a string' },
    target: { check: stringValue, message: 'target must be a string' },
    agentId: { check: stringValue, message: 'agentId must be a string' },
  }),
  'preview.refresh': objectShape({ id: { check: stringValue, message: 'id must be a string' } }),
  'terminal.spawn': objectShape({
    command: { check: stringValue, message: 'command must be a string' },
    cols: { check: numberValue, message: 'cols must be a number' },
    rows: { check: numberValue, message: 'rows must be a number' },
  }),
  'terminal.stop': objectShape({ id: { required: true, check: stringValue, message: 'id must be a string' } }),
  'terminal.write': objectShape({
    id: { required: true, check: stringValue, message: 'id must be a string' },
    data: { required: true, check: stringValue, message: 'data must be a string' },
  }),
  'terminal.resize': objectShape({
    id: { required: true, check: stringValue, message: 'id must be a string' },
    cols: { required: true, check: numberValue, message: 'cols must be a number' },
    rows: { required: true, check: numberValue, message: 'rows must be a number' },
  }),
  'mcp.invoke': objectShape({
    server: { required: true, check: stringValue, message: 'server must be a string' },
    method: { required: true, check: stringValue, message: 'method must be a string' },
    args: { check: looseObject, message: 'args must be an object' },
    authRef: { check: stringValue, message: 'authRef must be a string' },
  }),
  'workspace.activePanel': emptyParams,
  'panel.list': emptyParams,
  'panel.open': objectShape({
    id: { required: true, check: stringValue, message: 'id must be a string' },
    area: { check: areaValue, message: 'area must be center, left, right, or bottom' },
  }),
  'panel.close': objectShape({ instanceId: { required: true, check: stringValue, message: 'instanceId must be a string' } }),
  'secrets.list': objectShape({ scope: { check: scopeValue, message: 'scope must be user or project' } }),
  'secrets.has': objectShape({
    id: { required: true, check: stringValue, message: 'id must be a string' },
    scope: { check: scopeValue, message: 'scope must be user or project' },
  }),
  'secrets.use': objectShape({
    id: { required: true, check: stringValue, message: 'id must be a string' },
    scope: { check: scopeValue, message: 'scope must be user or project' },
    request: { required: true, check: isSecretRequest, message: 'request must be a mediated secret request' },
  }),
  'secrets.set': objectShape({
    id: { required: true, check: stringValue, message: 'id must be a string' },
    value: { required: true, check: stringValue, message: 'value must be a string' },
    scope: { check: scopeValue, message: 'scope must be user or project' },
    service: { check: stringValue, message: 'service must be a string' },
  }),
  'secrets.delete': objectShape({
    id: { required: true, check: stringValue, message: 'id must be a string' },
    scope: { check: scopeValue, message: 'scope must be user or project' },
  }),
  'secrets.reveal': objectShape({
    id: { required: true, check: stringValue, message: 'id must be a string' },
    scope: { check: scopeValue, message: 'scope must be user or project' },
  }),
  'debug.start': objectShape({
    scenario: { required: true, check: isDebugScenario, message: 'scenario must include a title' },
    adapter: { check: stringValue, message: 'adapter must be a string' },
    config: { check: looseObject, message: 'config must be an object' },
    trust: { check: debugTrustValue, message: 'trust must be observe, evaluate, or off' },
  }),
  'debug.probe': objectShape({
    adapter: { check: stringValue, message: 'adapter must be a string' },
    config: { check: looseObject, message: 'config must be an object' },
  }),
  'debug.setBreakpoints': objectShape({
    file: { required: true, check: stringValue, message: 'file must be a string' },
    breakpoints: { required: true, check: isBreakpointSpecArray, message: 'breakpoints must be breakpoint specs' },
    setBy: { check: debugSetByValue, message: 'setBy must be agent or human' },
  }),
  'debug.addBreakpoint': objectShape({
    file: { required: true, check: stringValue, message: 'file must be a string' },
    line: { required: true, check: positiveInteger, message: 'line must be a positive integer' },
    condition: { check: stringValue, message: 'condition must be a string' },
    setBy: { check: debugSetByValue, message: 'setBy must be agent or human' },
  }),
  'debug.removeBreakpoint': objectShape({
    file: { required: true, check: stringValue, message: 'file must be a string' },
    line: { required: true, check: positiveInteger, message: 'line must be a positive integer' },
  }),
  'debug.continue': objectShape({ threadId: { check: integerValue, message: 'threadId must be an integer' } }),
  'debug.stepOver': objectShape({ threadId: { check: integerValue, message: 'threadId must be an integer' } }),
  'debug.stepIn': objectShape({ threadId: { check: integerValue, message: 'threadId must be an integer' } }),
  'debug.stepOut': objectShape({ threadId: { check: integerValue, message: 'threadId must be an integer' } }),
  'debug.pause': objectShape({ threadId: { check: integerValue, message: 'threadId must be an integer' } }),
  'debug.stackTrace': objectShape({ threadId: { check: integerValue, message: 'threadId must be an integer' } }),
  'debug.scopes': objectShape({ frameId: { required: true, check: integerValue, message: 'frameId must be an integer' } }),
  'debug.variables': objectShape({ variablesReference: { required: true, check: integerValue, message: 'variablesReference must be an integer' } }),
  'debug.evaluate': objectShape({
    expression: { required: true, check: stringValue, message: 'expression must be a string' },
    frameId: { check: integerValue, message: 'frameId must be an integer' },
  }),
  'debug.setTrust': objectShape({ trust: { required: true, check: debugTrustValue, message: 'trust must be observe, evaluate, or off' } }),
  'debug.roadblock': objectShape({ ask: { required: true, check: stringValue, message: 'ask must be a string' } }),
  'debug.roadblock.resolve': emptyParams,
  'debug.capture.screenshot': objectShape({ target: { check: stringValue, message: 'target must be a string' } }),
  'debug.capture.console': objectShape({ limit: { check: positiveInteger, message: 'limit must be a positive integer' } }),
  'debug.capture.dom': objectShape({ selector: { check: stringValue, message: 'selector must be a string' } }),
  'debug.capture.network': emptyParams,
  'debug.rootCause': objectShape({
    summary: { required: true, check: stringValue, message: 'summary must be a string' },
    file: { check: stringValue, message: 'file must be a string' },
    line: { check: integerValue, message: 'line must be an integer' },
  }),
  'debug.capabilities': emptyParams,
  'debug.navigate': objectShape({ url: { required: true, check: stringValue, message: 'url must be a string' } }),
  'debug.click': objectShape({ selector: { required: true, check: stringValue, message: 'selector must be a string' } }),
  'debug.fill': objectShape({
    selector: { required: true, check: stringValue, message: 'selector must be a string' },
    text: { required: true, check: stringValue, message: 'text must be a string' },
  }),
  'debug.login': objectShape({
    url: { check: stringValue, message: 'url must be a string' },
    usernameSelector: { required: true, check: stringValue, message: 'usernameSelector must be a string' },
    passwordSelector: { required: true, check: stringValue, message: 'passwordSelector must be a string' },
    usernameSecret: { required: true, check: stringValue, message: 'usernameSecret must be a string' },
    passwordSecret: { required: true, check: stringValue, message: 'passwordSecret must be a string' },
    submitSelector: { check: stringValue, message: 'submitSelector must be a string' },
    scope: { check: scopeValue, message: 'scope must be user or project' },
  }),
  'debug.sessions': emptyParams,
  'debug.select': objectShape({ id: { required: true, check: stringValue, message: 'id must be a string' } }),
  'debug.state': emptyParams,
  'debug.stop': emptyParams,
  'plugins.list': objectShape({ scope: { check: enumValue(['project', 'user', 'builtin']), message: 'scope must be project, user, or builtin' } }),
  'plugins.enable': objectShape({ id: { required: true, check: stringValue, message: 'id must be a string' } }),
  'plugins.disable': objectShape({ id: { required: true, check: stringValue, message: 'id must be a string' } }),
  'plugins.confirmInstall': objectShape({
    manifest: { check: (value) => validateSchema('manifest.schema.json', value).ok, message: 'manifest must be a panel manifest' },
    source: { check: looseObject, message: 'source must be an object' },
    scope: { check: scopeValue, message: 'scope must be user or project' },
    totalSizeBytes: { check: numberValue, message: 'totalSizeBytes must be a number' },
    files: { check: isFilesList, message: 'files must have path and sizeBytes' },
  }),
  'plugins.install': objectShape({
    plugin: { check: isPluginRefInput, message: 'plugin must include a string id' },
    manifest: { check: (value) => validateSchema('manifest.schema.json', value).ok, message: 'manifest must be a panel manifest' },
    source: { check: stringValue, message: 'source must be a string' },
    scope: { check: scopeValue, message: 'scope must be user or project' },
    entryUrl: { check: stringValue, message: 'entryUrl must be a string' },
  }),
  'plugins.confirmUninstall': objectShape({ id: { required: true, check: stringValue, message: 'id must be a string' } }),
  'plugins.uninstall': objectShape({ id: { required: true, check: stringValue, message: 'id must be a string' } }),
  'skills.list': emptyParams,
  'skills.read': objectShape({ id: { required: true, check: stringValue, message: 'id must be a string' } }),
  'skills.write': objectShape({
    id: { check: stringValue, message: 'id must be a string' },
    name: { check: stringValue, message: 'name must be a string' },
    summary: { check: stringValue, message: 'summary must be a string' },
    body: { check: stringValue, message: 'body must be a string' },
    skillsetId: { check: stringValue, message: 'skillsetId must be a string' },
    origin: { check: skillOriginValue, message: 'origin must be polypore, builtin, claude, or codex' },
    publishedTo: { check: (value) => stringArrayOf(value, agentValue), message: 'publishedTo must be claude/codex strings' },
  }),
  'skills.publish': objectShape({
    id: { required: true, check: stringValue, message: 'id must be a string' },
    agents: { required: true, check: (value) => stringArrayOf(value, agentValue), message: 'agents must be claude/codex strings' },
  }),
  'skills.delete': objectShape({ id: { required: true, check: stringValue, message: 'id must be a string' } }),
  'skills.invoke': objectShape({
    id: { required: true, check: stringValue, message: 'id must be a string' },
    args: { check: looseObject, message: 'args must be an object' },
    sessionId: { check: stringValue, message: 'sessionId must be a string' },
  }),
  'skillsets.list': emptyParams,
  'skillsets.read': objectShape({ id: { required: true, check: stringValue, message: 'id must be a string' } }),
  'skillsets.upsert': objectShape({
    id: { check: stringValue, message: 'id must be a string' },
    title: { required: true, check: stringValue, message: 'title must be a string' },
    version: { check: stringValue, message: 'version must be a string' },
    builtin: { check: booleanValue, message: 'builtin must be a boolean' },
    source: { check: stringValue, message: 'source must be a string' },
    summary: { check: stringValue, message: 'summary must be a string' },
    skills: { check: stringArray, message: 'skills must be strings' },
  }),
  'skillsets.delete': objectShape({ id: { required: true, check: stringValue, message: 'id must be a string' } }),
  'mcp.servers.list': objectShape({ scope: { check: mcpScopeValue, message: 'scope must be project, user, or polypore' } }),
  'mcp.servers.upsert': objectShape({
    id: { check: stringValue, message: 'id must be a string' },
    name: { required: true, check: stringValue, message: 'name must be a string' },
    url: { required: true, check: stringValue, message: 'url must be a string' },
    scope: { check: mcpScopeValue, message: 'scope must be project, user, or polypore' },
    headers: { check: recordOfString, message: 'headers must be a string map' },
    authRef: { check: stringValue, message: 'authRef must be a string' },
    allowInsecure: { check: booleanValue, message: 'allowInsecure must be a boolean' },
    timeoutMs: { check: numberValue, message: 'timeoutMs must be a number' },
    lastTest: { check: isMcpLastTest, message: 'lastTest must be a probe result' },
  }),
  'mcp.servers.delete': objectShape({ id: { required: true, check: stringValue, message: 'id must be a string' } }),
  'mcp.servers.test': objectShape({ id: { required: true, check: stringValue, message: 'id must be a string' } }),
  'mcp.discover': emptyParams,
  'mcp.install': objectShape({
    name: { required: true, check: stringValue, message: 'name must be a string' },
    transport: { required: true, check: stringValue, message: 'transport must be a string' },
    command: { check: stringValue, message: 'command must be a string' },
    args: { check: stringArray, message: 'args must be strings' },
    env: { check: recordOfString, message: 'env must be a string map' },
    url: { check: stringValue, message: 'url must be a string' },
    headers: { check: recordOfString, message: 'headers must be a string map' },
    agents: { required: true, check: stringArray, message: 'agents must be strings' },
  }),
  'formation.upsert': objectShape({
    nodes: { required: true, check: objectArray, message: 'nodes must be objects' },
    edges: { required: true, check: objectArray, message: 'edges must be objects' },
  }),
  'plugins.toggle': objectShape({ id: { required: true, check: stringValue, message: 'id must be a string' } }),

  /* fs */
  'fs.write': objectShape({
    path: { required: true, check: stringValue, message: 'path must be a string' },
    content: { required: true, check: stringValue, message: 'content must be a string' },
  }),
  'fs.delete': objectShape({ path: { required: true, check: stringValue, message: 'path must be a string' } }),
  'fs.rename': objectShape({
    from: { required: true, check: stringValue, message: 'from must be a string' },
    to: { required: true, check: stringValue, message: 'to must be a string' },
  }),
  'fs.mkdir': objectShape({ path: { required: true, check: stringValue, message: 'path must be a string' } }),
  'fs.exists': objectShape({ path: { required: true, check: stringValue, message: 'path must be a string' } }),
  'fs.stat': objectShape({ path: { required: true, check: stringValue, message: 'path must be a string' } }),

  /* terminal extensions */
  'terminal.list': emptyParams,
  'terminal.read': objectShape({ id: { required: true, check: stringValue, message: 'id must be a string' } }),

  /* editor extensions */
  'editor.setDecorations': objectShape({
    path: { required: true, check: stringValue, message: 'path must be a string' },
    decorations: { required: true, check: isDecorationArray, message: 'decorations must be decoration objects' },
    pluginId: { check: stringValue, message: 'pluginId must be a string' },
  }),
  'editor.cursor': objectShape({ path: { required: true, check: stringValue, message: 'path must be a string' } }),
  'editor.selection': objectShape({ path: { required: true, check: stringValue, message: 'path must be a string' } }),
  'editor.revealLine': objectShape({
    path: { required: true, check: stringValue, message: 'path must be a string' },
    line: { required: true, check: integerValue, message: 'line must be an integer' },
  }),
  'editor.language': objectShape({ path: { required: true, check: stringValue, message: 'path must be a string' } }),

  /* ui extensions */
  'ui.statusBar.add': objectShape({
    text: { required: true, check: stringValue, message: 'text must be a string' },
    tooltip: { check: stringValue, message: 'tooltip must be a string' },
    pluginId: { check: stringValue, message: 'pluginId must be a string' },
  }),
  'ui.statusBar.update': objectShape({
    id: { required: true, check: stringValue, message: 'id must be a string' },
    text: { check: stringValue, message: 'text must be a string' },
    tooltip: { check: stringValue, message: 'tooltip must be a string' },
  }),
  'ui.statusBar.remove': objectShape({ id: { required: true, check: stringValue, message: 'id must be a string' } }),
  'ui.panel.setTitle': objectShape({
    instanceId: { required: true, check: stringValue, message: 'instanceId must be a string' },
    title: { required: true, check: stringValue, message: 'title must be a string' },
  }),
  'ui.panel.setBadge': objectShape({
    instanceId: { required: true, check: stringValue, message: 'instanceId must be a string' },
    count: { required: true, check: (v) => v === null || numberValue(v), message: 'count must be a number or null' },
  }),
  'ui.panel.focus': objectShape({ instanceId: { required: true, check: stringValue, message: 'instanceId must be a string' } }),
  'ui.inputBox': objectShape({
    prompt: { required: true, check: stringValue, message: 'prompt must be a string' },
    placeholder: { check: stringValue, message: 'placeholder must be a string' },
    value: { check: stringValue, message: 'value must be a string' },
  }),
  'ui.quickPick': objectShape({
    items: { required: true, check: isQuickPickItems, message: 'items must be quick pick item objects' },
  }),

  /* storage */
  'storage.get': objectShape({
    pluginId: { required: true, check: stringValue, message: 'pluginId must be a string' },
    key: { required: true, check: stringValue, message: 'key must be a string' },
  }),
  'storage.set': objectShape({
    pluginId: { required: true, check: stringValue, message: 'pluginId must be a string' },
    key: { required: true, check: stringValue, message: 'key must be a string' },
    value: { required: true, check: optionalAny, message: 'value may be any json value' },
  }),
  'storage.delete': objectShape({
    pluginId: { required: true, check: stringValue, message: 'pluginId must be a string' },
    key: { required: true, check: stringValue, message: 'key must be a string' },
  }),
  'storage.list': objectShape({ pluginId: { required: true, check: stringValue, message: 'pluginId must be a string' } }),

  /* git */
  'git.status': emptyParams,
  'git.log': objectShape({
    limit: { check: numberValue, message: 'limit must be a number' },
    file: { check: stringValue, message: 'file must be a string' },
  }),
  'git.blame': objectShape({ path: { required: true, check: stringValue, message: 'path must be a string' } }),
  'git.branches': emptyParams,
  'git.stash': emptyParams,
  'git.unstash': emptyParams,

  /* bus */
  'bus.publish': objectShape({
    topic: { required: true, check: stringValue, message: 'topic must be a string' },
    payload: { check: optionalAny, message: 'payload may be any json value' },
  }, { allowUnknown: false }),

  /* chat extensions */
  'chat.interrupt': objectShape({ sessionId: { required: true, check: stringValue, message: 'sessionId must be a string' } }),
  'chat.context.list': objectShape({ sessionId: { required: true, check: stringValue, message: 'sessionId must be a string' } }),
  'chat.context.add': objectShape({
    sessionId: { required: true, check: stringValue, message: 'sessionId must be a string' },
    path: { required: true, check: stringValue, message: 'path must be a string' },
  }),
  'chat.context.remove': objectShape({
    sessionId: { required: true, check: stringValue, message: 'sessionId must be a string' },
    path: { required: true, check: stringValue, message: 'path must be a string' },
  }),

  /* http */
  'http.fetch': objectShape({
    url: { required: true, check: stringValue, message: 'url must be a string' },
    method: { check: stringValue, message: 'method must be a string' },
    headers: { check: recordOfString, message: 'headers must be a string map' },
    body: { check: stringValue, message: 'body must be a string' },
    timeoutMs: { check: numberValue, message: 'timeoutMs must be a number' },
  }),

  /* clipboard */
  'clipboard.read': emptyParams,
  'clipboard.write': objectShape({ text: { required: true, check: stringValue, message: 'text must be a string' } }),
};

export function hostRpcValidatedMethods(): Set<string> {
  return new Set(Object.keys(RPC_PARAM_VALIDATORS));
}

function validateMethodParams(method: string, params: unknown): ValidationResult {
  const validator = RPC_PARAM_VALIDATORS[method];
  if (!validator) return okValidation;
  return validator(params);
}

/* ─── debug suite helpers ──────────────────────────────────────────────── */
function emptyDebugState(): DebugState {
  return {
    session: null,
    sessions: [],
    timeline: [],
    roadblock: null,
    status: 'idle',
    stop: null,
    breakpoints: [],
    rootCause: null,
    capabilities: { webAutoNav: false },
  };
}

export function debugErrMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function resolveDebugAdapter(adapter: string | undefined, config: Record<string, unknown>): string {
  const explicit = typeof adapter === 'string' ? adapter.trim() : '';
  if (explicit) return explicit;
  if (typeof config.adapterCommand === 'string' && config.adapterCommand.trim()) return 'custom';
  const type = typeof config.type === 'string' ? config.type.trim().toLowerCase() : '';
  const configAdapter = typeof config.adapter === 'string' ? config.adapter.trim().toLowerCase() : '';
  const requested = type || configAdapter;
  if (['vscode-js-debug', 'node', 'pwa-node', 'pwa-chrome', 'javascript', 'typescript'].includes(requested)) {
    return 'vscode-js-debug';
  }
  if (['python', 'debugpy'].includes(requested)) return 'debugpy';
  if (['go', 'delve', 'dlv'].includes(requested)) return 'delve';
  if (['lldb', 'lldb-dap', 'codelldb', 'cppdbg', 'cppvsdbg', 'c', 'cpp', 'c++', 'rust'].includes(requested)) {
    return 'lldb-dap';
  }
  throw invalidParamsError(
    'debug adapter is required unless config.type identifies a known DAP adapter or config.adapterCommand points to a DAP server',
  );
}

/* State summarization (spec §7) — raw DAP dumps blow the context window, so
   every variables payload is capped and truncations carry a drillable ref.
   The agent PULLS detail via a follow-up debug.variables; it is never PUSHED
   the heap. */
const DEBUG_OBJECT_CHILD_CAP = 50;
const DEBUG_COLLECTION_CAP = 20;
const DEBUG_STRING_BYTE_CAP = 2048;

export type SummarizedVariable = {
  name: string;
  value: string;
  type?: string;
  valueTruncated?: boolean;
  /* drill handle — present when this node has children the agent can expand. */
  ref?: number;
  more?: boolean;
};

export function truncateDebugString(value: string): { value: string; truncated: boolean } {
  if (value.length <= DEBUG_STRING_BYTE_CAP) return { value, truncated: false };
  return { value: `${value.slice(0, DEBUG_STRING_BYTE_CAP)}…`, truncated: true };
}

function summarizeVariable(variable: DapVariable): SummarizedVariable {
  const { value, truncated } = truncateDebugString(variable.value ?? '');
  const out: SummarizedVariable = { name: variable.name, value, type: variable.type };
  if (truncated) out.valueTruncated = true;
  if (variable.variablesReference && variable.variablesReference > 0) {
    out.ref = variable.variablesReference;
    out.more = true;
  }
  return out;
}

export function summarizeVariables(variables: DapVariable[]): {
  variables: SummarizedVariable[];
  total: number;
  truncated: boolean;
} {
  const total = variables.length;
  const looksLikeCollection = total > 0 && variables.every((v) => /^\d+$/.test(v.name) || v.name.startsWith('['));
  const cap = looksLikeCollection ? DEBUG_COLLECTION_CAP : DEBUG_OBJECT_CHILD_CAP;
  const sliced = variables.slice(0, cap);
  return {
    variables: sliced.map(summarizeVariable),
    total,
    truncated: total > cap,
  };
}

export function memoryKnowledgeBase(): KnowledgeBaseRef {
  return {
    id: 'memory',
    name: 'browser documents',
    root: 'memory://documents',
    scope: 'project',
    suggestedScope: 'project',
  };
}

export function browserDirectoryPicker(): null | (() => Promise<BrowserDirectoryHandle | null>) {
  const picker = (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  return typeof picker === 'function'
    ? () => (picker as () => Promise<BrowserDirectoryHandle | null>)()
    : null;
}

export function browserKnowledgeBase(handle: BrowserDirectoryHandle): KnowledgeBaseRef {
  return {
    id: `browser-${fileSlug(handle.name)}`,
    name: handle.name || 'browser documents',
    root: `browser://${handle.name || 'documents'}`,
    scope: 'project',
    suggestedScope: 'project',
  };
}

export async function listBrowserKnowledge(
  handle: BrowserDirectoryHandle,
  prefix = '',
): Promise<Array<{ kind: 'doc' | 'folder'; path: string }>> {
  if (typeof handle.entries !== 'function') return [];
  const nodes: Array<{ kind: 'doc' | 'folder'; path: string }> = [];
  for await (const [name, child] of handle.entries()) {
    if (ignoredDocumentName(name)) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (child.kind === 'directory') {
      nodes.push({ kind: 'folder', path });
      nodes.push(...await listBrowserKnowledge(child, path));
      continue;
    }
    if (child.kind === 'file' && looksTextualDocument(path)) {
      nodes.push({ kind: 'doc', path });
    }
  }
  return nodes.sort((left, right) => left.path.localeCompare(right.path));
}

export async function readBrowserKnowledge(root: BrowserDirectoryHandle, path: string) {
  const fileHandle = await browserFileHandle(root, path, false);
  const file = await fileHandle.getFile?.();
  if (!file) throw new Error(`browser document cannot be read: ${path}`);
  return file.text();
}

export async function writeBrowserKnowledge(root: BrowserDirectoryHandle, path: string, content: string) {
  const fileHandle = await browserFileHandle(root, path, true);
  const writable = await fileHandle.createWritable?.();
  if (!writable) throw new Error(`browser document cannot be written: ${path}`);
  await writable.write(content);
  await writable.close();
}

async function browserFileHandle(
  root: BrowserDirectoryHandle,
  rawPath: string,
  create: boolean,
): Promise<BrowserFileHandle> {
  const parts = safeDocumentPathParts(rawPath);
  const fileName = parts.pop();
  if (!fileName) throw new Error('document path is required');
  let dir = root;
  for (const part of parts) {
    if (!dir.getDirectoryHandle) throw new Error(`browser folder cannot be opened: ${part}`);
    dir = await dir.getDirectoryHandle(part, { create });
  }
  if (!dir.getFileHandle) throw new Error(`browser document cannot be opened: ${rawPath}`);
  return dir.getFileHandle(fileName, { create });
}

function safeDocumentPathParts(path: string) {
  const parts = path.split('/').filter(Boolean);
  if (
    parts.length === 0
    || path.includes('\0')
    || parts.some((part) => part === '.' || part === '..')
  ) {
    throw new Error('document path must stay inside its base');
  }
  return parts;
}

function ignoredDocumentName(name: string) {
  return name === '.git' || name === 'node_modules' || name === '.DS_Store';
}

function looksTextualDocument(path: string) {
  return !/\.(bmp|gif|ico|jpe?g|lock|pdf|png|rmeta|rlib|so|sqlite|webp|zip)$/i.test(path);
}

export function fileSlug(raw: string) {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'documents';
}

export function seedMemoryKnowledgePreset(
  store: Map<string, string>,
  name: string,
  preset: KnowledgeBasePreset,
  folderOverride?: string[],
) {
  const title = name || 'memory';
  const presetDefaults: Record<KnowledgeBasePreset, { readme?: string; agentNote?: string; folders: string[] }> = {
    basic: {
      readme: `# ${title}\n\nMemory base.\n`,
      agentNote: '# Wiki workflow\n\nKeep raw source material in `raw/` — never edit those. Maintain durable notes in `wiki/` and link claims back to sources.\n',
      folders: ['raw', 'wiki'],
    },
    blank: { folders: [] },
  };
  const defaults = presetDefaults[preset];
  const folders = folderOverride ?? defaults.folders;
  const files: Record<string, string> = {};
  if (defaults.readme) files['README.md'] = defaults.readme;
  if (defaults.agentNote) files['CLAUDE.md'] = defaults.agentNote;
  if (folders.length === 0) {
    files['index.md'] = `# ${title}\n\n`;
  } else {
    for (const folder of folders) {
      const cleaned = folder.replace(/^\/+|\/+$/g, '').trim();
      if (!cleaned) continue;
      const heading = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
      files[`${cleaned}/index.md`] = `# ${heading}\n\n`;
    }
  }
  for (const [path, content] of Object.entries(files)) {
    store.set(path, content);
  }
}

function inferAgentFromSession(sessionId: string) {
  if (sessionId.startsWith('claude')) return 'claude';
  if (sessionId.startsWith('codex')) return 'codex';
  return 'codex';
}

function dedupeHostDiagnostics(diagnostics: Diagnostic[]) {
  const seen = new Set<string>();
  return diagnostics.filter((item) => {
    const key = [
      item.file,
      item.range.start.line,
      item.range.start.column,
      item.range.end.line,
      item.range.end.column,
      item.message,
      item.source,
    ].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeConfirmDecision(decision: ConfirmDecision, fallbackScope?: 'project' | 'user') {
  if (typeof decision === 'boolean') return { confirmed: decision, scope: fallbackScope };
  return { confirmed: decision.confirmed, scope: decision.scope ?? fallbackScope };
}

function applyTextEdits(content: string, edits: unknown[]) {
  if (edits.length === 0) return content;
  const fullReplacement = fullReplacementText(edits);
  if (fullReplacement !== null) return fullReplacement;

  const patches = edits.map((edit) => {
    const candidate = edit as {
      range?: { start?: { line?: number; column?: number }; end?: { line?: number; column?: number } };
      newText?: string;
    };
    if (typeof candidate.newText !== 'string' || !candidate.range?.start || !candidate.range?.end) {
      throw new Error('editor.applyEdit edits must include range and newText');
    }
    return {
      start: offsetForPosition(content, candidate.range.start.line ?? 0, candidate.range.start.column ?? 0),
      end: offsetForPosition(content, candidate.range.end.line ?? 0, candidate.range.end.column ?? 0),
      newText: candidate.newText,
    };
  }).sort((a, b) => b.start - a.start);

  let next = content;
  for (const patch of patches) {
    if (patch.start > patch.end) throw new Error('editor.applyEdit range start must be before end');
    next = `${next.slice(0, patch.start)}${patch.newText}${next.slice(patch.end)}`;
  }
  return next;
}

function fullReplacementText(edits: unknown[]) {
  if (edits.length !== 1) return null;
  const edit = edits[0] as { replacement?: string; text?: string; newText?: string; range?: unknown };
  if (typeof edit.replacement === 'string') return edit.replacement;
  if (typeof edit.text === 'string') return edit.text;
  if (typeof edit.newText === 'string' && !edit.range) return edit.newText;
  return null;
}

function offsetForPosition(content: string, line: number, column: number) {
  const safeLine = Math.max(0, line);
  const safeColumn = Math.max(0, column);
  let offset = 0;
  let currentLine = 0;
  while (currentLine < safeLine && offset < content.length) {
    const nextBreak = content.indexOf('\n', offset);
    if (nextBreak === -1) return content.length;
    offset = nextBreak + 1;
    currentLine += 1;
  }
  const lineEnd = content.indexOf('\n', offset);
  return Math.min(offset + safeColumn, lineEnd === -1 ? content.length : lineEnd);
}

export function summarizeSkillBody(body?: string) {
  const line = body
    ?.split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('#'));
  return line?.slice(0, 120);
}

function safeRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function isDecorationArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const validStyles = new Set(['error', 'warning', 'info', 'highlight']);
  return value.every((item) => objectShape({
    range: { required: true, check: isRange, message: 'range must be a text range' },
    style: { required: true, check: (v) => typeof v === 'string' && validStyles.has(v), message: 'style must be error, warning, info, or highlight' },
    message: { check: stringValue, message: 'message must be a string' },
  })(item).ok);
}

function isQuickPickItems(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((item) => objectShape({
    label: { required: true, check: stringValue, message: 'label must be a string' },
    description: { check: stringValue, message: 'description must be a string' },
    value: { required: true, check: optionalAny, message: 'value may be any json value' },
  })(item).ok);
}

function languageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
    mjs: 'javascript', cjs: 'javascript', mts: 'typescript', cts: 'typescript',
    py: 'python', rs: 'rust', go: 'golang', java: 'java', cs: 'csharp',
    rb: 'ruby', php: 'php', html: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
    json: 'json', jsonc: 'jsonc', yaml: 'yaml', yml: 'yaml', toml: 'toml', md: 'markdown',
    sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', fish: 'fish',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cc: 'cpp',
    sql: 'sql', graphql: 'graphql', gql: 'graphql', xml: 'xml', svg: 'xml',
    swift: 'swift', kt: 'kotlin', dart: 'dart', lua: 'lua', vim: 'viml',
    ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', ml: 'ocaml',
    r: 'r', jl: 'julia', scala: 'scala', clj: 'clojure', tf: 'terraform',
    dockerfile: 'dockerfile', makefile: 'makefile',
  };
  return map[ext] ?? (ext ? ext : 'plaintext');
}

export function knowledgeDocName(title: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48) || 'note';
  return `${date}-${slug}`;
}

export function renderHandoffDoc(summary: string, nextSteps: string[], context: string[]): string {
  const lines = [`# Handoff: ${summary}`, ''];
  if (context.length) {
    lines.push('## Context', ...context.map((item) => `- ${item}`), '');
  }
  if (nextSteps.length) {
    lines.push('## Next steps', ...nextSteps.map((item) => `- [ ] ${item}`), '');
  }
  return `${lines.join('\n')}\n`;
}
