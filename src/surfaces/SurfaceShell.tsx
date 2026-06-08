import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './surface.css';

export interface SurfaceShellProps {
  /** aria-label for the dialog */
  label: string;
  /** brand title in the top bar (e.g. "settings", "manual") */
  title: ReactNode;
  /** breadcrumb / context line under the title */
  subtitle?: ReactNode;
  /** optional action(s) rendered just left of the close button */
  trailing?: ReactNode;
  /** aria-label for the close button (e.g. "close settings") */
  closeLabel: string;
  /** left-rail contents */
  nav: ReactNode;
  /** aria-label for the nav landmark (e.g. "settings sections") */
  navLabel: string;
  /** the scrolling content region — a <section>/<article> element */
  children: ReactNode;
  onClose: () => void;
}

/**
 * The full-screen warm-dark-glass takeover shell shared by Settings and the
 * Manual. Owns the portal, the top bar, the [nav | content] body grid, and the
 * Escape-to-close handler. Each surface supplies its own nav + content; the
 * chrome, type scale, and state-first primitives live in surface.css so the two
 * surfaces read as one product.
 */
export function SurfaceShell({
  label,
  title,
  subtitle,
  trailing,
  closeLabel,
  nav,
  navLabel,
  children,
  onClose,
}: SurfaceShellProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="surface" role="dialog" aria-label={label} aria-modal="true">
      <header className="surface__bar">
        <div className="surface__title">
          <strong>{title}</strong>
          {subtitle != null && subtitle !== '' && <span>{subtitle}</span>}
        </div>
        <div className="surface__bar-actions">
          {trailing}
          <button type="button" className="surface__close" aria-label={closeLabel} onClick={onClose}>
            esc
          </button>
        </div>
      </header>

      <div className="surface__body">
        <nav className="surface__nav" aria-label={navLabel}>{nav}</nav>
        {children}
      </div>
    </div>,
    document.body,
  );
}
