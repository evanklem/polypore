import type { PanelManifest } from '../../packages/sdk/src';
import { lazyBuiltinPanel, type BuiltinPlugin } from '../shared';
import manifestJson from './polypore.json';

const PreviewPanel = lazyBuiltinPanel(() => import('./component'), 'PreviewPanel');

export const previewPlugin: BuiltinPlugin = {
  manifest: manifestJson as PanelManifest,
  slot: 'preview',
  meta: { icon: 'run', label: 'preview' },
  defaultOrder: 10,
  Component: PreviewPanel,
};

export default previewPlugin;
