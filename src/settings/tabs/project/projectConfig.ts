/* Pure data layer for the project (.polypore/*.json) settings.
 *
 * Extracted from the old monolithic ProjectTab so the read/normalize/write
 * contracts live in one tested place and the React tab is just UI. The write
 * shapes here are the canonical ones the native loaders expect — do not change
 * them without updating the Rust side + the contract tests. */

import type { GlobalSettingsServices } from '../types';

export type ProjectSettingsGroup =
  | 'runtimes'
  | 'language-servers'
  | 'verify'
  | 'diagnostics'
  | 'formatters'
  | 'file-tree';

export type RuntimeKind = 'site' | 'desktop' | 'mobile' | 'cli' | 'test' | 'game';

export type RuntimeCommandConfig = { name: string; command: string; kind?: RuntimeKind };
export type RuntimeConfigEntry = { label: string; hint?: string; defaultUrl?: string; commands: RuntimeCommandConfig[] };
export type RuntimeConfig = { runtimes: RuntimeConfigEntry[] };

export type LanguageServerConfigEntry = {
  id: string;
  command: string;
  args?: string[];
  extensions?: string[];
  filenames?: string[];
  languageIds?: Record<string, string>;
};
export type LanguageServerConfig = { servers: LanguageServerConfigEntry[] };

export type VerifyCommandConfig = { id: string; label?: string; command: string; required?: boolean };

export type DiagnosticsSourceConfig = { id: string; command: string; parser?: string; deep?: boolean; timeoutSecs?: number };
export type DiagnosticsConfig = { sources: DiagnosticsSourceConfig[] };

export type FormatterConfigEntry = { id: string; label?: string; command: string; extensions?: string[]; filenames?: string[] };
export type FormatterConfig = { formatters: FormatterConfigEntry[] };

export type FileTreeConfig = {
  includeDirs?: string[];
  excludeDirs?: string[];
  textExtensions?: string[];
  binaryExtensions?: string[];
};

export type RuntimeFormState = { label: string; commandName: string; command: string; kind: RuntimeKind; url: string };
export type ServerFormState = { id: string; command: string; args: string; extensions: string; filenames: string; languageIds: string };
export type VerifyFormState = { id: string; command: string; label: string; required: boolean };
export type DiagnosticsFormState = { id: string; command: string; parser: string; deep: boolean };
export type FormatterFormState = { id: string; command: string; label: string; extensions: string; filenames: string };
export type FileTreeFormState = { includeDirs: string; excludeDirs: string; textExtensions: string; binaryExtensions: string };

export const DIAGNOSTICS_PARSERS = [
  'generic-colon',
  'tsc',
  'eslint-json',
  'cargo-json',
  'msbuild',
  'jvm',
  'dart',
  'php',
  'python-compile',
  'bash',
  'luac',
  'npm-audit',
  'composer',
] as const;

export const RUNTIME_KINDS: RuntimeKind[] = ['site', 'desktop', 'mobile', 'cli', 'test', 'game'];

export const RUNTIME_CONFIG_PATH = '.polypore/runtime.json';
export const LANGUAGE_SERVERS_CONFIG_PATH = '.polypore/language-servers.json';
export const VERIFY_CONFIG_PATH = '.polypore/verify.json';
export const DIAGNOSTICS_CONFIG_PATH = '.polypore/diagnostics.json';
export const FORMATTERS_CONFIG_PATH = '.polypore/formatters.json';
export const FILE_TREE_CONFIG_PATH = '.polypore/file-tree.json';

export const EMPTY_RUNTIME_FORM: RuntimeFormState = { label: '', commandName: '', command: '', kind: 'site', url: '' };
export const EMPTY_SERVER_FORM: ServerFormState = { id: '', command: '', args: '', extensions: '', filenames: '', languageIds: '' };
export const EMPTY_VERIFY_FORM: VerifyFormState = { id: '', command: '', label: '', required: true };
export const EMPTY_DIAGNOSTICS_FORM: DiagnosticsFormState = { id: '', command: '', parser: 'generic-colon', deep: false };
export const EMPTY_FORMATTER_FORM: FormatterFormState = { id: '', command: '', label: '', extensions: '', filenames: '' };
export const EMPTY_FILE_TREE_FORM: FileTreeFormState = { includeDirs: '', excludeDirs: '', textExtensions: '', binaryExtensions: '' };

const FULL_DOCUMENT_RANGE = {
  start: { line: 0, column: 0 },
  end: { line: 1_000_000, column: 0 },
};

type Host = GlobalSettingsServices['host'];

