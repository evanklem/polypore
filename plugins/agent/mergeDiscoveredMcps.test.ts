import { mergeDiscoveredMcps, type DiscoveredMcp, type McpServerRecord, type MergedMcpRow } from './mergeDiscoveredMcps';

// ── A7: dedupes by name with union origins ─────────────────────────────────────

test('merge_discovered_mcps_dedupes_by_name_with_union_origins', () => {
  const claude: DiscoveredMcp = {
    name: 'github',
    origins: ['claude'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
  };
  const codex: DiscoveredMcp = {
    name: 'github',
    origins: ['codex'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
  };

  const rows = mergeDiscoveredMcps([], [claude, codex]);

  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row.kind).toBe('discovered');
  if (row.kind !== 'discovered') throw new Error('type guard');
  expect(row.name).toBe('github');
  // origins must be the union of both sources, containing both
  expect(row.origins).toContain('claude');
  expect(row.origins).toContain('codex');
  expect(row.origins).toHaveLength(2);
});

// ── A8: managed wins on name collision ────────────────────────────────────────

test('merge_discovered_mcps_managed_wins_on_name_collision', () => {
  const managed: McpServerRecord = {
    id: 'server-1',
    name: 'github',
    url: 'https://mcp.github.com',
    scope: 'project',
  };
  const discovered: DiscoveredMcp = {
    name: 'github',
    origins: ['claude'],
    transport: 'http',
    url: 'http://localhost:3000/mcp',
  };

  const rows = mergeDiscoveredMcps([managed], [discovered]);

  // Only one row total — managed wins, discovered is dropped
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row.kind).toBe('managed');
  if (row.kind !== 'managed') throw new Error('type guard');
  expect(row.id).toBe('server-1');
});
