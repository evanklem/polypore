import type { PanelManifest, RpcEnvelope, RpcRequest } from '../../sdk/src';
import { validateSchema } from '../../sdk/src/validators.gen';
import type { HostRpcServer } from './rpc-server';

type HostPermission = PanelManifest['permissions'][number];

export type PluginLoadResult =
  | { ok: true; manifest: PanelManifest; entryHtml: string }
  | { ok: false; id: string; errors: unknown };

export type BuiltinPluginDefinition = {
  manifest: PanelManifest;
  entryHtml: string;
};

export type MountOptions = {
  iframe: HTMLIFrameElement;
  manifest: PanelManifest;
  server: HostRpcServer;
  instanceId?: string;
  expectedOrigin?: string;
};

export type PluginHandle = {
  manifest: PanelManifest;
  instanceId: string;
  dispose: () => void;
  ready: Promise<void>;
};

/* monotonic suffix: two mounts in the same millisecond must not share an
   instance id. */
let instanceSeq = 0;

export class PluginLoader {
  private plugins = new Map<string, BuiltinPluginDefinition>();

  register(definition: BuiltinPluginDefinition): PluginLoadResult {
    const manifestValidation = validateSchema('manifest.schema.json', definition.manifest);
    if (!manifestValidation.ok) {
      return { ok: false, id: definition.manifest.id, errors: manifestValidation.errors };
    }

    this.plugins.set(definition.manifest.id, definition);
    return { ok: true, manifest: definition.manifest, entryHtml: definition.entryHtml };
  }

  discover() {
    return [...this.plugins.values()].map((plugin) => plugin.manifest);
  }

  load(id: string): PluginLoadResult {
    const plugin = this.plugins.get(id);
    if (!plugin) return { ok: false, id, errors: [{ message: 'plugin not found' }] };

    const manifestValidation = validateSchema('manifest.schema.json', plugin.manifest);
    if (!manifestValidation.ok) {
      return { ok: false, id, errors: manifestValidation.errors };
    }

    return { ok: true, manifest: plugin.manifest, entryHtml: plugin.entryHtml };
  }

