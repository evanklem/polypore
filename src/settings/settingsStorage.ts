import { deriveThemeTokens } from './themeColor';

/** the accent is now any colour, stored as a hex string */
export type InterfaceAccent = string;
export type InterfaceMotion = 'full' | 'reduced';
export type InterfaceGlass = 'frosted' | 'solid';

export type InterfaceSettings = {
  accent: InterfaceAccent;
  motion: InterfaceMotion;
  glass: InterfaceGlass;
};

export const INTERFACE_SETTINGS_KEY = 'polypore.interfaceSettings.v1';

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
};

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
  return next;
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
  return DEFAULT_INTERFACE_SETTINGS;
}
