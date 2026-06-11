/**
 * Shapes returned by the Rust Tauri shell over `tauri::invoke`. These are the
 * adapter-level contracts the renderer relies on: each one mirrors a Rust
 * `#[derive(serde::Serialize)]` struct in `src-tauri/src/`. Centralized here so
 * App.tsx and every component talk to the same shape.
 */

export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T> | null;

export type ProjectStatusResult = {
  path: string;
  name: string;
  branch?: string | null;
  upstream?: string | null;
  dirty: boolean;
};

export type GitRunResult = {
  action: string;
  command: string[];
  exitCode?: number | null;
  output: string;
};

export type RecentProject = {
  path: string;
  name: string;
  lastOpened: number;
  exists: boolean;
};

export type NativeSecretRef = {
  id: string;
  scope: 'user' | 'project';
  service?: string | null;
  hint: string;
  configured: boolean;
  createdAt?: number;
  lastUsedAt?: number | null;
  /* hosts secrets.use may deliver this secret to; empty means refused. */
  allowedHosts?: string[] | null;
};

export type AgentBinaryStatus = {
  agent: string;
  available: boolean;
  path?: string | null;
};
