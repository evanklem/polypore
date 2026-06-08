import React, { useEffect, useMemo, useRef, useState } from 'react';
import './Launcher.css';

/* the launcher is shown before the IDE mounts. it gates the workspace on
   the user picking a project — either a recent one, a folder they navigate
   to, or a new project scaffolded from a template. once a project is
   selected, App.tsx swaps the launcher for the dockview workspace.

   it deliberately calls the desktop shell directly via __TAURI__.core.invoke
   so we don't have to thread the host RPC server through here — the
   launcher runs before the host comes online with project state. */

type TauriCore = {
  invoke?: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
};

type BrowserDirectoryHandle = {
  kind: 'directory';
  name: string;
  values?: () => AsyncIterable<unknown>;
  getDirectoryHandle?: (name: string, options?: { create?: boolean }) => Promise<BrowserDirectoryHandle>;
  getFileHandle?: (name: string, options?: { create?: boolean }) => Promise<{
    createWritable?: () => Promise<{ write: (value: string) => Promise<void>; close: () => Promise<void> }>;
  }>;
};

type BrowserWindow = Window & {
  __TAURI__?: { core?: TauriCore };
  __HOME__?: string;
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<BrowserDirectoryHandle>;
  __POLYPORE_BROWSER_PROJECTS__?: Map<string, BrowserDirectoryHandle>;
};

function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> | null {
  const core = (window as BrowserWindow).__TAURI__?.core;
  if (!core?.invoke) return null;
  return core.invoke<T>(command, args);
}

function hasTauriInvoke() {
  return Boolean((window as BrowserWindow).__TAURI__?.core?.invoke);
}

function compareTemplateCategory(left: string, right: string) {
  if (left === right) return 0;
  if (left === 'general') return -1;
  if (right === 'general') return 1;
  return left.localeCompare(right);
}

const BROWSER_RECENTS_KEY = 'polypore.browser.recentProjects';
const BROWSER_BLANK_GITIGNORE = [
  '# polypore blank project',
  '.env',
  '.env.*',
  '!.env.example',
  '.DS_Store',
  'dist/',
  'build/',
  'target/',
  'node_modules/',
  '__pycache__/',
  '*.pyc',
  '.venv/',
].join('\n') + '\n';
const BROWSER_TEMPLATES: ProjectTemplate[] = [{
  id: 'blank',
  label: 'blank folder',
  category: 'general',
  language: 'any',
  summary: 'empty directory with a .gitignore stub. start from scratch.',
  command: 'blank',
  requires: '',
}];

function browserProjectStore() {
  const browserWindow = window as BrowserWindow;
  if (!browserWindow.__POLYPORE_BROWSER_PROJECTS__) {
    browserWindow.__POLYPORE_BROWSER_PROJECTS__ = new Map();
  }
  return browserWindow.__POLYPORE_BROWSER_PROJECTS__;
}

function readBrowserRecents(): RecentProject[] {
  try {
    const raw = window.localStorage.getItem(BROWSER_RECENTS_KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw) as RecentProject[];
    return rows
      .filter((row) => row.path && row.name)
      .map((row) => ({ ...row, exists: browserProjectStore().has(row.path) || row.exists }))
      .slice(0, 24);
  } catch {
    return [];
  }
}

function writeBrowserRecents(rows: RecentProject[]) {
  try {
    window.localStorage.setItem(BROWSER_RECENTS_KEY, JSON.stringify(rows.slice(0, 24)));
  } catch {
    /* localStorage may be unavailable in private contexts. the in-memory
       handle map still lets the current session continue. */
  }
}

function rememberBrowserProject(handle: BrowserDirectoryHandle): LaunchTarget {
  const path = `browser://${handle.name}`;
  browserProjectStore().set(path, handle);
  const next: RecentProject = {
    path,
    name: handle.name || 'project',
    last_opened: Date.now(),
    exists: true,
  };
  writeBrowserRecents([next, ...readBrowserRecents().filter((row) => row.path !== path)]);
  return { path, name: next.name };
}

