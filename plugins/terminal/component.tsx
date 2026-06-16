import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { BuiltinPluginProps } from '../shared';
import { buildTerminalTheme, PanelHeader, perfPoint } from '../shared';
import { loadInterfaceSettings } from '../../src/settings/settingsStorage';
import { onTerminalSend, registerTerminalPanel, unregisterTerminalPanel } from '../../src/core/polypore-window';

/* quick-launch chips are a user-curated favorites list — the strip never
   records what gets typed into the terminal. an earlier build ranked chips
   by capturing submitted command lines, which also captured input typed at
   no-echo prompts (passwords) and half-finished lines; those stores are
   purged on load (see purgeCapturedCommandHistory) and nothing like them
   is written anymore. */
const FAVORITES_SHELL_KEY = 'polypore.terminal.favoriteCommands';
const FAVORITES_SLASH_KEY_PREFIX = 'polypore.terminal.favoriteSlashCommands';
const AGENT_CLI_NAMES = new Set(['claude', 'codex']);
const SHELL_DEFAULT_QUICK_COMMANDS = ['git status', 'pwd', 'ls'];
const SLASH_DEFAULT_QUICK_COMMANDS = ['/clear', '/help'];
const MAX_QUICK_COMMANDS = 12;
const MAX_QUICK_COMMAND_LENGTH = 120;

function storageKeyFor(agent: string) {
  return agent ? `${FAVORITES_SLASH_KEY_PREFIX}.${agent}` : FAVORITES_SHELL_KEY;
}

function defaultsFor(agent: string) {
  return agent ? SLASH_DEFAULT_QUICK_COMMANDS : SHELL_DEFAULT_QUICK_COMMANDS;
}

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

function readFavoriteCommands(key: string, defaults: readonly string[]): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    /* absent key → the user never customized this context; show defaults.
       an explicit empty array means they removed everything — respect it. */
    if (raw === null) return [...defaults];
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) return [...defaults];
    return rows
      .filter((row): row is string => typeof row === 'string')
      .map((row) => normalizeCommand(row))
      .filter((row, index, all) => row.length > 0 && row.length <= MAX_QUICK_COMMAND_LENGTH && all.indexOf(row) === index)
      .slice(0, MAX_QUICK_COMMANDS);
  } catch {
    return [...defaults];
  }
}

function writeFavoriteCommands(key: string, rows: string[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(rows.slice(0, MAX_QUICK_COMMANDS)));
  } catch {
    /* localStorage can be unavailable in restricted browser contexts. */
  }
}

/* one-time cleanup: older builds captured submitted command lines (with
   their count/lastUsed ranking) into these keys. that capture path also
   recorded input typed at no-echo prompts — i.e. passwords — so the
   stores are deleted outright rather than migrated. */
const LEGACY_CAPTURED_KEYS = [
  'polypore.terminal.frequentCommands',
  'polypore.terminal.frequentSlashCommands',
  'polypore.terminal.frequentSlashCommands.claude',
  'polypore.terminal.frequentSlashCommands.codex',
];
let purgeDone = false;

