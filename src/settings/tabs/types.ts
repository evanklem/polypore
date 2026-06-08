import type { SecretStore } from '../../../packages/host/src';
import type { PolyporeHost } from '../../../packages/sdk/src';
import type { AgentBinaryStatus, NativeSecretRef, TauriInvoke } from '../../core/tauri-types';

export type { AgentBinaryStatus, NativeSecretRef } from '../../core/tauri-types';

export type AgentMeta = Record<string, { icon: string; label: string }>;

/**
 * App-wide services consumed by the settings overlay tabs.
 * Each tab takes only this bag; App.tsx assembles it once.
 */
export interface GlobalSettingsServices {
  host: PolyporeHost;
  secretStore: SecretStore;
  tauriInvoke: TauriInvoke;
  localSecretRefs: () => NativeSecretRef[];
  secretHandle: (value: string) => string;
  agentMeta: AgentMeta;
}
