import type { PanelManifest } from '../../packages/sdk/src';
import { lazyBuiltinPanel, type BuiltinPlugin } from '../shared';
import manifestJson from './polypore.json';

type ChatAgent = 'codex' | 'claude';

const AgentTerminalPanel = lazyBuiltinPanel(() => import('../terminal/component'), 'TerminalPanel');

const AGENT_META: Record<ChatAgent, { icon: string; label: string; order: number }> = {
  codex: { icon: 'cd', label: 'codex', order: 10 },
  claude: { icon: 'cl', label: 'claude', order: 20 },
};

function buildAgentTerminalPlugin(agent: ChatAgent): BuiltinPlugin {
  const meta = AGENT_META[agent];
  const manifest = {
    ...(manifestJson as PanelManifest),
    id: `polypore.chat.${agent}`,
    title: meta.label,
    icon: meta.icon,
  } as PanelManifest;

  return {
    manifest,
    slot: agent,
    meta: { icon: meta.icon, label: meta.label },
    defaultOrder: meta.order,
    buildContext: () => ({
      initialCommand: agent,
      title: meta.label,
      /* surface the per-agent slash-command chip strip — same UI as the
         standalone terminal but ranked from the user's claude/codex
         slash-command history (/clear, /compact, custom skills, …). */
      quickLaunch: true,
      fallbackToShellOnExit: true,
    }),
    Component: AgentTerminalPanel,
  };
}

export const codexChatPlugin = buildAgentTerminalPlugin('codex');
export const claudeChatPlugin = buildAgentTerminalPlugin('claude');

export default [codexChatPlugin, claudeChatPlugin];