function purgeCapturedCommandHistory() {
  if (purgeDone) return;
  purgeDone = true;
  try {
    for (const key of LEGACY_CAPTURED_KEYS) window.localStorage.removeItem(key);
    /* also catch per-agent buckets for agents beyond claude/codex */
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith('polypore.terminal.frequentSlashCommands.')) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    /* localStorage can be unavailable in restricted browser contexts. */
  }
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
  const [quickCommands, setQuickCommands] = useState<string[]>(() => {
    purgeCapturedCommandHistory();
    return readFavoriteCommands(storageKey, quickDefaults);
  });
  const [editingQuick, setEditingQuick] = useState(false);
  const [quickDraft, setQuickDraft] = useState('');
  const quickEditButtonRef = useRef<HTMLButtonElement | null>(null);
  const quickEditorRef = useRef<HTMLDivElement | null>(null);
  /* the chip strip swaps between the shell list and the per-agent slash
     list when the user enters/leaves an agent CLI — re-read on swap. */
  useEffect(() => {
    setQuickCommands(readFavoriteCommands(storageKey, defaultsFor(effectiveAgent)));
  }, [storageKey, effectiveAgent]);
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

  /* on a plain shell terminal, flip the chip strip into agent mode the
     moment the user invokes `claude` / `codex`, and back to shell mode
     when they submit anything else at a $ prompt. the submitted line is
     compared against the known CLI names and then dropped — nothing the
     user types is recorded or displayed (an earlier build persisted these
     lines for chip ranking, which also captured passwords typed at
     no-echo prompts). */
  const noteSubmittedCommand = (rawCommand: string) => {
    if (initialCommand) return;
    const command = normalizeCommand(rawCommand);
    if (!command) return;
    if (AGENT_CLI_NAMES.has(command)) {
      setDynamicAgent(command);
    } else if (!command.startsWith('/')) {
      setDynamicAgent('');
    }
  };

  const trackTerminalInput = (data: string) => {
    if (!data) return;
    /* Ignore terminal control sequences such as arrows and function keys.
       The reconstructed line exists only in memory, only to detect agent
       CLI entry/exit for the chip-strip mode flip. */
    if (data.includes('\x1b')) return;
    for (const char of data) {
      if (char === '\r' || char === '\n') {
        noteSubmittedCommand(commandBufferRef.current);
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

  const addQuickCommand = () => {
    const command = normalizeCommand(quickDraft);
    if (!command || command.length > MAX_QUICK_COMMAND_LENGTH) return;
    setQuickDraft('');
    setQuickCommands((current) => {
      if (current.includes(command)) return current;
      const next = [...current, command].slice(0, MAX_QUICK_COMMANDS);
      writeFavoriteCommands(storageKey, next);
      return next;
    });
  };

  const removeQuickCommand = (command: string) => {
    setQuickCommands((current) => {
      const next = current.filter((row) => row !== command);
      writeFavoriteCommands(storageKey, next);
      return next;
    });
  };

  const resetQuickCommands = () => {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      /* restricted browser contexts */
    }
    setQuickCommands([...quickDefaults]);
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
    let resizeSettleTimer: number | null = null;
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

      /* terminal copy/paste. plain ctrl+c can't copy here — it has to stay
         SIGINT for the running program (claude, codex, a shell, …) — so we
         use the linux-terminal convention: ctrl+shift+c copies the current
         selection, ctrl+shift+v pastes. returning false tells xterm to
         swallow the key so the sequence never reaches the pty. anything
         else (including a bare ctrl+c with no shift) flows through. */
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true;
        const key = event.key.toLowerCase();
        if (key === 'c') {
          const selection = term.getSelection();
          if (selection) navigator.clipboard?.writeText(selection).catch(() => {});
          return false;
        }
        if (key === 'v') {
          /* route through term.paste so xterm applies bracketed-paste
             wrapping when the program enabled it; the resulting onData
             event forwards to the pty like any other input. */
          navigator.clipboard?.readText().then((text) => {
            if (text) term.paste(text);
          }).catch(() => {});
          return false;
        }
        return true;
      });

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
           expensive in JavaScriptCore. but the container reaches its final
           size *during* the drag, so no observer event fires after release;
           without a trailing fit the grid never contracts to a smaller pane
           and the walls just clip it. debounce a single fit that lands once
           drag movement settles (it resets on every drag step, so at most one
           fit per pause/release rather than one per frame). */
        if (document.body.dataset.dvResizing) {
          if (resizeSettleTimer !== null) clearTimeout(resizeSettleTimer);
          resizeSettleTimer = window.setTimeout(() => {
            resizeSettleTimer = null;
            requestAnimationFrame(propagateSize);
          }, 120);
          return;
        }
        requestAnimationFrame(propagateSize);
      });
      resizeObserver.observe(container);
    });

    return () => {
      cancelled = true;
      if (setupRafId !== null) cancelAnimationFrame(setupRafId);
      if (spawnRafId !== null) cancelAnimationFrame(spawnRafId);
      if (resizeSettleTimer !== null) clearTimeout(resizeSettleTimer);
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
    noteSubmittedCommand(text);
    /* paste the command into the running shell and press enter, just
       like a tab-completion or autosuggestion would. */
    host.terminal.write(id, `${text}\r`).catch(() => {});
    termRef.current?.focus();
  };

  useEffect(() => {
    if (!panelInstanceId) return undefined;
    registerTerminalPanel(panelInstanceId);
    return () => {
      unregisterTerminalPanel(panelInstanceId);
    };
  }, [panelInstanceId]);

  useEffect(() => onTerminalSend((detail) => {
    if (detail.panelId !== panelInstanceId || typeof detail.text !== 'string') return;
    const payload = detail.submit === false
      ? detail.text
      : `\x1b[200~${detail.text}\x1b[201~\r`;
    const id = sessionIdRef.current;
    if (id === null) {
      pendingWritesRef.current.push(payload);
      return;
    }
    host.terminal.write(id, payload).catch(() => {});
    termRef.current?.focus();
  }), [host, panelInstanceId]);

  /* close the quick-command editor on outside pointerdown; focus its input
     on open so it's immediately typeable. */
  useEffect(() => {
    if (!editingQuick) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (quickEditorRef.current?.contains(target)) return;
      if (quickEditButtonRef.current?.contains(target)) return;
      setEditingQuick(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    quickEditorRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [editingQuick]);

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
          <button
            type="button"
            ref={quickEditButtonRef}
            className="terminal-quicklaunch__edit"
            aria-label="edit quick commands"
            aria-expanded={editingQuick}
            aria-haspopup="dialog"
            title="edit quick commands"
            onClick={() => setEditingQuick((open) => !open)}
          >
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          {editingQuick && (
            <div
              className="terminal-quicklaunch__editor"
              ref={quickEditorRef}
              role="dialog"
              aria-label="quick commands"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditingQuick(false);
                  quickEditButtonRef.current?.focus();
                }
              }}
            >
              <header>
                <strong>quick commands</strong>
                <span>{effectiveAgent ? `${effectiveAgent} chat` : 'shell'}</span>
              </header>
              <div className="terminal-quicklaunch__editor-rows">
                {quickCommands.length === 0 && <em>no quick commands — add one below</em>}
                {quickCommands.map((cmd) => (
                  <div key={cmd} className="terminal-quicklaunch__editor-row">
                    <code>{cmd}</code>
                    <button
                      type="button"
                      aria-label={`remove ${cmd}`}
                      onClick={() => removeQuickCommand(cmd)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <form
                className="terminal-quicklaunch__editor-add"
                onSubmit={(event) => {
                  event.preventDefault();
                  addQuickCommand();
                }}
              >
                <input
                  value={quickDraft}
                  onChange={(event) => setQuickDraft(event.target.value)}
                  placeholder={effectiveAgent ? '/command' : 'command'}
                  aria-label="new quick command"
                  maxLength={MAX_QUICK_COMMAND_LENGTH}
                />
                <button type="submit" disabled={!quickDraft.trim()}>add</button>
              </form>
              <footer>
                <button type="button" onClick={resetQuickCommands}>reset to defaults</button>
              </footer>
            </div>
          )}
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
