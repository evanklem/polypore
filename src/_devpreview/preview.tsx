import { createRoot } from 'react-dom/client';
import '../styles/tokens.css';
import '../App.css';
import { SettingsSurface, type SettingsSection } from '../settings/SettingsSurface';
import { ManualSurface } from '../manual/ManualSurface';
import { loadManualCorpus } from '../manual/loadManualCorpus';
import { applyInterfaceSettings } from '../settings/settingsStorage';
import type { GlobalSettingsServices } from '../settings/tabs/types';
import type { PanelCatalogItem } from '../components/overlays/panelCatalog';

/* Standalone dev preview for the Settings + Manual full-screen surfaces.
 * Lets a headless browser screenshot either surface in isolation, with
 * believable stub services. Query params:
 *   ?surface=settings&section=panels   (panels|project|extensions|agents|credentials|appearance)
 *   ?surface=manual&slug=the-ide/getting-started
 *   &accent=#f0b35a */

const params = new URLSearchParams(location.search);
const accent = params.get('accent') ?? '#f0b35a';
applyInterfaceSettings({ accent, motion: 'full', glass: 'frosted' });

const PANELS: PanelCatalogItem[] = [
  { slot: 'editor', id: 'polypore.editor', icon: '{}', label: 'editor', title: 'Editor', version: '1.4.0', category: 'code', defaultArea: 'center', permissions: ['fs.read', 'fs.write'], capabilities: ['open-file', 'apply-edit'], enabled: true, source: 'built-in', manual: { summary: '', tips: [] } },
  {
    slot: 'agent',
    id: 'polypore.agent',
    icon: 'ai',
    label: 'agent',
    title: 'Agent',
    version: '0.1.0',
    category: 'agent',
    defaultArea: 'center',
    permissions: ['state.read', 'tasks.read', 'tasks.write', 'chat.read', 'chat.send', 'workspace.write', 'secrets.list', 'mcp.invoke', 'skills.read', 'skills.write'],
    capabilities: ['tool-use'],
    enabled: true,
    source: 'built-in',
    manual: {
      summary: 'Compose a task-specific team of agent roles and wire how they hand work to each other. Skills, MCP servers, and secrets sit on the left; the formation canvas on the right is where you connect roles like overseer, frontend, or QA into handoff routes.',
      tips: [],
    },
  },
  { slot: 'terminal', id: 'polypore.terminal', icon: '>_', label: 'terminal', title: 'Terminal', version: '1.1.0', category: 'system', defaultArea: 'bottom', permissions: ['pty.spawn'], capabilities: ['shell'], enabled: true, source: 'built-in', manual: { summary: '', tips: [] } },
  { slot: 'preview', id: 'polypore.preview', icon: '◉', label: 'preview', title: 'Preview', version: '1.0.3', category: 'view', defaultArea: 'right', permissions: ['net.localhost'], capabilities: ['render'], enabled: true, source: 'built-in', manual: { summary: '', tips: [] } },
  { slot: 'memory', id: 'polypore.memory', icon: '◇', label: 'memory', title: 'Memory', version: '0.9.0', category: 'ai', defaultArea: 'right', permissions: ['fs.read'], capabilities: ['recall'], enabled: false, source: 'built-in', manual: { summary: '', tips: [] } },
  { slot: 'problems', id: 'polypore.problems', icon: '!', label: 'problems', title: 'Problems', version: '1.0.0', category: 'code', defaultArea: 'bottom', permissions: ['fs.read'], capabilities: ['diagnostics'], enabled: true, source: 'built-in', manual: { summary: '', tips: [] } },
];

const PROJECT_FILES: Record<string, string> = {
  '.polypore/runtime.json': JSON.stringify({ runtimes: [
    { label: 'web dev', commands: [{ name: 'dev', command: 'npm run dev', kind: 'site' }], defaultUrl: 'http://localhost:5173' },
    { label: 'tauri', commands: [{ name: 'app', command: 'npm run app', kind: 'desktop' }] },
  ] }),
  '.polypore/language-servers.json': JSON.stringify({ servers: [
    { id: 'tsserver', command: 'typescript-language-server', args: ['--stdio'], extensions: ['ts', 'tsx'] },
  ] }),
  '.polypore/verify.json': JSON.stringify([
    { id: 'typecheck', label: 'type check', command: 'npm run typecheck', required: true },
    { id: 'test', label: 'unit tests', command: 'npm test', required: false },
  ]),
};

const SECRET_REFS = [
  { id: 'GITHUB_TOKEN', service: 'github', scope: 'project', hint: 'ghp-...', configured: true },
  { id: 'NPM_TOKEN', service: 'npm', scope: 'user', hint: 'npm_...', configured: true },
  { id: 'CI_DEPLOY_TOKEN', service: 'ci', scope: 'project', hint: '', configured: false },
];

const services = {
  host: {
    plugins: {
      list: async () => ({ plugins: PANELS.map((p) => ({ id: p.id, version: p.version, enabled: p.enabled, scope: 'user', source: p.source })) }),
      enable: async () => {}, disable: async () => {}, uninstall: async () => {}, install: async () => {}, toggle: async () => {},
    },
    editor: {
      read: async (path: string) => ({ path, content: PROJECT_FILES[path] ?? '' }),
      applyEdit: async () => ({ applied: 1 }),
    },
  },
  secretStore: { onChange: () => () => {}, has: () => true },
  /* matches the real TauriInvoke contract: Promise<T> | null (null synchronously
   * when no shell), so guards like `if (nativeList)` behave as in the app. */
  tauriInvoke: (cmd: string) => {
    if (cmd === 'project_agent_status') return Promise.resolve([{ agent: 'codex', available: true, path: '/usr/bin/codex' }, { agent: 'claude', available: false, path: null }]);
    if (cmd === 'secrets_list') return Promise.resolve(SECRET_REFS);
    if (cmd === 'secrets_has') return Promise.resolve(true);
    return null;
  },
  localSecretRefs: () => SECRET_REFS,
  secretHandle: (v: string) => v.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
  agentMeta: { codex: { icon: '◆', label: 'Codex' }, claude: { icon: '✶', label: 'Claude' } },
} as unknown as GlobalSettingsServices;

const surface = params.get('surface') ?? 'settings';
const root = createRoot(document.getElementById('root')!);

if (surface === 'manual') {
  const corpus = loadManualCorpus();
  const slug = params.get('slug') ?? undefined;
  root.render(
    <ManualSurface corpus={corpus} initialSlug={slug} onAskAgent={() => {}} onClose={() => {}} />,
  );
} else {
  const section = (params.get('section') as SettingsSection) ?? 'panels';
  const panelSlot = params.get('panel') ?? undefined;
  root.render(
    <SettingsSurface
      services={services}
      initialSection={section}
      initialPanelSlot={panelSlot}
      panelCatalog={PANELS}
      onRequestAgent={() => {}}
      onClose={() => {}}
    />,
  );
}
