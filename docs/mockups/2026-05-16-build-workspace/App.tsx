import React, { useState } from 'react';
import './App.css';
import { initialOperatorState, timelineEvents } from './core/sampleData';
import { AgentId, PanelType, WorkspaceName } from './core/types';
import { workspacePresets } from './workspaces/presets';

const PANEL_META: Record<PanelType, { icon: string; label: string }> = {
  chat: { icon: '/>', label: 'chat' },
  preview: { icon: 'run', label: 'preview' },
  editor: { icon: '{}', label: 'editor' },
  'diff-stack': { icon: '+-', label: 'diff' },
  terminal: { icon: '$', label: 'terminal' },
  verify: { icon: 'vf', label: 'verify' },
  memory: { icon: 'kb', label: 'memory' },
  extensions: { icon: 'ai', label: 'agent' },
  problems: { icon: '!', label: 'problems' },
  timeline: { icon: 'ts', label: 'history' },
};

const AGENT_META: Record<AgentId, { icon: string; label: string }> = {
  cursor: { icon: 'cs', label: 'cursor' },
  claude: { icon: 'cl', label: 'claude' },
  codex: { icon: 'cd', label: 'codex' },
};

type AddableItem =
  | { kind: 'agent'; agent: AgentId; label: string; icon: string }
  | { kind: 'panel'; panelType: PanelType; label: string; icon: string };

const ADDABLE: AddableItem[] = [
  { kind: 'agent', agent: 'codex', label: AGENT_META.codex.label, icon: AGENT_META.codex.icon },
  { kind: 'agent', agent: 'claude', label: AGENT_META.claude.label, icon: AGENT_META.claude.icon },
  { kind: 'panel', panelType: 'preview', label: PANEL_META.preview.label, icon: PANEL_META.preview.icon },
  { kind: 'panel', panelType: 'editor', label: PANEL_META.editor.label, icon: PANEL_META.editor.icon },
  { kind: 'panel', panelType: 'diff-stack', label: PANEL_META['diff-stack'].label, icon: PANEL_META['diff-stack'].icon },
  { kind: 'panel', panelType: 'terminal', label: PANEL_META.terminal.label, icon: PANEL_META.terminal.icon },
  { kind: 'panel', panelType: 'verify', label: PANEL_META.verify.label, icon: PANEL_META.verify.icon },
  { kind: 'panel', panelType: 'memory', label: PANEL_META.memory.label, icon: PANEL_META.memory.icon },
  { kind: 'panel', panelType: 'extensions', label: PANEL_META.extensions.label, icon: PANEL_META.extensions.icon },
];

const permissionModes = [
  { id: 'plan', label: 'plan', hint: 'ask before changes' },
  { id: 'default', label: 'default', hint: 'standard approvals' },
  { id: 'acceptEdits', label: 'accept edits', hint: 'apply file edits' },
  { id: 'auto', label: 'auto', hint: 'run trusted actions' },
  { id: 'bypass', label: 'bypass', hint: 'full local autonomy' },
] as const;

type StageTab = { id: string; panelType: PanelType };

const DEFAULT_TABS: StageTab[] = [
  { id: 't-preview', panelType: 'preview' },
  { id: 't-editor', panelType: 'editor' },
  { id: 't-diff', panelType: 'diff-stack' },
  { id: 't-terminal', panelType: 'terminal' },
  { id: 't-verify', panelType: 'verify' },
  { id: 't-memory', panelType: 'memory' },
  { id: 't-agent', panelType: 'extensions' },
];

const chatMessages = [
  { by: 'user', text: 'build the operator workspace from the prd, but keep the ui riced and minimal.' },
  { by: 'agent', text: 'demo mode: no acp runtime is connected yet. this shell is showing intended surfaces.' },
];

type ChatSession = {
  id: string;
  agent: AgentId;
  title: string;
  messages: Array<{ by: 'user' | 'agent'; text: string }>;
  draft: string;
};

const toolCards = [
  { id: 'tool-1', name: 'shell', summary: 'npm run build completed successfully', status: 'ok' },
  { id: 'tool-2', name: 'browser', summary: 'preview viewport captured for active run', status: 'live' },
];

const skillCards = [
  { id: 'skill-tdd', name: 'evanflow-tdd', summary: 'vertical-slice tdd loop for any production code' },
  { id: 'skill-review', name: 'security-review', summary: 'full security review of pending branch changes' },
  { id: 'skill-simplify', name: 'simplify', summary: 'audit changed code for reuse, quality, efficiency' },
  { id: 'skill-semgrep', name: 'semgrep', summary: 'static analysis scan with parallel language workers' },
  { id: 'skill-supply', name: 'supply-chain-risk-auditor', summary: 'flag dependencies at takeover or exploit risk' },
  { id: 'skill-claude-api', name: 'claude-api', summary: 'build and tune anthropic sdk apps with caching' },
];

const files = [
  'src/app.tsx',
  'src/app.css',
  'src/core/types.ts',
  'docs/ui-direction.md',
];

type FileNode =
  | { kind: 'file'; name: string; path: string; subtitle?: string }
  | { kind: 'folder'; name: string; children: FileNode[] };

const codeFileTree: FileNode[] = [
  {
    kind: 'folder',
    name: 'src',
    children: [
      { kind: 'file', name: 'app.tsx', path: 'src/app.tsx' },
      { kind: 'file', name: 'app.css', path: 'src/app.css' },
      {
        kind: 'folder',
        name: 'core',
        children: [
          { kind: 'file', name: 'types.ts', path: 'src/core/types.ts' },
          { kind: 'file', name: 'eventBus.ts', path: 'src/core/eventBus.ts' },
          { kind: 'file', name: 'sampleData.ts', path: 'src/core/sampleData.ts' },
        ],
      },
      {
        kind: 'folder',
        name: 'workspaces',
        children: [
          { kind: 'file', name: 'presets.ts', path: 'src/workspaces/presets.ts' },
        ],
      },
    ],
  },
  {
    kind: 'folder',
    name: 'docs',
    children: [
      { kind: 'file', name: 'ui-direction.md', path: 'docs/ui-direction.md' },
    ],
  },
  { kind: 'file', name: 'README.md', path: 'README.md' },
];

const codeFileMeta: Record<string, { name: string; language: string; status?: 'M' | 'A'; diagnostics?: number; dirty?: boolean; lines: string[] }> = {
  'src/app.tsx': {
    name: 'app.tsx',
    language: 'tsx',
    status: 'M',
    dirty: true,
    diagnostics: 1,
    lines: [
      'function buildWorkspace() {',
      '  return {',
      "    visual: 'glassy-rice',",
      "    background: 'fungus-photo',",
      "    tabs: ['preview', 'editor', 'diff', 'terminal'],",
      '  };',
      '}',
    ],
  },
  'src/app.css': {
    name: 'app.css',
    language: 'css',
    status: 'M',
    lines: [
      '.code-shell {',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 8px;',
      '}',
    ],
  },
  'src/core/types.ts': {
    name: 'types.ts',
    language: 'ts',
    diagnostics: 1,
    lines: [
      "export type PanelType = 'chat' | 'preview' | 'editor';",
      '',
      'export type PreviewSession = {',
      '  id: string;',
      "  status: 'idle' | 'running' | 'external';",
      '};',
    ],
  },
  'docs/ui-direction.md': {
    name: 'ui-direction.md',
    language: 'md',
    lines: [
      '# operator ide ui direction',
      '',
      '- preview is generic runtime output, not web-only.',
      '- code exposes a compact file picker and editor surface.',
    ],
  },
  'README.md': {
    name: 'README.md',
    language: 'md',
    status: 'A',
    lines: [
      '# polypore',
      '',
      'operator workspace prototype for coding agents.',
    ],
  },
};

const diffFileMeta: Record<string, { status: 'M' | 'A' | 'D'; added: number; removed: number; source: AgentId | 'human'; lines: Array<{ oldNo?: number; newNo?: number; oldText?: string; newText?: string; kind?: 'same' | 'add' | 'remove' | 'change' }> }> = {
  'src/app.tsx': {
    status: 'M',
    added: 80,
    removed: 12,
    source: 'codex',
    lines: [
      { oldNo: 1154, newNo: 1154, oldText: 'function PreviewSurface({ header }) {', newText: 'function PreviewSurface({ header }) {' },
      { oldNo: 1155, newNo: 1155, oldText: "  const [status, setStatus] = useState('idle');", newText: "  const [status, setStatus] = useState('idle');" },
      { oldNo: 1156, oldText: '', newNo: 1156, newText: '  const [logsOpen, setLogsOpen] = useState(false);', kind: 'add' },
      { oldNo: 1197, newNo: 1210, oldText: '            <strong>embedded output</strong>', newText: '            <strong>embedded output</strong>' },
      { oldNo: 1200, oldText: '              <button>run outside window</button>', newNo: 1217, newText: '              <button onClick={runOutside}>run outside window</button>', kind: 'change' },
      { newNo: 1220, newText: '              <button aria-expanded={logsOpen}>logs</button>', kind: 'add' },
      { newNo: 1233, newText: '            <aside className="preview-log-drawer">', kind: 'add' },
    ],
  },
  'src/App.css': {
    status: 'M',
    added: 42,
    removed: 8,
    source: 'codex',
    lines: [
      { oldNo: 827, newNo: 827, oldText: '.preview-output {', newText: '.preview-output {' },
      { newNo: 828, newText: '  position: relative;', kind: 'add' },
      { oldNo: 860, oldText: '.preview-output header div {', newNo: 861, newText: '.preview-output__controls {', kind: 'change' },
      { newNo: 1100, newText: '.preview-log-drawer {', kind: 'add' },
      { newNo: 1114, newText: '  justify-content: space-between;', kind: 'add' },
    ],
  },
  'src/App.test.tsx': {
    status: 'M',
    added: 20,
    removed: 3,
    source: 'codex',
    lines: [
      { oldNo: 98, newNo: 98, oldText: "fireEvent.click(screen.getByRole('button', { name: /run in window/i }));", newText: "fireEvent.click(screen.getByRole('button', { name: /run in window/i }));" },
      { newNo: 106, newText: "fireEvent.click(screen.getByRole('button', { name: /^logs$/i }));", kind: 'add' },
      { newNo: 107, newText: "expect(screen.getByRole('complementary', { name: /preview logs/i })).toBeInTheDocument();", kind: 'add' },
    ],
  },
  'src/workspaces/presets.ts': {
    status: 'A',
    added: 6,
    removed: 0,
    source: 'codex',
    lines: [
      { newNo: 1, newText: "export const workspacePresets = [{", kind: 'add' },
      { newNo: 2, newText: "  name: 'Build',", kind: 'add' },
      { newNo: 3, newText: "  panels: ['chat', 'preview', 'editor', 'diff-stack'],", kind: 'add' },
      { newNo: 4, newText: '}];', kind: 'add' },
    ],
  },
  'src/core/types.ts': {
    status: 'M',
    added: 12,
    removed: 3,
    source: 'codex',
    lines: [
      { oldNo: 64, newNo: 64, oldText: "  | 'preview'", newText: "  | 'preview'" },
      { oldNo: 65, newNo: 65, oldText: "  | 'verify';", newText: "  | 'verify'" },
      { newNo: 66, newText: "  | 'memory'", kind: 'add' },
      { newNo: 67, newText: "  | 'timeline';", kind: 'add' },
    ],
  },
};

