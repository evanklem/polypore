import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DockviewReact } from 'dockview';
import type {
  DockviewApi,
  DockviewReadyEvent,
  IDockviewHeaderActionsProps,
  IDockviewPanelHeaderProps,
  IDockviewPanelProps,
  DockviewWillShowOverlayLocationEvent,
  SerializedDockview,
} from 'dockview-core';
import 'dockview/dist/styles/dockview.css';
import { PanelLoadingSurface, PanelSurface } from './PanelSurface';
import type { BuiltinPlugin, PanelContextDoc } from '../plugins/shared';
import type { PolyporeHost } from '../packages/sdk/src/host';
import type { HostRpcServer, PluginLoader } from '../packages/host/src';
import type { WorkspaceLayoutItem } from './core/types';
import { pluginPrefetch, perfPoint } from '../plugins/shared';
import { clearDockviewApi, setDockviewApi, type DockviewGlobalApi } from './core/polypore-window';

const tauriCore = () => (window as Window & { __TAURI__?: { core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } } }).__TAURI__?.core;
const tauriEvent = () => (window as Window & { __TAURI__?: { event?: { listen?: (event: string, cb: (msg: { payload: unknown }) => void) => Promise<() => void> } } }).__TAURI__?.event;

/* polypore-dockview is the only layout primitive. every panel (chat,
   editor, preview, …) is a dockview panel — drag, dock, tab, split and
   close all work uniformly. there is no special "chat region"; chat is
   just another plugin that happens to render via iframe. */

type PluginPanelContext = {
  pluginsBySlot: Map<string, BuiltinPlugin>;
  host: PolyporeHost;
  hostServer: HostRpcServer;
  pluginLoader: PluginLoader;
  sdkRuntime: string;
  chatBoot: Record<string, unknown>;
  contextItems: string[];
  contextByChat: Record<string, string[]>;
  contextDocsByChat: Record<string, PanelContextDoc[]>;
  onAddContext: (label: string, targetId?: string) => void;
  onRemoveContext: (label: string, targetId?: string) => void;
  onOpenHelp: (slot: string) => void;
  onOpenSettings: (slot: string) => void;
  installedPlugins: Array<{ id: string; title: string; source: string; enabled: boolean }>;
};

const AddPanelDispatchContext = createContext<((slot: string, referenceGroupId?: string) => void) | null>(null);
const FocusPanelDispatchContext = createContext<((id: string) => void) | null>(null);

/* agent chat panels are identified by manifest.category === 'agent', not by
   a hardcoded name list. this way any third-party plugin that declares
   category: "agent" in its polypore.json appears in the "open chats" section
   of the add-panel menu without requiring a change here. */
function isAgentChatSlot(ctx: PluginPanelContext, slot: string): boolean {
  return ctx.pluginsBySlot.get(slot)?.manifest.category === 'agent';
}

const PluginPanelContextProvider = createContext<PluginPanelContext | null>(null);

export function usePluginPanelContext() {
  const ctx = useContext(PluginPanelContextProvider);
  if (!ctx) throw new Error('PluginPanelContext missing — wrap in PolyporeDockview');
  return ctx;
}

type PluginPanelParams = { slot: string; displayTitle?: string };

/* panel ids must be unique against both this session's panels and ids
   restored from a saved layout. wall-clock alone collides when two panels
   are added in the same millisecond; a counter alone collides with restored
   ids after a reload. the pair is unique on both axes. */
let panelIdSeq = 0;
function nextPanelId(slot: string): string {
  panelIdSeq += 1;
  return `${slot}-${Date.now().toString(36)}-${panelIdSeq}`;
}

function isPluginEnabled(ctx: PluginPanelContext, plugin: BuiltinPlugin | undefined): boolean {
  if (!plugin) return false;
  const installed = ctx.installedPlugins.find((item) => item.id === plugin.manifest.id);
  return installed?.enabled !== false;
}

/* custom tab renderer — exposes proper role="tab" + aria-label so the
   tab strip is queryable both by accessibility tooling and by tests, and
   is keyboard-operable: Enter/Space activates, arrows/Home/End move focus
   along the strip, Delete closes. */
