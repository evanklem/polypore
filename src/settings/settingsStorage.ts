import { deriveThemeTokens } from './themeColor';

/** the accent is now any colour, stored as a hex string */
export type InterfaceAccent = string;
export type InterfaceMotion = 'full' | 'reduced';
export type InterfaceGlass = 'frosted' | 'solid';

export type InterfaceSettings = {
  accent: InterfaceAccent;
  motion: InterfaceMotion;
  glass: InterfaceGlass;
  /* whole-UI zoom factor. applied as the webview's native page zoom in the
     Tauri shell (and CSS `zoom` as a browser-dev fallback) so the user can
     size the IDE independently of OS/compositor scaling. native zoom is used
     rather than CSS `zoom` because CSS `zoom` re-rounds every line box to a
     device pixel at fractional factors, which clips glyph descenders and the
     line-highlight bands in Monaco, xterm, and the diff/preview panels. */
  zoom: number;
};

export const INTERFACE_SETTINGS_KEY = 'polypore.interfaceSettings.v1';

/* fired on every persisted change so open UI (the Settings slider) can resync
   when the value is changed from elsewhere, e.g. the global zoom hotkeys. */
export const INTERFACE_SETTINGS_EVENT = 'polypore:interface-settings';

export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 1.5;
export const ZOOM_STEP = 0.05;
const DEFAULT_ZOOM = 1;

/** named quick-pick swatches; the picker can choose anything else */
export const ACCENT_PRESETS: Array<{ name: string; hex: string }> = [
  { name: 'honey', hex: '#f0b35a' },
  { name: 'moss', hex: '#8abe84' },
  { name: 'blue', hex: '#7aaae4' },
  { name: 'rose', hex: '#e58897' },
  { name: 'violet', hex: '#b18ce0' },
  { name: 'teal', hex: '#5fc4bd' },
];

export const DEFAULT_INTERFACE_SETTINGS: InterfaceSettings = {
  accent: '#f0b35a',
  motion: 'full',
  glass: 'frosted',
  zoom: DEFAULT_ZOOM,
};

export function normalizeZoom(value: number | undefined): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_ZOOM;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n * 100) / 100));
}

/* legacy preset names → hex, so a v1 value stored as 'honey' still loads */
const LEGACY_ACCENTS: Record<string, string> = {
  honey: '#f0b35a',
  moss: '#8abe84',
  blue: '#7aaae4',
  rose: '#e58897',
};

export function normalizeAccent(value: string | undefined): string {
  if (!value) return DEFAULT_INTERFACE_SETTINGS.accent;
  if (value in LEGACY_ACCENTS) return LEGACY_ACCENTS[value];
  const hex = value.trim();
  return /^#?[0-9a-fA-F]{6}$|^#?[0-9a-fA-F]{3}$/.test(hex)
    ? (hex.startsWith('#') ? hex.toLowerCase() : `#${hex.toLowerCase()}`)
    : DEFAULT_INTERFACE_SETTINGS.accent;
}

function sanitizeSettings(value: Partial<InterfaceSettings> | null | undefined): InterfaceSettings {
  const next = { ...DEFAULT_INTERFACE_SETTINGS, ...(value ?? {}) };
  return {
    accent: normalizeAccent(next.accent),
    motion: next.motion === 'reduced' ? 'reduced' : 'full',
    glass: next.glass === 'solid' ? 'solid' : 'frosted',
    zoom: normalizeZoom(next.zoom),
  };
}

export function loadInterfaceSettings(): InterfaceSettings {
  if (typeof window === 'undefined') return DEFAULT_INTERFACE_SETTINGS;
  try {
    const raw = window.localStorage.getItem(INTERFACE_SETTINGS_KEY);
    return sanitizeSettings(raw ? JSON.parse(raw) as Partial<InterfaceSettings> : null);
  } catch {
    return DEFAULT_INTERFACE_SETTINGS;
  }
}

export function saveInterfaceSettings(settings: InterfaceSettings): InterfaceSettings {
  const next = sanitizeSettings(settings);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(INTERFACE_SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* localStorage can be unavailable in restricted browser contexts. */
    }
  }
  applyInterfaceSettings(next);
  emitInterfaceSettings(next);
  return next;
}

