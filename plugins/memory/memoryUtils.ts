import type { FileNode } from '../shared';

export type ContextDocState = 'loaded' | 'compacted' | 'queued';

export type ContextDoc = {
  path: string;
  bytes: number;
  tokens: number;
  state: ContextDocState;
  readCount: number;
  contextItem?: string;
};

export type MemoryContext = {
  contextItems: string[];
  contextByChat: Record<string, string[]>;
  contextDocsByChat?: Record<string, ContextDoc[]>;
  onAddContext: (label: string, targetId?: string) => void;
  onRemoveContext: (label: string, targetId?: string) => void;
};

export type ChatTarget = {
  id: string;
  agent: string;
  title: string;
  active: boolean;
};

export type ChatSessionSummary = {
  id: string;
  agent: string;
  title: string;
  createdAt: number;
};

export type ChatMessageSummary = {
  by?: string;
  text?: string;
  ts?: number;
};

export type ChatContextStats = {
  source: 'chat history' | 'terminal' | 'chat history + terminal';
  bytes: number;
  tokens: number;
  turns: number;
  updatedAt?: number;
};

export type TerminalContextStats = {
  panelId: string;
  title?: string;
  agent?: string;
  inputChars: number;
  outputChars: number;
  transcriptChars: number;
  transcriptBytes: number;
  tokens: number;
  updatedAt: number;
  removed?: boolean;
};

export type ContextInventoryItem = {
  key: string;
  item: string;
  label: string;
  path: string;
  kind: 'file' | 'entry';
  bytes: number;
  tokens: number;
  missing: boolean;
};

export type KnowledgeBaseScope = 'global' | 'project';
export type KnowledgeBasePreset = 'blank' | 'basic';

export type KnowledgeBase = {
  id: string;
  name: string;
  root: string;
  scope: KnowledgeBaseScope;
  suggestedScope: KnowledgeBaseScope;
};

export type KnowledgeNode = {
  kind: 'doc' | 'folder';
  path: string;
};

export type KnowledgeIndex = {
  tree: FileNode[];
  docs: Map<string, string>;
};

export const AGENT_PANEL_SLOTS = new Set(['codex', 'claude']);

export function formatTokens(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k`;
  return String(count);
}

export function formatBytes(count: number): string {
  if (count >= 1024 * 1024) return `${(count / (1024 * 1024)).toFixed(count >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (count >= 1024) return `${(count / 1024).toFixed(count >= 10 * 1024 ? 0 : 1)} KB`;
  return `${count} B`;
}

export function formatContextSize(bytes: number, tokens: number): string {
  return `${formatBytes(bytes)} · ${formatTokens(tokens)} tok`;
}

export function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 4);
}

export function byteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function defaultBaseId(bases: KnowledgeBase[]) {
  return bases.find((base) => base.scope === 'project')?.id ?? bases[0]?.id ?? '';
}

export function sortKnowledgeBases(bases: KnowledgeBase[]) {
  return [...bases].sort((left, right) => (
    left.scope.localeCompare(right.scope)
      || left.name.toLowerCase().localeCompare(right.name.toLowerCase())
  ));
}

