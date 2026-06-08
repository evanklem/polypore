import { WorkspacePreset } from '../core/types';

export const workspacePresets: WorkspacePreset[] = [
  {
    schemaVersion: 1,
    name: 'Build',
    panels: ['chat', 'preview', 'editor', 'diff-stack', 'terminal', 'timeline', 'extensions'],
    emphasis: ['preview', 'editor'],
  },
];

export function getWorkspacePreset(name: WorkspacePreset['name']) {
  return workspacePresets.find((workspace) => workspace.name === name) ?? workspacePresets[0];
}