async function pickBrowserFolder(mode: 'read' | 'readwrite' = 'read'): Promise<LaunchTarget | null> {
  const picker = (window as BrowserWindow).showDirectoryPicker;
  if (!picker) return null;
  const handle = await picker({ mode });
  return rememberBrowserProject(handle);
}

async function writeBrowserFile(
  directory: BrowserDirectoryHandle,
  name: string,
  contents: string,
) {
  const fileHandle = await directory.getFileHandle?.(name, { create: true });
  const writable = await fileHandle?.createWritable?.();
  if (!writable) return;
  await writable.write(contents);
  await writable.close();
}

async function createBrowserBlankProject(parent: BrowserDirectoryHandle, name: string): Promise<LaunchTarget> {
  if (!parent.getDirectoryHandle) throw new Error('this browser cannot create folders');
  const directory = await parent.getDirectoryHandle(name, { create: true });
  await writeBrowserFile(directory, '.gitignore', BROWSER_BLANK_GITIGNORE);
  return rememberBrowserProject(directory);
}

export type LaunchTarget = { path: string; name: string };

type RecentProject = {
  path: string;
  name: string;
  last_opened: number;
  exists: boolean;
};

type ProjectTemplate = {
  id: string;
  label: string;
  category: string;
  language: string;
  summary: string;
  command: string;
  requires: string;
};

type ScaffoldOutcome = {
  ok: boolean;
  log: string;
  project: { path: string; name: string; created: boolean };
};

/* compact two-row Braille-block "polypore" wordmark. rendered as SVG with
   each cell positioned at a fixed x — HTML <pre> drifts when different
   braille codepoints fall through to different fallback fonts with
   different advance widths. SVG sidesteps that by anchoring every glyph
   at a column we control. */
const POLYPORE_BRAILLE: string[][] = [
  [...'\u28C0\u2840\u2800\u2880\u2840\u2800\u2847\u2800\u2840\u2880\u2800\u28C0\u2840\u2800\u2880\u2840\u2800\u2840\u28C0\u2800\u2880\u2840'],
  [...'\u2867\u281C\u2800\u2823\u281C\u2800\u2823\u2800\u28D1\u287A\u2800\u2867\u281C\u2800\u2823\u281C\u2800\u280F\u2800\u2800\u2823\u282D'],
];

function PolyporeLoadingScreen() {
  return (
    <div
      className="polypore-loading"
      role="status"
      aria-live="polite"
      aria-label="forming workspace"
    >
      <div className="polypore-loading__text">forming workspace</div>
      <div className="polypore-loading__dots" aria-hidden="true">
        {Array.from({ length: 28 }, (_, index) => (
          <span
            key={index}
            style={{ '--delay': `${index * 55}ms` } as React.CSSProperties}
          />
        ))}
      </div>
    </div>
  );
}

export { PolyporeLoadingScreen };

