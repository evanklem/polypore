/* Vite-glob glue: read the manual corpus from the real files on disk.
 *
 * Concept prose lives under docs/manual/**, per-panel prose in
 * plugins/<id>/MANUAL.md, and facts come from each plugin's polypore.json.
 * The mcp-server mirrors this same file convention for the agent reader, so the
 * two stay in lock-step without sharing code — the files are the contract.
 */
import {
  buildManualCorpus,
  type ManualCorpus,
  type ManualPanelManifest,
} from './manualCorpus';

const conceptRaw = import.meta.glob('/docs/manual/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const manifestMods = import.meta.glob('/plugins/*/polypore.json', {
  eager: true,
}) as Record<string, { default: ManualPanelManifest }>;

const manualRaw = import.meta.glob('/plugins/*/MANUAL.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

export function loadManualCorpus(): ManualCorpus {
  const docs = Object.entries(conceptRaw).map(([path, body]) => ({
    path: path.replace(/^\//, ''),
    body,
  }));

  const manualByDir = new Map<string, string>();
  for (const [path, body] of Object.entries(manualRaw)) {
    manualByDir.set(dirOf(path), body);
  }

  const panels = Object.entries(manifestMods)
    .map(([path, mod]) => ({
      manifest: mod.default,
      body: manualByDir.get(dirOf(path)) ?? '',
    }))
    .filter((panel) => panel.manifest?.id);

  return buildManualCorpus({ docs, panels });
}
