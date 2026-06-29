import { describe, expect, test } from 'vitest';
import { splitColorizedLines } from './monaco-highlight';

describe('splitColorizedLines', () => {
  test('splits monaco colorize output on <br/> and drops the trailing empty entry', () => {
    const html = '<span class="mtk1">const</span><br/><span class="mtk1">x</span><br/>';
    expect(splitColorizedLines(html)).toEqual([
      '<span class="mtk1">const</span>',
      '<span class="mtk1">x</span>',
    ]);
  });

  test('keeps interior blank lines so row alignment is preserved', () => {
    const html = 'a<br/><br/>b<br/>';
    expect(splitColorizedLines(html)).toEqual(['a', '', 'b']);
  });

  test('returns an empty array for empty input', () => {
    expect(splitColorizedLines('')).toEqual([]);
  });

  test('a lone <br/> is a single blank line', () => {
    expect(splitColorizedLines('<br/>')).toEqual(['']);
  });
});