  /* attach an iframe's window to a host rpc server. translates raw postMessage
     envelopes into requests on the server and publishes server events back to
     the iframe under the same envelope shape. returns a handle that the caller
     uses to wait for handshake and to tear down the bridge when the panel
     closes. */
  mount(opts: MountOptions): PluginHandle {
    const instanceId = opts.instanceId ?? `inst-${opts.manifest.id}-${++instanceSeq}`;
    const subs = new Map<string, () => void>();
    const grantedPermissions = new Set(opts.manifest.permissions ?? []);
    let readyResolve: () => void = () => {};
    let readyReject: (err: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    const post = (envelope: RpcEnvelope) => {
      const target = opts.iframe.contentWindow;
      if (!target) return;
      target.postMessage({ __polypore: true, pluginId: opts.manifest.id, envelope }, opts.expectedOrigin ?? '*');
    };

    const handleSubscribe = (topic: string) => {
      if (subs.has(topic)) return;
      const unsub = opts.server.subscribe(topic, (payload) => {
        post({ kind: 'event', topic, payload });
      });
      subs.set(topic, unsub);
    };

    const handleUnsubscribe = (topic: string) => {
      const unsub = subs.get(topic);
      if (!unsub) return;
      unsub();
      subs.delete(topic);
    };

    const onMessage = async (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.__polypore !== true) return;
      if (data.pluginId !== opts.manifest.id) return;
      if (event.source !== opts.iframe.contentWindow) return;
      if (opts.expectedOrigin && event.origin !== opts.expectedOrigin) return;
      const env: RpcEnvelope = data.envelope;
      if (!env || env.kind !== 'request') return;
      const req = env as RpcRequest;

      if (req.method === 'host.subscribe') {
        const { topic } = (req.params as { topic: string }) ?? { topic: '' };
        const required = permissionForTopic(topic);
        if (!required) {
          post(methodNotAllowed(req.id, `subscription ${topic}`));
          return;
        }
        if (required && !grantedPermissions.has(required)) {
          post(permissionDenied(req.id, required, `subscription ${topic}`));
          return;
        }
        if (topic) handleSubscribe(topic);
        post({ kind: 'response', id: req.id, ok: true, result: { subscribed: true, topic } });
        return;
      }
      if (req.method === 'host.unsubscribe') {
        const { topic } = (req.params as { topic: string }) ?? { topic: '' };
        if (topic) handleUnsubscribe(topic);
        post({ kind: 'response', id: req.id, ok: true, result: { unsubscribed: true, topic } });
        return;
      }
      if (req.method === 'plugin.ready') {
        const response = await opts.server.handle(req);
        post(response);
        readyResolve();
        return;
      }

      const required = permissionForMethod(req.method);
      if (!required) {
        post(methodNotAllowed(req.id, req.method));
        return;
      }
      if (required && !grantedPermissions.has(required)) {
        post(permissionDenied(req.id, required, req.method));
        return;
      }

      const response = await opts.server.handle(req);
      post(response);
    };

    window.addEventListener('message', onMessage);

    /* fail-fast handshake timeout — if the plugin never says ready in 5s the
       caller's ready promise rejects so the host can flag the panel. */
    const timer = window.setTimeout(() => {
      readyReject(new Error(`plugin ${opts.manifest.id} did not complete handshake in 5s`));
    }, 5000);

    void ready.then(() => window.clearTimeout(timer)).catch(() => window.clearTimeout(timer));

    return {
      manifest: opts.manifest,
      instanceId,
      ready,
      dispose: () => {
        window.removeEventListener('message', onMessage);
        for (const unsub of subs.values()) unsub();
        subs.clear();
        window.clearTimeout(timer);
      },
    };
  }
}

function permissionDenied(id: number, permission: HostPermission, target: string): RpcEnvelope {
  return {
    kind: 'response',
    id,
    ok: false,
    error: {
      code: 'permission_not_declared',
      message: `${target} requires undeclared permission ${permission}`,
    },
  };
}

function methodNotAllowed(id: number, target: string): RpcEnvelope {
  return {
    kind: 'response',
    id,
    ok: false,
    error: {
      code: 'permission_not_declared',
      message: `${target} is not available to iframe plugins`,
    },
  };
}

