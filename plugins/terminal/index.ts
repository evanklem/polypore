import type { PanelManifest } from '../../packages/sdk/src';
import { lazyBuiltinPanel, type BuiltinPlugin } from '../shared';
import manifestJson from './polypore.json';

const TerminalPanel = lazyBuiltinPanel(() => import('./component'), 'TerminalPanel');

export const terminalPlugin: BuiltinPlugin = {
  manifest: manifestJson as PanelManifest,
  slot: 'terminal',
  meta: { icon: '$', label: 'terminal' },
  defaultOrder: 40,
  Component: TerminalPanel,
};

export default terminalPlugin;
