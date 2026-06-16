/* terminal rendering helpers shared by the Terminal panel (live xterm) and the
   Preview panel (live xterm for the interactive surface, ansiToText for the
   read-only log views). keeping the theme in one place means both surfaces
   tint identically with the accent. */

/** xterm theme derived from the user's accent. the ansi indexes follow xterm
    convention so programs emitting `ESC[31m` etc. land on warm tones. */
export function buildTerminalTheme(accentHex: string): Record<string, string> {
  let r = 240, g = 179, b = 90; // honey fallback
  const clean = accentHex.replace('#', '');
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    r = parseInt(clean.slice(0, 2), 16);
    g = parseInt(clean.slice(2, 4), 16);
    b = parseInt(clean.slice(4, 6), 16);
  }
  const hex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  const full = `#${hex(r)}${hex(g)}${hex(b)}`;
  // pale variant: blend toward white for brightYellow
  const pale = `#${hex(r + (255 - r) * 0.4)}${hex(g + (255 - g) * 0.4)}${hex(b + (255 - b) * 0.4)}`;
  // selection: accent at ~40% alpha over opaque dark
  const sel = `#${hex(r)}${hex(g)}${hex(b)}66`;
  return {
    background: '#00000000',
    foreground: '#ffffff',
    cursor: full,
    cursorAccent: '#0d0a07',
    selectionBackground: sel,
    black: '#1a120c',
    red: '#e07560',
    green: '#a7c47a',
    yellow: full,
    blue: '#9bb8d8',
    magenta: '#c89bd8',
    cyan: '#8fc4c0',
    white: '#ffffff',
    brightBlack: '#5c4a32',
    brightRed: '#f08a73',
    brightGreen: '#bcd896',
    brightYellow: pale,
    brightBlue: '#b3ccea',
    brightMagenta: '#dbb2ea',
    brightCyan: '#a7d4d0',
    brightWhite: '#ffffff',
  };
}

/* OSC (operating-system command) sequences: ESC ] ... terminated by BEL or
   ST (ESC \). used for window titles etc. — drop them whole, including the
   terminator, which a plain stripper otherwise leaves dangling. */
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Reconstruct what a terminal would display from a raw PTY stream, as plain
    monochrome text, for read-only log views. Unlike a stripper this honors the
    sequences that move the cursor within a line — carriage returns, backspace,
    and erase-line — so progress bars (`Building [===> ]\r…`) collapse to their
    final line instead of stacking up with trailing whitespace. SGR colors and
    every other control sequence are discarded (xterm handles colors on the
    interactive surface; these views are intentionally plain). */
export function ansiToText(input: string): string {
  const lines = input.replace(OSC_RE, '').split('\n');
  return lines.map(reconstructLine).join('\n');
}

function reconstructLine(line: string): string {
  if (line.indexOf('\x1b') === -1 && line.indexOf('\r') === -1 && line.indexOf('\b') === -1) {
    // fast path: no in-line cursor motion, just drop stray control chars.
    // eslint-disable-next-line no-control-regex
    return line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  }
  const cells: string[] = [];
  let col = 0;
  const pad = (to: number) => { while (cells.length < to) cells.push(' '); };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\x1b' && line[i + 1] === '[') {
      // CSI: params [0-?] then intermediates [ -/] then a final byte [@-~].
      let j = i + 2;
      while (j < line.length && line[j] >= '0' && line[j] <= '?') j++;
      while (j < line.length && line[j] >= ' ' && line[j] <= '/') j++;
      const final = line[j];
      const params = line.slice(i + 2, j);
      if (final === 'K') {
        const mode = params === '' ? 0 : Number(params);
        if (mode === 0) cells.length = Math.min(cells.length, col); // erase to end of line
        else if (mode === 1) for (let k = 0; k < col && k < cells.length; k++) cells[k] = ' '; // erase to start
        else if (mode === 2) cells.length = 0; // erase whole line
      }
      // every other CSI (colors, cursor moves we don't model) is dropped.
      i = j; // skip to the final byte; the loop's i++ steps past it
      continue;
    }
    if (ch === '\r') { col = 0; continue; }
    if (ch === '\b') { if (col > 0) col -= 1; continue; }
    if (ch === '\t') {
      const next = (Math.floor(col / 8) + 1) * 8;
      pad(next);
      col = next;
      continue;
    }
    // drop remaining C0 controls and DEL; keep printable (incl. multibyte).
    if (ch < ' ' || ch === '\x7f') continue;
    pad(col);
    cells[col] = ch;
    col += 1;
  }
  return cells.join('').replace(/\s+$/, '');
}
