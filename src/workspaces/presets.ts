import { UserWorkspacePreset, WorkspacePreset } from '../core/types';

const USER_PRESETS_KEY_PREFIX = 'polypore.workspace.userPresets.v1|';
const USER_PRESET_LAYOUT_KEY_PREFIX = 'polypore.workspace.presetLayout.v1|';
const ACTIVE_WORKSPACE_KEY_PREFIX = 'polypore.workspace.active.v1|';

export const workspacePresets: WorkspacePreset[] = [
  {
    schemaVersion: 1,
    name: 'Default',
    panels: ['codex', 'claude', 'preview', 'editor', 'diff-stack', 'terminal', 'debug', 'memory', 'extensions'],
    emphasis: ['preview', 'editor'],
    layout: [
      { slot: 'codex', position: 'left', size: 1 / 3 },
      { slot: 'claude', position: 'left', tabIndex: 0 },
      { slot: 'preview', position: 'center' },
      { slot: 'editor', position: 'center' },
      { slot: 'diff-stack', position: 'center' },
      { slot: 'terminal', position: 'center' },
      { slot: 'debug', position: 'center' },
      { slot: 'memory', position: 'center' },
      { slot: 'extensions', position: 'center' },
    ],
  },
];

export function getWorkspacePreset(name: WorkspacePreset['name']) {
  return workspacePresets.find((workspace) => workspace.name === name) ?? workspacePresets[0];
}

function browserStorage(): Storage | null {
  try {
    const storage = window.localStorage;
    return typeof storage?.getItem === 'function'
      && typeof storage?.setItem === 'function'
      && typeof storage?.removeItem === 'function'
      ? storage
      : null;
  } catch {
    return null;
  }
}

function userPresetsStorageKey(projectPath: string) {
  return `${USER_PRESETS_KEY_PREFIX}${encodeURIComponent(projectPath)}`;
}

function activeWorkspaceStorageKey(projectPath: string) {
  return `${ACTIVE_WORKSPACE_KEY_PREFIX}${encodeURIComponent(projectPath)}`;
}

export function workspaceLayoutStorageKey(name: string, projectPath: string) {
  return `polypore.layout.v1|${name}|${projectPath}`;
}

export function workspacePresetLayoutStorageKey(name: string, projectPath: string) {
  return `${USER_PRESET_LAYOUT_KEY_PREFIX}${encodeURIComponent(projectPath)}|${encodeURIComponent(name)}`;
}

