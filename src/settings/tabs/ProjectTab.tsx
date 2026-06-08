import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GlobalSettingsServices } from './types';
import {
  DIAGNOSTICS_CONFIG_PATH,
  DIAGNOSTICS_PARSERS,
  EMPTY_DIAGNOSTICS_FORM,
  EMPTY_FORMATTER_FORM,
  EMPTY_RUNTIME_FORM,
  EMPTY_SERVER_FORM,
  EMPTY_VERIFY_FORM,
  FILE_TREE_CONFIG_PATH,
  FORMATTERS_CONFIG_PATH,
  LANGUAGE_SERVERS_CONFIG_PATH,
  RUNTIME_CONFIG_PATH,
  RUNTIME_KINDS,
  VERIFY_CONFIG_PATH,
  diagnosticsEntryFromForm,
  fileTreeConfigCount,
  fileTreeConfigFromForm,
  fileTreeConfigRows,
  fileTreeFormFromConfig,
  formatterEntryFromForm,
  normalizeDiagnosticsConfig,
  normalizeFileTreeConfig,
  normalizeFormatterConfig,
  normalizeLanguageServerConfig,
  normalizeRuntimeConfig,
  normalizeVerifyCommands,
  readProjectJson,
  runtimeEntryFromForm,
  serverEntryFromForm,
  verifyEntryFromForm,
  writeProjectJson,
  type DiagnosticsConfig,
  type DiagnosticsFormState,
  type FileTreeConfig,
  type FileTreeFormState,
  type FormatterConfig,
  type FormatterFormState,
  type LanguageServerConfig,
  type ProjectSettingsGroup,
  type RuntimeConfig,
  type RuntimeFormState,
  type RuntimeKind,
  type ServerFormState,
  type VerifyCommandConfig,
  type VerifyFormState,
} from './project/projectConfig';

export type { ProjectSettingsGroup } from './project/projectConfig';

export interface ProjectTabProps {
  services: GlobalSettingsServices;
  setNotice: (value: string) => void;
  focusGroup?: ProjectSettingsGroup;
}

const SUBNAV: Array<{ group: ProjectSettingsGroup; label: string }> = [
  { group: 'runtimes', label: 'runtimes' },
  { group: 'language-servers', label: 'servers' },
  { group: 'verify', label: 'verify' },
  { group: 'diagnostics', label: 'diagnostics' },
  { group: 'formatters', label: 'formatters' },
  { group: 'file-tree', label: 'file tree' },
];

