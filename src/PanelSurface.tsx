import React, { useEffect, useMemo, useRef } from 'react';
import { buildPluginSrcdoc } from '../packages/host/src';
import { PanelHeader, type BuiltinPlugin } from '../plugins/shared';
import type { PluginLoader } from '../packages/host/src';
import type { HostRpcServer } from '../packages/host/src';
import type { PolyporeHost } from '../packages/sdk/src/host';

export type PanelSurfaceProps = {
  plugin: BuiltinPlugin;
  host: PolyporeHost;
  hostServer: HostRpcServer;
  pluginLoader: PluginLoader;
  sdkRuntime: string;
  chatBoot: Record<string, unknown>;
  onOpenHelp: () => void;
  onOpenSettings: () => void;
  context?: Record<string, unknown>;
};

/* renders either an iframe (sandboxed plugins) or an in-tree
   React component (trusted built-ins). every dockview panel uses this so
   each surface is structurally identical to every other panel. */
function PanelSurfaceComponent({
  plugin,
  host,
  hostServer,
  pluginLoader,
  sdkRuntime,
  chatBoot,
  onOpenHelp,
  onOpenSettings,
  context,
}: PanelSurfaceProps) {
  const headerProps = useMemo(
    () => ({ icon: plugin.meta.icon, label: plugin.meta.label, onOpenHelp, onOpenSettings }),
    [onOpenHelp, onOpenSettings, plugin.meta.icon, plugin.meta.label],
  );

  if (plugin.iframe) {
    return (
      <IframePanelSurface
        plugin={plugin}
        hostServer={hostServer}
        pluginLoader={pluginLoader}
        sdkRuntime={sdkRuntime}
        chatBoot={chatBoot}
      />
    );
  }

  if (plugin.Component) {
    const Component = plugin.Component;
    return (
      <React.Suspense
        fallback={(
          <PanelLoadingSurface
            plugin={plugin}
            onOpenHelp={onOpenHelp}
            onOpenSettings={onOpenSettings}
            state="loading"
          />
        )}
      >
        <Component host={host} header={headerProps} context={context} />
      </React.Suspense>
    );
  }

  return <div className="empty-state">{plugin.meta.label}: no surface registered</div>;
}

export const PanelSurface = React.memo(PanelSurfaceComponent);

export function PanelLoadingSurface({
  plugin,
  onOpenHelp,
  onOpenSettings,
  state,
}: {
  plugin: BuiltinPlugin;
  onOpenHelp: () => void;
  onOpenSettings: () => void;
  state: 'loading' | 'preparing';
}) {
  return (
    <div
      className="dockview-panel-surface dockview-panel-surface--deferred"
      aria-label={`${plugin.meta.label} ${state}`}
    >
      <PanelHeader
        icon={plugin.meta.icon}
        label={plugin.meta.label}
        onOpenHelp={onOpenHelp}
        onOpenSettings={onOpenSettings}
      >
        <span className="panel-header__title">{plugin.meta.label}</span>
        <span className="panel-header__sep" aria-hidden="true" />
        <span className="panel-header__meta">{state}</span>
      </PanelHeader>
      <div className="panel-loading-state" role="status">{state}</div>
    </div>
  );
}

function IframePanelSurface({
  plugin,
  hostServer,
  pluginLoader,
  sdkRuntime,
  chatBoot,
}: {
  plugin: BuiltinPlugin;
  hostServer: HostRpcServer;
  pluginLoader: PluginLoader;
  sdkRuntime: string;
  chatBoot: Record<string, unknown>;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const isUrlMode = Boolean(plugin.iframe!.url) && !plugin.iframe!.build;

  const srcDoc = useMemo(() => {
    if (isUrlMode) return undefined;
    return plugin.iframe!.build!({
      buildPluginSrcdoc,
      sdkRuntime,
      boot: chatBoot,
    });
  }, [chatBoot, isUrlMode, plugin, sdkRuntime]);

  /* for URL-mode plugins, append pluginId as a query param so the bundled
     SDK can self-identify without inline script injection. */
  const iframeSrc = useMemo(() => {
    if (!isUrlMode) return undefined;
    const base = plugin.iframe!.url!;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}pluginId=${encodeURIComponent(plugin.manifest.id)}`;
  }, [isUrlMode, plugin]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const handle = pluginLoader.mount({
      iframe,
      manifest: plugin.manifest,
      server: hostServer,
    });
    handle.ready.catch(() => {});
    return () => handle.dispose();
  }, [hostServer, plugin.manifest, pluginLoader]);

  return (
    <iframe
      ref={iframeRef}
      title={plugin.manifest.id}
      className="plugin-iframe"
      {...(isUrlMode ? { src: iframeSrc } : { srcDoc })}
      sandbox="allow-scripts"
    />
  );
}
