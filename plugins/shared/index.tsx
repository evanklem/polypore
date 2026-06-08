import React from 'react';
import type { PanelManifest } from '../../packages/sdk/src';
import type { PolyporeHost } from '../../packages/sdk/src/host';

export type PanelContextDocState = 'loaded' | 'compacted' | 'queued';

export type PanelContextDoc = {
  path: string;
  bytes: number;
  tokens: number;
  state: PanelContextDocState;
  readCount: number;
  contextItem?: string;
};

/* the contract every built-in plugin honors. a plugin is self-describing:
   manifest + a slot key (used by workspace presets) + tab meta. manual prose
   lives in MANUAL.md and is joined through the manual corpus. it then renders either as an in-tree react component
   (built-ins trusted with the host bundle) or as an iframe (sandboxed,
   third-party-style). dropping a folder under plugins/<id>/ and exporting
   the right shape is sufficient to ship a new panel — App.tsx never names
   a specific plugin. */
export type BuiltinPlugin = {
  manifest: PanelManifest;
  slot: string;
  meta: { icon: string; label: string };
  Component?: React.FC<BuiltinPluginProps>;
  iframe?: PluginIframeDescriptor;
  /* opaque context bag passed to the component via props. used by memory
     today; legacy seam, will go away once those panels read from host.*. */
  buildContext?: (args: {
    contextItems: string[];
    contextByChat: Record<string, string[]>;
    contextDocsByChat: Record<string, PanelContextDoc[]>;
    onAddContext: (label: string, targetId?: string) => void;
    onRemoveContext: (label: string, targetId?: string) => void;
  }) =>
    Record<string, unknown> | undefined;
  /* if false, the plugin is registered but not shown in the default tab
     strip / workspace preset. */
  inDefaultStrip?: boolean;
  /* sort key for the default tab strip; smaller numbers come first. plugins
     without a value drop to the end in glob order. */
  defaultOrder?: number;
  /* "deep" warmup. lazyBuiltinPanel auto-attaches a chunk prefetch to the
     Component (warms the ~30KB wrapper). but some panels dynamic-import
     heavyweight bundles *inside* their component on first mount — monaco's
     3.3MB editor.main is the obvious one. expose those imports here so the
     post-boot driver can fetch them too. idempotent; called concurrently
     with the chunk prefetch. */
  prefetch?: () => Promise<unknown>;
};

export type PluginIframeDescriptor = {
  /* srcdoc path — built-in iframe plugins that bundle their own HTML. called
     by App.tsx with the runtime boot context; returns a complete srcdoc
     string. exactly one of build/url must be provided. */
  build?: (context: PluginIframeBuildContext) => string;
  /* URL path — external plugins distributed as standalone bundles served from
     a file:// path, Tauri custom protocol, or absolute https:// URL. the host
     appends ?pluginId= so the bundled SDK can self-identify without inline
     script injection. exactly one of build/url must be provided. */
  url?: string;
};

export type PluginIframeBuildContext = {
  buildPluginSrcdoc: (args: {
    manifest: PanelManifest;
    sdkRuntime: string;
    pluginScript: string;
    pluginCss?: string;
    bodyHtml?: string;
    instanceId?: string;
  }) => string;
  sdkRuntime: string;
  boot: Record<string, unknown>;
};

export type BuiltinPluginProps = {
  host: PolyporeHost;
  header: PanelHeaderProps;
  /* panels that historically read app-level context through props instead of
     the host (memory's loaded-context strip is the only one currently) get
     their data through this opaque bag. once they migrate onto host.* this
     prop disappears. */
  context?: Record<string, unknown>;
};

export type PanelLazyComponent = React.FC<BuiltinPluginProps> & {
  /* warm the panel's JS chunk without rendering. resolves once the chunk
     has been fetched + parsed + the component export resolved, so a
     subsequent React.lazy render mounts synchronously without a Suspense
     fallback flash. idempotent — repeated calls share one promise. */
  prefetch: () => Promise<void>;
};

export function lazyBuiltinPanel<T extends Record<string, unknown>>(
  loader: () => Promise<T>,
  exportName: keyof T & string,
): PanelLazyComponent {
  /* one shared promise for both manual prefetch and React.lazy's own
     consumption. without the cache, calling prefetch() then rendering
     LazyPanel would fire the dynamic import twice. */
  let cached: Promise<{ default: React.FC<BuiltinPluginProps> }> | null = null;
  const cachedLoader = () => {
    if (!cached) {
      cached = loader().then((mod) => ({
        default: mod[exportName] as React.FC<BuiltinPluginProps>,
      }));
    }
    return cached;
  };
  const LazyPanel: React.LazyExoticComponent<React.FC<BuiltinPluginProps>> = React.lazy(cachedLoader);
  function LazyBuiltinPanel(props: BuiltinPluginProps) {
    return React.createElement(LazyPanel, props);
  }
  LazyBuiltinPanel.displayName = `LazyBuiltinPanel(${String(exportName)})`;
  LazyBuiltinPanel.prefetch = () => cachedLoader().then(() => undefined);
  return LazyBuiltinPanel as PanelLazyComponent;
}

/* read .prefetch off a plugin's Component without losing type safety on
   plugins whose component isn't lazy (some Components are eagerly imported
   today). returns null for non-prefetchable components. */
export function pluginPrefetch(plugin: BuiltinPlugin): (() => Promise<void>) | null {
  const Component = plugin.Component as undefined | PanelLazyComponent;
  return Component && typeof Component.prefetch === 'function' ? Component.prefetch : null;
}

