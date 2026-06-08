/* Theme derivation: from one picked accent color, produce every RGB-triplet
 * primitive tokens.css exposes (accent + deep/pale shades, the dark surface
 * ladder, ink, muted). The surface/ink tones are re-hued to the accent so the
 * whole UI — backgrounds and panel bodies included — shifts in lockstep, not
 * just the accent-colored chrome. Lightness of each surface step is preserved
 * from the original warm palette; only the hue (and a capped saturation) move.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb {
  let value = hex.trim().replace(/^#/, '');
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  const int = Number.parseInt(value, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (n: number) => clampByte(n).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export interface Hsl {
  h: number; // 0..360
  s: number; // 0..1
  l: number; // 0..1
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;
  let s = 0;
  let h = 0;
  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let [r, g, b] = [0, 0, 0];
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: clampByte((r + m) * 255), g: clampByte((g + m) * 255), b: clampByte((b + m) * 255) };
}

function triple({ r, g, b }: Rgb): string {
  return `${clampByte(r)}, ${clampByte(g)}, ${clampByte(b)}`;
}

/* original warm palette — used only as the lightness reference for each step */
const BASE_SURFACES: Rgb[] = [
  { r: 5, g: 4, b: 4 },
  { r: 10, g: 8, b: 7 },
  { r: 12, g: 9, b: 7 },
  { r: 15, g: 11, b: 8 },
  { r: 21, g: 17, b: 14 },
  { r: 22, g: 16, b: 11 },
  { r: 28, g: 21, b: 14 },
];
const BASE_INK: Rgb = { r: 245, g: 234, b: 215 };
const BASE_MUTED: Rgb = { r: 185, g: 170, b: 145 };

/* saturation each layer takes from the accent hue. surfaces stay subtle so
 * dark backgrounds read as "tinted near-black", not coloured panels. ink keeps
 * enough to read as a warm/cool white without losing contrast. */
const SURFACE_SAT = 0.22;
const INK_SAT = 0.16;
const MUTED_SAT = 0.16;

function reHue(base: Rgb, hue: number, saturation: number): string {
  const { l } = rgbToHsl(base);
  return triple(hslToRgb({ h: hue, s: saturation, l }));
}

export function deriveThemeTokens(accentHex: string): Record<string, string> {
  const accent = hexToRgb(accentHex);
  const { h, s, l } = rgbToHsl(accent);

  const tokens: Record<string, string> = {
    '--c-accent-rgb': triple(accent),
    '--c-accent-deep-rgb': triple(hslToRgb({ h, s, l: Math.max(0, l * 0.74) })),
    '--c-accent-pale-rgb': triple(hslToRgb({ h, s: Math.min(1, s * 0.85), l: Math.min(0.9, l + 0.24) })),
    '--c-ink-rgb': reHue(BASE_INK, h, INK_SAT),
    '--c-muted-rgb': reHue(BASE_MUTED, h, MUTED_SAT),
  };
  BASE_SURFACES.forEach((surface, index) => {
    tokens[`--c-surface-${index}-rgb`] = reHue(surface, h, SURFACE_SAT);
  });
  return tokens;
}