export async function readProjectJson<T>(
  host: Host,
  path: string,
  fallback: T,
  normalize: (value: unknown) => T,
): Promise<T> {
  try {
    const file = await host.editor.read(path);
    return normalize(JSON.parse(file.content || 'null'));
  } catch {
    return fallback;
  }
}

export async function writeProjectJson(host: Host, path: string, value: unknown) {
  await host.editor.applyEdit(path, [{
    range: FULL_DOCUMENT_RANGE,
    newText: `${JSON.stringify(value, null, 2)}\n`,
  }]);
}

/* ── entry builders (form → config entry) ──────────────────────────────────── */

export function runtimeEntryFromForm(form: RuntimeFormState): RuntimeConfigEntry | null {
  const command = form.command.trim();
  if (!command) return null;
  return {
    label: form.label.trim() || 'custom runtime',
    hint: form.commandName.trim() || undefined,
    defaultUrl: form.url.trim() || undefined,
    commands: [{
      name: form.commandName.trim() || commandNameFromCommand(command),
      command,
      kind: form.kind,
    }],
  };
}

export function serverEntryFromForm(form: ServerFormState): LanguageServerConfigEntry | { error: string } {
  const id = form.id.trim();
  const command = form.command.trim();
  const extensions = splitCsv(form.extensions);
  const filenames = splitCsv(form.filenames);
  if (!id || !command) return { error: 'language server id and command are required' };
  if (extensions.length === 0 && filenames.length === 0) return { error: 'language server needs extensions or filenames' };
  return compactServer({ id, command, args: splitArgs(form.args), extensions, filenames, languageIds: splitMapping(form.languageIds) });
}

export function verifyEntryFromForm(form: VerifyFormState): VerifyCommandConfig | null {
  const id = form.id.trim();
  const command = form.command.trim();
  if (!id || !command) return null;
  return { id, label: form.label.trim() || id, command, required: form.required };
}

export function diagnosticsEntryFromForm(form: DiagnosticsFormState): DiagnosticsSourceConfig | null {
  const id = form.id.trim();
  const command = form.command.trim();
  if (!id || !command) return null;
  const parser = form.parser.trim() || 'generic-colon';
  return {
    id,
    command,
    ...(parser !== 'generic-colon' ? { parser } : {}),
    ...(form.deep ? { deep: true } : {}),
  };
}

export function formatterEntryFromForm(form: FormatterFormState): FormatterConfigEntry | null {
  const id = form.id.trim();
  const command = form.command.trim();
  if (!id || !command) return null;
  return compactFormatter({
    id,
    label: form.label.trim() || id,
    command,
    extensions: splitCsv(form.extensions),
    filenames: splitList(form.filenames),
  });
}

export function fileTreeConfigFromForm(form: FileTreeFormState): FileTreeConfig {
  return compactFileTreeConfig({
    includeDirs: splitList(form.includeDirs),
    excludeDirs: splitList(form.excludeDirs),
    textExtensions: splitCsv(form.textExtensions).map(stripLeadingDot),
    binaryExtensions: splitCsv(form.binaryExtensions).map(stripLeadingDot),
  });
}

/* ── normalizers ───────────────────────────────────────────────────────────── */

export function normalizeRuntimeConfig(value: unknown): RuntimeConfig {
  const runtimes = value && typeof value === 'object' && Array.isArray((value as RuntimeConfig).runtimes)
    ? (value as RuntimeConfig).runtimes
    : [];
  return {
    runtimes: runtimes.flatMap((runtime) => {
      if (!runtime || typeof runtime !== 'object') return [];
      const candidate = runtime as Partial<RuntimeConfigEntry>;
      const label = typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.trim() : 'custom runtime';
      const commands = Array.isArray(candidate.commands) ? candidate.commands.flatMap(normalizeRuntimeCommand) : [];
      if (commands.length === 0) return [];
      return [{
        label,
        hint: typeof candidate.hint === 'string' && candidate.hint.trim() ? candidate.hint.trim() : undefined,
        defaultUrl: typeof candidate.defaultUrl === 'string' && candidate.defaultUrl.trim() ? candidate.defaultUrl.trim() : undefined,
        commands,
      }];
    }),
  };
}

function normalizeRuntimeCommand(value: unknown): RuntimeCommandConfig[] {
  if (!value || typeof value !== 'object') return [];
  const candidate = value as Partial<RuntimeCommandConfig>;
  if (typeof candidate.command !== 'string' || !candidate.command.trim()) return [];
  const command = candidate.command.trim();
  return [{
    name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : commandNameFromCommand(command),
    command,
    kind: RUNTIME_KINDS.includes(candidate.kind as RuntimeKind) ? candidate.kind as RuntimeKind : 'cli',
  }];
}

