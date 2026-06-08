import type { PanelManifest } from '../../packages/sdk/src';
import { lazyBuiltinPanel, type BuiltinPlugin } from '../shared';
import manifestJson from './polypore.json';

const EditorPanel = lazyBuiltinPanel(() => import('./component'), 'EditorPanel');

/* monaco's editor.main is dynamic-imported inside EditorPanel on first mount
   (3.3MB / ~845KB gzip — registers every basic-language contribution). the
   component chunk itself is small; this is the real cost of opening the
   editor tab. preload it during the post-boot prefetch window so the click
   doesn't pay it. */
const prefetchMonacoMain = () => import('monaco-editor/esm/vs/editor/editor.main');

export const editorPlugin: BuiltinPlugin = {
  manifest: manifestJson as PanelManifest,
  slot: 'editor',
  meta: { icon: '{}', label: 'editor' },
  defaultOrder: 20,
  prefetch: prefetchMonacoMain,
  Component: EditorPanel,
};

export default editorPlugin;
