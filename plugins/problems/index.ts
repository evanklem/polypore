import type { PanelManifest } from '../../packages/sdk/src';
import { lazyBuiltinPanel, type BuiltinPlugin } from '../shared';
import manifestJson from './polypore.json';

const ProblemsPanel = lazyBuiltinPanel(() => import('./component'), 'ProblemsPanel');

export const problemsPlugin: BuiltinPlugin = {
  manifest: manifestJson as PanelManifest,
  slot: 'problems',
  meta: { icon: '!', label: 'problems' },
  Component: ProblemsPanel,
  inDefaultStrip: false,
};

export default problemsPlugin;
