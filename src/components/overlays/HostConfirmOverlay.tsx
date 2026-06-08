import { useState } from 'react';
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
  files?: Array<{ path: string; sizeBytes: number }>;
};

export function HostConfirmOverlay({ request, onCancel, onConfirm }: HostConfirmOverlayProps) {
  const details = request.details as ConfirmDetails | undefined;
  const manifest = details?.manifest;
  const permissions = manifest?.permissions ?? [];
  const [scope, setScope] = useState<'project' | 'user'>(details?.scope === 'user' ? 'user' : 'project');
  const isPluginInstall = request.kind === 'plugin-install';
  const isSecretReveal = request.kind === 'secret-reveal';
  return (
    <div className="panel-settings-backdrop" role="presentation">
      <div className="panel-settings-overlay host-confirm-overlay" role="dialog" aria-label="confirm action">
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
          {!isSecretReveal && <span>{permissions.length ? `permissions ${permissions.join(', ')}` : 'permissions none'}</span>}
          {details?.files && <span>{details.files.length} files · {details.totalSizeBytes ?? 0} bytes</span>}
        </section>
        <div className="host-confirm-overlay__actions">
          <button onClick={onCancel}>decline</button>
          <button onClick={() => onConfirm(isPluginInstall ? { confirmed: true, scope } : true)}>
            {isSecretReveal ? 'reveal' : 'accept'}
          </button>
        </div>
      </div>
    </div>
  );
}
