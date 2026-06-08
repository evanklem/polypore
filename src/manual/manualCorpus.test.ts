import { describe, expect, test } from 'vitest';
import { buildManualCorpus } from './manualCorpus';

describe('manual corpus', () => {
  test('a panel page takes prose from markdown and derives its facts from the manifest', () => {
    const corpus = buildManualCorpus({
      docs: [],
      panels: [
        {
          manifest: {
            id: 'polypore.editor',
            title: 'editor',
            version: '0.2.0',
            permissions: ['fs.read', 'fs.write'],
            capabilities: ['format'],
            category: 'core',
          },
          body: '# editor\n\nOpen files and edit them. Save with cmd-s.',
        },
      ],
    });

    const section = corpus.get('panels/polypore.editor');
    expect(section).toBeDefined();
    expect(section!.kind).toBe('panel');
    expect(section!.group).toBe('panels');
    expect(section!.title).toBe('editor');
    expect(section!.body).toContain('Save with cmd-s.');
    expect(section!.facts).toEqual({
      id: 'polypore.editor',
      version: '0.2.0',
      permissions: ['fs.read', 'fs.write'],
      capabilities: ['format'],
      category: 'core',
    });
  });

  test('a concept doc parses front-matter into title/group and strips it from the body', () => {
    const corpus = buildManualCorpus({
      panels: [],
      docs: [
        {
          path: 'docs/manual/agent-mcp/secrets.md',
          body: [
            '---',
            'title: secrets & safety',
            'group: the agent & mcp',
            'order: 3',
            '---',
            'Secrets never return their value. Use the handle.',
          ].join('\n'),
        },
      ],
    });

    const section = corpus.get('agent-mcp/secrets');
    expect(section).toBeDefined();
    expect(section!.kind).toBe('concept');
    expect(section!.group).toBe('the agent & mcp');
    expect(section!.title).toBe('secrets & safety');
    expect(section!.body.trim()).toBe('Secrets never return their value. Use the handle.');
    expect(section!.facts).toBeUndefined();
  });

  test('sections are organised into nav groups in canonical order, ordered within each', () => {
    const corpus = buildManualCorpus({
      panels: [{ manifest: { id: 'polypore.editor', title: 'editor' }, body: 'x' }],
      docs: [
        {
          path: 'docs/manual/the-ide/getting-started.md',
          body: '---\ntitle: getting started\ngroup: the ide\norder: 1\n---\nhi',
        },
        {
          path: 'docs/manual/agent-mcp/secrets.md',
          body: '---\ntitle: secrets\ngroup: the agent & mcp\norder: 2\n---\nhi',
        },
        {
          path: 'docs/manual/agent-mcp/tools.md',
          body: '---\ntitle: tools\ngroup: the agent & mcp\norder: 1\n---\nhi',
        },
      ],
    });

    expect(corpus.groups.map((group) => group.name)).toEqual([
      'the ide',
      'the agent & mcp',
      'panels',
    ]);
    const agentMcp = corpus.groups.find((group) => group.name === 'the agent & mcp')!;
    expect(agentMcp.sections.map((section) => section.title)).toEqual(['tools', 'secrets']);
  });
});
