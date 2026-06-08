import { PanelDefinition } from './types';

export const panelDefinitions: PanelDefinition[] = [
  { id: 'chat', title: 'chat', requiredCapabilities: ['streaming'], defaultArea: 'left' },
  { id: 'editor', title: 'editor', requiredCapabilities: [], defaultArea: 'center' },
  { id: 'problems', title: 'problems', requiredCapabilities: [], defaultArea: 'bottom' },
  { id: 'diff-stack', title: 'diff stack', requiredCapabilities: ['tool-use'], defaultArea: 'right' },
  { id: 'preview', title: 'preview', requiredCapabilities: [], defaultArea: 'center' },
  { id: 'verify', title: 'verify', requiredCapabilities: ['tool-servers'], defaultArea: 'bottom' },
  { id: 'memory', title: 'memory', requiredCapabilities: ['memory-dir'], defaultArea: 'right' },
  { id: 'timeline', title: 'history', requiredCapabilities: ['tool-use'], defaultArea: 'center' },
  { id: 'terminal', title: 'terminal', requiredCapabilities: [], defaultArea: 'bottom' },
  { id: 'extensions', title: 'agent', requiredCapabilities: ['tool-use'], defaultArea: 'center' },
];

export function getPanelDefinition(id: PanelDefinition['id']) {
  return panelDefinitions.find((panel) => panel.id === id);
}
