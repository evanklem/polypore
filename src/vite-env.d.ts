/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

declare module 'monaco-editor/esm/vs/editor/editor.main' {
  export * from 'monaco-editor/esm/vs/editor/editor.api';
}