/* lightweight perf-mark helper. surfaces in DevTools Performance/Timeline
   AND logs to the Console with relative timestamps so traces are readable
   on WebKitGTK (where the Timelines recorder freezes the inspected page).
   open the Web Inspector Console tab, click around, and grep "[perf]" to
   read the trace.

   the perf log is gated on a session storage flag so production noise
   stays off. enable with `window.__POLYPORE_PERF__ = true` in the console
   (set via boot localStorage flag below — automatic for now while we're
   diagnosing). */
const PERF_KEY = 'polypore.perf';
function perfEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const win = window as Window & { __POLYPORE_PERF__?: boolean };
  if (win.__POLYPORE_PERF__ === true) return true;
  if (win.__POLYPORE_PERF__ === false) return false;
  try {
    return window.sessionStorage.getItem(PERF_KEY) === '1'
      || window.localStorage.getItem(PERF_KEY) === '1';
  } catch {
    return false;
  }
}

let perfBaseline: number | null = null;
function perfTime(): number {
  if (typeof performance === 'undefined' || typeof performance.now !== 'function') return 0;
  const now = performance.now();
  if (perfBaseline === null) perfBaseline = now;
  return now - perfBaseline;
}

function perfReset(label: string): void {
  /* reset the baseline only on tab-click — each click defines one
     interaction. hydrate fires per panel and would otherwise reset
     mid-trace and mask the gaps we're trying to measure. */
  if (label.startsWith('tab-click')) {
    perfBaseline = null;
  }
}

export function perfMark(label: string): () => void {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') {
    return () => {};
  }
  perfReset(label);
  const startedAt = perfTime();
  const start = `polypore:${label}:start`;
  const end = `polypore:${label}:end`;
  try { performance.mark(start); } catch { /* ignore */ }
  if (perfEnabled()) {
    /* eslint-disable-next-line no-console */
    console.debug(`[perf] ${startedAt.toFixed(1)}ms  ${label}  (start)`);
  }
  return () => {
    try {
      performance.mark(end);
      performance.measure(`polypore:${label}`, start, end);
    } catch {
      /* ignore */
    }
    if (perfEnabled()) {
      const endedAt = perfTime();
      /* eslint-disable-next-line no-console */
      console.debug(`[perf] ${endedAt.toFixed(1)}ms  ${label}  (end, +${(endedAt - startedAt).toFixed(1)}ms)`);
    }
  };
}

export function perfPoint(label: string): void {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
  perfReset(label);
  const at = perfTime();
  try { performance.mark(`polypore:${label}`); } catch { /* ignore */ }
  if (perfEnabled()) {
    /* eslint-disable-next-line no-console */
    console.debug(`[perf] ${at.toFixed(1)}ms  ${label}`);
  }
}

/* defer a callback until after the browser has painted the next frame.
   rAF schedules work for the next frame's start; the setTimeout(0) inside
   that rAF yields back to the task queue so the paint task runs before
   the callback fires. use this to wrap cold-path host RPCs (diagnostics,
   editor.tree, verify.runs, …) on first mount — otherwise the
   pre-await synchronous setup (RPC envelope validation, JSON-serialize
   args, postMessage queueing, mergeDiagnostics, …) chains together
   across every useEffect in the panel and pushes the first paint back
   by hundreds of milliseconds. callers should use the returned cancel
   for effect cleanup. */
export function scheduleAfterPaint(callback: () => void): () => void {
  let timer: number | null = null;
  const frame = window.requestAnimationFrame(() => {
    timer = window.setTimeout(callback, 0);
  });
  return () => {
    window.cancelAnimationFrame(frame);
    if (timer !== null) window.clearTimeout(timer);
  };
}

export type PanelHeaderProps = {
  icon?: string;
  label: string;
  onOpenHelp: () => void;
  onOpenSettings: () => void;
};

export function PanelHeader({
  icon,
  label,
  onOpenHelp,
  onOpenSettings,
  className = '',
  children,
}: PanelHeaderProps & {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`panel-header ${className}`.trim()}>
      <div className="panel-header__content">
        {icon && <span className="panel-header__agent-pill">{icon}</span>}
        {children}
      </div>
      <div className="panel-header__controls">
        <button
          className="panel-help"
          title={`manual · ${label}`}
          aria-label={`open manual for ${label}`}
          onClick={onOpenHelp}
        >
          ?
        </button>
        <button
          className="panel-gear"
          title={`settings · ${label}`}
          aria-label={`open panel settings for ${label}`}
          onClick={onOpenSettings}
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export type FileNode =
  | { kind: 'file'; name: string; path: string; subtitle?: string }
  | { kind: 'folder'; name: string; children: FileNode[] };

export { FileTree, type FileMeta, type FileTreeProps, type FileTreeContextInfo } from './file-tree';
export {
  ResizeHandle,
  useResizableSplit,
  type ResizableSplitOptions,
  type ResizeHandleProps,
} from './resize-handle';
export {
  type ChatTarget,
  CHAT_PANEL_META,
  openChatPanelTargets,
  focusChatTarget,
  waitForTerminalTarget,
  sendPromptToTerminal,
  deliverPromptToTarget,
} from './chat-targets';
export {
  diagnosticProblemSeverity,
  diagnosticToProblem,
  diagnosticsToProblems,
  type DiagnosticProblem,
  type DiagnosticProblemSeverity,
} from './diagnostics';
