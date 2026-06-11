/* mcp server registry handlers — list/upsert/discover/test/install — registered against the core server by
   registerBuiltinHandlers(). HostInternals documents exactly which
   server state this domain touches. */

import type { HostInternals } from './internals';
import type { McpInstallInput, McpServerRecord, McpTesterResult } from '../rpc-server';

export function registerMcpHandlers(host: HostInternals) {
  host.registerHandler('mcp.servers.list', (params) => {
    const { scope } = (params as { scope?: McpServerRecord['scope'] }) ?? {};
    const servers = scope ? host.mcpServers.filter((s) => s.scope === scope) : host.mcpServers;
    return { servers: [...servers] };
  });
  host.registerHandler('mcp.servers.upsert', (params) => {
    const partial = params as Partial<McpServerRecord> & { name: string; url: string };
    const id = partial.id ?? `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const server: McpServerRecord = {
      id,
      name: partial.name,
      url: partial.url,
      scope: partial.scope ?? 'polypore',
      headers: partial.headers,
      authRef: partial.authRef,
      allowInsecure: partial.allowInsecure,
      timeoutMs: partial.timeoutMs,
      lastTest: partial.lastTest,
    };
    host.mcpServers = [server, ...host.mcpServers.filter((s) => s.id !== id)];
    host.publish('mcp:servers-changed', { servers: host.mcpServers });
    return { server };
  });
  host.registerHandler('mcp.servers.delete', (params) => {
    const { id } = params as { id: string };
    if (!host.mcpServers.some((s) => s.id === id)) throw new Error(`mcp server not found: ${id}`);
    host.mcpServers = host.mcpServers.filter((s) => s.id !== id);
    host.publish('mcp:servers-changed', { servers: host.mcpServers });
    return { deleted: true, id };
  });
  host.registerHandler('mcp.servers.test', async (params) => {
    const { id } = params as { id: string };
    const server = host.mcpServers.find((s) => s.id === id);
    if (!server) throw new Error(`mcp server not found: ${id}`);
    let probeResult: McpTesterResult;
    if (host.mcpTester) {
      probeResult = await host.mcpTester({
        transport: 'http',
        url: server.url,
        headers: server.headers,
      });
    } else {
      /* renderer-only mode cannot actually reach the server; the desktop
         shell registers a tester hook to do a real tools/list probe. */
      probeResult = { ok: false, error: 'mcp test requires the desktop shell' };
    }
    const stamped = { ok: probeResult.ok, ts: Date.now(), status: probeResult.status, error: probeResult.error };
    host.mcpServers = host.mcpServers.map((s) => (s.id === id ? { ...s, lastTest: stamped } : s));
    host.publish('mcp:servers-changed', { servers: host.mcpServers });
    return { ok: probeResult.ok, status: probeResult.status, error: probeResult.error };
  });
  /* mcp.discover — read claude/codex configs and return discovered MCPs.
     Renderer wires this through tauriInvoke('mcp_discover_external').
     Iframe plugins must declare mcp.invoke before plugin-loader will
     forward this request. */
  host.registerHandler('mcp.discover', async () => {
    if (!host.mcpDiscoverer) return { servers: [] };
    return host.mcpDiscoverer();
  });
  /* mcp.install — write an MCP entry into agent config files.
     Renderer wires this to tauriInvoke('mcp_config_install'). */
  host.registerHandler('mcp.install', async (params) => {
    if (!host.mcpInstaller) return { installed: false, targets: [] };
    return host.mcpInstaller(params as McpInstallInput);
  });
  
  /* formation — push a nodes/edges spec into host state so the agent
     panel renders it. */
}
