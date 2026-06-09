import { beforeEach, expect, test } from 'vitest';
import {
  deleteUserPreset,
  loadActiveWorkspace,
  loadUserPresets,
  resetWorkspaceLayout,
  saveActiveWorkspace,
  saveUserPreset,
  workspaceLayoutStorageKey,
  workspacePresetLayoutStorageKey,
} from './presets';

beforeEach(() => {
  window.localStorage.clear();
});

test('user workspace presets are project-scoped and keep a reset point', () => {
  const savedLayout = {
    panels: { editor: { id: 'editor' } },
    grid: { root: { type: 'leaf' } },
  };

  saveUserPreset('/projects/one', 'Review', savedLayout);

  expect(loadUserPresets('/projects/one')).toEqual([
    { name: 'Review', savedAt: expect.any(Number) },
  ]);
  expect(loadUserPresets('/projects/two')).toEqual([]);
  expect(JSON.parse(window.localStorage.getItem(
    workspaceLayoutStorageKey('Review', '/projects/one'),
  ) ?? '')).toEqual(savedLayout);

  window.localStorage.setItem(
    workspaceLayoutStorageKey('Review', '/projects/one'),
    JSON.stringify({ panels: {}, grid: {} }),
  );

  expect(resetWorkspaceLayout('/projects/one', 'Review')).toBe(true);
  expect(JSON.parse(window.localStorage.getItem(
    workspaceLayoutStorageKey('Review', '/projects/one'),
  ) ?? '')).toEqual(savedLayout);
});

test('deleting a user preset removes its project metadata and layouts', () => {
  saveUserPreset('/projects/one', 'Review', { panels: {}, grid: {} });

  deleteUserPreset('/projects/one', 'Review');

  expect(loadUserPresets('/projects/one')).toEqual([]);
  expect(window.localStorage.getItem(
    workspaceLayoutStorageKey('Review', '/projects/one'),
  )).toBeNull();
  expect(window.localStorage.getItem(
    workspacePresetLayoutStorageKey('Review', '/projects/one'),
  )).toBeNull();
});

test('the active workspace is restored only when it exists in that project', () => {
  const presets = saveUserPreset('/projects/one', 'Review', { panels: {}, grid: {} });
  saveActiveWorkspace('/projects/one', 'Review');

  expect(loadActiveWorkspace('/projects/one', presets)).toBe('Review');
  expect(loadActiveWorkspace('/projects/two', [])).toBeNull();

  deleteUserPreset('/projects/one', 'Review');
  expect(loadActiveWorkspace('/projects/one', [])).toBeNull();
});

test('workspace reads degrade safely when browser storage rejects access', () => {
  const previousStorage = window.localStorage;
  const blockedStorage = {
    getItem() {
      throw new DOMException('blocked', 'SecurityError');
    },
    removeItem() {
      throw new DOMException('blocked', 'SecurityError');
    },
    setItem() {
      throw new DOMException('blocked', 'SecurityError');
    },
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: blockedStorage,
  });

  try {
    expect(loadUserPresets('/projects/one')).toEqual([]);
    expect(loadActiveWorkspace('/projects/one', [])).toBeNull();
    expect(resetWorkspaceLayout('/projects/one', 'Review')).toBe(false);
  } finally {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: previousStorage,
    });
  }
});

test('a user preset cannot overwrite the built-in workspace', () => {
  expect(() => saveUserPreset('/projects/one', 'Default', {
    panels: {},
    grid: {},
  })).toThrow('workspace preset name is reserved');
  expect(window.localStorage.getItem(
    workspaceLayoutStorageKey('Default', '/projects/one'),
  )).toBeNull();
});
