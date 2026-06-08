import React, { useCallback, useEffect, useRef } from 'react';

/* PanelSheet — the one overlay primitive for the agent panel.

   The agent panel is cramped, so every popup fills the panel as a sheet
   rather than floating as a tiny anchored card (which clipped, stacked on
   top of other text, and — when rendered inside the formation canvas —
   bled wheel events straight into zoom). Consumers render this at the
   `.agent-shell` level so the backdrop covers exactly the panel; the shell
   is `position: relative`, so `inset: 0` fills it.

   It owns everything that used to be re-implemented per popup: backdrop,
   Escape + outside-click dismissal, focus trap + focus-return, and
   wheel/pointer isolation from the canvas underneath. The interface is
   four props; the behavior is deep. */
export type PanelSheetProps = {
  open: boolean;
  onDismiss: () => void;
  /* accessible name for the dialog */
  label: string;
  /* rendered in the sheet header, beside the close button */
  title?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function PanelSheet({ open, onDismiss, label, title, className = '', children }: PanelSheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const focusables = useCallback(
    () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    [],
  );

  /* move focus into the sheet on open; return it to whatever was focused
     before (the trigger) on close. prefer the first control in the body
     (the real content — e.g. a search field) over the header close button. */
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = (document.activeElement as HTMLElement) ?? null;
    const first =
      bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? focusables()[0] ?? panelRef.current;
    first?.focus();
    return () => {
      restoreFocusRef.current?.focus?.();
    };
  }, [open, focusables]);

  /* Escape dismisses; Tab cycles within the sheet so focus can't escape to
     the panel behind it. Listening at the document level keeps this robust
     regardless of where focus currently sits. */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onDismiss();
        return;
      }
      if (event.key === 'Tab') {
        const items = focusables();
        if (items.length === 0) {
          event.preventDefault();
          panelRef.current?.focus();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (event.shiftKey && (active === first || !panelRef.current?.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onDismiss, focusables]);

  if (!open) return null;

  return (
    <div
      className="panel-sheet"
      data-testid="panel-sheet-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <div
        ref={panelRef}
        className={`panel-sheet__panel ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        /* isolate the sheet from the canvas/panel underneath: clicks, drags
           and wheel scrolling stay inside and never pan/zoom the formation. */
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <header className="panel-sheet__head">
          <div className="panel-sheet__title">{title}</div>
          <button
            type="button"
            className="panel-sheet__close"
            aria-label="close"
            onClick={onDismiss}
          >
            ×
          </button>
        </header>
        <div className="panel-sheet__body" ref={bodyRef}>{children}</div>
      </div>
    </div>
  );
}
