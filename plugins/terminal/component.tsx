import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { BuiltinPluginProps } from '../shared';
import { PanelHeader, perfPoint } from '../shared';
import { loadInterfaceSettings } from '../../src/settings/settingsStorage';

function buildTerminalTheme(accentHex: string): Record<string, string> {
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

const SHELL_COMMANDS_KEY = 'polypore.terminal.frequentCommands';
/* slash commands live in per-CLI buckets. claude has its own slash
   palette (/compact, /init, …); codex has overlapping but distinct
   commands. tracking separately keeps each agent's chip strip ranked by
   what the user actually uses with *that* agent. */
const SLASH_COMMANDS_KEY_PREFIX = 'polypore.terminal.frequentSlashCommands';
const AGENT_CLI_NAMES = new Set(['claude', 'codex']);
const SHELL_DEFAULT_QUICK_COMMANDS = ['git status', 'pwd', 'ls'];
const SLASH_DEFAULT_QUICK_COMMANDS = ['/clear', '/help'];
/* shells rarely have command lines longer than this; anything past it is
   almost certainly a paragraph someone pasted into an agent CLI which we
   shouldn't be capturing as a "frequent command" anyway. */
const MAX_REMEMBERED_COMMAND_LENGTH = 80;
const SLASH_COMMAND_RE = /^(\/[A-Za-z][\w\-:.]*)/;

function storageKeyFor(agent: string) {
  return agent ? `${SLASH_COMMANDS_KEY_PREFIX}.${agent}` : SHELL_COMMANDS_KEY;
}

function defaultsFor(agent: string) {
  return agent ? SLASH_DEFAULT_QUICK_COMMANDS : SHELL_DEFAULT_QUICK_COMMANDS;
}

/* pulls the leading /token out of arbitrary user input. used to filter
   what we record on agent-CLI terminals so prose typed at claude doesn't
   leak into the chip strip. returns null when the input isn't a slash
   command. */
function extractSlashCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.match(SLASH_COMMAND_RE);
  return match ? match[1] : null;
}

type FrequentCommand = {
  command: string;
  count: number;
  lastUsed: number;
};

type TerminalContextStats = {
  panelId: string;
  title: string;
  agent: string;
  inputChars: number;
  outputChars: number;
  transcriptChars: number;
  transcriptBytes: number;
  tokens: number;
  updatedAt: number;
  removed?: boolean;
};

function normalizeCommand(command: string) {
  return command.replace(/\s+/g, ' ').trim();
}

function terminalPayloadTextLength(value: string) {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .length;
}

function readFrequentCommands(key: string): FrequentCommand[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const rows = JSON.parse(raw) as FrequentCommand[];
    /* the shell bucket should never contain /slash entries — those belong
       to the agent CLI bucket. drop them on read so the shell chip strip
       stays clean even if older builds wrote them in. */
    const isShellBucket = key === SHELL_COMMANDS_KEY;
    return rows
      .filter((row) => row && typeof row.command === 'string' && Number.isFinite(row.count))
      .map((row) => ({
        command: normalizeCommand(row.command),
        count: Math.max(1, Math.floor(row.count)),
        lastUsed: Number.isFinite(row.lastUsed) ? row.lastUsed : 0,
      }))
      .filter((row) => row.command.length > 0 && row.command.length <= MAX_REMEMBERED_COMMAND_LENGTH)
      .filter((row) => (isShellBucket ? !row.command.startsWith('/') : row.command.startsWith('/')))
      .sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed || a.command.localeCompare(b.command))
      .slice(0, 20);
  } catch {
    return [];
  }
}

function writeFrequentCommands(key: string, rows: FrequentCommand[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(rows.slice(0, 20)));
  } catch {
    /* localStorage can be unavailable in restricted browser contexts. */
  }
}

/* one-time migration: older builds tracked everything (shell commands +
   slash commands + prose) into the shell bucket, and a brief earlier
   pass put slash commands into a single shared bucket. relift any
   /slash entries out of those legacy stores and into the per-agent
   buckets (we don't know which agent each was originally typed at, so
   seed both), then clean the shell bucket so the chip strip reflects
   the new model. */
const LEGACY_SHARED_SLASH_KEY = 'polypore.terminal.frequentSlashCommands';
const SLASH_AGENT_BUCKETS = ['claude', 'codex'] as const;
let migrationDone = false;

