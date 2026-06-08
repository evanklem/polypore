import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { BuiltinPluginProps, ChatTarget } from '../shared';
import {
  PanelHeader,
  ResizeHandle,
  useResizableSplit,
  openChatPanelTargets,
  deliverPromptToTarget,
} from '../shared';
import { SectionHeader } from './SectionHeader';
import { EmptyState } from './EmptyState';
import { PanelSheet } from './PanelSheet';
import { mergeDiscoveredMcps, type DiscoveredMcp, type MergedMcpRow } from './mergeDiscoveredMcps';

/* skill bodies are markdown; render links so they open externally rather than
   navigating the whole webview away (mirrors the manual reader). */
const MARKDOWN_COMPONENTS = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
  ),
};

type SkillCard = {
  id: string;
  name: string;
  summary: string;
  body?: string;
  skillsetId?: string;
  origin?: 'polypore' | 'builtin' | 'claude' | 'codex';
  publishedTo?: Array<'claude' | 'codex'>;
};

type McpInstallAgent = 'claude-project' | 'claude-user' | 'codex';
type McpInstallTarget = 'claude' | 'codex' | 'global';
type McpInstallDraft = {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  argsText: string;
  envText: string;
  url: string;
  headersText: string;
  targets: McpInstallTarget[];
  claudeScope: 'project' | 'user';
};
const EMPTY_INSTALL_DRAFT: McpInstallDraft = {
  name: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  envText: '',
  url: '',
  headersText: '',
  targets: ['claude'],
  claudeScope: 'project',
};

function deriveInstallAgents(draft: McpInstallDraft): McpInstallAgent[] {
  const out = new Set<McpInstallAgent>();
  if (draft.targets.includes('claude')) out.add(draft.claudeScope === 'user' ? 'claude-user' : 'claude-project');
  if (draft.targets.includes('codex')) out.add('codex');
  if (draft.targets.includes('global')) { out.add('claude-user'); out.add('codex'); }
  return [...out];
}

function parseKvText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      if (key) result[key] = trimmed.slice(eq + 1);
    }
  }
  return result;
}

type SkillScopeChip = 'claude' | 'codex' | 'global';
const SCOPE_CYCLE: SkillScopeChip[] = ['claude', 'codex', 'global'];
type SkillDraft = {
  name: string;
  body: string;
  skillsetId: string;
  chip: SkillScopeChip;
};
type SkillEditDraft = SkillDraft;
const EMPTY_SKILL_DRAFT: SkillDraft = { name: '', body: '', skillsetId: '', chip: 'global' };

function chipForSkill(skill: SkillCard): SkillScopeChip {
  if (skill.origin === 'claude' || skill.origin === 'codex') return skill.origin;
  const exported = skill.publishedTo ?? [];
  if (exported.includes('claude') && exported.includes('codex')) return 'global';
  if (exported.includes('claude')) return 'claude';
  if (exported.includes('codex')) return 'codex';
  return 'global';
}

function agentsForChip(chip: SkillScopeChip): Array<'claude' | 'codex'> {
  if (chip === 'global') return ['claude', 'codex'];
  if (chip === 'claude') return ['claude'];
  return ['codex'];
}

function summarizeSkillDraft(body: string) {
  return body
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('#'))
    ?.slice(0, 120) ?? '';
}

type SkillsetCard = {
  id: string;
  title: string;
  version: string;
  builtin?: boolean;
  source?: string;
  summary?: string;
  skills: string[];
};

type McpServerCard = {
  id: string;
  name: string;
  url: string;
  scope: 'project' | 'user' | 'polypore';
  authRef?: string;
  lastTest?: { ok: boolean; ts: number; status?: number; error?: string };
};

type SecretMask = {
  id: string;
  scope: 'user' | 'project';
  service: string;
  hint: string;
  configured: boolean;
};

type NodeStatus = 'running' | 'waiting' | 'idle' | 'missing';

type FormationNode = {
  id: string;
  role: string;
  detail: string;
  status: NodeStatus;
  prompt: string;
  model: string;
  skills: string[];
  tools: string[];
  x: number;
  y: number;
  root?: boolean;
  templateId?: string;
};

type FormationEdge = {
  from: string;
  to: string;
};

type NodeTemplate = {
  id: string;
  role: string;
  detail: string;
  prompt: string;
  model: string;
  skills: string[];
  tools: string[];
  builtin?: boolean;
  customized?: boolean;
};

type OpenAgentPanel = {
  id: string;
  agent: string;
  title: string;
  active?: boolean;
};

const NODE_WIDTH = 200;
const NODE_HEIGHT = 58;
const FIT_VIEW_PADDING = 72;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 1.8;
const FORMATION_KEY = 'polypore.agent.formation.v2';
const TEMPLATES_KEY = 'polypore.agent.templates.v1';
const LEGACY_FORMATION_KEY = 'polypore.agent.formation';
const DEFAULT_NODE_MODEL = 'inherit';

const MODEL_OPTIONS = [
  'inherit',
  'runtime',
  'claude-opus',
  'claude-sonnet',
  'claude-haiku',
  'codex',
  'gpt-5',
];

const AVAILABLE_TOOLS = [
  'edit',
  'bash',
  'web',
  'search',
  'git',
  'mcp',
  'verify',
  'memory',
];

const BUILTIN_MCP = {
  key: 'builtin:polypore-ide',
  name: 'polypore-ide',
  detail: 'node packages/mcp-server/src/server.mjs',
};

function mcpRowDetail(row: MergedMcpRow): string {
  if (row.kind === 'managed') return row.url;
  if (row.url) return row.url;
  if (row.command) return [row.command, ...(row.args ?? [])].join(' ');
  return row.transport;
}

const BUILTIN_TEMPLATES: NodeTemplate[] = [
  {
    id: 'tpl-overseer',
    role: 'overseer',
    detail: 'task conductor · plans + delegates',
    prompt:
      'You are the overseer. Break the user goal into vertical slices, assign them to the right role, review handoffs, and keep state coherent across subagents. Stop and surface blockers — do not implement directly.',
    model: DEFAULT_NODE_MODEL,
    skills: [],
    tools: ['search', 'memory'],
    builtin: true,
  },
  {
    id: 'tpl-frontend',
    role: 'frontend',
    detail: 'ui implementation · project stack',
    prompt:
      'You implement interface changes in the project stack. Match the existing design language, keep components small, and verify rendered output before reporting done. Prefer editing existing files over creating new ones.',
    model: DEFAULT_NODE_MODEL,
    skills: [],
    tools: ['edit', 'bash', 'verify'],
    builtin: true,
  },
  {
    id: 'tpl-backend',
    role: 'backend',
    detail: 'apis · data · server logic',
    prompt:
      'You own backend changes: APIs, persistence, server modules. Be explicit about contracts. Write integration tests against real dependencies, not mocks.',
    model: DEFAULT_NODE_MODEL,
    skills: [],
    tools: ['edit', 'bash', 'verify'],
    builtin: true,
  },
  {
    id: 'tpl-qa',
    role: 'qa',
    detail: 'verification · edge cases',
    prompt:
      'You verify. Reproduce the change, exercise the golden path and the obvious edge cases, and report what actually happened — never claim success without observed behavior.',
    model: DEFAULT_NODE_MODEL,
    skills: [],
    tools: ['bash', 'verify'],
    builtin: true,
  },
  {
    id: 'tpl-security',
    role: 'security',
    detail: 'threat model · risky apis',
    prompt:
      'You review for security risk: input validation gaps, auth/authz, secret handling, supply chain. Use sharp-edges/secure-defaults lens; flag concrete issues with file:line.',
    model: DEFAULT_NODE_MODEL,
    skills: [],
    tools: ['search', 'mcp'],
    builtin: true,
  },
  {
    id: 'tpl-debugger',
    role: 'debugger',
    detail: 'root-cause · hypothesis-driven',
    prompt:
      'You debug. State the hypothesis, prove it with an observation, and only then change code. No speculative fixes. If the hypothesis is wrong, say so and try another.',
    model: DEFAULT_NODE_MODEL,
    skills: [],
    tools: ['edit', 'bash', 'search'],
    builtin: true,
  },
  {
    id: 'tpl-researcher',
    role: 'researcher',
    detail: 'gather context · synthesize',
    prompt:
      'You research the codebase or external docs to answer a specific question. Return a tight synthesis (file paths, key snippets, citations) — no narration of what you did.',
    model: DEFAULT_NODE_MODEL,
    skills: [],
    tools: ['search', 'web'],
    builtin: true,
  },
  {
    id: 'tpl-reviewer',
    role: 'reviewer',
    detail: 'independent code review',
    prompt:
      'You give second-opinion review on a diff. Independent — you did not write this code. Call out bugs, missing tests, and cohesion violations. Be specific; quote file:line.',
    model: DEFAULT_NODE_MODEL,
    skills: [],
    tools: ['search'],
    builtin: true,
  },
];

const BLANK_TEMPLATE: NodeTemplate = {
  id: 'tpl-blank',
  role: 'agent',
  detail: 'custom role',
  prompt: '',
  model: DEFAULT_NODE_MODEL,
  skills: [],
  tools: [],
};

function cleanTemplate(raw: Partial<NodeTemplate>, builtinIds = new Set<string>()): NodeTemplate | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) return null;
  const role = typeof raw.role === 'string' && raw.role.trim() ? raw.role : 'agent';
  const isBuiltinOverride = builtinIds.has(raw.id);
  return {
    id: raw.id,
    role,
    detail: typeof raw.detail === 'string' && raw.detail.trim() ? raw.detail : role,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model : DEFAULT_NODE_MODEL,
    skills: Array.isArray(raw.skills) ? raw.skills.filter((id): id is string => typeof id === 'string') : [],
    tools: Array.isArray(raw.tools) ? raw.tools.filter((id): id is string => typeof id === 'string') : [],
    builtin: isBuiltinOverride ? true : undefined,
    customized: isBuiltinOverride || Boolean(raw.customized),
  };
}

function mergeStoredTemplates(stored: unknown): NodeTemplate[] {
  const builtinIds = new Set(BUILTIN_TEMPLATES.map((tpl) => tpl.id));
  const byId = new Map(BUILTIN_TEMPLATES.map((tpl) => [tpl.id, { ...tpl }] as const));
  const custom: NodeTemplate[] = [];
  if (!Array.isArray(stored)) return [...byId.values()];

  for (const raw of stored) {
    const tpl = cleanTemplate(raw as Partial<NodeTemplate>, builtinIds);
    if (!tpl) continue;
    if (builtinIds.has(tpl.id)) byId.set(tpl.id, tpl);
    else custom.push(tpl);
  }
  return [...byId.values(), ...custom];
}

function templatesForStorage(items: NodeTemplate[]): NodeTemplate[] {
  return items
    .filter((tpl) => !tpl.builtin || tpl.customized)
    .map((tpl) => ({
      id: tpl.id,
      role: tpl.role,
      detail: tpl.detail || tpl.role || 'custom role',
      prompt: tpl.prompt,
      model: tpl.model,
      skills: [...tpl.skills],
      tools: [...tpl.tools],
      customized: tpl.builtin ? true : undefined,
    }));
}

