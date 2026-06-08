import { useCallback, useEffect, useRef, useState } from 'react';
import type { GlobalSettingsServices, NativeSecretRef } from './types';

export interface CredentialsTabProps {
  services: GlobalSettingsServices;
  setNotice: (value: string) => void;
}

export function CredentialsTab({ services, setNotice }: CredentialsTabProps) {
  const { secretStore, tauriInvoke, localSecretRefs, secretHandle } = services;
  const [secretName, setSecretName] = useState('');
  const [secretService, setSecretService] = useState('');
  const [secretScope, setSecretScope] = useState<'user' | 'project'>('user');
  const [secretValue, setSecretValue] = useState('');
  const ignoreStoreChangeRef = useRef(false);
  const [secrets, setSecrets] = useState<NativeSecretRef[]>(() => localSecretRefs());
  const [secretError, setSecretError] = useState('');

  const loadSecrets = useCallback(async () => {
    const nativeList = tauriInvoke<NativeSecretRef[]>('secrets_list');
    if (nativeList) {
      try {
        setSecrets(await nativeList);
        setNotice('');
        return;
      } catch (err) {
        setNotice(`keyring unavailable: ${String(err).toLowerCase()}`);
      }
    }
    setSecrets(localSecretRefs());
  }, [tauriInvoke, localSecretRefs, setNotice]);

  useEffect(() => {
    /* live-mirror the host-side secret store. settings + agent panel both
       see the same list because they both read from this store. */
    void loadSecrets();
    return secretStore.onChange(() => {
      if (ignoreStoreChangeRef.current) return;
      void loadSecrets();
    });
  }, [loadSecrets, secretStore]);

  const saveSecret = async () => {
    if (!secretName.trim() || !secretValue.trim()) {
      setSecretError('name and value are required');
      return;
    }
    const id = secretHandle(secretName);
    const service = secretService.trim() || id.split('-')[0] || id;
    try {
      const nativeSet = tauriInvoke<NativeSecretRef>('secrets_set', {
        id,
        value: secretValue,
        scope: secretScope,
        service,
      });
      if (nativeSet) {
        await nativeSet;
        await loadSecrets();
      } else {
        ignoreStoreChangeRef.current = true;
        secretStore.set({ id, value: secretValue, scope: secretScope, service });
        ignoreStoreChangeRef.current = false;
        setSecrets(localSecretRefs());
      }
      setSecretError('');
    } catch (err) {
      setSecretError(String(err).toLowerCase());
      return;
    }
    setSecretValue('');
    setNotice(`saved ${id}`);
  };

  const deleteSecret = async (secret: NativeSecretRef) => {
    const nativeDelete = tauriInvoke<boolean>('secrets_delete', { id: secret.id, scope: secret.scope });
    try {
      if (nativeDelete) {
        await nativeDelete;
        await loadSecrets();
      } else {
        ignoreStoreChangeRef.current = true;
        secretStore.delete(secret.id, secret.scope);
        ignoreStoreChangeRef.current = false;
        setSecrets(localSecretRefs());
      }
      setSecretError('');
      setNotice(`removed ${secret.id}`);
    } catch (err) {
      setSecretError(String(err).toLowerCase());
    }
  };

  const testSecret = async (secret: NativeSecretRef) => {
    const nativeHas = tauriInvoke<boolean>('secrets_has', { id: secret.id, scope: secret.scope });
    try {
      const configured = nativeHas ? await nativeHas : secretStore.has(secret.id, secret.scope);
      setNotice(configured ? `${secret.id} is configured` : `${secret.id} is missing`);
    } catch (err) {
      setNotice(String(err).toLowerCase());
    }
  };

  return (
    <section className="surface-page credentials-page" aria-label="credentials">
      <section className="surface-section" aria-label="saved handles">
        <div className="surface-section__head">
          <h2>configured credentials</h2>
          <small>stored as masked handles · the value never returns</small>
        </div>
        {secrets.length === 0
          ? <p className="surface-empty"><span>no credentials configured yet</span></p>
          : (
            <div className="surface-list">
              {secrets.map((secret) => (
                <div className="surface-row credentials-row" key={`${secret.scope}:${secret.id}`}>
                  <span className="credentials-row__dot" data-on={secret.configured || undefined} aria-hidden="true" />
                  <span className="surface-row__main">
                    <strong>{secret.id}</strong>
                    <small>{secret.service ?? 'custom'} · {secret.scope === 'user' ? 'global' : secret.scope}{secret.hint ? ` · ${secret.hint}` : ''}</small>
                  </span>
                  <span className="surface-row__actions">
                    <span className={secret.configured ? 'surface-pill surface-pill--ok' : 'surface-pill surface-pill--warn'}>
                      {secret.configured ? 'configured' : 'missing'}
                    </span>
                    <button type="button" className="surface-btn surface-btn--sm surface-btn--quiet" aria-label={`test ${secret.id}`} onClick={() => testSecret(secret)}>test</button>
                    <button type="button" className="surface-btn surface-btn--sm surface-btn--quiet" aria-label={`remove ${secret.id}`} onClick={() => deleteSecret(secret)}>remove</button>
                  </span>
                </div>
              ))}
            </div>
          )}
      </section>

      <section className="surface-section" aria-label="save credential">
        <div className="surface-section__head">
          <h2>add a credential</h2>
          <small>value is write-only</small>
        </div>
        <div className="credentials-form">
          <div className="credentials-form__meta">
            <label className="surface-field">
              <span>name</span>
              <input className="surface-input" value={secretName} placeholder="GITHUB_TOKEN" onChange={(event) => setSecretName(event.target.value)} />
            </label>
            <label className="surface-field">
              <span>service</span>
              <input className="surface-input" value={secretService} placeholder="github, npm, custom" onChange={(event) => setSecretService(event.target.value)} />
            </label>
            <label className="surface-field">
              <span>scope</span>
              <select className="surface-select" value={secretScope} onChange={(event) => setSecretScope(event.target.value as 'user' | 'project')}>
                <option value="user">global</option>
                <option value="project">project</option>
              </select>
            </label>
          </div>
          <div className="credentials-form__value">
            <label className="surface-field surface-field--wide">
              <span>secret value</span>
              <input
                className="surface-input"
                type="password"
                value={secretValue}
                placeholder="paste once — stored in the OS keyring"
                onChange={(event) => setSecretValue(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void saveSecret(); }}
              />
            </label>
            <button type="button" className="surface-btn surface-btn--accent" onClick={saveSecret}>save credential</button>
          </div>
          {secretError && <p className="surface-error">{secretError}</p>}
        </div>
      </section>
    </section>
  );
}
