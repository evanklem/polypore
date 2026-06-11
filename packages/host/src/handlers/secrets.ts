/* secret store handlers — masked list/has, mediated use, confirm-gated reveal — registered against the core server by
   registerBuiltinHandlers(). HostInternals documents exactly which
   server state this domain touches. */

import type { HostInternals } from './internals';
import type { SecretDeleterInput, SecretUser, SecretWriterInput } from '../rpc-server';
import type { SecretEntry } from '../secret-store';

export function registerSecretsHandlers(host: HostInternals) {
  host.registerHandler('secrets.list', (params) => {
    const { scope } = (params as { scope?: 'user' | 'project' }) ?? {};
    if (!host.secretStore) return { secrets: [] };
    return {
      secrets: host.secretStore.list(scope).map((entry) => ({
        id: entry.id,
        scope: entry.scope,
        service: entry.service,
        hint: entry.hint,
        configured: entry.configured,
      })),
    };
  });
  host.registerHandler('secrets.has', (params) => {
    const { id, scope } = params as { id: string; scope?: 'user' | 'project' };
    return { id, scope, has: host.secretStore?.has(id, scope) ?? false };
  });
  host.registerHandler('secrets.use', async (params) => {
    if (!host.secretUser) {
      throw new Error('secrets.use is not available without a shell binding');
    }
    const input = params as Parameters<SecretUser>[0];
    return host.secretUser(input);
  });
  /* secrets.set — writes via the SecretWriter hook (Tauri keyring) when
     set, falls back to the in-process SecretStore. This is host-internal:
     iframe plugins and broker callers never receive this route. */
  host.registerHandler('secrets.set', async (params) => {
    const input = params as SecretWriterInput;
    if (!host.secretStore && !host.secretWriter) {
      throw new Error('secrets.set is not available without a secret store');
    }
    const decision = await host.confirmDecider({
      kind: 'secret-write',
      message: `write secret "${input.id}"?`,
      details: { id: input.id, scope: input.scope, service: input.service },
    });
    const confirmed = typeof decision === 'boolean' ? decision : decision.confirmed;
    if (!confirmed) throw new Error(`secret write denied: ${input.id}`);
    let entry: SecretEntry;
    if (host.secretWriter) {
      entry = await host.secretWriter(input);
      /* mirror into local store so list/has reflect the change for the
         renderer's optimistic UI. */
      host.secretStore?.set({ id: input.id, value: input.value, scope: input.scope, service: input.service });
    } else if (host.secretStore) {
      entry = host.secretStore.set({ id: input.id, value: input.value, scope: input.scope, service: input.service });
    } else {
      throw new Error('secrets.set is not available without a secret store');
    }
    if (host.secretStore) {
      host.publish('secrets:changed', { secrets: host.secretStore.list() });
    }
    return { secret: entry };
  });
  /* secrets.delete — removes a handle via the SecretDeleter hook (Tauri
     keyring) when set, mirroring the removal into the in-process store so
     the masked list updates immediately. This is host-internal: iframe
     plugins and broker callers never receive this route. */
  host.registerHandler('secrets.delete', async (params) => {
    const { id, scope } = params as SecretDeleterInput;
    if (!host.secretStore && !host.secretDeleter) {
      throw new Error('secrets.delete is not available without a secret store');
    }
    const decision = await host.confirmDecider({
      kind: 'secret-delete',
      message: `delete secret "${id}"?`,
      details: { id, scope },
    });
    const confirmed = typeof decision === 'boolean' ? decision : decision.confirmed;
    if (!confirmed) throw new Error(`secret delete denied: ${id}`);
    let removed = false;
    if (host.secretDeleter) {
      removed = await host.secretDeleter({ id, scope });
      host.secretStore?.delete(id, scope);
    } else if (host.secretStore) {
      removed = host.secretStore.delete(id, scope);
    }
    if (host.secretStore) {
      host.publish('secrets:changed', { secrets: host.secretStore.list() });
    }
    return { removed };
  });
  /* secrets.reveal — returns the raw value to the renderer ONLY. Plugin
     iframes / MCP sidecars never get a reveal path; this handler must not
     be exposed through the loopback host route used by plugins.
     Confirmation is enforced HOST-SIDE via confirmDecider before the
     value crosses the IPC boundary (defense-in-depth in addition to the
     renderer's own host.ui.confirm flow). */
  host.registerHandler('secrets.reveal', async (params) => {
    const { id, scope } = params as { id: string; scope?: 'user' | 'project' };
    const configured = host.secretStore?.has(id, scope) ?? false;
    const decision = await host.confirmDecider({
      kind: 'secret-reveal',
      message: `reveal secret "${id}"?`,
      details: { id, scope },
    });
    const confirmed = typeof decision === 'boolean' ? decision : decision.confirmed;
    if (!confirmed) return { value: null, configured };
    if (host.secretRevealer) {
      return host.secretRevealer({ id, scope });
    }
    if (!host.secretStore) return { value: null, configured: false };
    const value = host.secretStore.reveal(id, scope);
    return { value, configured: value !== null };
  });
  
  /* ─── debug suite ──────────────────────────────────────────────────
     Every debug.* call mutates the host `debug` state and appends one
     timeline card (running → done/failed). The panel renders from this
     state alone; the agent's tool activity IS the investigation log. */
}
