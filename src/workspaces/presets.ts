import { WorkspacePreset } from '../core/types';

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