export function normalizeLanguageServerConfig(value: unknown): LanguageServerConfig {
  const servers = value && typeof value === 'object' && Array.isArray((value as LanguageServerConfig).servers)
    ? (value as LanguageServerConfig).servers
    : [];
  return {
    servers: servers.flatMap((server) => {
      if (!server || typeof server !== 'object') return [];
      const candidate = server as Partial<LanguageServerConfigEntry>;
      if (typeof candidate.id !== 'string' || typeof candidate.command !== 'string') return [];
      const entry = compactServer({
        id: candidate.id.trim(),
        command: candidate.command.trim(),
        args: Array.isArray(candidate.args) ? candidate.args.filter(isNonEmptyString) : [],
        extensions: Array.isArray(candidate.extensions) ? candidate.extensions.filter(isNonEmptyString) : [],
        filenames: Array.isArray(candidate.filenames) ? candidate.filenames.filter(isNonEmptyString) : [],
        languageIds: sanitizeStringRecord(candidate.languageIds),
      });
      if (!entry.id || !entry.command || (!(entry.extensions?.length) && !(entry.filenames?.length))) return [];
      return [entry];
    }),
  };
}

export function normalizeVerifyCommands(value: unknown): VerifyCommandConfig[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const candidate = item as Partial<VerifyCommandConfig>;
        if (typeof candidate.id !== 'string' || typeof candidate.command !== 'string') return [];
        const id = candidate.id.trim();
        const command = candidate.command.trim();
        if (!id || !command) return [];
        return [{
          id,
          label: typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.trim() : id,
          command,
          required: candidate.required !== false,
        }];
      })
    : [];
}

export function normalizeDiagnosticsConfig(value: unknown): DiagnosticsConfig {
  /* accept both `{ "sources": [...] }` and a bare `[...]`, matching the native
  loader's tolerance in diagnostics.rs. */
  const sources = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as DiagnosticsConfig).sources)
      ? (value as DiagnosticsConfig).sources
      : [];
  return {
    sources: sources.flatMap((source) => {
      if (!source || typeof source !== 'object') return [];
      const candidate = source as Partial<DiagnosticsSourceConfig>;
      if (typeof candidate.id !== 'string' || typeof candidate.command !== 'string') return [];
      const id = candidate.id.trim();
      const command = candidate.command.trim();
      if (!id || !command) return [];
      const parser = typeof candidate.parser === 'string' && candidate.parser.trim() ? candidate.parser.trim() : undefined;
      return [{
        id,
        command,
        ...(parser ? { parser } : {}),
        ...(candidate.deep === true ? { deep: true } : {}),
        ...(typeof candidate.timeoutSecs === 'number' ? { timeoutSecs: candidate.timeoutSecs } : {}),
      }];
    }),
  };
}

export function normalizeFormatterConfig(value: unknown): FormatterConfig {
  const formatters = value && typeof value === 'object' && Array.isArray((value as FormatterConfig).formatters)
    ? (value as FormatterConfig).formatters
    : [];
  return {
    formatters: formatters.flatMap((formatter) => {
      if (!formatter || typeof formatter !== 'object') return [];
      const candidate = formatter as Partial<FormatterConfigEntry>;
      if (typeof candidate.id !== 'string' || typeof candidate.command !== 'string') return [];
      const entry = compactFormatter({
        id: candidate.id.trim(),
        label: typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.trim() : candidate.id.trim(),
        command: candidate.command.trim(),
        extensions: Array.isArray(candidate.extensions) ? candidate.extensions.filter(isNonEmptyString).map(stripLeadingDot) : [],
        filenames: Array.isArray(candidate.filenames) ? candidate.filenames.filter(isNonEmptyString) : [],
      });
      if (!entry.id || !entry.command) return [];
      return [entry];
    }),
  };
}

export function normalizeFileTreeConfig(value: unknown): FileTreeConfig {
  if (!value || typeof value !== 'object') return {};
  const candidate = value as FileTreeConfig;
  return compactFileTreeConfig({
    includeDirs: Array.isArray(candidate.includeDirs) ? candidate.includeDirs.filter(isNonEmptyString) : [],
    excludeDirs: Array.isArray(candidate.excludeDirs) ? candidate.excludeDirs.filter(isNonEmptyString) : [],
    textExtensions: Array.isArray(candidate.textExtensions) ? candidate.textExtensions.filter(isNonEmptyString).map(stripLeadingDot) : [],
    binaryExtensions: Array.isArray(candidate.binaryExtensions) ? candidate.binaryExtensions.filter(isNonEmptyString).map(stripLeadingDot) : [],
  });
}

