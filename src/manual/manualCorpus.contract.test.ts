import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { buildManualCorpus, type ManualSection } from './manualCorpus';
// @ts-ignore the MCP server is authored as ESM JavaScript and exports testable helpers.
import { readManualSections } from '../../packages/mcp-server/src/server.mjs';

const repoRoot = process.cwd();

function walk(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function frontendSections(): ManualSection[] {
  const docs = walk(path.join(repoRoot, 'docs', 'manual'))
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({
      path: path.relative(repoRoot, file).split(path.sep).join('/'),
      body: readFileSync(file, 'utf8'),
    }));
  const panels = walk(path.join(repoRoot, 'plugins'))
    .filter((file) => path.basename(file) === 'polypore.json')
    .map((file) => ({
      manifest: JSON.parse(readFileSync(file, 'utf8')),
      body: readFileSync(path.join(path.dirname(file), 'MANUAL.md'), 'utf8'),
    }));
  return buildManualCorpus({ docs, panels }).sections;
}

function normalize(sections: ManualSection[]) {
  return sections
    .map((section) => ({
      slug: section.slug,
      title: section.title,
      group: section.group,
      order: section.order,
      body: section.body,
      facts: section.facts ?? null,
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

describe('manual corpus reader contract', () => {
  test('authored manual navigation and headings use lowercase labels', () => {
    const sections = frontendSections();

    for (const section of sections) {
      expect(section.title, `${section.slug} title`).toBe(section.title.toLocaleLowerCase());
      expect(section.group, `${section.slug} group`).toBe(section.group.toLocaleLowerCase());

      for (const line of section.body.split('\n')) {
        const heading = /^#{1,6}\s+(.+)$/.exec(line)?.[1];
        if (heading) expect(heading, `${section.slug} heading`).toBe(heading.toLocaleLowerCase());
      }
    }
  });

  test('frontend and MCP readers build the same manual sections from disk', async () => {
    expect(normalize(await readManualSections({ root: repoRoot }))).toEqual(normalize(frontendSections()));
  });

  test('project configuration contracts are available in the manual corpus', async () => {
    const sections = await readManualSections({ root: repoRoot });
    const section = sections.find((item: ManualSection) => item.slug === 'the-ide/project-configuration');

    expect(section).toBeDefined();
    expect(section!.title).toBe('project configuration');
    expect(section!.body).toContain('.polypore/language-servers.json');
    expect(section!.body).toContain('.polypore/runtime.json');
    expect(section!.body).toContain('.polypore/verify.json');
    expect(section!.body).toContain('.polypore/diagnostics.json');
    expect(section!.body).toContain('.polypore/formatters.json');
    expect(section!.body).toContain('.polypore/file-tree.json');
  });
});
