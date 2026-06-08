import type { PanelManifest } from '../../packages/sdk/src';
import { lazyBuiltinPanel, type BuiltinPlugin } from '../shared';
import manifestJson from './polypore.json';

const MemoryPanel = lazyBuiltinPanel(() => import('./component'), 'MemoryPanel');

export const memoryPlugin: BuiltinPlugin = {
  manifest: manifestJson as PanelManifest,
  slot: 'memory',
  meta: { icon: 'kb', label: 'memory' },
  defaultOrder: 60,
  buildContext: ({ contextItems, contextByChat, contextDocsByChat, onAddContext, onRemoveContext }) => ({
    contextItems,
    contextByChat,
    contextDocsByChat,
    onAddContext,
    onRemoveContext,
  }),
  Component: MemoryPanel,
};

export default memoryPlugin;
