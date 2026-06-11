import { useEffect, useRef, useState } from 'react';
import type { ConfirmDecision, ConfirmRequest } from '../../../packages/host/src';
import type { PanelManifest } from '../../../packages/sdk/src';

export interface HostConfirmOverlayProps {
  request: ConfirmRequest;
  onCancel: () => void;
  onConfirm: (decision: ConfirmDecision) => void;
}

type ConfirmDetails = {
  manifest?: PanelManifest;
  source?: { commit?: string; url?: string; ref?: string };
  id?: string;
  scope?: string;
  totalSizeBytes?: number;
  files?: Array<{ path: string; sizeBytes?: number }>;
  /* names the affirmative action ("delete folder") so destructive confirms
     don't fall back to a generic "accept". */
  confirmLabel?: string;
};

export function HostConfirmOverlay({ request, onCancel, onConfirm }: HostConfirmOverlayProps) {
  const details = request.details as ConfirmDetails | undefined;
  const manifest = details?.manifest;
  const permissions = manifest?.permissions ?? [];
  const [scope, setScope] = useState<'project' | 'user'>(details?.scope === 'user' ? 'user' : 'project');
  const isPluginInstall = request.kind === 'plugin-install';
  const isSecretReveal = request.kind === 'secret-reveal';
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const declineRef = useRef<HTMLButtonElement | null>(null);

  /* a consent dialog must own the keyboard: an Enter intended for the
     editor cannot be allowed to land on "accept", and Tab must not walk the
     obscured workspace. focus starts on the safe action (decline), Escape
     declines, Tab cycles inside the dialog, and the previously focused
     element gets focus back when the dialog closes. */
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    declineRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const overlay = overlayRef.current;
      if (!overlay) return;
      const focusables = [...overlay.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )];
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && overlay.contains(active);
      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previous?.focus();
    };
  }, [onCancel]);

  return (
    <div className="panel-settings-backdrop" role="presentation">
      <div
        ref={overlayRef}
        className="panel-settings-overlay host-confirm-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="confirm action"
      >
        <header>
          <strong>{isPluginInstall ? 'install plugin' : isSecretReveal ? 'reveal secret' : 'confirm action'}</strong>
        </header>
        <section className="host-confirm-overlay__body">
          <strong>{isSecretReveal ? (details?.id ?? request.message) : manifest?.title ?? manifest?.id ?? request.message}</strong>
          {isSecretReveal ? (
            <>
              {details?.scope && <span>scope {details.scope === 'user' ? 'global' : details.scope}</span>}
              <span>the raw value will be visible in the agent rail until it auto-hides</span>
            </>
          ) : (
            <>
              {manifest?.id && <span>{manifest.id}</span>}
              {details?.source?.url && <span>{details.source.url}</span>}
              {details?.source?.commit && <span>commit {details.source.commit}</span>}
            </>
          )}
          {isPluginInstall ? (
            <div className="host-confirm-overlay__scope" role="group" aria-label="install scope">
              <button
                type="button"
                className={scope === 'project' ? 'is-active' : ''}
                onClick={() => setScope('project')}
              >
                project
              </button>
              <button
                type="button"
                className={scope === 'user' ? 'is-active' : ''}
                onClick={() => setScope('user')}
              >
                global
              </button>
            </div>
          ) : !isSecretReveal && details?.scope ? <span>scope {details.scope === 'user' ? 'global' : details.scope}</span> : null}
          {(isPluginInstall || request.kind === 'plugin-uninstall') && (
            <span>{permissions.length ? `permissions ${permissions.join(', ')}` : 'permissions none'}</span>
          )}
          {details?.files && (
            <span>
              {details.files.length} {details.files.length === 1 ? 'file' : 'files'}
              {details.totalSizeBytes != null ? ` · ${details.totalSizeBytes} bytes` : ''}
            </span>
          )}
        </section>
        <div className="host-confirm-overlay__actions">
          <button type="button" ref={declineRef} onClick={onCancel}>decline</button>
          <button type="button" onClick={() => onConfirm(isPluginInstall ? { confirmed: true, scope } : true)}>
            {details?.confirmLabel ?? (isSecretReveal ? 'reveal' : 'accept')}
          </button>
        </div>
      </div>
    </div>
  );
}