function PolyporeTab(props: IDockviewPanelHeaderProps<PluginPanelParams>) {
  const ctx = usePluginPanelContext();
  const tabRef = useRef<HTMLDivElement | null>(null);
  const slot = props.params.slot;
  const plugin = ctx.pluginsBySlot.get(slot);
  const icon = plugin?.meta.icon ?? '';
  const title = props.params.displayTitle ?? props.api.title ?? plugin?.meta.label ?? slot;
  const label = icon ? `${icon} ${title}` : title;
  const [active, setActive] = useState(props.api.isActive);
  useEffect(() => {
    const disposable = props.api.onDidActiveChange((event) => setActive(event.isActive));
    setActive(props.api.isActive);
    return () => disposable.dispose();
  }, [props.api]);
  /* dockview owns the tab rail element, so a tab without a tablist would be
     incomplete ARIA — patch the role onto the surrounding rail on mount. */
  useEffect(() => {
    const rail = tabRef.current?.closest('.dv-tabs-container');
    if (rail instanceof HTMLElement && !rail.getAttribute('role')) {
      rail.setAttribute('role', 'tablist');
    }
  }, []);
  const activate = () => {
    if (!props.api.isActive) {
      perfPoint(`tab-click:${slot}`);
      props.api.setActive();
    }
  };
  const close = () => {
    if (isAgentChatSlot(ctx, slot)) {
      /* a close is a one-shot notification, so it rides the pub/sub bus on
         the standard panel:closed topic rather than being crammed into a
         state key that would keep the last-closed id around forever. */
      ctx.hostServer.publish('panel:closed', { instanceId: String(props.api.id ?? '') });
    }
    props.api.close();
  };
  const onClose = (event: React.MouseEvent) => {
    event.stopPropagation();
    close();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const rail = tabRef.current?.closest('.dv-tabs-container');
    const tabs = rail ? [...rail.querySelectorAll<HTMLElement>('.polypore-tab')] : [];
    const index = tabRef.current ? tabs.indexOf(tabRef.current) : -1;
    switch (event.key) {
      case 'Enter':
      case ' ':
        event.preventDefault();
        activate();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        tabs[(index - 1 + tabs.length) % tabs.length]?.focus();
        break;
      case 'ArrowRight':
        event.preventDefault();
        tabs[(index + 1) % tabs.length]?.focus();
        break;
      case 'Home':
        event.preventDefault();
        tabs[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        tabs[tabs.length - 1]?.focus();
        break;
      case 'Delete':
        event.preventDefault();
        close();
        break;
      default:
        break;
    }
  };
  return (
    <div
      ref={tabRef}
      role="tab"
      aria-selected={active}
      aria-label={label}
      className="polypore-tab"
      data-slot={slot}
      tabIndex={active ? 0 : -1}
      onClick={activate}
      onKeyDown={onKeyDown}
    >
      {icon && <span className="polypore-tab__icon" aria-hidden="true">{icon}</span>}
      <span className="polypore-tab__label">{title}</span>
      <button
        type="button"
        className="polypore-tab__close"
        aria-label={`close ${label}`}
        onClick={onClose}
        onMouseDown={(event) => event.stopPropagation()}
      >
        ×
      </button>
    </div>
  );
}

function PluginPanelHost({ params, api }: IDockviewPanelProps<PluginPanelParams>) {
  const ctx = usePluginPanelContext();
  const slot = params.slot;
  const plugin = ctx.pluginsBySlot.get(slot);
  /* during the initial preset cascade, dockview marks every freshly-added
     panel as active inside its group — only to deactivate it again one
     frame later when the next sibling is added. eagerly hydrating in that
     "briefly active" window pays the full mount cost (xterm, monaco, …)
     for panels the user never actually sees. defer hydration to the next
     frame and re-check visibility, so we only spin up surfaces that stay
     on screen after the cascade settles. */
  const [hydrated, setHydrated] = useState(import.meta.env.MODE === 'test');
  const openHelp = useCallback(() => ctx.onOpenHelp(slot), [ctx.onOpenHelp, slot]);
  const openSettings = useCallback(() => ctx.onOpenSettings(slot), [ctx.onOpenSettings, slot]);
  const panelContext = useMemo(() => {
    if (!plugin) return undefined;
    return {
      panelInstanceId: api.id,
      panelSlot: slot,
      contextItems: ctx.contextItems,
      contextByChat: ctx.contextByChat,
      contextDocsByChat: ctx.contextDocsByChat,
      onAddContext: ctx.onAddContext,
      onRemoveContext: ctx.onRemoveContext,
      installedPlugins: ctx.installedPlugins,
      ...(plugin.buildContext?.({
        contextItems: ctx.contextItems,
        contextByChat: ctx.contextByChat,
        contextDocsByChat: ctx.contextDocsByChat,
        onAddContext: ctx.onAddContext,
        onRemoveContext: ctx.onRemoveContext,
      }) ?? {}),
    };
  }, [api.id, ctx.contextByChat, ctx.contextDocsByChat, ctx.contextItems, ctx.installedPlugins, ctx.onAddContext, ctx.onRemoveContext, plugin, slot]);

  /* keep the dockview tab title + tooltip in sync with the plugin meta.
     visible tab text reads "icon label" so users can scan the tab strip
     without hovering for tooltips. */
  useEffect(() => {
    if (plugin) api.setTitle(params.displayTitle ?? plugin.meta.label);
  }, [params.displayTitle, plugin, api]);

  useEffect(() => {
    if (hydrated) return undefined;
    let pendingTimer: number | null = null;
    const hydrate = () => {
      /* fire-and-forget chunk prefetch (phase 4 click-promotion). idempotent
         — if the post-boot driver already warmed the chunk this resolves
         instantly and React.lazy mounts without a Suspense fallback flash.
         if the user clicked faster than the driver reached this slot, the
         Suspense fallback shows the same deferred-placeholder styling so
         the visual transition is identical either way. */
      perfPoint(`hydrate:${slot}`);
      if (plugin) pluginPrefetch(plugin)?.().catch(() => {});
      setHydrated(true);
    };
    const scheduleCheck = () => {
      /* debounce the visibility check past the cascade step gap (~34ms).
         the boot cascade adds panels one-per-rAF+18ms — without this
         debounce, every panel briefly looks active when it's added and
         hydrates a surface (xterm/monaco/iframe) that the next cascade
         step immediately hides. wait long enough that only panels still
         visible after the cascade settles pay the mount cost.

         once boot has fully settled (signalled by the post-boot prefetch
         driver via body[data-polypore-boot-hydrated]) skip the debounce
         entirely — every chunk is already warm, and any visibility flip
         is now user-initiated, so the user feels every millisecond.

         hidden panels stay deferred indefinitely — their chunks are warmed
         by the post-boot prefetch driver in App.tsx, and the component
         mount is delayed until the user actually focuses the tab. that
         keeps three xterm ptys, monaco workers, and friends out of the
         boot path while still feeling instant on first click. */
      if (document.body.dataset.polyporeBootHydrated === '1') {
        if (api.isVisible) hydrate();
        return;
      }
      if (pendingTimer !== null) return;
      pendingTimer = window.setTimeout(() => {
        pendingTimer = null;
        if (api.isVisible) hydrate();
      }, 80);
    };
    scheduleCheck();
    const visibilityDisposable = api.onDidVisibilityChange(scheduleCheck);
    const activeDisposable = api.onDidActiveChange(scheduleCheck);
    const groupDisposable = api.onDidActiveGroupChange(scheduleCheck);
    return () => {
      if (pendingTimer !== null) window.clearTimeout(pendingTimer);
      visibilityDisposable.dispose();
      activeDisposable.dispose();
      groupDisposable.dispose();
    };
  }, [api, hydrated, plugin]);

  if (!plugin) {
    return <div className="empty-state">no plugin registered for slot {slot}</div>;
  }

  if (!hydrated) {
    return (
      <PanelLoadingSurface
        plugin={plugin}
        onOpenHelp={openHelp}
        onOpenSettings={openSettings}
        state="preparing"
      />
    );
  }

  return (
    <PanelSurface
      plugin={plugin}
      host={ctx.host}
      hostServer={ctx.hostServer}
      pluginLoader={ctx.pluginLoader}
      sdkRuntime={ctx.sdkRuntime}
      chatBoot={ctx.chatBoot}
      onOpenHelp={openHelp}
      onOpenSettings={openSettings}
      context={panelContext}
    />
  );
}

export type PolyporeDockviewContext = PluginPanelContext;

export function PolyporeDockviewProvider({
  value,
  children,
}: {
  value: PluginPanelContext;
  children: React.ReactNode;
}) {
  return (
    <PluginPanelContextProvider.Provider value={value}>{children}</PluginPanelContextProvider.Provider>
  );
}

export function PolyporeDockview({
  ctx,
  initialLayout,
  onReady,
  layoutStorageKey,
}: {
  ctx: PluginPanelContext;
  initialLayout: WorkspaceLayoutItem[];
  onReady?: () => void;
  layoutStorageKey?: string;
}) {
  const apiRef = useRef<DockviewApi | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cleanupReadyRef = useRef<(() => void) | null>(null);
  const components = useMemo(() => ({ pluginPanel: PluginPanelHost }), []);
  const tabComponents = useMemo(() => ({ polyporeTab: PolyporeTab }), []);
  const [, setReady] = useState(false);

  const syncAgentPanels = useCallback((api: DockviewApi, removedPanelIds = new Set<string>()) => {
    const counts = new Map<string, number>();
    const panels = api.panels
      .filter((panel) => (
        !removedPanelIds.has(String(panel.id ?? ''))
        && isAgentChatSlot(ctx, String(panel.params?.slot ?? ''))
      ))
      .map((panel) => {
        const slot = String(panel.params?.slot ?? '');
        const count = (counts.get(slot) ?? 0) + 1;
        counts.set(slot, count);
        const baseTitle = ctx.pluginsBySlot.get(slot)?.meta.label ?? slot;
        const title = count === 1 ? baseTitle : `${baseTitle} ${count}`;
        panel.api.updateParameters({ ...(panel.params ?? {}), displayTitle: title });
        panel.api.setTitle(title);
        return {
          id: String(panel.id ?? ''),
          agent: slot,
          title,
          active: api.activePanel?.id === panel.id,
        };
      });
    ctx.hostServer.setState('agentPanels', panels);
  }, [ctx]);

  const focusOrAddPanel = useCallback((slot: string) => {
    const api = apiRef.current;
    if (!api) return;
    const existing = api.panels.find((panel) => panel.params?.slot === slot);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const plugin = ctx.pluginsBySlot.get(slot);
    if (!plugin || !isPluginEnabled(ctx, plugin)) return;
    const panel = api.addPanel<PluginPanelParams>({
      id: nextPanelId(slot),
      component: 'pluginPanel',
      tabComponent: 'polyporeTab',
      title: plugin.meta.label,
      params: { slot },
    });
    panel.api.setActive();
    syncAgentPanels(api);
  }, [ctx, syncAgentPanels]);

  const onFocusPanel = useCallback((id: string) => {
    const api = apiRef.current;
    if (!api) return;
    const panel = api.panels.find((candidate) => String(candidate.id ?? '') === id);
    panel?.api.setActive();
  }, []);

  const onAddPanel = useCallback((slot: string, referenceGroupId?: string) => {
    const api = apiRef.current;
    if (!api) return;
    const plugin = ctx.pluginsBySlot.get(slot);
    if (!plugin || !isPluginEnabled(ctx, plugin)) return;
    /* always add a fresh panel instance — Adobe-style. clicking + on
       a tab strip intentionally adds the new panel into that same group
       so it joins the strip you clicked, rather than picking a random
       group elsewhere in the layout. */
    const panel = api.addPanel<PluginPanelParams>({
      id: nextPanelId(slot),
      component: 'pluginPanel',
      tabComponent: 'polyporeTab',
      title: plugin.meta.label,
      params: { slot },
      ...(referenceGroupId ? { position: { referenceGroup: referenceGroupId } } : {}),
    });
    panel.api.setActive();
    syncAgentPanels(api);
  }, [ctx, syncAgentPanels]);

  useEffect(() => ctx.hostServer.subscribe('panel:opened', (payload) => {
    const panelId = typeof payload === 'object' && payload && 'panelId' in payload
      ? String((payload as { panelId: unknown }).panelId)
      : '';
    const plugin = [...ctx.pluginsBySlot.values()].find((candidate) => candidate.manifest.id === panelId);
    if (plugin) focusOrAddPanel(plugin.slot);
  }), [ctx.hostServer, ctx.pluginsBySlot, focusOrAddPanel]);

  const handleWillShowOverlay = useCallback((event: DockviewWillShowOverlayLocationEvent) => {
    /* suppress drop overlays that would be a no-op. dockview shows a
       5-way directional overlay on 'content' drops (center + top/bottom/
       left/right) — we only want to block the directions that wouldn't
       actually change anything:

       - dragging within own group, dropping on center → no-op (panel
         stays where it is).
       - dragging within own group when it's the only tab → every
         direction collapses to a twin of the same group, no-op.

       peeling a tab off a multi-tab group via top/bottom/left/right *is*
       allowed — that's the Adobe-style split the user wants. tab
       re-ordering ('tab' / 'header_space') inside own group is also
       allowed since it changes the tab order. */
    const data = event.getData();
    if (!data) return;
    const targetGroup = event.group;
    if (!targetGroup) return;
    const sameGroup = data.groupId === targetGroup.id;
    if (!sameGroup) return;
    const onlyPanelInGroup = targetGroup.panels.length <= 1;
    if (event.kind === 'content') {
      /* center on own group is always a no-op; edge directions are only
         a no-op when there's nothing left in the source group to split
         away from. */
      if (event.position === 'center' || onlyPanelInGroup) {
        event.preventDefault();
      }
      return;
    }
    /* tab / header_space inside a single-panel group → no-op reorder. */
    if (onlyPanelInGroup) {
      event.preventDefault();
    }
  }, []);

  const handleReady = useCallback((event: DockviewReadyEvent) => {
    cleanupReadyRef.current?.();
    cleanupReadyRef.current = null;
    apiRef.current = event.api;
    const overlayDisposable = event.api.onWillShowOverlay(handleWillShowOverlay);

    /* perf: while a sash is being dragged, tag <body data-dv-resizing="1">
       so CSS can suspend expensive chrome. Keep this state passive: it
       must not participate in Dockview's own pointer capture pipeline. */
    let clearFrame: number | null = null;
    let activePanelDisposable: { dispose: () => void } | null = null;
    let layoutChangeDisposable: { dispose: () => void } | null = null;
    let exposedDockviewApi: DockviewGlobalApi | undefined;
    const stagedMountTimers = new Set<number>();
    const stagedMountFrames = new Set<number>();
    let saveTimer: number | null = null;
    const saveLayout = () => {
      if (!layoutStorageKey) return;
      try {
        window.localStorage.setItem(layoutStorageKey, JSON.stringify(event.api.toJSON()));
      } catch { /* storage quota exceeded */ }
    };
    const scheduleSave = () => {
      if (!layoutStorageKey) return;
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(saveLayout, 1500);
    };

    const broadcastResizeState = (active: boolean) => {
      document.querySelectorAll<HTMLIFrameElement>('.plugin-iframe').forEach((frame) => {
        frame.contentWindow?.postMessage({ source: 'polypore', type: 'resize-state', active }, '*');
      });
    };

    const clearResizeState = (_reason?: string) => {
      if (clearFrame !== null) cancelAnimationFrame(clearFrame);
      /* Drag ended — reduce suppression to a 2s cooldown so git doesn't
         fire the instant the user releases, but doesn't stay blocked forever. */
      if (document.body.dataset.dvResizing) {
        tauriCore()?.invoke?.('snapshot_suppress', { durationMs: 2000 })?.catch(() => {});
      }
      clearFrame = requestAnimationFrame(() => {
        clearFrame = null;
        delete document.body.dataset.dvResizing;
        broadcastResizeState(false);
      });
    };
    /* while a dockview tab/group drag is in flight the cursor leaves the tab
       strip and sweeps over the panel body — a plugin iframe — which swallows
       the native drag stream and starves dockview of its terminating
       `dragend` (the "tab stuck to the cursor" bug, most visible on a fast
       flick down off the tab). flag the drag on <body> the instant it starts
       (cursor still on the tab strip) so CSS can make every iframe
       pointer-transparent for the duration; the drag then completes in the
       parent document and ends normally. mirrors the data-dv-resizing flag. */
    const clearTabDragging = () => {
      if (document.body.dataset.dvDragging) delete document.body.dataset.dvDragging;
    };
    /* click-flick guard: on a fast click+flick over a tab, WebKitGTK can
       begin a native drag whose terminating button-release is lost to a GTK
       grab race — the release reaches neither the page (no mouseup) nor the
       drag session (no dragend), so the drag image stays welded to the
       cursor until the next click. JS cannot cancel an in-flight native
       drag, only stop one from starting: veto any tab dragstart that fires
       within the hold threshold of its pointerdown (or after the button is
       already up). dockview's DragHandler bails on defaultPrevented, so the
       cancel is clean. a deliberate drag begun that fast just needs a retry. */
    const TAB_DRAG_MIN_HOLD_MS = 150;
    let tabStripPointerDownAt = 0;
    let tabStripPointerIsDown = false;
    const onDragStart = (e: DragEvent) => {
      const target = e.target;
      if (!(target instanceof Element) || !target.closest('.dv-tab, .dv-tabs-and-actions-container')) {
        return;
      }
      if (!tabStripPointerIsDown || performance.now() - tabStripPointerDownAt < TAB_DRAG_MIN_HOLD_MS) {
        e.preventDefault();
        return;
      }
      document.body.dataset.dvDragging = '1';
    };
    const onDragEnd = () => clearTabDragging();
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Element) {
        if (target.closest('.dv-tabs-and-actions-container')) {
          window.getSelection()?.removeAllRanges();
          if (e.button === 0) {
            tabStripPointerDownAt = performance.now();
            tabStripPointerIsDown = true;
          }
        }
        if (target.closest('.dv-sash')) {
          document.body.dataset.dvResizing = '1';
          broadcastResizeState(true);
          tauriCore()?.invoke?.('snapshot_suppress', { durationMs: 30000 })?.catch(() => {});
        }
      }
    };
    const scrubDrag = {
      rail: null as HTMLElement | null,
      pointerId: -1,
      startX: 0,
      startLeft: 0,
      moved: false,
    };
    const stopScrubDrag = () => {
      if (!scrubDrag.rail) return;
      scrubDrag.rail.classList.remove('is-scrubbing-tabs');
      try {
        scrubDrag.rail.releasePointerCapture(scrubDrag.pointerId);
      } catch {
        /* pointer capture may already be released by the browser. */
      }
      scrubDrag.rail = null;
      scrubDrag.pointerId = -1;
      scrubDrag.moved = false;
    };
    const onTabRailPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const tabRail = target.closest<HTMLElement>('.dv-tabs-container');
      const voidRail = target.closest<HTMLElement>('.dv-void-container');
      const header = target.closest<HTMLElement>('.dv-tabs-and-actions-container');
      const rail = tabRail ?? (voidRail || header ? header?.querySelector<HTMLElement>('.dv-tabs-container') ?? null : null);
      if (!rail || rail.scrollWidth <= rail.clientWidth) return;
      if (target.closest('.dockview-add, button')) return;
      if (target.closest('.dv-tab')) return;
      scrubDrag.rail = rail;
      scrubDrag.pointerId = e.pointerId;
      scrubDrag.startX = e.clientX;
      scrubDrag.startLeft = rail.scrollLeft;
      scrubDrag.moved = false;
      rail.classList.add('is-scrubbing-tabs');
      rail.setPointerCapture(e.pointerId);
    };
    const onTabRailPointerMove = (e: PointerEvent) => {
      const rail = scrubDrag.rail;
      if (!rail || e.pointerId !== scrubDrag.pointerId) return;
      const delta = e.clientX - scrubDrag.startX;
      if (Math.abs(delta) > 2) scrubDrag.moved = true;
      rail.scrollLeft = scrubDrag.startLeft - delta;
      e.preventDefault();
    };
    const onPointerUp = () => { tabStripPointerIsDown = false; clearResizeState('pointerup'); clearTabDragging(); };
    const onPointerCancel = () => { tabStripPointerIsDown = false; clearResizeState('pointercancel'); clearTabDragging(); };
    const onBlur = () => { tabStripPointerIsDown = false; clearResizeState('blur'); clearTabDragging(); };
    let agentAddDisposable: { dispose: () => void } | null = null;
    let agentRemoveDisposable: { dispose: () => void } | null = null;
    let agentActiveDisposable: { dispose: () => void } | null = null;
    const dockviewElement = hostRef.current;
    if (!dockviewElement) return;

    /* ── sash pointermove throttle ───────────────────────────────────────
       Dockview's layoutViews() runs synchronously on every pointermove on
       document. Fast mice (or just sustained dragging) fire 4–8 events per
       16ms frame, so layoutViews() stacks up and the cumulative JS cost
       delays the rAF — that was the primary source of the ~30-65 ms raf
       gaps we measured. Fix: intercept every sash-drag move in capture
       phase, stop it from reaching dockview, and dispatch exactly one
       synthetic event per rAF so dockview sees one layoutViews() call per
       frame instead of N.

       WeakSet guards the synthetic event so our capture handler lets it
       pass through without re-intercepting. stopImmediatePropagation stops
       all subsequent capture AND non-capture listeners (including
       dockview's document listener) for the raw event only.
    ─────────────────────────────────────────────────────────────────────── */
    const throttledMoves = new WeakSet<PointerEvent>();
    let pendingMove: PointerEvent | null = null;
    let throttleRafId: number | null = null;

    const dispatchThrottled = () => {
      throttleRafId = null;
      const ev = pendingMove;
      pendingMove = null;
      if (!ev || !document.body.dataset.dvResizing) return;
      const synthetic = new PointerEvent('pointermove', {
        bubbles: true,
        cancelable: ev.cancelable,
        clientX: ev.clientX,
        clientY: ev.clientY,
        screenX: ev.screenX,
        screenY: ev.screenY,
        movementX: ev.movementX,
        movementY: ev.movementY,
        pointerId: ev.pointerId,
        pointerType: ev.pointerType,
        pressure: ev.pressure,
        isPrimary: ev.isPrimary,
        button: ev.button,
        buttons: ev.buttons,
      });
      throttledMoves.add(synthetic);
      document.dispatchEvent(synthetic);
    };

    const onSashMoveThrottle = (e: PointerEvent) => {
      if (throttledMoves.has(e)) return;
      if (!document.body.dataset.dvResizing) {
        /* fallback: pointerdown detection may have missed if the click landed
           on the 1px panel border rather than the sash hit area. When the
           pointer is captured to a sash element, e.target still points to it
           during the drag — use that to late-set the flag. */
        if (e.buttons !== 0 && e.target instanceof Element && e.target.closest('.dv-sash')) {
          document.body.dataset.dvResizing = '1';
          broadcastResizeState(true);
          tauriCore()?.invoke?.('snapshot_suppress', { durationMs: 30000 })?.catch(() => {});
        } else {
          return;
        }
      }
      e.stopImmediatePropagation();
      pendingMove = e;
      if (throttleRafId === null) throttleRafId = requestAnimationFrame(dispatchThrottled);
    };

    document.addEventListener('pointermove', onSashMoveThrottle, { capture: true });

    dockviewElement.addEventListener('pointerdown', onPointerDown, true);
    dockviewElement.addEventListener('pointerdown', onTabRailPointerDown, true);
    dockviewElement.addEventListener('pointermove', onTabRailPointerMove, true);
    dockviewElement.addEventListener('dragstart', onDragStart, true);
    window.addEventListener('dragend', onDragEnd, true);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointerup', stopScrubDrag, true);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('pointercancel', stopScrubDrag, true);
    window.addEventListener('blur', onBlur, true);
    window.addEventListener('beforeunload', saveLayout);
    cleanupReadyRef.current = () => {
      document.removeEventListener('pointermove', onSashMoveThrottle, true);
      if (throttleRafId !== null) { cancelAnimationFrame(throttleRafId); throttleRafId = null; }
      overlayDisposable.dispose();
      agentAddDisposable?.dispose();
      agentRemoveDisposable?.dispose();
      agentActiveDisposable?.dispose();
      activePanelDisposable?.dispose();
      dockviewElement.removeEventListener('pointerdown', onPointerDown, true);
      dockviewElement.removeEventListener('pointerdown', onTabRailPointerDown, true);
      dockviewElement.removeEventListener('pointermove', onTabRailPointerMove, true);
      dockviewElement.removeEventListener('dragstart', onDragStart, true);
      window.removeEventListener('dragend', onDragEnd, true);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointerup', stopScrubDrag, true);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('pointercancel', stopScrubDrag, true);
      window.removeEventListener('blur', onBlur, true);
      if (clearFrame !== null) cancelAnimationFrame(clearFrame);
      for (const timer of stagedMountTimers) window.clearTimeout(timer);
      for (const frame of stagedMountFrames) window.cancelAnimationFrame(frame);
      stagedMountTimers.clear();
      stagedMountFrames.clear();
      stopScrubDrag();
      clearTabDragging();
      delete document.body.dataset.dvResizing;
      broadcastResizeState(false);
      window.removeEventListener('beforeunload', saveLayout);
      if (saveTimer !== null) { window.clearTimeout(saveTimer); saveTimer = null; }
      layoutChangeDisposable?.dispose();
      if (exposedDockviewApi) clearDockviewApi(exposedDockviewApi);
      if (apiRef.current === event.api) apiRef.current = null;
    };

    /* restore previous layout if available, otherwise build from preset */
    let restored = false;
    if (layoutStorageKey) {
      const savedRaw = window.localStorage.getItem(layoutStorageKey);
      if (savedRaw) {
        try {
          const savedLayout = JSON.parse(savedRaw) as SerializedDockview;
          if (savedLayout?.panels && savedLayout?.grid) {
            event.api.fromJSON(savedLayout);
            restored = true;
          }
        } catch { /* corrupt saved layout — fall through to preset cascade */ }
      }
    }

    if (restored) {
      ctx.hostServer.setState('activePanel', event.api.activePanel?.params?.slot ?? null);
      activePanelDisposable = event.api.onDidActivePanelChange((panel) => {
        ctx.hostServer.setState('activePanel', panel?.params?.slot ?? null);
      });
      syncAgentPanels(event.api);
      setReady(true);
      onReady?.();
    } else {
      /* build the initial layout from the selected workspace preset. dockview's
         `direction` controls split placement; once the left anchor is created,
         subsequent center panels target the right-side group. */
      const firstByPos = new Map<string, string>();
      let firstCenterId: string | null = null;
      /* a `size` of 0..1 in the layout config is interpreted as a fraction
         of the dockview width; integers are treated as pixels. translate at
         layout time using the current dockview element width so presets can
         own their window proportions. */
      const containerWidth = event.api.width || window.innerWidth || 1400;
      const initialWidthFor = (size: number | undefined) => {
        if (!size) return undefined;
        return size <= 1
          ? Math.max(280, Math.round(containerWidth * size))
          : Math.round(size);
      };
      const leftAnchorWidth = initialWidthFor(initialLayout.find((item) => item.position === 'left')?.size);
      const pendingInitialPanels = initialLayout.filter((item) => isPluginEnabled(ctx, ctx.pluginsBySlot.get(item.slot)));
      const stageInitialPanels = import.meta.env.MODE !== 'test';
      const scheduleNextInitialPanel = () => {
        if (!stageInitialPanels) {
          mountNextInitialPanel();
          return;
        }
        const frame = window.requestAnimationFrame(() => {
          stagedMountFrames.delete(frame);
          const timer = window.setTimeout(() => {
            stagedMountTimers.delete(timer);
            mountNextInitialPanel();
          }, 18);
          stagedMountTimers.add(timer);
        });
        stagedMountFrames.add(frame);
      };
      const mountNextInitialPanel = () => {
        const item = pendingInitialPanels.shift();
        if (!item) {
          if (firstCenterId) {
            const panel = event.api.getPanel(firstCenterId);
            panel?.api.setActive();
          }
          ctx.hostServer.setState('activePanel', event.api.activePanel?.params?.slot ?? firstCenterId ?? null);
          activePanelDisposable = event.api.onDidActivePanelChange((panel) => {
            ctx.hostServer.setState('activePanel', panel?.params?.slot ?? null);
          });

          setReady(true);
          onReady?.();
          return;
        }
        const plugin = ctx.pluginsBySlot.get(item.slot);
        if (!plugin) {
          mountNextInitialPanel();
          return;
        }
        const position = item.position ?? 'center';
        const referenceId = firstByPos.get(position);
        const id = `${item.slot}`;
        const isFirstCenterSplit = position === 'center' && !referenceId && Boolean(firstByPos.get('left'));
        const initialWidth = isFirstCenterSplit && leftAnchorWidth
          ? Math.max(480, containerWidth - leftAnchorWidth)
          : initialWidthFor(item.size);
        event.api.addPanel<PluginPanelParams>({
          id,
          component: 'pluginPanel',
          tabComponent: 'polyporeTab',
          title: plugin.meta.label,
          params: { slot: item.slot },
          ...(initialWidth ? { initialWidth } : {}),
          position: referenceId
            ? { referencePanel: referenceId, index: item.tabIndex }
            : position === 'left'
              ? undefined
              : firstByPos.get('left')
                ? { referencePanel: firstByPos.get('left')!, direction: 'right' }
                : undefined,
        });
        if (!firstByPos.has(position)) firstByPos.set(position, id);
        if (position === 'center' && firstCenterId === null) firstCenterId = id;
        syncAgentPanels(event.api);

        scheduleNextInitialPanel();
      };
      scheduleNextInitialPanel();
    }

    agentAddDisposable = event.api.onDidAddPanel(() => syncAgentPanels(event.api));
    agentRemoveDisposable = event.api.onDidRemovePanel((panel) => {
      syncAgentPanels(event.api, new Set([String(panel.id ?? '')]));
      const frame = window.requestAnimationFrame(() => {
        stagedMountFrames.delete(frame);
        syncAgentPanels(event.api);
      });
      stagedMountFrames.add(frame);
    });
    agentActiveDisposable = event.api.onDidActivePanelChange(() => syncAgentPanels(event.api));
    layoutChangeDisposable = event.api.onDidLayoutChange(scheduleSave);
    syncAgentPanels(event.api);

    /* expose two affordances for external callers:
       - addPanel(slot): always create a new instance (the + button path).
       - focusOrAdd(slot): focus an existing instance, create one if none
         exists (tool-card jumps from the chat iframe etc.). */
    exposedDockviewApi = {
      addPanel: (slot) => onAddPanel(slot),
      focusOrAdd: focusOrAddPanel,
      focusPanel: onFocusPanel,
      listPanels: () => event.api.panels.map((panel) => {
        const slot = typeof panel.params?.slot === 'string' ? panel.params.slot : '';
        return {
          id: String(panel.id ?? ''),
          slot,
          title: typeof panel.api?.title === 'string' ? panel.api.title : undefined,
          /* lets consumers (chat-targets) recognize agent panels by manifest
             category instead of a hardcoded name list. */
          category: ctx.pluginsBySlot.get(slot)?.manifest.category,
        };
      }),
      getLayout: () => event.api.toJSON(),
    };
    setDockviewApi(exposedDockviewApi);
  }, [initialLayout, ctx.pluginsBySlot, onAddPanel, focusOrAddPanel, onFocusPanel, handleWillShowOverlay, onReady, syncAgentPanels, layoutStorageKey]);

  useEffect(() => () => cleanupReadyRef.current?.(), []);

  return (
    <PolyporeDockviewProvider value={ctx}>
      <AddPanelDispatchContext.Provider value={onAddPanel}>
       <FocusPanelDispatchContext.Provider value={onFocusPanel}>
        <div className="polypore-dockview-host" ref={hostRef}>
          <DockviewReact
            className="polypore-dockview"
            components={components}
            tabComponents={tabComponents}
            defaultTabComponent={PolyporeTab}
            rightHeaderActionsComponent={AddPanelHeaderAction}
            disableFloatingGroups={false}
            disableDnd={false}
            onReady={handleReady}
          />
        </div>
       </FocusPanelDispatchContext.Provider>
      </AddPanelDispatchContext.Provider>
    </PolyporeDockviewProvider>
  );
}

