import { afterEach, describe, expect, test } from 'vitest';
import { applyInterfaceSettings, DEFAULT_INTERFACE_SETTINGS } from './settingsStorage';

type TauriWindow = Window & { __TAURI__?: unknown };
type FakeWebview = {
  label: string;
  calls: number[];
  setZoom(this: FakeWebview, factor: number): Promise<void>;
};

const originalTauri = (window as TauriWindow).__TAURI__;

describe('settingsStorage', () => {
  afterEach(() => {
    Object.defineProperty(window, '__TAURI__', {
      configurable: true,
      value: originalTauri,
    });
    document.documentElement.style.removeProperty('zoom');
    document.documentElement.style.removeProperty('--polypore-ui-zoom');
  });

  test('uses native Tauri webview zoom without leaving CSS zoom active', async () => {
    const webview: FakeWebview = {
      label: 'main',
      calls: [],
      async setZoom(factor) {
        if (this.label !== 'main') throw new Error('setZoom was called without its Webview receiver');
        this.calls.push(factor);
      },
    };
    Object.defineProperty(window, '__TAURI__', {
      configurable: true,
      value: {
        webview: {
          getCurrentWebview: () => webview,
        },
      },
    });
    document.documentElement.style.setProperty('zoom', '1.2');

    applyInterfaceSettings({ ...DEFAULT_INTERFACE_SETTINGS, zoom: 0.75 });
    await Promise.resolve();

    expect(webview.calls).toEqual([0.75]);
    expect(document.documentElement.style.getPropertyValue('zoom')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--polypore-ui-zoom')).toBe('0.75');
  });
});
