/* window.__polypore — the single typed namespace for the few renderer-global
 * side channels that cannot ride the host RPC bus.
 *
 * panel components and the dockview live outside each other's React trees,
 * so a handful of cross-cutting plumbing needs a window-level meeting point.
 * every such channel is collected here — typed, named, and described in one
 * place — instead of growing ad-hoc window globals.
 *
 * channels:
 * - dockview: imperative panel API exposed by PolyporeDockview while it is
 *   mounted (add/focus/list/layout). consumed by App's layout persistence
 *   and panel focusing, chat-target discovery (plugins/shared/chat-targets),
 *   and the memory panel's focus-editor flow.
 * - terminalPanels: ids of terminal panels whose pty has mounted. written by
 *   the terminal component, polled by chat-target delivery so a prompt is
 *   only dispatched once a cold-started terminal can accept it.
 * - 'polypore:terminal-send' (window CustomEvent, helpers below): prompt
 *   delivery into a running terminal. dispatched by chat-target delivery,
 *   handled by the terminal component.
 *
 * one-shot notifications (e.g. an agent panel closing) are NOT window
 * channels — they ride the host server's pub/sub (topic 'panel:closed').
 */

export type DockviewGlobalApi = {
  addPanel: (slot: string) => void;
  focusOrAdd: (slot: string) => void;
  focusPanel: (id: string) => void;
  listPanels: () => Array<{ id: string; slot: string; title?: string; category?: string }>;
  getLayout: () => unknown;
};

type PolyporeNamespace = {
  dockview?: DockviewGlobalApi;
  terminalPanels?: Set<string>;
};

declare global {
  interface Window {
    __polypore?: PolyporeNamespace;
  }
}

function namespace(): PolyporeNamespace {
  if (!window.__polypore) window.__polypore = {};
  return window.__polypore;
}

/* ── dockview ──────────────────────────────────────────────────────────── */

export function setDockviewApi(api: DockviewGlobalApi) {
  namespace().dockview = api;
}

/* identity-checked so a stale unmount can't tear down a newer dockview's API */
export function clearDockviewApi(api: DockviewGlobalApi) {
  const ns = window.__polypore;
  if (ns?.dockview === api) delete ns.dockview;
}

export function dockviewApi(): DockviewGlobalApi | undefined {
  return window.__polypore?.dockview;
}

/* ── terminal mount registry ───────────────────────────────────────────── */

export function registerTerminalPanel(panelId: string) {
  const ns = namespace();
  if (!ns.terminalPanels) ns.terminalPanels = new Set();
  ns.terminalPanels.add(panelId);
}

export function unregisterTerminalPanel(panelId: string) {
  window.__polypore?.terminalPanels?.delete(panelId);
}

export function isTerminalPanelMounted(panelId: string): boolean {
  return window.__polypore?.terminalPanels?.has(panelId) ?? false;
}

/* ── terminal-send event ───────────────────────────────────────────────── */

export const TERMINAL_SEND_EVENT = 'polypore:terminal-send';

export type TerminalSendDetail = {
  panelId: string;
  text: string;
  submit: boolean;
};

export function dispatchTerminalSend(detail: TerminalSendDetail) {
  window.dispatchEvent(new CustomEvent<TerminalSendDetail>(TERMINAL_SEND_EVENT, { detail }));
}

export function onTerminalSend(fn: (detail: TerminalSendDetail) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<TerminalSendDetail>).detail;
    if (detail?.panelId) fn(detail);
  };
  window.addEventListener(TERMINAL_SEND_EVENT, handler);
  return () => window.removeEventListener(TERMINAL_SEND_EVENT, handler);
}
