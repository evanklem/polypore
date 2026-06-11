/* side-rail domain types + pure helpers for the agent panel: skills,
   skillsets, MCP install drafts, secret masks. UI-free. */

import type { MergedMcpRow } from './mergeDiscoveredMcps';

export type SkillCard = {
  id: string;
  name: string;
  summary: string;
  body?: string;
  skillsetId?: string;
  origin?: 'polypore' | 'builtin' | 'claude' | 'codex';
  publishedTo?: Array<'claude' | 'codex'>;
};

export type McpInstallAgent = 'claude-project' | 'claude-user' | 'codex';
export type McpInstallTarget = 'claude' | 'codex' | 'global';
export type McpInstallDraft = {
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
export const EMPTY_INSTALL_DRAFT: McpInstallDraft = {
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

export function deriveInstallAgents(draft: McpInstallDraft): McpInstallAgent[] {
  const out = new Set<McpInstallAgent>();
  if (draft.targets.includes('claude')) out.add(draft.claudeScope === 'user' ? 'claude-user' : 'claude-project');
  if (draft.targets.includes('codex')) out.add('codex');
  if (draft.targets.includes('global')) { out.add('claude-user'); out.add('codex'); }
  return [...out];
}

export function parseKvText(text: string): Record<string, string> {
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

export type SkillScopeChip = 'claude' | 'codex' | 'global';
export const SCOPE_CYCLE: SkillScopeChip[] = ['claude', 'codex', 'global'];
export type SkillDraft = {
  name: string;
  body: string;
  skillsetId: string;
  chip: SkillScopeChip;
};
export type SkillEditDraft = SkillDraft;
export const EMPTY_SKILL_DRAFT: SkillDraft = { name: '', body: '', skillsetId: '', chip: 'global' };

export function chipForSkill(skill: SkillCard): SkillScopeChip {
  if (skill.origin === 'claude' || skill.origin === 'codex') return skill.origin;
  const exported = skill.publishedTo ?? [];
  if (exported.includes('claude') && exported.includes('codex')) return 'global';
  if (exported.includes('claude')) return 'claude';
  if (exported.includes('codex')) return 'codex';
  return 'global';
}

export function agentsForChip(chip: SkillScopeChip): Array<'claude' | 'codex'> {
  if (chip === 'global') return ['claude', 'codex'];
  if (chip === 'claude') return ['claude'];
  return ['codex'];
}

export function summarizeSkillDraft(body: string) {
  return body
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('#'))
    ?.slice(0, 120) ?? '';
}

/* skills publish to agent skill dirs under their id, and the agents derive
   the slash command from that directory name — so the id must be a readable
   slug of the skill's name ("/deploy-check"), not an opaque timestamp id
   ("/skill-1749580000000"). suffix on collision instead of overwriting. */
export function skillIdForName(name: string, takenIds: readonly string[]): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    || 'skill';
  if (!takenIds.includes(base)) return base;
  let suffix = 2;
  while (takenIds.includes(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export type SkillsetCard = {
  id: string;
  title: string;
  version: string;
  builtin?: boolean;
  source?: string;
  summary?: string;
  skills: string[];
};

export type McpServerCard = {
  id: string;
  name: string;
  url: string;
  scope: 'project' | 'user' | 'polypore';
  authRef?: string;
  lastTest?: { ok: boolean; ts: number; status?: number; error?: string };
};

export type SecretMask = {
  id: string;
  scope: 'user' | 'project';
  service: string;
  hint: string;
  configured: boolean;
};

export const BUILTIN_MCP = {
  key: 'builtin:polypore-ide',
  name: 'polypore-ide',
  detail: 'node packages/mcp-server/src/server.mjs',
};

export function mcpRowDetail(row: MergedMcpRow): string {
  if (row.kind === 'managed') return row.url;
  if (row.url) return row.url;
  if (row.command) return [row.command, ...(row.args ?? [])].join(' ');
  return row.transport;
}
