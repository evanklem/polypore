import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PreviewTarget } from '../../packages/sdk/src';
import type { BuiltinPluginProps } from '../shared';
import { PanelHeader, ResizeHandle, useResizableSplit } from '../shared';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

type PreviewTargetKind = PreviewTarget['kind'];

type DetectedScript = {
  name: string;
  command: string;
  raw?: string;
  kind: PreviewTargetKind;
};

type DetectedRuntime = {
  label: string;
  hint: string;
  /* candidate commands the user can pick from. empty means the user will
     enter a command manually. */
  scripts: DetectedScript[];
  defaultUrl: string;
  /* manifest filename the runtime was inferred from, or 'fallback' when
     no detector matched. shown verbatim in the setup header. */
  source: string;
};

type RuntimeConfigCommand = {
  id?: string;
  name?: string;
  command?: string;
  raw?: string;
  kind?: string;
};

type RuntimeConfigEntry = {
  id?: string;
  label?: string;
  hint?: string;
  defaultUrl?: string;
  url?: string;
  commands?: RuntimeConfigCommand[];
  scripts?: RuntimeConfigCommand[];
};

type RuntimeConfigFile = {
  runtimes?: RuntimeConfigEntry[];
};

type FileNode =
  | { kind: 'file'; name: string; path: string }
  | { kind: 'folder'; name: string; children: FileNode[] };

type TauriConfig = {
  build?: {
    devUrl?: string;
    devPath?: string;
  };
};

type NodePackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const FALLBACK_RUNTIME: DetectedRuntime = {
  label: 'no project detected',
  hint: 'enter a command to run',
  scripts: [],
  defaultUrl: '',
  source: 'fallback',
};

const RUNTIME_PREFERENCE_STORAGE_PREFIX = 'polypore.preview.runtime.v1';
const runtimePreferenceMemory = new Map<string, string>();
const CLI_EXECUTABLES = /^(node|npm|pnpm|yarn|bun|python|python3|pip|pip3|cargo|rustc|go|make|just|task|deno|sh|bash|zsh|fish|cmd|powershell|pwsh|open|xdg-open|gio|gtk-launch|flatpak|snap|eslint|prettier|tsc|vite|next|nuxt|astro|jest|vitest|pytest)$/;

function rankScript(name: string): number {
  const lower = name.toLowerCase();
  if (lower === 'dev') return 0;
  if (lower === 'start') return 1;
  if (lower.includes('dev') && !lower.includes('tauri')) return 2;
  if (lower.includes('serve')) return 3;
  if (lower.includes('preview')) return 4;
  if (
    lower.includes('tauri')
    || /^(app|launch|open|gui|desktop|client)$/.test(lower)
    || lower.includes('desktop')
    || lower.includes('electron')
    || lower.includes('wails')
  ) return 5;
  if (/\b(test|spec|check|lint|format|build)\b/.test(lower)) return 20;
  return 10;
}

function normalizeHost(host: string | undefined): string {
  if (!host || host === '0.0.0.0' || host === '::' || host === 'localhost') return 'localhost';
  return host;
}

function firstCommandToken(raw: string): string {
  const tokens = commandTokens(raw);
  let index = 0;
  if (tokens[index] === 'env') {
    index += 1;
    while (tokens[index]?.startsWith('-')) index += 1;
  }
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) index += 1;
  return tokens[index] ?? '';
}

