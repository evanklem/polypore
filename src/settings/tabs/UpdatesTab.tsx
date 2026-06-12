import { useEffect, useState } from 'react';
import { AdvancedDisclosure } from '../AdvancedDisclosure';
import type { GlobalSettingsServices } from './types';

export interface UpdatesTabProps {
  services: GlobalSettingsServices;
  setNotice: (value: string) => void;
}

interface UpdaterStatus {
  configured: boolean;
  endpoint: string | null;
  availableVersion: string | null;
  currentVersion: string;
  status: string;
}

const RELEASES_URL = 'https://github.com/evanklem/polypore/releases';

type Phase = 'idle' | 'checking' | 'installing' | 'installed';

export function UpdatesTab({ services, setNotice }: UpdatesTabProps) {
  const { tauriInvoke } = services;
  const [version, setVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdaterStatus | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');

  useEffect(() => {
    const call = tauriInvoke<string>('updater_current_version');
    if (!call) return;
    call.then(setVersion).catch(() => setVersion(null));
  }, [tauriInvoke]);

  const checkForUpdates = async () => {
    if (phase === 'checking' || phase === 'installing') return;
    setPhase('checking');
    try {
      const call = tauriInvoke<UpdaterStatus>('updater_status');
      if (!call) {
        setNotice('update checks require the desktop shell');
        return;
      }
      const result = await call;
      setStatus(result);
      setVersion(result.currentVersion);
      setNotice(result.status);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'update check failed');
    } finally {
      setPhase((current) => (current === 'checking' ? 'idle' : current));
    }
  };

  const installUpdate = async () => {
    if (phase === 'installing') return;
    setPhase('installing');
    try {
      const call = tauriInvoke<string>('updater_install');
      if (!call) {
        setNotice('updates require the desktop shell');
        setPhase('idle');
        return;
      }
      const result = await call;
      setNotice(result);
      setPhase('installed');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'update install failed');
      setPhase('idle');
    }
  };

  const relaunch = () => {
    void tauriInvoke('updater_relaunch');
  };

  const checked = status != null;
  const updateAvailable = status?.availableVersion != null;
  const versionPill = phase === 'installed'
    ? { className: 'surface-pill surface-pill--ok', label: 'restart to finish' }
    : updateAvailable
      ? { className: 'surface-pill surface-pill--warn', label: `${status?.availableVersion} available` }
      : checked
        ? status?.configured
          ? { className: 'surface-pill surface-pill--ok', label: 'up to date' }
          : { className: 'surface-pill surface-pill--warn', label: 'updater unavailable' }
        : { className: 'surface-pill', label: 'not checked' };

  return (
    <section className="surface-page" aria-label="updates">
      <section className="surface-section" aria-label="version">
        <div className="surface-section__head">
          <h2>version</h2>
          <span className="surface-section__head-row">
            <small>{checked ? status.status : 'updates are fetched from github releases'}</small>
            <button
              type="button"
              className="surface-btn surface-btn--sm"
              disabled={phase === 'checking' || phase === 'installing'}
              onClick={() => void checkForUpdates()}
            >
              {phase === 'checking' ? 'checking' : 'check for updates'}
            </button>
          </span>
        </div>
        <div className="surface-list">
          <div className="surface-row">
            <span className="surface-row__main">
              <strong>polypore</strong>
              <code>{version ? `v${version}` : 'version unavailable outside the desktop shell'}</code>
            </span>
            <span className="surface-row__actions">
              <span className={versionPill.className}>{versionPill.label}</span>
            </span>
          </div>
          {updateAvailable && (
            <div className="surface-row">
              <span className="surface-row__main">
                <strong>{phase === 'installed' ? 'update installed' : 'update available'}</strong>
                <code>{`v${status?.availableVersion}`}</code>
              </span>
              <span className="surface-row__actions">
                {phase === 'installed' ? (
                  <button type="button" className="surface-btn surface-btn--sm" onClick={relaunch}>
                    restart polypore
                  </button>
                ) : (
                  <button
                    type="button"
                    className="surface-btn surface-btn--sm"
                    disabled={phase === 'installing'}
                    onClick={() => void installUpdate()}
                  >
                    {phase === 'installing' ? 'installing' : 'download & install'}
                  </button>
                )}
              </span>
            </div>
          )}
        </div>
      </section>

      <section className="surface-section" aria-label="updates advanced">
        <AdvancedDisclosure summary="release channel">
          <div className="surface-list">
            <div className="surface-row">
              <span className="surface-row__main">
                <strong>releases</strong>
                <code>{RELEASES_URL}</code>
              </span>
              <span className="surface-row__actions">
                <button
                  type="button"
                  className="surface-btn surface-btn--sm surface-btn--quiet"
                  onClick={() => {
                    const call = tauriInvoke('open_external_url', { url: RELEASES_URL });
                    if (!call) setNotice('link opening requires the desktop shell');
                  }}
                >
                  view releases
                </button>
              </span>
            </div>
            <div className="surface-row">
              <span className="surface-row__main">
                <strong>install channel</strong>
                <code>{checked && !status.configured ? 'managed externally (package manager or dev build)' : 'direct download, in-app updates'}</code>
              </span>
            </div>
          </div>
        </AdvancedDisclosure>
      </section>
    </section>
  );
}
