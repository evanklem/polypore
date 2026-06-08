import { describe, expect, test } from 'vitest';
import { hexToRgb, rgbToHex, rgbToHsl, hslToRgb, deriveThemeTokens } from './themeColor';

describe('themeColor', () => {
  test('hex parses and round-trips through rgb', () => {
    expect(hexToRgb('#f0b35a')).toEqual({ r: 240, g: 179, b: 90 });
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(rgbToHex({ r: 240, g: 179, b: 90 })).toBe('#f0b35a');
  });

  test('hsl round-trips back to the original rgb', () => {
    const rgb = { r: 122, g: 170, b: 228 };
    const back = hslToRgb(rgbToHsl(rgb));
    expect(back).toEqual(rgb);
  });

  test('derives the accent triple verbatim from the picked colour', () => {
    const tokens = deriveThemeTokens('#7aaae4');
    expect(tokens['--c-accent-rgb']).toBe('122, 170, 228');
  });

  test('deep shade is darker and pale shade is lighter than the accent', () => {
    const tokens = deriveThemeTokens('#7aaae4');
    const sum = (t: string) => t.split(',').reduce((a, n) => a + Number(n), 0);
    expect(sum(tokens['--c-accent-deep-rgb'])).toBeLessThan(sum(tokens['--c-accent-rgb']));
    expect(sum(tokens['--c-accent-pale-rgb'])).toBeGreaterThan(sum(tokens['--c-accent-rgb']));
  });

  test('surfaces and ink are re-hued toward the accent (blue accent -> blue-tinted darks)', () => {
    const tokens = deriveThemeTokens('#7aaae4'); // blue
    const surface = tokens['--c-surface-4-rgb'].split(',').map(Number);
    const ink = tokens['--c-ink-rgb'].split(',').map(Number);
    // blue tint means blue channel exceeds red on both the dark surface and the ink
    expect(surface[2]).toBeGreaterThan(surface[0]);
    expect(ink[2]).toBeGreaterThan(ink[0]);
  });

  test('a warm accent keeps surfaces warm (red channel leads)', () => {
    const tokens = deriveThemeTokens('#f0b35a'); // honey
    const surface = tokens['--c-surface-4-rgb'].split(',').map(Number);
    expect(surface[0]).toBeGreaterThan(surface[2]);
  });

  test('every primitive tokens.css exposes is produced', () => {
    const tokens = deriveThemeTokens('#8abe84');
    for (const key of [
      '--c-accent-rgb', '--c-accent-deep-rgb', '--c-accent-pale-rgb',
      '--c-ink-rgb', '--c-muted-rgb',
      '--c-surface-0-rgb', '--c-surface-6-rgb',
    ]) {
      expect(tokens[key]).toMatch(/^\d+, \d+, \d+$/);
    }
  });
});