const memoryFileTree: FileNode[] = [
  {
    kind: 'folder',
    name: 'docs',
    children: [
      { kind: 'file', name: 'project index', path: '.knowledge/docs/index.md' },
      { kind: 'file', name: 'ui direction', path: 'docs/ui-direction.md' },
    ],
  },
  {
    kind: 'folder',
    name: 'agents',
    children: [
      { kind: 'file', name: 'agent conventions', path: '.knowledge/agents/conventions.md' },
      { kind: 'file', name: 'formation roles', path: '.knowledge/agents/formation.md' },
    ],
  },
  {
    kind: 'folder',
    name: 'adrs',
    children: [
      { kind: 'file', name: 'dockable shell', path: '.knowledge/adrs/dockable-shell.md' },
      { kind: 'file', name: 'history restore points', path: '.knowledge/adrs/history-restore.md' },
    ],
  },
];

const taskItems = [
  { id: 'visual', label: 'rebuild default shell around build workspace only', done: true },
  { id: 'agent', label: 'finalize agent surface naming', done: true },
  { id: 'settings', label: 'add settings access in the top bar', done: true },
  { id: 'dockview', label: 'replace mock docking with real dockview layout persistence', done: false },
];

const formationNodes = [
  { id: 'overseer', role: 'overseer', status: 'running', detail: 'task conductor', left: '50%', top: 18, root: true },
  { id: 'frontend', role: 'frontend', status: 'idle', detail: 'ui implementation', left: '18%', top: 170, root: false },
  { id: 'cybersecurity', role: 'cybersecurity', status: 'waiting', detail: 'review scope', left: '50%', top: 170, root: false },
  { id: 'qa', role: 'qa', status: 'idle', detail: 'verification', left: '82%', top: 170, root: false },
] as const;

type ProblemItem = {
  id: string;
  severity: 'error' | 'warn';
  file: string;
  line: number;
  msg: string;
};

type CheckItem = {
  id: string;
  label: string;
  cmd: string;
  status: 'ok' | 'fail' | 'pending';
  ms: number | null;
};

type QueueItem = {
  id: string;
  source: 'problem' | 'check';
  sourceId: string;
  label: string;
  detail?: string;
  status: 'pending' | 'fixing' | 'done' | 'failed';
};

type PreviewTargetKind = 'site' | 'desktop' | 'mobile' | 'cli' | 'game' | 'test';

type PreviewTargetConfig = {
  id: PreviewTargetKind;
  label: string;
  hint: string;
  icon: string;
  commandLabel: string;
  commandPlaceholder: string;
  defaultCommand: string;
  targetLabel: string;
  targetPlaceholder: string;
  defaultTarget: string;
};

const previewTargetKinds: PreviewTargetConfig[] = [
  {
    id: 'site',
    label: 'site',
    hint: 'localhost or hosted URL',
    icon: 'www',
    commandLabel: 'command',
    commandPlaceholder: 'npm start',
    defaultCommand: 'npm start',
    targetLabel: 'address',
    targetPlaceholder: 'http://localhost:3000',
    defaultTarget: 'http://localhost:3000',
  },
  {
    id: 'desktop',
    label: 'app',
    hint: 'desktop or native app',
    icon: 'win',
    commandLabel: 'launch command',
    commandPlaceholder: 'npm run app',
    defaultCommand: 'npm run app',
    targetLabel: 'app target',
    targetPlaceholder: 'desktop / default',
    defaultTarget: 'desktop / default',
  },
  {
    id: 'mobile',
    label: 'mobile',
    hint: 'simulator or device target',
    icon: 'mob',
    commandLabel: 'launch command',
    commandPlaceholder: 'npm run ios',
    defaultCommand: 'npm run ios',
    targetLabel: 'device',
    targetPlaceholder: 'iPhone 15 simulator',
    defaultTarget: 'iPhone 15 simulator',
  },
  {
    id: 'cli',
    label: 'cli',
    hint: 'terminal process output',
    icon: '$_',
    commandLabel: 'command',
    commandPlaceholder: 'npm run dev',
    defaultCommand: 'npm run dev',
    targetLabel: 'working directory',
    targetPlaceholder: '.',
    defaultTarget: '.',
  },
  {
    id: 'game',
    label: 'game',
    hint: 'canvas, engine, or playable viewport',
    icon: 'pad',
    commandLabel: 'run command',
    commandPlaceholder: 'npm run game',
    defaultCommand: 'npm run game',
    targetLabel: 'playable URL',
    targetPlaceholder: 'http://localhost:3000',
    defaultTarget: 'http://localhost:3000',
  },
  {
    id: 'test',
    label: 'test',
    hint: 'runner UI or structured output',
    icon: 'ok',
    commandLabel: 'test command',
    commandPlaceholder: 'npm test',
    defaultCommand: 'npm test',
    targetLabel: 'reporter',
    targetPlaceholder: 'watch output',
    defaultTarget: 'watch output',
  },
];

const initialProblems: ProblemItem[] = [
  { id: 'p1', severity: 'error', file: 'src/core/types.ts', line: 42, msg: "missing 'phase-reporting' implementation for codex shim" },
  { id: 'p2', severity: 'warn', file: 'src/App.tsx', line: 88, msg: 'inline style array could move to css' },
  { id: 'p3', severity: 'warn', file: 'src/workspaces/presets.ts', line: 14, msg: 'unused import: PanelType' },
];

const initialChecks: CheckItem[] = [
  { id: 'c1', label: 'typecheck', cmd: 'npm run build', status: 'ok', ms: 4120 },
  { id: 'c2', label: 'tests', cmd: 'npm test -- --watchAll=false', status: 'fail', ms: 2890 },
  { id: 'c3', label: 'lint', cmd: 'npm run lint', status: 'pending', ms: null },
];

const FIX_ITEM_MIME = 'application/x-fix-item';
const QUEUE_ITEM_MIME = 'application/x-queue-item';

const PANEL_MANUAL: Record<PanelType, { summary: string; tips: string[] }> = {
  chat: {
    summary: 'conversation surface for the active agent. multiple sessions live in the tab strip; tool-call cards link into the agent panel.',
    tips: [
      'enter sends; shift-enter for newline (planned)',
      '+ opens an agent picker for a new session',
      'tool-call cards jump to the agent activity feed',
    ],
  },
  preview: {
    summary: 'active runtime surface for the project — web viewport, cli output, test runner, or any registered run target.',
    tips: ['agents register a preview via the register_preview MCP tool', 'manual refresh from the panel header (planned)'],
  },
  editor: {
    summary: 'monaco-backed code editor with file tree and ctrl+p fuzzy file finder. lsp diagnostics surface inline and in the verify panel.',
    tips: ['ctrl+p — fuzzy find files', 'click the file bar to open the picker', 'lsp servers must be installed locally'],
  },
  'diff-stack': {
    summary: 'changed-file list fused with the timeline. scrub the history rail to inspect diffs at any past point; fork or revert from there.',
    tips: ['click any history entry to scrub', 'fork from here creates an isolated worktree', 'revert rewinds the working tree'],
  },
  terminal: {
    summary: 'xterm-backed shell for ad-hoc commands. distinct from verify — verify runs structured agent checks; this is for humans.',
    tips: ['multi-tab support (planned)', 'pty backed by node-pty in the desktop build'],
  },
  verify: {
    summary: 'problems and checks on the left, a fix queue on the right. drag items into the queue, then run to have the agent fix them sequentially.',
    tips: ['drag problems or checks into the queue', '+ add to author custom items', 'send to chat picks a target when multiple chats are open'],
  },
  memory: {
    summary: 'context view (left), knowledge base tree (middle), and document pane (right). drag knowledge files into the context list to load them.',
    tips: ['drag a file from the tree to context', '[[wikilinks]] jump between docs', 'handoff docs replace context compaction'],
  },
  extensions: {
    summary: 'agent cockpit. activity + tasks on the left; formation hierarchy on the right for orchestrating roles like overseer / frontend / qa.',
    tips: ['+ node opens role configuration', 'each node holds its own model/tool scope', 'edges encode handoff routes'],
  },
  problems: {
    summary: 'aggregated lsp diagnostics across the project. click an entry to jump to the source location.',
    tips: ['filter by severity / file / source (planned)', 'live-updates from connected lsp servers'],
  },
  timeline: {
    summary: 'unified stream of every agent tool call and human edit for the active task. each entry is a restore point.',
    tips: ['click an entry to scrub', 'retry-from-here forks a worktree', 'filter chips by source / tool / file (planned)'],
  },
};

