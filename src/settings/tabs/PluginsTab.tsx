import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PluginRef } from '../../../packages/sdk/src';
import { AdvancedDisclosure } from '../AdvancedDisclosure';
import type { GlobalSettingsServices } from './types';

export interface PluginsTabProps {
  services: GlobalSettingsServices;
  notice: string;
  setNotice: (value: string) => void;
  /** hand a "install from this source" request to the agent pipeline */
  onRequestAgent?: (prompt: string) => void;
}

export function PluginsTab({ services, setNotice, onRequestAgent }: PluginsTabProps) {
  const { host } = services;
  const [plugins, setPlugins] = useState<PluginRef[]>([]);
  const [pluginInstallId, setPluginInstallId] = useState('');
  const [pluginVersion, setPluginVersion] = useState('0.1.0');
  const [pluginScope, setPluginScope] = useState<'project' | 'user'>('project');
  const [sourceUrl, setSourceUrl] = useState('');
  const [filter, setFilter] = useState('');

  const loadPlugins = useCallback(() => {
    let cancelled = false;
    host.plugins.list().then((result) => {
      if (!cancelled) setPlugins(result.plugins);
    }).catch(() => setPlugins([]));
    return () => { cancelled = true; };
  }, [host]);

  useEffect(() => loadPlugins(), [loadPlugins]);

  const installPlugin = async () => {
    const id = pluginInstallId.trim();
    if (!id) {
      setNotice('plugin id is required');
      return;
    }
    try {
      const result = await host.plugins.install({
        id,
        version: pluginVersion.trim() || '0.1.0',
        scope: pluginScope,
        enabled: true,
        installedAt: Date.now(),
        source: 'settings',
      });
      setPlugins((current) => [result.plugin, ...current.filter((plugin) => plugin.id !== result.plugin.id)]);
      setPluginInstallId('');
      setNotice(`installed ${result.plugin.id}`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'plugin install failed');
    }
  };

  const uninstallPlugin = async (id: string) => {
    try {
      await host.plugins.uninstall(id);
      setPlugins((current) => current.filter((plugin) => plugin.id !== id));
      setNotice(`uninstalled ${id}`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'plugin uninstall failed');
    }
  };

  const togglePlugin = async (plugin: PluginRef) => {
    try {
      const result = plugin.enabled
        ? await host.plugins.disable(plugin.id)
        : await host.plugins.enable(plugin.id);
      const enabled = 'enabled' in result ? result.enabled : !result.disabled;
      setPlugins((current) => current.map((item) => (
        item.id === plugin.id ? { ...item, enabled } : item
      )));
      setNotice(`${plugin.id} ${enabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'plugin state update failed');
    }
  };

  const requestSourceReview = () => {
    const url = sourceUrl.trim();
    if (!url) {
      setNotice('paste a source url first');
      return;
    }
    onRequestAgent?.(
      `Inspect the polypore plugin source at ${url}: fetch it into staging, scan for a polypore.json manifest, summarize risks and install steps, and wait for my confirmation before installing anything.`,
    );
    setNotice(`asked the agent to inspect ${url}`);
    setSourceUrl('');
  };

  const allInstalled = useMemo(() => plugins.filter((p) => !isBuiltinPlugin(p)), [plugins]);

  const visibleInstalled = useMemo(() => {
    const normalized = filter.trim().toLowerCase();
    if (!normalized) return allInstalled;
    return allInstalled.filter((plugin) =>
      [plugin.id, plugin.version, plugin.scope, plugin.source, plugin.enabled ? 'enabled' : 'disabled']
        .join(' ').toLowerCase().includes(normalized),
    );
  }, [filter, allInstalled]);

  const enabledCount = allInstalled.filter((p) => p.enabled).length;

  return (
    <section className="surface-page" aria-label="extensions">
      <section className="surface-section" aria-label="installed extension list">
        <div className="surface-section__head">
          <h2>installed extensions</h2>
          <small>
            {allInstalled.length
              ? `${enabledCount} enabled · ${allInstalled.length} total`
              : 'none installed'}
          </small>
        </div>
        {allInstalled.length > 3 && (
          <label className="surface__search extensions-filter">
            <span className="surface__search-icon" aria-hidden="true">⌕</span>
            <input value={filter} placeholder="filter by id, scope, status" onChange={(event) => setFilter(event.target.value)} />
          </label>
        )}
        {visibleInstalled.length === 0 ? (
          <p className="surface-empty">
            <span>{filter.trim() ? 'no extensions match the filter' : 'no extensions installed'}</span>
          </p>
        ) : (
          <div className="surface-list">
            {visibleInstalled.map((plugin) => (
              <PluginRow
                key={plugin.id}
                plugin={plugin}
                onToggle={togglePlugin}
                onUninstall={uninstallPlugin}
              />
            ))}
          </div>
        )}
      </section>

      {onRequestAgent && (
        <section className="surface-section" aria-label="review extension source">
          <div className="surface-section__head">
            <h2>install from a source</h2>
            <small>agent-reviewed</small>
          </div>
          <p className="surface-hint">paste a git url or repo. the agent fetches it into staging, scans the manifest, and reports risks and install steps — nothing is installed without your confirmation.</p>
          <div className="surface-action-row source-install-row">
            <input
              className="surface-input"
              value={sourceUrl}
              placeholder="git url or repo"
              aria-label="plugin source url"
              onChange={(event) => setSourceUrl(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') requestSourceReview(); }}
            />
            <button type="button" className="surface-btn surface-btn--accent" onClick={requestSourceReview}>ask agent to inspect</button>
          </div>
        </section>
      )}

      <section className="surface-section" aria-label="advanced extension install">
        <AdvancedDisclosure summary="install by id">
          <p className="surface-hint">install a plugin directly by id. source-based installs require an agent review first.</p>
          <div className="surface-fields install-by-id">
            <input
              className="surface-input"
              value={pluginInstallId}
              placeholder="plugin id"
              onChange={(event) => setPluginInstallId(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void installPlugin(); }}
            />
            <input
              className="surface-input"
              value={pluginVersion}
              placeholder="version"
              onChange={(event) => setPluginVersion(event.target.value)}
            />
            <select className="surface-select" value={pluginScope} onChange={(event) => setPluginScope(event.target.value as 'project' | 'user')}>
              <option value="project">project</option>
              <option value="user">user</option>
            </select>
            <button type="button" className="surface-btn surface-btn--accent" onClick={installPlugin}>install</button>
          </div>
        </AdvancedDisclosure>
      </section>
    </section>
  );
}

function isBuiltinPlugin(plugin: PluginRef): boolean {
  return plugin.scope === 'builtin' || plugin.source === 'builtin' || plugin.source === 'built-in';
}

function PluginRow({
  plugin,
  onToggle,
  onUninstall,
}: {
  plugin: PluginRef;
  onToggle: (plugin: PluginRef) => void;
  onUninstall: (id: string) => void;
}) {
  const scopeLabel = `${plugin.scope} extension`;
  const sourceLabel = plugin.source && plugin.source !== plugin.scope ? ` · ${plugin.source}` : '';
  return (
    <div className="surface-row">
      <span className="surface-row__main">
        <strong>{plugin.id}</strong>
        <small>{scopeLabel}{sourceLabel} · {plugin.version}</small>
      </span>
      <span className="surface-row__actions">
        <span className={plugin.enabled ? 'surface-pill surface-pill--ok' : 'surface-pill'}>
          {plugin.enabled ? 'enabled' : 'disabled'}
        </span>
        <button type="button" className="surface-btn surface-btn--sm surface-btn--quiet" onClick={() => void onToggle(plugin)}>
          {plugin.enabled ? 'disable' : 'enable'}
        </button>
        <button type="button" className="surface-btn surface-btn--sm surface-btn--quiet" onClick={() => onUninstall(plugin.id)}>uninstall</button>
      </span>
    </div>
  );
}