export function loadUserPresets(projectPath: string): UserWorkspacePreset[] {
  if (!projectPath) return [];
  const storage = browserStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(userPresetsStorageKey(projectPath));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.filter((preset): preset is UserWorkspacePreset => {
      if (typeof preset?.name !== 'string' || !preset.name.trim() || typeof preset?.savedAt !== 'number') {
        return false;
      }
      const normalized = preset.name.toLowerCase();
      if (seen.has(normalized) || workspacePresets.some((item) => item.name.toLowerCase() === normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    });
  } catch {
    return [];
  }
}

export function loadActiveWorkspace(projectPath: string, userPresets: UserWorkspacePreset[]): string | null {
  if (!projectPath) return null;
  const storage = browserStorage();
  if (!storage) return null;
  try {
    const saved = storage.getItem(activeWorkspaceStorageKey(projectPath));
    if (!saved) return null;
    const normalized = saved.toLowerCase();
    const builtin = workspacePresets.find((preset) => preset.name.toLowerCase() === normalized);
    if (builtin) return builtin.name;
    return userPresets.find((preset) => preset.name.toLowerCase() === normalized)?.name ?? null;
  } catch {
    return null;
  }
}

export function saveActiveWorkspace(projectPath: string, name: string) {
  if (!projectPath) return;
  const storage = browserStorage();
  if (!storage) throw new Error('workspace storage is unavailable');
  storage.setItem(activeWorkspaceStorageKey(projectPath), name);
}

function restoreStorageValue(storage: Storage, key: string, value: string | null) {
  if (value === null) storage.removeItem(key);
  else storage.setItem(key, value);
}

function assertUserPresetName(name: string) {
  if (!name || name !== name.trim() || name.length > 48) {
    throw new Error('workspace preset name is invalid');
  }
  if (workspacePresets.some((preset) => preset.name.toLowerCase() === name.toLowerCase())) {
    throw new Error('workspace preset name is reserved');
  }
}

export function saveWorkspaceLayout(projectPath: string, name: string, layout: unknown) {
  const storage = browserStorage();
  if (!storage) throw new Error('workspace storage is unavailable');
  const serializedLayout = JSON.stringify(layout);
  if (!serializedLayout) throw new Error('workspace layout could not be serialized');
  storage.setItem(workspaceLayoutStorageKey(name, projectPath), serializedLayout);
}

export function saveUserPreset(projectPath: string, name: string, layout: unknown): UserWorkspacePreset[] {
  assertUserPresetName(name);
  const storage = browserStorage();
  if (!storage) throw new Error('workspace storage is unavailable');
  const serializedLayout = JSON.stringify(layout);
  if (!serializedLayout) throw new Error('workspace layout could not be serialized');

  const existing = loadUserPresets(projectPath).filter(
    (preset) => preset.name.toLowerCase() !== name.toLowerCase(),
  );
  const updated = [...existing, { name, savedAt: Date.now() }];
  const metadataKey = userPresetsStorageKey(projectPath);
  const layoutKey = workspaceLayoutStorageKey(name, projectPath);
  const presetLayoutKey = workspacePresetLayoutStorageKey(name, projectPath);
  const previous = [
    [metadataKey, storage.getItem(metadataKey)],
    [layoutKey, storage.getItem(layoutKey)],
    [presetLayoutKey, storage.getItem(presetLayoutKey)],
  ] as const;

  try {
    storage.setItem(layoutKey, serializedLayout);
    storage.setItem(presetLayoutKey, serializedLayout);
    storage.setItem(metadataKey, JSON.stringify(updated));
    return updated;
  } catch (error) {
    for (const [key, value] of previous) {
      try {
        restoreStorageValue(storage, key, value);
      } catch {
        // Preserve the original storage failure.
      }
    }
    throw error;
  }
}

export function resetWorkspaceLayout(projectPath: string, name: string): boolean {
  const storage = browserStorage();
  if (!storage) return false;
  try {
    const savedLayout = storage.getItem(workspacePresetLayoutStorageKey(name, projectPath));
    if (!savedLayout) return false;
    storage.setItem(workspaceLayoutStorageKey(name, projectPath), savedLayout);
    return true;
  } catch {
    return false;
  }
}

export function restoreWorkspacePresetLayout(projectPath: string, name: string): boolean {
  if (workspacePresets.some((preset) => preset.name.toLowerCase() === name.toLowerCase())) {
    removeWorkspaceLayout(projectPath, name);
    return true;
  }
  return resetWorkspaceLayout(projectPath, name);
}

export function removeWorkspaceLayout(projectPath: string, name: string) {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.removeItem(workspaceLayoutStorageKey(name, projectPath));
  } catch {
    // Reset remains a no-op when browser storage is unavailable.
  }
}

export function deleteUserPreset(projectPath: string, name: string): UserWorkspacePreset[] {
  const storage = browserStorage();
  if (!storage) throw new Error('workspace storage is unavailable');
  const updated = loadUserPresets(projectPath).filter(
    (preset) => preset.name.toLowerCase() !== name.toLowerCase(),
  );
  storage.setItem(userPresetsStorageKey(projectPath), JSON.stringify(updated));
  storage.removeItem(workspaceLayoutStorageKey(name, projectPath));
  storage.removeItem(workspacePresetLayoutStorageKey(name, projectPath));
  return updated;
}