function App() {
  const [workspace, setWorkspace] = useState<WorkspaceName>(initialOperatorState.workspace);
  const [tabs, setTabs] = useState<StageTab[]>(DEFAULT_TABS);
  const [activeTabId, setActiveTabId] = useState<string>(DEFAULT_TABS[0].id);
  const [chatWidth, setChatWidth] = useState(33);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [addPickerOpen, setAddPickerOpen] = useState(false);
  const [chatAddPickerOpen, setChatAddPickerOpen] = useState(false);
  const [contextItems, setContextItems] = useState<string[]>([
    'included: src/app.tsx',
    'included: docs/ui-direction.md',
  ]);
  const [panelSettingsFor, setPanelSettingsFor] = useState<PanelType | null>(null);
  const [panelHelpFor, setPanelHelpFor] = useState<PanelType | null>(null);

  const [chatSessions, setChatSessions] = useState<ChatSession[]>([
    {
      id: 'chat-1',
      agent: 'codex',
      title: 'codex 1',
      messages: chatMessages as ChatSession['messages'],
      draft: '',
    },
  ]);
  const [activeChatId, setActiveChatId] = useState('chat-1');

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  const addTab = (panelType: PanelType) => {
    const id = `t-${panelType}-${Date.now()}`;
    setTabs((prev) => [...prev, { id, panelType }]);
    setActiveTabId(id);
    setAddPickerOpen(false);
  };

  const createChatSession = (agent: AgentId) => {
    const count = chatSessions.filter((session) => session.agent === agent).length + 1;
    const nextSession: ChatSession = {
      id: `${agent}-${Date.now()}`,
      agent,
      title: `${agent} ${count}`,
      messages: [
        {
          by: 'agent',
          text: `${agent} session ready. runtime wiring is still mocked in this prototype.`,
        },
      ],
      draft: '',
    };
    setChatSessions((sessions) => [...sessions, nextSession]);
    setActiveChatId(nextSession.id);
  };

  const closeChatSession = (chatId: string) => {
    if (chatSessions.length === 1) return;
    const idx = chatSessions.findIndex((session) => session.id === chatId);
    const nextSessions = chatSessions.filter((session) => session.id !== chatId);
    setChatSessions(nextSessions);
    if (activeChatId === chatId) {
      setActiveChatId(nextSessions[Math.max(0, idx - 1)].id);
    }
  };

  const updateChatDraft = (draft: string) => {
    setChatSessions((sessions) => sessions.map((session) => (
      session.id === activeChatId ? { ...session, draft } : session
    )));
  };

  const sendChatDraft = () => {
    const session = chatSessions.find((s) => s.id === activeChatId);
    const text = session?.draft.trim();
    if (!text) return;
    setChatSessions((sessions) => sessions.map((s) => (
      s.id === activeChatId
        ? { ...s, draft: '', messages: [...s.messages, { by: 'user', text }] }
        : s
    )));
  };

  const addItem = (item: AddableItem) => {
    if (item.kind === 'agent') {
      createChatSession(item.agent);
    } else {
      addTab(item.panelType);
    }
    setAddPickerOpen(false);
    setChatAddPickerOpen(false);
  };

  const closeTab = (id: string) => {
    if (tabs.length === 1) return;
    const idx = tabs.findIndex((tab) => tab.id === id);
    const next = tabs.filter((tab) => tab.id !== id);
    setTabs(next);
    if (activeTabId === id) {
      setActiveTabId(next[Math.max(0, idx - 1)].id);
    }
  };

  const reorderTab = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    setTabs((prev) => {
      const fromIdx = prev.findIndex((tab) => tab.id === fromId);
      const toIdx = prev.findIndex((tab) => tab.id === toId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
    setDraggedTabId(null);
  };

  const addToContext = (label: string) => {
    setContextItems((items) => (items.includes(label) ? items : [label, ...items]));
  };

  const focusAgentTab = () => {
    const agentTab = tabs.find((tab) => tab.panelType === 'extensions');
    if (agentTab) setActiveTabId(agentTab.id);
    else addTab('extensions');
  };

  return (
    <main className="app-shell">
      <TopBar
        workspace={workspace}
        onWorkspaceChange={setWorkspace}
      />

      <section
        className="dockspace"
        style={{
          gridTemplateColumns: `minmax(260px, ${chatWidth}vw) 8px minmax(0, 1fr)`,
        }}
      >
        <ChatRegion
          onToolCardClick={focusAgentTab}
          onOpenSettings={() => setPanelSettingsFor('chat')}
          onOpenHelp={() => setPanelHelpFor('chat')}
          chatSessions={chatSessions}
          activeChatId={activeChatId}
          onSelectChat={setActiveChatId}
          onCloseChat={closeChatSession}
          onUpdateDraft={updateChatDraft}
          onSendDraft={sendChatDraft}
          addPickerOpen={chatAddPickerOpen}
          onToggleAddPicker={() => setChatAddPickerOpen((open) => !open)}
          onAdd={addItem}
        />
        <ResizeHandle
          axis="x"
          label="resize chat panel"
          onDrag={(event) => {
            const next = (event.clientX / window.innerWidth) * 100;
            setChatWidth(Math.min(48, Math.max(22, next)));
          }}
        />

        <section className="stage">
          <TabStrip
            tabs={tabs}
            activeTabId={activeTab.id}
            draggedTabId={draggedTabId}
            onSelect={setActiveTabId}
            onClose={closeTab}
            onDragStart={setDraggedTabId}
            onDrop={reorderTab}
            onDragEnd={() => setDraggedTabId(null)}
            addPickerOpen={addPickerOpen}
            onToggleAdd={() => setAddPickerOpen((open) => !open)}
            onAdd={addItem}
          />

          <section className="active-surface">
            <BuildSurface
              activeTab={activeTab}
              contextItems={contextItems}
              onAddContext={addToContext}
              onOpenHelp={() => setPanelHelpFor(activeTab.panelType)}
              onOpenSettings={() => setPanelSettingsFor(activeTab.panelType)}
            />
          </section>
        </section>
      </section>

      <BottomBar />

      {panelSettingsFor && (
        <PanelSettingsOverlay
          panelType={panelSettingsFor}
          onClose={() => setPanelSettingsFor(null)}
        />
      )}

      {panelHelpFor && (
        <PanelHelpOverlay
          panelType={panelHelpFor}
          onClose={() => setPanelHelpFor(null)}
        />
      )}
    </main>
  );
}

function PanelSettingsOverlay({
  panelType,
  onClose,
}: {
  panelType: PanelType;
  onClose: () => void;
}) {
  const meta = PANEL_META[panelType];
  return (
    <div className="panel-settings-backdrop" role="presentation" onClick={onClose}>
      <div
        className="panel-settings-overlay"
        role="dialog"
        aria-label={`settings for ${meta.label}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <strong>settings · {meta.label}</strong>
          <button className="panel-settings-overlay__close" aria-label="close settings" onClick={onClose}>x</button>
        </header>
        <p>scoped slice of project settings for the {meta.label} panel. lands as a deep-link into the full settings page when one exists.</p>
        <div className="panel-settings-overlay__rows">
          <button>open full settings →</button>
          <button>reset {meta.label} defaults</button>
        </div>
      </div>
    </div>
  );
}

function PanelHelpOverlay({
  panelType,
  onClose,
}: {
  panelType: PanelType;
  onClose: () => void;
}) {
  const meta = PANEL_META[panelType];
  const manual = PANEL_MANUAL[panelType];
  return (
    <div className="panel-settings-backdrop" role="presentation" onClick={onClose}>
      <div
        className="panel-settings-overlay panel-help-overlay"
        role="dialog"
        aria-label={`manual for ${meta.label}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <strong>manual · {meta.label}</strong>
          <button className="panel-settings-overlay__close" aria-label="close manual" onClick={onClose}>x</button>
        </header>
        <p>{manual.summary}</p>
        <ul className="panel-help-overlay__tips">
          {manual.tips.map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
        <div className="panel-settings-overlay__rows">
          <button>open full docs →</button>
        </div>
      </div>
    </div>
  );
}

function TopBar({
  workspace,
  onWorkspaceChange,
}: {
  workspace: WorkspaceName;
  onWorkspaceChange: (workspace: WorkspaceName) => void;
}) {
  const [gitMenuOpen, setGitMenuOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [permissionMode, setPermissionMode] = useState<(typeof permissionModes)[number]['id']>('default');
  const activeMode = permissionModes.find((mode) => mode.id === permissionMode) ?? permissionModes[1];
  const gitActions = [
    'commit...',
    'pull',
    'push',
    'fetch',
    'new branch...',
    'checkout...',
    'merge...',
    'rebase...',
    'show log',
  ];

  return (
    <header className="topbar">
      <div className="segment segment--project" title="current project">operator-ide</div>
      <div className="git-branch-menu">
        <button
          className="segment branch-button"
          title="git branch"
          aria-label={`git branch ${initialOperatorState.branch}`}
          aria-haspopup="menu"
          aria-expanded={gitMenuOpen}
          onClick={() => setGitMenuOpen((open) => !open)}
        >
          <span className="branch-button__icon" aria-hidden="true">git</span>
          <span className="branch-button__name">{initialOperatorState.branch}</span>
          <span className="branch-button__chevron" aria-hidden="true">v</span>
        </button>
        {gitMenuOpen && (
          <div className="git-menu" role="menu" aria-label="git actions">
            <header>
              <span>branch</span>
              <strong>{initialOperatorState.branch}</strong>
            </header>
            <div className="git-menu__status">
              <span>clean</span>
              <small>origin/{initialOperatorState.branch}</small>
            </div>
            <div className="git-menu__actions">
              {gitActions.map((action) => (
                <button key={action} role="menuitem" onClick={() => setGitMenuOpen(false)}>
                  {action}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="topbar-select">
        <button
          className="segment topbar-select__button"
          aria-label={`workspace ${workspace.toLowerCase()}`}
          aria-haspopup="menu"
          aria-expanded={workspaceMenuOpen}
          onClick={() => {
            setWorkspaceMenuOpen((open) => !open);
            setModeMenuOpen(false);
          }}
        >
          <span className="topbar-select__label">workspace</span>
          <strong>{workspace.toLowerCase()}</strong>
          <span className="topbar-select__chevron" aria-hidden="true">v</span>
        </button>
        {workspaceMenuOpen && (
          <div className="topbar-menu topbar-menu--workspace workspace-preset-menu" role="menu" aria-label="workspace presets">
            <header>
              <span>workspace preset</span>
              <strong>{workspace.toLowerCase()}</strong>
            </header>
            <div className="workspace-preset-menu__section" aria-label="workspace preset list">
              {workspacePresets.map((preset) => (
                <button
                  key={preset.name}
                  className={preset.name === workspace ? 'topbar-menu__item topbar-menu__item--active' : 'topbar-menu__item'}
                  role="menuitemradio"
                  aria-checked={preset.name === workspace}
                  onClick={() => {
                    onWorkspaceChange(preset.name);
                    setWorkspaceMenuOpen(false);
                  }}
                >
                  <span>{preset.name.toLowerCase()}</span>
                  <small>{preset.panels.length} panels · {preset.emphasis.map((panel) => PANEL_META[panel].label).join(', ')}</small>
                </button>
              ))}
            </div>
            <div className="workspace-preset-menu__section workspace-preset-menu__section--actions">
              <button role="menuitem" onClick={() => setWorkspaceMenuOpen(false)}>save current workspace...</button>
              <button role="menuitem" onClick={() => setWorkspaceMenuOpen(false)}>reset workspace</button>
              <button role="menuitem" onClick={() => setWorkspaceMenuOpen(false)}>manage workspaces...</button>
            </div>
          </div>
        )}
      </div>
      <div className="segment meter">
        ctx
        <span><i style={{ width: `${initialOperatorState.contextUsedPct}%` }} /></span>
        {initialOperatorState.contextUsedPct}%
        <button className="loop-action" title="write /handoff">/handoff</button>
      </div>
      <div className="topbar-select">
        <button
          className="segment topbar-select__button mode-segment"
          title="permission mode"
          aria-label={`permission mode ${activeMode.label}`}
          aria-haspopup="menu"
          aria-expanded={modeMenuOpen}
          onClick={() => {
            setModeMenuOpen((open) => !open);
            setWorkspaceMenuOpen(false);
          }}
        >
          <span className="topbar-select__label">mode</span>
          <strong>{activeMode.label}</strong>
          <span className="topbar-select__chevron" aria-hidden="true">v</span>
        </button>
        {modeMenuOpen && (
          <div className="topbar-menu topbar-menu--mode" role="menu" aria-label="permission mode options">
            <header>
              <span>permission mode</span>
              <strong>{activeMode.label}</strong>
            </header>
            {permissionModes.map((mode) => (
              <button
                key={mode.id}
                className={mode.id === permissionMode ? 'topbar-menu__item topbar-menu__item--active' : 'topbar-menu__item'}
                role="menuitem"
                onClick={() => {
                  setPermissionMode(mode.id);
                  setModeMenuOpen(false);
                }}
              >
                <span>{mode.label}</span>
                <small>{mode.hint}</small>
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="segment settings-button" title="settings" aria-label="settings">settings</button>
      <button className="segment help-button" title="help" aria-label="help">help</button>
      <div className="segment segment--brand">polypore v0.1.0</div>
    </header>
  );
}

function TabStrip({
  tabs,
  activeTabId,
  draggedTabId,
  onSelect,
  onClose,
  onDragStart,
  onDrop,
  onDragEnd,
  addPickerOpen,
  onToggleAdd,
  onAdd,
}: {
  tabs: StageTab[];
  activeTabId: string;
  draggedTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onDragStart: (id: string) => void;
  onDrop: (fromId: string, toId: string) => void;
  onDragEnd: () => void;
  addPickerOpen: boolean;
  onToggleAdd: () => void;
  onAdd: (item: AddableItem) => void;
}) {
  return (
    <div className="tab-strip" role="tablist">
      <div className="tab-strip__rail">
        {tabs.map((tab) => {
          const meta = PANEL_META[tab.panelType];
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              draggable
              className={`stage-tab ${active ? 'stage-tab--active' : ''} ${draggedTabId === tab.id ? 'stage-tab--dragging' : ''}`}
              onClick={() => onSelect(tab.id)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onSelect(tab.id);
              }}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', tab.id);
                onDragStart(tab.id);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                event.preventDefault();
                const fromId = event.dataTransfer.getData('text/plain') || draggedTabId;
                if (fromId) onDrop(fromId, tab.id);
              }}
              onDragEnd={onDragEnd}
            >
              <span className="stage-tab__icon">{meta.icon}</span>
              <span className="stage-tab__label">{meta.label}</span>
              {tabs.length > 1 && (
                <button
                  className="stage-tab__close"
                  aria-label={`close ${meta.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(tab.id);
                  }}
                >
                  x
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="tab-strip__add">
        <button
          className="tab-strip__add-button"
          aria-expanded={addPickerOpen}
          aria-label="open new tab"
          onClick={onToggleAdd}
        >
          +
        </button>
        {addPickerOpen && <AddPopover onAdd={onAdd} />}
      </div>
    </div>
  );
}

function AddPopover({ onAdd }: { onAdd: (item: AddableItem) => void }) {
  return (
    <div className="tab-strip__add-popover" role="dialog" aria-label="choose what to add">
      {ADDABLE.map((item) => {
        const key = item.kind === 'agent' ? `agent-${item.agent}` : `panel-${item.panelType}`;
        return (
          <button key={key} onClick={() => onAdd(item)}>
            <span>{item.icon}</span>
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function ChatRegion({
  onToolCardClick,
  onOpenSettings,
  onOpenHelp,
  chatSessions,
  activeChatId,
  onSelectChat,
  onCloseChat,
  onUpdateDraft,
  onSendDraft,
  addPickerOpen,
  onToggleAddPicker,
  onAdd,
}: {
  onToolCardClick: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  chatSessions: ChatSession[];
  activeChatId: string;
  onSelectChat: (id: string) => void;
  onCloseChat: (id: string) => void;
  onUpdateDraft: (draft: string) => void;
  onSendDraft: () => void;
  addPickerOpen: boolean;
  onToggleAddPicker: () => void;
  onAdd: (item: AddableItem) => void;
}) {
  const activeChat = chatSessions.find((session) => session.id === activeChatId) ?? chatSessions[0];
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);

  return (
    <section className="chat-region">
      <div className="tab-strip" role="tablist" aria-label="chat sessions">
        <div className="tab-strip__rail">
          {chatSessions.map((session) => {
            const active = session.id === activeChat.id;
            return (
              <div
                className={`stage-tab ${active ? 'stage-tab--active' : ''}`}
                key={session.id}
                role="tab"
                tabIndex={0}
                aria-selected={active}
                onClick={() => onSelectChat(session.id)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  onSelectChat(session.id);
                }}
              >
                <span className="stage-tab__icon">{AGENT_META[session.agent].icon}</span>
                <span className="stage-tab__label">{session.title}</span>
                {chatSessions.length > 1 && (
                  <button
                    className="stage-tab__close"
                    aria-label={`close ${session.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseChat(session.id);
                    }}
                  >
                    x
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="tab-strip__add">
          <button
            className="tab-strip__add-button"
            aria-expanded={addPickerOpen}
            aria-label="open new chat tab"
            onClick={onToggleAddPicker}
          >
            +
          </button>
          {addPickerOpen && <AddPopover onAdd={onAdd} />}
        </div>
      </div>

      <article className="chat-box">
        <PanelHeader
          label="chat"
          onOpenHelp={onOpenHelp}
          onOpenSettings={onOpenSettings}
          className="panel-header--chat"
        >
          <span className="panel-header__agent-pill">{AGENT_META[activeChat.agent].icon}</span>
          <span className="panel-header__title">{activeChat.title}</span>
          <span className="panel-header__sep" aria-hidden="true" />
          <span className="panel-header__meta">{activeChat.agent}</span>
          <span className="panel-header__meta">{activeChat.messages.length} messages</span>
        </PanelHeader>
        <div className="chat-body">
          <div className="chat-stream">
            {activeChat.messages.map((message, index) => (
              <section className={`chat-block chat-block--${message.by}`} key={`${message.by}-${index}`}>
                <small>{message.by}</small>
                <p>{message.text}</p>
              </section>
            ))}
            {toolCards.map((tool) => (
              <button className="tool-card" key={tool.id} onClick={onToolCardClick}>
                <span>{tool.name}</span>
                <strong>{tool.summary}</strong>
                <i>{tool.status}</i>
              </button>
            ))}
          </div>
          <div className="composer">
            <input
              placeholder={`message ${activeChat.agent}...`}
              value={activeChat.draft}
              onChange={(event) => onUpdateDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onSendDraft();
              }}
            />
            <div className="composer-tools">
              <button
                className="composer-tools__trigger"
                aria-label="open composer tools"
                aria-expanded={composerMenuOpen}
                onClick={() => setComposerMenuOpen((open) => !open)}
              >
                <span aria-hidden="true" />
                <span aria-hidden="true" />
                <span aria-hidden="true" />
                <span aria-hidden="true" />
              </button>
              {composerMenuOpen && (
                <div className="composer-tools__popover" role="dialog" aria-label="composer tools">
                  {['skills', 'files', 'knowledge', 'prompts'].map((item) => (
                    <button key={item} onClick={() => setComposerMenuOpen(false)}>{item}</button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={onSendDraft}>send</button>
          </div>
        </div>
      </article>
    </section>
  );
}

function FileTree({
  nodes,
  activePath,
  onSelect,
  draggable = false,
  dragMime,
  depth = 0,
  defaultExpanded = true,
}: {
  nodes: FileNode[];
  activePath?: string;
  onSelect?: (path: string) => void;
  draggable?: boolean;
  dragMime?: string;
  depth?: number;
  defaultExpanded?: boolean;
}) {
  return (
    <div className="file-tree" role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map((node) =>
        node.kind === 'folder' ? (
          <FileTreeFolder
            key={`f-${depth}-${node.name}`}
            node={node}
            depth={depth}
            activePath={activePath}
            onSelect={onSelect}
            draggable={draggable}
            dragMime={dragMime}
            defaultExpanded={defaultExpanded}
          />
        ) : (
          <FileTreeFile
            key={`x-${node.path}`}
            node={node}
            depth={depth}
            active={node.path === activePath}
            onSelect={onSelect}
            draggable={draggable}
            dragMime={dragMime}
          />
        ),
      )}
    </div>
  );
}

function FileTreeFolder({
  node,
  depth,
  activePath,
  onSelect,
  draggable,
  dragMime,
  defaultExpanded,
}: {
  node: Extract<FileNode, { kind: 'folder' }>;
  depth: number;
  activePath?: string;
  onSelect?: (path: string) => void;
  draggable: boolean;
  dragMime?: string;
  defaultExpanded: boolean;
}) {
  const [open, setOpen] = useState(defaultExpanded);
  return (
    <div className="file-tree__folder" role="treeitem" aria-expanded={open}>
      <button
        type="button"
        className="file-tree__row file-tree__row--folder"
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="file-tree__chevron" aria-hidden="true">{open ? 'v' : '>'}</span>
        <span className="file-tree__icon file-tree__icon--folder" aria-hidden="true">dir</span>
        <span className="file-tree__label">{node.name}</span>
        <small className="file-tree__count">{node.children.length}</small>
      </button>
      {open && (
        <FileTree
          nodes={node.children}
          activePath={activePath}
          onSelect={onSelect}
          draggable={draggable}
          dragMime={dragMime}
          depth={depth + 1}
          defaultExpanded={defaultExpanded}
        />
      )}
    </div>
  );
}

function FileTreeFile({
  node,
  depth,
  active,
  onSelect,
  draggable,
  dragMime,
}: {
  node: Extract<FileNode, { kind: 'file' }>;
  depth: number;
  active: boolean;
  onSelect?: (path: string) => void;
  draggable: boolean;
  dragMime?: string;
  }) {
  const meta = codeFileMeta[node.path];
  return (
    <button
      type="button"
      className={`file-tree__row file-tree__row--file ${active ? 'file-tree__row--active' : ''}`}
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={() => onSelect?.(node.path)}
      draggable={draggable}
      onDragStart={
        draggable && dragMime
          ? (event) => {
              event.dataTransfer.effectAllowed = 'copy';
              event.dataTransfer.setData(dragMime, node.path);
              event.dataTransfer.setData('text/plain', node.path);
            }
          : undefined
      }
    >
      <span className="file-tree__icon file-tree__icon--file" aria-hidden="true">·</span>
      <span className="file-tree__label">{node.name}</span>
      {meta?.status && <small className={`file-tree__badge file-tree__badge--${meta.status.toLowerCase()}`}>{meta.status}</small>}
      {meta?.diagnostics && <small className="file-tree__badge file-tree__badge--diagnostic">!</small>}
      <small className="file-tree__path">{node.path}</small>
    </button>
  );
}

function PanelHeader({
  label,
  onOpenHelp,
  onOpenSettings,
  className = '',
  children,
}: {
  label: string;
  onOpenHelp: () => void;
  onOpenSettings: () => void;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`panel-header ${className}`.trim()}>
      <div className="panel-header__content">{children}</div>
      <div className="panel-header__controls">
        <button
          className="panel-help"
          title={`manual · ${label}`}
          aria-label={`open manual for ${label}`}
          onClick={onOpenHelp}
        >
          ?
        </button>
        <button
          className="panel-gear"
          title={`settings · ${label}`}
          aria-label={`open settings for ${label}`}
          onClick={onOpenSettings}
        >
          gear
        </button>
      </div>
    </div>
  );
}

function BuildSurface({
  activeTab,
  contextItems,
  onAddContext,
  onOpenHelp,
  onOpenSettings,
}: {
  activeTab: StageTab;
  contextItems: string[];
  onAddContext: (label: string) => void;
  onOpenHelp: () => void;
  onOpenSettings: () => void;
}) {
  const meta = PANEL_META[activeTab.panelType];
  const headerProps = { label: meta.label, onOpenHelp, onOpenSettings };

  switch (activeTab.panelType) {
    case 'preview':
      return <PreviewSurface header={headerProps} />;
    case 'editor':
      return <CodeSurface header={headerProps} />;
    case 'diff-stack':
      return <DiffHistorySurface header={headerProps} />;
    case 'terminal':
      return <TerminalSurface header={headerProps} />;
    case 'verify':
      return <VerifySurface header={headerProps} />;
    case 'memory':
      return (
        <MemorySurface
          contextItems={contextItems}
          onAddContext={onAddContext}
          header={headerProps}
        />
      );
    case 'extensions':
      return <AgentSurface header={headerProps} />;
    case 'problems':
      return <ProblemsSurface header={headerProps} />;
    case 'timeline':
      return <HistorySurface header={headerProps} />;
    default:
      return <div className="empty-state">no surface registered for {activeTab.panelType}</div>;
  }
}

type PanelHeaderProps = {
  label: string;
  onOpenHelp: () => void;
  onOpenSettings: () => void;
};

function PreviewSurface({ header }: { header: PanelHeaderProps }) {
  const [targetKind, setTargetKind] = useState<PreviewTargetKind>('site');
  const [command, setCommand] = useState('npm start');
  const [url, setUrl] = useState('http://localhost:3000');
  const [mode, setMode] = useState<'window' | 'external'>('window');
  const [status, setStatus] = useState<'idle' | 'running' | 'external'>('idle');
  const [logsOpen, setLogsOpen] = useState(false);

  const selectedKind = previewTargetKinds.find((kind) => kind.id === targetKind) ?? previewTargetKinds[0];
  const previewLogs = [
    `$ ${command}`,
    `preview target: ${url}`,
    `${selectedKind.label} runtime starting`,
    targetKind === 'site' || targetKind === 'game'
      ? `local: ${url}`
      : `${selectedKind.label} output attached to preview`,
    'ready in 421ms',
  ];

  const selectTargetKind = (kind: PreviewTargetConfig) => {
    setTargetKind(kind.id);
    setCommand(kind.defaultCommand);
    setUrl(kind.defaultTarget);
    if (status === 'external') setStatus('idle');
    setLogsOpen(false);
  };

  const runInWindow = () => {
    setMode('window');
    setStatus('running');
    setLogsOpen(false);
  };

  const runOutside = () => {
    setMode('external');
    setStatus('external');
    setLogsOpen(false);
  };

  const stopPreview = () => {
    setStatus('idle');
    setLogsOpen(false);
  };

  const statusLabel =
    status === 'idle' ? 'not running' : status === 'running' ? 'running in window' : 'opened outside';

  const headerBar = (
    <PanelHeader {...header} className="panel-header--preview">
      <span className="panel-header__title">preview</span>
      <span className="panel-header__sep" aria-hidden="true" />
      <span className="panel-header__meta">{selectedKind.label}</span>
      <span className={`preview-status preview-status--${status}`}>{statusLabel}</span>
    </PanelHeader>
  );

  if (status === 'running' && mode === 'window') {
    return (
      <div className="preview-surface preview-surface--running">
        {headerBar}
        <section className="preview-output preview-output--fullscreen">
          <header>
            <strong>embedded output</strong>
            <span>{url}</span>
            <div className="preview-output__controls">
              <button onClick={stopPreview}>setup</button>
              <button>refresh</button>
              <button>restart</button>
              <button onClick={stopPreview}>stop</button>
              <button onClick={runOutside}>run outside window</button>
              <button
                className={logsOpen ? 'preview-output__log-toggle preview-output__log-toggle--active' : 'preview-output__log-toggle'}
                aria-expanded={logsOpen}
                onClick={() => setLogsOpen((open) => !open)}
              >
                logs
              </button>
            </div>
          </header>
          <div className="preview-viewport">
            <small>attached preview</small>
            <h1>active project output</h1>
            <p>{targetKind === 'site' ? url : `${selectedKind.label} runtime via ${command}`}</p>
          </div>
          {logsOpen && (
            <aside className="preview-log-drawer" aria-label="preview logs">
              <header>
                <div>
                  <strong>logs</strong>
                  <span>{command}</span>
                </div>
                <button onClick={() => setLogsOpen(false)}>close</button>
              </header>
              <pre>
                {previewLogs.map((line) => `> ${line}`).join('\n')}
              </pre>
            </aside>
          )}
        </section>
      </div>
    );
  }

  if (status === 'external' && mode === 'external') {
    return (
      <div className="preview-surface preview-surface--external">
        {headerBar}
        <section className="preview-output preview-output--fullscreen preview-output--external">
          <header>
            <strong>outside window</strong>
            <span>{url || command}</span>
            <div className="preview-output__controls">
              <button onClick={runOutside}>open</button>
              <button>copy</button>
              <button>restart</button>
              <button onClick={stopPreview}>stop</button>
              <button onClick={runInWindow}>run in window</button>
              <button
                className={logsOpen ? 'preview-output__log-toggle preview-output__log-toggle--active' : 'preview-output__log-toggle'}
                aria-expanded={logsOpen}
                onClick={() => setLogsOpen((open) => !open)}
              >
                logs
              </button>
            </div>
          </header>
          <div className="preview-viewport preview-viewport--external">
            <small>opened outside</small>
            <h1>external preview running</h1>
            <p>{targetKind === 'site'
              ? `browser window attached to ${url}`
              : `${selectedKind.label} runtime opened externally via ${command}`}</p>
            <code>{url || command}</code>
          </div>
          {logsOpen && (
            <aside className="preview-log-drawer" aria-label="preview logs">
              <header>
                <div>
                  <strong>logs</strong>
                  <span>{command}</span>
                </div>
                <button onClick={() => setLogsOpen(false)}>close</button>
              </header>
              <pre>
                {previewLogs.map((line) => `> ${line}`).join('\n')}
              </pre>
            </aside>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="preview-surface">
      {headerBar}
      <section className="preview-config">
        <header className="preview-config__intro">
          <div>
            <h2>preview setup</h2>
          </div>
          <p>pick a target, point it at a command or address, then run.</p>
        </header>

        <div className="preview-setup">
          <section className="preview-step preview-step--targets">
            <header className="preview-step__head">
              <strong>target</strong>
              <small>{selectedKind.label} · {selectedKind.hint}</small>
            </header>
            <div className="preview-target-pills" role="radiogroup" aria-label="preview target type">
              {previewTargetKinds.map((kind) => (
                <button
                  key={kind.id}
                  className={`preview-target ${targetKind === kind.id ? 'preview-target--active' : ''}`}
                  role="radio"
                  aria-checked={targetKind === kind.id}
                  onClick={() => selectTargetKind(kind)}
                >
                  <span className="preview-target__icon" aria-hidden="true">{kind.icon}</span>
                  <span className="preview-target__copy">
                    <strong>{kind.label}</strong>
                    <span>{kind.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="preview-launch-row">
            <div className="preview-launch-fields">
              <header className="preview-step__head">
                <strong>source</strong>
              </header>
              <div className="preview-config__row">
                <label className="preview-field">
                  <span>{selectedKind.commandLabel}</span>
                  <input
                    value={command}
                    placeholder={selectedKind.commandPlaceholder}
                    onChange={(event) => setCommand(event.target.value)}
                  />
                </label>
                <label className="preview-field">
                  <span>{selectedKind.targetLabel}</span>
                  <input
                    value={url}
                    placeholder={selectedKind.targetPlaceholder}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                </label>
              </div>
            </div>

            <div className="preview-launch-actions">
              <header className="preview-step__head">
                <strong>run</strong>
              </header>
              <div className="preview-config__actions" aria-label="preview run mode">
                <button
                  className={mode === 'window' ? 'preview-run preview-run--active' : 'preview-run'}
                  onClick={runInWindow}
                >
                  <strong>run in window</strong>
                  <span>fills the preview pane</span>
                </button>
                <button
                  className={mode === 'external' ? 'preview-run preview-run--active' : 'preview-run'}
                  onClick={runOutside}
                >
                  <strong>run outside window</strong>
                  <span>opens externally</span>
                </button>
              </div>
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

function CodeSurface({ header }: { header: PanelHeaderProps }) {
  const [activeFile, setActiveFile] = useState('src/app.tsx');
  const [openFiles, setOpenFiles] = useState(['src/app.tsx', 'src/core/types.ts', 'docs/ui-direction.md']);
  const [quickOpen, setQuickOpen] = useState(false);
  const [query, setQuery] = useState('');
  const activeMeta = codeFileMeta[activeFile] ?? codeFileMeta['src/app.tsx'];
  const allFiles = Object.keys(codeFileMeta);
  const filteredFiles = allFiles.filter((path) => path.toLowerCase().includes(query.toLowerCase()) || codeFileMeta[path].name.toLowerCase().includes(query.toLowerCase()));

  const openFile = (path: string) => {
    setActiveFile(path);
    setOpenFiles((current) => (current.includes(path) ? current : [...current, path]));
    setQuickOpen(false);
    setQuery('');
  };

  const closeFile = (path: string) => {
    setOpenFiles((current) => {
      const next = current.filter((file) => file !== path);
      if (path === activeFile) setActiveFile(next[0] ?? 'src/app.tsx');
      return next.length ? next : ['src/app.tsx'];
    });
  };

  return (
    <div className="code-shell">
      <PanelHeader {...header} className="panel-header--file">
        <span className="panel-header__title">editor</span>
        <span className="panel-header__sep" aria-hidden="true" />
        <span className="file-bar__name">{activeFile}</span>
        <span className="panel-header__meta">{activeMeta.language} · {activeMeta.dirty ? 'modified' : 'saved'} · ln 1</span>
      </PanelHeader>
      <div className="code-body">
        <aside className="code-explorer nav-section" aria-label="select file">
          <header className="nav-section__head">
            <span className="folder-symbol">dir</span>
            <strong className="nav-section__title">files</strong>
            <small className="nav-section__count">{files.length}</small>
          </header>
          <button className="nav-section__search" onClick={() => setQuickOpen(true)}>
            <span>search files...</span>
            <kbd>ctrl+p</kbd>
          </button>
          <nav className="nav-section__list">
            <FileTree nodes={codeFileTree} activePath={activeFile} onSelect={openFile} />
          </nav>
        </aside>
        <section className="editor-workbench">
          <div className="editor-tabs" role="tablist" aria-label="open files">
            {openFiles.map((file) => {
              const meta = codeFileMeta[file];
              return (
                <button
                  key={file}
                  className={file === activeFile ? 'editor-tab editor-tab--active' : 'editor-tab'}
                  role="tab"
                  aria-selected={file === activeFile}
                  onClick={() => setActiveFile(file)}
                >
                  <span>{meta.name}</span>
                  {meta.dirty && <i aria-label="modified">M</i>}
                  <b onClick={(event) => { event.stopPropagation(); closeFile(file); }}>x</b>
                </button>
              );
            })}
            <button className="editor-tab editor-tab--add" onClick={() => setQuickOpen(true)}>+</button>
          </div>
          <div className="editor-alert">
            <span>{activeMeta.diagnostics ? `${activeMeta.diagnostics} error in ${activeMeta.name}` : `no problems in ${activeMeta.name}`}</span>
            <button>view problems</button>
          </div>
          <div className="code-pane" aria-label={`editor for ${activeFile}`}>
            <div className="code-gutter">
              {activeMeta.lines.map((_, index) => <span key={index}>{index + 1}</span>)}
            </div>
            <pre>
              {activeMeta.lines.map((line, index) => (
                <span key={`${activeFile}-${index}`} className={activeMeta.diagnostics && index === 0 ? 'code-line code-line--diagnostic' : 'code-line'}>
                  {line || ' '}
                </span>
              ))}
            </pre>
            <div className="code-minimap" aria-hidden="true">
              {activeMeta.lines.map((line, index) => <i key={index} style={{ width: `${Math.min(92, Math.max(24, line.length * 3))}%` }} />)}
            </div>
          </div>
          <footer className="editor-status">
            <span>{activeMeta.language}</span>
            <span>utf-8</span>
            <span>spaces: 2</span>
            <span>{activeMeta.diagnostics ? '1 diagnostic' : 'clean'}</span>
          </footer>
        </section>
        {quickOpen && (
          <div className="quick-open" role="dialog" aria-label="quick open">
            <header>
              <strong>quick open</strong>
              <button onClick={() => setQuickOpen(false)}>close</button>
            </header>
            <input
              value={query}
              placeholder="type a file name"
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setQuickOpen(false);
                if (event.key === 'Enter' && filteredFiles[0]) openFile(filteredFiles[0]);
              }}
            />
            <div className="quick-open__results">
              {filteredFiles.map((path) => {
                const meta = codeFileMeta[path];
                return (
                  <button key={path} className={path === activeFile ? 'quick-open__result quick-open__result--active' : 'quick-open__result'} onClick={() => openFile(path)}>
                    <span>{meta.name}</span>
                    <small>{path}</small>
                    {meta.status && <i>{meta.status}</i>}
                    {meta.diagnostics && <i>!</i>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DiffHistorySurface({ header }: { header: PanelHeaderProps }) {
  const [selectedHistoryId, setSelectedHistoryId] = useState<string>(timelineEvents[timelineEvents.length - 1].id);
  const [selectedFile, setSelectedFile] = useState<string>('src/app.tsx');
  const [compareMode, setCompareMode] = useState<'working' | 'branch' | 'agent'>('working');
  const [compareOpen, setCompareOpen] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);

  const selectedHistory = timelineEvents.find((event) => event.id === selectedHistoryId);
  const isLatest = selectedHistoryId === timelineEvents[timelineEvents.length - 1].id;
  const comparisonLabel = !isLatest
    ? 'restore point snapshot vs working tree'
    : compareMode === 'working'
      ? 'working tree vs HEAD'
      : compareMode === 'branch'
        ? 'current branch vs origin/main'
        : 'agent task snapshot vs working tree';
  const baseLabel = !isLatest ? 'snapshot' : compareMode === 'working' ? 'HEAD' : compareMode === 'branch' ? 'origin/main' : 'task start';
  const targetLabel = compareMode === 'branch' && isLatest ? 'current branch' : 'working tree';
  const allDiffFiles = Object.keys(diffFileMeta);
  const changedFiles = isLatest
    ? allDiffFiles
    : selectedHistory?.affectedFiles.filter((file) => diffFileMeta[file]) ?? allDiffFiles.slice(0, 3);
  const activeFile = changedFiles.includes(selectedFile) ? selectedFile : changedFiles[0];
  const activeDiff = diffFileMeta[activeFile] ?? diffFileMeta['src/app.tsx'];
  const totals = changedFiles.reduce(
    (sum, file) => {
      const meta = diffFileMeta[file];
      return {
        added: sum.added + (meta?.added ?? 0),
        removed: sum.removed + (meta?.removed ?? 0),
      };
    },
    { added: 0, removed: 0 },
  );

  return (
    <div className="diff-history-shell">
      <PanelHeader {...header}>
        <span className="panel-header__title">diff</span>
        <span className="panel-header__sep" aria-hidden="true" />
        <span className="panel-header__meta">{comparisonLabel}</span>
        <span className="panel-header__meta">{changedFiles.length} files · +{totals.added} -{totals.removed}</span>
      </PanelHeader>
      <div className="diff-history-grid">
        <aside className="diff-review-rail">
          <div className="diff-scope" aria-label="git comparison mode">
            {(['working', 'branch', 'agent'] as const).map((item) => (
              <button
                key={item}
                className={compareMode === item && isLatest ? 'diff-scope__chip diff-scope__chip--active' : 'diff-scope__chip'}
                onClick={() => {
                  setCompareMode(item);
                  setSelectedHistoryId(timelineEvents[timelineEvents.length - 1].id);
                  setConfirmRevert(false);
                }}
              >
                {item === 'working' ? 'working tree' : item === 'branch' ? 'branch' : 'agent task'}
              </button>
            ))}
          </div>

          <nav className="diff-files" aria-label="changed files">
            <header>
              <strong>changed files</strong>
              <small>{changedFiles.length}</small>
            </header>
            <div className="diff-files__list">
              {changedFiles.map((file) => {
                const meta = diffFileMeta[file];
                return (
                  <button
                    key={file}
                    className={file === activeFile ? 'diff-files__entry diff-files__entry--active' : 'diff-files__entry'}
                    onClick={() => setSelectedFile(file)}
                  >
                    <i className={`diff-files__status diff-files__status--${meta.status.toLowerCase()}`}>{meta.status}</i>
                    <span>{file}</span>
                    <em>{meta.source}</em>
                    <small>+{meta.added} -{meta.removed}</small>
                  </button>
                );
              })}
            </div>
          </nav>

          <nav className="history-rail" aria-label="restore points">
            <header>
              <strong>agent snapshots</strong>
              <small>{timelineEvents.length}</small>
            </header>
            <div>
              {[...timelineEvents].reverse().map((event) => (
                <button
                  key={event.id}
                  className={`history-rail__entry ${event.id === selectedHistoryId ? 'history-rail__entry--active' : ''}`}
                  onClick={() => { setSelectedHistoryId(event.id); setConfirmRevert(false); }}
                >
                  <time>{new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                  <strong>{event.source} · {event.kind}</strong>
                  <span>{event.phase ?? event.toolName ?? `${event.affectedFiles.length} file${event.affectedFiles.length === 1 ? '' : 's'}`}</span>
                </button>
              ))}
            </div>
          </nav>
        </aside>

        <section className="diff-pane-region">
          <header className="diff-pane-region__bar">
            <div className="diff-file-title">
              <strong>{activeFile}</strong>
              <span>{activeDiff.status}</span>
              <small>+{activeDiff.added} -{activeDiff.removed}</small>
            </div>
            <div className="diff-pane-region__actions">
              <button>open in editor</button>
              <button onClick={() => setCompareOpen((open) => !open)}>compare</button>
              <button disabled={isLatest} title={isLatest ? 'already at latest state' : 'fork from this point'}>fork from here</button>
              <button disabled={isLatest} onClick={() => setConfirmRevert(true)} title={isLatest ? 'already at latest state' : 'review before reverting'}>revert...</button>
            </div>
          </header>

          {compareOpen && (
            <div className="diff-compare-popover" role="dialog" aria-label="compare refs">
              <label>
                <span>base</span>
                <select defaultValue={compareMode === 'working' ? 'head' : compareMode === 'branch' ? 'origin/main' : 'task-start'}>
                  <option value="working-tree">working tree</option>
                  <option value="head">HEAD</option>
                  <option value="origin/main">origin/main</option>
                  <option value="task-start">task start snapshot</option>
                </select>
              </label>
              <label>
                <span>target</span>
                <select defaultValue={compareMode === 'working' || compareMode === 'agent' ? 'working-tree' : 'current'}>
                  <option value="working-tree">working tree</option>
                  <option value="current">current branch</option>
                  <option value="head-1">HEAD~1</option>
                  <option value="commit">commit...</option>
                </select>
              </label>
              <button>run compare</button>
            </div>
          )}

          {!isLatest && (
            <div className="diff-historical-banner">
              <span>agent snapshot selected</span>
              <small>{new Date(selectedHistory?.ts ?? Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {selectedHistory?.source} · {selectedHistory?.kind}</small>
            </div>
          )}

          <div className="diff-split" aria-label={`diff for ${activeFile}`}>
            <div className="diff-column">
              <header>{baseLabel}</header>
              {activeDiff.lines.map((line, index) => (
                <div key={`old-${index}`} className={`diff-line diff-line--${line.kind ?? 'same'}`}>
                  <span>{line.oldNo ?? ''}</span>
                  <code>{line.oldText ?? ''}</code>
                </div>
              ))}
            </div>
            <div className="diff-column">
              <header>{targetLabel}</header>
              {activeDiff.lines.map((line, index) => (
                <div key={`new-${index}`} className={`diff-line diff-line--${line.kind ?? 'same'}`}>
                  <span>{line.newNo ?? ''}</span>
                  <code>{line.newText ?? ''}</code>
                </div>
              ))}
            </div>
          </div>

          {confirmRevert && (
            <aside className="diff-revert-confirm" role="dialog" aria-label="confirm revert">
              <header>
                <strong>revert to selected restore point?</strong>
                <button onClick={() => setConfirmRevert(false)}>close</button>
              </header>
              <p>This restores {changedFiles.length} file{changedFiles.length === 1 ? '' : 's'} to the selected snapshot. No git commit is created.</p>
              <div>
                <button onClick={() => setConfirmRevert(false)}>cancel</button>
                <button>revert working tree</button>
              </div>
            </aside>
          )}
        </section>
      </div>
    </div>
  );
}

function TerminalSurface({ header }: { header: PanelHeaderProps }) {
  return (
    <div className="terminal-shell">
      <PanelHeader {...header}>
        <span className="panel-header__title">terminal</span>
        <span className="panel-header__sep" aria-hidden="true" />
        <span className="panel-header__meta">bash</span>
        <span className="panel-header__meta">~/polypore</span>
      </PanelHeader>
      <section className="terminal" aria-label="bash terminal">
        <pre className="terminal__buffer">klemlitos@polypore:~/polypore$ npm run dev{'\n'}&gt; polypore@0.1.0 dev{'\n'}&gt; react-scripts start{'\n'}{'\n'}Compiled successfully.{'\n'}Local: http://localhost:3000</pre>
        <label className="terminal__prompt">
          <span>klemlitos@polypore:~/polypore$</span>
          <input aria-label="terminal command" autoComplete="off" spellCheck={false} />
        </label>
      </section>
    </div>
  );
}

function HistorySurface({ header }: { header: PanelHeaderProps }) {
  return (
    <section className="surface-card">
      <PanelHeader {...header}>
        <span className="panel-header__title">history</span>
        <span className="panel-header__sep" aria-hidden="true" />
        <span className="panel-header__meta">{timelineEvents.length} events</span>
      </PanelHeader>
      <header><h2>history</h2><small>{timelineEvents.length} events</small></header>
      <div className="history-list">
        {timelineEvents.map((event) => (
          <section key={event.id}>
            <time>{new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
            <strong>{event.source} / {event.kind}</strong>
          </section>
        ))}
      </div>
    </section>
  );
}

function VerifySurface({ header }: { header: PanelHeaderProps }) {
  const [problems, setProblems] = useState<ProblemItem[]>(initialProblems);
  const [checks, setChecks] = useState<CheckItem[]>(initialChecks);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [running, setRunning] = useState(false);
  const [problemDraft, setProblemDraft] = useState('');
  const [checkDraft, setCheckDraft] = useState('');
  const [addingProblem, setAddingProblem] = useState(false);
  const [addingCheck, setAddingCheck] = useState(false);
  const [queueHover, setQueueHover] = useState(false);
  const [draggedQueueId, setDraggedQueueId] = useState<string | null>(null);

  const enqueue = (
    source: 'problem' | 'check',
    sourceId: string,
    label: string,
    detail?: string,
  ) => {
    setQueue((current) => {
      if (current.some((item) => item.source === source && item.sourceId === sourceId)) return current;
      return [
        ...current,
        {
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          source,
          sourceId,
          label,
          detail,
          status: 'pending',
        },
      ];
    });
  };

  const removeQueueItem = (id: string) => setQueue((q) => q.filter((item) => item.id !== id));

  const reorderQueue = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    setQueue((prev) => {
      const fromIdx = prev.findIndex((item) => item.id === fromId);
      const toIdx = prev.findIndex((item) => item.id === toId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };

  const runQueue = async () => {
    if (running) return;
    const pending = queue.filter((item) => item.status === 'pending');
    if (pending.length === 0) return;
    setRunning(true);
    for (const item of pending) {
      setQueue((q) => q.map((i) => (i.id === item.id ? { ...i, status: 'fixing' } : i)));
      await new Promise((resolve) => setTimeout(resolve, 900));
      setQueue((q) => q.map((i) => (i.id === item.id ? { ...i, status: 'done' } : i)));
      if (item.source === 'problem') {
        setProblems((p) => p.filter((prob) => prob.id !== item.sourceId));
      }
      if (item.source === 'check') {
        setChecks((c) => c.map((check) => (check.id === item.sourceId ? { ...check, status: 'ok', ms: 1200 } : check)));
      }
    }
    setRunning(false);
  };

  const addCustomProblem = () => {
    const text = problemDraft.trim();
    if (!text) return;
    const id = `p-custom-${Date.now()}`;
    setProblems((p) => [...p, { id, severity: 'warn', file: 'custom', line: 0, msg: text }]);
    setProblemDraft('');
    setAddingProblem(false);
  };

  const addCustomCheck = () => {
    const text = checkDraft.trim();
    if (!text) return;
    const id = `c-custom-${Date.now()}`;
    setChecks((c) => [...c, { id, label: 'custom', cmd: text, status: 'pending', ms: null }]);
    setCheckDraft('');
    setAddingCheck(false);
  };

  const moveAllChecksToQueue = () => {
    setQueue((current) => {
      const existing = new Set(
        current.filter((i) => i.source === 'check').map((i) => i.sourceId),
      );
      const additions: QueueItem[] = checks
        .filter((c) => !existing.has(c.id))
        .map((c) => ({
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${c.id}`,
          source: 'check',
          sourceId: c.id,
          label: c.label,
          detail: c.cmd,
          status: 'pending',
        }));
      return [...current, ...additions];
    });
  };

  const moveAllProblemsToQueue = () => {
    setQueue((current) => {
      const existing = new Set(
        current.filter((i) => i.source === 'problem').map((i) => i.sourceId),
      );
      const additions: QueueItem[] = problems
        .filter((p) => !existing.has(p.id))
        .map((p) => ({
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${p.id}`,
          source: 'problem',
          sourceId: p.id,
          label: p.msg,
          detail: p.line ? `${p.file}:${p.line}` : p.file,
          status: 'pending',
        }));
      return [...current, ...additions];
    });
  };

  return (
    <div className="verify-shell">
      <PanelHeader {...header}>
        <span className="panel-header__title">verify</span>
        <span className="panel-header__sep" aria-hidden="true" />
        <span className="panel-header__meta">problems {problems.length}</span>
        <span className="panel-header__meta">checks {checks.length}</span>
        <span className="panel-header__meta">queue {queue.length}</span>
        {running && <span className="panel-header__meta panel-header__meta--live">running</span>}
      </PanelHeader>
    <div className="verify-grid verify-grid--queue">
      <div className="verify-stack">
        <section className="verify-section">
          <header>
            <h2>problems</h2>
            <small>{problems.length} {problems.length === 1 ? 'item' : 'items'}</small>
            <button
              className="verify-move-all"
              onClick={moveAllProblemsToQueue}
              disabled={problems.length === 0}
              title="move all problems to queue"
            >
              queue all
            </button>
          </header>
          <div className="problems-list">
            {problems.length === 0 ? (
              <span className="verify-empty">no problems · clean</span>
            ) : (
              problems.map((item) => (
                <div
                  key={item.id}
                  draggable
                  className={`problem-row problem-row--${item.severity}`}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'copy';
                    event.dataTransfer.setData(
                      FIX_ITEM_MIME,
                      JSON.stringify({
                        source: 'problem',
                        sourceId: item.id,
                        label: item.msg,
                        detail: item.line ? `${item.file}:${item.line}` : item.file,
                      }),
                    );
                  }}
                >
                  <span className="problem-row__severity">{item.severity}</span>
                  <span className="problem-row__file">{item.file}{item.line ? `:${item.line}` : ''}</span>
                  <span className="problem-row__msg">{item.msg}</span>
                  <button
                    className="verify-row-action"
                    aria-label={`queue ${item.msg}`}
                    onClick={() => enqueue('problem', item.id, item.msg, item.line ? `${item.file}:${item.line}` : item.file)}
                  >
                    +
                  </button>
                </div>
              ))
            )}
          </div>
          {addingProblem && (
            <div className="verify-add-form">
              <input
                placeholder="problem to enqueue"
                value={problemDraft}
                autoFocus
                onChange={(event) => setProblemDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') addCustomProblem();
                  if (event.key === 'Escape') setAddingProblem(false);
                }}
              />
              <button onClick={addCustomProblem}>add</button>
            </div>
          )}
          <div className="verify-section__footer">
            <button className="verify-add" onClick={() => setAddingProblem((v) => !v)}>create +</button>
          </div>
        </section>

        <section className="verify-section">
          <header>
            <div className="verify-section__heading">
              <h2>checks</h2>
              <small>{checks.length} {checks.length === 1 ? 'item' : 'items'}</small>
            </div>
            <div className="verify-section__actions">
              <button
                className="verify-move-all"
                onClick={moveAllChecksToQueue}
                disabled={checks.length === 0}
                title="move all checks to queue"
              >
                queue all
              </button>
            </div>
          </header>
          <div className="checks-list">
            {checks.map((check) => (
              <article
                key={check.id}
                draggable
                className={`check-row check-row--${check.status}`}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'copy';
                  event.dataTransfer.setData(
                    FIX_ITEM_MIME,
                    JSON.stringify({
                      source: 'check',
                      sourceId: check.id,
                      label: check.label,
                      detail: check.cmd,
                    }),
                  );
                }}
                >
                  <span className="check-row__label">{check.label}</span>
                  <code>{check.cmd}</code>
                  <button
                    className="verify-row-action"
                    aria-label={`queue ${check.label}`}
                  onClick={() => enqueue('check', check.id, check.label, check.cmd)}
                >
                  +
                </button>
              </article>
            ))}
          </div>
          {addingCheck && (
            <div className="verify-add-form">
              <input
                placeholder="custom command, e.g. npm run e2e"
                value={checkDraft}
                autoFocus
                onChange={(event) => setCheckDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') addCustomCheck();
                  if (event.key === 'Escape') setAddingCheck(false);
                }}
              />
              <button onClick={addCustomCheck}>add</button>
            </div>
          )}
          <div className="verify-section__footer">
            <button className="verify-add" onClick={() => setAddingCheck((v) => !v)}>create +</button>
          </div>
        </section>
      </div>

      <section className="verify-queue">
        <header>
          <h2>queue</h2>
          <small>{queue.length} queued</small>
        </header>
        <div
          className={`queue-list ${queueHover ? 'queue-list--drop' : ''}`}
          onDragOver={(event) => {
            const types = Array.from(event.dataTransfer.types);
            if (types.includes(FIX_ITEM_MIME) || types.includes(QUEUE_ITEM_MIME)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = types.includes(QUEUE_ITEM_MIME) ? 'move' : 'copy';
              setQueueHover(true);
            }
          }}
          onDragLeave={() => setQueueHover(false)}
          onDrop={(event) => {
            event.preventDefault();
            setQueueHover(false);
            const fixData = event.dataTransfer.getData(FIX_ITEM_MIME);
            if (fixData) {
              const item = JSON.parse(fixData) as { source: 'problem' | 'check'; sourceId: string; label: string; detail?: string };
              enqueue(item.source, item.sourceId, item.label, item.detail);
            }
          }}
        >
          {queue.length === 0 ? (
            <span className="verify-empty queue-empty">drag problems and checks here to assemble a fix list</span>
          ) : (
            queue.map((item, index) => (
              <article
                key={item.id}
                draggable={!running}
                className={`queue-item queue-item--${item.status} ${draggedQueueId === item.id ? 'queue-item--dragging' : ''}`}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData(QUEUE_ITEM_MIME, item.id);
                  setDraggedQueueId(item.id);
                }}
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes(QUEUE_ITEM_MIME)) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setQueueHover(false);
                  const fromId = event.dataTransfer.getData(QUEUE_ITEM_MIME);
                  if (fromId) reorderQueue(fromId, item.id);
                  setDraggedQueueId(null);
                }}
                onDragEnd={() => setDraggedQueueId(null)}
              >
                <span className="queue-item__index">{index + 1}</span>
                <div className="queue-item__body">
                  <span className="queue-item__type">{item.source === 'problem' ? 'fix' : 'run'}</span>
                  <strong>{item.label}</strong>
                  {item.detail && <small>{item.detail}</small>}
                </div>
                <span className="queue-item__status">{item.status}</span>
                <button
                  className="queue-item__close"
                  aria-label={`remove ${item.label} from queue`}
                  disabled={running && item.status === 'fixing'}
                  onClick={() => removeQueueItem(item.id)}
                >
                  x
                </button>
              </article>
            ))
          )}
        </div>
        <div className="queue-actions">
          <button
            className="queue-run"
            disabled={running || queue.filter((item) => item.status === 'pending').length === 0}
            onClick={runQueue}
          >
            {running ? 'sending...' : 'send to chat'}
          </button>
          <button
            disabled={running || queue.length === 0}
            onClick={() => setQueue([])}
          >
            clear
          </button>
        </div>
      </section>
    </div>
    </div>
  );
}

function ProblemsSurface({ header }: { header: PanelHeaderProps }) {
  return (
    <section className="surface-card">
      <PanelHeader {...header}>
        <span className="panel-header__title">problems</span>
        <span className="panel-header__sep" aria-hidden="true" />
        <span className="panel-header__meta">{initialProblems.length} items</span>
      </PanelHeader>
      <header><h2>problems</h2><small>{initialProblems.length} items</small></header>
      <div className="problems-list">
        {initialProblems.map((item) => (
          <div key={item.id} className={`problem-row problem-row--${item.severity}`}>
            <span className="problem-row__severity">{item.severity}</span>
            <span className="problem-row__file">{item.file}:{item.line}</span>
            <span className="problem-row__msg">{item.msg}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function MemorySurface({
  contextItems,
  onAddContext,
  header,
}: {
  contextItems: string[];
  onAddContext: (label: string) => void;
  header: PanelHeaderProps;
}) {
  const [dragOver, setDragOver] = useState(false);

  return (
    <div className="memory-shell">
      <PanelHeader {...header}>
        <span className="panel-header__title">memory</span>
        <span className="panel-header__sep" aria-hidden="true" />
        <span className="panel-header__meta">context {initialOperatorState.contextUsedPct}%</span>
        <span className="panel-header__meta">{contextItems.length} loaded</span>
        <span className="panel-header__meta">{memoryFileTree.length} folders</span>
      </PanelHeader>
    <div className="memory-grid">
      <section className="memory-context">
        <h2>loaded context</h2>
        <div className="context-meter-card">
          <span>active context</span>
          <strong>{initialOperatorState.contextUsedPct}%</strong>
          <i><b style={{ width: `${initialOperatorState.contextUsedPct}%` }} /></i>
          <em>recommend handoff at 80%</em>
        </div>
        <div
          className={`context-list ${dragOver ? 'context-list--drop' : ''}`}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('application/x-knowledge-file')) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            const path = event.dataTransfer.getData('application/x-knowledge-file');
            if (path) onAddContext(`included: ${path}`);
          }}
        >
          {contextItems.map((item) => (
            <button key={item}>{item}</button>
          ))}
          <span className="context-list__hint">drop files here to load context</span>
        </div>
        <div className="context-actions">
          <button>write handoff</button>
          <button>compress</button>
        </div>
      </section>
      <section className="memory-library nav-section">
        <header className="nav-section__head">
          <span className="folder-symbol">dir</span>
          <strong className="nav-section__title">knowledge base</strong>
          <small className="nav-section__count">{memoryFileTree.length} folders</small>
        </header>
        <nav className="nav-section__list">
          <FileTree nodes={memoryFileTree} draggable dragMime="application/x-knowledge-file" />
        </nav>
        <div className="memory-actions">
          <button className="memory-action">+ new note</button>
        </div>
      </section>
      <section className="memory-document">
        <header className="memory-document__head">
          <h2>selected note</h2>
          <button>load note</button>
        </header>
        <article>
          <h3>[[ui direction]]</h3>
          <p>formation controls agent hierarchy. history fuses into diff. memory owns project knowledge and active context.</p>
          <p>handoff docs let the agent clear context, then restart by reading its own written brief instead of compacting the full conversation.</p>
          <p>linked docs: [[agent conventions]], [[dockable shell]], [[repo map]]</p>
        </article>
      </section>
    </div>
    </div>
  );
}

function AgentSurface({ header }: { header: PanelHeaderProps }) {
  const [detailsWidth, setDetailsWidth] = useState(33);
  const [activityHeight, setActivityHeight] = useState(48);
  const [skills, setSkills] = useState(skillCards);
  const [creatingSkill, setCreatingSkill] = useState(false);
  const [skillDraft, setSkillDraft] = useState('');

  const createSkill = () => {
    const name = skillDraft.trim();
    if (!name) return;
    setSkills((current) => [
      {
        id: `skill-${Date.now()}`,
        name,
        summary: 'new local skill draft',
      },
      ...current,
    ]);
    setSkillDraft('');
    setCreatingSkill(false);
  };

  const runningAgents = formationNodes.filter((node) => node.status === 'running').length;
  const openTasks = taskItems.filter((t) => !t.done).length;

  return (
    <div className="agent-shell">
      <PanelHeader {...header}>
        <span className="panel-header__title">agent</span>
        <span className="panel-header__sep" aria-hidden="true" />
        <span className="panel-header__meta">{formationNodes.length} agents</span>
        <span className="panel-header__meta">{runningAgents} running</span>
        <span className="panel-header__meta">{openTasks} tasks open</span>
      </PanelHeader>
    <div
      className="inspector-grid"
      style={{
        gridTemplateColumns: `minmax(240px, ${detailsWidth}%) 8px minmax(360px, 1fr)`,
        gridTemplateRows: `minmax(130px, ${activityHeight}%) 8px minmax(130px, 1fr)`,
      }}
    >
      <section className="agent-skills">
        <header className="agent-section-head">
          <h2>skills</h2>
          <button className="skill-create-button" onClick={() => setCreatingSkill((open) => !open)}>
            + skill
          </button>
        </header>
        {creatingSkill && (
          <div className="skill-create-form">
            <input
              value={skillDraft}
              placeholder="skill name"
              onChange={(event) => setSkillDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') createSkill();
                if (event.key === 'Escape') setCreatingSkill(false);
              }}
            />
            <button onClick={createSkill}>create</button>
          </div>
        )}
        <div className="skills-list">
          {skills.map((skill) => (
            <article key={skill.id} className="skill-card">
              <span className="skill-card__name">{skill.name}</span>
              <span className="skill-card__summary">{skill.summary}</span>
            </article>
          ))}
        </div>
      </section>
      <section className="agent-tasks">
        <h2>tasks</h2>
        <div className="task-list task-list--embedded">
          {taskItems.map((task) => (
            <section key={task.id}>
              <input type="checkbox" checked={task.done} readOnly />
              <span>{task.label}</span>
            </section>
          ))}
        </div>
      </section>
      <ResizeHandle
        axis="x"
        label="resize agent details and formation"
        onDrag={(event, handle) => {
          const bounds = handle.parentElement?.getBoundingClientRect();
          if (!bounds) return;
          const next = ((event.clientX - bounds.left) / bounds.width) * 100;
          setDetailsWidth(Math.min(45, Math.max(24, next)));
        }}
      />
      <section className="agent-viewport">
        <h2>formation</h2>
        <div className="formation-canvas">
          <div className="formation-board">
            <svg className="formation-wires" aria-hidden="true">
              <line x1="50%" y1="58" x2="18%" y2="170" />
              <line x1="50%" y1="58" x2="50%" y2="170" />
              <line x1="50%" y1="58" x2="82%" y2="170" />
            </svg>
            {formationNodes.map((node) => (
              <button
                key={node.id}
                className={`formation-node formation-node--${node.status} ${node.root ? 'formation-node--root' : ''}`.trim()}
                style={{ left: node.left, top: node.top }}
              >
                <span className="formation-node__main">
                  <strong>{node.role}</strong>
                  <small>{node.status}</small>
                </span>
                <span className="formation-node__detail">{node.detail}</span>
                <span
                  className="formation-node__gear"
                  aria-label={`${node.role} settings`}
                  role="img"
                >
                  gear
                </span>
              </button>
            ))}
          </div>
          <button className="formation-add">+ node</button>
        </div>
      </section>
      <ResizeHandle
        axis="y"
        label="resize skills and tasks"
        onDrag={(event, handle) => {
          const bounds = handle.parentElement?.getBoundingClientRect();
          if (!bounds) return;
          const next = ((event.clientY - bounds.top) / bounds.height) * 100;
          setActivityHeight(Math.min(70, Math.max(30, next)));
        }}
      />
    </div>
    </div>
  );
}

function ResizeHandle({
  axis,
  label,
  onDrag,
}: {
  axis: 'x' | 'y';
  label: string;
  onDrag: (event: PointerEvent, handle: HTMLDivElement) => void;
}) {
  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => onDrag(moveEvent, handle);
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  return <div className={`resize-handle resize-handle--${axis}`} aria-label={label} role="separator" onPointerDown={beginDrag} />;
}

function BottomBar() {
  return (
    <footer className="bottombar">
      <span>branch:{initialOperatorState.branch}</span>
      <span>file:demo.tsx</span>
      <span>ln:1 col:1</span>
      <span>verify:fail · 1 problem</span>
    </footer>
  );
}

export default App;
