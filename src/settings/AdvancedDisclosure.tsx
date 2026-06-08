import { useState, type ReactNode } from 'react';

export interface AdvancedDisclosureProps {
  /** short label for what's hidden, e.g. "install by id" */
  summary: string;
  children: ReactNode;
}

/* The per-section layering primitive: the friendly controls sit above; the raw
 * escape-hatch lives behind this. Collapsed by default so most users never see
 * it, one click away for the power-user who wants it. */
export function AdvancedDisclosure({ summary, children }: AdvancedDisclosureProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="advanced-disclosure" data-open={open || undefined}>
      <button
        type="button"
        className="advanced-disclosure__toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="advanced-disclosure__chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        advanced · {summary}
      </button>
      {open && <div className="advanced-disclosure__body">{children}</div>}
    </div>
  );
}