function permissionForMethod(method: string): HostPermission | null {
  switch (method) {
    case 'state.get':
      return 'state.read';
    case 'tasks.list':
      return 'tasks.read';
    case 'tasks.add':
    case 'tasks.update':
      return 'tasks.write';
    case 'diagnostics.list':
    case 'diagnostics.document':
    case 'diagnostics.deepScan':
      return 'diagnostics.read';
    case 'verify.runs':
      return 'verify.read';
    case 'verify.run':
      return 'verify.run';
    case 'iterate.run':
      return 'iterate.run';
    case 'knowledge.bases':
    case 'knowledge.list':
    case 'knowledge.read':
      return 'knowledge.read';
    case 'knowledge.openFolder':
    case 'knowledge.suggestBaseLocation':
    case 'knowledge.pickBaseLocation':
    case 'knowledge.createBase':
    case 'knowledge.setBaseScope':
    case 'knowledge.renameBase':
    case 'knowledge.deleteBase':
    case 'knowledge.createFolder':
    case 'knowledge.renameFolder':
    case 'knowledge.deleteFolder':
    case 'knowledge.deleteDoc':
    case 'knowledge.write':
      return 'knowledge.write';
    case 'editor.tree':
    case 'editor.open':
    case 'editor.read':
      return 'editor.read';
    case 'editor.applyEdit':
      return 'editor.write';
    case 'chat.sessions':
    case 'chat.history':
    case 'agent.commands':
      return 'chat.read';
    case 'chat.send':
      return 'chat.send';
    case 'history.events':
    case 'history.diff':
      return 'history.read';
    case 'history.fork':
      return 'history.fork';
    case 'history.revert':
      return 'history.revert';
    case 'worktrees.list':
      return 'workspace.read';
    case 'worktrees.create':
      return 'workspace.write';
    case 'preview.list':
      return 'preview.read';
    case 'preview.register':
      return 'preview.register';
    case 'preview.refresh':
      return 'preview.refresh';
    case 'terminal.spawn':
      return 'terminal.spawn';
    case 'terminal.stop':
      return 'terminal.stop';
    case 'terminal.resize':
    case 'terminal.write':
      return 'terminal.write';
    case 'workspace.activePanel':
    case 'panel.list':
      return 'workspace.read';
    case 'panel.open':
    case 'panel.close':
      return 'workspace.write';
    case 'ui.notify':
      return 'ui.notify';
    case 'ui.confirm':
      return 'ui.confirm';
    case 'ui.openExternal':
      return 'ui.openExternal';
    case 'plugins.list':
      return 'plugins.read';
    case 'plugins.install':
    case 'plugins.uninstall':
    case 'plugins.enable':
    case 'plugins.disable':
    case 'plugins.toggle':
    case 'plugins.confirmInstall':
    case 'plugins.confirmUninstall':
      return 'plugins.write';
    case 'secrets.list':
    case 'secrets.has':
      return 'secrets.list';
    case 'secrets.use':
      return 'secrets.use';
    case 'secrets.reveal':
    case 'secrets.set':
    case 'secrets.delete':
      return null;
    case 'mcp.invoke':
    case 'mcp.discover':
    case 'mcp.servers.list':
    case 'mcp.servers.upsert':
    case 'mcp.servers.delete':
    case 'mcp.servers.test':
      return 'mcp.invoke';
    case 'skills.list':
    case 'skills.read':
      return 'skills.read';
    case 'skills.write':
      return 'skills.write';
    case 'skills.delete':
      return 'skills.delete';
    case 'skills.invoke':
      return 'skills.invoke';
    case 'manifest.register':
      return 'plugins.write';
    case 'formation.upsert':
      return 'workspace.write';
    case 'debug.state':
    case 'debug.sessions':
    case 'debug.probe':
    case 'debug.stackTrace':
    case 'debug.scopes':
    case 'debug.variables':
    case 'debug.capture.screenshot':
    case 'debug.capture.console':
    case 'debug.capture.dom':
    case 'debug.capture.network':
    case 'debug.capabilities':
      return 'debug.read';
    case 'debug.start':
    case 'debug.setBreakpoints':
    case 'debug.addBreakpoint':
    case 'debug.removeBreakpoint':
    case 'debug.continue':
    case 'debug.stepOver':
    case 'debug.stepIn':
    case 'debug.stepOut':
    case 'debug.pause':
    case 'debug.evaluate':
    case 'debug.setTrust':
    case 'debug.roadblock':
    case 'debug.roadblock.resolve':
    case 'debug.rootCause':
    case 'debug.select':
    case 'debug.stop':
    case 'debug.navigate':
    case 'debug.click':
    case 'debug.fill':
    case 'debug.login':
      return 'debug.control';
    /* editor extensions */
    case 'editor.setDecorations':
      return 'editor.decorate';
    case 'editor.cursor':
    case 'editor.selection':
    case 'editor.revealLine':
    case 'editor.language':
      return 'editor.read';
    /* chat extensions */
    case 'chat.interrupt':
      return 'chat.send';
    case 'chat.context.list':
    case 'chat.context.add':
    case 'chat.context.remove':
      return 'chat.context';
    /* terminal extensions */
    case 'terminal.list':
    case 'terminal.read':
      return 'terminal.read';
    /* ui extensions */
    case 'ui.statusBar.add':
    case 'ui.statusBar.update':
    case 'ui.statusBar.remove':
      return 'ui.statusBar';
    case 'ui.inputBox':
    case 'ui.quickPick':
      return 'ui.input';
    case 'ui.panel.setTitle':
    case 'ui.panel.setBadge':
    case 'ui.panel.focus':
      return 'workspace.write';
    /* storage */
    case 'storage.get':
    case 'storage.list':
      return 'storage.read';
    case 'storage.set':
    case 'storage.delete':
      return 'storage.write';
    /* git */
    case 'git.status':
    case 'git.log':
    case 'git.blame':
    case 'git.branches':
      return 'git.read';
    case 'git.stash':
    case 'git.unstash':
      return 'git.write';
    /* fs */
    case 'fs.write':
    case 'fs.delete':
    case 'fs.rename':
    case 'fs.mkdir':
    case 'fs.exists':
    case 'fs.stat':
      return 'fs.write';
    /* http */
    case 'http.fetch':
      return 'http.fetch';
    /* clipboard */
    case 'clipboard.read':
      return 'clipboard.read';
    case 'clipboard.write':
      return 'clipboard.write';
    /* bus */
    case 'bus.publish':
      return 'bus.publish';
    /* snapshots */
    case 'snapshots.take':
    case 'snapshots.signalTurnEnd':
      return 'workspace.write';
    /* skills extended */
    case 'skills.publish':
      return 'skills.write';
    /* skillsets */
    case 'skillsets.list':
    case 'skillsets.read':
      return 'skills.read';
    case 'skillsets.upsert':
    case 'skillsets.delete':
      return 'skills.write';
    /* adr */
    case 'adr.record':
      return 'knowledge.write';
    default:
      return null;
  }
}

