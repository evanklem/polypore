import { describe, expect, test } from 'vitest';
import {
  ambientTypeSpecifiersForPath,
  extraLibPathsForPath,
  isActionableMonacoMarker,
  nodeModuleMirrorRootsForPath,
  normalizeTypeScriptProjectConfig,
} from './ambient-types';

describe('editor TypeScript ambient type hydration', () => {
  test('mirrors tsconfig compilerOptions.types into Monaco hydration', () => {
    expect(normalizeTypeScriptProjectConfig({
      compilerOptions: {
        types: ['vite/client', 'vitest/globals', 'vite/client', 'types:@types/node', ''],
      },
    })).toEqual({ types: ['vite/client', 'vitest/globals', '@types/node'] });
  });

  test('loads project ambient types for ordinary source files', () => {
    expect(ambientTypeSpecifiersForPath('src/App.tsx', ['vitest/globals'])).toEqual([
      'vite/client',
      'vitest/globals',
    ]);
  });

  test('loads project, test, jest-dom, and node types for test files', () => {
    expect(ambientTypeSpecifiersForPath('plugins/agent/EmptyState.test.tsx', ['vite/client'])).toEqual([
      'vite/client',
      'vitest/globals',
      '@testing-library/jest-dom/vitest',
      '@types/node',
    ]);
  });

  test('loads node ambient types for host-side TypeScript without adding test globals', () => {
    expect(ambientTypeSpecifiersForPath('packages/host/src/rpc-server.ts', [])).toEqual([
      'vite/client',
      '@types/node',
    ]);
    expect(ambientTypeSpecifiersForPath('vite.config.ts', [])).toEqual([
      'vite/client',
      '@types/node',
    ]);
  });

  test('mirrors node_modules declarations into nested agent worktrees', () => {
    const worktreeRoot = '.claude/worktrees/agent-a39821ffefee81420';
    const mirrorRoots = nodeModuleMirrorRootsForPath(`${worktreeRoot}/src/App.test.tsx`, [
      'package.json',
      `${worktreeRoot}/package.json`,
      `${worktreeRoot}/src/App.test.tsx`,
    ]);

    expect(mirrorRoots).toEqual([worktreeRoot]);
    expect(extraLibPathsForPath('node_modules/@types/react/index.d.ts', mirrorRoots)).toEqual([
      'node_modules/@types/react/index.d.ts',
      `${worktreeRoot}/node_modules/@types/react/index.d.ts`,
    ]);
  });

  test('does not count Monaco hint markers as editor problems', () => {
    expect(isActionableMonacoMarker({ severity: 1 })).toBe(false);
    expect(isActionableMonacoMarker({ severity: 4 })).toBe(true);
    expect(isActionableMonacoMarker({ severity: 8 })).toBe(true);
  });

  test('suppresses TS2307 cannot-find-module from Monaco markers', () => {
    // TS2307 is always a hydration artifact; real errors are caught by tsc.
    expect(isActionableMonacoMarker({ severity: 8, code: '2307' })).toBe(false);
    expect(isActionableMonacoMarker({ severity: 8, code: { value: '2307' } })).toBe(false);
    // Other error codes still surface.
    expect(isActionableMonacoMarker({ severity: 8, code: '2339' })).toBe(true);
    expect(isActionableMonacoMarker({ severity: 8, code: undefined })).toBe(true);
  });
});
