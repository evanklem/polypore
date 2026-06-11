/* plugin install/uninstall/enable handlers (confirm-gated) — registered against the core server by
   registerBuiltinHandlers(). HostInternals documents exactly which
   server state this domain touches. */

import type { HostInternals } from './internals';
import type { PanelManifest, PluginRef } from '../../../sdk/src';
import { normalizeConfirmDecision } from '../rpc-server';

export function registerPluginsHandlers(host: HostInternals) {
  host.registerHandler('plugins.list', () => ({ plugins: [...host.plugins] }));
  host.registerHandler('plugins.enable', (params) => {
    const { id } = params as { id: string };
    if (!host.plugins.some((p) => p.id === id)) throw new Error(`plugin not found: ${id}`);
    host.plugins = host.plugins.map((p) => (p.id === id ? { ...p, enabled: true } : p));
    host.publish('plugins:changed', { plugins: host.plugins });
    return { enabled: true, id };
  });
  host.registerHandler('plugins.disable', (params) => {
    const { id } = params as { id: string };
    if (!host.plugins.some((p) => p.id === id)) throw new Error(`plugin not found: ${id}`);
    host.plugins = host.plugins.map((p) => (p.id === id ? { ...p, enabled: false } : p));
    host.publish('plugins:changed', { plugins: host.plugins });
    return { disabled: true, id };
  });
  host.registerHandler('plugins.confirmInstall', async (params) => {
    const details = params as {
      manifest?: PanelManifest;
      source?: { commit?: string; url?: string; ref?: string };
      scope?: 'project' | 'user';
      totalSizeBytes?: number;
      files?: Array<{ path: string; sizeBytes: number }>;
    };
    const decision = await host.confirmDecider({
      kind: 'plugin-install',
      message: `install plugin ${details.manifest?.id ?? 'unknown plugin'}`,
      details,
    });
    return normalizeConfirmDecision(decision, details.scope);
  });
  host.registerHandler('plugins.install', (params) => {
    const { plugin, manifest, source, scope, entryUrl } = params as {
      plugin?: PluginRef;
      manifest?: PanelManifest;
      source?: string;
      scope?: 'project' | 'user';
      /* URL of the plugin's entry point for URL-mode (external) plugins.
         stored on the PluginRef so that the renderer can reconstruct a
         BuiltinPlugin with iframe: { url } when plugins:changed fires. */
      entryUrl?: string;
    };
    const ref: PluginRef = plugin ?? {
      id: manifest?.id ?? `plugin-${Date.now()}`,
      version: manifest?.version ?? '0.0.0',
      scope: scope ?? 'project',
      enabled: true,
      installedAt: Date.now(),
      source: source ?? 'staged',
      permissions: manifest?.permissions ?? [],
      ...(manifest ? { manifest } : {}),
      ...(entryUrl ? { entryUrl } : {}),
    };
    host.plugins = [ref, ...host.plugins.filter((item) => item.id !== ref.id)];
    host.publish('plugins:changed', { plugins: host.plugins });
    return { installed: true, plugin: ref };
  });
  host.registerHandler('plugins.confirmUninstall', async (params) => {
    const { id } = params as { id: string };
    const decision = await host.confirmDecider({
      kind: 'plugin-uninstall',
      message: `uninstall plugin ${id}`,
      details: { id },
    });
    return normalizeConfirmDecision(decision);
  });
  host.registerHandler('plugins.uninstall', (params) => {
    const { id } = params as { id: string };
    if (!host.plugins.some((plugin) => plugin.id === id)) throw new Error(`plugin not found: ${id}`);
    host.plugins = host.plugins.filter((plugin) => plugin.id !== id);
    host.publish('plugins:changed', { plugins: host.plugins });
    return { uninstalled: true, id };
  });
  
  /* skills — currently a flat list supplied by the host; real M3+ migration
     resolves user/project/builtin skills against the filesystem. */
}
