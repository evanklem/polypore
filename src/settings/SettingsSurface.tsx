import { useEffect, useState } from 'react';
import { SurfaceShell } from '../surfaces/SurfaceShell';
import { CredentialsTab } from './tabs/CredentialsTab';
import { InterfaceTab } from './tabs/InterfaceTab';
import { PluginsTab } from './tabs/PluginsTab';
import { AgentsTab } from './tabs/AgentsTab';
import { PanelsTab } from './tabs/PanelsTab';
import { ProjectTab } from './tabs/ProjectTab';
import { UpdatesTab } from './tabs/UpdatesTab';
import type { ProjectSettingsGroup } from './tabs/project/projectConfig';
import type { GlobalSettingsServices } from './tabs/types';
import type { PanelCatalogItem } from '../components/overlays/panelCatalog';
import './settings-surface.css';

export interface SettingsSurfaceProps {
  services: GlobalSettingsServices;
  initialSection?: SettingsSection;
  initialPanelSlot?: string;
  initialProjectGroup?: ProjectSettingsGroup;
  panelCatalog?: PanelCatalogItem[];
  /** hand an instruction to the agent (e.g. install a plugin from a source) */
  onRequestAgent?: (prompt: string) => void;
  onClose: () => void;
}

export type CanonicalSettingsSection =
  | 'panels'
  | 'project'
  | 'extensions'
  | 'agents'
  | 'credentials'
  | 'updates'
  | 'appearance';

export type SettingsSection = CanonicalSettingsSection | 'interface' | 'plugins' | 'overview';

export type SectionJumpTarget =
  | { section: 'panels'; panelSlot?: string }
  | { section: 'project'; projectGroup?: ProjectSettingsGroup }
  | { section: 'extensions' | 'agents' | 'credentials' | 'updates' | 'appearance' };

const SECTIONS: Array<{
  id: CanonicalSettingsSection;
  label: string;
  blurb: string;
  group: 'workspace' | 'system' | 'look';
  icon: string;
  tags: string;
}> = [
  { id: 'panels', label: 'panels', blurb: 'access, local data, routes', group: 'workspace', icon: '[]', tags: 'windows panel gear docs' },
  { id: 'project', label: 'project', blurb: 'runtime, verify, diagnostics, editor', group: 'workspace', icon: '{}', tags: 'runtime lsp format file tree language servers formatters' },
  { id: 'extensions', label: 'extensions', blurb: 'installed plugins and sources', group: 'system', icon: '+-', tags: 'plugins install disable uninstall' },
  { id: 'agents', label: 'agents', blurb: 'agent clis and availability', group: 'system', icon: 'ai', tags: 'codex claude path probe' },
  { id: 'credentials', label: 'credentials', blurb: 'secret handles and scopes', group: 'system', icon: '**', tags: 'keys secrets tokens api' },
  { id: 'updates', label: 'updates', blurb: 'version, check, install', group: 'system', icon: 'up', tags: 'update version release install upgrade' },
  { id: 'appearance', label: 'appearance', blurb: 'accent, motion, surface', group: 'look', icon: 'px', tags: 'interface theme color glass motion' },
];

const GROUPS: Array<{ id: 'workspace' | 'system' | 'look'; label: string }> = [
  { id: 'workspace', label: 'workspace' },
  { id: 'system', label: 'system' },
  { id: 'look', label: 'look' },
];

function normalizeSection(section: SettingsSection | undefined): CanonicalSettingsSection {
  if (section === 'plugins') return 'extensions';
  if (section === 'interface') return 'appearance';
  if (section === 'overview' || section == null) return 'panels';
  return section;
}

export function SettingsSurface({
  services,
  initialSection = 'panels',
  initialPanelSlot,
  initialProjectGroup,
  panelCatalog = [],
  onRequestAgent,
  onClose,
}: SettingsSurfaceProps) {
  const [active, setActive] = useState<CanonicalSettingsSection>(() => normalizeSection(initialSection));
  const [projectGroup, setProjectGroup] = useState<ProjectSettingsGroup | undefined>(initialProjectGroup);
  const [panelSlot, setPanelSlot] = useState<string | undefined>(initialPanelSlot);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setActive(normalizeSection(initialSection));
    setProjectGroup(initialProjectGroup);
    setPanelSlot(initialPanelSlot);
    setNotice('');
  }, [initialPanelSlot, initialProjectGroup, initialSection]);

  const activeMeta = SECTIONS.find((section) => section.id === active) ?? SECTIONS[0];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleSections = normalizedQuery
    ? SECTIONS.filter((section) => [
        section.label,
        section.blurb,
        section.group,
        section.tags,
      ].join(' ').includes(normalizedQuery))
    : SECTIONS;

  const jumpTo = (target: SectionJumpTarget) => {
    setActive(target.section);
    setPanelSlot(target.section === 'panels' ? target.panelSlot : undefined);
    setProjectGroup(target.section === 'project' ? target.projectGroup : undefined);
    setNotice('');
  };

  const nav = (
    <>
      <label className="surface__search">
        <span className="surface__search-icon" aria-hidden="true">⌕</span>
        <input
          value={query}
          placeholder="find a setting"
          aria-label="find settings"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {GROUPS.map((group) => {
        const sections = visibleSections.filter((section) => section.group === group.id);
        if (sections.length === 0) return null;
        return (
          <div className="surface__nav-group" key={group.id}>
            <span className="surface__nav-heading">{group.label}</span>
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                className="surface__nav-link"
                aria-current={active === section.id ? 'page' : undefined}
                onClick={() => jumpTo({ section: section.id })}
              >
                <span className="surface__nav-icon" aria-hidden="true">{section.icon}</span>
                <span className="surface__nav-text">
                  <strong>{section.label}</strong>
                  <small>{section.blurb}</small>
                </span>
              </button>
            ))}
          </div>
        );
      })}
      {visibleSections.length === 0 && <p className="surface__nav-empty">no settings match</p>}
    </>
  );

  return (
    <SurfaceShell
      label="settings"
      title="settings"
      subtitle={`${activeMeta.label} · ${activeMeta.blurb}`}
      closeLabel="close settings"
      navLabel="settings sections"
      nav={nav}
      onClose={onClose}
    >
      <section className="surface__content" aria-label="settings content">
        <div className="surface__inner">
          {notice && <p className="settings-notice" role="status">{notice}</p>}
          {active === 'credentials' && (
            <CredentialsTab services={services} setNotice={setNotice} />
          )}
          {active === 'appearance' && <InterfaceTab setNotice={setNotice} />}
          {active === 'project' && (
            <ProjectTab services={services} setNotice={setNotice} focusGroup={projectGroup} />
          )}
          {active === 'panels' && (
            <PanelsTab
              services={services}
              panels={panelCatalog}
              initialPanelSlot={panelSlot}
              setNotice={setNotice}
              onJump={jumpTo}
            />
          )}
          {active === 'extensions' && (
            <PluginsTab
              services={services}
              notice={notice}
              setNotice={setNotice}
              onRequestAgent={onRequestAgent}
            />
          )}
          {active === 'agents' && (
            <AgentsTab services={services} notice={notice} setNotice={setNotice} />
          )}
          {active === 'updates' && (
            <UpdatesTab services={services} setNotice={setNotice} />
          )}
        </div>
      </section>
    </SurfaceShell>
  );
}
