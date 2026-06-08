import type { Diagnostic } from '../../packages/sdk/src';

export type EditorMarker = {
  severity: number;
  message: string;
  source?: string;
  code?: string | { value: string };
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

export type TypeScriptProjectConfig = {
  types: string[];
};

export function normalizeTypeScriptProjectConfig(value: unknown): TypeScriptProjectConfig {
  if (!value || typeof value !== 'object') return { types: [] };
  const compilerOptions = (value as { compilerOptions?: unknown }).compilerOptions;
  if (!compilerOptions || typeof compilerOptions !== 'object') return { types: [] };
  return { types: normalizeTypeSpecifierList((compilerOptions as { types?: unknown }).types) };
}

function normalizeTypeSpecifierList(value: unknown): string[] {
  const seen = new Set<string>();
  return normalizeStringList(value).flatMap((item) => {
    const normalized = item.trim().replace(/^types:/, '');
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
}

export function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === 'string' && item.trim() ? [item.trim()] : []));
}

export function ambientTypeSpecifiersForPath(path: string, projectTypes: string[] = []): string[] {
  const specifiers = new Set<string>(['vite/client']);
  for (const type of projectTypes) {
    if (type.trim()) specifiers.add(type.trim());
  }
  if (isTestPath(path)) {
    specifiers.add('vitest/globals');
    specifiers.add('@testing-library/jest-dom/vitest');
    specifiers.add('@types/node');
  }
  if (isLikelyNodePath(path)) {
    specifiers.add('@types/node');
  }
  return [...specifiers];
}

function isTestPath(path: string) {
  return /(?:^|[\\/])[^\\/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path)
    || /(?:^|[\\/])(?:__tests__|test|tests)[\\/]/i.test(path);
}

function isLikelyNodePath(path: string) {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  return normalized === 'vite.config.ts'
    || normalized.endsWith('.config.ts')
    || normalized.startsWith('packages/host/')
    || normalized.startsWith('scripts/')
    || normalized.includes('/node/')
    || normalized.includes('/server/');
}

export function dirname(path: string) {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash < 0 ? '.' : path.slice(0, lastSlash);
}

export function normalizeEditorPath(path: string) {
  const normalized: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }
  return normalized.join('/');
}

export function nodeModuleMirrorRootsForPath(path: string, workspaceFiles: string[] = []): string[] {
  const normalized = normalizeEditorPath(path);
  const workspaceFileSet = new Set(workspaceFiles);
  for (const dir of ancestorDirs(dirname(normalized))) {
    const packageJson = dir ? `${dir}/package.json` : 'package.json';
    if (workspaceFileSet.has(packageJson)) return dir ? [dir] : [];
  }
  const agentWorktree = normalized.match(/^(\.claude\/worktrees\/[^/]+)\//);
  return agentWorktree ? [agentWorktree[1]] : [];
}

function ancestorDirs(start: string) {
  const dirs: string[] = [];
  let current = start === '.' ? '' : start;
  while (current) {
    dirs.push(current);
    current = dirname(current);
    if (current === '.') current = '';
  }
  dirs.push('');
  return dirs;
}

export function extraLibPathsForPath(path: string, nodeModuleMirrorRoots: string[] = []): string[] {
  const normalized = normalizeEditorPath(path);
  const paths = new Set([normalized]);
  if (normalized.startsWith('node_modules/')) {
    const nodeModulePath = normalized.slice('node_modules/'.length);
    for (const root of nodeModuleMirrorRoots) {
      const normalizedRoot = normalizeEditorPath(root);
      if (normalizedRoot) paths.add(`${normalizedRoot}/node_modules/${nodeModulePath}`);
    }
  }
  return [...paths];
}

export function markerSeverity(severity: number): Diagnostic['severity'] {
  if (severity >= 8) return 'error';
  if (severity >= 4) return 'warn';
  if (severity >= 2) return 'info';
  return 'hint';
}

export function markerCode(code: EditorMarker['code']) {
  if (!code) return '';
  return typeof code === 'string' ? code : code.value;
}

export function isActionableMonacoMarker(marker: { severity: number; code?: EditorMarker['code'] }) {
  if (markerSeverity(marker.severity) === 'hint') return false;
  /* TS2307 "Cannot find module X" from Monaco's in-browser TS worker is always
     a hydration artifact: the worker only sees the types we manually feed it via
     addExtraLib, so unloaded packages appear missing until hydration completes.
     Real missing-module errors are caught by the host's tsc --noEmit diagnostics,
     so suppressing this code loses no real signal. */
  if (markerCode(marker.code) === '2307') return false;
  return true;
}
