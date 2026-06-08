import type { PanelManifest } from '../../packages/sdk/src';
import { lazyBuiltinPanel, type BuiltinPlugin } from '../shared';
import manifestJson from './polypore.json';

const DebugPanel = lazyBuiltinPanel(() => import('./component'), 'DebugPanel');

export const debugPlugin: BuiltinPlugin = {
  manifest: manifestJson as PanelManifest,
  slot: 'debug',
  meta: { icon: 'db', label: 'debug' },
  defaultOrder: 50,
  Component: DebugPanel,
};

export default debugPlugin;
