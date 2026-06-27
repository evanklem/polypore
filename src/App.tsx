import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Launcher, PolyporeLoadingScreen, type LaunchTarget } from './Launcher';
import {
  HostConfirmOverlay,
  HostInputBoxOverlay,
  type GlobalSettingsServices,
} from './components/overlays';
import { SettingsSurface, type SettingsSection } from './settings/SettingsSurface';
import type { ProjectSettingsGroup } from './settings/tabs/ProjectTab';
import { ManualSurface } from './manual/ManualSurface';
import { loadManualCorpus } from './manual/loadManualCorpus';
import type { ManualCorpus } from './manual/manualCorpus';
import type { PanelCatalogItem, PanelManual } from './components/overlays/panelCatalog';
import { TopBar } from './components/topbar';
import { BottomBar } from './components/BottomBar';
import './styles/tokens.css';
import './styles/app.css';
import './glass.css';
import { AgentId, PanelType, UserWorkspacePreset, WorkspaceName } from './core/types';
import type {
  AgentBinaryStatus,
  GitRunResult,
  NativeSecretRef,
  ProjectStatusResult,
  RecentProject,
} from './core/tauri-types';
import {
  deleteUserPreset,
  getWorkspacePreset,
  loadActiveWorkspace,
  loadUserPresets,
  restoreWorkspacePresetLayout,
  saveActiveWorkspace,
  saveUserPreset,
  saveWorkspaceLayout,
  workspaceLayoutStorageKey,
} from './workspaces/presets';
import { HostRpcServer, PluginLoader, buildPluginSrcdoc, createLocalStorageSecretStore, createMemorySecretStore, createMetadataSecretStore, parseDotEnv } from '../packages/host/src';
import type { ConfirmDecision, ConfirmRequest, HostStoreInitialState, SecretStore } from '../packages/host/src';
import type { FileTreeNode, DapFrame, DapScope, DapVariable, DebugStop, EditorSearchMatch, SkillPublisher } from '../packages/host/src';
import type { Diagnostic, HistoryEvent, PanelManifest, PluginRef, Task, VerifyRun } from '../packages/sdk/src';
import type { SnapshotRecord } from '../packages/sdk/src/host';
import { createLoopbackHost, type KnowledgeBase, type KnowledgeBasePreset, type KnowledgeBaseScope, type PolyporeHost } from '../packages/sdk/src/host';
import sdkRuntimeSource from '../packages/sdk/src/client-runtime.js?raw';
import type { BuiltinPlugin, PanelContextDoc } from '../plugins/shared';
import { deliverPromptToTarget, openChatPanelTargets, pluginPrefetch, perfPoint } from '../plugins/shared';
import { dockviewApi } from './core/polypore-window';

const PolyporeDockview = React.lazy(() =>
  import('./PolyporeDockview').then((mod) => ({ default: mod.PolyporeDockview })),
);

/* every panel registered with the host is discovered at build time from the
   `plugins/<id>/index.ts` files. drop a folder under plugins/, export a
   default BuiltinPlugin (or array), and it shows up — App.tsx never names
   a specific plugin again. */
const PLUGIN_MODULES = import.meta.glob<{ default: BuiltinPlugin | BuiltinPlugin[] }>(
  '../plugins/*/index.ts',
  { eager: true },
);
const ALL_PLUGINS: BuiltinPlugin[] = Object.values(PLUGIN_MODULES).flatMap((mod) => {
  const value = mod.default;
  return Array.isArray(value) ? value : value ? [value] : [];
});
const PLUGINS_BY_SLOT = new Map(ALL_PLUGINS.map((plugin) => [plugin.slot, plugin]));

/* bundled skillsets are discovered the same way as plugins. each packages/<name>/
   that has a skillset.json + skill-named subdirectories ships as a builtin
   skillset, so polyflow is always available without an install step. */
const SKILLSET_MANIFESTS = import.meta.glob<{ default: { id: string; title: string; version: string; builtin?: boolean; source?: string; summary?: string; skills: string[] } }>(
  '../packages/*/skillset.json',
  { eager: true },
);
/* the `?raw` query MUST be passed via the `query` option — an inline
   `...SKILL.md?raw` pattern silently matches zero files in this Vite version,
   which left every bundled skill body empty and every skill editor blank. */
const SKILLSET_BODIES = import.meta.glob<string>('../packages/*/*/SKILL.md', { eager: true, query: '?raw', import: 'default' });
function buildBundledSkillsets() {
  const skillsets: Array<{ id: string; title: string; version: string; builtin: boolean; source: string; summary?: string; skills: string[] }> = [];
  const skills: Array<{ id: string; name: string; summary: string; body: string; skillsetId: string; origin: 'builtin' }> = [];
  for (const [manifestPath, mod] of Object.entries(SKILLSET_MANIFESTS)) {
    const manifest = mod.default;
    const skillsetId = manifest.id;
    /* extract the package dir name from the manifest path (../packages/<dir>/skillset.json) */
    const pkgDir = manifestPath.split('/').slice(0, -1).join('/');
    skillsets.push({
      id: skillsetId,
      title: manifest.title,
      version: manifest.version,
      builtin: manifest.builtin ?? true,
      source: manifest.source ?? 'bundled',
      summary: manifest.summary,
      skills: manifest.skills,
    });
    for (const skillId of manifest.skills) {
      const body = SKILLSET_BODIES[`${pkgDir}/${skillId}/SKILL.md`];
      if (typeof body !== 'string') continue;
      const summary = (body.match(/^description:\s*(.+)$/m)?.[1] ?? '').trim().slice(0, 200);
      skills.push({
        id: skillId,
        name: skillId,
        summary,
        body,
        skillsetId,
        origin: 'builtin',
      });
    }
  }
  return { skillsets, skills };
}
const BUNDLED = buildBundledSkillsets();

type TauriCore = {
  invoke?: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
};

type TauriEventApi = {
  listen?: <T = unknown>(
    event: string,
    handler: (event: { payload: T }) => void,
  ) => Promise<() => void>;
};

type AgentRuntimeStatus = {
  agent: string;
  adapter: string;
  available: boolean;
};

type AgentSlashEntry = {
  command: string;
  title: string;
  detail: string;
  source: 'agent' | 'skill' | 'polypore';
  agent?: string;
};

type AgentSlashCatalog = {
  agent: string;
  commands: AgentSlashEntry[];
};

type AgentSendResult = {
  agent: string;
  adapter: string;
  sessionId: string;
  responseText: string;
  events: Array<
    | { kind: 'message'; text: string }
    | { kind: 'tool-call'; toolName: string; summary: string }
    | { kind: 'permission'; summary: string }
  >;
};

type ExternalOpenResult = boolean;

type AgentRuntimeEventPayload = {
  agent: string;
  adapter: string;
  sessionId: string;
  event:
    | { kind: 'message'; text: string }
    | { kind: 'tool-call'; toolName: string; summary: string }
    | { kind: 'permission'; summary: string };
};

type AgentControlResult = {
  agent: string;
  adapter: string;
  sessionId: string;
  interrupted: boolean;
  message: string;
};

type PersistedRow = {
  stored: boolean;
  id: string;
};

type PtySessionResult = {
  id: string;
  command: string;
  status: string;
  output: string;
  pid?: number | null;
  exitCode?: number | null;
};

type PtyEventPayload = {
  id: string;
  command: string;
  kind: string;
  data?: string | null;
  exitCode?: number | null;
};

type KnowledgeNodeResult = Array<{ kind: 'doc' | 'folder'; path: string }>;
type KnowledgeBaseInput = { name: string; scope: KnowledgeBaseScope; preset: KnowledgeBasePreset; root?: string };

type DiagnosticsCollectResult = {
  diagnostics: Diagnostic[];
};

type LspDiagnosticsResult = {
  servers: Array<{ id: string; command: string; available: boolean; detail: string }>;
  diagnostics: Diagnostic[];
};

type LspStatusResult = {
  servers: Array<{ id: string; available: boolean }>;
};

type UpdaterStatusResult = {
  configured: boolean;
  endpoint?: string | null;
  availableVersion?: string | null;
  currentVersion: string;
  status: string;
};

type GitDiffShellResult = {
  mode: string;
  file?: string | null;
  baseRef?: string | null;
  targetRef?: string | null;
  changedFiles: string[];
  diff: string;
  exitCode?: number | null;
};

type GitWorktreeShellResult = {
  id: string;
  path: string;
  branch: string;
  forkedFromEventId: string;
  output: string;
  exitCode?: number | null;
};

type GitRevertShellResult = {
  files: string[];
  output: string;
  exitCode?: number | null;
};

/* mirrors WorktreeInfo in src-tauri/src/project.rs (serde camelCase). */
type WorktreeListShellResult = {
  id: string;
  path: string;
  branch?: string | null;
  head?: string | null;
  isCurrent?: boolean;
  isLocked?: boolean;
  isDetached?: boolean;
};

type SecretUseResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

