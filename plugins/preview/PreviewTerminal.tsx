import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { PolyporeHost } from '../../packages/sdk/src/host';
import { buildTerminalTheme } from '../shared';
import { loadInterfaceSettings } from '../../src/settings/settingsStorage';

/* the preview's interactive run surface, rendered through xterm.js — the same
   engine the Terminal panel uses — so build/dev/test output looks exactly like
   a terminal: colors, in-place progress bars, cursor motion, TUIs, and live
   keyboard input. the session is owned by the parent (it spawns the command and
   tracks the id for URL detection / exit handling); this component only attaches
   a terminal view to it. keyed by sessionId upstream so a new run remounts. */
export function PreviewTerminal({ host, sessionId }: { host: PolyporeHost; sessionId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !sessionId) return undefined;
    /* xterm needs real browser APIs (canvas, DPR, matchMedia) jsdom lacks;
       short-circuit under tests, matching the Terminal panel. */
    if (navigator.userAgent.toLowerCase().includes('jsdom')) return undefined;

    let disposed = false;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let disposeData: { dispose: () => void } | null = null;
    let disposeEvents: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeSettle: number | null = null;

    /* defer one frame so the empty container paints first; xterm.open() is a
       synchronous spike (font metrics + canvas) that would otherwise stall the
       first paint of the panel. */
    const raf = requestAnimationFrame(() => {
      if (disposed) return;
      term = new Terminal({
        fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', 'SFMono-Regular', 'Cascadia Code', Consolas, monospace",
        fontSize: 12,
        lineHeight: 1.2,
        cursorBlink: true,
        cursorStyle: 'block',
        allowProposedApi: true,
        scrollback: 5000,
        convertEol: false,
        theme: buildTerminalTheme(loadInterfaceSettings().accent),
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(container);
      try { fit.fit(); } catch { /* container may be 0×0 mid-transition; observer retries */ }

      /* replay whatever the session printed before this mounted, then match the
         pty to the rendered size. */
      host.terminal.read(sessionId).then((res) => {
        if (disposed || !term) return;
        if (res?.output) term.write(res.output);
      }).catch(() => {});
      host.terminal.resize(sessionId, term.cols, term.rows).catch(() => {});

      /* live stream in, keystrokes out. the global terminal:event stream is the
         one channel that carries output in BOTH the Tauri shell (pty-event
         bridge) and the web in-process host, so filter it by session id rather
         than using the per-session topic, which the Tauri shell never emits. */
      disposeEvents = host.terminal.onEvent((event) => {
        if (disposed || event.id !== sessionId) return;
        if (event.kind === 'output' && event.data) term?.write(event.data);
      });
      disposeData = term.onData((data) => {
        host.terminal.write(sessionId, data).catch(() => {});
      });

      resizeObserver = new ResizeObserver(() => {
        if (resizeSettle) window.clearTimeout(resizeSettle);
        resizeSettle = window.setTimeout(() => {
          if (disposed || !term || !fit) return;
          try { fit.fit(); } catch { /* ignore transient 0×0 */ }
          host.terminal.resize(sessionId, term.cols, term.rows).catch(() => {});
        }, 80);
      });
      resizeObserver.observe(container);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (resizeSettle) window.clearTimeout(resizeSettle);
      resizeObserver?.disconnect();
      disposeEvents?.();
      disposeData?.dispose();
      term?.dispose();
    };
  }, [host, sessionId]);

  return (
    <div
      ref={containerRef}
      className="preview-terminal-frame"
      aria-label="interactive preview terminal"
    />
  );
}
