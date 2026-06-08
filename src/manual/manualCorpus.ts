/* The manual corpus: one authored body of content, two readers.
 *
 * Prose lives in markdown — `plugins/<id>/MANUAL.md` per panel and
 * `docs/manual/**` for cross-cutting concepts. Facts (version, permissions,
 * capabilities) are NEVER restated in prose; they are derived from the panel
 * manifest here so they can't drift. The human reader renders these sections;
 * the agent reads the same files through the mirrored mcp-server convention.
 */

export interface ManualPanelManifest {
  id: string;
  title?: string;
  version?: string;
  permissions?: string[];
  capabilities?: string[];
  category?: string;
}

export interface ManualPanelInput {
  manifest: ManualPanelManifest;
  /** raw markdown prose from the panel's MANUAL.md */
  body: string;
}

export interface ManualDocInput {
  /** source path, e.g. docs/manual/agent-mcp/secrets.md */
  path: string;
  /** raw markdown, optionally front-matter-prefixed */
  body: string;
}

export interface ManualFacts {
  id: string;
  version: string;
  permissions: string[];
  capabilities: string[];
  category: string;
}

export type ManualSectionKind = 'concept' | 'panel' | 'reference';

export interface ManualSection {
  slug: string;
  title: string;
  group: string;
  kind: ManualSectionKind;
  body: string;
  /** sort key within its nav group; lower sorts first, ties break on title */
  order: number;
  facts?: ManualFacts;
}

export interface ManualGroup {
  name: string;
  sections: ManualSection[];
}

export interface ManualCorpus {
  sections: ManualSection[];
  groups: ManualGroup[];
  get(slug: string): ManualSection | undefined;
}

/* Canonical nav order. Groups absent from the corpus are skipped; any group a
 * doc names outside this list is appended after, in first-seen order. */
const GROUP_ORDER = ['the ide', 'the agent & mcp', 'panels', 'workflows', 'reference'];

export interface ManualCorpusInput {
  docs: ManualDocInput[];
  panels: ManualPanelInput[];
}

function deriveFacts(manifest: ManualPanelManifest): ManualFacts {
  return {
    id: manifest.id,
    version: manifest.version ?? '0.1.0',
    permissions: manifest.permissions ?? [],
    capabilities: manifest.capabilities ?? [],
    category: manifest.category ?? 'other',
  };
}

interface FrontMatter {
  meta: Record<string, string>;
  body: string;
}

/* Minimal front-matter: a leading `---` fenced block of `key: value` lines.
 * We deliberately avoid a YAML dependency — manual front-matter only ever
 * carries flat string scalars (title, group, order). */
function parseFrontMatter(raw: string): FrontMatter {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: raw.slice(match[0].length) };
}

function docSlug(path: string): string {
  return path.replace(/^docs\/manual\//, '').replace(/\.md$/, '');
}

function conceptSection({ path, body: raw }: ManualDocInput): ManualSection {
  const { meta, body } = parseFrontMatter(raw);
  const slug = docSlug(path);
  return {
    slug,
    title: meta.title ?? slug,
    group: meta.group ?? 'the ide',
    kind: 'concept',
    body,
    order: Number.isFinite(Number(meta.order)) ? Number(meta.order) : 0,
  };
}

function panelSection({ manifest, body }: ManualPanelInput): ManualSection {
  return {
    slug: `panels/${manifest.id}`,
    title: manifest.title ?? manifest.id,
    group: 'panels',
    kind: 'panel',
    body,
    order: 0,
    facts: deriveFacts(manifest),
  };
}

function groupSections(sections: ManualSection[]): ManualGroup[] {
  const byName = new Map<string, ManualSection[]>();
  for (const section of sections) {
    const bucket = byName.get(section.group) ?? [];
    bucket.push(section);
    byName.set(section.group, bucket);
  }
  const present = [...byName.keys()];
  const ordered = [
    ...GROUP_ORDER.filter((name) => byName.has(name)),
    ...present.filter((name) => !GROUP_ORDER.includes(name)),
  ];
  return ordered.map((name) => ({
    name,
    sections: byName.get(name)!.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)),
  }));
}

export function buildManualCorpus(input: ManualCorpusInput): ManualCorpus {
  const sections = [...input.docs.map(conceptSection), ...input.panels.map(panelSection)];
  const bySlug = new Map(sections.map((section) => [section.slug, section]));
  return {
    sections,
    groups: groupSections(sections),
    get: (slug) => bySlug.get(slug),
  };
}
