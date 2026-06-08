import { useEffect, useMemo, useState } from 'react';
import type { PanelCatalogItem } from '../../components/overlays/panelCatalog';
import type { ProjectSettingsGroup } from './ProjectTab';
import type { GlobalSettingsServices } from './types';

export interface PanelsTabProps {
  services: GlobalSettingsServices;
  panels: PanelCatalogItem[];
  initialPanelSlot?: string;
  setNotice: (value: string) => void;
  onJump: (target: SettingsJumpTarget) => void;
}

type SettingsJumpTarget =
  | { section: 'credentials' }
  | { section: 'extensions' }
  | { section: 'agents' }
  | { section: 'project'; projectGroup: ProjectSettingsGroup };

type PanelSettingsRoute = {
  id: string;
  label: string;
  detail: string;
  target: SettingsJumpTarget;
};

type LocalDataAction = {
  id: string;
  label: string;
  detail: string;
  count: number;
  clear: () => number;
};

export function PanelsTab({ services, panels, initialPanelSlot, setNotice, onJump }: PanelsTabProps) {
  const [selectedSlot, setSelectedSlot] = useState(() => initialPanelSlot ?? panels[0]?.slot ?? '');
  const [enabledById, setEnabledById] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(panels.map((panel) => [panel.id, panel.enabled])),
  );
  const [localDataVersion, setLocalDataVersion] = useState(0);

  /* only force the selection when a deep-link slot is provided/changes — listing
     selectedSlot here would snap every manual click back to the first panel. */
  useEffect(() => {
    if (!initialPanelSlot) return;
    const next = panels.find((panel) => panel.slot === initialPanelSlot);
    if (next) setSelectedSlot(next.slot);
  }, [initialPanelSlot, panels]);

  useEffect(() => {
    setEnabledById(Object.fromEntries(panels.map((panel) => [panel.id, panel.enabled])));
  }, [panels]);

  const panel = panels.find((item) => item.slot === selectedSlot) ?? panels[0];
  const routes = useMemo(() => panel ? settingsRoutesForPanel(panel) : [], [panel]);
  const localActions = useMemo(() => panel ? localDataActionsForPanel(panel) : [], [panel, localDataVersion]);
  const enabled = panel ? enabledById[panel.id] ?? panel.enabled : false;

  const toggleEnabled = async () => {
    if (!panel) return;
    try {
      const result = enabled
        ? await services.host.plugins.disable(panel.id)
        : await services.host.plugins.enable(panel.id);
      const nextEnabled = 'enabled' in result ? result.enabled : !result.disabled;
      setEnabledById((current) => ({ ...current, [panel.id]: nextEnabled }));
      setNotice(`${panel.label} ${nextEnabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'plugin state update failed');
    }
  };

  if (!panel) {
    return (
      <section className="surface-page" aria-label="panels">
        <p className="surface-empty"><span>no panels registered</span></p>
      </section>
    );
  }

  return (
    <section className="surface-page panels-page" aria-label="panels">
      <div className="panels-layout">
        <div className="panels-list" role="listbox" aria-label="registered panels">
          {panels.map((item) => {
            const itemEnabled = enabledById[item.id] ?? item.enabled;
            return (
              <button
                key={item.slot}
                type="button"
                role="option"
                className="panels-list__item"
                aria-selected={item.slot === panel.slot}
                onClick={() => { setSelectedSlot(item.slot); setNotice(''); }}
              >
                <span className="panels-list__icon" aria-hidden="true">{item.icon}</span>
                <span className="panels-list__copy">
                  <strong>{item.label}</strong>
                  <small>{item.category} · {item.source}</small>
                </span>
                <span className={itemEnabled ? 'panels-list__state panels-list__state--on' : 'panels-list__state'}>
                  {itemEnabled ? 'on' : 'off'}
                </span>
              </button>
            );
          })}
        </div>

        <div className="panels-detail">

          {/* ── hero ──────────────────────────────────────────────────── */}
          <div className="panels-hero">
            <div className="panels-hero__bar">
              <span className="panels-hero__icon" aria-hidden="true">{panel.icon}</span>
              <div className="panels-hero__identity">
                <h2 className="panels-hero__name">{panel.label}</h2>
                <code className="panels-hero__id">{panel.id}</code>
              </div>
              <div className="panels-hero__controls">
                <span className={`panels-hero__dot${enabled ? ' panels-hero__dot--on' : ''}`} aria-hidden="true" />
                <span className="panels-hero__state">{enabled ? 'enabled' : 'disabled'}</span>
                <button
                  type="button"
                  className={`surface-btn surface-btn--sm${enabled ? '' : ' surface-btn--accent'}`}
                  onClick={() => void toggleEnabled()}
                >
                  {enabled ? 'disable' : 'enable'}
                </button>
              </div>
            </div>
            <p className="panels-hero__summary">{panel.manual.summary}</p>
          </div>

          {/* ── configuration links ───────────────────────────────────── */}
          {routes.length > 0 && (
            <div className="panels-block" aria-label={`${panel.label} configuration`}>
              <span className="panels-block__label">configuration</span>
              <div className="panels-config-grid">
                {routes.map((route) => (
                  <button
                    key={route.id}
                    type="button"
                    className="panels-config-card"
                    aria-label={`open ${route.label}`}
                    onClick={() => onJump(route.target)}
                  >
                    <span className="panels-config-card__label">{route.label}</span>
                    <span className="panels-config-card__detail">{route.detail}</span>
                    <span className="panels-config-card__arrow" aria-hidden="true">→</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── local data ────────────────────────────────────────────── */}
          {localActions.length > 0 && (
            <div className="panels-block" aria-label={`${panel.label} local data`}>
              <span className="panels-block__label">local data</span>
              <div className="panels-local-list">
                {localActions.map((action) => (
                  <div className="panels-local-row" key={action.id}>
                    <div className="panels-local-row__copy">
                      <strong>{action.label}</strong>
                      <small>{action.detail}{action.count > 0 ? ` · ${action.count} stored` : ''}</small>
                    </div>
                    <button
                      type="button"
                      className="surface-btn surface-btn--sm surface-btn--quiet"
                      disabled={action.count === 0}
                      onClick={() => {
                        const removed = action.clear();
                        setLocalDataVersion((version) => version + 1);
                        setNotice(removed ? `cleared ${action.label}` : `${action.label} already clear`);
                      }}
                    >
                      clear
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── access ────────────────────────────────────────────────── */}
          <div className="panels-block" aria-label={`${panel.label} access`}>
            <span className="panels-block__label">
              access
              {panel.permissions.length > 0 && (
                <span className="panels-block__count">{panel.permissions.length}</span>
              )}
            </span>
            {panel.permissions.length > 0 ? (
              <div className="panels-perms">
                {groupPermissions(panel.permissions).map(({ ns, ops }) => (
                  <div className="panels-perm-row" key={ns}>
                    <code className="panels-perm-ns">{ns}</code>
                    <div className="panels-perm-ops">
                      {ops.map((op) => <span key={op} className="panels-perm-op">{op}</span>)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="panels-none">no permissions declared</p>
            )}
            {panel.capabilities.length > 0 && (
              <div className="panels-caps">
                <span className="panels-caps__label">capabilities</span>
                {panel.capabilities.map((cap) => (
                  <span key={cap} className="panels-cap">{cap}</span>
                ))}
              </div>
            )}
          </div>

          {/* ── manifest footer ───────────────────────────────────────── */}
          <div className="panels-manifest" aria-label={`${panel.label} plugin manifest`}>
            <span>{panel.source}</span>
            <span aria-hidden="true">·</span>
            <span>v{panel.version}</span>
            {panel.defaultArea && (
              <>
                <span aria-hidden="true">·</span>
                <span>{panel.defaultArea}</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>{panel.slot}</span>
          </div>

        </div>
      </div>
    </section>
  );
}


function settingsRoutesForPanel(panel: PanelCatalogItem): PanelSettingsRoute[] {
  const routes: PanelSettingsRoute[] = [];
  const add = (route: PanelSettingsRoute) => {
    if (!routes.some((item) => item.id === route.id)) routes.push(route);
  };
  const project = (group: ProjectSettingsGroup, label: string, detail: string) => add({
    id: `project:${group}`,
    label,
    detail,
    target: { section: 'project', projectGroup: group },
  });

  if (panel.slot === 'preview') {
    project('runtimes', 'runtime commands', '.polypore/runtime.json');
  }

  if (panel.slot === 'editor') {
    project('language-servers', 'language servers', '.polypore/language-servers.json');
    project('formatters', 'formatter commands', '.polypore/formatters.json');
    project('file-tree', 'file tree filters', '.polypore/file-tree.json');
  }

  if (panel.slot === 'problems') {
    project('diagnostics', 'diagnostics sources', '.polypore/diagnostics.json');
  }

  if (panel.slot === 'debug') {
    project('verify', 'verify commands', '.polypore/verify.json');
    project('diagnostics', 'diagnostics sources', '.polypore/diagnostics.json');
  }

  if (panel.slot === 'agent' || panel.slot === 'codex' || panel.slot === 'claude' || panel.slot === 'extensions') {
    add({ id: 'agents', label: 'agent clis', detail: 'path probes and install hints', target: { section: 'agents' } });
  }

  if (panel.permissions.some((permission) => permission.startsWith('secrets.'))) {
    add({ id: 'credentials', label: 'credentials', detail: 'masked secret handles', target: { section: 'credentials' } });
  }

  return routes;
}

function localDataActionsForPanel(panel: PanelCatalogItem): LocalDataAction[] {
  const actions: LocalDataAction[] = [];
  if (panel.slot === 'preview') {
    actions.push(storageAction({
      id: 'preview-runtime',
      label: 'runtime choice',
      detail: 'saved preview runtime selection',
      prefixes: ['polypore.preview.runtime.v1:'],
    }));
  }
  if (panel.slot === 'terminal') {
    actions.push(storageAction({
      id: 'terminal-commands',
      label: 'command suggestions',
      detail: 'frequent shell commands',
      keys: ['polypore.terminal.frequentCommands'],
    }));
  }
  if (panel.slot === 'codex' || panel.slot === 'claude') {
    actions.push(storageAction({
      id: `${panel.slot}-slash`,
      label: 'slash suggestions',
      detail: `frequent ${panel.slot} slash commands`,
      keys: [`polypore.terminal.frequentSlashCommands.${panel.slot}`],
    }));
  }
  return actions;
}

function storageAction({
  id,
  label,
  detail,
  keys = [],
  prefixes = [],
}: {
  id: string;
  label: string;
  detail: string;
  keys?: string[];
  prefixes?: string[];
}): LocalDataAction {
  return {
    id,
    label,
    detail,
    count: countStorageEntries(keys, prefixes),
    clear: () => clearStorageEntries(keys, prefixes),
  };
}

function countStorageEntries(keys: string[], prefixes: string[]) {
  if (typeof window === 'undefined') return 0;
  try {
    let count = 0;
    for (const key of keys) {
      if (window.localStorage.getItem(key) != null) count += 1;
    }
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

function clearStorageEntries(keys: string[], prefixes: string[]) {
  if (typeof window === 'undefined') return 0;
  try {
    const toRemove = new Set(keys);
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) toRemove.add(key);
    }
    let removed = 0;
    for (const key of toRemove) {
      if (window.localStorage.getItem(key) == null) continue;
      window.localStorage.removeItem(key);
      removed += 1;
    }
    return removed;
  } catch {
    return 0;
  }
}

function groupPermissions(permissions: string[]): Array<{ ns: string; ops: string[] }> {
  const groups = new Map<string, string[]>();
  for (const perm of permissions) {
    const dot = perm.indexOf('.');
    const ns = dot >= 0 ? perm.slice(0, dot) : perm;
    const op = dot >= 0 ? perm.slice(dot + 1) : perm;
    const list = groups.get(ns) ?? [];
    list.push(op);
    groups.set(ns, list);
  }
  return [...groups.entries()].map(([ns, ops]) => ({ ns, ops }));
}