function formatTimestamp(ms: number): string {
  if (!ms) return '—';
  const now = Date.now();
  const diff = now - ms;
  if (diff < 0) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function shortenPath(path: string): string {
  if (path.startsWith('browser://')) return `${path.slice('browser://'.length)} (browser folder)`;
  const home = (window as BrowserWindow).__HOME__;
  if (home && path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

type RecentGroup = { id: string; label: string; items: RecentProject[] };

function groupRecents(recents: RecentProject[]): RecentGroup[] {
  const now = Date.now();
  const dayMs = 86_400_000;
  const today: RecentProject[] = [];
  const week: RecentProject[] = [];
  const month: RecentProject[] = [];
  const older: RecentProject[] = [];
  const missing: RecentProject[] = [];
  for (const row of recents) {
    if (!row.exists) {
      missing.push(row);
      continue;
    }
    const age = now - row.last_opened;
    if (age < dayMs) today.push(row);
    else if (age < 7 * dayMs) week.push(row);
    else if (age < 30 * dayMs) month.push(row);
    else older.push(row);
  }
  return [
    { id: 'today', label: 'today', items: today },
    { id: 'week', label: 'this week', items: week },
    { id: 'month', label: 'this month', items: month },
    { id: 'older', label: 'earlier', items: older },
    { id: 'missing', label: 'missing on disk', items: missing },
  ].filter((g) => g.items.length > 0);
}

const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function PolyporeWordmark() {
  const cols = POLYPORE_BRAILLE[0].length;
  const rows = POLYPORE_BRAILLE.length;
  const cellW = 12;
  const cellH = 18;
  const padX = 8;
  return (
    <svg
      className="launcher__ascii"
      viewBox={`${-padX} 0 ${cols * cellW + padX * 2} ${rows * cellH}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      {POLYPORE_BRAILLE.flatMap((row, r) =>
        row.map((ch, c) => (
          <text
            key={`${r}-${c}`}
            x={c * cellW + cellW / 2}
            y={r * cellH + cellH * 0.85}
            textAnchor="middle"
            fontSize={cellH}
            fill="currentColor"
          >
            {ch}
          </text>
        )),
      )}
    </svg>
  );
}

export function Launcher({
  onOpen,
  onDismiss,
  initialMode = 'recent',
}: {
  onOpen: (target: LaunchTarget) => void;
  onDismiss?: () => void;
  initialMode?: 'recent' | 'new';
}) {
  const desktopShellAvailable = hasTauriInvoke();
  const [recents, setRecents] = useState<RecentProject[]>(() =>
    desktopShellAvailable ? [] : readBrowserRecents());
  const [templates, setTemplates] = useState<ProjectTemplate[]>(() =>
    desktopShellAvailable ? [] : BROWSER_TEMPLATES);
  const [filter, setFilter] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(initialMode === 'new');

  useEffect(() => {
    if (!desktopShellAvailable) return;
    let cancelled = false;
    const load = async () => {
      try {
        const [recentRes, templateRes] = await Promise.all([
          tauriInvoke<RecentProject[]>('project_recent_list') ?? Promise.resolve([]),
          tauriInvoke<ProjectTemplate[]>('project_templates') ?? Promise.resolve(BROWSER_TEMPLATES),
        ]);
        if (cancelled) return;
        setRecents(recentRes);
        setTemplates(templateRes);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [desktopShellAvailable]);

  const filteredRecents = useMemo(() => {
    if (!filter.trim()) return recents;
    const needle = filter.toLowerCase();
    return recents.filter((r) =>
      r.name.toLowerCase().includes(needle) || r.path.toLowerCase().includes(needle));
  }, [recents, filter]);

  const groupedRecents = useMemo(() => groupRecents(filteredRecents), [filteredRecents]);

  const openProject = async (path: string) => {
    setWorking(true);
    setError(null);
    try {
      const meta = await tauriInvoke<{ path: string; name: string }>('project_open', { path });
      if (meta) {
        onOpen({ path: meta.path, name: meta.name });
        return;
      }
      const browserProject = readBrowserRecents().find((row) => row.path === path);
      if (!browserProject) {
        throw new Error('open folder requires the desktop shell or a browser-selected folder from this session');
      }
      const next = {
        ...browserProject,
        last_opened: Date.now(),
        exists: browserProjectStore().has(path) || browserProject.exists,
      };
      writeBrowserRecents([next, ...readBrowserRecents().filter((row) => row.path !== path)]);
      onOpen({ path: next.path, name: next.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const pickFolder = async () => {
    setWorking(true);
    setError(null);
    try {
      const nativePick = tauriInvoke<string | null>('project_pick_folder');
      if (nativePick) {
        const result = await nativePick;
        if (!result) {
          setWorking(false);
          return;
        }
        await openProject(result);
        return;
      }
      const picked = await pickBrowserFolder('read');
      if (!picked) {
        setError('folder picking requires the desktop shell or a browser with directory picker support.');
        setWorking(false);
        return;
      }
      setRecents(readBrowserRecents());
      setWorking(false);
      onOpen(picked);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setWorking(false);
    }
  };

  const forget = async (path: string) => {
    try {
      const forgetNative = tauriInvoke<void>('project_forget', { path });
      if (forgetNative) await forgetNative;
      browserProjectStore().delete(path);
      writeBrowserRecents(readBrowserRecents().filter((r) => r.path !== path));
      setRecents((current) => current.filter((r) => r.path !== path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (showNew) {
    return (
      <>
        <NewProjectWizard
          templates={templates}
          onCancel={() => setShowNew(false)}
          onCreated={(target) => onOpen(target)}
        />
      </>
    );
  }

  return (
    <div className="launcher" role="main" aria-label="polypore project launcher">
      <aside className="launcher__hero" aria-hidden="true">
        <div className="launcher__hero-image" />
      </aside>
      <section className="launcher__panel">
        <header className="launcher__header">
          <div className="launcher__brand">
            <PolyporeWordmark />
          </div>
          <p className="launcher__tagline">
            modular ide for agentic engineering. pick a project to drop into the workspace.
          </p>
        </header>

        <div className="launcher__actions">
          <button
            type="button"
            className="launcher__primary"
            onClick={pickFolder}
            disabled={working}
          >
            <span>open folder…</span>
            <small>choose an existing project</small>
          </button>
          <button
            type="button"
            className="launcher__secondary"
            onClick={() => setShowNew(true)}
            disabled={working}
          >
            <span>new project</span>
            <small>start from a template</small>
          </button>
          {onDismiss && (
            <button
              type="button"
              className="launcher__secondary"
              onClick={onDismiss}
              disabled={working}
              aria-label="close"
            >
              <span>close</span>
              <small>return to workspace</small>
            </button>
          )}
        </div>

        <section className="launcher__recents" aria-label="recent projects">
          <header className="launcher__recents-head">
            <h2>
              <span>recent projects</span>
              {recents.length > 0 && (
                <span className="launcher__recents-count">
                  {filter.trim() && filteredRecents.length !== recents.length
                    ? `${filteredRecents.length} of ${recents.length}`
                    : recents.length}
                </span>
              )}
            </h2>
            <input
              type="search"
              className="launcher__filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter by name or path…"
              aria-label="filter recent projects"
            />
          </header>
          {filteredRecents.length === 0 ? (
            <p className="launcher__empty">
              {recents.length === 0 ? (
                <>
                  <strong>no recent projects yet</strong>
                  open a folder or scaffold a new project from a template to get started.
                </>
              ) : (
                <>
                  <strong>no matches</strong>
                  nothing in your recents matches “{filter.trim()}”.
                </>
              )}
            </p>
          ) : (
            <div className="launcher__recents-scroll">
              {groupedRecents.map((group) => (
                <div key={group.id} className="launcher__recents-group">
                  <h3 className="launcher__recents-group-label">{group.label}</h3>
                  <ul className="launcher__recent-list">
                    {group.items.map((r) => (
                      <li
                        key={r.path}
                        className={`launcher__recent ${r.exists ? '' : 'launcher__recent--missing'}`}
                      >
                        <button
                          type="button"
                          className="launcher__recent-main"
                          onClick={() => openProject(r.path)}
                          disabled={!r.exists || working}
                          aria-label={`open ${r.name}`}
                          title={r.path}
                        >
                          <span className="launcher__recent-name">{r.name || 'project'}</span>
                          <span className="launcher__recent-path">{shortenPath(r.path)}</span>
                          <span className="launcher__recent-meta">
                            {r.exists ? formatTimestamp(r.last_opened) : 'missing'}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="launcher__recent-forget"
                          onClick={() => forget(r.path)}
                          aria-label={`forget ${r.name}`}
                          title="remove from recents"
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        <footer className="launcher__footer">
          {error && (
            <div className="launcher__error" role="alert">
              <span className="launcher__error-text">{error}</span>
              <button
                type="button"
                className="launcher__error-dismiss"
                onClick={() => setError(null)}
                aria-label="dismiss error"
                title="dismiss"
              >
                ×
              </button>
            </div>
          )}
        </footer>
      </section>
    </div>
  );
}

function NewProjectWizard({
  templates,
  onCancel,
  onCreated,
}: {
  templates: ProjectTemplate[];
  onCancel: () => void;
  onCreated: (target: LaunchTarget) => void;
}) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [selected, setSelected] = useState<string>(templates[0]?.id ?? 'blank');
  const [search, setSearch] = useState('');
  const [working, setWorking] = useState(false);
  const [log, setLog] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !working) {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [working, onCancel]);

  const trimmedName = name.trim();
  const nameInvalid = trimmedName.length > 0 && !PROJECT_NAME_PATTERN.test(trimmedName);

	  const categories = useMemo(() => {
	    const map = new Map<string, ProjectTemplate[]>();
	    for (const tpl of templates) {
	      const list = map.get(tpl.category) ?? [];
	      list.push(tpl);
	      map.set(tpl.category, list);
	    }
	    return [...map.entries()].sort(([left], [right]) => compareTemplateCategory(left, right));
	  }, [templates]);

  const filteredTemplates = useMemo(() => {
    if (!search.trim()) return templates;
    const needle = search.toLowerCase();
    return templates.filter((t) =>
      [t.label, t.category, t.language, t.summary, t.id].some((field) =>
        field.toLowerCase().includes(needle)));
  }, [templates, search]);

  const pickParent = async () => {
    try {
      const nativePick = tauriInvoke<string | null>('project_pick_folder');
      if (nativePick) {
        const result = await nativePick;
        if (result) setParent(result);
        return;
      }
      const picked = await pickBrowserFolder('readwrite');
      if (picked) {
        setParent(picked.path);
      } else {
        setError('folder picking requires the desktop shell or a browser with directory picker support.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const submit = async () => {
    if (!name.trim() || !parent.trim() || !selected) {
      setError('name, parent folder, and template are all required.');
      return;
    }
    setError(null);
    setWorking(true);
    setLog('starting…\n');
    try {
      const nativeCreate = tauriInvoke<ScaffoldOutcome>('project_create', {
        parent,
        name: name.trim(),
        templateId: selected,
      });
      if (nativeCreate) {
        const outcome = await nativeCreate;
        setLog(outcome.log);
        onCreated({ path: outcome.project.path, name: outcome.project.name });
        return;
      }
      if (selected !== 'blank') {
        throw new Error('this template needs the desktop shell so it can run its scaffold command.');
      }
      if (!PROJECT_NAME_PATTERN.test(name.trim())) {
        throw new Error('project name must start with a letter or number and can only contain letters, numbers, dots, underscores, and hyphens.');
      }
      const parentHandle = browserProjectStore().get(parent);
      if (!parentHandle) {
        throw new Error('pick a parent folder with the browse button before creating a browser project.');
      }
      const target = await createBrowserBlankProject(parentHandle, name.trim());
      setLog(`created ${target.name}\n`);
      onCreated(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const activeTemplate = templates.find((t) => t.id === selected);
  const usingFilter = search.trim().length > 0;

  const canSubmit = !working && trimmedName.length > 0 && !nameInvalid && parent.trim().length > 0 && Boolean(selected);

  const onFormKey = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Enter' && canSubmit) {
      const target = event.target as HTMLElement;
      if (target.tagName === 'TEXTAREA') return;
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="launcher launcher--wizard" role="main" aria-label="new project wizard">
      <aside className="launcher__hero" aria-hidden="true">
        <div className="launcher__hero-image" />
      </aside>
      <section className="launcher__panel">
        <header className="launcher__wizard-head">
          <button type="button" className="launcher__back" onClick={onCancel} disabled={working}>
            ← back
          </button>
          <h1>new project</h1>
        </header>

        <form
          className="launcher__wizard-grid"
          onSubmit={(e) => { e.preventDefault(); if (canSubmit) void submit(); }}
          onKeyDown={onFormKey}
        >
          <div className="launcher__wizard-form">
            <label className="launcher__field">
              <span>project name</span>
              <input
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-project"
                disabled={working}
                spellCheck={false}
                aria-invalid={nameInvalid}
              />
              {nameInvalid && (
                <span className="launcher__name-hint">
                  start with a letter or number; use only letters, numbers, dots, underscores, and hyphens.
                </span>
              )}
            </label>
            <label className="launcher__field">
              <span>parent folder</span>
              <div className="launcher__field-row">
                <input
                  value={parent}
                  onChange={(e) => setParent(e.target.value)}
                  placeholder="/home/you/projects"
                  disabled={working}
                  spellCheck={false}
                />
                <button type="button" onClick={pickParent} disabled={working}>browse…</button>
              </div>
            </label>

            <div className="launcher__field">
              <span>template</span>
              <input
                type="search"
                className="launcher__filter"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`search ${templates.length || '50+'} templates…`}
                aria-label="filter templates"
              />
            </div>

            <div className="launcher__templates" role="listbox" aria-label="project templates">
              {usingFilter ? (
                filteredTemplates.length === 0 ? (
                  <p className="launcher__templates-empty">no templates match “{search.trim()}”.</p>
                ) : (
                  <div className="launcher__template-grid">
                    {filteredTemplates.map((tpl) => (
                      <TemplateCard
                        key={tpl.id}
                        template={tpl}
                        selected={selected === tpl.id}
                        onSelect={() => setSelected(tpl.id)}
                      />
                    ))}
                  </div>
                )
              ) : (
                categories.map(([category, list]) => (
                  <div key={category} className="launcher__template-group">
                    <h3>{category}</h3>
                    <div className="launcher__template-grid">
                      {list.map((tpl) => (
                        <TemplateCard
                          key={tpl.id}
                          template={tpl}
                          selected={selected === tpl.id}
                          onSelect={() => setSelected(tpl.id)}
                        />
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <aside className="launcher__wizard-summary">
            {activeTemplate ? (
              <>
                <h2>{activeTemplate.label}</h2>
                <p>{activeTemplate.summary}</p>
                <dl>
                  <div><dt>language</dt><dd>{activeTemplate.language}</dd></div>
                  <div><dt>requires</dt><dd>{activeTemplate.requires || 'nothing extra'}</dd></div>
                  <div>
                    <dt>scaffold</dt>
                    <dd>
                      <code>
                        {activeTemplate.command.startsWith('blank')
                          ? '(built-in inline scaffold)'
                          : activeTemplate.command.replace('{name}', trimmedName || '<name>')}
                      </code>
                    </dd>
                  </div>
                </dl>
              </>
            ) : (
              <p>pick a template to see details.</p>
            )}
            <button
              type="submit"
              className="launcher__primary launcher__create"
              disabled={!canSubmit}
            >
              {working ? 'scaffolding…' : 'create project'}
            </button>
            {log && (
              <pre className="launcher__wizard-log" aria-label="scaffold log">{log}</pre>
            )}
            {error && (
              <div className="launcher__error" role="alert">
                <span className="launcher__error-text">{error}</span>
                <button
                  type="button"
                  className="launcher__error-dismiss"
                  onClick={() => setError(null)}
                  aria-label="dismiss error"
                  title="dismiss"
                >
                  ×
                </button>
              </div>
            )}
          </aside>
        </form>
      </section>
    </div>
  );
}

function TemplateCard({
  template,
  selected,
  onSelect,
}: {
  template: ProjectTemplate;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`launcher__template ${selected ? 'launcher__template--active' : ''}`}
      onClick={onSelect}
    >
      <span className="launcher__template-label">{template.label}</span>
      <span className="launcher__template-lang">{template.language}</span>
    </button>
  );
}