function mergeSlashEntries(target: FrequentCommand[], rows: FrequentCommand[]) {
  for (const row of rows) {
    if (!row || typeof row.command !== 'string') continue;
    const slash = extractSlashCommand(normalizeCommand(row.command));
    if (!slash) continue;
    const existing = target.find((entry) => entry.command === slash);
    const count = Math.max(1, Math.floor(Number.isFinite(row.count) ? row.count : 1));
    const lastUsed = Number.isFinite(row.lastUsed) ? row.lastUsed : 0;
    if (existing) {
      existing.count += count;
      existing.lastUsed = Math.max(existing.lastUsed, lastUsed);
    } else {
      target.push({ command: slash, count, lastUsed });
    }
  }
}

function migrateLegacyEntries() {
  if (migrationDone) return;
  migrationDone = true;
  try {
    const seed: FrequentCommand[] = [];
    let seedDirty = false;

    const shellRaw = window.localStorage.getItem(SHELL_COMMANDS_KEY);
    if (shellRaw) {
      const rows = JSON.parse(shellRaw);
      if (Array.isArray(rows)) {
        const slashFromShell = rows.filter(
          (row) => row && typeof row.command === 'string' && row.command.trim().startsWith('/'),
        );
        if (slashFromShell.length > 0) {
          mergeSlashEntries(seed, slashFromShell);
          const cleanedShell = rows.filter(
            (row) => row && typeof row.command === 'string' && !row.command.trim().startsWith('/'),
          );
          writeFrequentCommands(SHELL_COMMANDS_KEY, cleanedShell);
          seedDirty = true;
        }
      }
    }

    const sharedRaw = window.localStorage.getItem(LEGACY_SHARED_SLASH_KEY);
    if (sharedRaw) {
      const rows = JSON.parse(sharedRaw);
      if (Array.isArray(rows)) {
        mergeSlashEntries(seed, rows);
        seedDirty = true;
      }
      window.localStorage.removeItem(LEGACY_SHARED_SLASH_KEY);
    }

    if (!seedDirty || seed.length === 0) return;

    /* fan the legacy entries out to every per-agent bucket. we don't
       know which agent each was originally typed at, and most of the
       well-known slash commands work in both, so seeding both gives the
       user a useful baseline. */
    for (const agent of SLASH_AGENT_BUCKETS) {
      const key = storageKeyFor(agent);
      const existing = readFrequentCommands(key);
      const merged = [...existing];
      mergeSlashEntries(merged, seed);
      merged.sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed || a.command.localeCompare(b.command));
      writeFrequentCommands(key, merged);
    }
  } catch {
    /* localStorage / JSON failures are non-fatal — old entries just stay
       put and get filtered on every read instead. */
  }
}

function mergeQuickCommands(rows: FrequentCommand[], defaults: readonly string[]) {
  const ranked = rows.map((row) => row.command);
  for (const command of defaults) {
    if (!ranked.includes(command)) ranked.push(command);
  }
  return ranked.slice(0, 10);
}

/* a real terminal panel.

   the previous implementation rendered command output into a <pre> and
   read keystrokes from an <input>. that was fine for one-shot commands
   but failed on anything interactive — claude, vim, htop, ssh, less,
   even `git commit` without -m — because those programs assume:

     1. a real pty on the other end of stdio (for SIGWINCH, isatty, …),
     2. ansi/csi escape sequences honored by the renderer
        (cursor positioning, alt-screen, 256-color, true-color, …),
     3. immediate keystroke delivery, not enter-buffered line input.

   xterm.js implements the vt100/vt220/xterm/etc. emulator client-side.
   we connect it to a portable_pty-backed shell on the rust side
   (src-tauri/src/pty.rs) so byte streams flow:

     keypress -> xterm.onData -> host.terminal.write -> pty
     pty -> output event -> xterm.write -> rendered glyphs

   resize is the other key piece: when the panel changes size we fit
   xterm to the available cells, then tell the pty about the new
   cols/rows so the spawned program sees SIGWINCH and reflows. */