function newNodeId() {
  return `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function templateToNode(tpl: NodeTemplate, x: number, y: number, opts?: { root?: boolean }): FormationNode {
  return {
    id: newNodeId(),
    role: tpl.role,
    detail: tpl.detail,
    status: 'idle',
    prompt: tpl.prompt,
    model: tpl.model,
    skills: [...tpl.skills],
    tools: [...tpl.tools],
    templateId: tpl.id === 'tpl-blank' ? undefined : tpl.id,
    x,
    y,
    root: opts?.root,
  };
}

function providerForRoleModel(role: string, model: string) {
  const haystack = `${role} ${model}`.toLowerCase();
  if (haystack.includes('claude')) return 'claude';
  if (haystack.includes('codex')) return 'codex';
  return null;
}

function looksLikeLocalPath(value: string) {
  return value.startsWith('/') || value.startsWith('~/') || value.includes('/.local/bin/');
}

function blockedHandoffMessage(
  from: { role: string; model: string },
  to: { role: string; model: string },
) {
  if (providerForRoleModel(from.role, from.model) === 'codex'
    && providerForRoleModel(to.role, to.model) === 'claude') {
    return 'cannot add that handoff: anthropic does not support using claude as a subagent for codex.';
  }
  return null;
}

function withHandoff(nodes: FormationNode[], edges: FormationEdge[], fromId: string, toId: string) {
  const from = nodes.find((n) => n.id === fromId);
  const to = nodes.find((n) => n.id === toId);
  if (!from || !to) return { edges, from, to, blocked: null, added: false };
  const blocked = blockedHandoffMessage(from, to);
  if (blocked) return { edges, from, to, blocked, added: false };
  if (edges.some((e) => e.from === fromId && e.to === toId)) {
    return { edges, from, to, blocked: null, added: false };
  }
  return { edges: [...edges, { from: fromId, to: toId }], from, to, blocked: null, added: true };
}

function filterTemplatesByQuery(items: NodeTemplate[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((t) =>
    t.role.toLowerCase().includes(q) || t.detail.toLowerCase().includes(q),
  );
}

function sanitizeNode(node: Partial<FormationNode> & { left?: string; top?: string }, index = 0): FormationNode {
  const role = node.role ?? 'agent';
  const rawDetail = node.detail ?? '';
  const detectedRuntime = /claude|codex/i.test(`${role} ${node.model ?? ''}`);
  return {
    id: node.id ?? `node-${index}`,
    role,
    detail: looksLikeLocalPath(rawDetail) ? (node.status === 'missing' ? 'runtime unavailable' : '') : rawDetail,
    status: (node.status as NodeStatus) ?? 'idle',
    prompt: node.prompt ?? '',
    model: looksLikeLocalPath(node.model ?? '') ? 'runtime' : node.model ?? (detectedRuntime ? 'runtime' : 'inherit'),
    skills: Array.isArray(node.skills) ? node.skills : [],
    tools: Array.isArray(node.tools) ? node.tools : [],
    x: typeof node.x === 'number' ? node.x : 80 + (index % 3) * 220,
    y: typeof node.y === 'number' ? node.y : 120 + Math.floor(index / 3) * 130,
    root: node.root,
    templateId: node.templateId,
  };
}

function normalizeEdges(nodes: FormationNode[], edges: FormationEdge[]) {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const next = edges.filter((edge) => {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    return from && to && !blockedHandoffMessage(from, to);
  });
  return next;
}

/* the one root node that stands in for the active conversation. it is never
   deleted from the canvas while a chat is open — it *is* the chat. carries the
   previous root's position/prompt across a switch so the layout doesn't jump. */
function makeRootNode(panel: { id: string; agent: string; title?: string }, prev?: FormationNode): FormationNode {
  return {
    id: `panel-${panel.id}`,
    role: panel.title || panel.agent,
    detail: '',
    status: 'idle',
    prompt: prev?.prompt ?? '',
    model: panel.agent,
    skills: [],
    tools: [],
    x: prev?.x ?? 80,
    y: prev?.y ?? 60,
    root: true,
    templateId: 'runtime-panel',
  };
}

function readOpenChatTargets(): ChatTarget[] {
  if (typeof window === 'undefined') return [];
  return openChatPanelTargets();
}

/* nodes the active conversation root can actually dispatch to: itself plus
   everything wired downstream of it. anything not reachable is an orphan the
   chat has no path to, so it never makes it into the prompt bundle. */
function reachableFromRoot(nodes: FormationNode[], edges: FormationEdge[]): Set<string> {
  const reachable = new Set<string>();
  const root = nodes.find((n) => n.root);
  if (!root) return reachable;
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const bucket = out.get(e.from) ?? [];
    bucket.push(e.to);
    out.set(e.from, bucket);
  }
  const queue = [root.id];
  reachable.add(root.id);
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of out.get(id) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  return reachable;
}

function buildPromptBundle(allNodes: FormationNode[], allEdges: FormationEdge[], skills: SkillCard[]): string {
  if (allNodes.length === 0) return '';
  const root = allNodes.find((n) => n.root);
  /* only the active conversation root and what it can reach get dispatched;
     orphaned roles are left out. with no root (no chat open) fall back to the
     whole board so "copy" still works. */
  const reachable = root ? reachableFromRoot(allNodes, allEdges) : null;
  const formation = reachable ? allNodes.filter((n) => reachable.has(n.id)) : allNodes;
  const edges = reachable
    ? allEdges.filter((e) => reachable.has(e.from) && reachable.has(e.to))
    : allEdges;
  const skillLookup = new Map(skills.map((s) => [s.id, s] as const));
  const lines: string[] = [];
  lines.push('# Agent formation');
  lines.push('');
  lines.push(`Composed of ${formation.length} role${formation.length === 1 ? '' : 's'} and ${edges.length} handoff${edges.length === 1 ? '' : 's'}.`);
  lines.push('');
  lines.push('## Roles');
  for (const node of formation) {
    lines.push('');
    lines.push(`### ${node.role}${node.root ? ' (root)' : ''}`);
    lines.push(`- model: \`${node.model}\``);
    if (node.tools.length) lines.push(`- tools: ${node.tools.map((t) => `\`${t}\``).join(', ')}`);
    if (node.skills.length) {
      const names = node.skills.map((id) => skillLookup.get(id)?.name ?? id);
      lines.push(`- skills: ${names.map((n) => `\`${n}\``).join(', ')}`);
    }
    if (node.prompt) {
      lines.push('');
      lines.push(node.prompt);
    }
  }
  if (edges.length) {
    lines.push('');
    lines.push('## Handoff routes');
    const byFrom = new Map<string, FormationNode[]>();
    for (const edge of edges) {
      const from = formation.find((n) => n.id === edge.from);
      const to = formation.find((n) => n.id === edge.to);
      if (!from || !to) continue;
      const bucket = byFrom.get(from.id) ?? [];
      bucket.push(to);
      byFrom.set(from.id, bucket);
    }
    for (const [fromId, targets] of byFrom) {
      const from = formation.find((n) => n.id === fromId);
      if (!from) continue;
      lines.push(`- **${from.role}** → ${targets.map((t) => t.role).join(', ')}`);
    }
  }
  if (root) {
    lines.push('');
    lines.push('## Start with');
    lines.push(`**${root.role}** — you are this conversation; dispatch the rest of the formation.`);
  }
  return lines.join('\n');
}

function autoLayoutFormation(formation: FormationNode[], edges: FormationEdge[]): FormationNode[] {
  if (formation.length === 0) return formation;
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const n of formation) {
    incoming.set(n.id, []);
    outgoing.set(n.id, []);
  }
  for (const e of edges) {
    if (incoming.has(e.to)) incoming.get(e.to)!.push(e.from);
    if (outgoing.has(e.from)) outgoing.get(e.from)!.push(e.to);
  }
  const rootIds = formation
    .filter((n) => (incoming.get(n.id) ?? []).length === 0 || n.root)
    .map((n) => n.id);
  const order: string[] = [];
  const depth = new Map<string, number>();
  const visited = new Set<string>();
  const queue: Array<{ id: string; d: number }> = rootIds.map((id) => ({ id, d: 0 }));
  if (queue.length === 0 && formation.length) queue.push({ id: formation[0].id, d: 0 });
  while (queue.length) {
    const { id, d } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    depth.set(id, d);
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      if (!visited.has(next)) queue.push({ id: next, d: d + 1 });
    }
  }
  for (const n of formation) if (!depth.has(n.id)) depth.set(n.id, 0);
  const byDepth = new Map<number, string[]>();
  for (const n of formation) {
    const d = depth.get(n.id) ?? 0;
    const bucket = byDepth.get(d) ?? [];
    bucket.push(n.id);
    byDepth.set(d, bucket);
  }
  const horizontalSpacing = NODE_WIDTH + 60;
  const verticalSpacing = NODE_HEIGHT + 80;
  const positions = new Map<string, { x: number; y: number }>();
  for (const [d, ids] of byDepth) {
    const rowWidth = (ids.length - 1) * horizontalSpacing;
    ids.forEach((id, index) => {
      const x = 80 + index * horizontalSpacing - rowWidth / 2 + Math.max(rowWidth, horizontalSpacing) / 2;
      const y = 60 + d * verticalSpacing;
      positions.set(id, { x, y });
    });
  }
  return formation.map((n) => {
    const p = positions.get(n.id);
    return p ? { ...n, x: p.x, y: p.y } : n;
  });
}

const GearIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

export function AgentPanel({ header, host }: BuiltinPluginProps) {
  const [detailsWidth, onDetailsResize] = useResizableSplit({ axis: 'x', initial: 34, min: 26, max: 55 });
  const RAIL_MIN_SECTION = 8;
  const RAIL_MIN_SECRET = 5;
  /* side rail is a 3-pane vertical stack: Skills · MCP · Secrets.
     trackers are the two divider positions as a % from the top.
     defaults split the rail in thirds; user resizes from there. */
  const [skillsBottomPct, setSkillsBottomPct] = useState(33);
  const [mcpBottomPct, setMcpBottomPct] = useState(66);
  const sideRailRef = useRef<HTMLDivElement | null>(null);
  const onSkillsResize = (event: PointerEvent) => {
    const rail = sideRailRef.current;
    if (!rail) return;
    const bounds = rail.getBoundingClientRect();
    if (bounds.height <= 0) return;
    const next = Math.max(RAIL_MIN_SECTION, ((event.clientY - bounds.top) / bounds.height) * 100);
    const maxBottom = 100 - RAIL_MIN_SECRET;
    if (next > mcpBottomPct - RAIL_MIN_SECTION) {
      const nextBottom = Math.min(maxBottom, next + RAIL_MIN_SECTION);
      setMcpBottomPct(nextBottom);
      setSkillsBottomPct(Math.min(nextBottom - RAIL_MIN_SECTION, next));
      return;
    }
    setSkillsBottomPct(Math.min(mcpBottomPct - RAIL_MIN_SECTION, next));
  };
  const onMcpResize = (event: PointerEvent) => {
    const rail = sideRailRef.current;
    if (!rail) return;
    const bounds = rail.getBoundingClientRect();
    if (bounds.height <= 0) return;
    const next = ((event.clientY - bounds.top) / bounds.height) * 100;
    setMcpBottomPct(Math.max(skillsBottomPct + RAIL_MIN_SECTION, Math.min(100 - RAIL_MIN_SECRET, next)));
  };
  const [skills, setSkills] = useState<SkillCard[]>([]);
  const [skillsets, setSkillsets] = useState<SkillsetCard[]>([]);
  const [expandedSkillsets, setExpandedSkillsets] = useState<Record<string, boolean>>({});
  const [editingSkill, setEditingSkill] = useState<SkillCard | null>(null);
  const [editDraft, setEditDraft] = useState<SkillEditDraft>({ ...EMPTY_SKILL_DRAFT });
  const [skillBodyView, setSkillBodyView] = useState<'rendered' | 'source'>('rendered');
  const [creatingSkillset, setCreatingSkillset] = useState(false);
  const [skillsetDraft, setSkillsetDraft] = useState('');
  const [mcpServers, setMcpServers] = useState<McpServerCard[]>([]);
  const [secrets, setSecrets] = useState<SecretMask[]>([]);
  const [installingMcp, setInstallingMcp] = useState(false);
  const [installDraft, setInstallDraft] = useState<McpInstallDraft>({ ...EMPTY_INSTALL_DRAFT });
  const [discoveredMcps, setDiscoveredMcps] = useState<DiscoveredMcp[]>([]);
  const [creatingSecret, setCreatingSecret] = useState(false);
  const [secretDraft, setSecretDraft] = useState<{ id: string; value: string; service: string; scope: 'user' | 'project' }>({ id: '', value: '', service: '', scope: 'project' });
  const [secretSettings, setSecretSettings] = useState<SecretMask | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const revealTimersRef = useRef<Record<string, number>>({});
  const [templates, setTemplates] = useState<NodeTemplate[]>(BUILTIN_TEMPLATES);
  const [formation, setFormation] = useState<FormationNode[]>([]);
  const [edges, setEdges] = useState<FormationEdge[]>([]);
  const [creatingSkill, setCreatingSkill] = useState(false);
  const [skillDraft, setSkillDraft] = useState<SkillDraft>({ ...EMPTY_SKILL_DRAFT });
  const [agentNotice, setAgentNotice] = useState('');
  /* distinguishes "host unreachable" from "nothing configured" — without it
     a failed skills/mcp/secrets fetch looks identical to an empty rail. */
  const [loadError, setLoadError] = useState(false);
  const [linkSourceId, setLinkSourceId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [templateDraft, setTemplateDraft] = useState({
    role: '',
    prompt: '',
    model: DEFAULT_NODE_MODEL,
    skills: [] as string[],
    tools: [] as string[],
  });
  const [connectionPicker, setConnectionPicker] = useState<{
    direction: 'from' | 'to';
    nodeId: string;
    clientX: number;
    clientY: number;
  } | null>(null);
  const [connectionPickerQuery, setConnectionPickerQuery] = useState('');
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [hoverEdgeKey, setHoverEdgeKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<'sending' | null>(null);
  const [chatTargets, setChatTargets] = useState<ChatTarget[]>(readOpenChatTargets);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => readOpenChatTargets()[0]?.id ?? null);
  const [connectDrag, setConnectDrag] = useState<{ direction: 'out' | 'in'; nodeId: string; x: number; y: number; overId: string | null } | null>(null);
  const [mcpSettingsKey, setMcpSettingsKey] = useState<string | null>(null);
  const [mcpSettingsDraft, setMcpSettingsDraft] = useState({ name: '', url: '', authRef: '' });

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragNodeRef = useRef<{ id: string; startX: number; startY: number; px: number; py: number; lastX: number; lastY: number; moved: boolean } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; ox: number; oy: number; lastX: number; lastY: number } | null>(null);
  const connectDragRef = useRef<{ direction: 'out' | 'in'; nodeId: string } | null>(null);
  /* current selection read by the agentPanels sync, which runs from a stale
     effect closure — the ref keeps it from re-rooting to the wrong chat. */
  const activeConversationIdRef = useRef<string | null>(activeConversationId);
  const initialFormationViewFitRef = useRef(false);
  /* true while applying a formation that arrived from the host (hydration or a
     remote upsert) so persistFormation does not echo it straight back. */
  const applyingRemoteFormationRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const mergedMcpRows = useMemo(
    () => mergeDiscoveredMcps(mcpServers, discoveredMcps),
    [mcpServers, discoveredMcps],
  );
  const mcpRowKey = useCallback((row: MergedMcpRow) => (
    row.kind === 'managed'
      ? `managed:${row.id}`
      : `discovered:${row.name}:${[...row.origins].sort().join('+')}`
  ), []);
  const visibleMcpRows = mergedMcpRows;
  const showBuiltinMcp = !visibleMcpRows.some((row) => row.name === BUILTIN_MCP.name);
  const activeMcpSettings = useMemo(() => {
    if (!mcpSettingsKey) return null;
    if (mcpSettingsKey === BUILTIN_MCP.key) {
      return { kind: 'builtin' as const, name: BUILTIN_MCP.name, detail: BUILTIN_MCP.detail };
    }
    return visibleMcpRows.find((row) => mcpRowKey(row) === mcpSettingsKey) ?? null;
  }, [mcpSettingsKey, visibleMcpRows, mcpRowKey]);

  const scheduleFrame = (fn: () => void) => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      fn();
    });
  };
  useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, []);

  useEffect(() => {
    let cancelled = false;
    const syncOpenAgentPanels = (value: unknown) => {
      if (cancelled || !Array.isArray(value)) return false;
      const panels = value.filter((item): item is OpenAgentPanel => (
        item && typeof item === 'object'
        && typeof (item as OpenAgentPanel).id === 'string'
        && typeof (item as OpenAgentPanel).agent === 'string'
      ));
      const perAgent: Record<string, number> = {};
      const targets = panels.map((panel) => {
        const n = (perAgent[panel.agent] = (perAgent[panel.agent] ?? 0) + 1);
        return {
          id: panel.id,
          agent: panel.agent,
          slot: panel.agent,
          title: panel.title || `${panel.agent} ${n}`,
          createdAt: n,
        };
      });
      const nextTargets = targets.length > 0 ? targets : readOpenChatTargets();
      setChatTargets(nextTargets);
      const prevActive = activeConversationIdRef.current;
      const nextActive = prevActive && nextTargets.some((p) => p.id === prevActive)
        ? prevActive
        : (nextTargets[0]?.id ?? null);
      activeConversationIdRef.current = nextActive;
      setActiveConversationId(nextActive);
      const activePanel = nextActive ? nextTargets.find((p) => p.id === nextActive) : undefined;
      const newRootId = activePanel ? `panel-${activePanel.id}` : null;
      setFormation((current) => {
        const custom = current.filter((node) => node.templateId !== 'runtime-panel');
        const oldRoot = current.find((node) => node.templateId === 'runtime-panel');
        const next = activePanel ? [makeRootNode(activePanel, oldRoot), ...custom] : custom;
        setEdges((currentEdges) => {
          const repointed = oldRoot && newRootId && oldRoot.id !== newRootId
            ? currentEdges.map((e) => ({
                from: e.from === oldRoot.id ? newRootId : e.from,
                to: e.to === oldRoot.id ? newRootId : e.to,
              }))
            : currentEdges;
          const nextEdges = normalizeEdges(next, repointed);
          persistFormation(next, nextEdges);
          return nextEdges;
        });
        return next;
      });
      return true;
    };

    host.skills.list().then((result) => {
      if (cancelled || result.skills.length === 0) return;
      setSkills(result.skills.map((s) => {
        const extra = s as { skillsetId?: string; origin?: SkillCard['origin']; publishedTo?: Array<'claude' | 'codex'>; body?: string };
        return {
          id: s.id,
          name: s.name,
          summary: s.summary,
          body: extra.body,
          skillsetId: extra.skillsetId,
          origin: extra.origin,
          publishedTo: extra.publishedTo,
        };
      }));
    }).catch(() => { if (!cancelled) setLoadError(true); });

    host.skillsets?.list().then((result) => {
      if (cancelled || !result?.skillsets) return;
      setSkillsets(result.skillsets);
      /* skillset rows start collapsed — keep the rail compact. user expands
         what they want to browse. */
      setExpandedSkillsets({});
    }).catch(() => {});

    host.mcp?.servers?.list().then((result) => {
      if (cancelled || !result?.servers) return;
      setMcpServers(result.servers);
    }).catch(() => { if (!cancelled) setLoadError(true); });

    host.mcp?.discover?.().then((result) => {
      if (cancelled || !result?.servers) return;
      setDiscoveredMcps(result.servers);
    }).catch(() => {});

    host.secrets.list().then((result) => {
      if (cancelled || !result?.secrets) return;
      setSecrets(result.secrets);
    }).catch(() => { if (!cancelled) setLoadError(true); });

    try {
      const rawTpl = window.localStorage.getItem(TEMPLATES_KEY);
      if (rawTpl) {
        const parsed = JSON.parse(rawTpl) as NodeTemplate[];
        setTemplates(mergeStoredTemplates(parsed));
      }
    } catch {}

    let hydrated = false;
    try {
      const raw = window.localStorage.getItem(FORMATION_KEY) ?? window.localStorage.getItem(LEGACY_FORMATION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { nodes?: FormationNode[]; edges?: FormationEdge[] };
        if (Array.isArray(parsed.nodes)) {
          const nodes = parsed.nodes.map((n, index) => sanitizeNode(n, index));
          const nextEdges = normalizeEdges(nodes, Array.isArray(parsed.edges) ? parsed.edges : []);
          setFormation(nodes);
          setEdges(nextEdges);
          applyingRemoteFormationRef.current = true;
          persistFormation(nodes, nextEdges);
          applyingRemoteFormationRef.current = false;
          hydrated = true;
        }
      }
    } catch {}

    if (!hydrated) {
      host.state.get('formation').then((result) => {
        if (cancelled || !Array.isArray(result.value)) return;
        const value = result.value as Array<Partial<FormationNode> & { left?: string; top?: string }>;
        const nodes = value.map((node, index) => sanitizeNode(node, index));
        const nextEdges = normalizeEdges(nodes, []);
        setFormation(nodes);
        setEdges(nextEdges);
        applyingRemoteFormationRef.current = true;
        persistFormation(nodes, nextEdges);
        applyingRemoteFormationRef.current = false;
      }).catch(() => {});
    }
    host.state.get('agentPanels')
      .then((result) => { syncOpenAgentPanels(result.value); })
      .catch(() => {});
    const unsubscribe = host.state.subscribe('agentPanels', syncOpenAgentPanels);
    /* the formation state key is owned by host.formation.upsert (called by
       the host RPC or MCP bridge). live updates land here so the panel
       reflects formation changes the moment an agent writes them. */
    const unsubscribeFormation = host.state.subscribe('formation', (value) => {
      if (cancelled || !value || typeof value !== 'object') return;
      const incoming = value as { nodes?: Partial<FormationNode>[]; edges?: FormationEdge[] };
      if (!Array.isArray(incoming.nodes)) return;
      const nodes = incoming.nodes.map((n, i) => sanitizeNode(n, i));
      const nextEdges = normalizeEdges(nodes, Array.isArray(incoming.edges) ? incoming.edges : []);
      setFormation(nodes);
      setEdges(nextEdges);
      applyingRemoteFormationRef.current = true;
      persistFormation(nodes, nextEdges);
      applyingRemoteFormationRef.current = false;
      setAgentNotice('formation updated');
    });
    const unsubscribeClosedPanel = host.state.subscribe('closedAgentPanel', (value) => {
      if (cancelled || typeof value !== 'string' || !value) return;
      const nodeId = `panel-${value}`;
      setFormation((current) => {
        if (!current.some((node) => node.id === nodeId && node.templateId === 'runtime-panel')) return current;
        const next = current.filter((node) => node.id !== nodeId);
        setEdges((currentEdges) => {
          const nextEdges = normalizeEdges(next, currentEdges);
          persistFormation(next, nextEdges);
          return nextEdges;
        });
        return next;
      });
      setSelectedId((current) => (current === nodeId ? null : current));
      setLinkSourceId((current) => (current === nodeId ? null : current));
    });
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeFormation();
      unsubscribeClosedPanel();
    };
  }, [host]);

  useEffect(() => {
    if (!agentNotice) return;
    const timer = window.setTimeout(() => {
      setAgentNotice((current) => (current === agentNotice ? '' : current));
    }, 3200);
    return () => window.clearTimeout(timer);
  }, [agentNotice]);

  const persistTemplates = (next: NodeTemplate[]) => {
    setTemplates(next);
    try {
      window.localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templatesForStorage(next)));
    } catch {}
  };

  const persistFormation = (nodes: FormationNode[], es: FormationEdge[]) => {
    try {
      window.localStorage.setItem(FORMATION_KEY, JSON.stringify({ nodes, edges: es }));
    } catch {}
    /* write the canvas back to host state so the formation the human edits is
       the same one agents read via polypore.formation/state. skip when we're
       merely reflecting a formation the host just pushed us (no echo loop). */
    if (!applyingRemoteFormationRef.current) {
      host.formation?.upsert?.({ nodes, edges: es }).catch(() => {});
    }
  };

  const updateFormation = (mut: (nodes: FormationNode[]) => FormationNode[]) => {
    setFormation((current) => {
      const next = mut(current);
      persistFormation(next, edges);
      return next;
    });
  };

  const createSkill = async () => {
    const name = skillDraft.name.trim();
    const body = skillDraft.body.trim();
    if (!name || !body) return;
    const agents = agentsForChip(skillDraft.chip);
    const skill: SkillCard = {
      id: `skill-${Date.now()}`,
      name,
      summary: summarizeSkillDraft(body),
      body,
      skillsetId: skillDraft.skillsetId || undefined,
      origin: 'polypore',
      publishedTo: agents,
    };
    setSkills((current) => [skill, ...current.filter((s) => s.id !== skill.id)]);
    try {
      const result = await host.skills.write(skill);
      const written = {
        ...skill,
        ...result.skill,
        body: (result.skill as { body?: string }).body ?? body,
      };
      if (agents.length) await host.skills.publish(skill.id, agents).catch(() => {});
      setSkills((current) => [written, ...current.filter((s) => s.id !== written.id)]);
      setSkillDraft({ ...EMPTY_SKILL_DRAFT });
      setCreatingSkill(false);
    } catch {
      setAgentNotice('could not save skill');
    }
  };

  const installMcp = async () => {
    const name = installDraft.name.trim();
    if (!name || installDraft.targets.length === 0) return;
    if (installDraft.transport === 'stdio' && !installDraft.command.trim()) return;
    if (installDraft.transport === 'http' && !installDraft.url.trim()) return;
    const args = installDraft.argsText.split('\n').map((s) => s.trim()).filter(Boolean);
    const env = parseKvText(installDraft.envText);
    const headers = parseKvText(installDraft.headersText);
    try {
      const result = await host.mcp.install({
        name,
        transport: installDraft.transport,
        command: installDraft.command.trim() || undefined,
        args: args.length ? args : undefined,
        env: Object.keys(env).length ? env : undefined,
        url: installDraft.url.trim() || undefined,
        headers: Object.keys(headers).length ? headers : undefined,
        agents: deriveInstallAgents(installDraft),
      });
      if (result.installed) {
        setInstallDraft({ ...EMPTY_INSTALL_DRAFT });
        setInstallingMcp(false);
        setAgentNotice(`installed ${name} → ${result.targets.join(', ')}`);
        host.mcp?.discover?.().then((disc) => {
          if (disc?.servers) setDiscoveredMcps(disc.servers);
        }).catch(() => {});
      } else {
        setAgentNotice('install failed — desktop shell required');
      }
    } catch (err) {
      setAgentNotice(err instanceof Error ? err.message : 'install failed');
    }
  };

  const removeMcpServer = async (id: string, name: string) => {
    const { confirmed } = await host.ui.confirm(`remove mcp server "${name}"?`);
    if (!confirmed) return;
    host.mcp?.servers?.delete(id).catch(() => {});
    setMcpServers((current) => current.filter((s) => s.id !== id));
    setMcpSettingsKey(null);
    setAgentNotice(`removed ${name}`);
  };

  const openMcpSettings = (key: string, draft?: { name?: string; url?: string; authRef?: string }) => {
    setInstallingMcp(false);
    setMcpSettingsKey((current) => {
      if (current === key) return null;
      setMcpSettingsDraft({
        name: draft?.name ?? '',
        url: draft?.url ?? '',
        authRef: draft?.authRef ?? '',
      });
      return key;
    });
  };

  const saveMcpServerSettings = async (row: MergedMcpRow & { kind: 'managed' }) => {
    const name = mcpSettingsDraft.name.trim();
    const url = mcpSettingsDraft.url.trim();
    if (!name || !url) return;
    try {
      const result = await host.mcp?.servers?.upsert({
        id: row.id,
        name,
        url,
        scope: row.scope,
        authRef: mcpSettingsDraft.authRef.trim() || undefined,
      });
      if (result?.server) {
        setMcpServers((current) => [result.server, ...current.filter((s) => s.id !== row.id)]);
      }
      setMcpSettingsKey(null);
      setAgentNotice(`saved ${name}`);
    } catch {
      setAgentNotice('save mcp failed');
    }
  };

  const refreshDiscoveredMcps = useCallback(() => {
    host.mcp?.discover?.().then((result) => {
      if (!result?.servers) return;
      setMcpSettingsKey(null);
      setDiscoveredMcps(result.servers);
      setAgentNotice(`discovered ${result.servers.length} external mcp${result.servers.length === 1 ? '' : 's'}`);
    }).catch(() => {
      setAgentNotice('discover failed — desktop shell required');
    });
  }, [host]);

  const createSecret = useCallback(async () => {
    const id = secretDraft.id.trim();
    if (!id || !secretDraft.value) return;
    try {
      await host.secrets.set({
        id,
        value: secretDraft.value,
        scope: secretDraft.scope,
        service: secretDraft.service.trim() || undefined,
      });
      const refreshed = await host.secrets.list();
      if (refreshed?.secrets) setSecrets(refreshed.secrets);
      setSecretDraft({ id: '', value: '', service: '', scope: 'project' });
      setCreatingSecret(false);
      setAgentNotice(`saved ${id}`);
    } catch (err) {
      setAgentNotice(err instanceof Error ? err.message : 'save failed');
    }
  }, [host, secretDraft]);

  const deleteSecret = useCallback(async (secret: SecretMask) => {
    try {
      await host.secrets.delete(secret.id, secret.scope);
      const refreshed = await host.secrets.list();
      if (refreshed?.secrets) setSecrets(refreshed.secrets);
      setSecretSettings(null);
      setAgentNotice(`deleted ${secret.id}`);
    } catch (err) {
      setAgentNotice(err instanceof Error ? err.message : 'delete failed');
    }
  }, [host]);

  const testMcpServer = (id: string) => {
    host.mcp?.servers?.test(id).then((result) => {
      const now = Date.now();
      setMcpServers((current) => current.map((s) => s.id === id ? { ...s, lastTest: { ok: result.ok, ts: now, error: result.error } } : s));
      setAgentNotice(result.ok ? `${id}: ok` : `${id}: ${result.error ?? 'failed'}`);
    }).catch(() => setAgentNotice(`${id}: test failed`));
  };

  const toggleSkillset = (id: string) => {
    setExpandedSkillsets((current) => ({ ...current, [id]: !current[id] }));
  };

  const openSkillEditor = async (skill: SkillCard) => {
    setCreatingSkill(false);
    setCreatingSkillset(false);
    /* fetch the full body if we don't already have it (skills.list returns
       summary + minimal fields; body comes from the dedicated read). */
    let body = skill.body ?? '';
    if (!body) {
      try {
        const { skill: fresh } = await host.skills.read(skill.id);
        body = (fresh as { body?: string }).body ?? '';
        if (body) {
          setSkills((current) => current.map((s) => (s.id === skill.id ? { ...s, body } : s)));
        }
      } catch {}
    }
    setEditingSkill(skill);
    setEditDraft({ name: skill.name, body, skillsetId: skill.skillsetId ?? '', chip: chipForSkill(skill) });
    setSkillBodyView('rendered');
  };

  const saveSkillEdit = async () => {
    if (!editingSkill) return;
    const body = editDraft.body.trim();
    const name = editDraft.name.trim();
    if (!name || !body) return;
    const updates: Partial<SkillCard> & { id: string } = {
      id: editingSkill.id,
      name,
      summary: summarizeSkillDraft(body) || editingSkill.summary,
      body,
      skillsetId: editDraft.skillsetId || undefined,
      publishedTo: agentsForChip(editDraft.chip),
    };
    try {
      const { skill } = await host.skills.write(updates);
      setSkills((current) => current.map((s) => (s.id === skill.id ? { ...s, ...updates, body } : s)));
      if (editingSkill.origin === 'polypore' || editingSkill.origin === undefined) {
        await host.skills.publish(editingSkill.id, agentsForChip(editDraft.chip)).catch(() => {});
      }
      setAgentNotice(`saved ${skill.id}`);
    } catch {
      setAgentNotice('save failed');
    }
    setEditingSkill(null);
  };

  const duplicateEditingSkill = () => {
    if (!editingSkill) return;
    setSkillDraft({
      name: `${editDraft.name.trim() || editingSkill.name} copy`,
      body: editDraft.body,
      skillsetId: editDraft.skillsetId,
      chip: 'global',
    });
    setEditingSkill(null);
    setCreatingSkillset(false);
    setCreatingSkill(true);
  };


  const createSkillset = async () => {
    const title = skillsetDraft.trim();
    if (!title) return;
    try {
      const { skillset } = await host.skillsets.upsert({ title });
      setSkillsets((current) => [skillset, ...current.filter((s) => s.id !== skillset.id)]);
      setExpandedSkillsets((current) => ({ ...current, [skillset.id]: true }));
      setAgentNotice(`created folder ${skillset.title}`);
    } catch {
      setAgentNotice('create folder failed');
    }
    setSkillsetDraft('');
    setCreatingSkillset(false);
  };

  const deleteSkillset = async (set: SkillsetCard, event: React.MouseEvent) => {
    event.stopPropagation();
    if (set.builtin) return;
    const { confirmed } = await host.ui.confirm(`delete folder "${set.title}"? skills inside will move to the root.`);
    if (!confirmed) return;
    try {
      await host.skillsets.delete(set.id);
      setSkillsets((current) => current.filter((s) => s.id !== set.id));
      setSkills((current) => current.map((s) => (s.skillsetId === set.id ? { ...s, skillsetId: undefined } : s)));
    } catch {
      setAgentNotice('delete failed');
    }
  };

  const deleteSkill = async (skill: SkillCard) => {
    const { confirmed } = await host.ui.confirm(`delete skill "${skill.name}"?`);
    if (!confirmed) return;
    try {
      await host.skills.delete(skill.id);
      setSkills((current) => current.filter((s) => s.id !== skill.id));
      setSkillsets((current) => current.map((set) => ({
        ...set,
        skills: set.skills.filter((id) => id !== skill.id),
      })));
      setEditingSkill((current) => (current?.id === skill.id ? null : current));
      setAgentNotice(`deleted ${skill.id}`);
    } catch {
      setAgentNotice('delete skill failed');
    }
  };

  const toggleReveal = async (secret: SecretMask) => {
    const key = `${secret.scope}:${secret.id}`;
    if (revealed[key] !== undefined) {
      /* already shown — collapse and clear timer */
      const timer = revealTimersRef.current[key];
      if (timer) window.clearTimeout(timer);
      delete revealTimersRef.current[key];
      setRevealed((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      return;
    }
    try {
      const result = await host.secrets.reveal(secret.id, secret.scope);
      if (result.value == null) {
        setAgentNotice(`${secret.id} not configured`);
        return;
      }
      setRevealed((current) => ({ ...current, [key]: result.value as string }));
      const timer = window.setTimeout(() => {
        setRevealed((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        delete revealTimersRef.current[key];
      }, 30000);
      revealTimersRef.current[key] = timer;
    } catch {
      setAgentNotice('reveal unavailable');
    }
  };

  useEffect(() => () => {
    /* clear any outstanding reveal timers on unmount so we don't update
       state on a stale component (and so secrets don't linger longer than
       the agent panel does). */
    for (const timer of Object.values(revealTimersRef.current)) window.clearTimeout(timer);
    revealTimersRef.current = {};
  }, []);

  const placeFromTemplate = (tpl: NodeTemplate, atClient?: { x: number; y: number }, opts?: { connectFromId?: string; connectToId?: string }) => {
    const bounds = viewportRef.current?.getBoundingClientRect();
    let x: number, y: number;
    if (bounds && atClient) {
      x = (atClient.x - bounds.left - pan.x) / zoom - NODE_WIDTH / 2;
      y = (atClient.y - bounds.top - pan.y) / zoom - NODE_HEIGHT / 2;
    } else if (bounds) {
      const cx = bounds.width / 2;
      const cy = bounds.height / 2;
      const jitter = formation.length * 24;
      x = (cx - pan.x) / zoom - NODE_WIDTH / 2 + jitter;
      y = (cy - pan.y) / zoom - NODE_HEIGHT / 2 + jitter;
    } else {
      x = 80 + formation.length * 24;
      y = 80 + formation.length * 24;
    }
    const node = templateToNode(tpl, x, y, { root: false });
    const nextFormation = [...formation, node];
    let nextEdges = edges;
    if (opts?.connectFromId) {
      const result = withHandoff(nextFormation, edges, opts.connectFromId, node.id);
      if (result.blocked) {
        setAgentNotice(result.blocked);
        return;
      }
      nextEdges = result.edges;
      setEdges(nextEdges);
    } else if (opts?.connectToId) {
      const result = withHandoff(nextFormation, edges, node.id, opts.connectToId);
      if (result.blocked) {
        setAgentNotice(result.blocked);
        return;
      }
      nextEdges = result.edges;
      setEdges(nextEdges);
    }
    setFormation(nextFormation);
    persistFormation(nextFormation, nextEdges);
    setSelectedId(null);
    setAgentNotice('');
    setPickerOpen(false);
    setConnectionPicker(null);
    setConnectionPickerQuery('');
  };

  const loadStarterTeam = () => {
    const startersIds = ['tpl-overseer', 'tpl-frontend', 'tpl-qa'];
    const starters = startersIds
      .map((id) => BUILTIN_TEMPLATES.find((t) => t.id === id))
      .filter((t): t is NodeTemplate => Boolean(t));
    const nodes: FormationNode[] = starters.map((tpl, i) =>
      templateToNode(tpl, 80, 80 + i * 140, { root: false }),
    );
    const overseerId = nodes[0]?.id;
    const newEdges: FormationEdge[] = overseerId
      ? nodes.slice(1).map((n) => ({ from: overseerId, to: n.id }))
      : [];
    setFormation(nodes);
    setEdges(newEdges);
    persistFormation(nodes, newEdges);
    setSelectedId(null);
    setAgentNotice('');
    scheduleFrame(() => setFormation((cur) => {
      const laid = autoLayoutFormation(cur, newEdges);
      persistFormation(laid, newEdges);
      return laid;
    }));
  };

  const removeNode = (id: string) => {
    if (formation.find((n) => n.id === id)?.root) {
      setAgentNotice('the chat root can’t be removed');
      return;
    }
    setFormation((current) => {
      const next = current.filter((n) => n.id !== id);
      persistFormation(next, edges.filter((e) => e.from !== id && e.to !== id));
      return next;
    });
    setEdges((current) => current.filter((e) => e.from !== id && e.to !== id));
    if (linkSourceId === id) setLinkSourceId(null);
    if (selectedId === id) setSelectedId(null);
    if (connectionPicker?.nodeId === id) setConnectionPicker(null);
  };

  const duplicateNode = (id: string) => {
    const src = formation.find((n) => n.id === id);
    if (!src) return;
    const node: FormationNode = {
      ...src,
      id: newNodeId(),
      x: src.x + 40,
      y: src.y + 40,
      root: false,
    };
    setFormation((cur) => {
      const next = [...cur, node];
      persistFormation(next, edges);
      return next;
    });
    setSelectedId(node.id);
  };

  const clickNode = (id: string) => {
    if (linkSourceId === null) {
      setSelectedId(id);
      return;
    }
    if (linkSourceId === id) {
      setLinkSourceId(null);
      setAgentNotice('');
      return;
    }
    const result = withHandoff(formation, edges, linkSourceId, id);
    if (!result.from || !result.to) return;
    if (result.blocked) {
      setLinkSourceId(null);
      setAgentNotice(result.blocked);
      return;
    }
    setEdges(result.edges);
    persistFormation(formation, result.edges);
    setLinkSourceId(null);
    setAgentNotice(result.added ? 'handoff added' : 'handoff already exists');
  };

  const onNodePointerDown = (event: React.PointerEvent<HTMLElement>, node: FormationNode) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragNodeRef.current = {
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      px: node.x,
      py: node.y,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    };
  };

  const onNodePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragNodeRef.current;
    if (!drag) return;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    const dist = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (dist > 4) drag.moved = true;
    scheduleFrame(() => {
      const current = dragNodeRef.current;
      if (!current) return;
      const dx = (current.lastX - current.startX) / zoom;
      const dy = (current.lastY - current.startY) / zoom;
      setFormation((nodes) => nodes.map((n) => (
        n.id === current.id ? { ...n, x: current.px + dx, y: current.py + dy } : n
      )));
    });
  };

  const onNodePointerUp = () => {
    const drag = dragNodeRef.current;
    if (!drag) return;
    const id = drag.id;
    const moved = drag.moved;
    dragNodeRef.current = null;
    if (moved) {
      persistFormation(formation, edges);
    } else {
      clickNode(id);
    }
  };

  const onViewportPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.formation-node, .formation-node-tool, .formation-edge-hit, .formation-reset-view, .formation-zoom')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      ox: pan.x,
      oy: pan.y,
      lastX: event.clientX,
      lastY: event.clientY,
    };
    setSelectedId(null);
    if (linkSourceId) setLinkSourceId(null);
    if (connectionPicker) setConnectionPicker(null);
    if (pickerOpen) setPickerOpen(false);
  };
  const onViewportPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const ref = panRef.current;
    if (!ref) return;
    ref.lastX = event.clientX;
    ref.lastY = event.clientY;
    scheduleFrame(() => {
      const current = panRef.current;
      if (!current) return;
      setPan({
        x: current.ox + (current.lastX - current.startX),
        y: current.oy + (current.lastY - current.startY),
      });
    });
  };
  const onViewportPointerUp = () => { panRef.current = null; };

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom - event.deltaY * 0.001));
    setZoom(next);
  };

  const clientToWorld = (clientX: number, clientY: number) => {
    const bounds = viewportRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    return {
      x: (clientX - bounds.left - pan.x) / zoom,
      y: (clientY - bounds.top - pan.y) / zoom,
    };
  };

  const hitTestNode = (worldX: number, worldY: number, ignoreId?: string) => {
    for (const n of formation) {
      if (ignoreId && n.id === ignoreId) continue;
      if (worldX >= n.x && worldX <= n.x + NODE_WIDTH && worldY >= n.y && worldY <= n.y + NODE_HEIGHT) {
        return n;
      }
    }
    return null;
  };

  const onPortPointerDown = (event: React.PointerEvent<HTMLElement>, node: FormationNode, direction: 'out' | 'in') => {
    event.stopPropagation();
    if (event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    connectDragRef.current = { direction, nodeId: node.id };
    const world = clientToWorld(event.clientX, event.clientY);
    if (!world) return;
    setConnectDrag({ direction, nodeId: node.id, x: world.x, y: world.y, overId: null });
  };

  const onPortPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = connectDragRef.current;
    if (!drag) return;
    const world = clientToWorld(event.clientX, event.clientY);
    if (!world) return;
    const hit = hitTestNode(world.x, world.y, drag.nodeId);
    scheduleFrame(() => setConnectDrag((cd) => (cd ? { ...cd, x: world.x, y: world.y, overId: hit ? hit.id : null } : cd)));
  };

  const onPortPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const drag = connectDragRef.current;
    connectDragRef.current = null;
    if (!drag) { setConnectDrag(null); return; }
    const world = clientToWorld(event.clientX, event.clientY);
    if (world) {
      const target = hitTestNode(world.x, world.y, drag.nodeId);
      if (target) {
        const result = drag.direction === 'out'
          ? withHandoff(formation, edges, drag.nodeId, target.id)
          : withHandoff(formation, edges, target.id, drag.nodeId);
        if (result.blocked) {
          setAgentNotice(result.blocked);
          setConnectDrag(null);
          return;
        }
        setEdges(result.edges);
        persistFormation(formation, result.edges);
        setAgentNotice(result.added ? `${result.from?.role ?? 'node'} → ${result.to?.role ?? 'node'}` : 'handoff already exists');
      } else {
        /* the picker fills the panel as a sheet now, so no anchor math —
           we only keep the drop point to place the new node on the canvas. */
        setConnectionPicker({
          direction: drag.direction === 'out' ? 'from' : 'to',
          nodeId: drag.nodeId,
          clientX: event.clientX,
          clientY: event.clientY,
        });
        setConnectionPickerQuery('');
        setPickerOpen(false);
        setSelectedId(null);
        setEditingTemplateId(null);
        setAgentNotice('');
      }
    }
    setConnectDrag(null);
  };

  const removeEdge = (edge: FormationEdge) => {
    setEdges((current) => {
      const next = current.filter((e) => !(e.from === edge.from && e.to === edge.to));
      persistFormation(formation, next);
      return next;
    });
  };

  const tidyLayout = () => {
    if (formation.length === 0) return;
    setFormation((cur) => {
      const next = autoLayoutFormation(cur, edges);
      persistFormation(next, edges);
      return next;
    });
    setPan({ x: 0, y: 0 });
    setZoom(1);
  };

  const resetView = useCallback(() => {
    const bounds = viewportRef.current?.getBoundingClientRect();
    if (!bounds || formation.length === 0) {
      setPan({ x: 0, y: 0 });
      setZoom(1);
      return;
    }

    const nodeBounds = formation.reduce((acc, node) => ({
      left: Math.min(acc.left, node.x),
      top: Math.min(acc.top, node.y),
      right: Math.max(acc.right, node.x + NODE_WIDTH),
      bottom: Math.max(acc.bottom, node.y + NODE_HEIGHT),
    }), {
      left: formation[0].x,
      top: formation[0].y,
      right: formation[0].x + NODE_WIDTH,
      bottom: formation[0].y + NODE_HEIGHT,
    });
    const contentWidth = Math.max(NODE_WIDTH, nodeBounds.right - nodeBounds.left);
    const contentHeight = Math.max(NODE_HEIGHT, nodeBounds.bottom - nodeBounds.top);
    const availableWidth = Math.max(1, bounds.width - FIT_VIEW_PADDING * 2);
    const availableHeight = Math.max(1, bounds.height - FIT_VIEW_PADDING * 2);
    const nextZoom = Math.min(1, availableWidth / contentWidth, availableHeight / contentHeight);
    const contentCenterX = (nodeBounds.left + nodeBounds.right) / 2;
    const contentCenterY = (nodeBounds.top + nodeBounds.bottom) / 2;

    setZoom(nextZoom);
    setPan({
      x: bounds.width / 2 - contentCenterX * nextZoom,
      y: bounds.height / 2 - contentCenterY * nextZoom,
    });
  }, [formation]);

  useLayoutEffect(() => {
    if (initialFormationViewFitRef.current || formation.length === 0) return;
    const bounds = viewportRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    resetView();
    initialFormationViewFitRef.current = true;
  }, [formation.length, resetView]);

  const displaySkills = useMemo(() => {
    const byId = new Map(skills.map((skill) => [skill.id, skill] as const));
    for (const set of skillsets) {
      for (const skillId of set.skills) {
        if (byId.has(skillId)) continue;
        byId.set(skillId, {
          id: skillId,
          name: skillId,
          summary: '',
          skillsetId: set.id,
          origin: set.builtin ? 'builtin' : undefined,
        });
      }
    }
    return [...byId.values()];
  }, [skillsets, skills]);


  /* the active conversation root and everything it can dispatch to. used to
     dim orphaned roles and keep "send" honest about what actually ships. */
  const reachableSet = useMemo(
    () => reachableFromRoot(formation, edges),
    [formation, edges],
  );

  /* point the formation at a different open chat: swap the root node and carry
     the existing wiring over so the circuit re-roots instead of breaking. */
  const selectActiveConversation = (id: string) => {
    if (!id) return;
    activeConversationIdRef.current = id;
    setActiveConversationId(id);
    const target = chatTargets.find((t) => t.id === id);
    if (!target) return;
    const newRootId = `panel-${id}`;
    setFormation((current) => {
      const custom = current.filter((node) => node.templateId !== 'runtime-panel');
      const oldRoot = current.find((node) => node.templateId === 'runtime-panel');
      const next = [makeRootNode(target, oldRoot), ...custom];
      setEdges((currentEdges) => {
        const repointed = oldRoot && oldRoot.id !== newRootId
          ? currentEdges.map((e) => ({
              from: e.from === oldRoot.id ? newRootId : e.from,
              to: e.to === oldRoot.id ? newRootId : e.to,
            }))
          : currentEdges;
        const nextEdges = normalizeEdges(next, repointed);
        persistFormation(next, nextEdges);
        return nextEdges;
      });
      return next;
    });
  };

  /* deliver the formation prompt into a specific running session — the same
     pty path verify/memory use, so it lands in the live claude/codex CLI the
     user has open on the left, not the headless ACP adapter. */
  const deliverFormationToTarget = async (target: ChatTarget) => {
    const bundle = buildPromptBundle(formation, edges, displaySkills);
    setBusy('sending');
    try {
      await deliverPromptToTarget(target, bundle);
      setAgentNotice(`formation sent to ${target.title || target.agent}`);
      try { await host.ui.notify('success', `formation sent to ${target.title || target.agent}`); } catch {}
    } catch (err) {
      setAgentNotice(err instanceof Error ? err.message.toLowerCase() : 'send failed');
    } finally {
      setBusy(null);
    }
  };

  const sendToChat = async () => {
    if (!activeConversationId) {
      setAgentNotice('no active chat — open a claude or codex panel');
      return;
    }
    const target = openChatPanelTargets().find((t) => t.id === activeConversationId)
      ?? chatTargets.find((t) => t.id === activeConversationId);
    if (!target) {
      setAgentNotice('active chat is no longer open');
      return;
    }
    const orphans = formation.filter((n) => !n.root && !reachableSet.has(n.id));
    await deliverFormationToTarget(target);
    if (orphans.length > 0) {
      setAgentNotice(`${orphans.length} role${orphans.length === 1 ? '' : 's'} not routed to ${target.title || target.agent} — not sent`);
    }
  };

  const copyMarkdown = async () => {
    const bundle = buildPromptBundle(formation, edges, displaySkills);
    try {
      if (navigator?.clipboard) {
        await navigator.clipboard.writeText(bundle);
        setAgentNotice('formation markdown copied');
        return;
      }
    } catch {}
    setAgentNotice('clipboard unavailable');
  };

  const clearFormation = () => {
    const roots = formation.filter((n) => n.root);
    const rootIds = new Set(roots.map((n) => n.id));
    const rootEdges = edges.filter((e) => rootIds.has(e.from) && rootIds.has(e.to));
    setFormation(roots);
    setEdges(rootEdges);
    setSelectedId((current) => (current && rootIds.has(current) ? current : null));
    setLinkSourceId(null);
    setConnectionPicker(null);
    persistFormation(roots, rootEdges);
    setAgentNotice('formation cleared');
  };

  const selected = useMemo(
    () => (selectedId ? formation.find((n) => n.id === selectedId) ?? null : null),
    [selectedId, formation],
  );
  const editingTemplate = useMemo(
    () => (editingTemplateId ? templates.find((tpl) => tpl.id === editingTemplateId) ?? null : null),
    [editingTemplateId, templates],
  );

  const updateSelected = (patch: Partial<FormationNode>) => {
    if (!selected) return;
    updateFormation((cur) => cur.map((n) => (n.id === selected.id ? { ...n, ...patch } : n)));
  };

  const toggleSelectedSkill = (skillId: string) => {
    if (!selected) return;
    const has = selected.skills.includes(skillId);
    updateSelected({
      skills: has ? selected.skills.filter((id) => id !== skillId) : [...selected.skills, skillId],
    });
  };

  const toggleSelectedTool = (tool: string) => {
    if (!selected) return;
    const has = selected.tools.includes(tool);
    updateSelected({
      tools: has ? selected.tools.filter((t) => t !== tool) : [...selected.tools, tool],
    });
  };

  const saveSelectedAsTemplate = () => {
    if (!selected) return;
    const tpl: NodeTemplate = {
      id: `tpl-user-${Date.now()}`,
      role: selected.role,
      detail: selected.detail || selected.role || 'custom role',
      prompt: selected.prompt,
      model: selected.model,
      skills: [...selected.skills],
      tools: [...selected.tools],
    };
    persistTemplates([...templates, tpl]);
    updateSelected({ templateId: tpl.id });
    setAgentNotice(`saved ${selected.role} as template`);
  };

  const deleteTemplate = (id: string) => {
    const builtin = BUILTIN_TEMPLATES.find((tpl) => tpl.id === id);
    if (builtin) {
      persistTemplates(templates.map((tpl) => (tpl.id === id ? { ...builtin } : tpl)));
    } else {
      persistTemplates(templates.filter((t) => t.id !== id));
    }
    if (editingTemplateId === id) setEditingTemplateId(null);
  };

  const openAddNodePicker = () => {
    setSelectedId(null);
    setConnectionPicker(null);
    setConnectionPickerQuery('');
    setEditingTemplateId(null);
    setPickerQuery('');
    setPickerOpen(true);
    setAgentNotice('');
  };

  const closeNodePicker = () => {
    setPickerOpen(false);
    setConnectionPicker(null);
    setConnectionPickerQuery('');
  };

  const openTemplateEditor = (tpl: NodeTemplate) => {
    setSelectedId(null);
    setTemplateDraft({
      role: tpl.role,
      prompt: tpl.prompt,
      model: tpl.model,
      skills: [...tpl.skills],
      tools: [...tpl.tools],
    });
    setEditingTemplateId(tpl.id);
  };

  const saveTemplateDraft = () => {
    if (!editingTemplate) return;
    const role = templateDraft.role.trim() || 'agent';
    const nextTemplate: NodeTemplate = {
      ...editingTemplate,
      role,
      detail: role,
      prompt: templateDraft.prompt,
      model: templateDraft.model,
      skills: [...templateDraft.skills],
      tools: [...templateDraft.tools],
      customized: editingTemplate.builtin ? true : editingTemplate.customized,
    };
    persistTemplates(templates.map((tpl) => (tpl.id === editingTemplate.id ? nextTemplate : tpl)));
    setEditingTemplateId(null);
    setAgentNotice('');
  };

  const toggleTemplateSkill = (skillId: string) => {
    setTemplateDraft((draft) => ({
      ...draft,
      skills: draft.skills.includes(skillId)
        ? draft.skills.filter((id) => id !== skillId)
        : [...draft.skills, skillId],
    }));
  };

  const toggleTemplateTool = (tool: string) => {
    setTemplateDraft((draft) => ({
      ...draft,
      tools: draft.tools.includes(tool)
        ? draft.tools.filter((id) => id !== tool)
        : [...draft.tools, tool],
    }));
  };

  const filteredTemplates = useMemo(() => filterTemplatesByQuery(templates, pickerQuery), [templates, pickerQuery]);
  const connectionAnchor = useMemo(
    () => (connectionPicker ? formation.find((n) => n.id === connectionPicker.nodeId) ?? null : null),
    [connectionPicker, formation],
  );
  const connectionFilteredTemplates = useMemo(() => {
    const filtered = filterTemplatesByQuery(templates, connectionPickerQuery);
    if (!connectionPicker || !connectionAnchor) return filtered;
    return filtered.filter((tpl) => (
      connectionPicker.direction === 'from'
        ? !blockedHandoffMessage(connectionAnchor, tpl)
        : !blockedHandoffMessage(tpl, connectionAnchor)
    ));
  }, [connectionPicker, connectionPickerQuery, connectionAnchor, templates]);
  /* why a blank-node handoff is disallowed for this drag direction — surfaced
     to the user instead of silently disabling the button. */
  const blockedBlankMessage = connectionPicker && connectionAnchor
    ? (
        connectionPicker.direction === 'from'
          ? blockedHandoffMessage(connectionAnchor, BLANK_TEMPLATE)
          : blockedHandoffMessage(BLANK_TEMPLATE, connectionAnchor)
      )
    : null;
  const connectionBlockedCopy = blockedBlankMessage?.replace(/^cannot add that handoff:\s*/, '') ?? '';
  const activePickerMode = connectionPicker ? 'connect' : pickerOpen ? 'add' : null;
  const activePickerQuery = connectionPicker ? connectionPickerQuery : pickerQuery;
  const activePickerTemplates = connectionPicker ? connectionFilteredTemplates : filteredTemplates;
  const activePickerTitle = connectionPicker
    ? (
        connectionPicker.direction === 'from'
          ? <>connect from <strong>{connectionAnchor?.role ?? 'node'}</strong></>
          : <>connect to <strong>{connectionAnchor?.role ?? 'node'}</strong></>
      )
    : <>add <strong>node</strong></>;
  const activePickerLabel = connectionPicker ? 'connect node' : 'add node';
  const activePickerPlaceholder = connectionPicker ? 'search compatible roles...' : 'search templates...';
  const activePickerEmptyCopy = connectionPicker
    ? (connectionBlockedCopy || 'try a compatible role or connect to an existing compatible node.')
    : 'no matching templates';
  const canPlaceBlank = !connectionPicker || !blockedBlankMessage;

  const setActivePickerQuery = (value: string) => {
    if (connectionPicker) setConnectionPickerQuery(value);
    else setPickerQuery(value);
  };

  const chooseTemplateFromPicker = (tpl: NodeTemplate) => {
    if (connectionPicker) {
      placeFromTemplate(
        tpl,
        { x: connectionPicker.clientX, y: connectionPicker.clientY },
        connectionPicker.direction === 'from'
          ? { connectFromId: connectionPicker.nodeId }
          : { connectToId: connectionPicker.nodeId },
      );
    } else {
      placeFromTemplate(tpl);
    }
  };

  /* claude/codex skills are owned on disk by those agents, so their publish
     scope stays locked. everything else — including built-ins — is editable. */
  const editingSkillScopeLocked = editingSkill?.origin === 'claude' || editingSkill?.origin === 'codex';
  const editingSkillOriginLabel =
    editingSkill?.origin === 'builtin'
      ? 'built in'
      : editingSkill?.origin === 'claude'
        ? 'claude'
        : editingSkill?.origin === 'codex'
          ? 'codex'
          : 'polypore';

  return (
    <div
      className="agent-shell"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          if (editingTemplateId) setEditingTemplateId(null);
          else if (linkSourceId) { setLinkSourceId(null); setAgentNotice(''); }
          else if (pickerOpen || connectionPicker) closeNodePicker();
          else if (mcpSettingsKey) setMcpSettingsKey(null);
          else if (selectedId) setSelectedId(null);
        }
        if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId && !(event.target as HTMLElement).closest('input, textarea, select')) {
          event.preventDefault();
          removeNode(selectedId);
        }
      }}
    >
      <PanelHeader {...header}>
        <span className="panel-header__title">agent</span>
        <span className="panel-header__sep" aria-hidden="true" />
        <span className="panel-header__meta">{formation.length} roles</span>
        <span className="panel-header__meta">{edges.length} handoffs</span>
      </PanelHeader>
      <div
        className="inspector-grid inspector-grid--single-row"
        style={{ '--agent-details-width': `${detailsWidth}%` } as React.CSSProperties}
      >
        <section className="agent-side">
            {loadError && (
              <div className="agent-side__load-error" role="status">
                couldn’t reach the host — some sections may be empty or stale.
                <button type="button" onClick={() => setLoadError(false)} aria-label="dismiss">dismiss</button>
              </div>
            )}
            <div
              className="agent-side__sections"
              ref={sideRailRef}
              style={{
                '--rail-skills-h': `${skillsBottomPct}%`,
                '--rail-mcp-h': `${mcpBottomPct - skillsBottomPct}%`,
                '--rail-secrets-h': `${100 - mcpBottomPct}%`,
              } as React.CSSProperties}
            >
              <section className="agent-side__section agent-side__section--skills">
                <SectionHeader
                  title="skills"
                  count={displaySkills.length}
                >
                  <button
                    type="button"
                    className="section-header__add agent-side__inline-btn"
                    onClick={() => {
                      setCreatingSkill(false);
                      setEditingSkill(null);
                      setCreatingSkillset(true);
                    }}
                  >+ folder</button>
                </SectionHeader>

	                <div className="agent-side__skills">
	                  {skillsets.map((set) => {
	                    const expanded = expandedSkillsets[set.id] === true;
	                    const setSkills = displaySkills.filter((s) => s.skillsetId === set.id);
	                    return (
                      <div key={set.id} className="skillset">
                        <button
                          type="button"
                          className="skillset__head"
                          onClick={() => toggleSkillset(set.id)}
                          aria-expanded={expanded}
                        >
                          <span className="skillset__caret">{expanded ? '▾' : '▸'}</span>
                          <span className="skillset__title">{set.title}</span>
                          <span className="skillset__count">{setSkills.length}</span>
                          {!set.builtin && (
                            <span
                              className="skillset__del"
                              role="button"
                              tabIndex={0}
                              aria-label={`delete folder ${set.title}`}
                              onClick={(event) => deleteSkillset(set, event)}
                            >×</span>
                          )}
                        </button>
                        {expanded && (
                          <div className="skillset__body">
                            <ul className="skillset__skills">
                              {setSkills.map((skill) => {
                                return (
                                  <li
                                    key={skill.id}
                                    className="skillset__skill"
                                    title={skill.summary}
                                    onClick={() => openSkillEditor(skill)}
                                  >
                                    <div className="skillset__skill-line">
                                      <span className="skillset__skill-name">{skill.name}</span>
                                      <span className="skillset__skill-actions">
                                        <button
                                          type="button"
                                          className="skillset__gear"
                                          aria-label={`settings for skill ${skill.name}`}
                                          title="settings"
                                          onClick={(event) => { event.stopPropagation(); openSkillEditor(skill); }}
                                        ><GearIcon /></button>
                                      </span>
                                    </div>
                                    {skill.summary && <span className="skillset__skill-summary">{skill.summary}</span>}
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {(() => {
                    const loose = displaySkills.filter((s) => !s.skillsetId);
                    if (loose.length === 0) return null;
                    return (
                      <ul className="skillset__skills skillset__skills--root">
                        {loose.map((skill) => {
                          return (
                            <li
                              key={skill.id}
                              className="skillset__skill"
                              title={skill.summary}
                              onClick={() => openSkillEditor(skill)}
                            >
                              <div className="skillset__skill-line">
                                <span className="skillset__skill-name">{skill.name}</span>
                                <span className="skillset__skill-actions">
                                  <button
                                    type="button"
                                    className="skillset__gear"
                                    aria-label={`settings for skill ${skill.name}`}
                                    title="settings"
                                    onClick={(event) => { event.stopPropagation(); openSkillEditor(skill); }}
                                  ><GearIcon /></button>
                                </span>
                              </div>
                              {skill.summary && <span className="skillset__skill-summary">{skill.summary}</span>}
                            </li>
                          );
                        })}
                      </ul>
                    );
                  })()}
                </div>
	                <button
	                  type="button"
	                  className="skill-create-button skill-create-button--bar"
	                  onClick={() => {
	                    setCreatingSkillset(false);
	                    setEditingSkill(null);
	                    setSkillDraft({ ...EMPTY_SKILL_DRAFT });
	                    setCreatingSkill(true);
		                  }}
		                >+ skill</button>

		                <PanelSheet
		                  open={creatingSkillset}
		                  label="create folder"
		                  title="new folder"
		                  onDismiss={() => { setCreatingSkillset(false); setSkillsetDraft(''); }}
		                  className="panel-sheet--rail panel-sheet--rail-wide"
		                >
		                  <form
		                    className="rail-form"
		                    onSubmit={(event) => {
		                      event.preventDefault();
		                      createSkillset();
		                    }}
		                  >
		                    <label className="rail-form__field">
		                      <span>folder name</span>
		                      <input
		                        value={skillsetDraft}
		                        placeholder="folder name"
		                        aria-label="folder name"
		                        autoFocus
		                        onChange={(event) => setSkillsetDraft(event.target.value)}
		                      />
		                    </label>
		                    <div className="rail-form__actions">
		                      <button type="button" onClick={() => { setCreatingSkillset(false); setSkillsetDraft(''); }}>cancel</button>
		                      <button
		                        type="submit"
		                        className="rail-form__primary"
		                        disabled={!skillsetDraft.trim()}
		                      >create</button>
		                    </div>
		                  </form>
		                </PanelSheet>

		                <PanelSheet
		                  open={creatingSkill}
		                  label="create skill"
		                  title="new skill"
		                  onDismiss={() => { setCreatingSkill(false); setSkillDraft({ ...EMPTY_SKILL_DRAFT }); }}
		                  className="panel-sheet--rail panel-sheet--rail-wide"
		                >
	                  <form
	                    className="rail-form rail-form--editor skill-editor"
	                    onSubmit={(event) => {
	                      event.preventDefault();
	                      createSkill();
	                    }}
	                  >
	                    <label className="rail-form__field">
	                      <span>skill name</span>
	                      <input
	                        value={skillDraft.name}
	                        placeholder="skill name"
	                        autoFocus
	                        onChange={(event) => setSkillDraft((draft) => ({ ...draft, name: event.target.value }))}
	                      />
	                    </label>
	                    <div className="skill-editor__controls">
	                      <label className="rail-form__field">
	                        <span>folder</span>
	                        <select
	                          value={skillDraft.skillsetId}
	                          onChange={(event) => setSkillDraft((draft) => ({ ...draft, skillsetId: event.target.value }))}
	                        >
	                          <option value="">none</option>
	                          {skillsets.filter((set) => !set.builtin).map((set) => (
	                            <option key={set.id} value={set.id}>{set.title}</option>
	                          ))}
	                        </select>
	                      </label>

	                      <fieldset className="rail-form__segmented skill-editor__scope">
	                        <legend>scope</legend>
	                        {([
	                          ['claude', 'claude'],
	                          ['codex', 'codex'],
	                          ['global', 'global'],
	                        ] as Array<[SkillScopeChip, string]>).map(([chip, label]) => (
	                          <label key={chip} className={skillDraft.chip === chip ? 'skill-editor__scope-option skill-editor__scope-option--on' : 'skill-editor__scope-option'}>
	                            <input
	                              type="radio"
	                              name="skill-create-scope"
	                              value={chip}
	                              checked={skillDraft.chip === chip}
	                              onChange={() => setSkillDraft((draft) => ({ ...draft, chip }))}
	                            />
	                            <span>{label}</span>
	                          </label>
	                        ))}
	                      </fieldset>
	                    </div>
	                    <label className="rail-form__field rail-form__field--grow skill-editor__body">
	                      <span>instructions</span>
	                      <textarea
	                        value={skillDraft.body}
	                        placeholder="# skill instructions in markdown..."
	                        onChange={(event) => setSkillDraft((draft) => ({ ...draft, body: event.target.value }))}
	                      />
	                    </label>
	                    <div className="rail-form__actions">
	                      <button type="button" onClick={() => { setCreatingSkill(false); setSkillDraft({ ...EMPTY_SKILL_DRAFT }); }}>cancel</button>
	                      <button
	                        type="submit"
	                        className="rail-form__primary"
	                        disabled={!skillDraft.name.trim() || !skillDraft.body.trim()}
	                      >save skill</button>
	                    </div>
	                  </form>
	                </PanelSheet>

                <PanelSheet
                  open={Boolean(editingSkill)}
	                  label={editingSkill ? `${editingSkill.name} skill editor` : 'skill editor'}
	                  title={editingSkill ? <>skill <strong>{editingSkill.name}</strong></> : 'skill'}
	                  onDismiss={() => setEditingSkill(null)}
	                  className="panel-sheet--rail panel-sheet--rail-wide"
	                >
                  {editingSkill && (
                    <form
                      className="rail-form rail-form--editor skill-editor"
                      onSubmit={(event) => {
                        event.preventDefault();
                        saveSkillEdit();
                      }}
                    >
                      <label className="skill-editor__name">
                        <span>name</span>
                        <div className="skill-editor__name-row">
                          <input
                            value={editDraft.name}
                            aria-label="skill name"
                            onChange={(event) => setEditDraft((draft) => ({ ...draft, name: event.target.value }))}
                          />
                          <span className="skill-editor__origin">{editingSkillOriginLabel}</span>
                        </div>
                      </label>

                      <div className="skill-editor__controls">
                        <label className="rail-form__field">
                          <span>folder</span>
                          <select
                            value={editDraft.skillsetId}
                            onChange={(event) => setEditDraft((draft) => ({ ...draft, skillsetId: event.target.value }))}
                          >
                            <option value="">none</option>
                            {skillsets.filter((set) => !set.builtin || set.id === editingSkill.skillsetId).map((set) => (
                              <option key={set.id} value={set.id}>{set.title}{set.builtin ? ' (builtin)' : ''}</option>
                            ))}
                          </select>
                        </label>

                        <fieldset className="rail-form__segmented skill-editor__scope">
                          <legend>scope</legend>
                          {([
                            ['claude', 'claude'],
                            ['codex', 'codex'],
                            ['global', 'global'],
                          ] as Array<[SkillScopeChip, string]>).map(([chip, label]) => (
                            <label key={chip} className={editDraft.chip === chip ? 'skill-editor__scope-option skill-editor__scope-option--on' : 'skill-editor__scope-option'}>
                              <input
                                type="radio"
                                name="skill-edit-scope"
                                value={chip}
                                checked={editDraft.chip === chip}
                                disabled={editingSkillScopeLocked}
                                onChange={() => setEditDraft((draft) => ({ ...draft, chip }))}
                              />
                              <span>{label}</span>
                            </label>
                          ))}
                        </fieldset>
                      </div>

                      <div className="rail-form__field rail-form__field--grow skill-editor__body">
                        <div className="skill-editor__body-head">
                          <span>instructions</span>
                          <div className="skill-editor__view-toggle" role="group" aria-label="instructions view">
                            <button
                              type="button"
                              className={skillBodyView === 'rendered' ? 'is-on' : ''}
                              aria-pressed={skillBodyView === 'rendered'}
                              onClick={() => setSkillBodyView('rendered')}
                            >rendered</button>
                            <button
                              type="button"
                              className={skillBodyView === 'source' ? 'is-on' : ''}
                              aria-pressed={skillBodyView === 'source'}
                              onClick={() => setSkillBodyView('source')}
                            >source</button>
                          </div>
                        </div>
                        {skillBodyView === 'rendered' ? (
                          <div
                            className="skill-editor__rendered"
                            role="button"
                            tabIndex={0}
                            title="click to edit the markdown source"
                            onClick={() => setSkillBodyView('source')}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                setSkillBodyView('source');
                              }
                            }}
                          >
                            {editDraft.body.trim()
                              ? <ReactMarkdown components={MARKDOWN_COMPONENTS}>{editDraft.body}</ReactMarkdown>
                              : <p className="skill-editor__rendered-empty">no instructions yet — switch to source to write them.</p>}
                          </div>
                        ) : (
                          <textarea
                            value={editDraft.body}
                            autoFocus
                            placeholder="# skill body in markdown..."
                            onChange={(event) => setEditDraft((draft) => ({ ...draft, body: event.target.value }))}
                          />
                        )}
                      </div>

                      <p className="skill-editor__persist-note" role="note">
                        edits apply to this session only — skills aren’t saved to disk yet, so changes reset when polypore restarts.
                      </p>
                      <div className="rail-form__actions">
                        <button type="button" className="rail-form__danger" onClick={() => deleteSkill(editingSkill)}>delete</button>
                        <button type="button" onClick={() => setEditingSkill(null)}>cancel</button>
                        <button type="button" onClick={duplicateEditingSkill}>duplicate</button>
                        <button
                          type="submit"
                          className="rail-form__primary"
                          disabled={!editDraft.name.trim() || !editDraft.body.trim()}
                        >save skill</button>
                      </div>
                    </form>
                  )}
                </PanelSheet>

              </section>

              <ResizeHandle axis="y" label="resize skills vs mcp" onDrag={onSkillsResize} />

              <section className="agent-side__section agent-side__section--mcp">
                <SectionHeader
                  title="mcp"
                  count={visibleMcpRows.length + (showBuiltinMcp ? 1 : 0)}
                />
                <div className="agent-side__mcp">
                  {(showBuiltinMcp || visibleMcpRows.length > 0) && (
                  <ul className="mcp-list">
                    {showBuiltinMcp && (
                      <li className="mcp-row">
                        <div className="mcp-row__body">
                          <span className="mcp-row__name">{BUILTIN_MCP.name}</span>
                          <span className="mcp-row__url">{BUILTIN_MCP.detail}</span>
                        </div>
                        <div className="mcp-row__actions">
                          <button
                            type="button"
                            className="mcp-row__manage"
                            aria-label={`manage ${BUILTIN_MCP.name}`}
                            onClick={() => openMcpSettings(BUILTIN_MCP.key, { name: BUILTIN_MCP.name, url: BUILTIN_MCP.detail })}
                          ><GearIcon /></button>
                        </div>
                      </li>
                    )}
                    {visibleMcpRows.map((row: MergedMcpRow) => {
                      const rowKey = mcpRowKey(row);
                      if (row.kind === 'managed') {
                        return (
                          <li key={`m:${row.id}`} className="mcp-row">
                            <div className="mcp-row__body">
                              <span className="mcp-row__name">{row.name}</span>
                              <span className="mcp-row__url">{row.url}</span>
                              {row.lastTest && (
                                <span className={`mcp-row__status mcp-row__status--${row.lastTest.ok ? 'ok' : 'fail'}`}>
                                  {row.lastTest.ok ? 'ok' : (row.lastTest.error ?? 'failed')}
                                </span>
                              )}
                            </div>
                            <div className="mcp-row__actions">
                              <button type="button" onClick={() => testMcpServer(row.id)}>test</button>
                              <button
                                type="button"
                                className="mcp-row__manage"
                                aria-label={`manage ${row.name}`}
                                onClick={() => openMcpSettings(rowKey, { name: row.name, url: row.url, authRef: row.authRef })}
                              ><GearIcon /></button>
                            </div>
                          </li>
                        );
                      }
                      const detail = mcpRowDetail(row);
                      return (
                        <li key={`d:${row.name}`} className="mcp-row mcp-row--discovered" title={`discovered from ${row.origins.join(' + ')}`}>
                          <div className="mcp-row__body">
                            <span className="mcp-row__name">{row.name}</span>
                            <span className="mcp-row__url">{detail}</span>
                            <span className="mcp-row__origin">{row.origins.join('+')}</span>
                          </div>
                          <div className="mcp-row__actions">
                            <button
                              type="button"
                              className="mcp-row__manage"
                              aria-label={`manage ${row.name}`}
                              onClick={() => openMcpSettings(rowKey, { name: row.name, url: detail })}
                            ><GearIcon /></button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  )}
                  {visibleMcpRows.length === 0 && !installingMcp && (
                    <EmptyState
                      message="no mcps installed"
                      ctaLabel="scan agent configs"
                      onAction={refreshDiscoveredMcps}
                    />
                  )}
                </div>
                <button
                  type="button"
                  className="skill-create-button skill-create-button--bar"
                  onClick={() => {
                    setMcpSettingsKey(null);
                    setInstallingMcp(true);
                  }}
                >+ install</button>
                <PanelSheet
                  open={installingMcp}
                  label="install mcp server"
                  title="install mcp"
                  onDismiss={() => { setInstallingMcp(false); setInstallDraft({ ...EMPTY_INSTALL_DRAFT }); }}
                  className="panel-sheet--rail panel-sheet--rail-wide"
                >
                  <form
                    className="rail-form rail-form--editor skill-editor"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void installMcp();
                    }}
                  >
                    <label className="rail-form__field">
                      <span>name</span>
                      <input
                        value={installDraft.name}
                        placeholder="e.g. github"
                        autoFocus
                        onChange={(event) => setInstallDraft((d) => ({ ...d, name: event.target.value }))}
                      />
                    </label>
                    <div className="skill-editor__controls">
                      <fieldset className="rail-form__segmented skill-editor__scope">
                        <legend>transport</legend>
                        {(['stdio', 'http'] as const).map((t) => (
                          <label key={t} className={installDraft.transport === t ? 'skill-editor__scope-option skill-editor__scope-option--on' : 'skill-editor__scope-option'}>
                            <input
                              type="radio"
                              name="mcp-install-transport"
                              value={t}
                              checked={installDraft.transport === t}
                              onChange={() => setInstallDraft((d) => ({ ...d, transport: t }))}
                            />
                            <span>{t}</span>
                          </label>
                        ))}
                      </fieldset>
                    </div>
                    {installDraft.transport === 'stdio' ? (
                      <>
                        <label className="rail-form__field">
                          <span>command</span>
                          <input
                            value={installDraft.command}
                            placeholder="npx"
                            onChange={(event) => setInstallDraft((d) => ({ ...d, command: event.target.value }))}
                          />
                        </label>
                        <label className="rail-form__field">
                          <span>args <small>(one per line)</small></span>
                          <textarea
                            value={installDraft.argsText}
                            placeholder={'-y\n@modelcontextprotocol/server-github'}
                            rows={3}
                            onChange={(event) => setInstallDraft((d) => ({ ...d, argsText: event.target.value }))}
                          />
                        </label>
                      </>
                    ) : (
                      <label className="rail-form__field">
                        <span>url</span>
                        <input
                          value={installDraft.url}
                          placeholder="https://server.example.com/mcp"
                          onChange={(event) => setInstallDraft((d) => ({ ...d, url: event.target.value }))}
                        />
                      </label>
                    )}
                    <label className="rail-form__field">
                      <span>env <small>(key=value, one per line)</small></span>
                      <textarea
                        value={installDraft.envText}
                        placeholder="GITHUB_TOKEN=ghp_..."
                        rows={2}
                        onChange={(event) => setInstallDraft((d) => ({ ...d, envText: event.target.value }))}
                      />
                    </label>
                    <fieldset className="rail-form__segmented skill-editor__scope mcp-install-agents">
                      <legend>install for</legend>
                      {(['claude', 'codex', 'global'] as const).map((target) => {
                        const checked = installDraft.targets.includes(target);
                        return (
                          <label key={target} className={checked ? 'skill-editor__scope-option skill-editor__scope-option--on' : 'skill-editor__scope-option'}>
                            <input
                              type="checkbox"
                              value={target}
                              checked={checked}
                              onChange={() => setInstallDraft((d) => ({
                                ...d,
                                targets: checked ? d.targets.filter((t) => t !== target) : [...d.targets, target],
                              }))}
                            />
                            <span>{target}</span>
                          </label>
                        );
                      })}
                      {installDraft.targets.includes('claude') && (
                        <div className="mcp-install-agents__scope-row">
                          {(['project', 'user'] as const).map((scope) => (
                            <label key={scope} className={installDraft.claudeScope === scope ? 'skill-editor__scope-option skill-editor__scope-option--on' : 'skill-editor__scope-option'}>
                              <input
                                type="radio"
                                name="mcp-claude-scope"
                                value={scope}
                                checked={installDraft.claudeScope === scope}
                                onChange={() => setInstallDraft((d) => ({ ...d, claudeScope: scope }))}
                              />
                              <span>{scope}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </fieldset>
                    <div className="rail-form__actions">
                      <button type="button" onClick={() => { setInstallingMcp(false); setInstallDraft({ ...EMPTY_INSTALL_DRAFT }); }}>cancel</button>
                      <button
                        type="submit"
                        className="rail-form__primary"
                        disabled={
                          !installDraft.name.trim()
                          || installDraft.targets.length === 0
                          || (installDraft.transport === 'stdio' && !installDraft.command.trim())
                          || (installDraft.transport === 'http' && !installDraft.url.trim())
                        }
                      >install</button>
                    </div>
                  </form>
                </PanelSheet>
                <PanelSheet
                  open={Boolean(activeMcpSettings)}
                  label={activeMcpSettings ? `${activeMcpSettings.name} settings` : 'mcp settings'}
                  title="mcp settings"
                  onDismiss={() => setMcpSettingsKey(null)}
                  className="panel-sheet--rail panel-sheet--rail-wide"
                >
                  {activeMcpSettings?.kind === 'builtin' && (
                    <div className="rail-form rail-form--readonly">
                      <label className="rail-form__field">
                        <span>name</span>
                        <input value={activeMcpSettings.name} readOnly />
                      </label>
                      <label className="rail-form__field">
                        <span>command</span>
                        <input value={activeMcpSettings.detail} readOnly />
                      </label>
                      <p className="rail-form__hint">built in mcp - always available</p>
                    </div>
                  )}
                  {activeMcpSettings?.kind === 'managed' && (
                    <form
                      className="rail-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        saveMcpServerSettings(activeMcpSettings);
                      }}
                    >
                      <label className="rail-form__field">
                        <span>name</span>
                        <input
                          value={mcpSettingsDraft.name}
                          autoFocus
                          onChange={(event) => setMcpSettingsDraft((draft) => ({ ...draft, name: event.target.value }))}
                        />
                      </label>
                      <label className="rail-form__field">
                        <span>url</span>
                        <input
                          value={mcpSettingsDraft.url}
                          onChange={(event) => setMcpSettingsDraft((draft) => ({ ...draft, url: event.target.value }))}
                        />
                      </label>
                      <label className="rail-form__field">
                        <span>secret</span>
                        <input
                          value={mcpSettingsDraft.authRef}
                          placeholder="optional"
                          onChange={(event) => setMcpSettingsDraft((draft) => ({ ...draft, authRef: event.target.value }))}
                        />
                      </label>
                      <div className="rail-form__actions">
                        <button type="button" className="rail-form__danger" onClick={() => removeMcpServer(activeMcpSettings.id, activeMcpSettings.name)}>delete</button>
                        <button type="button" onClick={() => setMcpSettingsKey(null)}>cancel</button>
                        <button type="submit" className="rail-form__primary">save</button>
                      </div>
                    </form>
                  )}
                  {activeMcpSettings?.kind === 'discovered' && (
                    <div className="rail-form rail-form--readonly">
                      <label className="rail-form__field">
                        <span>name</span>
                        <input value={activeMcpSettings.name} readOnly />
                      </label>
                      <label className="rail-form__field">
                        <span>source</span>
                        <input value={activeMcpSettings.origins.join('+')} readOnly />
                      </label>
                      <label className="rail-form__field">
                        <span>{activeMcpSettings.url ? 'url' : 'command'}</span>
                        <input value={mcpRowDetail(activeMcpSettings)} readOnly />
                      </label>
                      <p className="rail-form__hint">managed in the source agent config</p>
                    </div>
                  )}
                </PanelSheet>
              </section>

              <ResizeHandle axis="y" label="resize mcp vs secrets" onDrag={onMcpResize} />

              <section className="agent-side__section agent-side__section--secrets">
                <SectionHeader
                  title="secrets"
                  count={secrets.length}
                />
                {secrets.length === 0 && !creatingSecret ? (
                  <EmptyState
                    message="no secret handles configured"
                    ctaLabel="add a project secret"
                    onAction={() => setCreatingSecret(true)}
                  />
                ) : secrets.length > 0 ? (
                <ul className="secret-list">
                  {secrets.map((secret) => {
                    const key = `${secret.scope}:${secret.id}`;
                    const visible = revealed[key];
                    return (
                      <li key={key} className="secret-row">
                        <span className="secret-row__id">{secret.id}</span>
                        <span className="secret-row__scope">{secret.scope}</span>
                        <span className={`secret-row__hint ${visible !== undefined ? 'secret-row__hint--revealed' : ''}`}>
                          {visible !== undefined ? visible : secret.hint}
                        </span>
                        <span className="secret-row__actions">
                          {secret.configured && (
                            <button
                              className="secret-row__eye"
                              onClick={() => toggleReveal(secret)}
                              title={visible !== undefined ? 'hide (auto-hides in 30s)' : 'reveal'}
                              aria-label={visible !== undefined ? 'hide secret' : 'reveal secret'}
                            >{visible !== undefined ? '◉' : '◯'}</button>
                          )}
                          <button
                            className="secret-row__gear"
                            onClick={() => setSecretSettings(secret)}
                            title="settings"
                            aria-label={`settings for secret ${secret.id}`}
                          ><GearIcon /></button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
                ) : null}
                <button
                  type="button"
                  className="skill-create-button skill-create-button--bar"
                  onClick={() => setCreatingSecret(true)}
                >+ secret</button>
                <PanelSheet
                  open={creatingSecret}
                  label="add secret"
                  title="new secret"
                  onDismiss={() => { setCreatingSecret(false); setSecretDraft({ id: '', value: '', service: '', scope: 'project' }); }}
                  className="panel-sheet--rail panel-sheet--rail-wide"
                >
                  <form
                    className="rail-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      createSecret();
                    }}
                  >
                    <label className="rail-form__field">
                      <span>handle</span>
                      <input
                        value={secretDraft.id}
                        placeholder="handle (e.g. github-pat)"
                        autoFocus
                        onChange={(event) => setSecretDraft((draft) => ({ ...draft, id: event.target.value }))}
                      />
                    </label>
                    <label className="rail-form__field">
                      <span>value</span>
                      <input
                        type="password"
                        value={secretDraft.value}
                        placeholder="value"
                        onChange={(event) => setSecretDraft((draft) => ({ ...draft, value: event.target.value }))}
                      />
                    </label>
                    <label className="rail-form__field">
                      <span>service</span>
                      <input
                        value={secretDraft.service}
                        placeholder="service (optional)"
                        onChange={(event) => setSecretDraft((draft) => ({ ...draft, service: event.target.value }))}
                      />
                    </label>
                    <fieldset className="rail-form__segmented skill-editor__scope">
                      <legend>scope</legend>
                      <label className={secretDraft.scope === 'project' ? 'skill-editor__scope-option skill-editor__scope-option--on' : 'skill-editor__scope-option'}>
                        <input
                          type="radio"
                          name="secret-scope"
                          checked={secretDraft.scope === 'project'}
                          onChange={() => setSecretDraft((draft) => ({ ...draft, scope: 'project' }))}
                        />
                        <span>project</span>
                      </label>
                      <label className={secretDraft.scope === 'user' ? 'skill-editor__scope-option skill-editor__scope-option--on' : 'skill-editor__scope-option'}>
                        <input
                          type="radio"
                          name="secret-scope"
                          checked={secretDraft.scope === 'user'}
                          onChange={() => setSecretDraft((draft) => ({ ...draft, scope: 'user' }))}
                        />
                        <span>user</span>
                      </label>
                    </fieldset>
                    <p className="rail-form__hint">
                      stored in the system keyring. polypore confirms before revealing the raw value.
                    </p>
                    <div className="rail-form__actions">
                      <button type="button" onClick={() => { setCreatingSecret(false); setSecretDraft({ id: '', value: '', service: '', scope: 'project' }); }}>cancel</button>
                      <button type="submit" className="rail-form__primary" disabled={!secretDraft.id.trim() || !secretDraft.value}>save</button>
                    </div>
                  </form>
                </PanelSheet>
                <PanelSheet
                  open={Boolean(secretSettings)}
                  label={secretSettings ? `${secretSettings.id} settings` : 'secret settings'}
                  title="secret settings"
                  onDismiss={() => setSecretSettings(null)}
                  className="panel-sheet--rail panel-sheet--rail-wide"
                >
                  {secretSettings && (
                    <div className="rail-form rail-form--readonly">
                      <label className="rail-form__field">
                        <span>handle</span>
                        <input value={secretSettings.id} readOnly />
                      </label>
                      <label className="rail-form__field">
                        <span>scope</span>
                        <input value={secretSettings.scope} readOnly />
                      </label>
                      <label className="rail-form__field">
                        <span>service</span>
                        <input value={secretSettings.service || '—'} readOnly />
                      </label>
                      <label className="rail-form__field">
                        <span>value</span>
                        <input value={secretSettings.configured ? secretSettings.hint : 'not configured'} readOnly />
                      </label>
                      <p className="rail-form__hint">
                        the raw value stays in the system keyring. reveal it from the row; polypore confirms first.
                      </p>
                      <div className="rail-form__actions">
                        <button type="button" className="rail-form__danger" onClick={() => deleteSecret(secretSettings)}>delete</button>
                        <button type="button" onClick={() => setSecretSettings(null)}>close</button>
                      </div>
                    </div>
                  )}
                </PanelSheet>
              </section>
            </div>
        </section>

        <ResizeHandle
          axis="x"
          label="resize agent details and formation"
          onDrag={onDetailsResize}
        />

        <section className="agent-viewport">
          <header className="agent-section-head agent-section-head--toolbar">
            <div className="formation-head-left">
              <h2>formation</h2>
              <label className="formation-conversation">
                <select
                  className="agent-select formation-conversation__select"
                  aria-label="active conversation"
                  value={activeConversationId ?? ''}
                  onChange={(e) => selectActiveConversation(e.target.value)}
                  disabled={chatTargets.length === 0}
                >
                  {chatTargets.length === 0 && <option value="">no chat open</option>}
                  {chatTargets.map((t) => (
                    <option key={t.id} value={t.id}>{t.title}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="formation-toolbar">
              <button className="formation-tool formation-tool--danger" onClick={clearFormation} disabled={formation.every((n) => n.root)}>clear</button>
              <button className="formation-tool" onClick={tidyLayout} disabled={formation.length === 0} title="organize layout">organize</button>
              <div className="formation-tool-group">
                <button
                  className="formation-tool formation-tool--primary"
                  onClick={() => (pickerOpen ? closeNodePicker() : openAddNodePicker())}
                  aria-haspopup="true"
                  aria-expanded={pickerOpen}
                >+ node</button>
              </div>
            </div>
          </header>
          {activePickerMode && (
            <PanelSheet
              open
              label={activePickerLabel}
              title={activePickerTitle}
              onDismiss={closeNodePicker}
              className="panel-sheet--formation-editor panel-sheet--connection"
            >
              <div className="node-bank">
                <input
                  className="node-bank__search"
                  placeholder={activePickerPlaceholder}
                  value={activePickerQuery}
                  autoFocus
                  onChange={(e) => setActivePickerQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const first = activePickerTemplates[0] ?? (canPlaceBlank ? BLANK_TEMPLATE : null);
                      if (first) chooseTemplateFromPicker(first);
                    }
                    if (e.key === 'Escape') closeNodePicker();
                  }}
                />
                <div className="node-bank__list">
                  {activePickerTemplates.length === 0 ? (
                    <div className="node-bank__empty" role="note">
                      <strong>{connectionPicker ? 'no compatible roles' : 'no matches'}</strong>
                      <span>{activePickerEmptyCopy}</span>
                    </div>
                  ) : (
                    activePickerTemplates.map((tpl) => (
                      <div
                        key={tpl.id}
                        className={`node-bank__item ${tpl.builtin ? '' : 'node-bank__item--user'}`}
                      >
                        <button
                          type="button"
                          className="node-bank__select"
                          onClick={() => chooseTemplateFromPicker(tpl)}
                        >
                          <span className="node-bank__role">{tpl.role}</span>
                          {!tpl.builtin && <small>saved</small>}
                          {tpl.builtin && tpl.customized && <small>edited</small>}
                        </button>
                        <div className="node-bank__row-actions">
                          <button
                            type="button"
                            className="node-bank__edit"
                            aria-label="edit template"
                            title={`edit ${tpl.role} template`}
                            onClick={() => openTemplateEditor(tpl)}
                          >edit</button>
                          {!tpl.builtin && (
                            <button
                              type="button"
                              className="node-bank__remove"
                              aria-label="remove template"
                              title={`remove ${tpl.role} template`}
                              onClick={() => deleteTemplate(tpl.id)}
                            >×</button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
                {canPlaceBlank && (
                  <footer className="node-bank__actions">
                    <button type="button" onClick={() => chooseTemplateFromPicker(BLANK_TEMPLATE)}>blank role</button>
                  </footer>
                )}
              </div>
            </PanelSheet>
          )}
          {editingTemplate && (
            <PanelSheet
              open
              label={`${editingTemplate.role || 'role'} template editor`}
              title={(
                <span className="node-editor-title">
                  <span>edit template</span>
                  <strong>{editingTemplate.role || 'role'}</strong>
                  {editingTemplate.builtin && <span className="node-inspector__status">built in</span>}
                </span>
              )}
              onDismiss={() => setEditingTemplateId(null)}
              className="panel-sheet--formation-editor"
            >
              <div className="node-editor node-editor--template">
                <div className="node-editor__main">
                  <section className="node-editor__section node-editor__section--basics" aria-label="template basics">
                    <div className="node-editor__grid">
                      <label className="node-editor__field node-editor__field--wide">
                        <span>role</span>
                        <input
                          value={templateDraft.role}
                          onChange={(e) => setTemplateDraft((draft) => ({ ...draft, role: e.target.value }))}
                        />
                      </label>
                      <label className="node-editor__field node-editor__field--wide">
                        <span>model</span>
                        <select
                          className="agent-select agent-select--model"
                          value={templateDraft.model}
                          onChange={(e) => setTemplateDraft((draft) => ({ ...draft, model: e.target.value }))}
                        >
                          {[...new Set([templateDraft.model, ...MODEL_OPTIONS].filter(Boolean))].map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </section>

                  <label className="node-editor__field node-editor__prompt">
                    <span>prompt</span>
                    <textarea
                      rows={10}
                      value={templateDraft.prompt}
                      placeholder="role instructions sent to the agent..."
                      onChange={(e) => setTemplateDraft((draft) => ({ ...draft, prompt: e.target.value }))}
                    />
                  </label>
                </div>

                <aside className="node-editor__side" aria-label="template capabilities">
                  <section className="node-editor__section">
                    <div className="node-editor__section-head">
                      <span>tools</span>
                      <small>{templateDraft.tools.length}/{AVAILABLE_TOOLS.length}</small>
                    </div>
                    <div className="agent-chip-row node-editor__chip-row">
                      {AVAILABLE_TOOLS.map((tool) => (
                        <button
                          key={tool}
                          type="button"
                          className={`agent-chip ${templateDraft.tools.includes(tool) ? 'agent-chip--on' : ''}`}
                          onClick={() => toggleTemplateTool(tool)}
                        >{tool}</button>
                      ))}
                    </div>
                  </section>

                  {displaySkills.length > 0 && (
                    <section className="node-editor__section node-editor__section--skills">
                      <div className="node-editor__section-head">
                        <span>skills</span>
                        <small>{templateDraft.skills.length}/{displaySkills.length}</small>
                      </div>
                      <div className="node-editor__skills">
                        {skillsets.map((set) => {
                          const setSkills = displaySkills.filter((s) => s.skillsetId === set.id);
                          if (setSkills.length === 0) return null;
                          const expanded = expandedSkillsets[set.id] === true;
                          const selectedCount = setSkills.filter((skill) => templateDraft.skills.includes(skill.id)).length;
                          return (
                            <div key={set.id} className="node-editor__skill-folder">
                              <button
                                type="button"
                                className="node-editor__skill-folder-head"
                                aria-expanded={expanded}
                                onClick={() => toggleSkillset(set.id)}
                              >
                                <span className="skillset__caret">{expanded ? '▾' : '▸'}</span>
                                <span className="node-editor__skill-folder-title">{set.title}</span>
                                <small>{selectedCount}/{setSkills.length}</small>
                              </button>
                              {expanded && (
                                <div className="agent-chip-row node-editor__chip-row node-editor__skill-folder-body">
                                  {setSkills.map((skill) => (
                                    <button
                                      key={skill.id}
                                      type="button"
                                      className={`agent-chip ${templateDraft.skills.includes(skill.id) ? 'agent-chip--on' : ''}`}
                                      title={skill.summary}
                                      onClick={() => toggleTemplateSkill(skill.id)}
                                    >{skill.name}</button>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        {(() => {
                          const loose = displaySkills.filter((s) => !s.skillsetId);
                          if (loose.length === 0) return null;
                          return (
                            <div className="agent-chip-row node-editor__chip-row">
                              {loose.map((skill) => (
                                <button
                                  key={skill.id}
                                  type="button"
                                  className={`agent-chip ${templateDraft.skills.includes(skill.id) ? 'agent-chip--on' : ''}`}
                                  title={skill.summary}
                                  onClick={() => toggleTemplateSkill(skill.id)}
                                >{skill.name}</button>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    </section>
                  )}
                </aside>

                <div className="node-editor__actions">
                  <button type="button" onClick={() => setEditingTemplateId(null)}>cancel</button>
                  {editingTemplate.builtin && editingTemplate.customized && (
                    <button type="button" onClick={() => deleteTemplate(editingTemplate.id)}>reset</button>
                  )}
                  {!editingTemplate.builtin && (
                    <button type="button" className="node-editor__danger" onClick={() => deleteTemplate(editingTemplate.id)}>delete</button>
                  )}
                  <button type="button" className="node-editor__primary" onClick={saveTemplateDraft}>save template</button>
                </div>
              </div>
            </PanelSheet>
          )}
          {selected && (
            <PanelSheet
              open
              label={`${selected.role || 'role'} role editor`}
              title={(
                <span className="node-editor-title">
                  <span>edit</span>
                  <strong>{selected.role || 'role'}</strong>
                  <span className={`node-inspector__status node-inspector__status--${selected.status}`}>{selected.status}</span>
                </span>
              )}
              onDismiss={() => setSelectedId(null)}
              className="panel-sheet--formation-editor"
            >
              <div className="node-editor">
                <div className="node-editor__main">
                  <section className="node-editor__section node-editor__section--basics" aria-label="role basics">
                    <div className="node-editor__grid">
                      <label className="node-editor__field node-editor__field--wide">
                        <span>role</span>
                        <input
                          value={selected.role}
                          onChange={(e) => updateSelected({ role: e.target.value })}
                        />
                      </label>
                      <label className="node-editor__field">
                        <span>model</span>
                        <select
                          className="agent-select agent-select--model"
                          value={selected.model}
                          onChange={(e) => updateSelected({ model: e.target.value })}
                        >
                          {MODEL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </label>
                    </div>
                  </section>

                  <label className="node-editor__field node-editor__prompt">
                    <span>prompt</span>
                    <textarea
                      rows={10}
                      value={selected.prompt}
                      placeholder="role instructions sent to the agent..."
                      onChange={(e) => updateSelected({ prompt: e.target.value })}
                    />
                  </label>
                </div>

                <aside className="node-editor__side" aria-label="role capabilities">
                  <section className="node-editor__section">
                    <div className="node-editor__section-head">
                      <span>tools</span>
                      <small>{selected.tools.length}/{AVAILABLE_TOOLS.length}</small>
                    </div>
                    <div className="agent-chip-row node-editor__chip-row">
                      {AVAILABLE_TOOLS.map((tool) => (
                        <button
                          key={tool}
                          type="button"
                          className={`agent-chip ${selected.tools.includes(tool) ? 'agent-chip--on' : ''}`}
                          onClick={() => toggleSelectedTool(tool)}
                        >{tool}</button>
                      ))}
                    </div>
                  </section>

                  {displaySkills.length > 0 && (
                    <section className="node-editor__section node-editor__section--skills">
                      <div className="node-editor__section-head">
                        <span>skills</span>
                        <small>{selected.skills.length}/{displaySkills.length}</small>
                      </div>
                      <div className="node-editor__skills">
                        {skillsets.map((set) => {
                          const setSkills = displaySkills.filter((s) => s.skillsetId === set.id);
                          if (setSkills.length === 0) return null;
                          const expanded = expandedSkillsets[set.id] === true;
                          const selectedCount = setSkills.filter((skill) => selected.skills.includes(skill.id)).length;
                          return (
                            <div key={set.id} className="node-editor__skill-folder">
                              <button
                                type="button"
                                className="node-editor__skill-folder-head"
                                aria-expanded={expanded}
                                onClick={() => toggleSkillset(set.id)}
                              >
                                <span className="skillset__caret">{expanded ? '▾' : '▸'}</span>
                                <span className="node-editor__skill-folder-title">{set.title}</span>
                                <small>{selectedCount}/{setSkills.length}</small>
                              </button>
                              {expanded && (
                                <div className="agent-chip-row node-editor__chip-row node-editor__skill-folder-body">
                                  {setSkills.map((skill) => (
                                    <button
                                      key={skill.id}
                                      type="button"
                                      className={`agent-chip ${selected.skills.includes(skill.id) ? 'agent-chip--on' : ''}`}
                                      title={skill.summary}
                                      onClick={() => toggleSelectedSkill(skill.id)}
                                    >{skill.name}</button>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        {(() => {
                          const loose = displaySkills.filter((s) => !s.skillsetId);
                          if (loose.length === 0) return null;
                          return (
                            <div className="agent-chip-row node-editor__chip-row">
                              {loose.map((skill) => (
                                <button
                                  key={skill.id}
                                  type="button"
                                  className={`agent-chip ${selected.skills.includes(skill.id) ? 'agent-chip--on' : ''}`}
                                  title={skill.summary}
                                  onClick={() => toggleSelectedSkill(skill.id)}
                                >{skill.name}</button>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    </section>
                  )}
                </aside>

                <div className="node-editor__actions">
                  <button type="button" onClick={() => duplicateNode(selected.id)}>duplicate</button>
                  <button type="button" onClick={saveSelectedAsTemplate}>save as template</button>
                  {selected.root ? (
                    <span className="node-editor__danger-wrap" title="can't remove — this is a root node">
                      <button type="button" className="node-editor__danger" disabled>remove</button>
                    </span>
                  ) : (
                    <button type="button" className="node-editor__danger" onClick={() => removeNode(selected.id)}>remove</button>
                  )}
                </div>
              </div>
            </PanelSheet>
          )}
          <div
            className="formation-canvas"
            ref={viewportRef}
          >
            <div
              className="formation-canvas__viewport"
              onPointerDown={onViewportPointerDown}
              onPointerMove={onViewportPointerMove}
              onPointerUp={onViewportPointerUp}
              onPointerCancel={onViewportPointerUp}
              onWheel={onWheel}
            >
              <button
                className="formation-reset-view"
                onClick={resetView}
                onPointerDown={(event) => event.stopPropagation()}
                title="reset view"
                aria-label="reset view"
              >⌂</button>
              <div className="formation-zoom" onPointerDown={(event) => event.stopPropagation()}>
                <button
                  className="formation-zoom__btn"
                  onClick={() => setZoom((z) => Math.min(MAX_ZOOM, Math.round((z + 0.15) * 100) / 100))}
                  disabled={zoom >= MAX_ZOOM}
                  title="zoom in"
                  aria-label="zoom in"
                >+</button>
                <button
                  className="formation-zoom__btn"
                  onClick={() => setZoom((z) => Math.max(MIN_ZOOM, Math.round((z - 0.15) * 100) / 100))}
                  disabled={zoom <= MIN_ZOOM}
                  title="zoom out"
                  aria-label="zoom out"
                >−</button>
              </div>
              <div
                className="formation-canvas__world"
                style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
              >
                <svg className="formation-wires" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '4000px', height: '4000px', pointerEvents: 'none' }}>
                  <defs>
                    <marker
                      id="formation-arrow"
                      viewBox="0 0 10 10"
                      refX="8"
                      refY="5"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path d="M0,0 L10,5 L0,10 z" style={{ fill: 'rgba(var(--c-accent-rgb), 0.75)' }} />
                    </marker>
                  </defs>
                  {connectDrag && (() => {
                    const anchor = formation.find((n) => n.id === connectDrag.nodeId);
                    if (!anchor) return null;
                    const fx = connectDrag.direction === 'out'
                      ? anchor.x + NODE_WIDTH / 2
                      : connectDrag.x;
                    const fy = connectDrag.direction === 'out'
                      ? anchor.y + NODE_HEIGHT
                      : connectDrag.y;
                    const tx = connectDrag.direction === 'out'
                      ? connectDrag.x
                      : anchor.x + NODE_WIDTH / 2;
                    const ty = connectDrag.direction === 'out'
                      ? connectDrag.y
                      : anchor.y;
                    return (
                      <path
                        d={`M ${fx} ${fy} C ${fx} ${(fy + ty) / 2}, ${tx} ${(fy + ty) / 2}, ${tx} ${ty}`}
                        style={{ stroke: connectDrag.overId ? 'rgba(var(--c-accent-rgb), 1)' : 'rgba(var(--c-accent-rgb), 0.7)' }}
                        strokeWidth={2}
                        strokeDasharray={connectDrag.overId ? '0' : '4 4'}
                        fill="none"
                      />
                    );
                  })()}
                  {edges.map((edge) => {
                    const from = formation.find((n) => n.id === edge.from);
                    const to = formation.find((n) => n.id === edge.to);
                    if (!from || !to) return null;
                    const fx = from.x + NODE_WIDTH / 2;
                    const fy = from.y + NODE_HEIGHT;
                    const tx = to.x + NODE_WIDTH / 2;
                    const ty = to.y;
                    const key = `${edge.from}-${edge.to}`;
                    const path = `M ${fx} ${fy} C ${fx} ${(fy + ty) / 2}, ${tx} ${(fy + ty) / 2}, ${tx} ${ty}`;
                    const isHover = hoverEdgeKey === key;
                    // an edge is part of the dispatched circuit only when both
                    // endpoints route back to the active chat; dim the rest.
                    const live = reachableSet.size === 0 || (reachableSet.has(edge.from) && reachableSet.has(edge.to));
                    return (
                      <g key={key} opacity={live ? 1 : 0.3}>
                        <path
                          d={path}
                          style={{ stroke: isHover ? 'rgba(var(--c-accent-rgb), 0.95)' : 'rgba(var(--c-accent-rgb), 0.55)' }}
                          strokeWidth={isHover ? 2 : 1.5}
                          strokeDasharray={live ? undefined : '4 4'}
                          fill="none"
                          markerEnd="url(#formation-arrow)"
                        />
                        <path
                          className="formation-edge-hit"
                          d={path}
                          stroke="transparent"
                          strokeWidth={16}
                          fill="none"
                          style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                          onMouseEnter={() => setHoverEdgeKey(key)}
                          onMouseLeave={() => setHoverEdgeKey((current) => (current === key ? null : current))}
                          onClick={() => removeEdge(edge)}
                        >
                          <title>click to remove handoff</title>
                        </path>
                      </g>
                    );
                  })}
                </svg>
                {formation.length === 0 && (
                  <div className="formation-empty" style={{ position: 'absolute', left: 36, top: 36 }}>
                    <h3>no formation yet</h3>
                    <p>add roles with <strong>+ node</strong>, or start with a preset team.</p>
                    <div className="formation-empty__actions">
                      <button className="formation-tool formation-tool--primary" onClick={loadStarterTeam}>load starter team</button>
                      <button className="formation-tool" onClick={openAddNodePicker}>+ node</button>
                    </div>
                  </div>
                )}
                {formation.map((node) => {
                  const isSelected = selectedId === node.id;
                  const isLinkSrc = linkSourceId === node.id;
                  const statusLabel = node.status === 'running' ? 'active' : node.status === 'missing' ? 'offline' : node.status;
                  return (
                    <div
                      key={node.id}
                      role="button"
                      tabIndex={0}
                      className={[
                        'formation-node',
                        `formation-node--${node.status}`,
                        node.root ? 'formation-node--root' : '',
                        (reachableSet.size > 0 && !reachableSet.has(node.id)) ? 'formation-node--orphan' : '',
                        isLinkSrc ? 'formation-node--linking' : '',
                        isSelected ? 'formation-node--selected' : '',
                      ].filter(Boolean).join(' ')}
                      style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                      aria-label={`${node.role} ${node.status}`}
                      onPointerDown={(event) => onNodePointerDown(event, node)}
                      onPointerMove={onNodePointerMove}
                      onPointerUp={onNodePointerUp}
                      onContextMenu={(event) => { event.preventDefault(); setSelectedId(node.id); }}
                      onKeyDown={(event) => {
                        if (event.key === 'Delete' || event.key === 'Backspace') {
                          event.preventDefault();
                          removeNode(node.id);
                        } else if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          clickNode(node.id);
                        } else if (event.key === 'd' && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          duplicateNode(node.id);
                        }
                      }}
                    >
                      {!node.root && (
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label={`drag to ${node.role} to connect`}
                          title="drag to another node output to create a handoff"
                          className={`formation-port formation-port--in ${connectDrag?.direction === 'out' && connectDrag.overId === node.id ? 'formation-port--target' : ''}`}
                          onPointerDown={(event) => onPortPointerDown(event, node, 'in')}
                          onPointerMove={onPortPointerMove}
                          onPointerUp={onPortPointerUp}
                          onPointerCancel={onPortPointerUp}
                          onClick={(event) => event.stopPropagation()}
                        />
                      )}
                      <div className="formation-node__body">
                        <span className={`formation-node__status formation-node__status--${node.status}`} title={statusLabel} aria-label={statusLabel} />
                        <div className="formation-node__identity">
                          <strong className="formation-node__name">{node.role || 'role'}</strong>
                        </div>
                      </div>
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={`drag from ${node.role} to connect`}
                        title="drag to another node to create a handoff"
                        className={`formation-port formation-port--out ${connectDrag?.direction === 'in' && connectDrag.overId === node.id ? 'formation-port--target' : ''}`}
                        onPointerDown={(event) => onPortPointerDown(event, node, 'out')}
                        onPointerMove={onPortPointerMove}
                        onPointerUp={onPortPointerUp}
                        onPointerCancel={onPortPointerUp}
                        onClick={(event) => event.stopPropagation()}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
            <span className="formation-canvas__hint">drag to pan · wheel to zoom · drag a port to connect or add · esc to deselect</span>
            <div className="formation-bottom-actions">
              <button
                className="formation-copy"
                disabled={formation.length === 0}
                onClick={copyMarkdown}
              >copy</button>
              <div className="formation-send-wrap">
                <button
                  className="formation-send"
                  disabled={busy === 'sending' || !activeConversationId || formation.length === 0}
                  onClick={sendToChat}
                >{busy === 'sending' ? 'sending…' : 'send to chat'}</button>
              </div>
            </div>
            {linkSourceId && (
              <span className="formation-link-mode">linking from <strong style={{ marginLeft: 4 }}>{formation.find((n) => n.id === linkSourceId)?.role}</strong> — pick a target</span>
            )}
            {agentNotice && <span className="formation-notice">{agentNotice}</span>}
          </div>
        </section>
      </div>
    </div>
  );
}
