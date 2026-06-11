import { describe, expect, test } from 'vitest';
import { skillIdForName } from './rail';

describe('skillIdForName', () => {
  test('slugs the skill name so the published slash command is readable', () => {
    expect(skillIdForName('Deploy Check', [])).toBe('deploy-check');
    expect(skillIdForName('  fix CI!  ', [])).toBe('fix-ci');
  });

  test('suffixes instead of colliding with existing ids', () => {
    expect(skillIdForName('deploy check', ['deploy-check'])).toBe('deploy-check-2');
    expect(skillIdForName('deploy check', ['deploy-check', 'deploy-check-2'])).toBe('deploy-check-3');
  });

  test('falls back to a generic slug for symbol-only names', () => {
    expect(skillIdForName('!!!', [])).toBe('skill');
  });
});
