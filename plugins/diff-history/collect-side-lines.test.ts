import { describe, expect, test } from 'vitest';
import { collectSideLines, type SideRow } from './collect-side-lines';

const rows: SideRow[] = [
  { kind: 'header', text: '@@ -1,3 +1,3 @@' },
  { kind: 'context', baseLn: 1, targetLn: 1, text: 'const a = 1;' },
  { kind: 'delete', baseLn: 2, text: 'const old = 2;' },
  { kind: 'add', targetLn: 2, text: 'const fresh = 2;' },
  { kind: 'change', baseLn: 3, baseText: 'return old;', targetLn: 3, targetText: 'return fresh;' },
];

describe('collectSideLines', () => {
  test('base side takes context, delete, and change-base text in row order', () => {
    expect(collectSideLines(rows, 'base')).toEqual([
      { index: 1, text: 'const a = 1;' },
      { index: 2, text: 'const old = 2;' },
      { index: 4, text: 'return old;' },
    ]);
  });

  test('target side takes context, add, and change-target text in row order', () => {
    expect(collectSideLines(rows, 'target')).toEqual([
      { index: 1, text: 'const a = 1;' },
      { index: 3, text: 'const fresh = 2;' },
      { index: 4, text: 'return fresh;' },
    ]);
  });

  test('headers and the opposite side’s rows are excluded', () => {
    expect(collectSideLines(rows, 'base').some((l) => l.index === 0)).toBe(false);
    expect(collectSideLines(rows, 'base').some((l) => l.index === 3)).toBe(false);
    expect(collectSideLines(rows, 'target').some((l) => l.index === 2)).toBe(false);
  });
});