export function ProjectTab({ services, setNotice, focusGroup }: ProjectTabProps) {
  const { host } = services;
  const rootRef = useRef<HTMLElement | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>({ runtimes: [] });
  const [languageConfig, setLanguageConfig] = useState<LanguageServerConfig>({ servers: [] });
  const [verifyCommands, setVerifyCommands] = useState<VerifyCommandConfig[]>([]);
  const [diagnosticsConfig, setDiagnosticsConfig] = useState<DiagnosticsConfig>({ sources: [] });
  const [formatterConfig, setFormatterConfig] = useState<FormatterConfig>({ formatters: [] });
  const [fileTreeConfig, setFileTreeConfig] = useState<FileTreeConfig>({});

  const [runtimeForm, setRuntimeForm] = useState(EMPTY_RUNTIME_FORM);
  const [serverForm, setServerForm] = useState(EMPTY_SERVER_FORM);
  const [verifyForm, setVerifyForm] = useState(EMPTY_VERIFY_FORM);
  const [diagnosticsForm, setDiagnosticsForm] = useState(EMPTY_DIAGNOSTICS_FORM);
  const [formatterForm, setFormatterForm] = useState(EMPTY_FORMATTER_FORM);
  const [fileTreeForm, setFileTreeForm] = useState<FileTreeFormState>(fileTreeFormFromConfig({}));

  const [openForm, setOpenForm] = useState<ProjectSettingsGroup | ''>('');
  const [highlightGroup, setHighlightGroup] = useState<ProjectSettingsGroup | ''>('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      readProjectJson(host, RUNTIME_CONFIG_PATH, { runtimes: [] }, normalizeRuntimeConfig),
      readProjectJson(host, LANGUAGE_SERVERS_CONFIG_PATH, { servers: [] }, normalizeLanguageServerConfig),
      readProjectJson(host, VERIFY_CONFIG_PATH, [], normalizeVerifyCommands),
      readProjectJson(host, DIAGNOSTICS_CONFIG_PATH, { sources: [] }, normalizeDiagnosticsConfig),
      readProjectJson(host, FORMATTERS_CONFIG_PATH, { formatters: [] }, normalizeFormatterConfig),
      readProjectJson(host, FILE_TREE_CONFIG_PATH, {}, normalizeFileTreeConfig),
    ]).then(([runtimes, servers, checks, diagnostics, formatters, fileTree]) => {
      if (cancelled) return;
      setRuntimeConfig(runtimes);
      setLanguageConfig(servers);
      setVerifyCommands(checks);
      setDiagnosticsConfig(diagnostics);
      setFormatterConfig(formatters);
      setFileTreeConfig(fileTree);
      setFileTreeForm(fileTreeFormFromConfig(fileTree));
    }).catch((err) => {
      if (!cancelled) setNotice(err instanceof Error ? err.message : 'project settings failed to load');
    });
    return () => { cancelled = true; };
  }, [host, setNotice]);

  const counts = useMemo(() => ({
    runtimes: runtimeConfig.runtimes.length,
    'language-servers': languageConfig.servers.length,
    verify: verifyCommands.length,
    diagnostics: diagnosticsConfig.sources.length,
    formatters: formatterConfig.formatters.length,
    'file-tree': fileTreeConfigCount(fileTreeConfig),
  } satisfies Record<ProjectSettingsGroup, number>), [
    diagnosticsConfig.sources.length, fileTreeConfig,
    formatterConfig.formatters.length, languageConfig.servers.length,
    runtimeConfig.runtimes.length, verifyCommands.length,
  ]);

  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

  const focusProjectGroup = (group: ProjectSettingsGroup) => {
    const target = rootRef.current?.querySelector<HTMLElement>(`[data-settings-group="${group}"]`);
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    setHighlightGroup(group);
    window.setTimeout(() => setHighlightGroup(''), 1400);
  };

  useEffect(() => {
    if (!focusGroup) return undefined;
    focusProjectGroup(focusGroup);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusGroup]);

  const toggleForm = (group: ProjectSettingsGroup) => {
    setOpenForm((current) => {
      if (current === group) return '';
      if (group === 'file-tree') setFileTreeForm(fileTreeFormFromConfig(fileTreeConfig));
      return group;
    });
  };

  const closeForm = () => setOpenForm('');

  /* ── commit handlers (reuse the canonical builders + writers) ───────────── */

  const addRuntime = async () => {
    const entry = runtimeEntryFromForm(runtimeForm);
    if (!entry) { setNotice('runtime command is required'); return; }
    const next = { runtimes: [...runtimeConfig.runtimes, entry] };
    await writeProjectJson(host, RUNTIME_CONFIG_PATH, next);
    setRuntimeConfig(next);
    setRuntimeForm(EMPTY_RUNTIME_FORM);
    closeForm();
    setNotice('runtime command saved');
  };

  const removeRuntime = async (index: number) => {
    const next = { runtimes: runtimeConfig.runtimes.filter((_, i) => i !== index) };
    await writeProjectJson(host, RUNTIME_CONFIG_PATH, next);
    setRuntimeConfig(next);
    setNotice('runtime command removed');
  };

  const addServer = async () => {
    const entry = serverEntryFromForm(serverForm);
    if ('error' in entry) { setNotice(entry.error); return; }
    const next = { servers: [...languageConfig.servers.filter((server) => server.id !== entry.id), entry] };
    await writeProjectJson(host, LANGUAGE_SERVERS_CONFIG_PATH, next);
    setLanguageConfig(next);
    setServerForm(EMPTY_SERVER_FORM);
    closeForm();
    setNotice('language server saved');
  };

  const removeServer = async (id: string) => {
    const next = { servers: languageConfig.servers.filter((server) => server.id !== id) };
    await writeProjectJson(host, LANGUAGE_SERVERS_CONFIG_PATH, next);
    setLanguageConfig(next);
    setNotice('language server removed');
  };

  const addVerify = async () => {
    const entry = verifyEntryFromForm(verifyForm);
    if (!entry) { setNotice('check id and command are required'); return; }
    const next = [...verifyCommands.filter((check) => check.id !== entry.id), entry];
    await writeProjectJson(host, VERIFY_CONFIG_PATH, next);
    setVerifyCommands(next);
    setVerifyForm(EMPTY_VERIFY_FORM);
    closeForm();
    setNotice('verify command saved');
  };

  const removeVerify = async (id: string) => {
    const next = verifyCommands.filter((check) => check.id !== id);
    await writeProjectJson(host, VERIFY_CONFIG_PATH, next);
    setVerifyCommands(next);
    setNotice('verify command removed');
  };

  const addDiagnostics = async () => {
    const entry = diagnosticsEntryFromForm(diagnosticsForm);
    if (!entry) { setNotice('diagnostics source id and command are required'); return; }
    const next = { sources: [...diagnosticsConfig.sources.filter((source) => source.id !== entry.id), entry] };
    await writeProjectJson(host, DIAGNOSTICS_CONFIG_PATH, next);
    setDiagnosticsConfig(next);
    setDiagnosticsForm(EMPTY_DIAGNOSTICS_FORM);
    closeForm();
    setNotice('diagnostics source saved');
  };

  const removeDiagnostics = async (id: string) => {
    const next = { sources: diagnosticsConfig.sources.filter((source) => source.id !== id) };
    await writeProjectJson(host, DIAGNOSTICS_CONFIG_PATH, next);
    setDiagnosticsConfig(next);
    setNotice('diagnostics source removed');
  };

  const addFormatter = async () => {
    const entry = formatterEntryFromForm(formatterForm);
    if (!entry) { setNotice('formatter id and command are required'); return; }
    const next = { formatters: [...formatterConfig.formatters.filter((formatter) => formatter.id !== entry.id), entry] };
    await writeProjectJson(host, FORMATTERS_CONFIG_PATH, next);
    setFormatterConfig(next);
    setFormatterForm(EMPTY_FORMATTER_FORM);
    closeForm();
    setNotice('formatter command saved');
  };

  const removeFormatter = async (id: string) => {
    const next = { formatters: formatterConfig.formatters.filter((formatter) => formatter.id !== id) };
    await writeProjectJson(host, FORMATTERS_CONFIG_PATH, next);
    setFormatterConfig(next);
    setNotice('formatter command removed');
  };

  const saveFileTreeConfig = async () => {
    const next = fileTreeConfigFromForm(fileTreeForm);
    await writeProjectJson(host, FILE_TREE_CONFIG_PATH, next);
    setFileTreeConfig(next);
    setFileTreeForm(fileTreeFormFromConfig(next));
    closeForm();
    setNotice('file tree filters saved');
  };

  return (
    <section className="surface-page project-page" aria-label="project" ref={rootRef}>
      <nav className="project-subnav" aria-label="project sections">
        {SUBNAV.map((item) => (
          <button key={item.group} type="button" onClick={() => focusProjectGroup(item.group)}>
            {item.label}
            <span className="project-subnav__count">{counts[item.group]}</span>
          </button>
        ))}
        <span className="project-subnav__total">{total} entries</span>
      </nav>

      <p className="project-config-note">
        these are explicit project overrides in `.polypore`. auto-detected package scripts and checks can still appear in panels even when a group here is empty.
      </p>

      <Group
        groupKey="runtimes"
        title="runtime commands"
        path={RUNTIME_CONFIG_PATH}
        description="overrides and preferred launch commands. preview still detects package scripts when this file is empty."
        highlight={highlightGroup === 'runtimes'}
        open={openForm === 'runtimes'}
        onToggle={() => toggleForm('runtimes')}
        empty="no runtime commands configured"
        rows={runtimeConfig.runtimes.map((runtime, index) => ({
          key: `${runtime.label}:${index}`,
          title: runtime.label,
          detail: runtime.commands.map((command) => command.command).join(', '),
          onRemove: () => void removeRuntime(index),
        }))}
        form={(
          <Form onCancel={closeForm} onCommit={() => void addRuntime()} commitLabel="add runtime">
            <Field label="label">
              <input className="surface-input" aria-label="runtime label" placeholder="web dev" value={runtimeForm.label}
                onChange={(event) => setRuntimeForm((current) => ({ ...current, label: event.target.value }))} />
            </Field>
            <Field label="command name">
              <input className="surface-input" aria-label="runtime command name" placeholder="dev" value={runtimeForm.commandName}
                onChange={(event) => setRuntimeForm((current) => ({ ...current, commandName: event.target.value }))} />
            </Field>
            <Field label="kind">
              <select className="surface-select" aria-label="runtime kind" value={runtimeForm.kind}
                onChange={(event) => setRuntimeForm((current) => ({ ...current, kind: event.target.value as RuntimeKind }))}>
                {RUNTIME_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
            </Field>
            <Field label="command" wide>
              <input className="surface-input" aria-label="runtime command" placeholder="npm run dev" value={runtimeForm.command}
                onChange={(event) => setRuntimeForm((current) => ({ ...current, command: event.target.value }))} />
            </Field>
            <Field label="url">
              <input className="surface-input" aria-label="runtime url" placeholder="http://localhost:5173" value={runtimeForm.url}
                onChange={(event) => setRuntimeForm((current) => ({ ...current, url: event.target.value }))} />
            </Field>
          </Form>
        )}
      />

      <Group
        groupKey="language-servers"
        title="language servers"
        path={LANGUAGE_SERVERS_CONFIG_PATH}
        description="project-specific lsp commands keyed by file extension, filename, or language id."
        highlight={highlightGroup === 'language-servers'}
        open={openForm === 'language-servers'}
        onToggle={() => toggleForm('language-servers')}
        empty="no language servers configured"
        rows={languageConfig.servers.map((server) => ({
          key: server.id,
          title: server.id,
          detail: [server.command, ...(server.extensions ?? []), ...(server.filenames ?? [])].join(' · '),
          onRemove: () => void removeServer(server.id),
        }))}
        form={(
          <Form onCancel={closeForm} onCommit={() => void addServer()} commitLabel="add server">
            <Field label="id"><input className="surface-input" aria-label="language server id" placeholder="roc-lsp" value={serverForm.id}
              onChange={(event) => setServerForm((current) => ({ ...current, id: event.target.value }))} /></Field>
            <Field label="command"><input className="surface-input" aria-label="language server command" placeholder="roc_language_server" value={serverForm.command}
              onChange={(event) => setServerForm((current) => ({ ...current, command: event.target.value }))} /></Field>
            <Field label="args"><input className="surface-input" aria-label="language server args" placeholder="--stdio" value={serverForm.args}
              onChange={(event) => setServerForm((current) => ({ ...current, args: event.target.value }))} /></Field>
            <Field label="extensions"><input className="surface-input" aria-label="language server extensions" placeholder=".roc, .rocx" value={serverForm.extensions}
              onChange={(event) => setServerForm((current) => ({ ...current, extensions: event.target.value }))} /></Field>
            <Field label="filenames"><input className="surface-input" aria-label="language server filenames" placeholder="BUILD, WORKSPACE" value={serverForm.filenames}
              onChange={(event) => setServerForm((current) => ({ ...current, filenames: event.target.value }))} /></Field>
            <Field label="language ids"><input className="surface-input" aria-label="language server language ids" placeholder="roc=roc" value={serverForm.languageIds}
              onChange={(event) => setServerForm((current) => ({ ...current, languageIds: event.target.value }))} /></Field>
          </Form>
        )}
      />

      <Group
        groupKey="verify"
        title="verify commands"
        path={VERIFY_CONFIG_PATH}
        description="named checks that the verify panel and agents can run on demand."
        highlight={highlightGroup === 'verify'}
        open={openForm === 'verify'}
        onToggle={() => toggleForm('verify')}
        empty="no verify commands configured"
        rows={verifyCommands.map((check) => ({
          key: check.id,
          title: check.label || check.id,
          detail: check.command,
          badge: check.required ? 'required' : 'optional',
          onRemove: () => void removeVerify(check.id),
        }))}
        form={(
          <Form onCancel={closeForm} onCommit={() => void addVerify()} commitLabel="add check">
            <Field label="id"><input className="surface-input" aria-label="verify id" placeholder="typecheck" value={verifyForm.id}
              onChange={(event) => setVerifyForm((current) => ({ ...current, id: event.target.value }))} /></Field>
            <Field label="label"><input className="surface-input" aria-label="verify label" placeholder="type check" value={verifyForm.label}
              onChange={(event) => setVerifyForm((current) => ({ ...current, label: event.target.value }))} /></Field>
            <Field label="command" wide><input className="surface-input" aria-label="verify command" placeholder="npm run typecheck" value={verifyForm.command}
              onChange={(event) => setVerifyForm((current) => ({ ...current, command: event.target.value }))} /></Field>
            <label className="surface-check">
              <input type="checkbox" checked={verifyForm.required}
                onChange={(event) => setVerifyForm((current) => ({ ...current, required: event.target.checked }))} />
              required
            </label>
          </Form>
        )}
      />

      <Group
        groupKey="diagnostics"
        title="diagnostics sources"
        path={DIAGNOSTICS_CONFIG_PATH}
        description="problem-list producers and parsers for compilers, linters, and deep scans."
        highlight={highlightGroup === 'diagnostics'}
        open={openForm === 'diagnostics'}
        onToggle={() => toggleForm('diagnostics')}
        empty="no diagnostics sources configured"
        rows={diagnosticsConfig.sources.map((source) => ({
          key: source.id,
          title: source.id,
          detail: [source.command, source.parser ?? 'generic-colon', source.deep ? 'deep' : 'always'].join(' · '),
          onRemove: () => void removeDiagnostics(source.id),
        }))}
        form={(
          <Form onCancel={closeForm} onCommit={() => void addDiagnostics()} commitLabel="add source">
            <Field label="id"><input className="surface-input" aria-label="diagnostics id" placeholder="lint" value={diagnosticsForm.id}
              onChange={(event) => setDiagnosticsForm((current) => ({ ...current, id: event.target.value }))} /></Field>
            <Field label="command" wide><input className="surface-input" aria-label="diagnostics command" placeholder="mylang check --format=gcc" value={diagnosticsForm.command}
              onChange={(event) => setDiagnosticsForm((current) => ({ ...current, command: event.target.value }))} /></Field>
            <Field label="parser">
              <select className="surface-select" aria-label="diagnostics parser" value={diagnosticsForm.parser}
                onChange={(event) => setDiagnosticsForm((current) => ({ ...current, parser: event.target.value }))}>
                {DIAGNOSTICS_PARSERS.map((parser) => <option key={parser} value={parser}>{parser}</option>)}
              </select>
            </Field>
            <label className="surface-check">
              <input type="checkbox" checked={diagnosticsForm.deep}
                onChange={(event) => setDiagnosticsForm((current) => ({ ...current, deep: event.target.checked }))} />
              deep scan only
            </label>
          </Form>
        )}
      />

      <Group
        groupKey="formatters"
        title="formatter commands"
        path={FORMATTERS_CONFIG_PATH}
        description="named formatter commands and the files they apply to."
        highlight={highlightGroup === 'formatters'}
        open={openForm === 'formatters'}
        onToggle={() => toggleForm('formatters')}
        empty="no formatter commands configured"
        rows={formatterConfig.formatters.map((formatter) => ({
          key: formatter.id,
          title: formatter.label || formatter.id,
          detail: [formatter.command, ...(formatter.extensions ?? []), ...(formatter.filenames ?? [])].join(' · '),
          onRemove: () => void removeFormatter(formatter.id),
        }))}
        form={(
          <Form onCancel={closeForm} onCommit={() => void addFormatter()} commitLabel="add formatter">
            <Field label="id"><input className="surface-input" aria-label="formatter id" placeholder="prettier" value={formatterForm.id}
              onChange={(event) => setFormatterForm((current) => ({ ...current, id: event.target.value }))} /></Field>
            <Field label="label"><input className="surface-input" aria-label="formatter label" placeholder="prettier" value={formatterForm.label}
              onChange={(event) => setFormatterForm((current) => ({ ...current, label: event.target.value }))} /></Field>
            <Field label="command" wide><input className="surface-input" aria-label="formatter command" placeholder="prettier --write" value={formatterForm.command}
              onChange={(event) => setFormatterForm((current) => ({ ...current, command: event.target.value }))} /></Field>
            <Field label="extensions"><input className="surface-input" aria-label="formatter extensions" placeholder=".ts, .tsx" value={formatterForm.extensions}
              onChange={(event) => setFormatterForm((current) => ({ ...current, extensions: event.target.value }))} /></Field>
            <Field label="filenames"><input className="surface-input" aria-label="formatter filenames" placeholder="Makefile" value={formatterForm.filenames}
              onChange={(event) => setFormatterForm((current) => ({ ...current, filenames: event.target.value }))} /></Field>
          </Form>
        )}
      />

      <Group
        groupKey="file-tree"
        title="file tree filters"
        path={FILE_TREE_CONFIG_PATH}
        description="workspace file discovery filters for source, generated, text, and binary files."
        highlight={highlightGroup === 'file-tree'}
        open={openForm === 'file-tree'}
        onToggle={() => toggleForm('file-tree')}
        addLabel={fileTreeConfigCount(fileTreeConfig) > 0 ? 'edit' : undefined}
        empty="no file tree filters configured"
        rows={fileTreeConfigRows(fileTreeConfig).map((row) => ({ key: row.id, title: row.id, detail: row.detail }))}
        form={(
          <Form onCancel={closeForm} onCommit={() => void saveFileTreeConfig()} commitLabel="save filters">
            <Field label="include dirs" wide><input className="surface-input" aria-label="file tree include dirs" placeholder="src, packages" value={fileTreeForm.includeDirs}
              onChange={(event) => setFileTreeForm((current) => ({ ...current, includeDirs: event.target.value }))} /></Field>
            <Field label="exclude dirs" wide><input className="surface-input" aria-label="file tree exclude dirs" placeholder="node_modules, dist" value={fileTreeForm.excludeDirs}
              onChange={(event) => setFileTreeForm((current) => ({ ...current, excludeDirs: event.target.value }))} /></Field>
            <Field label="text extensions" wide><input className="surface-input" aria-label="file tree text extensions" placeholder=".roc, .rlib" value={fileTreeForm.textExtensions}
              onChange={(event) => setFileTreeForm((current) => ({ ...current, textExtensions: event.target.value }))} /></Field>
            <Field label="binary extensions" wide><input className="surface-input" aria-label="file tree binary extensions" placeholder=".snap, .png" value={fileTreeForm.binaryExtensions}
              onChange={(event) => setFileTreeForm((current) => ({ ...current, binaryExtensions: event.target.value }))} /></Field>
          </Form>
        )}
      />
    </section>
  );
}

