import { useMemo, useState } from 'react';
import { AdvancedDisclosure } from '../AdvancedDisclosure';
import type { AgentBinaryStatus, GlobalSettingsServices } from './types';

export interface AgentsTabProps {
  services: GlobalSettingsServices;
  notice: string;
  setNotice: (value: string) => void;
}

/* friendly "fix it" guidance: how to get a missing agent onto PATH */
const INSTALL_HINTS: Record<string, string> = {
  codex: 'npm i -g @openai/codex',
  claude: 'npm i -g @anthropic-ai/claude-code',
};

let cachedAgentStatus: AgentBinaryStatus[] | null = null;

export function AgentsTab({ services, setNotice }: AgentsTabProps) {
  const { tauriInvoke, agentMeta } = services;
  const [agents, setAgents] = useState<AgentBinaryStatus[] | null>(() => cachedAgentStatus);
  const [probing, setProbing] = useState(false);

  const probeAgents = async (focusAgent?: string) => {
    if (probing) return;
    setProbing(true);
    try {
      const rows = await tauriInvoke<AgentBinaryStatus[]>('project_agent_status');
      if (!rows) {
        setNotice('agent probe requires the desktop shell');
        return;
      }
      cachedAgentStatus = rows;
      setAgents(rows);
      if (focusAgent) {
        const row = rows.find((agent) => agent.agent === focusAgent);
        setNotice(`${focusAgent} ${row?.available ? 'is available' : 'is not available'}`);
      } else {
        setNotice(`probed ${rows.length} agents`);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'agent probe failed');
    } finally {
      setProbing(false);
    }
  };

  const fallbackRows = useMemo(() =>
    Object.keys(agentMeta)
      .filter((agent) => agent !== 'cursor')
      .map<AgentBinaryStatus>((agent) => ({ agent, available: false, path: null })),
  [agentMeta]);

  const rows = agents
    ? agents
    : fallbackRows;
  const hasProbeResult = agents != null;

  return (
    <section className="surface-page" aria-label="agents">
      <section className="surface-section" aria-label="agent availability">
        <div className="surface-section__head">
          <h2>availability</h2>
          <span className="surface-section__head-row">
            <small>{hasProbeResult ? `${rows.filter((agent) => agent.available).length} of ${rows.length} ready` : 'not checked'}</small>
            <button type="button" className="surface-btn surface-btn--sm" disabled={probing} onClick={() => void probeAgents()}>
              {probing ? 'probing' : 'probe all'}
            </button>
          </span>
        </div>
        <div className="surface-list">
          {rows.map((agent) => (
            <div className="surface-row" key={agent.agent}>
              <span className="surface-row__main">
                <strong>{agent.agent}</strong>
                <code>{hasProbeResult ? agent.path ?? 'not on path' : 'probe to check path'}</code>
              </span>
              <span className="surface-row__actions">
                {hasProbeResult && !agent.available && INSTALL_HINTS[agent.agent] && (
                  <button
                    type="button"
                    className="surface-btn surface-btn--sm agent-install-hint"
                    title="copy install command"
                    onClick={() => {
                      const command = INSTALL_HINTS[agent.agent];
                      navigator.clipboard?.writeText(command)
                        .then(() => setNotice(`copied: ${command}`))
                        .catch(() => setNotice(`run: ${command}`));
                    }}
                  >
                    {INSTALL_HINTS[agent.agent]} ⧉
                  </button>
                )}
                <span className={agent.available ? 'surface-pill surface-pill--ok' : hasProbeResult ? 'surface-pill surface-pill--warn' : 'surface-pill'}>
                  {hasProbeResult ? agent.available ? 'available' : 'missing' : 'not checked'}
                </span>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="surface-section" aria-label="agent advanced">
        <AdvancedDisclosure summary="raw paths & per-agent probe">
          <div className="surface-list">
            {rows.map((agent) => (
              <div className="surface-row" key={agent.agent}>
                <span className="surface-row__main">
                  <strong>{agent.agent}</strong>
                  <code>{hasProbeResult ? agent.path ?? 'not on path' : 'probe to check path'}</code>
                </span>
                <span className="surface-row__actions">
                  <button
                    type="button"
                    className="surface-btn surface-btn--sm surface-btn--quiet"
                    disabled={probing}
                    onClick={() => void probeAgents(agent.agent)}
                  >
                    probe
                  </button>
                </span>
              </div>
            ))}
          </div>
        </AdvancedDisclosure>
      </section>
    </section>
  );
}
