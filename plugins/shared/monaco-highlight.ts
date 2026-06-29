import type * as MonacoApi from 'monaco-editor/esm/vs/editor/editor.api';
import { loadInterfaceSettings } from '../../src/settings/settingsStorage';

export type MonacoModule = typeof MonacoApi;

/* one shared promise so the editor panel and the diff panel pull the same
   Monaco chunk. editor.main (not editor.api) is the "fat" entry that
   auto-registers every basic-language monarch tokenizer — without it both
   panels would render flat plaintext. */
let monacoPromise: Promise<MonacoModule> | null = null;

export function loadMonaco(): Promise<MonacoModule> {
  if (!monacoPromise) {
    monacoPromise = import('monaco-editor/esm/vs/editor/editor.main') as unknown as Promise<MonacoModule>;
  }
  return monacoPromise;
}

/* glass editor theme — warm-dark surface with a transparent background so the
   panel's frosted layer shows through. Accent colors are derived from the
   user's current settings so chrome updates when the theme changes; syntax
   token colors stay inherited from vs-dark (rules: []). */
export function buildGlassThemeColors(accentHex: string): Record<string, string> {
  let r = 240, g = 179, b = 90; // honey fallback
  const clean = accentHex.replace('#', '');
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    r = parseInt(clean.slice(0, 2), 16);
    g = parseInt(clean.slice(2, 4), 16);
    b = parseInt(clean.slice(4, 6), 16);
  }
  const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  const a = (alpha: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}${hex2(alpha * 255)}`;
  const full = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return {
    'editor.background': '#0d0a0700',
    'editor.foreground': '#ffffff',
    'editorLineNumber.foreground': '#5c4a32',
    'editorLineNumber.activeForeground': full,
    'editor.selectionBackground': a(0.40),
    'editor.lineHighlightBackground': '#1a120c80',
    'editorCursor.foreground': full,
    'editorIndentGuide.background': '#2a1c1240',
    'editorIndentGuide.activeBackground': a(0.19),
    'editorBracketMatch.background': a(0.19),
    'editorBracketMatch.border': full,
    'editorStickyScroll.background': '#120c08f5',
    'editorStickyScrollHover.background': '#1d1410f8',
    'editor.findMatchBackground': a(0.31),
    'editor.findMatchHighlightBackground': a(0.13),
    'editor.findMatchBorder': a(0.60),
    'editor.findRangeHighlightBackground': a(0.06),
    'editorWidget.background': '#1a110a',
    'editorWidget.border': '#3d2a1a',
    'editorWidget.foreground': '#ffffff',
    'input.background': '#2a1c10',
    'input.border': '#3d2a1a',
    'input.foreground': '#ffffff',
    'inputOption.activeBorder': full,
    'inputOption.activeBackground': a(0.13),
  };
}

/* define + activate the glass theme. idempotent — defineTheme/setTheme just
   overwrite, so callers (editor on accent change, diff before colorizing) can
   invoke it freely. setTheme also injects the global .mtkN color classes that
   colorize()'s output relies on. */
export function applyGlassTheme(monaco: MonacoModule): void {
  const accent = loadInterfaceSettings().accent;
  monaco.editor.defineTheme('polypore-warm', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: buildGlassThemeColors(accent),
  });
  monaco.editor.setTheme('polypore-warm');
}

/* look up monaco's registered language id for a file path by querying the
   editor's own language registry. `monaco.languages.getLanguages()` returns
   every contribution registered by `editor.main` (the basic-languages bundle),
   each with the file extensions, recognized filenames (Dockerfile, Makefile, …),
   and aliases it claims. matching against that registry means we automatically
   pick up any language monaco ships with — no whitelist to keep in sync. falls
   back to plaintext if nothing claims the file. */
export function monacoLanguageForPath(monaco: MonacoModule, path: string): string {
  if (!path) return 'plaintext';
  const filename = (path.split('/').pop() ?? '').toLowerCase();
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot) : '';
  const langs = (monaco as unknown as {
    languages: {
      getLanguages: () => Array<{
        id: string;
        extensions?: string[];
        filenames?: string[];
        aliases?: string[];
      }>;
    };
  }).languages.getLanguages();
  for (const lang of langs) {
    if (ext && lang.extensions?.some((e) => e.toLowerCase() === ext)) return lang.id;
    if (lang.filenames?.some((f) => f.toLowerCase() === filename)) return lang.id;
  }
  /* aliases/ids without dotted extensions (e.g. "Dockerfile.dev") — last
     ditch: check if the bare filename or trailing token matches a language
     id or alias. */
  const tail = dot >= 0 ? filename.slice(dot + 1) : filename;
  for (const lang of langs) {
    if (lang.id.toLowerCase() === tail) return lang.id;
    if (lang.aliases?.some((a) => a.toLowerCase() === tail)) return lang.id;
  }
  return 'plaintext';
}

/* monaco.editor.colorize joins per-line HTML with <br/> and appends a trailing
   <br/>. Split it back into one entry per source line, dropping only that
   trailing terminator so interior blank lines stay (row alignment depends on
   it). */
export function splitColorizedLines(html: string): string[] {
  if (html === '') return [];
  const parts = html.split('<br/>');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/* colorize a contiguous block of source text into per-line HTML using the
   active theme's token colors. plaintext is returned as escaped-but-uncolored
   lines, so callers can skip it. */
export async function colorizeLines(
  monaco: MonacoModule,
  text: string,
  languageId: string,
): Promise<string[]> {
  const html = await monaco.editor.colorize(text, languageId, { tabSize: 2 });
  return splitColorizedLines(html);
}