/* the + button rendered inside dockview's right tab-action slot so it
   sits flush against the tab strip on each group — clicking it adds the
   selected plugin into that same group, matching the Adobe pattern. */
function AddPanelHeaderAction(props: IDockviewHeaderActionsProps) {
  const ctx = usePluginPanelContext();
  const addPanel = useContext(AddPanelDispatchContext);
  return (
    <AddPanelButton
      ctx={ctx}
      onAdd={(slot) => addPanel?.(slot, props.group.id)}
    />
  );
}

function AddPanelButton({
  ctx,
  onAdd,
}: {
  ctx: PluginPanelContext;
  onAdd: (slot: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const allPlugins = [...ctx.pluginsBySlot.values()]
    .filter((plugin) => isPluginEnabled(ctx, plugin) && plugin.inDefaultStrip !== false);

  /* agent plugins always appear first, then non-agents — both groups
     sorted by their own defaultOrder. no separate "open chats" section
     so each plugin appears exactly once. */
  const plugins = [
    ...allPlugins.filter((p) => p.manifest.category === 'agent').sort((a, b) => (a.defaultOrder ?? 999) - (b.defaultOrder ?? 999)),
    ...allPlugins.filter((p) => p.manifest.category !== 'agent').sort((a, b) => (a.defaultOrder ?? 999) - (b.defaultOrder ?? 999)),
  ];

  const toggle = () => setOpen((wasOpen) => !wasOpen);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    /* focus the first item so the menu is keyboard-reachable as soon as it
       opens; the trigger keeps focus otherwise and arrows would be dead. */
    containerRef.current?.querySelector<HTMLElement>('.dockview-add__item')?.focus();
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    const items = containerRef.current
      ? [...containerRef.current.querySelectorAll<HTMLElement>('.dockview-add__item')]
      : [];
    const index = items.indexOf(document.activeElement as HTMLElement);
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        containerRef.current?.querySelector<HTMLElement>('.dockview-add__button')?.focus();
        break;
      case 'ArrowDown':
        event.preventDefault();
        items[(index + 1) % items.length]?.focus();
        break;
      case 'ArrowUp':
        event.preventDefault();
        items[(index - 1 + items.length) % items.length]?.focus();
        break;
      case 'Home':
        event.preventDefault();
        items[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        items[items.length - 1]?.focus();
        break;
      default:
        break;
    }
  };

  return (
    <div className="dockview-add" ref={containerRef}>
      <button
        type="button"
        className="dockview-add__button"
        aria-label="open new tab"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={toggle}
      >
        +
      </button>
      {open && (
        <div className="dockview-add__menu" role="menu" aria-label="add panel" onKeyDown={onMenuKeyDown}>
          {plugins.map((plugin) => (
            <button
              key={plugin.slot}
              type="button"
              role="menuitem"
              className="dockview-add__item"
              aria-label={`${plugin.meta.icon} ${plugin.meta.label}`}
              onClick={() => {
                onAdd(plugin.slot);
                setOpen(false);
              }}
            >
              <span className="dockview-add__icon" aria-hidden="true">{plugin.meta.icon}</span>
              <span>{plugin.meta.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
