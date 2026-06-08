import type { PanelManifest } from '../../packages/sdk/src';
import type { BuiltinPlugin } from '../shared';
import manifestJson from './polypore.json';
import { DiffHistoryPanel } from './component';

/* The timeline was folded into the primary diff-history surface. Keep this
   plugin registered as the one user-facing history/diff panel. */
export const diffHistoryPlugin: BuiltinPlugin = {
  manifest: manifestJson as PanelManifest,
  slot: 'diff-stack',
  meta: { icon: '+-', label: 'diff' },
  defaultOrder: 30,
  Component: DiffHistoryPanel,
};

const plugins: BuiltinPlugin[] = [diffHistoryPlugin];
export default plugins;
