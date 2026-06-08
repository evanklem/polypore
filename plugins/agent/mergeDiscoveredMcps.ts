/**
 * mergeDiscoveredMcps — pure helper.
 *
 * Takes `managed` (polypore-owned McpServerRecord[]) and `discovered`
 * (DiscoveredMcp[] returned by mcp.discover) and produces a single
 * MergedMcpRow[] where:
 *
 * - Managed entries come first, with kind='managed'.
 * - Discovered entries with the same `name` across claude AND codex are
 *   collapsed into one row with origins=['claude','codex'].
 * - If a discovered entry shares a `name` with a managed entry, the managed
 *   entry wins and the discovered entry is dropped.
 */

// Re-export types used by the test so it can import everything from one place.
export type { McpServerRecord } from '../../packages/host/src/rpc-server';

export type DiscoveredMcp = {
  name: string;
  origins: Array<'claude' | 'codex'>;
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

export type ManagedMcpRow = {
  kind: 'managed';
  id: string;
  name: string;
  url: string;
  scope: 'project' | 'user' | 'polypore';
  headers?: Record<string, string>;
  authRef?: string;
  allowInsecure?: boolean;
  timeoutMs?: number;
  lastTest?: { ok: boolean; ts: number; status?: number; error?: string };
};

export type DiscoveredMcpRow = DiscoveredMcp & {
  kind: 'discovered';
  // origins is already part of DiscoveredMcp but we override to be explicit
  origins: Array<'claude' | 'codex'>;
};

export type MergedMcpRow = ManagedMcpRow | DiscoveredMcpRow;

// ── McpServerRecord type for compatibility (imported via re-export above) ─────

import type { McpServerRecord } from '../../packages/host/src/rpc-server';

export function mergeDiscoveredMcps(
  managed: McpServerRecord[],
  discovered: DiscoveredMcp[],
): MergedMcpRow[] {
  // Build a set of names already covered by managed entries.
  const managedNames = new Set(managed.map((s) => s.name));

  // Dedupe discovered by name, unioning origins.
  const deduped = new Map<string, DiscoveredMcpRow>();
  for (const entry of discovered) {
    // Skip if a managed entry already covers this name.
    if (managedNames.has(entry.name)) continue;

    const existing = deduped.get(entry.name);
    if (existing) {
      // Union origins — avoid duplicates.
      for (const origin of entry.origins) {
        if (!existing.origins.includes(origin)) {
          existing.origins.push(origin);
        }
      }
    } else {
      deduped.set(entry.name, {
        kind: 'discovered',
        ...entry,
        // Ensure origins is a mutable copy so we can push later.
        origins: [...entry.origins] as Array<'claude' | 'codex'>,
      });
    }
  }

  // Managed rows first, then discovered rows.
  const managedRows: ManagedMcpRow[] = managed.map((s) => ({
    kind: 'managed',
    id: s.id,
    name: s.name,
    url: s.url,
    scope: s.scope,
    headers: s.headers,
    authRef: s.authRef,
    allowInsecure: s.allowInsecure,
    timeoutMs: s.timeoutMs,
    lastTest: s.lastTest,
  }));

  return [...managedRows, ...deduped.values()];
}
