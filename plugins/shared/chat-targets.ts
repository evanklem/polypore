/* shared "send to an open chat" plumbing.
 *
 * several panels (verify, agent/formation, …) need to push a prompt into a
 * running claude/codex CLI. the transport is the same everywhere: enumerate
 * the live agent-terminal panels from the dockview, focus the chosen one,
 * wait for its pty to mount, then dispatch a `polypore:terminal-send` event
 * the terminal component picks up and writes into the process. keeping it in
 * one place stops the three callers from drifting apart. */

import {
  dispatchTerminalSend,
  dockviewApi,
  isTerminalPanelMounted,
} from '../../src/core/polypore-window';

export type ChatTarget = {
  id: string;
  agent: string;
  slot: string;
  title: string;
  createdAt: number;
};

/* the running agent sessions, newest-listed-last, ready to send to. agent
   panels are recognized by manifest.category === 'agent' (surfaced through
   listPanels), not a hardcoded name list, so third-party agent plugins are
   valid send-to-chat targets too. */
export function openChatPanelTargets(): ChatTarget[] {
  const dock = dockviewApi();
  let panels: Array<{ id: string; slot: string; title?: string; category?: string }> = [];
  try {
    panels = dock?.listPanels() ?? [];
  } catch {
    panels = [];
  }
  return panels.flatMap((panel, index) => {
    if (panel.category !== 'agent' || !panel.id) return [];
    return [{
      id: panel.id,
      agent: panel.slot,
      slot: panel.slot,
      title: panel.title?.replace(/^[^\w]+/, '').trim() || `${panel.slot} ${index + 1}`,
      createdAt: index,
    }];
  });
}

/* bring the target session into view before delivery. prefers focusing the
   exact panel instance; falls back to focus-by-slot on older shells. */
export function focusChatTarget(target: ChatTarget) {
  const dock = dockviewApi();
  try {
    if (dock?.focusPanel) dock.focusPanel(target.id);
    else dock?.focusOrAdd(target.slot);
  } catch {
    /* focusing is best-effort; terminal delivery still checks mount readiness. */
  }
}

/* resolves true once the target terminal's pty has registered itself, or
   false after a short grace window (cold-started terminals). */
export function waitForTerminalTarget(panelId: string) {
  if (isTerminalPanelMounted(panelId)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const startedAt = performance.now();
    const check = () => {
      if (isTerminalPanelMounted(panelId)) {
        resolve(true);
        return;
      }
      if (performance.now() - startedAt > 1200) {
        resolve(false);
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

export function sendPromptToTerminal(target: ChatTarget, text: string) {
  dispatchTerminalSend({ panelId: target.id, text, submit: true });
}

/* one-shot helper: pick-or-deliver. returns a status describing what
   happened so callers can surface it. when more than one chat is open the
   caller should instead enumerate via openChatPanelTargets() and present a
   picker. */
export async function deliverPromptToTarget(
  target: ChatTarget,
  text: string,
): Promise<void> {
  focusChatTarget(target);
  const ready = await waitForTerminalTarget(target.id);
  if (!ready) throw new Error(`${target.title || target.agent} terminal is not mounted`);
  sendPromptToTerminal(target, text);
}