/* ── derivations (config → display) ────────────────────────────────────────── */

export function compactFileTreeConfig(config: FileTreeConfig): FileTreeConfig {
  const includeDirs = (config.includeDirs ?? []).map((item) => item.trim()).filter(Boolean);
  const excludeDirs = (config.excludeDirs ?? []).map((item) => item.trim()).filter(Boolean);
  const textExtensions = (config.textExtensions ?? []).map(stripLeadingDot).filter(Boolean);
  const binaryExtensions = (config.binaryExtensions ?? []).map(stripLeadingDot).filter(Boolean);
  return {
    ...(includeDirs.length ? { includeDirs } : {}),
    ...(excludeDirs.length ? { excludeDirs } : {}),
    ...(textExtensions.length ? { textExtensions } : {}),
    ...(binaryExtensions.length ? { binaryExtensions } : {}),
  };
}

export function fileTreeFormFromConfig(config: FileTreeConfig): FileTreeFormState {
  return {
    includeDirs: (config.includeDirs ?? []).join(', '),
    excludeDirs: (config.excludeDirs ?? []).join(', '),
    textExtensions: (config.textExtensions ?? []).join(', '),
    binaryExtensions: (config.binaryExtensions ?? []).join(', '),
  };
}

export function fileTreeConfigRows(config: FileTreeConfig): Array<{ id: string; detail: string }> {
  return [
    config.includeDirs?.length ? { id: 'include dirs', detail: config.includeDirs.join(', ') } : null,
    config.excludeDirs?.length ? { id: 'exclude dirs', detail: config.excludeDirs.join(', ') } : null,
    config.textExtensions?.length ? { id: 'text extensions', detail: config.textExtensions.join(', ') } : null,
    config.binaryExtensions?.length ? { id: 'binary extensions', detail: config.binaryExtensions.join(', ') } : null,
  ].filter((row): row is { id: string; detail: string } => Boolean(row));
}

export function fileTreeConfigCount(config: FileTreeConfig): number {
  return (config.includeDirs?.length ?? 0)
    + (config.excludeDirs?.length ?? 0)
    + (config.textExtensions?.length ?? 0)
    + (config.binaryExtensions?.length ?? 0);
}

function compactServer(entry: LanguageServerConfigEntry): LanguageServerConfigEntry {
  return {
    id: entry.id,
    command: entry.command,
    ...(entry.args?.length ? { args: entry.args } : {}),
    ...(entry.extensions?.length ? { extensions: entry.extensions } : {}),
    ...(entry.filenames?.length ? { filenames: entry.filenames } : {}),
    ...(entry.languageIds && Object.keys(entry.languageIds).length ? { languageIds: entry.languageIds } : {}),
  };
}

function compactFormatter(entry: FormatterConfigEntry): FormatterConfigEntry {
  return {
    id: entry.id,
    label: entry.label || entry.id,
    command: entry.command,
    ...(entry.extensions?.length ? { extensions: entry.extensions } : {}),
    ...(entry.filenames?.length ? { filenames: entry.filenames } : {}),
  };
}

/* ── string helpers ────────────────────────────────────────────────────────── */

export function splitCsv(value: string): string[] {
  return value.split(',').map((item) => item.trim().replace(/^\./, '')).filter(Boolean);
}

export function splitList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function stripLeadingDot(value: string): string {
  return value.trim().replace(/^\./, '');
}

export function splitArgs(value: string): string[] {
  return value.match(/"([^"]*)"|'([^']*)'|(\S+)/g)?.map((item) => item.replace(/^['"]|['"]$/g, '')) ?? [];
}

export function splitMapping(value: string): Record<string, string> {
  return Object.fromEntries(splitList(value).flatMap((item) => {
    const separator = item.includes('=') ? '=' : item.includes(':') ? ':' : '';
    if (!separator) return [];
    const [key, mapped] = item.split(separator, 2).map((part) => part.trim());
    return key && mapped ? [[stripLeadingDot(key), mapped]] : [];
  }));
}

function sanitizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => Boolean(entry[0].trim()) && isNonEmptyString(entry[1]))
    .map(([key, mapped]) => [stripLeadingDot(key), mapped.trim()] as const)
    .filter(([key, mapped]) => key && mapped);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function commandNameFromCommand(command: string): string {
  return command.split(/\s+/)[0]?.replace(/[^\w.-]+/g, '-') || 'run';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