function permissionForTopic(topic: string): HostPermission | null {
  if (topic.startsWith('state:')) return 'state.read';
  if (topic.startsWith('editor:') || topic === 'editor:opened') return 'editor.read';
  if (topic.startsWith('knowledge:')) return 'knowledge.read';
  if (topic.startsWith('tasks:')) return 'tasks.read';
  if (topic.startsWith('diagnostics:')) return 'diagnostics.read';
  if (topic.startsWith('verify:')) return 'verify.read';
  if (topic.startsWith('chat:')) return 'chat.read';
  if (topic.startsWith('history:') || topic.startsWith('agent:')) return 'history.read';
  if (topic.startsWith('preview:')) return 'preview.read';
  if (topic.startsWith('terminal:')) return 'terminal.spawn';
  if (topic.startsWith('panel:')) return 'workspace.read';
  if (topic.startsWith('plugins:')) return 'plugins.read';
  if (topic.startsWith('secrets:')) return 'secrets.list';
  if (topic.startsWith('skills:')) return 'skills.read';
  if (topic.startsWith('fs:')) return 'fs.write';
  if (topic.startsWith('ui:statusBar')) return 'ui.statusBar';
  if (topic.startsWith('bus:')) return 'bus.publish';
  return null;
}

/* construct a srcdoc string that inlines the sdk runtime, plugin css, and
   plugin script body. iframes run with sandbox="allow-scripts" so any script
   that needs to talk to the host must live inside this srcdoc. */
export function buildPluginSrcdoc(opts: {
  manifest: PanelManifest;
  sdkRuntime: string;
  pluginCss?: string;
  pluginScript: string;
  bodyHtml?: string;
  instanceId?: string;
}): string {
  const safeId = JSON.stringify(opts.manifest.id);
  const safeInstance = JSON.stringify(opts.instanceId ?? null);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(opts.manifest.title)}</title>
  <style>${opts.pluginCss ?? ''}</style>
</head>
<body>
  ${opts.bodyHtml ?? '<main id="root"></main>'}
  <script>
    window.POLYPORE_PLUGIN_ID = ${safeId};
    window.POLYPORE_INSTANCE_ID = ${safeInstance};
  </script>
  <script>${opts.sdkRuntime}</script>
  <script>${opts.pluginScript}</script>
</body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