function commandTokens(raw: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

function executableBasename(token: string): string {
  return token.split(/[\\/]/).pop()?.toLowerCase() ?? token.toLowerCase();
}

function looksLikeExecutableToken(token: string): boolean {
  if (!token) return false;
  return /^[a-z]:[\\/]/i.test(token)
    || /^[./~]/.test(token)
    || /\.app(?:[\\/]|$)/i.test(token)
    || /^[a-z0-9_./:-]+(?:\.exe|\.app)?$/i.test(token);
}

function isNativeExecutableCommand(raw: string): boolean {
  const executable = firstCommandToken(raw);
  return isMacOpenNativeCommand(raw)
    || isWindowsShellNativeCommand(raw)
    || isLinuxLauncherNativeCommand(raw)
    || isPackageExecNativeCommand(raw)
    || (looksLikeExecutableToken(executable) && !CLI_EXECUTABLES.test(executableBasename(executable)));
}

function isMacOpenNativeCommand(raw: string): boolean {
  const executable = executableBasename(firstCommandToken(raw));
  if (executable !== 'open') return false;
  return /(?:^|\s)-a(?:\s|=)/.test(raw) || /\.app(?:["'\s\\/]|$)/i.test(raw);
}

function isWindowsShellNativeCommand(raw: string): boolean {
  const executable = executableBasename(firstCommandToken(raw)).replace(/\.exe$/i, '');
  if (executable === 'powershell' || executable === 'pwsh') {
    return /\b(?:Start-Process|saps)\b/i.test(raw) && /\.exe(?:["'\s]|$)/i.test(raw);
  }
  if (executable === 'cmd') {
    return /(?:^|\s)\/[ck]\s+start\b/i.test(raw) && /\.exe(?:["'\s]|$)/i.test(raw);
  }
  return false;
}

function isLinuxLauncherNativeCommand(raw: string): boolean {
  const executable = executableBasename(firstCommandToken(raw));
  if (executable === 'gtk-launch') return true;
  if (executable === 'flatpak' || executable === 'snap') return /\brun\s+\S+/i.test(raw) && !/\bhttps?:\/\//i.test(raw);
  if (executable === 'xdg-open') return /\.desktop(?:["'\s]|$)/i.test(raw);
  if (executable === 'gio') return /\blaunch\s+\S+/i.test(raw) && !/\bhttps?:\/\//i.test(raw);
  return false;
}

function isPackageExecNativeCommand(raw: string): boolean {
  return /(?:^|\s)(?:npx|bunx)\s+(?:--yes\s+|-y\s+)?(?:electron|tauri|wails|neutralino|nw|nodewebkit)(?=\s|$)/i.test(raw)
    || /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:exec|dlx|x)\s+(?:--\s+)?(?:electron|tauri|wails|neutralino|nw|nodewebkit)(?=\s|$)/i.test(raw);
}

function inferKindFromScript(name: string, raw: string): PreviewTargetKind {
  const lower = `${name} ${raw}`.toLowerCase();
  const executable = firstCommandToken(raw);
  const executableName = executableBasename(executable);
  const launchScript = /^(app|launch|open|gui|desktop|client)$/i.test(name) || /\b(app|launch|gui|desktop)\b/i.test(name);
  const executableLike = looksLikeExecutableToken(executable);
  const manualExecutable = !name && executableLike;
  /* `name === 'app'` alone no longer auto-elevates to desktop — the
     raw command has to actually look native. otherwise a pyproject
     `app = "python_gui.main:main"` (processed into `python -m
     python_gui.main`) would be blocked from the in-window terminal
     embed even though python is a clean cli invocation. */
  if (
    isMacOpenNativeCommand(raw)
    || isWindowsShellNativeCommand(raw)
    || isLinuxLauncherNativeCommand(raw)
    || isPackageExecNativeCommand(raw)
    || /\b(tauri|electron|wails|neutralino|nw|nodewebkit)\b/.test(lower)
    || /\bcargo\s+tauri\b/.test(lower)
    || (/\bflutter\s+run\b/.test(lower) && /\b(?:-d|--device-id)\s*(?:macos|windows|linux)\b/.test(lower))
    || /\bdesktop\b/.test(lower)
  ) return 'desktop';
  if (/\b(android|ios|mobile|simulator|emulator|react-native|expo|capacitor|cordova)\b/.test(lower)) return 'mobile';
  if (/\b(test|vitest|jest|playwright|cypress|pytest|rspec|minitest|phpunit|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test|sbt\s+test|mix\s+test|dotnet\s+test)\b/.test(lower)) return 'test';
  if (
    /\b(vite|next|nuxt|astro|webpack-dev-server|serve|http-server|parcel|remix|svelte-kit|spring-boot|bootrun|rails|sinatra|django|flask|fastapi|uvicorn|gunicorn|hypercorn|phoenix|phx|artisan|laravel|deno\s+task\s+dev|deno\s+run.*--watch|gin|echo-server|actix-web|rocket)\b/.test(lower)
    || /manage\.py\s+runserver/.test(lower)
    || /\bphp\s+-S\b/.test(lower)
  ) return 'site';
  if (/\b(game|phaser|unity|godot)\b/.test(lower)) return 'game';
  if (
    (looksLikeExecutableToken(raw.trim()) || ((launchScript || manualExecutable) && executableLike))
    && !CLI_EXECUTABLES.test(executableName)
  ) return 'desktop';
  return 'cli';
}

function inferScriptNameFromCommand(command: string): string {
  return /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([a-z0-9:_-]+)(?=\s|$)/i.exec(command)?.[1] ?? '';
}

function scriptCommand(manager: NodePackageManager, name: string): string {
  return manager === 'npm' ? `npm run ${name}` : `${manager} run ${name}`;
}

function inferUrlFromScript(script: DetectedScript): string {
  if (script.kind !== 'site' && script.kind !== 'game') return '';
  const raw = script.raw ?? script.command;
  const lower = raw.toLowerCase();
  const port = /(?:^|\s)(?:--port|-p)\s*=?\s*(\d{2,5})(?=\s|$)/.exec(raw)?.[1]
    ?? /(?:^|\s)port=(\d{2,5})(?=\s|$)/i.exec(raw)?.[1];
  const host = normalizeHost(/(?:^|\s)--host\s*=?\s*([^\s]+)/.exec(raw)?.[1]);
  if (port) return `http://${host}:${port}`;
  if (/\bvite(?:\s|$)/.test(lower)) return `http://${host}:5173`;
  if (/\bastro\b/.test(lower)) return `http://${host}:4321`;
  if (/\bnext\b/.test(lower)) return `http://${host}:3000`;
  if (/\bnuxt\b/.test(lower)) return `http://${host}:3000`;
  if (/\bremix\b/.test(lower)) return `http://${host}:3000`;
  if (/\bsvelte-?kit\b/.test(lower)) return `http://${host}:5173`;
  if (/\bwebpack-dev-server\b/.test(lower)) return `http://${host}:8080`;
  if (/\b(spring-boot|bootrun)\b/.test(lower)) return `http://${host}:8080`;
  if (/\bjetty(?:-run|:run)?\b/.test(lower)) return `http://${host}:8080`;
  if (/\brails\b/.test(lower)) return `http://${host}:3000`;
  if (/\bsinatra\b/.test(lower)) return `http://${host}:4567`;
  if (/\b(django|manage\.py\s+runserver)\b/.test(lower) || /manage\.py\s+runserver/.test(lower)) return `http://${host}:8000`;
  if (/\bflask\b/.test(lower)) return `http://${host}:5000`;
  if (/\b(phoenix|phx(?:\.server)?)\b/.test(lower)) return `http://${host}:4000`;
  if (/\bartisan\b/.test(lower) || /\bphp\s+-S\b/.test(lower)) return `http://${host}:8000`;
  if (/\b(uvicorn|fastapi|hypercorn)\b/.test(lower)) return `http://${host}:8000`;
  if (/\bgunicorn\b/.test(lower)) return `http://${host}:8000`;
  if (/\bdeno\b/.test(lower)) return `http://${host}:8000`;
  return '';
}

/* parse host + port out of a user-supplied url. returns null when the
   url is empty or unparseable — callers should treat that as "no
   override" and leave the command alone. */
function parseHostPort(rawUrl: string): { host: string; port: string } | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  const match = /^https?:\/\/([^:/?#]+)(?::(\d{2,5}))?/i.exec(trimmed);
  if (!match) return null;
  const host = match[1];
  const port = match[2] ?? '';
  if (!port) return null;
  return { host, port };
}

/* rewrite the user's command so the spawned dev server binds to the
   host/port the user typed in the URL field. supports two shapes:

   1. existing `--port`/`-p` and `--host`/`-h` flags in the command
      get their values replaced in place (`vite --port 1420` →
      `vite --port 1423`).

   2. npm/pnpm/yarn/bun `run <script>` commands get the flags appended
      after a `--` separator so the underlying script receives them
      (`npm run dev` → `npm run dev -- --host 127.0.0.1 --port 1423`).
      a single `--` is reused if one already exists.

   commands that don't match either shape — django's `runserver`, php
   `-S host:port`, custom go binaries, etc. — return unchanged. the
   user can edit the command field directly for those. */
function applyUrlOverrideToCommand(rawCommand: string, override: { host: string; port: string }): string {
  let command = rawCommand;
  let hostReplaced = false;
  let portReplaced = false;
  command = command.replace(/(--host|--hostname|-h)(\s*=\s*|\s+)([^\s]+)/g, (_match, flag, sep, _value) => {
    hostReplaced = true;
    return `${flag}${sep}${override.host}`;
  });
  command = command.replace(/(--port|-p)(\s*=\s*|\s+)(\d{2,5})\b/g, (_match, flag, sep, _value) => {
    portReplaced = true;
    return `${flag}${sep}${override.port}`;
  });
  if (hostReplaced && portReplaced) return command;

  const runScriptMatch = /^(\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[a-z0-9:_-]+)(\s+--\s+)?(.*)$/i.exec(command);
  if (runScriptMatch) {
    const [, head, existingSep, tail] = runScriptMatch;
    const sep = existingSep ? existingSep : ' -- ';
    const extras: string[] = [];
    if (!hostReplaced) extras.push(`--host ${override.host}`);
    if (!portReplaced) extras.push(`--port ${override.port}`);
    return `${head}${sep}${[tail.trim(), ...extras].filter(Boolean).join(' ')}`;
  }
  return command;
}

function extractPreviewUrl(output: string): string {
  const match = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[[^\]]+\]|[a-z0-9.-]+)(?::\d{2,5})?(?:\/[^\s"'<>)]*)?/i.exec(output);
  if (!match) return '';
  return match[0]
    .replace('://0.0.0.0', '://localhost')
    .replace('://[::]', '://localhost');
}

function terminalInputForKey(event: React.KeyboardEvent): string {
  if (event.ctrlKey && event.key.length === 1) {
    const code = event.key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  }
  const specialKeys: Record<string, string> = {
    Enter: '\r',
    Backspace: '\x7f',
    Tab: '\t',
    Escape: '\x1b',
    ArrowUp: '\x1b[A',
    ArrowDown: '\x1b[B',
    ArrowRight: '\x1b[C',
    ArrowLeft: '\x1b[D',
    Home: '\x1b[H',
    End: '\x1b[F',
    Delete: '\x1b[3~',
    PageUp: '\x1b[5~',
    PageDown: '\x1b[6~',
  };
  if (specialKeys[event.key]) return specialKeys[event.key];
  if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1) return event.key;
  return '';
}

async function readTauriDevUrl(host: BuiltinPluginProps['host']): Promise<string> {
  for (const path of [
    'src-tauri/tauri.conf.json',
    'src-tauri/tauri.conf.json5',
    'src-tauri/Tauri.toml',
    'tauri.conf.json',
    'tauri.conf.json5',
    'Tauri.toml',
  ]) {
    try {
      const config = await host.editor.read(path);
      return parseTauriDevUrl(path, config.content || '');
    } catch {
      /* try next config path */
    }
  }
  return '';
}

function parseTauriDevUrl(path: string, content: string): string {
  if (/\.toml$/i.test(path)) return parseTauriTomlDevUrl(content);
  const source = /\.json5$/i.test(path) ? stripJson5Affordances(content) : content;
  const parsed = JSON.parse(source || '{}') as TauriConfig;
  return parsed.build?.devUrl || parsed.build?.devPath || '';
}

function stripJson5Affordances(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
}

function parseTauriTomlDevUrl(content: string): string {
  const build = /(?:^|\n)\[build\]\s*\n([\s\S]*?)(?=\n\[|$)/i.exec(content)?.[1] ?? '';
  const match = /^\s*(?:devUrl|devPath)\s*=\s*["']([^"']+)["']/im.exec(build);
  return match?.[1] ?? '';
}

async function detectNodePackageManager(host: BuiltinPluginProps['host'], packageManager?: string): Promise<NodePackageManager> {
  const declared = packageManager?.split('@')[0];
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm') return declared;
  const lockfiles: Array<[string, NodePackageManager]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ];
  for (const [path, manager] of lockfiles) {
    try {
      await host.editor.read(path);
      return manager;
    } catch {
      /* try next lockfile */
    }
  }
  return 'npm';
}

async function readFirstExisting(host: BuiltinPluginProps['host'], paths: string[]) {
  for (const path of paths) {
    try {
      return await host.editor.read(path);
    } catch {
      /* try next path */
    }
  }
  throw new Error(`none of ${paths.join(', ')} found`);
}

function firstMakeTargetCommand(content: string, target: string): string {
  const lines = content.split(/\r?\n/);
  const header = new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:(?![=])`);
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return target;
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z0-9_.-]+\s*:(?![=])/.test(line)) break;
    const command = /^\t@?-?(.+)$/.exec(line)?.[1]?.trim();
    if (command) return command;
  }
  return target;
}

function firstJustRecipeCommand(content: string, recipe: string): string {
  const lines = content.split(/\r?\n/);
  const header = new RegExp(`^${recipe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s+[^:=\\n]+)?\\s*:`);
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return recipe;
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z0-9_-]+(?:\s+[^:=\n]+)?\s*:/.test(line)) break;
    const command = /^\s+@?-?(.+)$/.exec(line)?.[1]?.trim();
    if (command) return command;
  }
  return recipe;
}

function firstTaskCommand(content: string, task: string): string {
  const lines = content.split(/\r?\n/);
  const header = new RegExp(`^\\s{2}${task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return task;
  for (const line of lines.slice(start + 1)) {
    if (/^\s{2}[A-Za-z0-9_-]+\s*:/.test(line)) break;
    const command = /^\s*-\s*(.+)$/.exec(line)?.[1]?.trim();
    if (command && !/^\{/.test(command)) return command.replace(/^['"]|['"]$/g, '');
  }
  return task;
}

function pythonScriptsFromPyproject(content: string): DetectedScript[] {
  const sections = ['project.scripts', 'tool.poetry.scripts'];
  const scripts: DetectedScript[] = [];
  for (const section of sections) {
    const match = new RegExp(`(?:^|\\n)\\[${section.replace('.', '\\.')}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\[|$)`, 'i').exec(content);
    const body = match?.[1];
    if (!body) continue;
    for (const line of body.split(/\r?\n/)) {
      const entry = /^\s*([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']/.exec(line);
      if (!entry) continue;
      const name = entry[1];
      const moduleName = entry[2].split(':')[0].trim();
      if (!moduleName) continue;
      const raw = `python -m ${moduleName}`;
      scripts.push({
        name,
        command: raw,
        raw,
        kind: inferKindFromScript(name, raw),
      });
    }
  }
  return scripts
    .filter((script, index, all) => all.findIndex((candidate) => candidate.name === script.name) === index)
    .sort((a, b) => rankScript(a.name) - rankScript(b.name));
}

/* a detector reads a manifest (or set of files) and returns a runtime if
   the project shape matches. returning null means "not my stack" — the
   pipeline will move on. throwing is equivalent to returning null; either
   is fine since most detectors short-circuit on a single `read` failure. */
type RuntimeDetector = (host: BuiltinPluginProps['host']) => Promise<DetectedRuntime | null>;

async function listProjectFiles(host: BuiltinPluginProps['host'], maxDepth = 3): Promise<string[]> {
  try {
    const result = await host.editor.tree() as { tree: FileNode[] };
    const out: string[] = [];
    const walk = (nodes: FileNode[], depth: number) => {
      if (depth > maxDepth) return;
      for (const node of nodes) {
        if (node.kind === 'file') out.push(node.path);
        else walk(node.children, depth + 1);
      }
    };
    walk(result.tree, 0);
    return out;
  } catch {
    return [];
  }
}

async function readContent(host: BuiltinPluginProps['host'], path: string): Promise<string | null> {
  try {
    const file = await host.editor.read(path);
    return file.content ?? '';
  } catch {
    return null;
  }
}

async function existsAny(host: BuiltinPluginProps['host'], paths: string[]): Promise<boolean> {
  for (const path of paths) {
    if ((await readContent(host, path)) !== null) return true;
  }
  return false;
}

async function readConfiguredRuntimes(host: BuiltinPluginProps['host']): Promise<DetectedRuntime[]> {
  const content = await readContent(host, '.polypore/runtime.json');
  if (content === null) return [];
  const parsed = JSON.parse(content || '{}') as RuntimeConfigFile;
  const rows = Array.isArray(parsed.runtimes) ? parsed.runtimes : [];
  return rows.flatMap((runtime, index) => {
    if (!runtime || typeof runtime !== 'object') return [];
    const commands = Array.isArray(runtime.commands)
      ? runtime.commands
      : Array.isArray(runtime.scripts)
        ? runtime.scripts
        : [];
    const scripts = commands.flatMap(normalizeConfiguredRuntimeCommand);
    if (scripts.length === 0) return [];
    const label = cleanConfigString(runtime.label)
      ?? cleanConfigString(runtime.id)
      ?? `configured runtime ${index + 1}`;
    const defaultUrl = cleanConfigString(runtime.defaultUrl)
      ?? cleanConfigString(runtime.url)
      ?? inferUrlFromScript(scripts[0])
      ?? '';
    return [{
      label,
      hint: cleanConfigString(runtime.hint) ?? `${scripts.length} configured command${scripts.length === 1 ? '' : 's'}`,
      scripts,
      defaultUrl,
      source: '.polypore/runtime.json',
    }];
  });
}

function normalizeConfiguredRuntimeCommand(command: RuntimeConfigCommand): DetectedScript[] {
  if (!command || typeof command !== 'object') return [];
  const commandText = cleanConfigString(command.command);
  if (!commandText) return [];
  const name = cleanConfigString(command.name)
    ?? cleanConfigString(command.id)
    ?? cleanConfigString(inferScriptNameFromCommand(commandText))
    ?? cleanConfigString(firstCommandToken(commandText))
    ?? 'run';
  const raw = cleanConfigString(command.raw) ?? commandText;
  const kind = normalizePreviewKind(command.kind) ?? inferKindFromScript(name, raw);
  return [{ name, command: commandText, raw, kind }];
}

function cleanConfigString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizePreviewKind(value: unknown): PreviewTargetKind | null {
  return value === 'site'
    || value === 'desktop'
    || value === 'mobile'
    || value === 'cli'
    || value === 'test'
    || value === 'game'
    ? value
    : null;
}

const detectNode: RuntimeDetector = async (host) => {
  const content = await readContent(host, 'package.json');
  if (content === null) return null;
  const parsed = JSON.parse(content || '{}') as { scripts?: Record<string, string>; name?: string; packageManager?: string };
  const entries = Object.entries(parsed.scripts ?? {});
  if (entries.length === 0) return null;
  const manager = await detectNodePackageManager(host, parsed.packageManager);
  const scripts = entries
    .map(([name, raw]) => ({ name, command: scriptCommand(manager, name), raw, kind: inferKindFromScript(name, raw) }))
    .sort((a, b) => rankScript(a.name) - rankScript(b.name));
  const first = scripts[0];
  const defaultUrl = inferUrlFromScript(first) || (first?.kind === 'desktop' ? await readTauriDevUrl(host) : '');
  return {
    label: parsed.name ? `node · ${parsed.name}` : 'node project',
    hint: `${scripts.length} ${manager} scripts`,
    scripts,
    defaultUrl,
    source: 'package.json',
  };
};

const detectCargo: RuntimeDetector = async (host) => {
  const content = await readContent(host, 'Cargo.toml');
  if (!content) return null;
  const nameMatch = /name\s*=\s*"([^"]+)"/.exec(content);
  const tauriDevUrl = await readTauriDevUrl(host);
  const hasTauri = Boolean(tauriDevUrl) || /\btauri\b/i.test(content);
  const scripts: DetectedScript[] = [
    ...(hasTauri ? [{ name: 'tauri', command: 'cargo tauri dev', raw: 'cargo tauri dev', kind: 'desktop' as PreviewTargetKind }] : []),
    { name: 'run', command: 'cargo run', kind: 'cli' },
    { name: 'build', command: 'cargo build', kind: 'cli' },
    { name: 'test', command: 'cargo test', kind: 'test' },
  ];
  return {
    label: nameMatch ? `rust · ${nameMatch[1]}` : 'rust crate',
    hint: hasTauri ? 'cargo tauri dev / run' : 'cargo run / build',
    scripts,
    defaultUrl: hasTauri ? tauriDevUrl : '',
    source: 'Cargo.toml',
  };
};

const detectPython: RuntimeDetector = async (host) => {
  const pyproject = await readContent(host, 'pyproject.toml');
  const requirements = await readContent(host, 'requirements.txt');
  const setupCfg = await readContent(host, 'setup.cfg');
  const setupPy = await readContent(host, 'setup.py');
  const managePy = await readContent(host, 'manage.py');
  if (pyproject === null && requirements === null && setupCfg === null && setupPy === null && managePy === null) return null;
  const declared = `${pyproject ?? ''}\n${requirements ?? ''}\n${setupCfg ?? ''}`;
  const isDjango = managePy !== null || /\bdjango\b/i.test(declared);
  const isFlask = /\bflask\b/i.test(declared);
  const isFastapi = /\bfastapi\b/i.test(declared);
  const isStreamlit = /\bstreamlit\b/i.test(declared);
  const scripts: DetectedScript[] = [];
  if (isDjango) scripts.push({ name: 'runserver', command: 'python manage.py runserver', raw: 'python manage.py runserver', kind: 'site' });
  if (isFlask) scripts.push({ name: 'flask', command: 'flask --app . run --debug', raw: 'flask run', kind: 'site' });
  if (isFastapi) scripts.push({ name: 'uvicorn', command: 'uvicorn main:app --reload', raw: 'uvicorn main:app --reload', kind: 'site' });
  if (isStreamlit) scripts.push({ name: 'streamlit', command: 'streamlit run app.py', raw: 'streamlit run app.py', kind: 'site' });
  if (pyproject) scripts.push(...pythonScriptsFromPyproject(pyproject));
  if (scripts.length === 0) scripts.push({ name: 'run', command: 'python -m app', kind: 'cli' });
  scripts.push({ name: 'pytest', command: 'pytest', kind: 'test' });
  const label = isDjango ? 'django project' : isFlask ? 'flask project' : isFastapi ? 'fastapi project' : isStreamlit ? 'streamlit project' : 'python project';
  const defaultUrl = isDjango || isFastapi ? 'http://localhost:8000' : isFlask ? 'http://localhost:5000' : isStreamlit ? 'http://localhost:8501' : '';
  const source = pyproject !== null ? 'pyproject.toml'
    : managePy !== null ? 'manage.py'
    : requirements !== null ? 'requirements.txt'
    : setupPy !== null ? 'setup.py'
    : 'setup.cfg';
  return { label, hint: `${source} detected`, scripts, defaultUrl, source };
};

const detectGo: RuntimeDetector = async (host) => {
  const content = await readContent(host, 'go.mod');
  if (!content) return null;
  const moduleMatch = /^module\s+(.+)$/m.exec(content);
  return {
    label: moduleMatch ? `go · ${moduleMatch[1].trim().split('/').pop()}` : 'go module',
    hint: 'go run / test',
    scripts: [
      { name: 'run', command: 'go run .', raw: 'go run .', kind: 'cli' },
      { name: 'test', command: 'go test ./...', raw: 'go test ./...', kind: 'test' },
      { name: 'build', command: 'go build ./...', raw: 'go build ./...', kind: 'cli' },
    ],
    defaultUrl: '',
    source: 'go.mod',
  };
};

const detectGradle: RuntimeDetector = async (host) => {
  const kts = await readContent(host, 'build.gradle.kts');
  const groovy = await readContent(host, 'build.gradle');
  const settings = (await readContent(host, 'settings.gradle.kts')) ?? (await readContent(host, 'settings.gradle')) ?? '';
  const buildScript = kts ?? groovy;
  if (buildScript === null) return null;
  const wrapper = await existsAny(host, ['gradlew', 'gradlew.bat']);
  const prefix = wrapper ? './gradlew' : 'gradle';
  const isSpringBoot = /spring-boot/i.test(buildScript);
  const isAndroid = /com\.android\.(application|library)/.test(buildScript);
  const nameMatch = /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(settings);
  const scripts: DetectedScript[] = [];
  if (isSpringBoot) scripts.push({ name: 'bootRun', command: `${prefix} bootRun`, raw: 'spring-boot:run', kind: 'site' });
  if (isAndroid) scripts.push({ name: 'installDebug', command: `${prefix} installDebug`, raw: 'gradle installDebug', kind: 'mobile' });
  scripts.push(
    { name: 'run', command: `${prefix} run`, raw: `${prefix} run`, kind: 'cli' },
    { name: 'test', command: `${prefix} test`, raw: `${prefix} test`, kind: 'test' },
    { name: 'build', command: `${prefix} build`, raw: `${prefix} build`, kind: 'cli' },
  );
  return {
    label: nameMatch ? `gradle · ${nameMatch[1]}` : isAndroid ? 'android project' : 'gradle project',
    hint: isSpringBoot ? `${prefix} bootRun` : `${prefix} run / test`,
    scripts,
    defaultUrl: isSpringBoot ? 'http://localhost:8080' : '',
    source: kts !== null ? 'build.gradle.kts' : 'build.gradle',
  };
};

const detectMaven: RuntimeDetector = async (host) => {
  const content = await readContent(host, 'pom.xml');
  if (!content) return null;
  const artifactId = /<artifactId>([^<]+)<\/artifactId>/.exec(content)?.[1];
  const isSpringBoot = /spring-boot/i.test(content);
  const isQuarkus = /\bquarkus\b/i.test(content);
  const isJetty = /\bjetty-maven-plugin\b/i.test(content);
  const scripts: DetectedScript[] = [];
  if (isSpringBoot) scripts.push({ name: 'spring-boot:run', command: 'mvn spring-boot:run', raw: 'mvn spring-boot:run', kind: 'site' });
  if (isQuarkus) scripts.push({ name: 'quarkus:dev', command: 'mvn quarkus:dev', raw: 'mvn quarkus:dev', kind: 'site' });
  if (isJetty) scripts.push({ name: 'jetty:run', command: 'mvn jetty:run', raw: 'mvn jetty:run', kind: 'site' });
  scripts.push(
    { name: 'compile', command: 'mvn compile', kind: 'cli' },
    { name: 'exec', command: 'mvn exec:java', kind: 'cli' },
    { name: 'test', command: 'mvn test', kind: 'test' },
    { name: 'package', command: 'mvn package', kind: 'cli' },
  );
  return {
    label: artifactId ? `maven · ${artifactId}` : 'maven project',
    hint: isSpringBoot ? 'mvn spring-boot:run' : isQuarkus ? 'mvn quarkus:dev' : 'mvn compile / test',
    scripts,
    defaultUrl: isSpringBoot || isJetty ? 'http://localhost:8080' : isQuarkus ? 'http://localhost:8080' : '',
    source: 'pom.xml',
  };
};

const detectDotnet: RuntimeDetector = async (host) => {
  const files = await listProjectFiles(host);
  const sln = files.find((path) => path.toLowerCase().endsWith('.sln'));
  const projects = files.filter((path) => /\.(csproj|fsproj|vbproj)$/i.test(path));
  if (!sln && projects.length === 0) return null;
  const primary = sln ?? projects[0];
  const projectContent = projects[0] ? await readContent(host, projects[0]) : null;
  const isAspNet = /<Project[^>]*Sdk="Microsoft\.NET\.Sdk\.Web"/i.test(projectContent ?? '')
    || /\b(Microsoft\.AspNetCore|Microsoft\.AspNet\.WebApi)\b/i.test(projectContent ?? '');
  const isBlazorWasm = /Microsoft\.AspNetCore\.Components\.WebAssembly/.test(projectContent ?? '');
  const isMaui = /Microsoft\.Maui/.test(projectContent ?? '');
  const scripts: DetectedScript[] = [];
  if (isAspNet || isBlazorWasm) {
    scripts.push({ name: 'run', command: 'dotnet run', raw: 'dotnet run', kind: 'site' });
    scripts.push({ name: 'watch', command: 'dotnet watch run', raw: 'dotnet watch run', kind: 'site' });
  } else if (isMaui) {
    scripts.push({ name: 'run', command: 'dotnet build -t:Run', raw: 'dotnet maui', kind: 'desktop' });
  } else {
    scripts.push({ name: 'run', command: 'dotnet run', raw: 'dotnet run', kind: 'cli' });
  }
  scripts.push(
    { name: 'test', command: 'dotnet test', raw: 'dotnet test', kind: 'test' },
    { name: 'build', command: 'dotnet build', raw: 'dotnet build', kind: 'cli' },
  );
  const projectName = primary.split('/').pop()?.replace(/\.(sln|csproj|fsproj|vbproj)$/i, '');
  return {
    label: projectName ? `dotnet · ${projectName}` : 'dotnet project',
    hint: isAspNet ? 'dotnet run / watch' : 'dotnet run / test',
    scripts,
    defaultUrl: isAspNet || isBlazorWasm ? 'http://localhost:5000' : '',
    source: primary,
  };
};

const detectSbt: RuntimeDetector = async (host) => {
  const content = await readContent(host, 'build.sbt');
  if (content === null) return null;
  const nameMatch = /name\s*:=\s*"([^"]+)"/.exec(content);
  const isPlay = /\bplayframework\b/i.test(content) || /PlayScala\b/.test(content);
  const scripts: DetectedScript[] = [];
  if (isPlay) scripts.push({ name: 'run', command: 'sbt run', raw: 'sbt run', kind: 'site' });
  else scripts.push({ name: 'run', command: 'sbt run', raw: 'sbt run', kind: 'cli' });
  scripts.push(
    { name: 'test', command: 'sbt test', raw: 'sbt test', kind: 'test' },
    { name: 'compile', command: 'sbt compile', raw: 'sbt compile', kind: 'cli' },
    { name: 'package', command: 'sbt package', raw: 'sbt package', kind: 'cli' },
  );
  return {
    label: nameMatch ? `sbt · ${nameMatch[1]}` : isPlay ? 'play project' : 'scala project',
    hint: isPlay ? 'sbt run (play)' : 'sbt run / test',
    scripts,
    defaultUrl: isPlay ? 'http://localhost:9000' : '',
    source: 'build.sbt',
  };
};

const detectMix: RuntimeDetector = async (host) => {
  const content = await readContent(host, 'mix.exs');
  if (content === null) return null;
  const appMatch = /app:\s*:([A-Za-z0-9_]+)/.exec(content);
  const isPhoenix = /\bphoenix\b/i.test(content) || /Phoenix\.PubSub/.test(content);
  const scripts: DetectedScript[] = [];
  if (isPhoenix) scripts.push({ name: 'phx.server', command: 'mix phx.server', raw: 'mix phx.server', kind: 'site' });
  scripts.push(
    { name: 'run', command: 'mix run --no-halt', raw: 'mix run', kind: isPhoenix ? 'cli' : 'cli' },
    { name: 'test', command: 'mix test', raw: 'mix test', kind: 'test' },
    { name: 'compile', command: 'mix compile', raw: 'mix compile', kind: 'cli' },
  );
  return {
    label: appMatch ? `elixir · ${appMatch[1]}` : isPhoenix ? 'phoenix project' : 'elixir project',
    hint: isPhoenix ? 'mix phx.server' : 'mix run / test',
    scripts,
    defaultUrl: isPhoenix ? 'http://localhost:4000' : '',
    source: 'mix.exs',
  };
};

const detectRuby: RuntimeDetector = async (host) => {
  const gemfile = await readContent(host, 'Gemfile');
  const gemspec = await listProjectFiles(host, 1).then((files) => files.find((path) => path.endsWith('.gemspec')));
  const rakefile = await readContent(host, 'Rakefile');
  if (gemfile === null && !gemspec && rakefile === null) return null;
  const isRails = /\b(rails|sprockets|actionpack)\b/i.test(gemfile ?? '') || (await readContent(host, 'config/application.rb')) !== null;
  const isSinatra = /\bsinatra\b/i.test(gemfile ?? '');
  const isJekyll = /\bjekyll\b/i.test(gemfile ?? '');
  const scripts: DetectedScript[] = [];
  if (isRails) scripts.push({ name: 'server', command: 'bundle exec rails server', raw: 'rails server', kind: 'site' });
  if (isSinatra) scripts.push({ name: 'sinatra', command: 'bundle exec ruby app.rb', raw: 'sinatra app.rb', kind: 'site' });
  if (isJekyll) scripts.push({ name: 'serve', command: 'bundle exec jekyll serve', raw: 'jekyll serve', kind: 'site' });
  if (rakefile !== null) scripts.push({ name: 'rake', command: 'bundle exec rake', raw: 'rake', kind: 'cli' });
  scripts.push(
    { name: 'test', command: isRails ? 'bundle exec rails test' : 'bundle exec rspec', raw: 'rspec', kind: 'test' },
    { name: 'console', command: isRails ? 'bundle exec rails console' : 'bundle exec irb', raw: 'irb', kind: 'cli' },
  );
  const label = isRails ? 'rails project' : isSinatra ? 'sinatra project' : isJekyll ? 'jekyll site' : 'ruby project';
  const defaultUrl = isRails ? 'http://localhost:3000' : isSinatra ? 'http://localhost:4567' : isJekyll ? 'http://localhost:4000' : '';
  const source = gemfile !== null ? 'Gemfile' : gemspec ?? 'Rakefile';
  return { label, hint: `${source} detected`, scripts, defaultUrl, source };
};

const detectComposer: RuntimeDetector = async (host) => {
  const content = await readContent(host, 'composer.json');
  if (!content) return null;
  const parsed = JSON.parse(content) as { name?: string; scripts?: Record<string, string | string[]>; require?: Record<string, string> };
  const isLaravel = !!parsed.require?.['laravel/framework'] || (await readContent(host, 'artisan')) !== null;
  const isSymfony = !!parsed.require?.['symfony/framework-bundle'];
  const declared = Object.entries(parsed.scripts ?? {})
    .map(([name, raw]) => ({
      name,
      command: `composer run ${name}`,
      raw: Array.isArray(raw) ? raw.join(' && ') : raw,
      kind: inferKindFromScript(name, Array.isArray(raw) ? raw.join(' ') : raw),
    }))
    .sort((a, b) => rankScript(a.name) - rankScript(b.name));
  const scripts: DetectedScript[] = [];
  if (isLaravel) scripts.push({ name: 'serve', command: 'php artisan serve', raw: 'php artisan serve', kind: 'site' });
  if (isSymfony) scripts.push({ name: 'symfony', command: 'symfony serve', raw: 'symfony serve', kind: 'site' });
  scripts.push(...declared);
  scripts.push(
    { name: 'phpunit', command: 'vendor/bin/phpunit', raw: 'phpunit', kind: 'test' },
    { name: 'php-serve', command: 'php -S localhost:8000', raw: 'php -S', kind: 'site' },
  );
  return {
    label: isLaravel ? 'laravel project' : isSymfony ? 'symfony project' : parsed.name ? `php · ${parsed.name}` : 'php project',
    hint: isLaravel ? 'php artisan serve' : 'composer scripts',
    scripts,
    defaultUrl: isLaravel || isSymfony ? 'http://localhost:8000' : '',
    source: 'composer.json',
  };
};

const detectDeno: RuntimeDetector = async (host) => {
  const config = (await readContent(host, 'deno.json')) ?? (await readContent(host, 'deno.jsonc'));
  if (config === null) return null;
  /* deno.jsonc allows comments and trailing commas — reuse the json5 stripper. */
  const parsed = JSON.parse(stripJson5Affordances(config) || '{}') as { name?: string; tasks?: Record<string, string> };
  const tasks = Object.entries(parsed.tasks ?? {});
  const scripts = tasks
    .map(([name, raw]) => ({ name, command: `deno task ${name}`, raw, kind: inferKindFromScript(name, raw) }))
    .sort((a, b) => rankScript(a.name) - rankScript(b.name));
  if (scripts.length === 0) {
    scripts.push(
      { name: 'run', command: 'deno run --allow-all main.ts', raw: 'deno run main.ts', kind: 'cli' },
      { name: 'test', command: 'deno test --allow-all', raw: 'deno test', kind: 'test' },
    );
  }
  return {
    label: parsed.name ? `deno · ${parsed.name}` : 'deno project',
    hint: `${scripts.length} deno task${scripts.length === 1 ? '' : 's'}`,
    scripts,
    defaultUrl: inferUrlFromScript(scripts[0]) || '',
    source: (await readContent(host, 'deno.json')) !== null ? 'deno.json' : 'deno.jsonc',
  };
};

const detectFlutter: RuntimeDetector = async (host) => {
  const content = await readContent(host, 'pubspec.yaml');
  if (content === null) return null;
  const isFlutter = /\bflutter:\s*\n/.test(content) || /\bsdk:\s*flutter\b/.test(content);
  const nameMatch = /^name:\s*([A-Za-z0-9_]+)/m.exec(content);
  const scripts: DetectedScript[] = [];
  if (isFlutter) {
    scripts.push(
      { name: 'run', command: 'flutter run', raw: 'flutter run', kind: 'desktop' },
      { name: 'web', command: 'flutter run -d chrome', raw: 'flutter run -d chrome', kind: 'site' },
      { name: 'test', command: 'flutter test', raw: 'flutter test', kind: 'test' },
      { name: 'build', command: 'flutter build apk', raw: 'flutter build', kind: 'mobile' },
    );
  } else {
    scripts.push(
      { name: 'run', command: 'dart run', raw: 'dart run', kind: 'cli' },
      { name: 'test', command: 'dart test', raw: 'dart test', kind: 'test' },
    );
  }
  return {
    label: nameMatch ? `${isFlutter ? 'flutter' : 'dart'} · ${nameMatch[1]}` : isFlutter ? 'flutter project' : 'dart project',
    hint: isFlutter ? 'flutter run / test' : 'dart run / test',
    scripts,
    defaultUrl: '',
    source: 'pubspec.yaml',
  };
};

const detectCmake: RuntimeDetector = async (host) => {
  const content = await readContent(host, 'CMakeLists.txt');
  if (content === null) return null;
  const projectMatch = /project\s*\(\s*([A-Za-z0-9_]+)/.exec(content);
  return {
    label: projectMatch ? `cmake · ${projectMatch[1]}` : 'cmake project',
    hint: 'cmake configure / build',
    scripts: [
      { name: 'configure', command: 'cmake -B build', raw: 'cmake -B build', kind: 'cli' },
      { name: 'build', command: 'cmake --build build', raw: 'cmake --build build', kind: 'cli' },
      { name: 'test', command: 'ctest --test-dir build', raw: 'ctest', kind: 'test' },
    ],
    defaultUrl: '',
    source: 'CMakeLists.txt',
  };
};

const detectBazel: RuntimeDetector = async (host) => {
  const hasBazel = await existsAny(host, ['MODULE.bazel', 'WORKSPACE', 'WORKSPACE.bazel']);
  if (!hasBazel) return null;
  return {
    label: 'bazel workspace',
    hint: 'bazel run / test',
    scripts: [
      { name: 'build', command: 'bazel build //...', raw: 'bazel build //...', kind: 'cli' },
      { name: 'test', command: 'bazel test //...', raw: 'bazel test //...', kind: 'test' },
      { name: 'run', command: 'bazel run //...', raw: 'bazel run //...', kind: 'cli' },
    ],
    defaultUrl: '',
    source: (await readContent(host, 'MODULE.bazel')) !== null ? 'MODULE.bazel' : 'WORKSPACE',
  };
};

const detectNix: RuntimeDetector = async (host) => {
  const content = await readContent(host, 'flake.nix');
  if (content === null) return null;
  const hasApps = /\bapps\s*=/.test(content) || /\bapp\.default\s*=/.test(content);
  const hasPackages = /\bpackages\s*=/.test(content);
  const scripts: DetectedScript[] = [];
  if (hasApps) scripts.push({ name: 'run', command: 'nix run', raw: 'nix run', kind: 'cli' });
  if (hasPackages) scripts.push({ name: 'build', command: 'nix build', raw: 'nix build', kind: 'cli' });
  scripts.push(
    { name: 'develop', command: 'nix develop', raw: 'nix develop', kind: 'cli' },
    { name: 'flake-check', command: 'nix flake check', raw: 'nix flake check', kind: 'test' },
  );
  return {
    label: 'nix flake',
    hint: 'nix run / develop',
    scripts,
    defaultUrl: '',
    source: 'flake.nix',
  };
};

const detectMake: RuntimeDetector = async (host) => {
  const makefile = await readFirstExisting(host, ['Makefile', 'makefile', 'GNUmakefile']).catch(() => null);
  if (!makefile?.content) return null;
  const targets = Array.from(makefile.content.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?![=])/gm))
    .map((match) => match[1])
    .filter((target) => !target.startsWith('.'))
    .filter((target, index, all) => all.indexOf(target) === index);
  if (targets.length === 0) return null;
  const scripts = targets
    .map((target) => {
      const raw = firstMakeTargetCommand(makefile.content, target);
      return {
        name: target,
        command: `make ${target}`,
        raw,
        kind: inferKindFromScript(target, raw),
      };
    })
    .sort((a, b) => rankScript(a.name) - rankScript(b.name));
  return {
    label: 'make project',
    hint: `${scripts.length} make targets`,
    scripts,
    defaultUrl: inferUrlFromScript(scripts[0]) || '',
    source: 'Makefile',
  };
};

const detectJust: RuntimeDetector = async (host) => {
  const justfile = await readFirstExisting(host, ['justfile', 'Justfile', '.justfile']).catch(() => null);
  if (!justfile?.content) return null;
  const recipes = Array.from(justfile.content.matchAll(/^([A-Za-z0-9_-]+)(?:\s+[^:=\n]+)?\s*:/gm))
    .map((match) => match[1])
    .filter((recipe) => !recipe.startsWith('_'))
    .filter((recipe, index, all) => all.indexOf(recipe) === index);
  if (recipes.length === 0) return null;
  const scripts = recipes
    .map((recipe) => {
      const raw = firstJustRecipeCommand(justfile.content, recipe);
      return {
        name: recipe,
        command: `just ${recipe}`,
        raw,
        kind: inferKindFromScript(recipe, raw),
      };
    })
    .sort((a, b) => rankScript(a.name) - rankScript(b.name));
  return {
    label: 'just project',
    hint: `${scripts.length} just recipes`,
    scripts,
    defaultUrl: inferUrlFromScript(scripts[0]) || '',
    source: 'justfile',
  };
};

const detectTask: RuntimeDetector = async (host) => {
  const taskfile = await readFirstExisting(host, ['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml', 'taskfile.yaml']).catch(() => null);
  if (!taskfile?.content) return null;
  const tasksBlock = /(?:^|\n)tasks:\s*\n([\s\S]*)/i.exec(taskfile.content)?.[1] ?? taskfile.content;
  const tasks = Array.from(tasksBlock.matchAll(/^\s{2}([A-Za-z0-9_-]+)\s*:/gm))
    .map((match) => match[1])
    .filter((task) => !task.startsWith('_'))
    .filter((task, index, all) => all.indexOf(task) === index);
  if (tasks.length === 0) return null;
  const scripts = tasks
    .map((task) => {
      const raw = firstTaskCommand(taskfile.content, task);
      return {
        name: task,
        command: `task ${task}`,
        raw,
        kind: inferKindFromScript(task, raw),
      };
    })
    .sort((a, b) => rankScript(a.name) - rankScript(b.name));
  return {
    label: 'taskfile project',
    hint: `${scripts.length} task targets`,
    scripts,
    defaultUrl: inferUrlFromScript(scripts[0]) || '',
    source: 'Taskfile.yml',
  };
};

const detectProcfile: RuntimeDetector = async (host) => {
  const content = (await readContent(host, 'Procfile')) ?? (await readContent(host, 'Procfile.dev'));
  if (content === null) return null;
  const entries = Array.from(content.matchAll(/^([A-Za-z0-9_-]+):\s*(.+)$/gm))
    .map((match) => ({ name: match[1], raw: match[2].trim() }));
  if (entries.length === 0) return null;
  const scripts = entries
    .map(({ name, raw }) => ({ name, command: raw, raw, kind: inferKindFromScript(name, raw) }))
    .sort((a, b) => rankScript(a.name) - rankScript(b.name));
  return {
    label: 'procfile',
    hint: `${scripts.length} process${scripts.length === 1 ? '' : 'es'}`,
    scripts,
    defaultUrl: inferUrlFromScript(scripts[0]) || '',
    source: 'Procfile',
  };
};

const detectDockerCompose: RuntimeDetector = async (host) => {
  const compose = await readFirstExisting(host, ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']).catch(() => null);
  if (!compose?.content) return null;
  const servicesBlock = /(?:^|\n)services:\s*\n([\s\S]*?)(?=\n[A-Za-z]+:\s*\n|$)/.exec(compose.content)?.[1] ?? '';
  const services = Array.from(servicesBlock.matchAll(/^\s{2}([A-Za-z0-9_-]+):/gm))
    .map((match) => match[1])
    .filter((name, index, all) => all.indexOf(name) === index);
  const scripts: DetectedScript[] = [
    { name: 'up', command: 'docker compose up', raw: 'docker compose up', kind: 'cli' },
    { name: 'up-d', command: 'docker compose up -d', raw: 'docker compose up -d', kind: 'cli' },
    { name: 'down', command: 'docker compose down', raw: 'docker compose down', kind: 'cli' },
    ...services.map((name): DetectedScript => ({
      name,
      command: `docker compose up ${name}`,
      raw: `docker compose up ${name}`,
      kind: 'cli',
    })),
  ];
  return {
    label: 'docker compose',
    hint: services.length > 0 ? `${services.length} service${services.length === 1 ? '' : 's'}` : 'compose stack',
    scripts,
    defaultUrl: '',
    source: 'docker-compose.yml',
  };
};

/* Detectors run in a stable display order. We collect every match instead of
   stopping at the first one so polyglot repos can choose Rust/Python/Go/etc.
   even when a package.json is also present. */
const RUNTIME_DETECTORS: RuntimeDetector[] = [
  detectNode,
  detectCargo,
  detectPython,
  detectGo,
  detectGradle,
  detectMaven,
  detectDotnet,
  detectSbt,
  detectMix,
  detectRuby,
  detectComposer,
  detectDeno,
  detectFlutter,
  detectCmake,
  detectBazel,
  detectNix,
  detectMake,
  detectJust,
  detectTask,
  detectProcfile,
  detectDockerCompose,
];

function runtimeKey(runtime: DetectedRuntime): string {
  return `${runtime.source}:${runtime.label}`;
}

async function runtimePreferenceScope(host: BuiltinPluginProps['host']): Promise<string> {
  try {
    const result = await host.state.get('project');
    const scoped = projectStateScope(result.value);
    if (scoped) return scoped;
  } catch {
    /* fall back to a file-tree fingerprint */
  }
  const files = await listProjectFiles(host, 2);
  if (files.length > 0) return `tree:${files.sort().slice(0, 64).join('|')}`;
  return 'default';
}

function projectStateScope(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!value || typeof value !== 'object') return null;
  const project = value as { path?: unknown; name?: unknown };
  if (typeof project.path === 'string' && project.path.trim()) return project.path.trim();
  if (typeof project.name === 'string' && project.name.trim()) return `name:${project.name.trim()}`;
  return null;
}

function runtimePreferenceStorageKey(scope: string) {
  return `${RUNTIME_PREFERENCE_STORAGE_PREFIX}:${encodeURIComponent(scope).slice(0, 512)}`;
}

function readStoredRuntimePreference(scope: string): string | null {
  const storageKey = runtimePreferenceStorageKey(scope);
  const memoryValue = runtimePreferenceMemory.get(storageKey) ?? null;
  try {
    return window.localStorage.getItem(storageKey) ?? memoryValue;
  } catch {
    return memoryValue;
  }
}

function storeRuntimePreference(scope: string, key: string) {
  const storageKey = runtimePreferenceStorageKey(scope);
  runtimePreferenceMemory.set(storageKey, key);
  try {
    window.localStorage.setItem(storageKey, key);
  } catch {
    /* localStorage can be unavailable in private contexts. */
  }
}

async function detectRuntimes(host: BuiltinPluginProps['host']): Promise<DetectedRuntime[]> {
  const runtimes: DetectedRuntime[] = [];
  const seen = new Set<string>();
  const addRuntime = (runtime: DetectedRuntime) => {
    const key = runtimeKey(runtime);
    if (seen.has(key)) return;
    seen.add(key);
    runtimes.push(runtime);
  };
  try {
    for (const runtime of await readConfiguredRuntimes(host)) addRuntime(runtime);
  } catch {
    /* invalid project runtime config should not block auto-detection. */
  }
  for (const detect of RUNTIME_DETECTORS) {
    try {
      const result = await detect(host);
      if (!result) continue;
      addRuntime(result);
    } catch {
      /* try next detector */
    }
  }
  return runtimes.length > 0 ? runtimes : [FALLBACK_RUNTIME];
}

type CurrentRun = {
  command: string;
  url: string;
  kind: PreviewTargetKind;
  rawHint: string;
  /* tauri/electron/native-launcher commands stay labeled "embedded app
     preview" even when falling back to an iframe (their dev URL). heuristic
     'desktop' classifications (e.g. an unknown executable with a 'launch'
     script name) render as plain "embedded preview" in iframe fallback —
     they were a guess, not an assertion. */
  explicitNative: boolean;
};

export function PreviewPanel({ header, host }: BuiltinPluginProps) {
  const [scriptsWidth, onScriptsResize] = useResizableSplit({ axis: 'x', initial: 28, min: 18, max: 46 });
  const [runtimes, setRuntimes] = useState<DetectedRuntime[]>([]);
  const [runtime, setRuntime] = useState<DetectedRuntime | null>(null);
  const [selectedScript, setSelectedScript] = useState<string>('');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<'window' | 'external'>('window');
  const [status, setStatus] = useState<'idle' | 'running' | 'external'>('idle');
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const logPaneRef = useRef<HTMLPreElement | null>(null);
  const logDrawerRef = useRef<HTMLPreElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [sessionId, setSessionId] = useState('');
  const [frameKey, setFrameKey] = useState(0);
  /* the frozen intent for the currently-active run. set in runInWindow/
     runOutside, cleared in stopPreview. while this is non-null, the
     rendered view is determined by currentRun.kind — not by ambient state
     like url-regex matches or preview.list rehydration. this is what
     prevents a cli/test run from being silently reclassified into a site
     iframe when a stray URL shows up. */
  const [currentRun, setCurrentRun] = useState<CurrentRun | null>(null);
  const commandRef = useRef('');
  const sessionIdRef = useRef('');
  const currentRunRef = useRef<CurrentRun | null>(null);
  const terminalFrameRef = useRef<HTMLPreElement | null>(null);
  /* tracks whether the user has interacted with the setup form. used to
     skip the preview.list() rehydration race that would otherwise clobber
     a fresh selection with the first-ever-registered target. */
  const userTouchedRef = useRef(false);
  const runtimePreferenceScopeRef = useRef('');

  const activeScript = useMemo(
    () => runtime?.scripts.find((script) => script.name === selectedScript) ?? null,
    [runtime, selectedScript],
  );
  const commandScript = useMemo(
    () => runtime?.scripts.find((script) => script.name === inferScriptNameFromCommand(command)) ?? null,
    [command, runtime],
  );
  const rawCommandHint = commandScript?.raw ?? (activeScript?.command === command ? activeScript.raw : undefined) ?? command;
  const inferredCommandKind = commandScript?.kind ?? inferKindFromScript(inferScriptNameFromCommand(command), command);
  /* setup-view kind: what the user is about to launch. used only for ui
     hints on the setup form. the running view reads from currentRun.kind. */
  const candidateKind = activeScript?.command === command ? activeScript.kind : inferredCommandKind;
  /* explicit native frameworks (tauri/electron/wails/...) ship a real OS
     window. their dev URL is the *frontend* served to that window, not
     the app. iframing it would silently swap the desktop runtime for a
     plain browser context — APIs missing, IPC missing — so we refuse to
     embed regardless of whether a URL was detected. */
  const candidateExplicitNative =
    /\b(tauri|electron|wails|neutralino|nw|nodewebkit|cargo\s+tauri)\b/i.test(`${command} ${rawCommandHint}`)
    || isNativeExecutableCommand(command)
    || isMacOpenNativeCommand(rawCommandHint)
    || isWindowsShellNativeCommand(rawCommandHint)
    || isLinuxLauncherNativeCommand(rawCommandHint)
    || isPackageExecNativeCommand(rawCommandHint);
  /* a run is embeddable in the panel iff it produces a surface the
     webview can host: an iframe (any url-having site/game/desktop) or
     a terminal (cli/test). pure-native gui (desktop with no devUrl,
     mobile simulators, native binaries) can't be embedded — only
     opened externally. */
  const canRunInWindow =
    !candidateExplicitNative
    && (
      candidateKind === 'cli'
      || candidateKind === 'test'
      || candidateKind === 'site'
      || candidateKind === 'game'
      || (candidateKind === 'desktop' && /https?:\/\//i.test(url))
    );
  const runInWindowReason = canRunInWindow
    ? ''
    : candidateExplicitNative
      ? 'this is a native desktop app — it launches its own OS window outside polypore'
      : candidateKind === 'mobile'
        ? 'mobile simulators always run as a separate window'
        : candidateKind === 'desktop'
          ? 'no embeddable url detected (raw native windows can\'t be hosted inside polypore)'
          : 'no embeddable surface detected for this command';
  const runUrlIsWebish = currentRun ? /https?:\/\//i.test(currentRun.url) : false;

  useEffect(() => {
    commandRef.current = command;
  }, [command]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    currentRunRef.current = currentRun;
  }, [currentRun]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([detectRuntimes(host), runtimePreferenceScope(host)]).then(([nextRuntimes, preferenceScope]) => {
      if (cancelled) return;
      runtimePreferenceScopeRef.current = preferenceScope;
      setRuntimes(nextRuntimes);
      const preferredKey = readStoredRuntimePreference(preferenceScope);
      const next = nextRuntimes.find((candidate) => runtimeKey(candidate) === preferredKey)
        ?? nextRuntimes[0]
        ?? FALLBACK_RUNTIME;
      setRuntime(next);
      const first = next.scripts[0];
      if (first && !userTouchedRef.current) {
        setSelectedScript(first.name);
        setCommand(first.command);
      }
      if (!userTouchedRef.current) setUrl(next.defaultUrl);
    });
    /* a previously registered preview target takes precedence — the user
       may have already edited the command for this project. but only if
       they haven't touched the form yet in this mount; otherwise this
       races their selection and clobbers it. */
    host.preview.list().then((result) => {
      if (cancelled || result.targets.length === 0 || userTouchedRef.current) return;
      const target = result.targets[result.targets.length - 1];
      setCommand(target.command);
      setUrl(target.target);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [host]);

  useEffect(() => host.terminal.onEvent((event) => {
    if (event.id !== sessionIdRef.current) return;
    if (event.kind === 'output' && event.data) {
      setLogs((current) => [...current, event.data ?? ''].slice(-400));
      /* gate URL promotion from stdout: cli/test runs never pick up URLs
         (a typecheck error mentioning http://localhost must not turn into
         an iframe). site/game/desktop/mobile may pick up URLs — a dev
         server printing its address, or a desktop heuristic that was
         actually a web target. */
      const run = currentRunRef.current;
      if (run && run.kind !== 'cli' && run.kind !== 'test') {
        const detectedUrl = extractPreviewUrl(event.data);
        if (detectedUrl) {
          setCurrentRun((prev) => {
            if (!prev) return prev;
            const prevPort = parseHostPort(prev.url)?.port;
            const detectedPort = parseHostPort(detectedUrl)?.port;
            const portMismatch = prevPort && detectedPort && prevPort !== detectedPort;
            const next = (!prev.url || portMismatch) ? { ...prev, url: detectedUrl } : prev;
            currentRunRef.current = next;
            return next;
          });
          setUrl((current) => {
            const currentPort = parseHostPort(current)?.port;
            const detectedPort = parseHostPort(detectedUrl)?.port;
            const portMismatch = currentPort && detectedPort && currentPort !== detectedPort;
            return (!current || portMismatch) ? detectedUrl : current;
          });
        }
      }
    }
    if (event.kind === 'exited') {
      setLogs((current) => [...current, `\n[process exited ${event.exitCode ?? 0}]\n`].slice(-400));
      setExitCode(event.exitCode ?? 0);
    }
  }), [host]);

  /* tail behavior: stick to the bottom of the log pane as new output
     arrives, but yield as soon as the user scrolls up to read history.
     a single threshold (~24px from the bottom) avoids fighting the user
     when they re-anchor by scrolling back down. */
  useEffect(() => {
    const node = logPaneRef.current;
    if (node && stickToBottomRef.current) node.scrollTop = node.scrollHeight;
    const termNode = terminalFrameRef.current;
    if (termNode) termNode.scrollTop = termNode.scrollHeight;
    const drawerNode = logDrawerRef.current;
    if (drawerNode) drawerNode.scrollTop = drawerNode.scrollHeight;
  }, [logs]);

  useEffect(() => {
    if (status === 'running' && mode === 'window' && currentRun && (currentRun.kind === 'cli' || currentRun.kind === 'test') && !runUrlIsWebish) {
      terminalFrameRef.current?.focus();
    }
  }, [currentRun, mode, runUrlIsWebish, status]);

  const pickRuntime = (nextRuntime: DetectedRuntime) => {
    userTouchedRef.current = true;
    persistRuntimePreference(nextRuntime);
    setRuntime(nextRuntime);
    const first = nextRuntime.scripts[0];
    setSelectedScript(first?.name ?? '');
    commandRef.current = first?.command ?? '';
    setCommand(first?.command ?? '');
    setUrl(nextRuntime.defaultUrl);
  };

  const persistRuntimePreference = (nextRuntime: DetectedRuntime) => {
    const key = runtimeKey(nextRuntime);
    if (runtimePreferenceScopeRef.current) {
      storeRuntimePreference(runtimePreferenceScopeRef.current, key);
      return;
    }
    runtimePreferenceScope(host).then((scope) => {
      runtimePreferenceScopeRef.current = scope;
      storeRuntimePreference(scope, key);
    }).catch(() => {});
  };

  const pickScript = (script: DetectedScript) => {
    userTouchedRef.current = true;
    setSelectedScript(script.name);
    commandRef.current = script.command;
    setCommand(script.command);
    const inferredUrl = script.raw ? inferUrlFromScript(script) : '';
    if (inferredUrl) {
      setUrl(inferredUrl);
      return;
    }
    if (script.kind === 'desktop') {
      readTauriDevUrl(host).then((devUrl) => setUrl(devUrl)).catch(() => setUrl(''));
      return;
    }
    setUrl('');
  };

  const resolveUrlForCommand = async (nextCommand: string): Promise<string> => {
    const scriptName = inferScriptNameFromCommand(nextCommand);
    const matchingScript = runtime?.scripts.find((script) => script.name === scriptName);
    const inferredKind = matchingScript?.kind ?? inferKindFromScript(scriptName, nextCommand);
    const raw = matchingScript?.raw ?? nextCommand;
    const inferredUrl = inferUrlFromScript({
      name: scriptName,
      command: nextCommand,
      raw,
      kind: inferredKind,
    });
    if (inferredUrl) return inferredUrl;
    if (inferredKind === 'desktop' && /\b(?:tauri|cargo\s+tauri)\b/i.test(`${nextCommand} ${raw}`)) {
      return readTauriDevUrl(host);
    }
    return '';
  };

  const changeCommand = (nextCommand: string) => {
    userTouchedRef.current = true;
    commandRef.current = nextCommand;
    setCommand(nextCommand);
    const scriptName = inferScriptNameFromCommand(nextCommand);
    const matchingScript = runtime?.scripts.find((script) => script.name === scriptName);
    const inferredKind = matchingScript?.kind ?? inferKindFromScript(scriptName, nextCommand);
    const raw = matchingScript?.raw ?? nextCommand;
    const immediateUrl = inferUrlFromScript({
      name: scriptName,
      command: nextCommand,
      raw,
      kind: inferredKind,
    });
    if (immediateUrl) {
      setUrl(immediateUrl);
    } else if (!(inferredKind === 'desktop' && /\b(?:tauri|cargo\s+tauri)\b/i.test(`${nextCommand} ${raw}`))) {
      setUrl('');
    }
    resolveUrlForCommand(nextCommand)
        .then((devUrl) => {
          if (commandRef.current === nextCommand) setUrl(devUrl);
        })
        .catch(() => {
          if (commandRef.current === nextCommand) setUrl('');
        });
  };

  const registerOnHost = async (run: CurrentRun) => {
    await host.preview.register({
      label: runtime?.label ?? 'preview',
      command: run.command,
      target: run.url,
      kind: run.kind,
    });
  };

  const startCommand = async (run: CurrentRun) => {
    if (!run.command.trim()) return;
    if (sessionId) {
      await host.terminal.stop(sessionId).catch(() => {});
      sessionIdRef.current = '';
      setSessionId('');
    }
    setLogs([`$ ${run.command}\n`]);
    setExitCode(null);
    const result = await host.terminal.spawn(run.command);
    sessionIdRef.current = result.session.id;
    setSessionId(result.session.id);
    if (result.session.status === 'exited') setExitCode(result.session.exitCode ?? 0);
    if (result.session.output) {
      setLogs((current) => [...current, result.session.output].slice(-400));
      /* same gating as the streaming listener: cli/test never adopt URLs
         from stdout. */
      if (run.kind !== 'cli' && run.kind !== 'test') {
        const detectedUrl = extractPreviewUrl(result.session.output);
        if (detectedUrl) {
          setCurrentRun((prev) => {
            if (!prev) return prev;
            const prevPort = parseHostPort(prev.url)?.port;
            const detectedPort = parseHostPort(detectedUrl)?.port;
            const portMismatch = prevPort && detectedPort && prevPort !== detectedPort;
            const next = (!prev.url || portMismatch) ? { ...prev, url: detectedUrl } : prev;
            currentRunRef.current = next;
            return next;
          });
          setUrl((current) => {
            const currentPort = parseHostPort(current)?.port;
            const detectedPort = parseHostPort(detectedUrl)?.port;
            const portMismatch = currentPort && detectedPort && currentPort !== detectedPort;
            return (!current || portMismatch) ? detectedUrl : current;
          });
        }
      }
    }
  };

  /* freeze the user's intent for this launch into a CurrentRun. the
     running/external views render against this snapshot rather than the
     editable form state, so a stray URL or late preview.list rehydration
     can't reclassify a cli/test run into an embedded site iframe.

     a URL inside the command itself (e.g. `open http://...`, `xdg-open
     http://...`) is treated as intentional and promotes a cli to a site
     run — the user is explicitly asking to display a page. URLs that
     appear only in stdout don't promote cli/test runs; that was the bug. */
  const buildRun = async (): Promise<CurrentRun> => {
    /* user-typed URL wins, and is authoritative for what the dev server
       binds to — not just where the iframe loads. when the URL parses
       into a host+port, applyUrlOverrideToCommand rewrites the command
       so the spawned process actually listens there. for npm scripts
       without `--port` flags we pass through via `-- --port HOST` so
       the underlying tool (vite/next/etc) picks them up.

       empty URL means "no iframe, just run the command" — falls
       through to the embedded terminal view. */
    const inlineUrl = extractPreviewUrl(command);
    const finalUrl = url.trim() || inlineUrl;
    const override = parseHostPort(url);
    const rewrittenCommand = override ? applyUrlOverrideToCommand(command, override) : command;
    const promoteToSite = candidateKind === 'cli' && !!(url.trim() || inlineUrl);
    const commandAndRaw = `${rewrittenCommand} ${rawCommandHint}`;
    const explicitNative = /\b(tauri|electron|wails|neutralino|nw|nodewebkit|cargo\s+tauri)\b/i.test(commandAndRaw)
      || isNativeExecutableCommand(rewrittenCommand)
      || isMacOpenNativeCommand(rawCommandHint)
      || isWindowsShellNativeCommand(rawCommandHint)
      || isLinuxLauncherNativeCommand(rawCommandHint)
      || isPackageExecNativeCommand(rawCommandHint);
    return {
      command: rewrittenCommand,
      url: finalUrl,
      kind: promoteToSite ? 'site' : candidateKind,
      rawHint: rawCommandHint,
      explicitNative,
    };
  };

  const runInWindow = async () => {
    userTouchedRef.current = true;
    setMode('window');
    setStatus('running');
    setLogsOpen(false);
    setFrameKey((key) => key + 1);
    const run = await buildRun();
    setUrl(run.url);
    currentRunRef.current = run;
    setCurrentRun(run);
    await registerOnHost(run).catch(() => {});
    await startCommand(run).catch((err) => {
      setLogs((current) => [...current, `${err instanceof Error ? err.message : String(err)}\n`]);
    });
  };

  const runOutside = async () => {
    userTouchedRef.current = true;
    setMode('external');
    setStatus('external');
    setLogsOpen(false);
    const run = await buildRun();
    setUrl(run.url);
    currentRunRef.current = run;
    setCurrentRun(run);
    await registerOnHost(run).catch(() => {});
    await startCommand(run).catch((err) => {
      setLogs((current) => [...current, `[spawn failed] ${err instanceof Error ? err.message : String(err)}\n`]);
      setExitCode((prev) => (prev ?? -1));
    });
    if (/https?:\/\//i.test(run.url) && run.kind !== 'desktop') await host.ui.openExternal(run.url).catch(() => {});
  };

  const refreshPreview = () => {
    setFrameKey((key) => key + 1);
    host.preview.refresh().catch(() => {});
  };

  const sendTerminalKey = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!sessionId) return;
    const data = terminalInputForKey(event);
    if (!data) return;
    event.preventDefault();
    host.terminal.write(sessionId, data).catch(() => {});
  };

  const sendTerminalPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    if (!sessionId) return;
    const text = event.clipboardData.getData('text');
    if (!text) return;
    event.preventDefault();
    host.terminal.write(sessionId, text).catch(() => {});
  };

  const stopPreview = () => {
    if (sessionId) {
      host.terminal.stop(sessionId).catch(() => {});
      sessionIdRef.current = '';
      setSessionId('');
    }
    setStatus('idle');
    setLogsOpen(false);
    currentRunRef.current = null;
    setCurrentRun(null);
  };

  const runKind = currentRun?.kind ?? candidateKind;
  const runCommand = currentRun?.command ?? command;
  const runUrl = currentRun?.url ?? url;
  const statusLabel =
    status === 'idle' ? 'not running'
    : status === 'running' ? 'running in window'
    : runUrlIsWebish && runKind !== 'desktop' ? 'opened outside'
    : 'running outside';
  const scripts = runtime?.scripts ?? [];
  const hasScripts = scripts.length > 0;
  const headerBar = (
    <PanelHeader {...header}>
      <span className="panel-header__title">preview</span>
      <span className="panel-header__sep" aria-hidden="true" />
      <span className="panel-header__meta">{runtime?.label ?? 'detecting…'}</span>
      <span className={`panel-header__meta preview-status preview-status--${status}`}>{statusLabel}</span>
    </PanelHeader>
  );

  if (status === 'running' && mode === 'window') {
    /* the running view is driven by the frozen run snapshot:
       - cli/test never reclassify into an iframe even if a URL ends up in
         state. this is the bug we fixed: typecheck output incidentally
         mentioning http://localhost stops being treated as a website.
       - desktop/mobile/site/game fall back to iframe when a URL is known
         and the run is embeddable. */
    const allowIframe = runKind !== 'cli' && runKind !== 'test';
    /* when the spawned process has died non-zero, the iframe is
       guaranteed to be looking at a dead URL — show the error overlay
       instead of a blank embed. zero-exit + iframe stays embedded
       (some servers fork off and the parent exits cleanly). */
    const processFailed = exitCode !== null && exitCode !== 0;
    const showIframe = allowIframe && runUrlIsWebish && !processFailed;
    const headerLabel = processFailed
      ? `process exited ${exitCode}`
      : showIframe
        ? (currentRun?.explicitNative ? 'embedded app preview' : 'embedded preview')
        : `${runKind} output`;
    return (
      <div className="preview-surface preview-surface--running">
        {headerBar}
        <section className="preview-output preview-output--fullscreen">
          <header>
            <strong className={processFailed ? 'preview-output__status preview-output__status--failed' : undefined}>{headerLabel}</strong>
            <span>{runUrl || runCommand}</span>
            <div className="preview-output__controls">
              <button onClick={refreshPreview} title="reload the iframe">refresh</button>
              <button onClick={() => void runInWindow()} title="kill and rerun the command">restart</button>
              <button onClick={() => void runOutside()} title="reopen in external window">open outside</button>
              <button
                className={logsOpen ? 'preview-output__log-toggle preview-output__log-toggle--active' : 'preview-output__log-toggle'}
                aria-expanded={logsOpen}
                onClick={() => setLogsOpen((open) => !open)}
              >
                logs
              </button>
              <button onClick={stopPreview} title="stop the command and return to setup">stop</button>
            </div>
          </header>
          {processFailed ? (
            <div className="preview-error" role="alert">
              <header>
                <strong>command failed</strong>
                <span>exit code {exitCode}</span>
              </header>
              <pre className="preview-error__log" aria-label="command error output">
                {stripAnsi(logs.join('').trimEnd()) || `$ ${runCommand}\n(no output captured)`}
              </pre>
              <footer>
                <button onClick={() => void runInWindow()}>retry</button>
                <button onClick={stopPreview}>back to setup</button>
              </footer>
            </div>
          ) : showIframe ? (
            <iframe
              key={frameKey}
              className="preview-iframe"
              title="project preview"
              src={runUrl}
              sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            />
          ) : (
            <pre
              ref={terminalFrameRef}
              className="preview-terminal-frame"
              aria-label="interactive preview terminal"
              tabIndex={0}
              onKeyDown={sendTerminalKey}
              onPaste={sendTerminalPaste}
            >
              {stripAnsi(logs.join('')) || `$ ${runCommand}\n`}
            </pre>
          )}
          {logsOpen && (
            <aside className="preview-log-drawer" aria-label="preview logs">
              <header>
                <div>
                  <strong>logs</strong>
                  <span>{runCommand}</span>
                </div>
                <button onClick={() => setLogsOpen(false)}>close</button>
              </header>
              <pre ref={logDrawerRef}>
                {stripAnsi(logs.join('')) || `$ ${runCommand}\nwaiting for preview output...\n`}
              </pre>
            </aside>
          )}
        </section>
      </div>
    );
  }

  if (status === 'external' && mode === 'external') {
    const isExternalBrowserish = runUrlIsWebish && runKind !== 'desktop';
    const exited = exitCode !== null;
    const failed = exited && exitCode !== 0;
    const statusLabel = failed
      ? `process exited ${exitCode}`
      : exited
      ? 'process exited'
      : isExternalBrowserish ? 'opened externally' : 'running externally';
    return (
      <div className="preview-surface preview-surface--external">
        {headerBar}
        <section className="preview-output preview-output--fullscreen preview-output--external">
          <header>
            <strong className={failed ? 'preview-output__status preview-output__status--failed' : 'preview-output__status'}>{statusLabel}</strong>
            <span>{runUrl || runCommand}</span>
            <div className="preview-output__controls">
              <button onClick={() => void host.ui.openExternal(runUrl || '').catch(() => {})} disabled={!isExternalBrowserish} title="reopen the url in your browser">open url</button>
              <button onClick={() => navigator.clipboard?.writeText(logs.join('') || runCommand).catch(() => {})} title="copy logs">copy logs</button>
              <button onClick={() => void runOutside()} title="kill and rerun">restart</button>
              <button onClick={() => void runInWindow()} title="switch to embedded mode">embed instead</button>
              <button onClick={stopPreview} title="stop and return to setup">stop</button>
            </div>
          </header>
          <pre
            ref={logPaneRef}
            className="preview-log-pane"
            aria-label="preview logs"
            role="log"
            onScroll={(event) => {
              const target = event.currentTarget;
              const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
              stickToBottomRef.current = distanceFromBottom < 24;
            }}
          >
            {logs.join('') || `$ ${runCommand}\nwaiting for preview output...\n`}
          </pre>
        </section>
      </div>
    );
  }

  return (
    <div className="preview-surface">
      {headerBar}
      <section className="preview-setup">
        <header className="preview-setup__head">
          <div className="preview-setup__title">
            <strong>{runtime?.label ?? 'detecting project…'}</strong>
            <small>{runtime?.hint ?? 'reading manifest from project root'}</small>
          </div>
          {runtime?.source && runtime.source !== 'fallback' && (
            <span className="preview-setup__source">via {runtime.source}</span>
          )}
        </header>

        <div
          className={`preview-setup__body ${hasScripts ? 'preview-setup__body--resizable' : 'preview-setup__body--single'}`}
          style={hasScripts ? ({ '--preview-scripts-width': `${scriptsWidth}%` } as React.CSSProperties) : undefined}
        >
          {hasScripts && (
            <aside className="preview-scripts" aria-label="detected commands">
              <header className="preview-scripts__head">
                <strong>scripts</strong>
                <small>{scripts.length}</small>
              </header>
              {runtimes.length > 1 && (
                <div className="preview-runtime-list" role="listbox" aria-label="detected runtimes">
                  {runtimes.map((item) => {
                    const key = runtimeKey(item);
                    const active = runtime ? runtimeKey(runtime) === key : false;
                    return (
                      <button
                        key={key}
                        type="button"
                        className={active ? 'preview-runtime preview-runtime--active' : 'preview-runtime'}
                        role="option"
                        aria-selected={active}
                        onClick={() => pickRuntime(item)}
                      >
                        <span>{item.label}</span>
                        <small>{item.source}</small>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="preview-scripts__list" role="radiogroup">
                {scripts.map((script) => (
                  <button
                    key={script.name}
                    type="button"
                    className={`preview-script ${selectedScript === script.name ? 'preview-script--active' : ''}`}
                    role="radio"
                    aria-checked={selectedScript === script.name}
                    onClick={() => pickScript(script)}
                  >
                    <span className="preview-script__name">{script.name}</span>
                    <code className="preview-script__cmd">{script.command}</code>
                  </button>
                ))}
              </div>
            </aside>
          )}
          {hasScripts && (
            <ResizeHandle axis="x" label="resize preview scripts and command form" onDrag={onScriptsResize} />
          )}

          <div className="preview-form">
            <label className="preview-input">
              <span>command</span>
              <input
                value={command}
                placeholder="command to run"
                spellCheck={false}
                onChange={(event) => changeCommand(event.target.value)}
              />
            </label>

            <label className="preview-input">
              <span>url <em>optional</em></span>
              <input
                value={url}
                placeholder="http://localhost:3000"
                spellCheck={false}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>

            <div className={`preview-cta ${canRunInWindow ? '' : 'preview-cta--external-only'}`}>
              {canRunInWindow ? (
                <>
                  <button
                    type="button"
                    className="preview-cta__primary"
                    onClick={() => void runInWindow()}
                    disabled={!command.trim()}
                  >
                    <span className="preview-cta__glyph" aria-hidden="true">▶</span>
                    run in window
                  </button>
                  <button
                    type="button"
                    className="preview-cta__secondary"
                    onClick={() => void runOutside()}
                    disabled={!command.trim()}
                  >
                    open externally
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="preview-cta__primary preview-cta__primary--external"
                  onClick={() => void runOutside()}
                  disabled={!command.trim()}
                  title={runInWindowReason || undefined}
                >
                  <span className="preview-cta__glyph" aria-hidden="true">↗</span>
                  open externally
                </button>
              )}
            </div>

            <p className="preview-form__hint">
              {runInWindowReason
                ? `${runInWindowReason}.`
                : `detection inferred from ${runtime?.source ?? 'project files'}. you (or the agent) can edit the command at any time.`}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
