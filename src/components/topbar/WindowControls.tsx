import { useCallback, useEffect, useState } from 'react';
import type { AppWindowControls } from './platform';

/* Caption buttons for the borderless Windows/Linux window. The middle button's
   glyph flips to a "restore" pair while the window is maximized; we re-query the
   real state on every OS resize rather than trusting our own toggle, so an
   OS-driven maximize (Win+Up, snap, double-clicking the drag region) stays in
   sync with the glyph. Tauri calls reject if the window is gone mid-action —
   swallow those, there is nothing to recover. */
export function WindowControls({ appWindow }: { appWindow: AppWindowControls }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      appWindow
        .isMaximized()
        .then((value) => {
          if (!cancelled) setMaximized(value);
        })
        .catch(() => {});
    };
    sync();
    window.addEventListener('resize', sync);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', sync);
    };
  }, [appWindow]);

  const minimize = useCallback(() => {
    appWindow.minimize().catch(() => {});
  }, [appWindow]);
  const toggleMaximize = useCallback(() => {
    appWindow.toggleMaximize().catch(() => {});
  }, [appWindow]);
  const close = useCallback(() => {
    appWindow.close().catch(() => {});
  }, [appWindow]);

  return (
    <div className="window-controls" role="group" aria-label="window controls">
      <button
        type="button"
        className="window-control"
        aria-label="minimize"
        title="minimize"
        onClick={minimize}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
          <path d="M1 5h8" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        type="button"
        className="window-control"
        aria-label={maximized ? 'restore' : 'maximize'}
        title={maximized ? 'restore' : 'maximize'}
        onClick={toggleMaximize}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1">
            <path d="M2.5 3.5V1.5h6v6h-2" />
            <rect x="1.5" y="3.5" width="5" height="5" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="1.5" y="1.5" width="7" height="7" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="window-control window-control--close"
        aria-label="close"
        title="close"
        onClick={close}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false" stroke="currentColor" strokeWidth="1">
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
        </svg>
      </button>
    </div>
  );
}