type GroupRow = { key: string; title: string; detail: string; badge?: string; onRemove?: () => void };

function Group({
  groupKey, title, path, description, highlight, open, onToggle, empty, rows, form, addLabel,
}: {
  groupKey: ProjectSettingsGroup;
  title: string;
  path: string;
  description?: string;
  highlight: boolean;
  open: boolean;
  onToggle: () => void;
  empty: string;
  rows: GroupRow[];
  form: ReactNode;
  addLabel?: string;
}) {
  const toggleText = open ? '× close' : `+ ${addLabel ?? 'add'}`;
  return (
    <section
      className={`surface-section project-group${highlight ? ' settings-fieldset--focus' : ''}`}
      role="group"
      aria-label={title}
      data-settings-group={groupKey}
    >
      <div className="surface-section__head">
        <h2>{title}</h2>
        <span className="project-group__meta">
          <code className="surface-section__path">{path}</code>
          <button
            type="button"
            className="surface-btn surface-btn--sm surface-btn--quiet"
            aria-label={`add to ${title}`}
            aria-expanded={open}
            onClick={onToggle}
          >
            {toggleText}
          </button>
        </span>
      </div>

      {description && <p className="project-group__description">{description}</p>}

      {open && form}

      {rows.length > 0 ? (
        <div className="surface-list">
          {rows.map((row) => (
            <div className="surface-row" key={row.key}>
              <span className="surface-row__main">
                <strong>{row.title}</strong>
                {row.detail && <code>{row.detail}</code>}
              </span>
              <span className="surface-row__actions">
                {row.badge && <span className="surface-pill">{row.badge}</span>}
                {row.onRemove && (
                  <button type="button" className="surface-btn surface-btn--sm surface-btn--quiet"
                    aria-label={`remove ${row.title}`} onClick={row.onRemove}>remove</button>
                )}
              </span>
            </div>
          ))}
        </div>
      ) : (
        !open && (
          <p className="surface-empty">
            <span>{empty}</span>
            <button type="button" className="surface-btn surface-btn--sm" onClick={onToggle}>+ {addLabel ?? 'add'}</button>
          </p>
        )
      )}
    </section>
  );
}

function Form({ children, onCancel, onCommit, commitLabel }: {
  children: ReactNode;
  onCancel: () => void;
  onCommit: () => void;
  commitLabel: string;
}) {
  return (
    <div className="surface-inline-form">
      <div className="surface-inline-form__grid">{children}</div>
      <div className="surface-inline-form__actions">
        <button type="button" className="surface-btn surface-btn--sm surface-btn--quiet" onClick={onCancel}>cancel</button>
        <button type="button" className="surface-btn surface-btn--sm surface-btn--accent" onClick={onCommit}>{commitLabel}</button>
      </div>
    </div>
  );
}

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`surface-field${wide ? ' surface-field--wide' : ''}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}