type IterateRunShellResult = {
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

type McpHostRpcEvent = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

const MCP_HOST_RPC_ALLOWED_METHODS = new Set([
  'state.get',
  'workspace.describe',
  'editor.open',
  'editor.read',
  'editor.search',
  'tasks.add',
  'tasks.list',
  'tasks.update',
  'diagnostics.list',
  'verify.run',
  'verify.runs',
  'knowledge.bases',
  'knowledge.list',
  'knowledge.read',
  'knowledge.write',
  'knowledge.link',
  'knowledge.handoff',
  'adr.record',
  'phase.report',
  'workflow.update',
  'panel.open',
  'panel.close',
  'ui.notify',
  'preview.register',
  'preview.refresh',
  'history.events',
  'history.fork',
  'plugins.list',
  'plugins.enable',
  'plugins.disable',
  'plugins.confirmInstall',
  'plugins.install',
  'plugins.confirmUninstall',
  'plugins.uninstall',
  'skills.list',
  'skills.read',
  'skills.write',
  'skills.invoke',
  'skills.delete',
  'skillsets.list',
  'skillsets.read',
  'skillsets.upsert',
  'skillsets.delete',
  'skills.publish',
  'mcp.servers.list',
  'mcp.servers.upsert',
  'mcp.servers.delete',
  'mcp.servers.test',
  'formation.upsert',
  'debug.probe',
  'debug.start',
  'debug.setBreakpoints',
  'debug.addBreakpoint',
  'debug.removeBreakpoint',
  'debug.continue',
  'debug.stepOver',
  'debug.stepIn',
  'debug.stepOut',
  'debug.pause',
  'debug.stackTrace',
  'debug.scopes',
  'debug.variables',
  'debug.evaluate',
  'debug.capture.screenshot',
  'debug.capture.console',
  'debug.capture.dom',
  'debug.capture.network',
  'debug.roadblock',
  'debug.roadblock.resolve',
  'debug.rootCause',
  'debug.sessions',
  'debug.select',
  'debug.state',
  'debug.stop',
  'debug.capabilities',
  'debug.navigate',
  'debug.click',
  'debug.fill',
  'debug.login',
]);

/* monotonic id source for host-internal rpc envelopes — Date.now() collides
   when two requests land in the same millisecond. */
let hostRpcSeq = 0;
function nextHostRpcId() {
  hostRpcSeq += 1;
  return hostRpcSeq;
}

function tauriInvoke<T>(command: string, args?: Record<string, unknown>) {
  const core = (window as Window & { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core;
  if (!core?.invoke) return null;
  return core.invoke<T>(command, args);
}

function hasTauriInvoke() {
  return Boolean((window as Window & { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core?.invoke);
}

/* shared shape for the blocking continue/step* debug commands. */
async function debugStop(command: string, sessionId: string, threadId?: number) {
  const call = tauriInvoke<{ stop: DebugStop | null; terminated: boolean }>(command, { input: { sessionId, threadId } });
  if (!call) throw new Error('debug is unavailable in browser preview');
  const result = await call;
  return { stop: result.stop, terminated: result.terminated };
}

function tauriListen<T>(event: string, handler: (payload: T) => void) {
  const events = (window as Window & { __TAURI__?: { event?: TauriEventApi } }).__TAURI__?.event;
  if (!events?.listen) return null;
  return events.listen<T>(event, (message) => handler(message.payload));
}

function mergeDiagnostics(diagnostics: Diagnostic[]) {
  const seen = new Set<string>();
  return diagnostics.filter((item) => {
    const key = [
      item.file,
      item.range.start.line,
      item.range.start.column,
      item.range.end.line,
      item.range.end.column,
      item.message,
    ].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function secretHandle(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'secret';
}

const PANEL_META: Record<PanelType, { icon: string; label: string }> = Object.fromEntries(
  ALL_PLUGINS.map((plugin) => [plugin.slot, plugin.meta]),
);

function panelMeta(slot: PanelType): { icon: string; label: string } {
  return PANEL_META[slot] ?? { icon: '?', label: slot };
}

const AGENT_META: Record<AgentId, { icon: string; label: string }> = {
  claude: { icon: 'cl', label: 'claude' },
  codex: { icon: 'cd', label: 'codex' },
};

type AddableItem =
  | { kind: 'agent'; agent: AgentId; label: string; icon: string }
  | { kind: 'panel'; panelType: PanelType; label: string; icon: string };

const ADDABLE: AddableItem[] = [
  { kind: 'agent', agent: 'codex', label: AGENT_META.codex.label, icon: AGENT_META.codex.icon },
  { kind: 'agent', agent: 'claude', label: AGENT_META.claude.label, icon: AGENT_META.claude.icon },
  /* every plugin that opts into the default tab strip becomes an "addable"
     item. chat is the always-mounted left pane so it's excluded. */
  ...ALL_PLUGINS
    .filter((plugin) => plugin.slot !== 'chat' && plugin.inDefaultStrip !== false)
    .map<AddableItem>((plugin) => ({
      kind: 'panel',
      panelType: plugin.slot,
      label: plugin.meta.label,
      icon: plugin.meta.icon,
    })),
];

type StageTab = { id: string; panelType: PanelType };

/* default tab strip is every plugin that opts in, sorted by defaultOrder.
   chat is always-mounted in the left pane and excluded here. */
const DEFAULT_TABS: StageTab[] = [...ALL_PLUGINS]
  .filter((plugin) => plugin.slot !== 'chat' && plugin.inDefaultStrip !== false)
  .sort((a, b) => (a.defaultOrder ?? 999) - (b.defaultOrder ?? 999))
  .map((plugin) => ({ id: `t-${plugin.slot}`, panelType: plugin.slot }));

const DEFAULT_WORKSPACE: WorkspaceName = 'Default';
const DEFAULT_CONTEXT_USED_PCT = 0;
const DEFAULT_BRANCH = 'none';

type ChatSession = {
  id: string;
  agent: AgentId;
  title: string;
  messages: Array<{ by: 'user' | 'agent'; text: string }>;
  draft: string;
};

/* everything App needs from the host layer, built by createAppHost(). */
export type AppHostBundle = {
  hostServer: HostRpcServer;
  pluginLoader: PluginLoader;
  secretStore: SecretStore;
  host: PolyporeHost;
  settingsServices: GlobalSettingsServices;
};

function createAppHostInitialState(): HostStoreInitialState {
  return {
    state: {
      activeAgent: 'codex',
      permissionMode: 'default',
      workspace: DEFAULT_WORKSPACE,
      contextUsedPct: DEFAULT_CONTEXT_USED_PCT,
    },
    /* every discovered built-in plugin is registered with the host. once the
       real plugin install pipeline lands, third-party plugins join this list
       via .polypore/plugins/<id>/ and the install confirmation modal. */
    plugins: ALL_PLUGINS.map((plugin) => ({
      id: plugin.manifest.id,
      version: plugin.manifest.version ?? '0.1.0',
      scope: 'builtin',
      enabled: true,
      installedAt: Date.now(),
    })),
    skillsets: BUNDLED.skillsets,
    skills: BUNDLED.skills,
  };
}

/* Constructs the app-wide host: the HostRpcServer with every adapter
   registered, the plugin loader with all built-ins, the secret store, and
   the loopback PolyporeHost for in-tree panels. Importing this module
   performs NONE of that — index.tsx calls this once and provides the
   bundle via AppHostProvider; rendering <App /> without a provider (tests,
   dev preview) lazily constructs a shared default on first render. The
   body keeps the indentation of its module-level past: several statements
   embed multi-line template literals whose content would change if
   re-indented. */
export function createAppHost(): AppHostBundle {
const pluginLoader = new PluginLoader();

/* app-wide host rpc server — shared across every mounted plugin. It starts
   empty; desktop mode hydrates it from Tauri adapters and MCP/tool events. */
const appHostServer = new HostRpcServer(createAppHostInitialState());

appHostServer.setAgentDispatcher(async ({ agent, sessionId, worktreeId, text, transcript }) => {
  const conversationText = transcript.length > 1
    ? [
      'Continue this Polypore chat session. Treat earlier turns as conversation context and answer the latest user turn.',
      '',
      ...transcript.map((turn) => `${turn.by.toUpperCase()}:\n${turn.text}`),
    ].join('\n\n')
    : text;
  const send = tauriInvoke<AgentSendResult>('agent_send', { agent, sessionId, worktreeId, text: conversationText });
  if (!send) {
    return {
      adapter: 'browser',
      responseText: `${agent} runtime is unavailable in browser preview.`,
      events: [],
    };
  }
  const result = await send;
  return {
    adapter: result.adapter,
    responseText: result.responseText,
    events: result.events.map((event) => {
      if (event.kind === 'tool-call') return { kind: 'tool-call' as const, toolName: event.toolName, summary: event.summary };
      if (event.kind === 'permission') return { kind: 'permission' as const, summary: event.summary };
      return { kind: 'message' as const, text: event.text };
    }).filter((event) => event.kind !== 'message'),
    streamed: false,
  };
});

appHostServer.setAgentCommandProvider(async (agent) => {
  const catalog = tauriInvoke<AgentSlashCatalog>('agent_slash_catalog', { agent });
  if (!catalog) return [];
  return (await catalog).commands;
});

appHostServer.setPersistenceWriter({
  chatMessage: async ({ sessionId, agent, title, role, body, toolCallId }) => {
    const record = tauriInvoke<PersistedRow>('persistence_record_chat_message', {
      input: {
        sessionId,
        agent,
        title,
        role,
        body,
        toolCallId,
      },
    });
    await record;
  },
  historyEvent: async (event) => {
    const record = tauriInvoke('history_event_record', {
      input: {
        id: event.id,
        ts: event.ts,
        taskId: event.taskId,
        source: event.source,
        kind: event.kind,
        agentId: event.agentId,
        toolName: event.toolName,
        phase: event.phase,
        affectedFiles: event.affectedFiles ?? [],
        summary: event.summary,
        worktreeId: event.worktreeId,
        snapshotCommit: event.snapshotCommit,
        payload: event.payload ?? null,
      },
    });
    if (record) await record;
  },
});

appHostServer.setTerminalRunner({
  spawn: async (command, size) => {
    const session = tauriInvoke<PtySessionResult>('pty_spawn', {
      command,
      cols: size?.cols,
      rows: size?.rows,
    });
    if (!session) {
      return {
        id: `pty-${Date.now()}`,
        command,
        status: 'exited',
        output: 'terminal bridge unavailable without the desktop shell\n',
        exitCode: 1,
      };
    }
    const result = await session;
    return {
      id: result.id,
      command: result.command,
      status: result.status,
      output: result.output,
      pid: result.pid,
      exitCode: result.exitCode,
    };
  },
  stop: async (id) => {
    const stopped = tauriInvoke<boolean>('pty_stop', { id });
    return stopped ? await stopped : false;
  },
  write: async (id, data) => {
    const written = tauriInvoke<boolean>('pty_write', { id, data });
    return written ? await written : false;
  },
  resize: async (id, cols, rows) => {
    const resized = tauriInvoke<boolean>('pty_resize', { id, cols, rows });
    return resized ? await resized : false;
  },
});

appHostServer.setExternalOpener(async (url) => {
  const opened = tauriInvoke<ExternalOpenResult>('open_external_url', { url });
  if (opened) return await opened;
  try {
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    return Boolean(win);
  } catch {
    return false;
  }
});

if (hasTauriInvoke()) {
  appHostServer.setFileSystemAdapter({
    listTree: async () => {
      const tree = tauriInvoke<FileTreeNode[]>('fs_list_tree');
      if (!tree) throw new Error('filesystem bridge unavailable');
      return tree;
    },
    listDir: async (path) => {
      const tree = tauriInvoke<FileTreeNode[]>('fs_list_dir', { path });
      if (!tree) throw new Error('filesystem bridge unavailable');
      return tree;
    },
    listFiles: async () => {
      const files = tauriInvoke<string[]>('fs_list_files');
      if (!files) throw new Error('filesystem bridge unavailable');
      return files;
    },
    readText: async (path) => {
      const text = tauriInvoke<string>('fs_read_text', { path });
      if (!text) throw new Error('filesystem bridge unavailable');
      return text;
    },
    writeText: async (path, content) => {
      const write = tauriInvoke<void>('fs_write_text', { path, content });
      if (!write) throw new Error('filesystem bridge unavailable');
      await write;
    },
    search: async ({ query, regex, glob, limit }) => {
      const matches = tauriInvoke<EditorSearchMatch[]>('fs_search', { query, regex, glob, limit });
      if (!matches) throw new Error('filesystem bridge unavailable');
      return matches;
    },
    createDir: async (path) => {
      const result = tauriInvoke<void>('fs_mkdir', { path });
      if (!result) throw new Error('filesystem bridge unavailable');
      await result;
    },
    deleteFile: async (path) => {
      const result = tauriInvoke<void>('fs_delete', { path });
      if (!result) throw new Error('filesystem bridge unavailable');
      await result;
    },
  });
  appHostServer.setSkillPublisher({
    publish: async (id, name, body, agents) => {
      const result = tauriInvoke<string[]>('skill_publish', { id, name, body, agents });
      if (!result) throw new Error('skill publish bridge unavailable');
      const published = await result;
      return { published };
    },
    unpublish: async (id) => {
      const result = tauriInvoke<string[]>('skill_unpublish', { id });
      if (!result) throw new Error('skill unpublish bridge unavailable');
      const unpublished = await result;
      return { unpublished };
    },
    delete: async (id) => {
      const result = tauriInvoke<void>('skill_delete', { id });
      if (!result) throw new Error('skill delete bridge unavailable');
      await result;
    },
  });
  appHostServer.setPluginStore({
    setEnabled: async (id, enabled) => {
      const result = tauriInvoke<void>('plugins_set_installed_enabled', { id, enabled });
      if (result) await result;
    },
    remove: async (id) => {
      const result = tauriInvoke<void>('plugins_remove_installed', { id });
      if (result) await result;
    },
  });
  appHostServer.setTaskAdapter({
    list: async () => {
      const tasks = tauriInvoke<Task[]>('tasks_list');
      if (!tasks) throw new Error('task bridge unavailable');
      return tasks;
    },
    add: async (task) => {
      const written = tauriInvoke<Task>('tasks_add', { input: task });
      if (!written) throw new Error('task bridge unavailable');
      return written;
    },
    update: async (id, patch) => {
      const written = tauriInvoke<Task>('tasks_update', { input: { id, ...patch } });
      if (!written) throw new Error('task bridge unavailable');
      return written;
    },
  });
  appHostServer.setVerifyAdapter({
    runs: async () => {
      const runs = tauriInvoke<VerifyRun[]>('verify_runs_list');
      if (!runs) throw new Error('verify bridge unavailable');
      return runs;
    },
    run: async (id) => {
      const run = tauriInvoke<VerifyRun>('verify_run_command', { id });
      if (!run) throw new Error('verify bridge unavailable');
      return run;
    },
  });

  appHostServer.setKnowledgeAdapter({
    bases: async () => {
      const bases = tauriInvoke<KnowledgeBase[]>('knowledge_bases_list');
      if (!bases) throw new Error('knowledge bridge unavailable');
      return bases;
    },
    openFolder: async () => {
      const base = tauriInvoke<KnowledgeBase | null>('knowledge_pick_base_folder');
      if (!base) throw new Error('knowledge bridge unavailable');
      return base;
    },
    createBase: async (input: KnowledgeBaseInput) => {
      const base = tauriInvoke<KnowledgeBase>('knowledge_base_create', { input });
      if (!base) throw new Error('knowledge bridge unavailable');
      return base;
    },
    suggestBaseLocation: async (input) => {
      const location = tauriInvoke<string>('knowledge_base_suggest_location', { input });
      if (!location) throw new Error('knowledge bridge unavailable');
      return location;
    },
    pickBaseLocation: async () => {
      const result = tauriInvoke<{ location: string | null; scope?: KnowledgeBaseScope }>('knowledge_pick_base_location');
      if (!result) throw new Error('knowledge bridge unavailable');
      return result;
    },
    setBaseScope: async (id, scope) => {
      const base = tauriInvoke<KnowledgeBase>('knowledge_base_set_scope', { id, scope });
      if (!base) throw new Error('knowledge bridge unavailable');
      return base;
    },
    renameBase: async (id, name) => {
      const base = tauriInvoke<KnowledgeBase>('knowledge_base_rename', { id, name });
      if (!base) throw new Error('knowledge bridge unavailable');
      return base;
    },
    deleteBase: async (id) => {
      const result = tauriInvoke<void>('knowledge_base_delete', { id });
      if (!result) throw new Error('knowledge bridge unavailable');
      await result;
    },
    createFolder: async (path, baseId) => {
      const result = tauriInvoke<void>('knowledge_folder_create', { path, baseId });
      if (!result) throw new Error('knowledge bridge unavailable');
      await result;
    },
    renameFolder: async (from, to, baseId) => {
      const result = tauriInvoke<void>('knowledge_folder_rename', { from, to, baseId });
      if (!result) throw new Error('knowledge bridge unavailable');
      await result;
    },
    deleteFolder: async (path, baseId) => {
      const result = tauriInvoke<void>('knowledge_folder_delete', { path, baseId });
      if (!result) throw new Error('knowledge bridge unavailable');
      await result;
    },
    deleteDoc: async (path, baseId) => {
      const result = tauriInvoke<void>('knowledge_delete_doc', { path, baseId });
      if (!result) throw new Error('knowledge bridge unavailable');
      await result;
    },
    list: async (baseId) => {
      const nodes = tauriInvoke<KnowledgeNodeResult>('knowledge_list', { baseId });
      if (!nodes) throw new Error('knowledge bridge unavailable');
      return nodes;
    },
    read: async (path, baseId) => {
      const content = tauriInvoke<string>('knowledge_read', { path, baseId });
      if (!content) throw new Error('knowledge bridge unavailable');
      return content;
    },
    write: async (path, content, baseId) => {
      const write = tauriInvoke<void>('knowledge_write', { path, content, baseId });
      if (!write) throw new Error('knowledge bridge unavailable');
      await write;
    },
  });

  appHostServer.setHistoryAdapter({
    events: async (filter) => {
      const result = tauriInvoke<HistoryEvent[]>('history_events_list', {
        worktreeId: filter?.worktreeId ?? null,
        limit: filter?.limit ?? 500,
      });
      if (!result) return [];
      try {
        return await result;
      } catch {
        return [];
      }
    },
    diff: async (request) => {
      const result = tauriInvoke<GitDiffShellResult>('git_diff', {
        mode: request.mode,
        file: request.file ?? null,
        snapshotCommit: request.snapshotCommit ?? null,
        worktreePath: request.worktreePath ?? null,
      });
      if (!result) throw new Error('git diff bridge unavailable');
      const diff = await result;
      return {
        mode: diff.mode,
        file: diff.file ?? null,
        baseRef: diff.baseRef ?? null,
        targetRef: diff.targetRef ?? null,
        changedFiles: diff.changedFiles,
        diff: diff.diff,
        exitCode: diff.exitCode ?? null,
      };
    },
    fork: async (eventId) => {
      const result = tauriInvoke<GitWorktreeShellResult>('git_fork', { eventId });
      if (!result) throw new Error('git worktree bridge unavailable');
      const worktree = await result;
      return {
        id: worktree.id,
        path: worktree.path,
        branch: worktree.branch,
        forkedFromEventId: worktree.forkedFromEventId,
      };
    },
    revert: async (_eventId, files) => {
      const result = tauriInvoke<GitRevertShellResult>('git_revert_files', { files });
      if (!result) throw new Error('git revert bridge unavailable');
      const reverted = await result;
      return {
        files: reverted.files,
        output: reverted.output,
        exitCode: reverted.exitCode ?? null,
      };
    },
    restoreFromSnapshot: async ({ snapshotCommit, files, worktreePath }) => {
      const result = tauriInvoke<GitRevertShellResult>('git_restore_from_snapshot', {
        snapshotCommit,
        files,
        worktreePath: worktreePath ?? null,
      });
      if (!result) throw new Error('autosave restore bridge unavailable');
      const reverted = await result;
      return {
        files: reverted.files,
        output: reverted.output,
        exitCode: reverted.exitCode ?? null,
      };
    },
    takeSnapshot: async ({ worktreeId, worktreePath, kind }) => {
      const result = tauriInvoke<SnapshotRecord>('snapshot_take', {
        worktreeId,
        worktreePath: worktreePath ?? null,
        kind: kind ?? null,
      });
      if (!result) throw new Error('autosave bridge unavailable');
      return await result;
    },
    signalWrite: (worktreeId) => {
      const call = tauriInvoke<void>('snapshot_signal_write', { worktreeId });
      if (call) void call.catch(() => {});
    },
    signalTurnEnd: (worktreeId) => {
      const call = tauriInvoke<void>('snapshot_signal_turn_end', { worktreeId });
      if (call) void call.catch(() => {});
    },
    listWorktrees: async () => {
      const result = tauriInvoke<WorktreeListShellResult[]>('worktrees_list');
      if (!result) return [];
      try {
        /* list-only: autosave bootstrapping happens once in the project-open
           effect, not as a side effect of listing. */
        const rows = await result;
        return rows.map((row) => ({
          id: row.id,
          path: row.path,
          branch: row.branch ?? null,
          head: row.head ?? null,
          isCurrent: row.isCurrent ?? false,
          isLocked: row.isLocked ?? false,
          isDetached: row.isDetached ?? false,
        }));
      } catch {
        return [];
      }
    },
    createWorktree: async ({ branch, path, fromRef }) => {
      const result = tauriInvoke<GitWorktreeShellResult>('worktree_create', {
        branch: branch ?? null,
        path: path ?? null,
        fromRef: fromRef ?? null,
      });
      if (!result) throw new Error('git worktree bridge unavailable');
      const worktree = await result;
      return {
        id: worktree.id,
        path: worktree.path,
        branch: worktree.branch,
        forkedFromEventId: worktree.forkedFromEventId,
      };
    },
  });

  appHostServer.setDiagnosticsProvider(async () => {
    /* Keep the default list path to language-server diagnostics. The CLI
       collectors (`tsc`, eslint, cargo, and deeper probes) are explicit
       deep-scan work: running them for every cold diagnostics.list can
       saturate the machine enough to stall the visible workspace. */
    perfPoint('provider:diagnostics-cold-fire');
    const lsp = tauriInvoke<LspDiagnosticsResult>('lsp_diagnostics_collect');
    if (!lsp) throw new Error('diagnostics bridge unavailable');
    const lspResult = await lsp.catch(() => ({ servers: [], diagnostics: [] as Diagnostic[] }));
    perfPoint('provider:diagnostics-resolved');
    return mergeDiagnostics(lspResult.diagnostics);
  });

  appHostServer.setDiagnosticsDocumentProvider(async (path, content) => {
    const result = tauriInvoke<LspDiagnosticsResult>('lsp_diagnostics_document', {
      path,
      text: content,
    });
    if (!result) return [];
    return (await result.catch(() => ({ servers: [], diagnostics: [] as Diagnostic[] }))).diagnostics;
  });

  appHostServer.setDiagnosticsDeepScanner(async () => {
    const lsp = tauriInvoke<LspDiagnosticsResult>('lsp_diagnostics_collect');
    const deep = tauriInvoke<DiagnosticsCollectResult>('diagnostics_deep_scan');
    if (!lsp && !deep) throw new Error('deep diagnostics bridge unavailable');
    const [lspResult, deepResult] = await Promise.all([
      lsp?.catch(() => ({ servers: [], diagnostics: [] as Diagnostic[] })),
      deep?.catch(() => ({ diagnostics: [] as Diagnostic[] })),
    ]);
    return mergeDiagnostics([
      ...(lspResult?.diagnostics ?? []),
      ...(deepResult?.diagnostics ?? []),
    ]);
  });
}

appHostServer.setIterateRunner(async ({ taskId, prompt, maxCycles, verifyCommands }) => {
  const run = tauriInvoke<IterateRunShellResult>('iterate_run', {
    input: {
      taskId,
      prompt,
      maxCycles,
      verifyCommands: verifyCommands.map((command) => ({
        id: command.id,
        label: command.label,
        command: command.command,
        required: command.required,
      })),
    },
  });
  if (!run) {
    return {
      taskId,
      status: 'unavailable',
      cycle: 0,
      maxCycles: maxCycles ?? 5,
      runs: verifyCommands.map((command) => ({
        id: `${command.id}-${Date.now()}`,
        label: command.label,
        command: command.command,
        required: command.required,
        exitCode: null,
        output: 'iterate runner unavailable without the desktop shell',
      })),
    };
  }
  const result = await run;
  return {
    taskId: result.taskId,
    status: result.status,
    cycle: result.cycle,
    maxCycles: result.maxCycles,
    runs: result.runs.map((item) => ({
      id: item.id,
      label: item.label,
      command: item.command,
      required: item.required,
      exitCode: item.exitCode,
      output: item.output,
    })),
  };
});

/* secret store lives host-side. plugins only see the masked view via
   host.secrets.list/has. in the desktop shell, values live exclusively in
   the OS keyring (Tauri secrets_* commands) and this store holds metadata
   only; the browser preview has no shell, so it falls back to the
   localStorage value store. */
const appSecretStore: SecretStore = typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  ? (hasTauriInvoke() ? createMetadataSecretStore(window.localStorage) : createLocalStorageSecretStore(window.localStorage))
  : createMemorySecretStore();
appHostServer.setSecretStore(appSecretStore);

function localSecretRefs(): NativeSecretRef[] {
  return appSecretStore.list().map((entry) => ({
    id: entry.id,
    scope: entry.scope,
    service: entry.service,
    hint: entry.hint,
    configured: entry.configured,
    createdAt: entry.updatedAt,
  }));
}

/* discover .env files in the project and seed handles. tauri-only: the
   browser preview can't read the filesystem, so this is a no-op there.
   manual entries take precedence (already-known handles are skipped).
   values go straight into the OS keyring; the renderer store keeps the
   masked metadata only. */
void (async () => {
  const candidates = ['.env', '.env.local', '.env.development'];
  for (const file of candidates) {
    const promise = tauriInvoke<string>('fs_read_text', { path: file });
    if (!promise) return; /* no tauri shell — skip discovery */
    try {
      const body = await promise;
      if (typeof body === 'string' && body.length > 0) {
        for (const { key, id, value } of parseDotEnv(body)) {
          if (appSecretStore.has(id, 'project') || appSecretStore.has(id)) continue;
          try {
            await tauriInvoke('secrets_set', { id, value, scope: 'project', service: key });
            appSecretStore.set({ id, value, scope: 'project', service: key });
          } catch {
            /* keyring unavailable — leave the key undiscovered */
          }
        }
      }
    } catch {
      /* file missing or unreadable — quietly try the next candidate */
    }
  }
})();
appHostServer.setSecretUser(async ({ id, scope, request }) => {
  const useSecret = tauriInvoke<SecretUseResult>('secrets_use', { id, scope, request });
  if (!useSecret) {
    throw new Error('secrets.use is unavailable in browser preview');
  }
  return useSecret;
});

/* secrets.set — Tauri keyring write with optimistic mirror into the local
   store so the masked list updates immediately. */
appHostServer.setSecretWriter(async ({ id, value, scope, service }) => {
  const tauriCall = tauriInvoke<{ id: string; scope: string; service?: string; hint: string; configured: boolean; createdAt: number }>(
    'secrets_set',
    { id, value, scope: scope ?? 'project', service },
  );
  if (!tauriCall) {
    /* browser preview — fall back to the in-process store directly. */
    return appSecretStore.set({ id, value, scope, service });
  }
  const tauriEntry = await tauriCall;
  appSecretStore.set({ id, value, scope, service });
  return {
    id: tauriEntry.id,
    scope: tauriEntry.scope as 'user' | 'project',
    service: tauriEntry.service ?? service ?? '',
    hint: tauriEntry.hint,
    configured: tauriEntry.configured,
    updatedAt: tauriEntry.createdAt,
  };
});

/* secrets.reveal — call Tauri keyring; renderer-only mode falls back to
   the in-process SecretStore (the host-side confirmDecider gate still
   fires either way, before we get here). */
appHostServer.setSecretRevealer(async ({ id, scope }) => {
  const tauriCall = tauriInvoke<string | null>('secrets_reveal', { id, scope: scope ?? 'project' });
  if (!tauriCall) {
    const value = appSecretStore.reveal(id, scope);
    return { value, configured: value !== null };
  }
  const value = await tauriCall;
  const configured = appSecretStore.has(id, scope) || value !== null;
  return { value, configured };
});

/* secrets.delete — Tauri keyring removal with mirror into the local store
   so the masked list updates immediately. */
appHostServer.setSecretDeleter(async ({ id, scope }) => {
  const tauriCall = tauriInvoke<boolean>('secrets_delete', { id, scope: scope ?? 'project' });
  if (!tauriCall) {
    /* browser preview — fall back to the in-process store directly. */
    return appSecretStore.delete(id, scope);
  }
  const removed = await tauriCall;
  appSecretStore.delete(id, scope);
  return removed;
});

/* mcp.discover — read claude/codex configs + project .mcp.json via Tauri. */
appHostServer.setMcpDiscoverer(async () => {
  const projectState = appHostServer.getState('project') as { path?: string } | undefined;
  const tauriCall = tauriInvoke<Array<{ name: string; origins: Array<'claude' | 'codex' | 'project'>; transport: 'http' | 'sse' | 'stdio'; url?: string; command?: string; args?: string[]; env?: Record<string, string> }>>(
    'mcp_discover_external',
    { projectDir: projectState?.path ?? null },
  );
  if (!tauriCall) return { servers: [] };
  try {
    const servers = await tauriCall;
    return { servers: servers ?? [] };
  } catch {
    return { servers: [] };
  }
});

/* mcp.install — write MCP entry to agent config files via Tauri. */
appHostServer.setMcpInstaller(async (input) => {
  const projectState = appHostServer.getState('project') as { path?: string } | undefined;
  const tauriCall = tauriInvoke<{ installed: boolean; targets: string[] }>(
    'mcp_config_install',
    { ...input, projectDir: projectState?.path ?? null },
  );
  if (!tauriCall) return { installed: false, targets: [] };
  return tauriCall;
});

/* mcp.servers.test — real probe via Tauri (HTTP tools/list). Renderer-
   only mode falls back to the handler's built-in stub. */
appHostServer.setMcpTester(async (input) => {
  const tauriCall = tauriInvoke<{ ok: boolean; status?: number; error?: string }>(
    'mcp_server_probe',
    { input },
  );
  if (!tauriCall) {
    return { ok: false, error: 'mcp test requires the desktop shell' };
  }
  return tauriCall;
});

/* ─── debug suite ──────────────────────────────────────────────────────────
   The host owns the investigation (state/timeline/trust/summarization); this
   runner is the thin seam to the Tauri dap.rs/debug_capture.rs commands. In
   browser preview there is no shell, so every call reports unavailable and the
   panel shows the empty/blocked state. */
appHostServer.setDebugRunner({
  probe: async ({ adapter, config }) => {
    const call = tauriInvoke<{ adapter: string; command: string; available: boolean; detail: string }>(
      'debug_adapter_probe',
      { input: { adapter, config } },
    );
    if (!call) {
      return {
        adapter,
        command: '',
        available: false,
        detail: 'debug adapter probing requires the desktop shell',
      };
    }
    return call;
  },
  start: async ({ adapter, config }) => {
    const call = tauriInvoke<{ sessionId: string }>('debug_start', { input: { adapter, config } });
    if (!call) throw new Error('debug is unavailable in browser preview — run the desktop shell');
    const result = await call;
    return { sessionId: result.sessionId };
  },
  setBreakpoints: async ({ sessionId, file, breakpoints }) => {
    const call = tauriInvoke<{ breakpoints: Array<{ verified?: boolean; line?: number }> }>('debug_set_breakpoints', {
      input: { sessionId, file, breakpoints },
    });
    if (!call) throw new Error('debug is unavailable in browser preview');
    return call;
  },
  continue: async ({ sessionId, threadId }) => debugStop('debug_continue', sessionId, threadId),
  stepOver: async ({ sessionId, threadId }) => debugStop('debug_step_over', sessionId, threadId),
  stepIn: async ({ sessionId, threadId }) => debugStop('debug_step_in', sessionId, threadId),
  stepOut: async ({ sessionId, threadId }) => debugStop('debug_step_out', sessionId, threadId),
  pause: async ({ sessionId, threadId }) => debugStop('debug_pause', sessionId, threadId),
  stackTrace: async ({ sessionId, threadId }) => {
    const call = tauriInvoke<{ frames: DapFrame[] }>('debug_stack_trace', { input: { sessionId, threadId } });
    if (!call) throw new Error('debug is unavailable in browser preview');
    return call;
  },
  scopes: async ({ sessionId, frameId }) => {
    const call = tauriInvoke<{ scopes: DapScope[] }>('debug_scopes', { input: { sessionId, frameId } });
    if (!call) throw new Error('debug is unavailable in browser preview');
    return call;
  },
  variables: async ({ sessionId, variablesReference }) => {
    const call = tauriInvoke<{ variables: DapVariable[] }>('debug_variables', { input: { sessionId, variablesReference } });
    if (!call) throw new Error('debug is unavailable in browser preview');
    return call;
  },
  evaluate: async ({ sessionId, expression, frameId }) => {
    const call = tauriInvoke<{ result: string; type?: string; variablesReference?: number }>('debug_evaluate', {
      input: { sessionId, expression, frameId },
    });
    if (!call) throw new Error('debug is unavailable in browser preview');
    return call;
  },
  capture: {
    screenshot: async ({ sessionId, target }) => {
      const call = tauriInvoke<{ mimeType: string; dataBase64: string }>('debug_capture_screenshot', {
        input: { sessionId, target },
      });
      if (!call) throw new Error('debug capture is unavailable in browser preview');
      return call;
    },
    console: async ({ sessionId, limit }) => {
      const call = tauriInvoke<Array<{ level: string; text: string }>>('debug_capture_console', {
        input: { sessionId, limit },
      });
      if (!call) throw new Error('debug capture is unavailable in browser preview');
      return { entries: await call };
    },
    /* dom/network omitted — host surfaces the "needs CDP" error (slice 1). */
  },
  /* web auto-nav (phase 1.5) — capability is detected per project; driving
     lazily spawns a playwright driver. absent → host degrades to a roadblock. */
  capabilities: async () => {
    const call = tauriInvoke<{ webAutoNav: boolean }>('debug_web_capabilities');
    if (!call) return { webAutoNav: false };
    try {
      return { webAutoNav: (await call).webAutoNav };
    } catch {
      return { webAutoNav: false };
    }
  },
  drive: {
    navigate: async ({ sessionId, url }) => {
      const call = tauriInvoke<{ url: string; ok: boolean }>('debug_web_navigate', { input: { sessionId, url } });
      if (!call) throw new Error('web auto-nav is unavailable in browser preview');
      return call;
    },
    click: async ({ sessionId, selector }) => {
      const call = tauriInvoke<{ ok: boolean }>('debug_web_click', { input: { sessionId, selector } });
      if (!call) throw new Error('web auto-nav is unavailable in browser preview');
      return call;
    },
    fill: async ({ sessionId, selector, text }) => {
      const call = tauriInvoke<{ ok: boolean }>('debug_web_fill', { input: { sessionId, selector, text } });
      if (!call) throw new Error('web auto-nav is unavailable in browser preview');
      return call;
    },
    login: async (params) => {
      const call = tauriInvoke<{ ok: boolean }>('debug_web_login', { input: params });
      if (!call) throw new Error('web auto-nav is unavailable in browser preview');
      return call;
    },
  },
  stop: async ({ sessionId }) => {
    const dap = tauriInvoke<void>('debug_stop', { sessionId });
    if (dap) await dap;
    const web = tauriInvoke<void>('debug_web_stop', { sessionId });
    if (web) await web.catch(() => {});
  },
});

/* scrub evaluate output against the secret store so debuggee values never
   leak back through dumps (POLYPORE_AGENT_SCRUBBED philosophy). desktop mode
   scrubs host-side via secrets_scrub — the renderer never touches values;
   the browser preview falls back to the in-process store. */
appHostServer.setDebugScrubber(async (text) => {
  const call = tauriInvoke<string>('secrets_scrub', { text });
  if (call) {
    try {
      return await call;
    } catch {
      return text;
    }
  }
  let scrubbed = text;
  for (const entry of appSecretStore.list()) {
    const value = appSecretStore.reveal(entry.id, entry.scope);
    if (value) scrubbed = scrubbed.split(value).join('[secret]');
  }
  return scrubbed;
});

/* loopback PolyporeHost used by built-in plugin components that share the
   react tree with the host. third-party plugins receive their host via
   PluginLoader.mount over postMessage instead. */
const appHost: PolyporeHost = createLoopbackHost(
  (request) => appHostServer.handle(request),
  (topic, fn) => appHostServer.subscribe(topic, fn),
);

for (const plugin of ALL_PLUGINS) {
  /* URL-mode built-ins skip srcdoc generation — their iframe element is
     mounted by IframePanelSurface via src= and doesn't need a loader entry.
     register a placeholder so the host knows the plugin exists. */
  const entryHtml = plugin.iframe?.build
    ? plugin.iframe.build({
        buildPluginSrcdoc,
        sdkRuntime: sdkRuntimeSource as string,
        boot: { agents: AGENT_META },
      })
    : buildStaticPanelPluginHtml(plugin.manifest);
  pluginLoader.register({ manifest: plugin.manifest, entryHtml });
}

/* dependency bundle the global-settings overlay tabs consume. assembling it
   once here keeps overlays decoupled from the host singletons. */
const settingsServices: GlobalSettingsServices = {
  host: appHost,
  secretStore: appSecretStore,
  tauriInvoke,
  localSecretRefs,
  secretHandle,
  agentMeta: AGENT_META,
};

return {
  hostServer: appHostServer,
  pluginLoader,
  secretStore: appSecretStore,
  host: appHost,
  settingsServices,
};
}

const AppHostContext = React.createContext<AppHostBundle | null>(null);
export const AppHostProvider = AppHostContext.Provider;

let defaultAppHostBundle: AppHostBundle | null = null;
/* tests and the dev preview render <App /> bare; the first render builds
   one shared bundle, matching the old module-singleton behavior. */
function getDefaultAppHost(): AppHostBundle {
  if (!defaultAppHostBundle) defaultAppHostBundle = createAppHost();
  return defaultAppHostBundle;
}

/* slot -> manifest.id is derived directly from the discovered plugins. */
const PLUGIN_ID_BY_PANEL: Record<PanelType, string> = Object.fromEntries(
  ALL_PLUGINS.map((plugin) => [plugin.slot, plugin.manifest.id]),
);

const BUILTIN_PANEL_MANIFESTS: PanelManifest[] = ALL_PLUGINS.map((plugin) => plugin.manifest);

type ChatPluginMessage =
  | { source: 'polypore.chat'; type: 'ready'; manifestId: string; agent?: AgentId }
  | { source: 'polypore.chat'; type: 'tool-card'; toolId: string; agent?: AgentId }
  | { source: 'polypore.chat'; type: 'open-settings'; agent?: AgentId }
  | { source: 'polypore.chat'; type: 'open-help'; agent?: AgentId };

function buildStaticPanelPluginHtml(manifest: PanelManifest) {
  const manifestId = JSON.stringify(manifest.id);
  const safeId = escapeStaticPluginHtml(manifest.id);
  const safeTitle = escapeStaticPluginHtml(manifest.title);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
</head>
<body>
  <main data-plugin-id="${safeId}" data-plugin-title="${safeTitle}"></main>
  <script>
    const manifestId = ${manifestId};
    window.parent.postMessage({ source: manifestId, type: 'ready', manifestId }, '*');
  </script>
</body>
</html>`;
}

function escapeStaticPluginHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char
  ));
}

function isLegacyChatFrameSource(source: MessageEventSource) {
  return [...document.querySelectorAll<HTMLIFrameElement>('.plugin-iframe')]
    .some((frame) => (
      frame.contentWindow === source
      && (frame.title === 'polypore.chat' || frame.title.startsWith('polypore.chat.'))
    ));
}

type InstalledPluginSnapshot = {
  id: string;
  title: string;
  source: string;
  enabled: boolean;
};

function installedSnapshotFromRefs(refs: PluginRef[]): InstalledPluginSnapshot[] {
  const byId = new Map(ALL_PLUGINS.map((plugin) => [plugin.manifest.id, plugin]));
  return refs.map((ref) => {
    const builtin = byId.get(ref.id);
    /* for external plugins, the full manifest is stored on the ref by
       plugins.install; use its title as the label fallback. */
    const manifest = !builtin && ref.manifest && typeof ref.manifest === 'object'
      ? (ref.manifest as { title?: string; id?: string })
      : null;
    return {
      id: ref.id,
      title: builtin?.meta.label ?? manifest?.title ?? ref.id,
      source: typeof ref.source === 'string' ? ref.source : ref.scope ?? 'project',
      enabled: ref.enabled !== false,
    };
  });
}

/* construct a minimal BuiltinPlugin from a PluginRef that carries a manifest
   + entryUrl (set by plugins.install for external/URL-mode plugins). */
function externalPluginFromRef(ref: PluginRef): BuiltinPlugin | null {
  if (!ref.manifest || !ref.entryUrl) return null;
  const manifest = ref.manifest as import('../packages/sdk/src').PanelManifest;
  const entryUrl = ref.entryUrl as string;
  return {
    manifest,
    slot: manifest.id,
    meta: { icon: manifest.icon, label: manifest.title },
    iframe: { url: entryUrl },
    defaultOrder: 500,
    inDefaultStrip: true,
  };
}

/* Resolve the panel a help button was pressed on to its manual page. Runtime
 * slots can carry an agent suffix (polypore.chat.codex) while the manual has one
 * page per plugin (polypore.chat), so fall back to the plugin base id. */
function manualSlugForSlot(
  corpus: ManualCorpus,
  catalog: PanelCatalogItem[],
  slot: string,
): string | undefined {
  const id = catalog.find((item) => item.slot === slot)?.id;
  if (!id) return undefined;
  if (corpus.get(`panels/${id}`)) return `panels/${id}`;
  const base = id.split('.').slice(0, 2).join('.');
  return corpus.get(`panels/${base}`) ? `panels/${base}` : undefined;
}

function manualAgentPrompt(section: ManualCorpus['sections'][number]): string {
  const facts = section.facts
    ? [
      `Plugin: ${section.facts.id}`,
      `Version: ${section.facts.version}`,
      `Category: ${section.facts.category}`,
      `Permissions: ${section.facts.permissions.join(', ') || 'none'}`,
      `Capabilities: ${section.facts.capabilities.join(', ') || 'none'}`,
    ].join('\n')
    : '';
  return [
    'Use this Polypore manual section to answer questions or suggest next steps.',
    `Title: ${section.title}`,
    `Slug: ${section.slug}`,
    `Group: ${section.group}`,
    facts,
    'Manual body:',
    section.body.trim() || '(no prose authored for this page yet.)',
  ].filter(Boolean).join('\n\n');
}

function stripManualHeading(markdown: string, title: string): string {
  const body = markdown.replace(/^\s+/, '');
  const match = /^#\s+(.+?)(?:\n|$)/.exec(body);
  if (!match) return markdown;
  const heading = match[1].replace(/\s+#+\s*$/, '').trim().toLowerCase();
  return heading === title.trim().toLowerCase()
    ? body.slice(match[0].length).replace(/^\n+/, '')
    : markdown;
}

function plainManualText(value: string): string {
  return value
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function manualSummary(section: ManualCorpus['sections'][number] | undefined, label: string): string {
  if (!section) return `${label} panel`;
  const body = stripManualHeading(section.body, section.title);
  const paragraph: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed && paragraph.length > 0) break;
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('- ') || trimmed.startsWith('* ')) continue;
    paragraph.push(trimmed);
  }
  return plainManualText(paragraph.join(' ')) || `${label} panel`;
}

function manualTips(section: ManualCorpus['sections'][number] | undefined): string[] {
  if (!section) return [];
  const tips = /(?:^|\n)##\s+Tips\s*\n([\s\S]*?)(?=\n##\s+|\s*$)/i.exec(section.body);
  if (!tips) return [];
  return tips[1]
    .split('\n')
    .map((line) => /^\s*[-*]\s+(.+)$/.exec(line)?.[1])
    .filter((line): line is string => Boolean(line))
    .map(plainManualText)
    .filter(Boolean);
}

function panelManualFromCorpus(corpus: ManualCorpus, pluginId: string, label: string): PanelManual {
  const section = corpus.get(`panels/${pluginId}`);
  return {
    summary: manualSummary(section, label),
    tips: manualTips(section),
  };
}

function contextPathFromLabel(label: string): string {
  const match = /^included:\s*(.+)$/.exec(label);
  return match?.[1].trim() ?? '';
}

function contextDocFromLabel(label: string): PanelContextDoc | null {
  const path = contextPathFromLabel(label);
  if (!path) return null;
  return {
    path: path.replace(/^memory:\/\/documents\//, ''),
    bytes: 0,
    tokens: 0,
    state: 'queued',
    readCount: 0,
    contextItem: label,
  };
}

function contextDocsByChatFromLabels(contextByChat: Record<string, string[]>): Record<string, PanelContextDoc[]> {
  return Object.fromEntries(Object.entries(contextByChat).map(([chatId, labels]) => {
    const seen = new Set<string>();
    const docs = labels.flatMap((label) => {
      const doc = contextDocFromLabel(label);
      if (!doc || seen.has(doc.path)) return [];
      seen.add(doc.path);
      return [doc];
    });
    return [chatId, docs];
  }));
}

function buildPanelCatalog(
  installedPlugins: InstalledPluginSnapshot[],
  corpus: ManualCorpus,
  dynamicPlugins: BuiltinPlugin[] = [],
): PanelCatalogItem[] {
  const installedById = new Map(installedPlugins.map((plugin) => [plugin.id, plugin]));
  const allPlugins = dynamicPlugins.length > 0
    ? [...ALL_PLUGINS, ...dynamicPlugins.filter((p) => !PLUGINS_BY_SLOT.has(p.slot))]
    : ALL_PLUGINS;
  return allPlugins.map((plugin) => {
    const installed = installedById.get(plugin.manifest.id);
    return {
      slot: plugin.slot,
      id: plugin.manifest.id,
      icon: plugin.meta.icon,
      label: plugin.meta.label,
      title: plugin.manifest.title ?? plugin.meta.label,
      version: plugin.manifest.version ?? '0.1.0',
      category: plugin.manifest.category ?? 'other',
      defaultArea: plugin.manifest.defaultArea,
      permissions: plugin.manifest.permissions ?? [],
      capabilities: plugin.manifest.capabilities ?? [],
      enabled: installed?.enabled ?? true,
      source: installed?.source ?? 'builtin',
      manual: panelManualFromCorpus(corpus, plugin.manifest.id, plugin.meta.label),
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

function App() {
  const {
    hostServer: appHostServer,
    host: appHost,
    pluginLoader,
    settingsServices,
  } = React.useContext(AppHostContext) ?? getDefaultAppHost();
  const [workspace, setWorkspace] = useState<WorkspaceName>(DEFAULT_WORKSPACE);
  const workspacePreset = useMemo(() => getWorkspacePreset(workspace), [workspace]);
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const [userPresets, setUserPresets] = useState<UserWorkspacePreset[]>([]);
  const [projectPath, setProjectPath] = useState('');
  const [projectVersion, setProjectVersion] = useState(0);
  const workspaceMounted = projectVersion > 0 || import.meta.env.MODE === 'test';

  const layoutStorageKey = useMemo(
    () => (projectPath ? workspaceLayoutStorageKey(workspace, projectPath) : undefined),
    [projectPath, workspace],
  );
  /* the launcher is the first screen on boot — adobe-style. once the user
     picks a project, launcherMode goes null and the workspace becomes
     visible. when re-opened from the top-bar project menu, it's
     dismissable; on initial boot (no project yet) it's a gate. */
  const [launcherMode, setLauncherMode] = useState<'recent' | 'new' | null>('recent');
  const [launcherDismissable, setLauncherDismissable] = useState(false);
  const [projectLoading, setProjectLoading] = useState(false);
  const projectLoadingStartedAt = useRef(0);
  const workspaceMountCancelsRef = useRef<Array<() => void>>([]);
  const loadingHideTimerRef = useRef<number | null>(null);
  const projectOpenPublishCancelRef = useRef<(() => void) | null>(null);
  const [contextItems, setContextItems] = useState<string[]>([]);
  const [contextByChat, setContextByChat] = useState<Record<string, string[]>>({});
  const [panelHelpFor, setPanelHelpFor] = useState<PanelType | null>(null);
  const [settingsTarget, setSettingsTarget] = useState<{
    section: SettingsSection;
    panelSlot?: PanelType;
    projectGroup?: ProjectSettingsGroup;
    nonce: number;
  } | null>(null);
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginSnapshot[]>(INSTALLED_PLUGINS_SNAPSHOT);
  /* dynamicPlugins: external plugins installed at runtime via plugins.install.
     keyed by slot (= manifest.id) so they can be merged into the dockview
     context alongside the build-time ALL_PLUGINS map. */
  const [dynamicPlugins, setDynamicPlugins] = useState<BuiltinPlugin[]>([]);
  const pluginsBySlot = useMemo<Map<string, BuiltinPlugin>>(() => {
    if (dynamicPlugins.length === 0) return PLUGINS_BY_SLOT;
    return new Map([...PLUGINS_BY_SLOT, ...dynamicPlugins.map((p) => [p.slot, p] as const)]);
  }, [dynamicPlugins]);
  /* the manual corpus is assembled at build time from markdown files (Vite
     globs), so it's stable for the session — load it once. */
  const manualCorpus = useMemo(() => loadManualCorpus(), []);
  const panelCatalog = useMemo(
    () => buildPanelCatalog(installedPlugins, manualCorpus, dynamicPlugins),
    [installedPlugins, manualCorpus, dynamicPlugins],
  );
  /* codex and claude are now independent windows. keep a placeholder active
     agent for state.subscribe('activeAgent') consumers that still expect a
     single current runtime. */
  const activeAgent: AgentId = 'codex';
  const [confirmRequest, setConfirmRequest] = useState<{
    request: ConfirmRequest;
    resolve: (decision: ConfirmDecision) => void;
  } | null>(null);
  const [inputBoxRequest, setInputBoxRequest] = useState<{
    prompt: string;
    placeholder?: string;
    value?: string;
    resolve: (value: string | null) => void;
  } | null>(null);
  /* in-app answer to a git/ssh credential prompt routed through the askpass
     broker. cancel-only: closing the modal cancels the underlying git op. */
  const [askpassPrompt, setAskpassPrompt] = useState<{ id: string; prompt: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const applyPluginRefs = (refs: PluginRef[]) => {
      if (cancelled) return;
      setInstalledPlugins(installedSnapshotFromRefs(refs));
      /* build BuiltinPlugin stubs for any external plugin that carries a
         manifest + entryUrl on its PluginRef (set by plugins.install).
         these are keyed by manifest.id as the slot so they join the merged
         pluginsBySlot map and appear in the dockview panel strip. */
      const external = refs.flatMap((ref) => {
        /* a built-in slot is owned by the bundled plugin; a disabled external
           plugin stays registered (so the catalog can re-enable it) but is kept
           out of the rendered tab strip. */
        if (PLUGINS_BY_SLOT.has(ref.id) || ref.enabled === false) return [];
        const plugin = externalPluginFromRef(ref);
        return plugin ? [plugin] : [];
      });
      setDynamicPlugins(external);
    };

    const loadPlugins = () => {
      appHost.plugins.list().then(({ plugins }) => applyPluginRefs(plugins)).catch(() => {});
    };

    /* rehydrate plugins installed in a previous session: the desktop host reads
       the on-disk .polypore/plugins/ registry and registers each one so its
       panel renders on every launch. no-op in browser preview (no Tauri). */
    const hydrateInstalledPlugins = async () => {
      const result = tauriInvoke<PluginRef[]>('plugins_list_installed');
      if (!result) return;
      try {
        const records = await result;
        if (cancelled) return;
        for (const record of records) {
          await appHost.plugins.install(record);
        }
      } catch { /* installed-plugin registry is optional */ }
    };

    void hydrateInstalledPlugins().finally(loadPlugins);
    const unsubscribe = appHostServer.subscribe('plugins:changed', (payload) => {
      const plugins = typeof payload === 'object' && payload && 'plugins' in payload
        ? (payload as { plugins?: PluginRef[] }).plugins
        : undefined;
      if (Array.isArray(plugins)) applyPluginRefs(plugins);
      else loadPlugins();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    appHostServer.setConfirmDecider((request) => new Promise<ConfirmDecision>((resolve) => {
      setConfirmRequest({ request, resolve });
    }));
    return () => {
      appHostServer.setConfirmDecider(() => false);
    };
  }, []);

  useEffect(() => {
    appHostServer.setInputBoxAdapter(({ prompt, placeholder, value }) => (
      new Promise<string | null>((resolve) => {
        setInputBoxRequest({ prompt, placeholder, value, resolve });
      })
    ));
    return () => {
      appHostServer.setInputBoxAdapter(null);
    };
  }, []);

  /* page-visibility: when the app tab/window is hidden, tag <body> so
     glass.css can pause every running animation (chat pulse, monaco
     caret, etc). saves real battery on backgrounded laptops without
     changing what users see. */
  useEffect(() => {
    const sync = () => {
      if (document.visibilityState === 'hidden') {
        document.body.dataset.appHidden = '1';
      } else {
        delete document.body.dataset.appHidden;
      }
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  const closeConfirm = useCallback((decision: ConfirmDecision) => {
    confirmRequest?.resolve(decision);
    setConfirmRequest(null);
  }, [confirmRequest]);

  const addToContext = useCallback((label: string, targetId?: string) => {
    if (targetId) {
      setContextByChat((items) => {
        const targetItems = items[targetId] ?? [];
        return {
          ...items,
          [targetId]: targetItems.includes(label) ? targetItems : [label, ...targetItems],
        };
      });
      return;
    }
    setContextItems((items) => (items.includes(label) ? items : [label, ...items]));
  }, []);

  const removeFromContext = useCallback((label: string, targetId?: string) => {
    if (targetId) {
      setContextByChat((items) => {
        if (!items[targetId]?.includes(label)) return items;
        return { ...items, [targetId]: items[targetId].filter((item) => item !== label) };
      });
      return;
    }
    setContextItems((items) => items.filter((item) => item !== label));
  }, []);

  const openSettings = useCallback((target?: {
    section?: SettingsSection;
    panelSlot?: PanelType;
    projectGroup?: ProjectSettingsGroup;
  }) => {
    setSettingsTarget({
      section: target?.section ?? 'panels',
      panelSlot: target?.panelSlot,
      projectGroup: target?.projectGroup,
      nonce: Date.now(),
    });
  }, []);
  const openPanelHelp = useCallback((slot: string) => setPanelHelpFor(slot), []);
  const openPanelSettings = useCallback((slot: string) => {
    openSettings({ section: 'panels', panelSlot: slot });
  }, [openSettings]);

  const allContextItems = useMemo(() => [...new Set([
    ...contextItems,
    ...Object.values(contextByChat).flat(),
  ])], [contextByChat, contextItems]);
  const contextDocsByChat = useMemo(
    () => contextDocsByChatFromLabels(contextByChat),
    [contextByChat],
  );

  const chatBoot = useMemo(
    () => ({
      agents: AGENT_META,
      contextItems: allContextItems,
    }),
    [allContextItems],
  );

  const dockviewContext = useMemo(() => ({
    pluginsBySlot,
    host: appHost,
    hostServer: appHostServer,
    pluginLoader,
    sdkRuntime: sdkRuntimeSource as string,
    chatBoot,
    contextItems,
    contextByChat,
    contextDocsByChat,
    onAddContext: addToContext,
    onRemoveContext: removeFromContext,
    onOpenHelp: openPanelHelp,
    onOpenSettings: openPanelSettings,
    installedPlugins,
  }), [addToContext, chatBoot, contextByChat, contextDocsByChat, contextItems, installedPlugins, openPanelHelp, openPanelSettings, pluginsBySlot, removeFromContext]);

  const clearWorkspaceMountSchedule = useCallback(() => {
    for (const cancel of workspaceMountCancelsRef.current.splice(0)) {
      cancel();
    }
  }, []);

  const clearLoadingHideTimer = useCallback(() => {
    if (loadingHideTimerRef.current !== null) {
      window.clearTimeout(loadingHideTimerRef.current);
      loadingHideTimerRef.current = null;
    }
  }, []);

  const clearProjectOpenPublish = useCallback(() => {
    projectOpenPublishCancelRef.current?.();
    projectOpenPublishCancelRef.current = null;
  }, []);

  const scheduleWorkspaceMount = useCallback(() => {
    clearWorkspaceMountSchedule();
    const scheduleFrame = (callback: FrameRequestCallback) => {
      if (typeof window.requestAnimationFrame === 'function') {
        const frame = window.requestAnimationFrame(callback);
        workspaceMountCancelsRef.current.push(() => window.cancelAnimationFrame(frame));
        return;
      }
      const timer = window.setTimeout(() => callback(performance.now()), 16);
      workspaceMountCancelsRef.current.push(() => window.clearTimeout(timer));
    };
    scheduleFrame(() => {
      scheduleFrame(() => {
        const timer = window.setTimeout(() => {
          scheduleFrame(() => {
            workspaceMountCancelsRef.current = [];
            setProjectVersion((version) => version + 1);
          });
        }, 160);
        workspaceMountCancelsRef.current.push(() => window.clearTimeout(timer));
      });
    });
  }, [clearWorkspaceMountSchedule]);

  const handleWorkspaceChange = useCallback((newWorkspace: WorkspaceName) => {
    if (projectPath && !restoreWorkspacePresetLayout(projectPath, newWorkspace)) {
      return;
    }
    setWorkspace(newWorkspace);
    setWorkspaceVersion((v) => v + 1);
    appHostServer.setState('workspace', newWorkspace);
    try {
      saveActiveWorkspace(projectPath, newWorkspace);
    } catch {
      // The workspace still switches for this session when persistence is unavailable.
    }
  }, [projectPath]);

  const handleResetWorkspace = useCallback(() => {
    if (projectPath && !restoreWorkspacePresetLayout(projectPath, workspace)) {
      return;
    }
    setWorkspaceVersion((v) => v + 1);
    appHostServer.setState('workspace', workspace);
  }, [projectPath, workspace]);

  const handleSaveAsPreset = useCallback((name: string) => {
    if (!projectPath) return 'open a project before saving a preset';
    const dock = dockviewApi();
    if (!dock) return 'workspace layout is still loading';
    try {
      const layout = dock.getLayout();
      saveWorkspaceLayout(projectPath, workspace, layout);
      const updated = saveUserPreset(projectPath, name, layout);
      setUserPresets(updated);
      handleWorkspaceChange(name);
      return null;
    } catch {
      return 'could not save the workspace preset';
    }
  }, [projectPath, workspace, handleWorkspaceChange]);

  const handleDeletePreset = useCallback((name: string) => {
    if (!projectPath) return 'open a project before deleting a preset';
    try {
      const updated = deleteUserPreset(projectPath, name);
      setUserPresets(updated);
      return null;
    } catch {
      return 'could not delete the workspace preset';
    }
  }, [projectPath]);

  const handleProjectOpened = useCallback((target: LaunchTarget) => {
    clearLoadingHideTimer();
    clearProjectOpenPublish();
    const nextUserPresets = loadUserPresets(target.path);
    const nextWorkspace = loadActiveWorkspace(target.path, nextUserPresets) ?? DEFAULT_WORKSPACE;
    restoreWorkspacePresetLayout(target.path, nextWorkspace);
    setProjectPath(target.path);
    setUserPresets(nextUserPresets);
    setWorkspace(nextWorkspace);
    appHostServer.resetProjectState(createAppHostInitialState());
    appHostServer.setState('project', { path: target.path, name: target.name });
    appHostServer.setState('workspace', nextWorkspace);
    /* hydrate user skills from disk so the agent panel shows them after reload */
    tauriInvoke<Array<Record<string, unknown>>>('skill_list')?.then((userSkills) => {
      for (const skill of userSkills ?? []) {
        appHostServer.handle({ kind: 'request', id: nextHostRpcId(), method: 'skills.write', params: skill }).catch(() => {});
      }
    }).catch(() => {});
    /* hydrate installed plugins from the newly opened project's on-disk registry
       so third-party panels show up without a restart. */
    tauriInvoke<PluginRef[]>('plugins_list_installed')?.then((records) => {
      for (const record of records ?? []) {
        appHostServer.handle({ kind: 'request', id: nextHostRpcId(), method: 'plugins.install', params: { plugin: record } }).catch(() => {});
      }
    }).catch(() => {});
    setContextItems([]);
    setContextByChat({});
    projectLoadingStartedAt.current = performance.now();
    setProjectLoading(true);
    setLauncherMode(null);
    if (typeof window.requestAnimationFrame === 'function') {
      const frame = window.requestAnimationFrame(() => {
        projectOpenPublishCancelRef.current = null;
        appHostServer.publish('project:opened', target);
        appHostServer.publish('fs:event', { kind: 'open', paths: [target.path] });
      });
      projectOpenPublishCancelRef.current = () => window.cancelAnimationFrame(frame);
    } else {
      const timer = window.setTimeout(() => {
        projectOpenPublishCancelRef.current = null;
        appHostServer.publish('project:opened', target);
        appHostServer.publish('fs:event', { kind: 'open', paths: [target.path] });
      }, 16);
      projectOpenPublishCancelRef.current = () => window.clearTimeout(timer);
    }
    scheduleWorkspaceMount();
  }, [clearLoadingHideTimer, clearProjectOpenPublish, scheduleWorkspaceMount]);

  useEffect(() => {
    const status = tauriInvoke<ProjectStatusResult>('project_status');
    if (!status) return;
    let cancelled = false;
    status.then((project) => {
      if (!cancelled) appHostServer.setState('project', project);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectVersion]);

  const handleDockviewReady = useCallback(() => {
    if (!projectLoadingStartedAt.current) return;
    const elapsed = performance.now() - projectLoadingStartedAt.current;
    const remaining = Math.max(0, 650 - elapsed);
    clearLoadingHideTimer();
    loadingHideTimerRef.current = window.setTimeout(() => {
      loadingHideTimerRef.current = null;
      projectLoadingStartedAt.current = 0;
      setProjectLoading(false);
    }, remaining);
  }, [clearLoadingHideTimer]);

  useEffect(() => () => {
    clearWorkspaceMountSchedule();
    clearLoadingHideTimer();
    clearProjectOpenPublish();
  }, [clearLoadingHideTimer, clearProjectOpenPublish, clearWorkspaceMountSchedule]);

  /* post-boot prefetch driver (phases 1+2). while the loading screen is
     up nothing prewarms — the loading frame must be uncontested or the
     backdrop-blur tanks with monaco/xterm/lazy-chunk parses fighting it.
     once projectLoading flips false we start dynamic-importing every
     plugin chunk one-per-rAF, ordered by the preset's emphasis hints
     first then defaultOrder. dynamic imports don't construct any
     surfaces (no editor instance, no pty_spawn) — they just warm the
     module cache so React.lazy mounts synchronously on first click. */
  useEffect(() => {
    if (projectLoading) return;
    if (!workspaceMounted) return;

    const emphasis = workspacePreset.emphasis ?? [];
    const ordered = [...ALL_PLUGINS].sort((a, b) => {
      const aIdx = emphasis.indexOf(a.slot);
      const bIdx = emphasis.indexOf(b.slot);
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return (a.defaultOrder ?? 999) - (b.defaultOrder ?? 999);
    });

    let cancelled = false;
    let rafId: number | null = null;
    let startTimer: number | null = null;
    let cursor = 0;

    const step = () => {
      if (cancelled) return;
      if (cursor >= ordered.length) {
        /* mark boot prefetch complete so dockview can hydrate user clicks
           without the 80ms cascade-debounce — by now every panel's chunk
           is hot, so visibility flips can map straight to setHydrated. */
        document.body.dataset.polyporeBootHydrated = '1';
        return;
      }
      const plugin = ordered[cursor++];
      /* idempotent — repeated calls share the cached loader promise so
         prefetching a slot that the user already focused is free. */
      pluginPrefetch(plugin)?.().catch(() => {});
      /* deep prefetch — e.g. editor's monaco-editor/editor.main, the
         3.3MB chunk that the component dynamic-imports on first mount.
         fire-and-forget; the network is the bottleneck, not main-thread. */
      plugin.prefetch?.().catch(() => {});
      rafId = window.requestAnimationFrame(step);
    };

    /* small initial delay so the first uncontested workspace paint
       (loading screen just dismissed) lands before we start kicking
       background module fetches. */
    startTimer = window.setTimeout(() => {
      startTimer = null;
      rafId = window.requestAnimationFrame(step);
    }, 80);

    return () => {
      cancelled = true;
      delete document.body.dataset.polyporeBootHydrated;
      if (startTimer !== null) window.clearTimeout(startTimer);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [projectLoading, workspaceMounted, workspacePreset]);

  /* tool-card clicks from agent surfaces focus the agent panel. dockview's
     window-exposed API mounts the panel if it's not already open. */
  const focusAgentTab = useCallback(() => {
    dockviewApi()?.focusOrAdd('extensions');
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent<ChatPluginMessage>) => {
      const data = event.data;
      if (!data || data.source !== 'polypore.chat') return;
      if (!event.source || !isLegacyChatFrameSource(event.source)) return;

      const agentSlot = data.agent && data.agent in PANEL_META ? data.agent : 'codex';
      if (data.type === 'tool-card') focusAgentTab();
      if (data.type === 'open-settings') openPanelSettings(agentSlot);
      if (data.type === 'open-help') setPanelHelpFor(agentSlot);
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [focusAgentTab, openPanelSettings]);

  useEffect(() => {
    /* fire-and-forget mcp boot — the supervisor restarts it on crash and the
       sidecar wires itself to the host_broker. status surfaces via panels
       that care (the agent panel), not the top bar. */
    tauriInvoke<{ message: string }>('mcp_server_start')?.catch(() => {});
  }, [projectVersion]);

  useEffect(() => {
    const unlisten = tauriListen<AgentRuntimeEventPayload>('polypore://agent-event', (payload) => {
      const event = payload.event.kind === 'tool-call'
        ? { kind: 'tool-call' as const, toolName: payload.event.toolName, summary: payload.event.summary }
        : payload.event.kind === 'permission'
          ? { kind: 'permission' as const, summary: payload.event.summary }
          : { kind: 'message' as const, text: payload.event.text };
      appHostServer.recordAgentRuntimeEvent({
        agent: payload.agent,
        adapter: payload.adapter,
        sessionId: payload.sessionId,
        event,
      });
    });
    if (!unlisten) return;
    let disposed = false;
    unlisten.then((dispose) => {
      if (disposed) dispose();
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten.then((dispose) => dispose()).catch(() => {});
    };
  }, [projectVersion]);

  useEffect(() => {
    const unlisten = tauriListen<McpHostRpcEvent>('polypore://mcp-host-rpc', async (payload) => {
      const rpcId = nextHostRpcId();
      const response = MCP_HOST_RPC_ALLOWED_METHODS.has(payload.method)
        ? await appHostServer.handle({
          kind: 'request',
          id: rpcId,
          method: payload.method,
          params: payload.params ?? {},
        })
        : {
          kind: 'response' as const,
          id: rpcId,
          ok: false as const,
          error: {
            code: 'permission_not_declared' as const,
            message: `mcp host broker method not allowed: ${payload.method}`,
          },
        };
      await tauriInvoke('mcp_host_rpc_respond', { id: payload.id, response });
    });
    if (!unlisten) return;
    let disposed = false;
    unlisten.then((dispose) => {
      if (disposed) dispose();
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten.then((dispose) => dispose()).catch(() => {});
    };
  }, [projectVersion]);

  useEffect(() => {
    const unlisten = tauriListen<{ id: string; prompt: string }>('polypore://askpass-prompt', (payload) => {
      setAskpassPrompt({ id: payload.id, prompt: payload.prompt });
    });
    if (!unlisten) return;
    let disposed = false;
    unlisten.then((dispose) => {
      if (disposed) dispose();
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten.then((dispose) => dispose()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    /* keep host state in sync with the renderer's currently-active session
       agent. agent probe (acp vs stdio) doesn't surface anywhere in chrome
       per spec §12 — panels that need it (e.g., chat) read it themselves. */
    appHostServer.setState('activeAgent', activeAgent);
    tauriInvoke<AgentRuntimeStatus>('agent_probe', { agent: activeAgent })?.catch(() => {});
  }, [activeAgent]);

  useEffect(() => {
    tauriInvoke<AgentBinaryStatus[]>('project_agent_status')?.then((agents) => {
      appHostServer.setState('formation', agents.map((agent, index) => ({
        id: agent.agent,
        role: agent.agent,
        detail: agent.available ? '' : 'runtime unavailable',
        status: agent.available ? (agent.agent === activeAgent ? 'running' : 'idle') : 'missing',
        model: 'runtime',
        left: `${20 + index * 26}%`,
        top: index === 0 ? '70px' : '170px',
        root: agent.agent === 'claude' || agent.agent === 'codex',
      })));
    }).catch(() => {});
  }, [activeAgent]);

  useEffect(() => {
    /* lsp + updater run probes in the shell — diagnostics surface via the
       editor's marker overlays and the verify panel; updater check fires
       in the background and (when configured) prompts via ui.notify. */
    tauriInvoke<LspStatusResult>('lsp_status')?.catch(() => {});
    tauriInvoke<UpdaterStatusResult>('updater_status')?.catch(() => {});
  }, []);

  /* boot or re-root the shell-side fs watcher and re-publish its events into
     the host bus so editor / diff-history panels can refresh without polling. */
  useEffect(() => {
    const started = tauriInvoke<{ root: string | null }>('fs_watch_status');
    started?.catch(() => {});
    const unlisten = tauriListen<{ kind: string; paths: string[] }>('polypore://fs-event', (payload) => {
      appHostServer.publish('fs:event', payload);
      for (const path of payload.paths) appHostServer.publish(`editor:${path}`, { path, kind: payload.kind });
    });
    if (!unlisten) return;
    let disposed = false;
    unlisten.then((dispose) => { if (disposed) dispose(); }).catch(() => {});
    return () => {
      disposed = true;
      unlisten.then((dispose) => dispose()).catch(() => {});
    };
  }, [projectVersion]);

  /* Bootstrap autosavers for all worktrees on project open, then load
  persisted history events. The scheduler ensures an initial autosave exists
  for each registered worktree. */
  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      try {
        const worktreesCall = tauriInvoke<WorktreeListShellResult[]>('worktrees_list');
        if (!worktreesCall) return;
        const worktrees = await worktreesCall;
        if (cancelled || worktrees.length === 0) return;
        const bootstrapCall = tauriInvoke<void>('snapshot_bootstrap', {
          worktrees: worktrees.map((w) => ({ id: w.id, path: w.path })),
        });
        if (bootstrapCall) await bootstrapCall.catch(() => {});
        const current = worktrees.find((w) => w.isCurrent);
        if (current) appHostServer.setActiveWorktreeId(current.id);
        const eventsCall = tauriInvoke<HistoryEvent[]>('history_events_list', {
          worktreeId: null,
          limit: 500,
        });
        if (eventsCall) {
          const events = await eventsCall.catch(() => [] as HistoryEvent[]);
          if (!cancelled && Array.isArray(events)) appHostServer.loadHistoryEvents(events);
        }
      } catch (err) {
        console.warn('autosave bootstrap failed', err);
      }
    };
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [projectVersion]);

  useEffect(() => {
    const unlisten = tauriListen<SnapshotRecord>('polypore://snapshot-taken', (record) => {
      appHostServer.recordHistoryEvent({
        ts: record.ts,
        taskId: 'active',
        source: record.kind === 'manual' ? 'human' : 'agent',
        kind: 'snapshot',
        summary: `${record.kind} autosave @ ${new Date(record.ts).toLocaleTimeString()}`,
        affectedFiles: [],
        worktreeId: record.worktreeId,
        snapshotCommit: record.commitHash,
      });
    });
    if (!unlisten) return;
    let disposed = false;
    unlisten.then((dispose) => { if (disposed) dispose(); }).catch(() => {});
    return () => {
      disposed = true;
      unlisten.then((dispose) => dispose()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const unlisten = tauriListen<PtyEventPayload>('polypore://pty-event', (payload) => {
      appHostServer.publish('terminal:event', payload);
    });
    if (!unlisten) return;
    let disposed = false;
    unlisten.then((dispose) => { if (disposed) dispose(); }).catch(() => {});
    return () => {
      disposed = true;
      unlisten.then((dispose) => dispose()).catch(() => {});
    };
  }, []);

  return (
    <>
    <main className="app-shell">
      {workspaceMounted && (
        <>
          <TopBar
            workspace={workspace}
            defaultWorkspace={DEFAULT_WORKSPACE}
            defaultBranch={DEFAULT_BRANCH}
            panelLabel={(slot) => panelMeta(slot).label}
            onWorkspaceChange={handleWorkspaceChange}
            onResetWorkspace={handleResetWorkspace}
            onOpenSettings={() => openSettings()}
            onOpenHelp={() => setPanelHelpFor('overview')}
            projectVersion={projectVersion}
            onProjectOpened={handleProjectOpened}
            onOpenProjectLauncher={(mode) => { setLauncherMode(mode); setLauncherDismissable(true); }}
            tauriInvoke={tauriInvoke}
            userPresets={userPresets}
            onSaveAsPreset={handleSaveAsPreset}
            onDeletePreset={handleDeletePreset}
          />

          <React.Suspense fallback={null}>
            <PolyporeDockview
              key={`${projectVersion}-${workspaceVersion}`}
              ctx={dockviewContext}
              initialLayout={workspacePreset.layout}
              layoutStorageKey={layoutStorageKey}
              onReady={handleDockviewReady}
            />
          </React.Suspense>

          <BottomBar
            projectVersion={projectVersion}
            defaultBranch={DEFAULT_BRANCH}
            tauriInvoke={tauriInvoke}
          />
        </>
      )}

      {projectLoading && <PolyporeLoadingScreen />}

      {panelHelpFor && (
        <ManualSurface
          corpus={manualCorpus}
          initialSlug={manualSlugForSlot(manualCorpus, panelCatalog, panelHelpFor)}
          scopeLabel={panelMeta(panelHelpFor).label}
          getChatTargets={async () => {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            return openChatPanelTargets().map((t) => ({ id: t.id, title: t.title || t.agent }));
          }}
          onAskAgent={(section, targetId) => {
            const prompt = manualAgentPrompt(section);
            const targets = openChatPanelTargets();
            const target = targetId
              ? (targets.find((t) => t.id === targetId) ?? targets[0])
              : (targets.find((t) => t.agent === activeAgent) ?? targets[0]);
            if (target) {
              void deliverPromptToTarget(target, prompt).catch(() => addToContext(prompt));
            } else {
              addToContext(prompt);
              focusAgentTab();
            }
            setPanelHelpFor(null);
          }}
          onClose={() => setPanelHelpFor(null)}
        />
      )}

      {settingsTarget && (
        <SettingsSurface
          key={settingsTarget.nonce}
          services={settingsServices}
          initialSection={settingsTarget.section}
          initialPanelSlot={settingsTarget.panelSlot}
          initialProjectGroup={settingsTarget.projectGroup}
          panelCatalog={panelCatalog}
          onRequestAgent={(prompt) => {
            addToContext(prompt);
            focusAgentTab();
            setSettingsTarget(null);
          }}
          onClose={() => setSettingsTarget(null)}
        />
      )}
      {confirmRequest && (
        <HostConfirmOverlay
          request={confirmRequest.request}
          onCancel={() => closeConfirm(false)}
          onConfirm={(decision) => closeConfirm(decision)}
        />
      )}
      {inputBoxRequest && (
        <HostInputBoxOverlay
          prompt={inputBoxRequest.prompt}
          placeholder={inputBoxRequest.placeholder}
          initialValue={inputBoxRequest.value}
          onCancel={() => {
            inputBoxRequest.resolve(null);
            setInputBoxRequest(null);
          }}
          onSubmit={(value) => {
            inputBoxRequest.resolve(value);
            setInputBoxRequest(null);
          }}
        />
      )}
      {askpassPrompt && (
        <HostInputBoxOverlay
          prompt={askpassPrompt.prompt}
          secret
          onCancel={() => {
            tauriInvoke('askpass_cancel', { id: askpassPrompt.id })?.catch(() => {});
            setAskpassPrompt(null);
          }}
          onSubmit={(value) => {
            tauriInvoke('askpass_respond', { id: askpassPrompt.id, secret: value })?.catch(() => {});
            setAskpassPrompt(null);
          }}
        />
      )}
    </main>
    {launcherMode && (
      <div
        className={`project-launcher-modal project-launcher-modal--active ${!launcherDismissable && projectVersion === 0 ? 'project-launcher-modal--boot' : ''}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label="project launcher"
      >
        <Launcher
          initialMode={launcherMode}
          onOpen={handleProjectOpened}
          /* on the initial boot the launcher is the gate and has no
             close affordance. once a project is loaded — or the user
             opens it via the top-bar project menu — it becomes
             dismissable. */
          onDismiss={
            launcherDismissable || projectVersion > 0
              ? () => setLauncherMode(null)
              : undefined
          }
        />
      </div>
    )}
    </>
  );
}

/* every layout-related helper that used to live here (ChatPluginFrame,
   DockviewStage, DockviewBuildPanel, TabStrip, AddPopover, BuildSurface)
   has been collapsed into PolyporeDockview + PanelSurface. App.tsx now
   only owns app-level state (workspace, context items, overlay routing)
   and delegates every panel to dockview. */


/* PanelHeader was moved to plugins/shared so every panel package can render
   the gear+help controls without crossing the src boundary. */

/* synchronous snapshot of every registered plugin, used as the initial panel
   view before host.plugins.list resolves. derived from the same discovery
   that powers the registry — single source of truth. */
const INSTALLED_PLUGINS_SNAPSHOT = ALL_PLUGINS.map((plugin) => ({
  id: plugin.manifest.id,
  title: plugin.meta.label,
  source: 'builtin',
  enabled: true,
}));


export default App;