export function sameKnowledgeBases(left: KnowledgeBase[], right: KnowledgeBase[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((base, index) => {
    const other = right[index];
    return base.id === other.id
      && base.name === other.name
      && base.root === other.root
      && base.scope === other.scope
      && base.suggestedScope === other.suggestedScope;
  });
}

export function sameFileTrees(left: FileNode[], right: FileNode[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((node, index) => sameFileNode(node, right[index]));
}

export function sameFileNode(left: FileNode, right: FileNode): boolean {
  if (left.kind !== right.kind || left.name !== right.name) return false;
  if (left.kind === 'file') {
    return right.kind === 'file'
      && left.path === right.path
      && left.subtitle === right.subtitle;
  }
  return right.kind === 'folder' && sameFileTrees(left.children, right.children);
}

export function sameStringMaps(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

export function sameChatTargets(left: ChatTarget[], right: ChatTarget[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((target, index) => {
    const other = right[index];
    return target.id === other.id
      && target.agent === other.agent
      && target.title === other.title
      && target.active === other.active;
  });
}

export function sameChatContextStats(
  left: ChatContextStats | null,
  right: ChatContextStats | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.source === right.source
    && left.bytes === right.bytes
    && left.tokens === right.tokens
    && left.turns === right.turns;
}

export function sameTerminalStatsRecord(
  left: Record<string, TerminalContextStats>,
  right: Record<string, TerminalContextStats>,
): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => sameTerminalContextStats(left[key], right[key]));
}

export function sameTerminalContextStats(
  left: TerminalContextStats | undefined,
  right: TerminalContextStats | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.panelId === right.panelId
    && left.title === right.title
    && left.agent === right.agent
    && left.inputChars === right.inputChars
    && left.outputChars === right.outputChars
    && left.transcriptChars === right.transcriptChars
    && left.transcriptBytes === right.transcriptBytes
    && left.tokens === right.tokens
    && left.updatedAt === right.updatedAt
    && left.removed === right.removed;
}

export function pathFromContextItem(item: string): string {
  const match = item.match(/^included:\s*(.+)$/);
  return match?.[1].trim() ?? '';
}

export function buildContextInventory({
  items,
  docs,
  cachedFiles,
  selectedPath,
  selectedContent,
}: {
  items: string[];
  docs: Map<string, string>;
  cachedFiles: Map<string, string>;
  selectedPath: string;
  selectedContent: string;
}): ContextInventoryItem[] {
  return items.map((item, index) => {
    const path = pathFromContextItem(item);
    const content = path === selectedPath
      ? selectedContent
      : path
        ? docs.get(path) ?? cachedFiles.get(path)
        : item;
    const missing = path ? content === undefined : false;
    const body = content ?? '';
    return {
      key: `${item}:${index}`,
      item,
      label: path || item,
      path,
      kind: path ? 'file' : 'entry',
      bytes: byteSize(body),
      tokens: estimateTokensFromText(body),
      missing,
    };
  });
}

export function chatContextStatsForTarget(
  target: ChatTarget,
  hostStats: ChatContextStats | null,
  terminalStats?: TerminalContextStats,
): ChatContextStats {
  if (hostStats && terminalStats) {
    return {
      source: 'chat history + terminal',
      bytes: hostStats.bytes + terminalStats.transcriptBytes,
      tokens: hostStats.tokens + terminalStats.tokens,
      turns: hostStats.turns,
      updatedAt: Math.max(hostStats.updatedAt ?? 0, terminalStats.updatedAt),
    };
  }
  if (hostStats) return hostStats;
  if (terminalStats) {
    return {
      source: 'terminal',
      bytes: terminalStats.transcriptBytes,
      tokens: terminalStats.tokens,
      turns: 0,
      updatedAt: terminalStats.updatedAt,
    };
  }
  return {
    source: 'terminal',
    bytes: 0,
    tokens: 0,
    turns: 0,
    updatedAt: Date.now(),
  };
}

export function resolveChatSession(sessions: ChatSessionSummary[], target: ChatTarget): ChatSessionSummary | null {
  const exactIds = new Set([target.id, `${target.id}-main`, defaultChatSessionId(target)]);
  return sessions.find((session) => exactIds.has(session.id))
    ?? sessions.find((session) => session.agent === target.agent && session.id.startsWith(`${target.agent}-`))
    ?? sessions.find((session) => session.agent === target.agent)
    ?? null;
}

export function defaultChatSessionId(target: ChatTarget): string {
  return `${target.agent}-main`;
}

export function chatSessionMatchesTarget(sessionId: string, target: ChatTarget): boolean {
  return sessionId === target.id
    || sessionId === `${target.id}-main`
    || sessionId === defaultChatSessionId(target)
    || sessionId.startsWith(`${target.agent}-`);
}

export function statsFromChatMessages(messages: ChatMessageSummary[]): ChatContextStats {
  const transcript = messages.map((message) => (
    `${String(message.by || 'message')}:\n${String(message.text || '')}`
  )).join('\n\n');
  return {
    source: 'chat history',
    bytes: byteSize(transcript),
    tokens: estimateTokensFromText(transcript),
    turns: messages.length,
    updatedAt: messages.reduce((latest, message) => (
      typeof message.ts === 'number' ? Math.max(latest, message.ts) : latest
    ), 0) || undefined,
  };
}

export function readTerminalContextStats(): Record<string, TerminalContextStats> {
  const value = (window as Window & {
    __polyporeTerminalContextStats?: Map<string, TerminalContextStats> | Record<string, TerminalContextStats>;
  }).__polyporeTerminalContextStats;
  if (value instanceof Map) return Object.fromEntries(value.entries());
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, TerminalContextStats] => (
    Boolean(entry[1]?.panelId)
  )));
}

