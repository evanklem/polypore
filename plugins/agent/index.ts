import type { PanelManifest } from '../../packages/sdk/src';
import { lazyBuiltinPanel, type BuiltinPlugin } from '../shared';
import manifestJson from './polypore.json';

const AgentPanel = lazyBuiltinPanel(() => import('./component'), 'AgentPanel');

export const agentPlugin: BuiltinPlugin = {
  manifest: manifestJson as PanelManifest,
  slot: 'extensions',
  meta: { icon: 'ai', label: 'agent' },
  defaultOrder: 70,
  buildContext: () => ({}),
  Component: AgentPanel,
};

export default agentPlugin;