function emitInterfaceSettings(next: InterfaceSettings): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(INTERFACE_SETTINGS_EVENT, { detail: next }));
}

export function applyInterfaceSettings(settings: InterfaceSettings): void {
  if (typeof document === 'undefined') return;
  const next = sanitizeSettings(settings);
  const root = document.documentElement;
  /* derive the whole palette — accent shades AND the surface/ink ladder — so
     backgrounds and panel bodies re-tint with the accent, not just the chrome. */
  const tokens = deriveThemeTokens(next.accent);
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(name, value);
  }
  delete root.dataset.polyporeDensity;
  root.dataset.polyporeMotion = next.motion;
  root.dataset.polyporeGlass = next.glass;
  applyZoom(next.zoom);
}

type TauriWebview = { setZoom?: (factor: number) => Promise<void> };
type TauriWebviewApi = { getCurrentWebview?: () => TauriWebview };

function nativeWebview(): TauriWebviewApi | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { __TAURI__?: { webview?: TauriWebviewApi } }).__TAURI__?.webview ?? null;
}

/* native page zoom rasterizes per device pixel, so Monaco/xterm/diff/preview
   lines never clip at fractional factors the way CSS `zoom` does. only the
   browser-dev path (no scriptable native zoom) keeps the CSS `zoom` fallback. */
function applyZoom(zoom: number): void {
  const root = document.documentElement;
  root.style.setProperty('--polypore-ui-zoom', String(zoom));
  root.style.setProperty('--polypore-ui-hairline', `${Math.max(1, 1 / zoom).toFixed(4)}px`);
  let webview: TauriWebview | undefined;
  try {
    webview = nativeWebview()?.getCurrentWebview?.();
  } catch {
    webview = undefined;
  }
  if (webview?.setZoom) {
    root.style.removeProperty('zoom');
    const fallbackToCssZoom = () => root.style.setProperty('zoom', String(zoom));
    try {
      // Tauri Webview methods read `this.label`, so keep the receiver intact.
      Promise.resolve(webview.setZoom(zoom)).catch(fallbackToCssZoom);
    } catch {
      fallbackToCssZoom();
    }
    return;
  }
  root.style.setProperty('zoom', String(zoom));
}

export function resetInterfaceSettings(): InterfaceSettings {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(INTERFACE_SETTINGS_KEY);
    } catch {
      /* localStorage can be unavailable in restricted browser contexts. */
    }
  }
  applyInterfaceSettings(DEFAULT_INTERFACE_SETTINGS);
  emitInterfaceSettings(DEFAULT_INTERFACE_SETTINGS);
  return DEFAULT_INTERFACE_SETTINGS;
}

/* step the scale by one increment (1 = in, -1 = out, 0 = reset to 100%),
   clamped to the slider range, and persist it through the same path the
   Settings slider uses so the two stay in sync. */
export function nudgeZoom(direction: 1 | -1 | 0): InterfaceSettings {
  const current = loadInterfaceSettings();
  const zoom = direction === 0
    ? DEFAULT_ZOOM
    : normalizeZoom(current.zoom + direction * ZOOM_STEP);
  return saveInterfaceSettings({ ...current, zoom });
}

/* VS Code-style global scale hotkeys bound to the same persisted setting:
   Ctrl/Cmd with '=' or '+' zooms in, with '-' zooms out, with '0' resets.
   capture phase + preventDefault so the browser's own page zoom and the
   focused Monaco/xterm surfaces don't also act on the chord. */
export function registerZoomHotkeys(target: Window = window): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || !(event.ctrlKey || event.metaKey)) return;
    let direction: 1 | -1 | 0;
    switch (event.key) {
      case '=':
      case '+':
        direction = 1;
        break;
      case '-':
      case '_':
        direction = -1;
        break;
      case '0':
        direction = 0;
        break;
      default:
        return;
    }
    event.preventDefault();
    nudgeZoom(direction);
  };
  target.addEventListener('keydown', onKeyDown, { capture: true });
  return () => target.removeEventListener('keydown', onKeyDown, { capture: true });
}
