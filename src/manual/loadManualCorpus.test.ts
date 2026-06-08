import { describe, expect, test } from 'vitest';
import { loadManualCorpus } from './loadManualCorpus';

describe('loadManualCorpus (real files)', () => {
  test('assembles seeded concept docs and panel pages with derived facts', () => {
    const corpus = loadManualCorpus();

    const gettingStarted = corpus.get('the-ide/getting-started');
    expect(gettingStarted).toBeDefined();
    expect(gettingStarted!.group).toBe('the ide');
    expect(gettingStarted!.body).toContain('agentic coding sessions');

    const editor = corpus.get('panels/polypore.editor');
    expect(editor).toBeDefined();
    expect(editor!.facts?.id).toBe('polypore.editor');
    expect(editor!.body).toContain('Monaco-backed code editor');

    // nav groups assembled in canonical order
    const groupNames = corpus.groups.map((group) => group.name);
    expect(groupNames).toContain('the agent & mcp');
    expect(groupNames.indexOf('the ide')).toBeLessThan(groupNames.indexOf('panels'));
  });
});
