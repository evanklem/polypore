import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-ignore the MCP server is authored as ESM JavaScript and exports testable helpers.
import { toolSchemas } from '../../packages/mcp-server/src/server.mjs';

describe('MCP tool schema contract', () => {
  test('canonical schema defines every live MCP server tool input', () => {
    const canonical = JSON.parse(readFileSync('schemas/mcp-tools.schema.json', 'utf8')) as {
      definitions?: Record<string, unknown>;
    };
    const canonicalTools = new Set(
      Object.keys(canonical.definitions ?? {})
        .filter((name) => name.startsWith('polypore.') && name.endsWith('.input'))
        .map((name) => name.slice(0, -'.input'.length)),
    );
    const liveTools = Object.keys(toolSchemas).sort();

    expect(liveTools.filter((name) => !canonicalTools.has(name))).toEqual([]);
  });
});