export function TerminalPanel({ host, header, context }: BuiltinPluginProps) {
  const initialCommand = typeof context?.initialCommand === 'string' ? context.initialCommand : '';
  const title = typeof context?.title === 'string' ? context.title : 'terminal';
  const perfSession = initialCommand || 'shell';
  const terminalLabel = title === 'terminal' ? 'bash terminal' : `${title} terminal`;
  const quickLaunchEnabled = context?.quickLaunch !== false;
  const fallbackToShellOnExit = context?.fallbackToShellOnExit === true;
  const panelInstanceId = typeof context?.panelInstanceId === 'string' ? context.panelInstanceId : '';
  const contextByChat = (context?.contextByChat as Record<string, string[]> | undefined) ?? undefined;
  const onRemoveContext = context?.onRemoveContext as ((label: string, targetId?: string) => void) | undefined;
  const [workspace, setWorkspace] = useState('polypore');
  const [status, setStatus] = useState('starting');
  /* on a plain shell terminal, the chip strip starts in shell mode and
     flips to claude/codex slash mode the moment the user invokes that
     CLI from the shell. on a chat panel (initialCommand set) the agent
     is fixed for the lifetime of the panel, so dynamicAgent stays unset. */
  const [dynamicAgent, setDynamicAgent] = useState<string>('');
  const effectiveAgent = initialCommand || dynamicAgent;
  const storageKey = storageKeyFor(effectiveAgent);
  const quickDefaults = defaultsFor(effectiveAgent);
  const [quickCommands, setQuickCommands] = useState<string[]>(() => mergeQuickCommands(readFrequentCommands(storageKey), quickDefaults));
  /* keep a ref to the latest effectiveAgent so callbacks captured by
     term.onData / event listeners (set up once in useEffect) always read
     the current mode rather than a stale render snapshot. */
  const effectiveAgentRef = useRef(effectiveAgent);
  useEffect(() => {
    effectiveAgentRef.current = effectiveAgent;
  }, [effectiveAgent]);
  /* keep refs so the term.onData handler (registered once on mount) reads
     the latest queued attachments and remove callback rather than the
     stale values captured at mount time. */
  const queuedItemsRef = useRef<string[]>([]);
  const onRemoveContextRef = useRef(onRemoveContext);
  useEffect(() => {
    queuedItemsRef.current = (panelInstanceId && contextByChat?.[panelInstanceId]) || [];
    onRemoveContextRef.current = onRemoveContext;
  }, [contextByChat, onRemoveContext, panelInstanceId]);
  const contextStatsFrameRef = useRef<number | null>(null);
  const inputCharsRef = useRef(0);
  const outputCharsRef = useRef(0);

  /* sample xterm's rendered buffer for transcript size. input/output counters
     are still useful telemetry, but transcript size must reflect what's
     actually on screen so deletions and clears decrement naturally. */
  const computeBufferChars = (): number => {
    const term = termRef.current;
    if (!term) return 0;
    const buffer = term.buffer.active;
    let total = 0;
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) total += line.translateToString(true).length;
    }
    return total;
  };

  const publishTerminalContextStats = () => {
    if (!panelInstanceId || contextStatsFrameRef.current !== null) return;
    contextStatsFrameRef.current = window.requestAnimationFrame(() => {
      contextStatsFrameRef.current = null;
      const transcriptChars = computeBufferChars();
      const stats: TerminalContextStats = {
        panelId: panelInstanceId,
        title,
        agent: effectiveAgentRef.current || initialCommand || '',
        inputChars: inputCharsRef.current,
        outputChars: outputCharsRef.current,
        transcriptChars,
        transcriptBytes: transcriptChars,
        tokens: Math.ceil(transcriptChars / 4),
        updatedAt: Date.now(),
      };
      const global = window as Window & {
        __polyporeTerminalContextStats?: Map<string, TerminalContextStats>;
      };
      const statsMap = global.__polyporeTerminalContextStats ?? new Map<string, TerminalContextStats>();
      global.__polyporeTerminalContextStats = statsMap;
      statsMap.set(panelInstanceId, stats);
      window.dispatchEvent(new CustomEvent('polypore:terminal-context-stats', { detail: stats }));
    });
  };

  const addTerminalInputContext = (data: string) => {
    const chars = terminalPayloadTextLength(data);
    if (chars <= 0) return;
    inputCharsRef.current += chars;
    /* only republish on Enter — typing alone shouldn't move the meter,
       since the draft isn't part of "what the agent has consumed" yet.
       agent output still publishes live (see addTerminalOutputContext). */
    if (!data.includes('\r') && !data.includes('\n')) return;
    publishTerminalContextStats();
  };

  const addTerminalOutputContext = (data: string) => {
    const chars = terminalPayloadTextLength(data);
    if (chars <= 0) return;
    outputCharsRef.current += chars;
    publishTerminalContextStats();
  };

  useEffect(() => {
    publishTerminalContextStats();
    return () => {
      if (contextStatsFrameRef.current !== null) window.cancelAnimationFrame(contextStatsFrameRef.current);
      contextStatsFrameRef.current = null;
      if (!panelInstanceId) return;
      const global = window as Window & {
        __polyporeTerminalContextStats?: Map<string, TerminalContextStats>;
      };
      global.__polyporeTerminalContextStats?.delete(panelInstanceId);
      window.dispatchEvent(new CustomEvent('polypore:terminal-context-stats', {
        detail: { panelId: panelInstanceId, removed: true },
      }));
    };
    /* panelInstanceId is the lifecycle key for this exported stat row. */
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [panelInstanceId]);

  /* when the active CLI changes (either because dynamicAgent flipped, or
     because focus jumped between agent panels), reload the chip strip
     from that agent's bucket. */
  useEffect(() => {
    migrateLegacyEntries();
    setQuickCommands(mergeQuickCommands(readFrequentCommands(storageKey), quickDefaults));
  }, [storageKey, quickDefaults]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const firstOutputMarkedRef = useRef(false);
  const commandBufferRef = useRef('');
  /* buffer keystrokes that arrive before the pty session id resolves so
     nothing is silently dropped on a slow spawn. */
  const pendingWritesRef = useRef<string[]>([]);
  /* tracks the "settling" period after spawn during which we collapse
     stray blank rows once the shell's startup output goes quiet. set
     to a deadline timestamp (ms) while active, null once settled. */
  const settlingDeadlineRef = useRef<number | null>(null);
  const settlingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    host.state.get('workspace').then((result) => {
      if (cancelled) return;
      if (typeof result.value === 'string') setWorkspace(result.value);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [host]);

  const rememberCommand = (rawCommand: string) => {
    const command = normalizeCommand(rawCommand);
    if (!command) return;
    /* on a plain shell terminal, flip the chip strip into agent mode the
       moment the user invokes `claude` / `codex`. flip back to shell
       mode when the user submits anything else that isn't a slash
       command (which means they're back at a $ prompt). */
    if (!initialCommand) {
      if (AGENT_CLI_NAMES.has(command)) {
        setDynamicAgent(command);
      } else if (!command.startsWith('/')) {
        setDynamicAgent('');
      }
    }
    const currentAgent = effectiveAgentRef.current;
    const key = storageKeyFor(currentAgent);
    const defaults = defaultsFor(currentAgent);
    /* on agent CLIs (claude, codex, …) we only care about the slash
       command — anything else is prose the user typed to the agent and
       shouldn't pollute the chip strip. on plain shells we cap length to
       drop accidental pastes and reject /slash entries (those belong to
       the agent's own bucket). */
    let toStore: string;
    if (currentAgent) {
      const slash = extractSlashCommand(command);
      if (!slash) return;
      toStore = slash;
    } else {
      if (command.length > MAX_REMEMBERED_COMMAND_LENGTH) return;
      if (command.startsWith('/')) return;
      toStore = command;
    }
    const current = readFrequentCommands(key);
    const existing = current.find((row) => row.command === toStore);
    const next = existing
      ? current.map((row) => row.command === toStore ? { ...row, count: row.count + 1, lastUsed: Date.now() } : row)
      : [{ command: toStore, count: 1, lastUsed: Date.now() }, ...current];
    next.sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed || a.command.localeCompare(b.command));
    writeFrequentCommands(key, next);
    setQuickCommands(mergeQuickCommands(next, defaults));
  };

  const trackTerminalInput = (data: string) => {
    if (!data) return;
    /* Ignore terminal control sequences such as arrows and function keys.
       We only need a best-effort command line for ranking quick launches. */
    if (data.includes('\x1b')) return;
    for (const char of data) {
      if (char === '\r' || char === '\n') {
        rememberCommand(commandBufferRef.current);
        commandBufferRef.current = '';
      } else if (char === '\x7f' || char === '\b') {
        commandBufferRef.current = commandBufferRef.current.slice(0, -1);
      } else if (char === '\x03' || char === '\x15') {
        commandBufferRef.current = '';
      } else if (char === '\x17') {
        commandBufferRef.current = commandBufferRef.current.replace(/\s*\S+\s*$/, '');
      } else if (char >= ' ') {
        commandBufferRef.current += char;
      }
    }
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    /* xterm needs real browser APIs (matchMedia, canvas, DPR…) that jsdom
       doesn't ship. tests render the workspace including this panel, so
       short-circuit when the env is jsdom — matches what the editor
       plugin does for monaco. */
    if (navigator.userAgent.toLowerCase().includes('jsdom')) return undefined;

    /* xterm construction is a synchronous spike: building the Terminal,
       loading addons, and term.open() each measure font metrics and
       create canvases on the main thread. on a cold boot this can stall
       paint for hundreds of ms — long enough to make the workspace
       loading animation stutter or, on the panel that auto-mounts as
       active, trigger the OS "window not responding" prompt.

       defer it one paint frame so the panel chrome + empty terminal
       container render and paint first; xterm initializes on the next
       frame. the rAF is the same scheduling trick the resize observer
       uses below, just applied to the setup path too. */
    let setupRafId: number | null = null;
    let spawnRafId: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let dataDisposable: { dispose: () => void } | null = null;
    let binaryDisposable: { dispose: () => void } | null = null;
    let cancelled = false;

    setupRafId = requestAnimationFrame(() => {
      setupRafId = null;
      if (cancelled) return;
      perfPoint(`terminal:setup-start:${perfSession}`);

      /* warm palette. the ansi indexes follow xterm convention so
         programs that emit `ESC[31m` etc. land on warm tones rather than
         clashing primary reds/blues. */
      const term = new Terminal({
        fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', 'SFMono-Regular', 'Cascadia Code', Consolas, monospace",
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        cursorStyle: 'block',
        allowProposedApi: true,
        scrollback: 5000,
        convertEol: false,
        macOptionIsMeta: true,
        theme: buildTerminalTheme(loadInterfaceSettings().accent),
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      term.open(container);
      perfPoint(`terminal:xterm-open-done:${perfSession}`);
      termRef.current = term;
      fitRef.current = fitAddon;

      /* xterm's first measurement reads font metrics that may not be ready
         until layout settles in the next animation frame. without the rAF
         the initial fit() rounds down to fewer cols/rows and the spawn
         size doesn't match what the user sees. */
      let spawned = false;
      const initialSpawn = () => {
        spawnRafId = null;
        if (cancelled || spawned) return;
        spawned = true;
        try {
          fitAddon.fit();
        } catch {
          /* fit can throw if the container is 0×0 during transition — the
             ResizeObserver below will retry once layout settles. */
        }
        const cols = term.cols;
        const rows = term.rows;
        firstOutputMarkedRef.current = false;
        perfPoint(`terminal:pty-spawn-call:${perfSession}`);
        host.terminal.spawn(initialCommand, { cols, rows }).then((result) => {
          perfPoint(`terminal:pty-spawn-resolved:${perfSession}`);
          sessionIdRef.current = result.session.id;
          setStatus(result.session.status);
          if (result.session.output) {
            addTerminalOutputContext(result.session.output);
            term.write(result.session.output);
          }
          /* flush anything the user typed during the spawn round-trip. */
          for (const pending of pendingWritesRef.current) {
            host.terminal.write(result.session.id, pending).catch(() => {});
          }
          pendingWritesRef.current = [];
          /* a fresh terminal usually shows the prompt several rows down
             because the shell's rc files / MOTD / starship add_newline
             emit blank lines into the buffer before the prompt arrives.
             those rows linger until real output scrolls them off, which
             is why a filled terminal looks tight at the top but a fresh
             one looks loose.

             xterm.js's term.clear() collapses the buffer so the cursor's
             current row becomes the new first row. but we can't just call
             it at a fixed delay: slow shells (nvm, oh-my-zsh, zinit,
             plugin managers) keep printing well past any reasonable
             timeout, and clearing too early either does nothing (output
             hasn't arrived) or collapses partway through, leaving
             later-printed blank rows above the final prompt.

             instead we open a "settling" window for up to 4s after
             spawn. each output event during settling resets a 250ms
             debounce; when output goes quiet for that long, we assume
             the shell has reached its prompt and call clear() once.
             that's robust against any startup speed.

             only applies to plain-shell spawns. agent CLIs (claude,
             codex, …) paint a TUI on startup and then go idle waiting
             for input — exactly the "output went quiet" signal the
             debounce uses — so running clear() against them wipes
             their UI off the screen. */
          if (!initialCommand) settlingDeadlineRef.current = Date.now() + 4000;
        }).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          const output = `\r\n\x1b[31mterminal failed:\x1b[0m ${msg}\r\n`;
          addTerminalOutputContext(output);
          term.write(output);
          setStatus('failed');
        });
      };
      spawnRafId = requestAnimationFrame(initialSpawn);

      /* keystrokes (including control sequences like ctrl+c, arrows, esc)
         flow to the pty exactly as xterm emits them. xterm has already
         translated key events into the right vt sequences. */
      dataDisposable = term.onData((data) => {
        addTerminalInputContext(data);
        trackTerminalInput(data);
        const id = sessionIdRef.current;
        if (id === null) {
          pendingWritesRef.current.push(data);
          return;
        }
        /* attach queued files on Enter: jump to start of line (^A), type
           '@path1 @path2 ', jump back (^E), then forward the original Enter.
           assumes readline-style line editing (works for codex/claude/bash). */
        if (data === '\r' && queuedItemsRef.current.length > 0 && panelInstanceId) {
          const paths = queuedItemsRef.current.map((item) => item.replace(/^included:\s*/, ''));
          const prefix = paths.map((p) => '@' + p).join(' ') + ' ';
          host.terminal.write(id, '\x01' + prefix + '\x05' + data).catch(() => {});
          const removeQueued = onRemoveContextRef.current;
          if (removeQueued) {
            queuedItemsRef.current.forEach((item) => removeQueued(item, panelInstanceId));
          }
          return;
        }
        host.terminal.write(id, data).catch(() => {});
      });

      /* binary data (e.g. paste of non-utf8 bytes) goes through onBinary
         so we don't drop anything on the floor. */
      binaryDisposable = term.onBinary((data) => {
        addTerminalInputContext(data);
        const id = sessionIdRef.current;
        if (id === null) return;
        host.terminal.write(id, data).catch(() => {});
      });

      /* track size locally so we only call resize when the cell grid
         actually changes — otherwise every panel paint would round-trip
         to the pty unnecessarily. */
      let lastCols = term.cols;
      let lastRows = term.rows;
      const propagateSize = () => {
        try {
          fitAddon.fit();
        } catch {
          return;
        }
        if (term.cols === lastCols && term.rows === lastRows) return;
        lastCols = term.cols;
        lastRows = term.rows;
        const id = sessionIdRef.current;
        if (id === null) return;
        host.terminal.resize(id, term.cols, term.rows).catch(() => {});
      };

      resizeObserver = new ResizeObserver(() => {
        /* skip per-frame fit during sash drags — fitAddon.fit() is
           expensive in JavaScriptCore; let it snap once on release instead. */
        if (document.body.dataset.dvResizing) return;
        requestAnimationFrame(propagateSize);
      });
      resizeObserver.observe(container);
    });

    return () => {
      cancelled = true;
      if (setupRafId !== null) cancelAnimationFrame(setupRafId);
      if (spawnRafId !== null) cancelAnimationFrame(spawnRafId);
      resizeObserver?.disconnect();
      dataDisposable?.dispose();
      binaryDisposable?.dispose();
      if (settlingDebounceRef.current) {
        clearTimeout(settlingDebounceRef.current);
        settlingDebounceRef.current = null;
      }
      settlingDeadlineRef.current = null;
      const id = sessionIdRef.current;
      if (id !== null) host.terminal.stop(id).catch(() => {});
      sessionIdRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [host, initialCommand, perfSession]);

  const attachSession = (result: { session: { id: string; status: string; output: string } }) => {
    sessionIdRef.current = result.session.id;
    setStatus(result.session.status);
    if (result.session.output) {
      addTerminalOutputContext(result.session.output);
      termRef.current?.write(result.session.output);
    }
    for (const pending of pendingWritesRef.current) {
      host.terminal.write(result.session.id, pending).catch(() => {});
    }
    pendingWritesRef.current = [];
    settlingDeadlineRef.current = Date.now() + 4000;
  };

  /* pty event stream → xterm. each output chunk is raw bytes (well,
     utf-8 decoded for transport) including ansi escape sequences, which
     xterm interprets to drive its cell grid. */
  useEffect(() => host.terminal.onEvent((event) => {
    const id = sessionIdRef.current;
    if (id === null || event.id !== id) return;
    if (event.kind === 'output' && event.data) {
      addTerminalOutputContext(event.data);
      if (!firstOutputMarkedRef.current) {
        firstOutputMarkedRef.current = true;
        perfPoint(`terminal:first-output:${perfSession}`);
      }
      const term = termRef.current;
      term?.write(event.data, () => {
        /* run inside xterm's write callback so the chunk has actually
           been parsed into the grid before we (potentially) collapse
           it. resetting the debounce here means any further output
           pushes the collapse back; quiet output for the debounce
           window lets us assume the shell reached its prompt. */
        const deadline = settlingDeadlineRef.current;
        if (deadline === null || !term) return;
        if (settlingDebounceRef.current) clearTimeout(settlingDebounceRef.current);
        if (Date.now() > deadline) {
          settlingDeadlineRef.current = null;
          settlingDebounceRef.current = null;
          term.clear();
          return;
        }
        settlingDebounceRef.current = setTimeout(() => {
          settlingDeadlineRef.current = null;
          settlingDebounceRef.current = null;
          term.clear();
        }, 250);
      });
    }
    if (event.kind === 'exited') {
      setStatus(event.exitCode === 0 || event.exitCode == null ? 'exited' : `exited ${event.exitCode}`);
      termRef.current?.write(`\r\n\x1b[2m[process exited${event.exitCode != null ? ` with code ${event.exitCode}` : ''}]\x1b[0m\r\n`);
      sessionIdRef.current = null;
      if (fallbackToShellOnExit && event.command === initialCommand) {
        const term = termRef.current;
        setStatus('shell');
        term?.write('\x1b[2m[agent cli exited; starting shell]\x1b[0m\r\n');
        host.terminal.spawn('', term ? { cols: term.cols, rows: term.rows } : undefined)
          .then(attachSession).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          term?.write(`\r\n\x1b[31mshell fallback failed:\x1b[0m ${msg}\r\n`);
          setStatus('failed');
        });
      }
    }
  }), [fallbackToShellOnExit, host, initialCommand, perfSession]);

  const sendCommand = (text: string) => {
    const id = sessionIdRef.current;
    if (id === null) return;
    rememberCommand(text);
    /* paste the command into the running shell and press enter, just
       like a tab-completion or autosuggestion would. */
    host.terminal.write(id, `${text}\r`).catch(() => {});
    termRef.current?.focus();
  };

  useEffect(() => {
    if (!panelInstanceId) return undefined;
    const global = window as Window & { __polyporeTerminalPanels?: Set<string> };
    const panels = global.__polyporeTerminalPanels ?? new Set<string>();
    global.__polyporeTerminalPanels = panels;
    panels.add(panelInstanceId);
    return () => {
      panels.delete(panelInstanceId);
    };
  }, [panelInstanceId]);

  useEffect(() => {
    const onTerminalSend = (event: Event) => {
      const detail = (event as CustomEvent<{
        panelId?: string;
        text?: string;
        submit?: boolean;
      }>).detail;
      if (!detail || detail.panelId !== panelInstanceId || typeof detail.text !== 'string') return;
      const payload = detail.submit === false
        ? detail.text
        : `\x1b[200~${detail.text}\x1b[201~\r`;
      const id = sessionIdRef.current;
      if (id === null) {
        pendingWritesRef.current.push(payload);
        return;
      }
      rememberCommand(detail.text);
      host.terminal.write(id, payload).catch(() => {});
      termRef.current?.focus();
    };
    window.addEventListener('polypore:terminal-send', onTerminalSend);
    return () => window.removeEventListener('polypore:terminal-send', onTerminalSend);
  }, [host, panelInstanceId]);

  return (
    <div className="terminal-shell">
      <PanelHeader {...header}>
        <span className="panel-header__title">{title}</span>
        <span className="panel-header__sep" aria-hidden="true" />
        <span className="panel-header__meta">{status}</span>
        <span className="panel-header__meta">~/{workspace === 'polypore' ? 'polypore' : workspace}</span>
      </PanelHeader>
      {quickLaunchEnabled && (
        <div className="terminal-quicklaunch" aria-label="quick launch">
          {quickCommands.map((cmd) => (
            <button
              key={cmd}
              className="terminal-quicklaunch__chip"
              onClick={() => sendCommand(cmd)}
              title={`run: ${cmd}`}
            >
              {cmd}
            </button>
          ))}
        </div>
      )}
      <section className="terminal" aria-label={terminalLabel} onClick={() => termRef.current?.focus()}>
        <div className="terminal__surface">
          <div ref={containerRef} className="terminal__xterm" />
        </div>
      </section>
    </div>
  );
}