export function chatTargetsFromState(value: unknown): ChatTarget[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const panel = item as Partial<ChatTarget> & { agent?: unknown };
    if (typeof panel.id !== 'string' || typeof panel.agent !== 'string') return [];
    if (!AGENT_PANEL_SLOTS.has(panel.agent)) return [];
    return [{
      id: panel.id,
      agent: panel.agent,
      title: typeof panel.title === 'string' && panel.title ? panel.title : panel.agent,
      active: panel.active === true,
    }];
  });
}

export function chatTargetsFromDockview(): ChatTarget[] {
  const dock = (window as Window & {
    __polyporeDockview?: {
      listPanels?: () => Array<{ id: string; slot: string; title?: string }>;
    };
  }).__polyporeDockview;
  let panels: Array<{ id: string; slot: string; title?: string }> = [];
  try {
    panels = dock?.listPanels?.() ?? [];
  } catch {
    panels = [];
  }
  return panels.flatMap((panel) => {
    if (!panel.id || !AGENT_PANEL_SLOTS.has(panel.slot)) return [];
    return [{
      id: panel.id,
      agent: panel.slot,
      title: chatPanelTitle(panel.title, panel.slot),
      active: false,
    }];
  });
}

export function reconcileChatTargets(stateTargets: ChatTarget[], panelTargets: ChatTarget[]) {
  if (panelTargets.length === 0) return stateTargets;
  const stateById = new Map(stateTargets.map((target) => [target.id, target]));
  const merged = panelTargets.map((target) => {
    const stateTarget = stateById.get(target.id);
    return {
      ...target,
      title: stateTarget?.title || target.title,
      active: stateTarget?.active ?? target.active,
    };
  });
  const panelIds = new Set(panelTargets.map((target) => target.id));
  for (const target of stateTargets) {
    if (!panelIds.has(target.id)) merged.push(target);
  }
  return merged;
}

export function chatPanelTitle(title: string | undefined, agent: string) {
  const cleaned = title
    ?.replace(/^[^\w]+/, '')
    .replace(/^(?:cd|cl)\s+(?=codex|claude)/i, '')
    .trim();
  return cleaned || agent;
}

export function knowledgeTreeFromNodes(nodes: KnowledgeNode[]): FileNode[] {
  const root: FileNode[] = [];
  for (const node of nodes) {
    const path = node.path.replace(/^\/+|\/+$/g, '');
    if (!path) continue;
    const parts = path.split('/').filter(Boolean);
    if (node.kind === 'folder') {
      ensureFolders(root, parts);
      continue;
    }
    const fileName = parts.pop();
    if (!fileName) continue;
    const children = ensureFolders(root, parts);
    if (!children.some((child) => child.kind === 'file' && child.path === path)) {
      children.push({ kind: 'file', name: fileName, path });
    }
  }
  return sortKnowledgeNodes(root);
}

export function ensureFolders(nodes: FileNode[], parts: string[]): FileNode[] {
  return parts.reduce((children, name) => {
    const found = children.find((child): child is Extract<FileNode, { kind: 'folder' }> => (
      child.kind === 'folder' && child.name === name
    ));
    if (found) return found.children;
    const folder: Extract<FileNode, { kind: 'folder' }> = { kind: 'folder', name, children: [] };
    children.push(folder);
    return folder.children;
  }, nodes);
}

export function flattenFiles(nodes: FileNode[]): string[] {
  return nodes.flatMap((node) => (node.kind === 'file' ? [node.path] : flattenFiles(node.children)));
}

export function folderPaths(nodes: FileNode[], parentPath = ''): string[] {
  return nodes.flatMap((node) => {
    if (node.kind === 'file') return [];
    const path = parentPath ? `${parentPath}/${node.name}` : node.name;
    return [path, ...folderPaths(node.children, path)];
  });
}

export function folderAncestors(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

export function sortKnowledgeNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes]
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
    .map((node) => (node.kind === 'folder'
      ? { ...node, children: sortKnowledgeNodes(node.children) }
      : node));
}
