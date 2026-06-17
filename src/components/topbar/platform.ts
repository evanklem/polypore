/* Window chrome differs by OS. On macOS we keep the native traffic lights
   (tauri.macos.conf.json sets titleBarStyle: "Overlay") and render no custom
   controls; on Windows/Linux the native title bar is off (decorations: false)
   and we draw our own minimize / maximize / close.

   Both the controls and the macOS left-inset run only inside the Tauri desktop
   shell. In a plain browser or under jsdom there is no native window to drive,
   so getAppWindow() returns null and callers no-op. */

export interface AppWindowControls {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
}

type GlobalTauri = {
  window?: { getCurrentWindow?: () => AppWindowControls };
};

export const IS_MAC =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent);

/* The handle exposed by Tauri's global API (withGlobalTauri). Returns null when
   not running inside the desktop shell. */
export function getAppWindow(): AppWindowControls | null {
  const tauri = (window as Window & { __TAURI__?: GlobalTauri }).__TAURI__;
  return tauri?.window?.getCurrentWindow?.() ?? null;
}
