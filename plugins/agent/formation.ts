/* formation-canvas domain: node/edge/template types, the built-in role
   templates, and the pure graph logic (sanitize/normalize/layout/prompt
   bundling). UI-free — the canvas component renders what these compute. */

import type { ChatTarget } from '../shared';
import { openChatPanelTargets } from '../shared';
import type { SkillCard } from './rail';

export type NodeStatus = 'running' | 'waiting' | 'idle' | 'missing';

export type FormationNode = {
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

export type FormationEdge = {
  from: string;
  to: string;
};

export type NodeTemplate = {
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

export type OpenAgentPanel = {
  id: string;
  agent: string;
  title: string;
  active?: boolean;
};

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 58;
export const FIT_VIEW_PADDING = 72;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 1.8;
export const FORMATION_KEY = 'polypore.agent.formation.v2';
export const TEMPLATES_KEY = 'polypore.agent.templates.v1';
export const LEGACY_FORMATION_KEY = 'polypore.agent.formation';
export const DEFAULT_NODE_MODEL = 'inherit';

export const MODEL_OPTIONS = [
  'inherit',
  'runtime',
  'claude-opus',
  'claude-sonnet',
  'claude-haiku',
  'codex',
  'gpt-5',
];

export const AVAILABLE_TOOLS = [
  'edit',
  'bash',
  'web',
  'search',
  'git',
  'mcp',
  'verify',
  'memory',
];

export const BUILTIN_TEMPLATES: NodeTemplate[] = [
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

export const BLANK_TEMPLATE: NodeTemplate = {
  id: 'tpl-blank',
  role: 'agent',
  detail: 'custom role',
  prompt: '',
  model: DEFAULT_NODE_MODEL,
  skills: [],
  tools: [],
};

export function cleanTemplate(raw: Partial<NodeTemplate>, builtinIds = new Set<string>()): NodeTemplate | null {
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

export function mergeStoredTemplates(stored: unknown): NodeTemplate[] {
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

export function templatesForStorage(items: NodeTemplate[]): NodeTemplate[] {
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

export function newNodeId() {
  return `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export function templateToNode(tpl: NodeTemplate, x: number, y: number, opts?: { root?: boolean }): FormationNode {
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

export function providerForRoleModel(role: string, model: string) {
  const haystack = `${role} ${model}`.toLowerCase();
  if (haystack.includes('claude')) return 'claude';
  if (haystack.includes('codex')) return 'codex';
  return null;
}

export function looksLikeLocalPath(value: string) {
  return value.startsWith('/') || value.startsWith('~/') || value.includes('/.local/bin/');
}

export function blockedHandoffMessage(
  from: { role: string; model: string },
  to: { role: string; model: string },
) {
  if (providerForRoleModel(from.role, from.model) === 'codex'
    && providerForRoleModel(to.role, to.model) === 'claude') {
    return 'cannot add that handoff: anthropic does not support using claude as a subagent for codex.';
  }
  return null;
}

export function withHandoff(nodes: FormationNode[], edges: FormationEdge[], fromId: string, toId: string) {
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

export function filterTemplatesByQuery(items: NodeTemplate[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((t) =>
    t.role.toLowerCase().includes(q) || t.detail.toLowerCase().includes(q),
  );
}

export function sanitizeNode(node: Partial<FormationNode> & { left?: string; top?: string }, index = 0): FormationNode {
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

export function normalizeEdges(nodes: FormationNode[], edges: FormationEdge[]) {
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
export function makeRootNode(panel: { id: string; agent: string; title?: string }, prev?: FormationNode): FormationNode {
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

export function readOpenChatTargets(): ChatTarget[] {
  if (typeof window === 'undefined') return [];
  return openChatPanelTargets();
}

/* nodes the active conversation root can actually dispatch to: itself plus
   everything wired downstream of it. anything not reachable is an orphan the
   chat has no path to, so it never makes it into the prompt bundle. */
export function reachableFromRoot(nodes: FormationNode[], edges: FormationEdge[]): Set<string> {
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

export function buildPromptBundle(allNodes: FormationNode[], allEdges: FormationEdge[], skills: SkillCard[]): string {
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

export function autoLayoutFormation(formation: FormationNode[], edges: FormationEdge[]): FormationNode[] {
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

