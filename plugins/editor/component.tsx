import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Diagnostic, TextEdit } from '../../packages/sdk/src';
import type * as MonacoApi from 'monaco-editor/esm/vs/editor/editor.api';
import type { FileMeta, FileNode, FileTreeContextInfo } from '../shared';
import type { BuiltinPluginProps } from '../shared';
import { FileTree, PanelHeader, ResizeHandle, scheduleAfterPaint, perfPoint, useResizableSplit } from '../shared';
import { buildDebugDecorations, nextBreakpointAction } from './debug-decorations';
import {
  type EditorMarker,
  type TypeScriptProjectConfig,
  ambientTypeSpecifiersForPath,
  dirname,
  extraLibPathsForPath,
  isActionableMonacoMarker,
  markerCode,
  markerSeverity,
  nodeModuleMirrorRootsForPath,
  normalizeEditorPath,
  normalizeStringList,
  normalizeTypeScriptProjectConfig,
} from './ambient-types';
import type { DebugState } from '../../packages/sdk/src/host';
import { loadInterfaceSettings } from '../../src/settings/settingsStorage';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

type MonacoModule = typeof MonacoApi;
type MonacoEditorModel = ReturnType<MonacoModule['editor']['createModel']>;
type MonacoEditorInstance = ReturnType<MonacoModule['editor']['create']>;
type ExtraLibDisposable = { dispose: () => void };

/* Build Monaco theme color map from the current accent hex. All accent-derived
   slots use 8-digit hex (RRGGBBAA) so they update together when the accent
   changes; fixed warm-dark surface colors stay hardcoded. */
function buildMonacoThemeColors(accentHex: string): Record<string, string> {
  let r = 240, g = 179, b = 90; // honey fallback
  const clean = accentHex.replace('#', '');
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    r = parseInt(clean.slice(0, 2), 16);
    g = parseInt(clean.slice(2, 4), 16);
    b = parseInt(clean.slice(4, 6), 16);
  }
  const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  const a = (alpha: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}${hex2(alpha * 255)}`;
  const full = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return {
    'editor.background': '#0d0a0700',
    'editor.foreground': '#ffffff',
    'editorLineNumber.foreground': '#5c4a32',
    'editorLineNumber.activeForeground': full,
    'editor.selectionBackground': a(0.40),
    'editor.lineHighlightBackground': '#1a120c80',
    'editorCursor.foreground': full,
    'editorIndentGuide.background': '#2a1c1240',
    'editorIndentGuide.activeBackground': a(0.19),
    'editorBracketMatch.background': a(0.19),
    'editorBracketMatch.border': full,
    'editorStickyScroll.background': '#120c08f5',
    'editorStickyScrollHover.background': '#1d1410f8',
    'editor.findMatchBackground': a(0.31),
    'editor.findMatchHighlightBackground': a(0.13),
    'editor.findMatchBorder': a(0.60),
    'editor.findRangeHighlightBackground': a(0.06),
    'editorWidget.background': '#1a110a',
    'editorWidget.border': '#3d2a1a',
    'editorWidget.foreground': '#ffffff',
    'input.background': '#2a1c10',
    'input.border': '#3d2a1a',
    'input.foreground': '#ffffff',
    'inputOption.activeBorder': full,
    'inputOption.activeBackground': a(0.13),
  };
}

const TYPE_SCRIPT_FILE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const WORKSPACE_IMPORT_LIMIT = 80;
const PACKAGE_LIB_LIMIT = 180;
const LARGE_FILE_BYTES = 100_000;
const LANGUAGE_SERVERS_CONFIG_PATH = '.polypore/language-servers.json';
const FORMATTERS_CONFIG_PATH = '.polypore/formatters.json';
const TSCONFIG_PATH = 'tsconfig.json';

type EditorHost = BuiltinPluginProps['host'];
type FormatterSession = Awaited<ReturnType<EditorHost['terminal']['spawn']>>['session'];

type EditorIssue = {
  id: string;
  severity: Diagnostic['severity'];
  message: string;
  source: string;
  file: string;
  line: number;
  column: number;
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
};

type FormatterCommand = {
  id: string;
  label?: string;
  command: string;
  extensions?: string[];
  filenames?: string[];
};

type FormatterConfig = {
  formatters: FormatterCommand[];
};

export type ProjectLanguageServer = {
  id: string;
  extensions?: string[];
  filenames?: string[];
  languageIds?: Record<string, string>;
};

export type ProjectLanguageConfig = {
  servers: ProjectLanguageServer[];
};

export type { TypeScriptProjectConfig } from './ambient-types';

function severityToMarker(monaco: MonacoModule, severity: Diagnostic['severity']) {
  switch (severity) {
    case 'error':
      return monaco.MarkerSeverity.Error;
    case 'warn':
      return monaco.MarkerSeverity.Warning;
    case 'info':
      return monaco.MarkerSeverity.Info;
    case 'hint':
    default:
      return monaco.MarkerSeverity.Hint;
  }
}

function diagnosticMarkers(monaco: MonacoModule, diagnostics: Diagnostic[]) {
  return diagnostics.map((d) => ({
    message: d.message,
    severity: severityToMarker(monaco, d.severity),
    startLineNumber: (d.range?.start?.line ?? 0) + 1,
    startColumn: (d.range?.start?.column ?? 0) + 1,
    endLineNumber: (d.range?.end?.line ?? d.range?.start?.line ?? 0) + 1,
    endColumn: (d.range?.end?.column ?? (d.range?.start?.column ?? 0) + 1) + 1,
    source: d.source,
    code: d.code == null ? undefined : String(d.code),
  }));
}

/* Returns a match score ≥ 0 if every character in `query` appears in `text`
   in order (subsequence match), weighted by consecutive runs. Returns -1 on
   no match. Higher is better. */
function fuzzyScore(text: string, query: string): number {
  if (!query) return 0;
  let score = 0, qi = 0, consecutiveBonus = 0;
  for (let i = 0; i < text.length && qi < query.length; i++) {
    if (text[i] === query[qi]) {
      consecutiveBonus = i > 0 && text[i - 1] === query[qi - 1] ? consecutiveBonus + 2 : 0;
      score += 1 + consecutiveBonus;
      qi++;
    }
  }
  return qi === query.length ? score : -1;
}

function fullDocumentEdit(text: string): TextEdit {
  const lines = text.split('\n');
  return {
    range: {
      start: { line: 0, column: 0 },
      end: { line: Math.max(0, lines.length - 1), column: lines.at(-1)?.length ?? 0 },
    },
    newText: text,
  };
}


export function EditorPanel({ header, host }: BuiltinPluginProps) {
  perfPoint('editor:render');
  const [explorerWidth, onExplorerResize] = useResizableSplit({ axis: 'x', initial: 28, min: 18, max: 46 });
  const [activeFile, setActiveFile] = useState('');
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [quickOpen, setQuickOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const [newEntryKind, setNewEntryKind] = useState<'file' | 'folder'>('file');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; info: FileTreeContextInfo } | null>(null);
  const [query, setQuery] = useState('');
  const [tree, setTree] = useState<FileNode[]>([]);
  const [fileText, setFileText] = useState('');
  const [monacoReady, setMonacoReady] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [documentDiagnostics, setDocumentDiagnostics] = useState<Diagnostic[]>([]);
  const [languageConfig, setLanguageConfig] = useState<ProjectLanguageConfig>({ servers: [] });
  const [formatterConfig, setFormatterConfig] = useState<FormatterConfig>({ formatters: [] });
  const [typeScriptConfig, setTypeScriptConfig] = useState<TypeScriptProjectConfig>({ types: [] });
  const [selectedFormatterId, setSelectedFormatterId] = useState('');
  const [formattingFormatterId, setFormattingFormatterId] = useState('');
  const [monacoMarkers, setMonacoMarkers] = useState<EditorMarker[]>([]);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [savedText, setSavedText] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [fileActionError, setFileActionError] = useState('');
  const [cursor, setCursor] = useState<{ line: number; col: number }>({ line: 1, col: 1 });
  const [debugStatus, setDebugStatus] = useState<string>('');
  const [quickOpenIdx, setQuickOpenIdx] = useState(0);
  const [indentInfo, setIndentInfo] = useState<{ insertSpaces: boolean; tabSize: number } | null>(null);
  const [plusPopupOpen, setPlusPopupOpen] = useState(false);
  const [plusKind, setPlusKind] = useState<'folder' | 'file' | null>(null);
  const [plusName, setPlusName] = useState('');
  const [plusError, setPlusError] = useState('');
  const monacoHostRef = useRef<HTMLDivElement | null>(null);
  const monacoRef = useRef<MonacoModule | null>(null);
  const editorRef = useRef<MonacoEditorInstance | null>(null);
  const ownedModelUrisRef = useRef(new Set<string>());
  const editorReadCacheRef = useRef(new Map<string, Promise<string | null>>());
  const extraLibsRef = useRef(new Map<string, ExtraLibDisposable>());
  const hydrationRunRef = useRef(0);
  const registeredProjectLanguagesRef = useRef(new Set<string>());
  const documentDiagnosticsRunRef = useRef(0);
  const pendingIssueRef = useRef<EditorIssue | null>(null);
  const debugDecorationsRef = useRef<{ set: (d: unknown[]) => void; clear: () => void } | null>(null);
  const debugBreakpointsRef = useRef<DebugState['breakpoints']>([]);
  const activeFileRef = useRef<string | null>(null);
  const saveActiveFileRef = useRef<(() => Promise<void>) | null>(null);
  const viewStateMapRef = useRef(new Map<string, unknown>());
  const plusPopupRef = useRef<HTMLDivElement | null>(null);
  const plusBtnRef = useRef<HTMLButtonElement | null>(null);
  const plusRowRef = useRef<HTMLDivElement | null>(null);
  const [plusPos, setPlusPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!plusPopupOpen) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as Node;
      if (plusBtnRef.current?.contains(target)) return;
      if (plusPopupRef.current?.contains(target)) return;
      if (plusRowRef.current?.contains(target)) return;
      setPlusPopupOpen(false);
      setPlusKind(null);
      setPlusName('');
      setPlusError('');
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [plusPopupOpen]);

  useEffect(() => {
    /* defer past first paint — see scheduleAfterPaint comment. without
       the yield, this fires synchronously with all the other editor
       useEffects after commit and the panel can't paint until the
       chain drains. with it, the editor frame paints instantly and the
       file tree fills in on the next task. */
    let cancelled = false;
    const cancelSchedule = scheduleAfterPaint(() => {
      if (cancelled) return;
      perfPoint('editor:tree-effect-fires');
      host.editor.tree().then((result) => {
        if (cancelled || !result.tree) return;
        const nextTree = result.tree as FileNode[];
        setTree(nextTree);
        const nextFiles = flattenFiles(nextTree);
        setActiveFile((current) => {
          if (current && nextFiles.includes(current)) return current;
          if (nextFiles.length === 0) return '';
          const preferred = nextFiles.find((path) => path.toLowerCase().endsWith('readme.md')) ?? nextFiles[0];
          setOpenFiles([preferred]);
          return preferred;
        });
      }).catch(() => {
        setTree([]);
      });
    });
    return () => {
      cancelled = true;
      cancelSchedule();
    };
  }, [host]);

  useEffect(() => {
    let cancelled = false;
    host.editor.read(LANGUAGE_SERVERS_CONFIG_PATH).then((result) => {
      if (!cancelled) setLanguageConfig(normalizeProjectLanguageConfig(JSON.parse(result.content)));
    }).catch(() => {
      if (!cancelled) setLanguageConfig({ servers: [] });
    });
    return () => { cancelled = true; };
  }, [host]);

  useEffect(() => {
    let cancelled = false;
    host.editor.read(FORMATTERS_CONFIG_PATH).then((result) => {
      if (!cancelled) setFormatterConfig(normalizeFormatterConfig(JSON.parse(result.content)));
    }).catch(() => {
      if (!cancelled) setFormatterConfig({ formatters: [] });
    });
    return () => { cancelled = true; };
  }, [host]);

  useEffect(() => {
    let cancelled = false;
    host.editor.read(TSCONFIG_PATH).then((result) => {
      if (!cancelled) setTypeScriptConfig(normalizeTypeScriptProjectConfig(JSON.parse(result.content)));
    }).catch(() => {
      if (!cancelled) setTypeScriptConfig({ types: [] });
    });
    return () => { cancelled = true; };
  }, [host]);

  useEffect(() => {
    const runId = ++documentDiagnosticsRunRef.current;
    if (!activeFile || !monacoReady) {
      setDocumentDiagnostics([]);
      return undefined;
    }
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      host.diagnostics.document(activeFile, fileText).then((result) => {
        if (!cancelled && documentDiagnosticsRunRef.current === runId) {
          setDocumentDiagnostics(result.diagnostics.filter((diagnostic) => diagnostic.file === activeFile));
        }
      }).catch(() => {
        if (!cancelled && documentDiagnosticsRunRef.current === runId) setDocumentDiagnostics([]);
      });
    }, 650);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [activeFile, fileText, host, monacoReady]);
  const allFiles = useMemo(() => flattenFiles(tree), [tree]);
  const isDirty = activeFile !== '' && fileText !== savedText;
  const newEntryDir = newFilePath.includes('/') ? newFilePath.slice(0, newFilePath.lastIndexOf('/') + 1) : '';
  const diagnosticsByFile = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const item of diagnostics) {
      grouped.set(item.file, (grouped.get(item.file) ?? 0) + 1);
    }
    return grouped;
  }, [diagnostics]);
  const fileMeta = useCallback((path: string) => {
    const meta = inferredFileMeta(
      path,
      diagnosticsByFile.get(path) ?? 0,
      editorLanguageLabelForPath(monacoRef.current, path, languageConfig),
    );
    return { ...meta, dirty: path === activeFile ? isDirty : meta.dirty };
  }, [activeFile, diagnosticsByFile, isDirty, languageConfig, monacoReady]);
  const activeMeta = useMemo(() => fileMeta(activeFile), [activeFile, fileMeta]);
  const activeLines = useMemo(() => fileText.split('\n'), [fileText]);
  const activeDiagnostics = useMemo(
    () => diagnostics.filter((item) => item.file === activeFile),
    [activeFile, diagnostics],
  );
  const activeErrorCount = activeDiagnostics.filter((item) => item.severity === 'error').length;
  const activeWarningCount = activeDiagnostics.filter((item) => item.severity === 'warn').length;
  const activeDiagnosticLabel = activeDiagnostics.length === 0
    ? 'clean'
    : `${activeErrorCount} error${activeErrorCount === 1 ? '' : 's'} · ${activeWarningCount} warning${activeWarningCount === 1 ? '' : 's'}`;
  const monacoIssues = useMemo(
    () => monacoMarkers
      .filter(isActionableMonacoMarker)
      .map((marker, index) => markerToIssue(marker, activeFile, index)),
    [activeFile, monacoMarkers],
  );
  const hostIssues = useMemo(
    () => diagnostics.map(diagnosticToIssue),
    [diagnostics],
  );
  const editorIssues = useMemo(
    () => [
      ...(monacoIssues.length ? monacoIssues : hostIssues.filter((item) => item.file === activeFile)),
      ...hostIssues.filter((item) => item.file !== activeFile),
    ]
      .sort(compareEditorIssues),
    [activeFile, hostIssues, monacoIssues],
  );
  const activeProblemCount = Math.max(activeDiagnostics.length, monacoIssues.length);
  const activeProblemLabel = monacoIssues.length > activeDiagnostics.length
    ? `${activeProblemCount} problem${activeProblemCount === 1 ? '' : 's'}`
    : activeDiagnosticLabel;
  const editorProblemCount = editorIssues.length || diagnostics.length;
  const matchingFormatters = useMemo(
    () => activeFile ? formatterConfig.formatters.filter((formatter) => formatterMatchesPath(formatter, activeFile)) : [],
    [activeFile, formatterConfig],
  );
  const selectedFormatter = useMemo(
    () => matchingFormatters.find((formatter) => formatter.id === selectedFormatterId) ?? matchingFormatters[0] ?? null,
    [matchingFormatters, selectedFormatterId],
  );
  const filteredFiles = useMemo(() => {
    const normalizedQuery = query.toLowerCase();
    if (!normalizedQuery) return allFiles;
    return allFiles
      .map((path) => {
        const nameScore = fuzzyScore(fileMeta(path).name.toLowerCase(), normalizedQuery);
        const pathScore = fuzzyScore(path.toLowerCase(), normalizedQuery);
        return { path, score: Math.max(nameScore, pathScore) };
      })
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.path);
  }, [allFiles, fileMeta, query]);

  useEffect(() => {
    setSelectedFormatterId((current) => (
      matchingFormatters.some((formatter) => formatter.id === current)
        ? current
        : matchingFormatters[0]?.id ?? ''
    ));
  }, [matchingFormatters]);

  useEffect(() => { setQuickOpenIdx(0); }, [filteredFiles]);

  const openFile = (path: string, options?: { preserveStatus?: boolean }) => {
    setActiveFile(path);
    setOpenFiles((current) => (current.includes(path) ? current : [...current, path]));
    setQuickOpen(false);
    setQuery('');
    if (!options?.preserveStatus) setSaveStatus('');
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === 'p') {
        event.preventDefault();
        setQuickOpen(true);
        return;
      }
      if (key === 's') {
        event.preventDefault();
        void saveActiveFileRef.current?.();
        return;
      }
      /* Ctrl+F → Monaco find, Ctrl+H → Monaco find+replace.
         Tauri's WebKit would otherwise let the browser handle Ctrl+F (which
         does nothing useful in a sandboxed webview). We focus the editor first
         so Monaco's keybinding layer is active before we trigger the action. */
      if (key === 'f' || key === 'h') {
        const editor = editorRef.current;
        if (!editor) return;
        event.preventDefault();
        const e = editor as unknown as {
          focus(): void;
          getAction(id: string): { run(): void } | null;
        };
        e.focus();
        const actionId = key === 'h'
          ? 'editor.action.startFindReplaceAction'
          : 'actions.find';
        e.getAction(actionId)?.run();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!activeFile) {
      setFileText('');
      return undefined;
    }
    let cancelled = false;
    host.editor.read(activeFile).then((result) => {
      if (!cancelled) {
        setFileText(result.content);
        setSavedText(result.content);
      }
    }).catch(() => {
      if (!cancelled) {
        const fallback = activeMeta.lines?.join('\n') ?? '';
        setFileText(fallback);
        setSavedText(fallback);
      }
    });
    return () => { cancelled = true; };
  }, [activeFile, host]);

  useEffect(() => host.editor.onOpen((event) => {
    openFile(event.path);
  }), [host]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [contextMenu]);

  useEffect(() => {
    const hostEl = monacoHostRef.current;
    if (!hostEl || navigator.userAgent.toLowerCase().includes('jsdom')) return undefined;
    let disposed = false;
    let editor: MonacoEditorInstance | null = null;
    let markerDisposable: { dispose: () => void } | null = null;
    let themeObserver: MutationObserver | null = null;
    let monacoResizeObserver: ResizeObserver | null = null;

    /* importing the default 'monaco-editor' entry (rather than
       editor.api) pulls in the basic-languages registry, which is what
       actually wires up the monarch tokenizers for ts/tsx/js/css/html/
       json/md/rust/etc. without this the editor renders plain text with
       no colors. Vite bundles the workers below so Monaco validators can
       keep live diagnostics off the UI thread. */
    (window as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
      getWorker: (_workerId: string, label: string) => {
        if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker();
        if (label === 'json') return new JsonWorker();
        if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
        if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
        return new EditorWorker();
      },
    };
    /* editor.main is the "fat" entry that auto-registers every basic
       language contribution (ts/js/css/html/json/md/rust/python/yaml…)
       via monarch. editor.api alone — which we were importing before —
       loads the editor with zero language contributions, which is why
       opening a .tsx file rendered as flat plaintext. */
    perfPoint('editor:monaco-import-start');
    import('monaco-editor/esm/vs/editor/editor.main').then((monaco) => {
      perfPoint('editor:monaco-import-resolved');
      if (disposed || !monacoHostRef.current) return;
      /* glass editor theme — warm-dark surface with transparent background so
         the panel's frosted layer shows through. Accent colors are derived from
         the user's current settings so they update when the theme changes. */
      const applyTheme = () => {
        const accent = loadInterfaceSettings().accent;
        monaco.editor.defineTheme('polypore-warm', {
          base: 'vs-dark',
          inherit: true,
          rules: [],
          colors: buildMonacoThemeColors(accent),
        });
        monaco.editor.setTheme('polypore-warm');
      };
      applyTheme();
      /* watch :root inline style for changes — applyInterfaceSettings writes
         CSS vars there, so this fires whenever the user changes their accent. */
      themeObserver = new MutationObserver(applyTheme);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
      configureTypeScriptWorker(monaco);
      perfPoint('editor:monaco-create-start');
      editor = monaco.editor.create(monacoHostRef.current, {
        value: '',
        language: 'plaintext',
        theme: 'polypore-warm',
        minimap: { enabled: false },
        /* gutter space for agent/human breakpoint glyphs + the stop arrow
           rendered by the debug suite (see debug-decorations.ts). */
        glyphMargin: true,
        automaticLayout: false,
        /* match the site-wide --mono stack defined in src/App.css so file
           contents render in the same JetBrains Mono face as the rest of
           the UI (gutters, status bar, code fallback, etc.). */
        fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', 'SFMono-Regular', 'Cascadia Code', Consolas, monospace",
        fontSize: 13,
        /* 1.7 line-height matches the .code-gutter / fallback ratio so
           gutter numbers stay aligned with their lines and the editor
           breathes the same as surrounding mono text. */
        lineHeight: 22,
        fontLigatures: true,
        lineNumbersMinChars: 3,
        scrollBeyondLastLine: false,
        renderLineHighlight: 'gutter',
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        padding: { top: 12, bottom: 12 },
        hover: { above: false },
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: true, indentation: true },
      });
      monacoResizeObserver = new ResizeObserver(() => {
        /* skip during sash drags — Monaco's internal recompute is expensive
           in JavaScriptCore; snap once on release via the final observer tick. */
        if (document.body.dataset.dvResizing) return;
        requestAnimationFrame(() => editorRef.current?.layout());
      });
      monacoResizeObserver.observe(monacoHostRef.current);
      monacoRef.current = monaco;
      editorRef.current = editor;
      debugDecorationsRef.current = (editor as unknown as {
        createDecorationsCollection: () => { set(d: unknown[]): void; clear(): void };
      }).createDecorationsCollection();
      perfPoint('editor:monaco-create-done');
      setMonacoReady(true);
      const syncMarkers = () => {
        const model = editor?.getModel() as null | { uri: { toString(): string } };
        if (!model) {
          setMonacoMarkers([]);
          return;
        }
        setMonacoMarkers(monaco.editor.getModelMarkers({ resource: model.uri as never }) as EditorMarker[]);
      };
      editor?.onDidChangeModelContent(() => {
        if (editor) setFileText(editor.getValue());
      });
      markerDisposable = monaco.editor.onDidChangeMarkers((resources: readonly { toString(): string }[]) => {
        const model = editor?.getModel() as null | { uri: { toString(): string } };
        if (model && resources.some((resource) => resource.toString() === model.uri.toString())) {
          syncMarkers();
        }
      });
      syncMarkers();
      const cursorEditor = editor as unknown as {
        onDidChangeCursorPosition: (cb: (e: { position: { lineNumber: number; column: number } }) => void) => unknown;
      };
      cursorEditor.onDidChangeCursorPosition?.((event) => {
        setCursor({ line: event.position.lineNumber, col: event.position.column });
      });
      /* clicking the glyph margin toggles a human breakpoint — VS Code
         convention: glyph margin only, not line numbers. line-number clicks
         move the cursor in Monaco (unavoidable default), so we restrict to
         the glyph strip to avoid the off-by-one cursor jump. */
      const mt = (monaco.editor as unknown as { MouseTargetType?: Record<string, number> }).MouseTargetType;
      const glyphType = mt?.GUTTER_GLYPH_MARGIN ?? 2;
      const mouseEditor = editor as unknown as {
        onMouseDown?: (cb: (e: { target: { type: number; position?: { lineNumber: number } } }) => void) => unknown;
      };
      mouseEditor.onMouseDown?.((event) => {
        const t = event.target?.type;
        if (t !== glyphType) return;
        const line = event.target.position?.lineNumber;
        const file = activeFileRef.current;
        if (!line || !file) return;
        const action = nextBreakpointAction(debugBreakpointsRef.current, file, line);
        if (action === 'add') {
          void host.debug.addBreakpoint({ file, line, setBy: 'human' }).catch(() => {});
        } else {
          void host.debug.removeBreakpoint({ file, line }).catch(() => {});
        }
      });
    }).catch(() => setMonacoReady(false));

    return () => {
      disposed = true;
      markerDisposable?.dispose();
      themeObserver?.disconnect();
      monacoResizeObserver?.disconnect();
      debugDecorationsRef.current?.clear();
      debugDecorationsRef.current = null;
      editor?.dispose();
      for (const uri of ownedModelUrisRef.current) {
        monacoRef.current?.editor.getModel(monacoRef.current.Uri.parse(uri) as never)?.dispose();
      }
      ownedModelUrisRef.current.clear();
      for (const lib of extraLibsRef.current.values()) lib.dispose();
      extraLibsRef.current.clear();
      editorRef.current = null;
      monacoRef.current = null;
      setMonacoReady(false);
    };
  }, []);

  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco || !monacoReady) return;
    const existing = new Set(monaco.languages.getLanguages().map((language) => language.id));
    for (const language of projectLanguageDefinitions(languageConfig)) {
      if (existing.has(language.id) || registeredProjectLanguagesRef.current.has(language.id)) continue;
      monaco.languages.register(language);
      registeredProjectLanguagesRef.current.add(language.id);
    }
  }, [languageConfig, monacoReady]);

  /* Mirror tsconfig `compilerOptions.types` into Monaco's TS worker so the
     worker sees the same ambient packages tsc does. Runs per-file so test
     files automatically gain vitest/globals without polluting non-test files. */
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco || !monacoReady) return;
    const ts = (monaco.languages as unknown as {
      typescript?: {
        typescriptDefaults: {
          getCompilerOptions: () => Record<string, unknown>;
          setCompilerOptions: (options: Record<string, unknown>) => void;
        };
        javascriptDefaults: {
          getCompilerOptions: () => Record<string, unknown>;
          setCompilerOptions: (options: Record<string, unknown>) => void;
        };
      };
    }).typescript;
    if (!ts) return;
    const types = ambientTypeSpecifiersForPath(activeFile, typeScriptConfig.types);
    ts.typescriptDefaults.setCompilerOptions({ ...ts.typescriptDefaults.getCompilerOptions(), types });
    ts.javascriptDefaults.setCompilerOptions({ ...ts.javascriptDefaults.getCompilerOptions(), types });
  }, [activeFile, typeScriptConfig, monacoReady]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor || !activeFile) return;
    const model = getOrCreateWorkspaceModel(
      monaco,
      activeFile,
      '',
      ownedModelUrisRef.current,
    );
    if (editor.getModel()?.uri.toString() !== model.uri.toString()) {
      const prevUri = editor.getModel()?.uri.toString();
      const vs = (editor as unknown as { saveViewState(): unknown }).saveViewState();
      if (prevUri && vs) viewStateMapRef.current.set(prevUri, vs);
      editor.setModel(model);
      setMonacoMarkers(monaco.editor.getModelMarkers({ resource: model.uri as never }) as EditorMarker[]);
      const savedVs = viewStateMapRef.current.get(model.uri.toString());
      if (savedVs) (editor as unknown as { restoreViewState(vs: unknown): void }).restoreViewState(savedVs);
    }
    const opts = (model as unknown as { getOptions(): { insertSpaces: boolean; tabSize: number } }).getOptions();
    setIndentInfo({ insertSpaces: opts.insertSpaces, tabSize: opts.tabSize });
    /* ask monaco for the right language id rather than maintaining a
       hand-rolled whitelist. `editor.main` registers every basic-language
       contribution (~80 languages: go, java, ruby, php, sql, dockerfile,
       …) and each registration declares its file extensions, recognized
       filenames, and aliases. matching against that registry means any
       language monaco ships with gets highlighted automatically. */
    const target = editorLanguageForPath(monaco, activeFile, languageConfig);
    monaco.editor.setModelLanguage(model as never, target);
  }, [activeFile, languageConfig, monacoReady]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.getValue() === fileText) return;
    editor.setValue(fileText);
  }, [fileText, monacoReady]);

  /* debug suite gutter: render agent/human breakpoint glyphs and the current
     stop line from host `debug` state. no code view is rebuilt in the panel —
     the breakpoints and stop project straight into the open editor. */
  useEffect(() => {
    activeFileRef.current = activeFile;
    if (!monacoReady) return undefined;
    let cancelled = false;
    const apply = (debug: DebugState | null) => {
      debugBreakpointsRef.current = debug?.breakpoints ?? [];
      const s = debug?.status;
      setDebugStatus(s && s !== 'idle' ? s : '');
      const monaco = monacoRef.current;
      if (cancelled || !monaco || !activeFile) return;
      const GlyphMarginLane = (monaco.editor as unknown as { GlyphMarginLane?: { Center: number } }).GlyphMarginLane;
      const RangeCtor = (monaco as unknown as { Range: new (...args: number[]) => unknown }).Range;
      const decorations = buildDebugDecorations(debug, activeFile).map((decoration) => ({
        range: new RangeCtor(decoration.line, 1, decoration.line, 1),
        options: {
          description: 'polypore-debug',
          isWholeLine: Boolean(decoration.className),
          glyphMarginClassName: decoration.glyphMarginClassName ?? undefined,
          className: decoration.className ?? undefined,
          glyphMarginHoverMessage: decoration.hoverMessage ? { value: decoration.hoverMessage } : undefined,
          glyphMargin: GlyphMarginLane ? { position: GlyphMarginLane.Center } : undefined,
        },
      }));
      /* use createDecorationsCollection (Monaco 0.34+ non-deprecated path) so
         changes go through changeDecorations and are gated properly on the live
         model. falls back to a no-op if the collection hasn't been created yet. */
      debugDecorationsRef.current?.set(decorations);
    };
    host.debug.state().then((debug) => apply(debug)).catch(() => {});
    const unsubscribe = host.debug.onChange?.((debug) => apply(debug));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [host, activeFile, monacoReady]);

  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco || !activeFile || !isTypeScriptFamilyPath(activeFile)) return undefined;
    if (new TextEncoder().encode(fileText).length >= LARGE_FILE_BYTES) return undefined;
    const run = ++hydrationRunRef.current;
    const timeout = window.setTimeout(() => {
      void hydrateTypeScriptImports({
        monaco,
        read: (path) => readEditorText(host.editor.read, editorReadCacheRef.current, path),
        activeFile,
        activeText: fileText,
        ambientTypeSpecifiers: ambientTypeSpecifiersForPath(activeFile, typeScriptConfig.types),
        nodeModuleMirrorRoots: nodeModuleMirrorRootsForPath(activeFile, allFiles),
        workspaceFiles: allFiles,
        ownedModelUris: ownedModelUrisRef.current,
        extraLibs: extraLibsRef.current,
        cancelled: () => hydrationRunRef.current !== run,
      });
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [activeFile, allFiles, fileText, host, monacoReady, typeScriptConfig.types]);

  useEffect(() => {
    const issue = pendingIssueRef.current;
    if (!issue || issue.file !== activeFile || !monacoReady) return;
    pendingIssueRef.current = null;
    focusEditorIssue(issue);
  }, [activeFile, fileText, monacoReady]);

  /* project diagnostics — pull the host's current lighter list path or a
     previous explicit deep scan. active unsaved-buffer diagnostics arrive
     separately through diagnostics.document below. convert both streams
     to monaco markers so squiggles, hover-tooltips, and problems stay in
     sync. */
  const loadDiagnostics = useCallback(() => {
    let active = true;
    host.diagnostics.list().then((result) => {
      if (!active) return;
      setDiagnostics(result.diagnostics);
    }).catch(() => {});
    return () => { active = false; };
  }, [host]);

  useEffect(() => {
    /* same paint-yield rationale as the editor.tree effect above —
       diagnostics.list is the cold-path RPC with the heaviest sync
       setup (envelope validation + diagnosticsProvider's two tauri
       invokes), so deferring it is what most of the perceived "panel
       freezes for a sec" comes from. */
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const cancelSchedule = scheduleAfterPaint(() => {
      if (cancelled) return;
      host.diagnostics.list().then((result) => {
        if (!cancelled) setDiagnostics(result.diagnostics);
      }).catch(() => {});
      unsubscribe = host.diagnostics.onChange((event) => {
        if (!cancelled) setDiagnostics(event.diagnostics);
      });
    });
    return () => {
      cancelled = true;
      cancelSchedule();
      unsubscribe?.();
    };
  }, [host]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    const model = editor.getModel() as null | {
      uri: { toString(): string };
    };
    if (!model) return;
    const fileDiagnostics = diagnostics.filter((d) => d.file === activeFile);
    monaco.editor.setModelMarkers(model as never, 'polypore-lsp', diagnosticMarkers(monaco, fileDiagnostics));
  }, [diagnostics, activeFile, monacoReady]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!monaco || !model) return;
    const fileDiagnostics = documentDiagnostics.filter((d) => d.file === activeFile);
    monaco.editor.setModelMarkers(model as never, 'polypore-live-lsp', diagnosticMarkers(monaco, fileDiagnostics));
  }, [activeFile, documentDiagnostics, monacoReady]);

  const closeFile = (path: string) => {
    setOpenFiles((current) => {
      const next = current.filter((file) => file !== path);
      if (path === activeFile) setActiveFile(next[0] ?? '');
      return next;
    });
  };

  const saveActiveFile = async () => {
    if (!activeFile || !isDirty) return;
    setSaveStatus('saving...');
    try {
      await host.editor.applyEdit(activeFile, [fullDocumentEdit(fileText)]);
      setSavedText(fileText);
      setSaveStatus('saved');
      loadDiagnostics();
    } catch (err) {
      setSaveStatus(err instanceof Error ? err.message : 'save failed');
    }
  };
  saveActiveFileRef.current = saveActiveFile;

  const runFormatter = async () => {
    const formatter = selectedFormatter;
    const path = activeFile;
    if (!formatter || !path || formattingFormatterId) return;
    setFormattingFormatterId(formatter.id);
    setSaveStatus(`formatting ${activeMeta.name}...`);
    try {
      if (fileText !== savedText) {
        await host.editor.applyEdit(path, [fullDocumentEdit(fileText)]);
        setSavedText(fileText);
      }
      const command = formatCommandForFile(formatter.command, path);
      const spawned = await host.terminal.spawn(command);
      const exitCode = await waitForTerminalExit(host, spawned.session);
      const label = formatter.label ?? formatter.id;
      if (exitCode === 0) {
        try {
          const latest = await host.editor.read(path);
          if (activeFileRef.current === path) {
            setFileText(latest.content);
            setSavedText(latest.content);
          }
        } catch {
          /* the formatter may target generated files or the whole project. */
        }
        setSaveStatus(`${label} formatted`);
        loadDiagnostics();
      } else {
        setSaveStatus(`${label} exited ${exitCode ?? 'unknown'}`);
      }
    } catch (err) {
      setSaveStatus(err instanceof Error ? err.message : 'format failed');
    } finally {
      setFormattingFormatterId('');
    }
  };

  const createNewFile = async () => {
    const path = newFilePath.trim().replace(/^\/+/, '');
    if (!path) {
      setFileActionError('file path is required');
      return;
    }
    if (path.includes('..') || path.includes('\0')) {
      setFileActionError('file path must stay inside the project');
      return;
    }
    setFileActionError('');
    try {
      await host.editor.applyEdit(path, [fullDocumentEdit('')]);
      setNewFileOpen(false);
      setNewFilePath('');
      openFile(path, { preserveStatus: true });
      const result = await host.editor.tree();
      setTree(result.tree as FileNode[]);
      setSavedText('');
      setFileText('');
      setSaveStatus('created');
      loadDiagnostics();
    } catch (err) {
      setFileActionError(err instanceof Error ? err.message : 'could not create file');
    }
  };

  const openNewEntry = (kind: 'file' | 'folder', inDir?: string) => {
    /* only pre-fill when the caller supplies an explicit directory (context-menu
       actions). header buttons leave the path blank so the user gets a clean
       prompt instead of inheriting the active file's path. */
    const raw = inDir ?? '';
    const dir = raw && !raw.endsWith('/') ? `${raw}/` : raw;
    setNewEntryKind(kind);
    setNewFilePath(dir);
    setFileActionError('');
    setNewFileOpen(true);
    setContextMenu(null);
  };

  const createNewFolder = async () => {
    const path = newFilePath.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (!path) { setFileActionError('folder path is required'); return; }
    if (path.includes('..') || path.includes('\0')) { setFileActionError('path must stay inside the project'); return; }
    setFileActionError('');
    try {
      await host.fs.mkdir(path);
      setNewFileOpen(false);
      setNewFilePath('');
      const result = await host.editor.tree();
      setTree(result.tree as FileNode[]);
      setSaveStatus('folder created');
    } catch (err) {
      setFileActionError(err instanceof Error ? err.message : 'could not create folder');
    }
  };

  const createPlusEntry = async () => {
    if (!plusKind) return;
    const raw = plusName.trim().replace(/^\/+/, '');
    if (!raw) { setPlusError(`${plusKind === 'folder' ? 'folder' : 'file'} name is required`); return; }
    if (raw.includes('..') || raw.includes('\0')) { setPlusError('path must stay inside the project'); return; }
    setPlusError('');
    if (plusKind === 'folder') {
      const path = raw.replace(/\/+$/, '');
      try {
        await host.fs.mkdir(path);
        setPlusPopupOpen(false);
        setPlusName('');
        const result = await host.editor.tree();
        setTree(result.tree as FileNode[]);
        setSaveStatus('folder created');
      } catch (err) {
        setPlusError(err instanceof Error ? err.message : 'could not create folder');
      }
    } else {
      const path = raw;
      try {
        await host.editor.applyEdit(path, [fullDocumentEdit('')]);
        setPlusPopupOpen(false);
        setPlusName('');
        openFile(path, { preserveStatus: true });
        const result = await host.editor.tree();
        setTree(result.tree as FileNode[]);
        setSavedText('');
        setFileText('');
        setSaveStatus('created');
        loadDiagnostics();
      } catch (err) {
        setPlusError(err instanceof Error ? err.message : 'could not create file');
      }
    }
  };

  const deleteEntry = async (path: string, kind: 'file' | 'folder') => {
    setContextMenu(null);
    const { confirmed } = await host.ui.confirm(`delete "${path.split('/').pop()}"?`);
    if (!confirmed) return;
    try {
      await host.fs.delete(path);
      if (kind === 'file') {
        const next = openFiles.filter((f) => f !== path);
        setOpenFiles(next);
        if (activeFile === path) setActiveFile(next[0] ?? '');
      } else {
        const prefix = `${path}/`;
        const next = openFiles.filter((f) => f !== path && !f.startsWith(prefix));
        setOpenFiles(next);
        if (activeFile === path || activeFile.startsWith(prefix)) setActiveFile(next[0] ?? '');
      }
      const result = await host.editor.tree();
      setTree(result.tree as FileNode[]);
    } catch (err) {
      setSaveStatus(err instanceof Error ? err.message : 'delete failed');
    }
  };

  const startRename = async (path: string) => {
    setContextMenu(null);
    const name = path.split('/').pop() ?? path;
    const dir = path.slice(0, path.length - name.length);
    const { value } = await host.ui.inputBox({ prompt: `rename "${name}"`, value: name, placeholder: name });
    if (!value || value === name) return;
    const newPath = dir + value;
    const prefix = `${path}/`;
    try {
      await host.fs.rename(path, newPath);
      setOpenFiles((prev) => prev.map((f) => {
        if (f === path) return newPath;
        if (f.startsWith(prefix)) return `${newPath}/${f.slice(prefix.length)}`;
        return f;
      }));
      if (activeFile === path) setActiveFile(newPath);
      else if (activeFile.startsWith(prefix)) setActiveFile(`${newPath}/${activeFile.slice(prefix.length)}`);
      const result = await host.editor.tree();
      setTree(result.tree as FileNode[]);
    } catch (err) {
      setSaveStatus(err instanceof Error ? err.message : 'rename failed');
    }
  };

  const handleTreeContextMenu = (e: React.MouseEvent, info: FileTreeContextInfo) => {
    const menuWidth = 168;
    // folder: 5 items + 1 separator; file: 4 items + 1 separator
    const menuHeight = info.kind === 'folder' ? 160 : 132;
    const x = e.clientX + menuWidth > window.innerWidth ? e.clientX - menuWidth : e.clientX;
    const y = e.clientY + menuHeight > window.innerHeight ? e.clientY - menuHeight : e.clientY;
    setContextMenu({ x, y, info });
  };

  const focusEditorIssue = (issue: EditorIssue) => {
    const editor = editorRef.current as null | {
      focus: () => void;
      setPosition: (position: { lineNumber: number; column: number }) => void;
      setSelection: (range: EditorIssue['range']) => void;
      revealRangeNearTop: (range: EditorIssue['range']) => void;
    };
    if (!editor) return;
    editor.setSelection(issue.range);
    editor.setPosition({ lineNumber: issue.range.startLineNumber, column: issue.range.startColumn });
    editor.revealRangeNearTop(issue.range);
    editor.focus();
  };

  const openEditorIssue = (issue: EditorIssue) => {
    setIssuesOpen(false);
    if (issue.file === activeFile) {
      focusEditorIssue(issue);
      return;
    }
    pendingIssueRef.current = issue;
    openFile(issue.file, { preserveStatus: true });
  };

  return (
    <div className="code-shell">
      <PanelHeader {...header} className="panel-header--file">
        <span className="panel-header__title">editor</span>
        <span className="panel-header__sep" aria-hidden="true" />
        <span className="panel-header__meta panel-header__meta--path" title={activeFile}>{activeFile}</span>
        <span className="panel-header__meta panel-header__meta--state">{activeMeta.language} · {activeMeta.dirty ? 'modified' : 'saved'} · ln {cursor.line}:{cursor.col}</span>
      </PanelHeader>
      <div
        className="code-body"
        style={{ '--code-explorer-width': `${explorerWidth}%` } as React.CSSProperties}
      >
        <aside className="code-explorer nav-section" aria-label="select file">
          <header className="nav-section__head">
            <span className="folder-symbol" aria-hidden="true" />
            <strong className="nav-section__title">files</strong>
            <small className="nav-section__count">{allFiles.length}</small>
            <div className="nav-section__actions">
              <button
                ref={plusBtnRef}
                className={`nav-section__action${plusPopupOpen ? ' nav-section__action--open' : ''}`}
                title="new entry"
                aria-label="new entry"
                aria-expanded={plusPopupOpen}
                onClick={(e) => {
                  const nextOpen = !plusPopupOpen;
                  if (nextOpen) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setPlusPos({ top: rect.bottom + 4, left: rect.left });
                  }
                  setPlusPopupOpen(nextOpen);
                  setPlusKind(null);
                  setPlusName('');
                  setPlusError('');
                }}
              >+</button>
            </div>
          </header>
          <button className="nav-section__search" onClick={() => setQuickOpen(true)}>
            <span>search files...</span>
            <kbd>ctrl+p</kbd>
          </button>
          <nav className="nav-section__list">
            {plusPopupOpen && plusKind !== null && (
              <>
                <div ref={plusRowRef} className="new-entry-row">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="new-entry-row__icon" aria-hidden="true">
                    {plusKind === 'folder' ? (
                      <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l.532.531A1.5 1.5 0 0 0 9.032 3H13.5A1.5 1.5 0 0 1 15 4.5v8a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9Z" />
                    ) : (
                      <path d="M4 0h5.293A1 1 0 0 1 10 .293L13.707 4a1 1 0 0 1 .293.707V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2zm5.5 1.5v2a1 1 0 0 0 1 1h2l-3-3z" />
                    )}
                  </svg>
                  <input
                    className="new-entry-row__input"
                    value={plusName}
                    placeholder={plusKind === 'folder' ? 'folder-name' : 'filename.ts'}
                    autoFocus
                    onChange={(e) => setPlusName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { setPlusPopupOpen(false); setPlusKind(null); setPlusName(''); setPlusError(''); }
                      if (e.key === 'Enter') void createPlusEntry();
                    }}
                  />
                </div>
                {plusError && <p className="new-entry-row__error">{plusError}</p>}
              </>
            )}
            <FileTree
              nodes={tree}
              activePath={activeFile}
              onSelect={openFile}
              metaFor={(path) => {
                const m = fileMeta(path);
                return m ? { status: m.status, diagnostics: m.diagnostics } : undefined;
              }}
              onContextMenu={handleTreeContextMenu}
            />
          </nav>
        </aside>
        <ResizeHandle axis="x" label="resize file explorer and editor" onDrag={onExplorerResize} />
        <section className="editor-workbench">
          <div className="editor-tabs" role="tablist" aria-label="open files">
            {openFiles.length === 0 && <span className="editor-tab editor-tab--empty">no file open</span>}
            {openFiles.map((file) => {
              const meta = fileMeta(file);
              return (
                <div
                  key={file}
                  className={file === activeFile ? 'editor-tab editor-tab--active' : 'editor-tab'}
                  role="tab"
                  tabIndex={0}
                  aria-selected={file === activeFile}
                  aria-label={`${meta.name}${meta.dirty ? ' modified' : ''}`}
                  title={file}
                  onClick={() => setActiveFile(file)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    setActiveFile(file);
                  }}
                >
                  <span>{meta.name}</span>
                  {meta.dirty && <i aria-label="modified">m</i>}
                  <button
                    type="button"
                    className="editor-tab__close"
                    aria-label={`close ${meta.name}`}
                    onClick={(event) => { event.stopPropagation(); closeFile(file); }}
                  >
                    x
                  </button>
                </div>
              );
            })}
            <button className="editor-tab editor-tab--add" onClick={() => setQuickOpen(true)}>+</button>
          </div>
          <div className="editor-alert">
            <span>{saveStatus || (activeFile ? (activeProblemCount ? `${activeProblemLabel} in ${activeMeta.name}` : `no problems in ${activeMeta.name}`) : 'open a file from the workspace tree')}</span>
            <div className="editor-alert__actions">
              {matchingFormatters.length > 1 && (
                <select
                  aria-label="formatter command"
                  value={selectedFormatter?.id ?? ''}
                  onChange={(event) => setSelectedFormatterId(event.target.value)}
                >
                  {matchingFormatters.map((formatter) => (
                    <option key={formatter.id} value={formatter.id}>{formatter.label ?? formatter.id}</option>
                  ))}
                </select>
              )}
              {matchingFormatters.length > 0 && (
                <button
                  disabled={!selectedFormatter || Boolean(formattingFormatterId)}
                  onClick={() => void runFormatter()}
                >
                  format
                </button>
              )}
              <button disabled={!activeFile || !isDirty} onClick={saveActiveFile}>save</button>
            </div>
          </div>
          <div className="code-pane" aria-label={`editor for ${activeFile}`}>
            {editorProblemCount > 0 && (
              <button
                type="button"
                className="editor-diagnostic-badge editor-diagnostic-badge--active"
                title={`${editorProblemCount} problem${editorProblemCount === 1 ? '' : 's'} in the editor`}
                aria-label={`${issuesOpen ? 'close' : 'open'} editor problems, ${editorProblemCount} item${editorProblemCount === 1 ? '' : 's'}`}
                aria-expanded={issuesOpen}
                aria-haspopup="dialog"
                onClick={() => setIssuesOpen((current) => !current)}
              >
                {editorProblemCount}
              </button>
            )}
            {issuesOpen && editorProblemCount > 0 && (
              <section className="editor-diagnostic-menu" aria-label="editor problems">
                <header>
                  <strong>problems</strong>
                  <span>{editorProblemCount}</span>
                </header>
                <div className="editor-diagnostic-menu__list">
                  {editorIssues.map((issue) => (
                    <button
                      key={issue.id}
                      type="button"
                      className={`editor-diagnostic-item editor-diagnostic-item--${issue.severity}`}
                      onClick={() => openEditorIssue(issue)}
                    >
                      <b>{issue.severity}</b>
                      <span>{issue.message}</span>
                      <small>{issue.file}:{issue.line}:{issue.column}</small>
                    </button>
                  ))}
                </div>
              </section>
            )}
            <div ref={monacoHostRef} className="monaco-host" data-ready={monacoReady} />
            {!monacoReady && (
              <div className="code-fallback">
                <div className="code-gutter">
                  {activeLines.map((_, index) => <span key={index}>{index + 1}</span>)}
                </div>
                <pre>
                  {activeLines.map((line, index) => (
                    <span key={`${activeFile}-${index}`} className={activeMeta.diagnostics && index === 0 ? 'code-line code-line--diagnostic' : 'code-line'}>
                      {line || ' '}
                    </span>
                  ))}
                </pre>
                <div className="code-minimap" aria-hidden="true">
                  {activeLines.map((line, index) => <i key={index} style={{ width: `${Math.min(92, Math.max(24, line.length * 3))}%` }} />)}
                </div>
              </div>
            )}
          </div>
          <footer className="editor-status">
            <span>{activeMeta.language}</span>
            <span>utf-8</span>
            <span>{indentInfo ? `${indentInfo.insertSpaces ? 'spaces' : 'tabs'}: ${indentInfo.tabSize}` : 'spaces: 2'}</span>
            <span>{activeProblemLabel}</span>
            {debugStatus && (
              <span className={`editor-status__debug editor-status__debug--${debugStatus.replace('-', '')}`}>
                {`● ${debugStatus}`}
              </span>
            )}
          </footer>
        </section>
        {quickOpen && (
          <div className="quick-open" role="dialog" aria-label="quick open">
            <header>
              <strong>quick open</strong>
              <button onClick={() => setQuickOpen(false)}>close</button>
            </header>
            <input
              value={query}
              placeholder="type a file name"
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') { setQuickOpen(false); return; }
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setQuickOpenIdx((i) => Math.min(i + 1, filteredFiles.length - 1));
                  return;
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setQuickOpenIdx((i) => Math.max(i - 1, 0));
                  return;
                }
                if (event.key === 'Enter' && filteredFiles[quickOpenIdx]) openFile(filteredFiles[quickOpenIdx]);
              }}
            />
            <div className="quick-open__results">
              {filteredFiles.map((path, idx) => {
                const meta = fileMeta(path);
                const isSelected = idx === quickOpenIdx;
                return (
                  <button
                    key={path}
                    className={`quick-open__result${isSelected ? ' quick-open__result--selected' : ''}${path === activeFile ? ' quick-open__result--active' : ''}`}
                    aria-label={`${meta.name} ${path}${meta.status ? ` ${meta.status}` : ''}`}
                    aria-selected={isSelected}
                    onClick={() => openFile(path)}
                  >
                    <span>{meta.name}</span>
                    <small>{path}</small>
                    {meta.status && <i>{meta.status}</i>}
                    {meta.diagnostics && <i>!</i>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {plusPopupOpen && plusKind === null && plusPos && createPortal(
          <div
            ref={plusPopupRef}
            className="plus-dropdown"
            style={{ top: plusPos.top, left: plusPos.left }}
            role="menu"
          >
            <button
              type="button"
              className="plus-dropdown__item"
              role="menuitem"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setPlusPopupOpen(false); setPlusKind(null); }
                if (e.key === 'ArrowDown') { e.preventDefault(); (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus(); }
                if (e.key === 'ArrowUp') { e.preventDefault(); (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus(); }
              }}
              onClick={() => setPlusKind('folder')}
            >
              <svg className="plus-dropdown__icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l.532.531A1.5 1.5 0 0 0 9.032 3H13.5A1.5 1.5 0 0 1 15 4.5v8a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9Z" />
              </svg>
              new folder
            </button>
            <button
              type="button"
              className="plus-dropdown__item"
              role="menuitem"
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setPlusPopupOpen(false); setPlusKind(null); }
                if (e.key === 'ArrowDown') { e.preventDefault(); (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus(); }
                if (e.key === 'ArrowUp') { e.preventDefault(); (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus(); }
              }}
              onClick={() => setPlusKind('file')}
            >
              <svg className="plus-dropdown__icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M4 0h5.293A1 1 0 0 1 10 .293L13.707 4a1 1 0 0 1 .293.707V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2zm5.5 1.5v2a1 1 0 0 0 1 1h2l-3-3z" />
              </svg>
              new file
            </button>
          </div>,
          document.body,
        )}
        {newFileOpen && (
          <div className="entry-dialog" role="dialog" aria-label={newEntryKind === 'folder' ? 'new folder' : 'new file'}>
            <header className="entry-dialog__header">
              <strong className="entry-dialog__title">new {newEntryKind}</strong>
              <button type="button" className="entry-dialog__close" onClick={() => setNewFileOpen(false)}>close</button>
            </header>
            {newEntryDir && <small className="entry-dialog__context">in {newEntryDir}</small>}
            <input
              className="entry-dialog__input"
              value={newFilePath}
              placeholder={newEntryKind === 'folder' ? 'path/to/new-folder' : 'path/to/newfile.ts'}
              autoFocus
              ref={(el) => el && (el.selectionStart = el.selectionEnd = el.value.length)}
              onChange={(event) => setNewFilePath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setNewFileOpen(false);
                if (event.key === 'Enter') void (newEntryKind === 'folder' ? createNewFolder() : createNewFile());
              }}
            />
            {fileActionError && <p className="entry-dialog__error">{fileActionError}</p>}
            <div className="entry-dialog__actions">
              <button type="button" onClick={() => setNewFileOpen(false)}>cancel</button>
              <button
                type="button"
                className="entry-dialog__create"
                onClick={newEntryKind === 'folder' ? createNewFolder : createNewFile}
              >create {newEntryKind}</button>
            </div>
          </div>
        )}
        {contextMenu && createPortal(
          <div
            className="ctx-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            role="menu"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {contextMenu.info.kind === 'folder' && (
              <>
                <button className="ctx-menu__item" role="menuitem" onClick={() => openNewEntry('file', contextMenu.info.path)}>
                  <span className="ctx-menu__icon ctx-menu__icon--file" aria-hidden="true" />
                  new file
                </button>
                <button className="ctx-menu__item" role="menuitem" onClick={() => openNewEntry('folder', contextMenu.info.path)}>
                  <span className="ctx-menu__icon ctx-menu__icon--folder" aria-hidden="true" />
                  new folder
                </button>
                <div className="ctx-menu__sep" role="separator" />
                <button className="ctx-menu__item" role="menuitem" onClick={() => void startRename(contextMenu.info.path)}>
                  rename
                </button>
                <button className="ctx-menu__item ctx-menu__item--danger" role="menuitem" onClick={() => void deleteEntry(contextMenu.info.path, 'folder')}>
                  delete
                </button>
              </>
            )}
            {contextMenu.info.kind === 'file' && (
              <>
                <button className="ctx-menu__item" role="menuitem" onClick={() => openNewEntry('file', (contextMenu.info as Extract<FileTreeContextInfo, { kind: 'file' }>).folderPath)}>
                  <span className="ctx-menu__icon ctx-menu__icon--file" aria-hidden="true" />
                  new file here
                </button>
                <div className="ctx-menu__sep" role="separator" />
                <button className="ctx-menu__item" role="menuitem" onClick={() => void startRename(contextMenu.info.path)}>
                  rename
                </button>
                <button className="ctx-menu__item ctx-menu__item--danger" role="menuitem" onClick={() => void deleteEntry(contextMenu.info.path, 'file')}>
                  delete
                </button>
                <div className="ctx-menu__sep" role="separator" />
                <button className="ctx-menu__item" role="menuitem" onClick={() => { void navigator.clipboard.writeText(contextMenu.info.path); setContextMenu(null); }}>
                  copy path
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
      </div>
    </div>
  );
}

function flattenFiles(nodes: FileNode[]): string[] {
  return nodes.flatMap((node) => node.kind === 'file' ? [node.path] : flattenFiles(node.children));
}

function normalizeProjectLanguageConfig(value: unknown): ProjectLanguageConfig {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { servers?: unknown }).servers)) {
    return { servers: [] };
  }
  const servers = (value as { servers: unknown[] }).servers.flatMap((item): ProjectLanguageServer[] => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as {
      id?: unknown;
      extensions?: unknown;
      filenames?: unknown;
      languageIds?: unknown;
    };
    if (typeof raw.id !== 'string' || !raw.id.trim()) return [];
    const server: ProjectLanguageServer = {
      id: raw.id.trim(),
      extensions: normalizeStringList(raw.extensions).map(stripLeadingDot),
      filenames: normalizeStringList(raw.filenames),
      languageIds: normalizeStringRecord(raw.languageIds),
    };
    if (
      (server.extensions?.length ?? 0) === 0
      && (server.filenames?.length ?? 0) === 0
      && Object.keys(server.languageIds ?? {}).length === 0
    ) return [];
    return [server];
  });
  return { servers };
}

export {
  ambientTypeSpecifiersForPath,
  extraLibPathsForPath,
  isActionableMonacoMarker,
  nodeModuleMirrorRootsForPath,
  normalizeTypeScriptProjectConfig,
} from './ambient-types';

function normalizeFormatterConfig(value: unknown): FormatterConfig {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { formatters?: unknown }).formatters)) {
    return { formatters: [] };
  }
  const seen = new Set<string>();
  const formatters = (value as { formatters: unknown[] }).formatters.flatMap((item): FormatterCommand[] => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as {
      id?: unknown;
      label?: unknown;
      command?: unknown;
      extensions?: unknown;
      filenames?: unknown;
    };
    if (typeof raw.id !== 'string' || typeof raw.command !== 'string') return [];
    const id = raw.id.trim();
    const command = raw.command.trim();
    if (!id || !command || seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : id,
      command,
      extensions: normalizeStringList(raw.extensions).map(stripLeadingDot),
      filenames: normalizeStringList(raw.filenames),
    }];
  });
  return { formatters };
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .flatMap(([key, mapped]) => {
      if (!key.trim() || typeof mapped !== 'string' || !mapped.trim()) return [];
      return [[stripLeadingDot(key), mapped.trim()] as const];
    });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function stripLeadingDot(value: string): string {
  return value.replace(/^\.+/, '').toLowerCase();
}

function formatterMatchesPath(formatter: FormatterCommand, path: string): boolean {
  const extensions = new Set((formatter.extensions ?? []).map(stripLeadingDot).filter(Boolean));
  const filenames = new Set((formatter.filenames ?? []).filter(Boolean));
  if (extensions.size === 0 && filenames.size === 0) return true;
  const basename = path.split(/[\\/]/).pop() ?? path;
  const extension = stripLeadingDot(basename.includes('.') ? basename.split('.').pop() ?? '' : '');
  return (extension && extensions.has(extension)) || filenames.has(basename) || filenames.has(path);
}

function formatCommandForFile(command: string, path: string): string {
  const basename = path.split(/[\\/]/).pop() ?? path;
  const dir = path.includes('/') || path.includes('\\')
    ? path.replace(/[\\/][^\\/]*$/, '') || '.'
    : '.';
  const replacements: Record<string, string> = {
    file: path,
    path,
    basename,
    dir,
  };
  return command.replace(/\{(file|path|basename|dir)\}/g, (_match, key: string) => shellQuote(replacements[key] ?? ''));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function waitForTerminalExit(host: EditorHost, session: FormatterSession, timeoutMs = 120_000): Promise<number | null> {
  if (session.status === 'exited' || session.exitCode != null) return Promise.resolve(session.exitCode ?? null);
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined;
    let timer = 0;
    const finish = (exitCode: number | null) => {
      window.clearTimeout(timer);
      unsubscribe?.();
      resolve(exitCode);
    };
    timer = window.setTimeout(() => finish(null), timeoutMs);
    unsubscribe = host.terminal.onEvent((event) => {
      if (event.id !== session.id || event.kind !== 'exited') return;
      finish(event.exitCode ?? null);
    });
  });
}

function configureTypeScriptWorker(monaco: MonacoModule) {
  const ts = (monaco.languages as unknown as {
    typescript?: {
      typescriptDefaults: {
        setCompilerOptions: (options: Record<string, unknown>) => void;
        setDiagnosticsOptions: (options: Record<string, unknown>) => void;
        setEagerModelSync: (value: boolean) => void;
      };
      javascriptDefaults: {
        setCompilerOptions: (options: Record<string, unknown>) => void;
        setDiagnosticsOptions: (options: Record<string, unknown>) => void;
        setEagerModelSync: (value: boolean) => void;
      };
      JsxEmit: { ReactJSX: number };
      ModuleKind: { ESNext: number };
      ModuleResolutionKind: { Bundler?: number; NodeJs: number };
      ScriptTarget: { ESNext: number };
    };
  }).typescript;
  if (!ts) return;
  const compilerOptions = {
    allowJs: true,
    allowNonTsExtensions: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler ?? ts.ModuleResolutionKind.NodeJs,
    noEmit: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  };
  ts.typescriptDefaults.setCompilerOptions(compilerOptions);
  ts.javascriptDefaults.setCompilerOptions(compilerOptions);
  /* TS2307 "Cannot find module" is always a hydration artifact in Monaco's
     in-browser worker — it only knows types we manually feed it, so any
     unhydrated package looks missing until addExtraLib runs. Real missing-module
     errors are reported by the host's tsc --noEmit diagnostics instead. */
  const diagnosticsOptions = { diagnosticCodesToIgnore: [2307] };
  ts.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
  ts.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
  /* Hydration creates only the active import graph as Monaco models. Eagerly
     sync those models so TypeScript can resolve a sibling source file by URI. */
  ts.typescriptDefaults.setEagerModelSync(true);
  ts.javascriptDefaults.setEagerModelSync(true);
}

function workspaceUri(monaco: MonacoModule, path: string) {
  return monaco.Uri.file(`/${path.replace(/^\/+/, '')}`);
}

function getOrCreateWorkspaceModel(
  monaco: MonacoModule,
  path: string,
  value: string,
  ownedModelUris: Set<string>,
): MonacoEditorModel {
  const uri = workspaceUri(monaco, path);
  const existing = monaco.editor.getModel(uri as never) as MonacoEditorModel | null;
  if (existing) return existing;
  const model = monaco.editor.createModel(value, monacoLanguageForPath(monaco, path), uri as never) as MonacoEditorModel;
  ownedModelUris.add(uri.toString());
  return model;
}

async function readEditorText(
  read: (path: string) => Promise<{ content: string }>,
  cache: Map<string, Promise<string | null>>,
  path: string,
) {
  const normalized = normalizeEditorPath(path);
  const cached = cache.get(normalized);
  if (cached) return cached;
  const pending = read(normalized).then((result) => result.content).catch(() => null);
  cache.set(normalized, pending);
  return pending;
}

type TypeScriptHydration = {
  monaco: MonacoModule;
  read: (path: string) => Promise<string | null>;
  activeFile: string;
  activeText: string;
  ambientTypeSpecifiers: string[];
  nodeModuleMirrorRoots: string[];
  workspaceFiles: string[];
  ownedModelUris: Set<string>;
  extraLibs: Map<string, ExtraLibDisposable>;
  cancelled: () => boolean;
};

async function hydrateTypeScriptImports(input: TypeScriptHydration) {
  const workspaceFiles = new Set(input.workspaceFiles);
  const sourceQueue: Array<{ path: string; text: string }> = [{ path: input.activeFile, text: input.activeText }];
  const sourceSeen = new Set([input.activeFile]);
  const packageQueue = new Set<string>(input.ambientTypeSpecifiers);
  if (/\.[jt]sx$/.test(input.activeFile)) packageQueue.add('react/jsx-runtime');

  while (sourceQueue.length && sourceSeen.size <= WORKSPACE_IMPORT_LIMIT && !input.cancelled()) {
    const source = sourceQueue.shift();
    if (!source) break;
    for (const specifier of importSpecifiers(source.text)) {
      if (isBareImport(specifier)) {
        packageQueue.add(specifier);
        continue;
      }
      for (const dependency of resolveWorkspaceImportCandidates(source.path, specifier, workspaceFiles)) {
        if (sourceSeen.has(dependency)) continue;
        const text = await input.read(dependency);
        if (text == null || input.cancelled()) continue;
        const model = getOrCreateWorkspaceModel(input.monaco, dependency, text, input.ownedModelUris);
        if (model.getValue() !== text) model.setValue(text);
        sourceSeen.add(dependency);
        if (isTypeScriptFamilyPath(dependency)) sourceQueue.push({ path: dependency, text });
        break;
      }
    }
  }

  const packageState = { loaded: new Set<string>(), declarations: 0 };
  for (const specifier of packageQueue) {
    if (input.cancelled() || packageState.declarations >= PACKAGE_LIB_LIMIT) break;
    await hydratePackageImport(input, specifier, packageState);
  }
}

function importSpecifiers(text: string) {
  const imports = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) imports.add(match[1]);
    }
  }
  return imports;
}

function isBareImport(specifier: string) {
  return Boolean(specifier) && !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes('://');
}

function isTypeScriptFamilyPath(path: string) {
  return TYPE_SCRIPT_FILE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));
}

function resolveWorkspaceImportCandidates(from: string, specifier: string, workspaceFiles: Set<string>) {
  if (!specifier.startsWith('.')) return [];
  const path = normalizeEditorPath(`${dirname(from)}/${specifier.split(/[?#]/, 1)[0]}`);
  const candidates = [
    path,
    ...TYPE_SCRIPT_FILE_EXTENSIONS.map((extension) => `${path}${extension}`),
    `${path}.d.ts`,
    `${path}.json`,
    ...TYPE_SCRIPT_FILE_EXTENSIONS.map((extension) => `${path}/index${extension}`),
    `${path}/index.d.ts`,
    `${path}/index.json`,
  ];
  const visibleCandidates = candidates.filter((candidate) => workspaceFiles.has(candidate));
  return visibleCandidates.length ? visibleCandidates : candidates;
}

type PackageHydrationState = {
  loaded: Set<string>;
  declarations: number;
};

async function hydratePackageImport(
  input: TypeScriptHydration,
  specifier: string,
  state: PackageHydrationState,
) {
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
  if (!cleanSpecifier || state.loaded.has(cleanSpecifier) || input.cancelled()) return;
  state.loaded.add(cleanSpecifier);
  if (cleanSpecifier.startsWith('node:')) {
    await hydratePackageImport(input, '@types/node', state);
    return;
  }

  const requested = splitPackageImport(cleanSpecifier);
  const packageRoot = `node_modules/${requested.name}`;
  const packageJsonPath = `${packageRoot}/package.json`;
  const packageJsonText = await input.read(packageJsonPath);
  const packageJson = packageJsonText ? parsePackageJson(packageJsonText) : null;
  if (packageJsonText) addExtraLib(input, packageJsonPath, packageJsonText);

  let hydrated = false;
  for (const candidate of declarationEntryCandidates(packageRoot, requested.subpath, packageJson)) {
    hydrated = await hydrateDeclarationFile(input, candidate, state) || hydrated;
    if (hydrated || input.cancelled() || state.declarations >= PACKAGE_LIB_LIMIT) break;
  }
  if (hydrated || requested.name.startsWith('@types/')) return;

  const typePackage = typesPackageFor(requested.name);
  const typeSubpath = requested.subpath === '' ? '' : requested.subpath;
  await hydratePackageImport(input, `${typePackage}${typeSubpath ? `/${typeSubpath}` : ''}`, state);
}

async function hydrateDeclarationFile(
  input: TypeScriptHydration,
  entryPath: string,
  state: PackageHydrationState,
) {
  const queue = declarationPathCandidates(entryPath);
  let hydrated = false;

  while (queue.length && !input.cancelled() && state.declarations < PACKAGE_LIB_LIMIT) {
    const path = normalizeEditorPath(queue.shift() ?? '');
    if (!path || state.loaded.has(path)) continue;
    state.loaded.add(path);
    const libUris = extraLibPathsForPath(path, input.nodeModuleMirrorRoots)
      .map((libPath) => workspaceUri(input.monaco, libPath).toString());
    if (libUris.every((uri) => input.extraLibs.has(uri))) {
      hydrated = true;
      continue;
    }
    const text = await input.read(path);
    if (text == null) continue;
    hydrated = true;
    state.declarations += 1;
    addExtraLib(input, path, text);

    for (const specifier of importSpecifiers(text)) {
      if (isBareImport(specifier)) {
        await hydratePackageImport(input, specifier, state);
      } else if (specifier.startsWith('.')) {
        queue.push(...declarationPathCandidates(normalizeEditorPath(`${dirname(path)}/${specifier}`)));
      }
    }
    for (const referencePath of declarationReferencePaths(text)) {
      queue.push(...declarationPathCandidates(normalizeEditorPath(`${dirname(path)}/${referencePath}`)));
    }
    for (const referenceType of declarationReferenceTypes(text)) {
      await hydratePackageImport(input, referenceType, state);
    }
  }
  return hydrated;
}

function addExtraLib(input: TypeScriptHydration, path: string, content: string) {
  const ts = (input.monaco.languages as unknown as {
    typescript?: {
      typescriptDefaults: { addExtraLib: (text: string, filePath?: string) => ExtraLibDisposable };
      javascriptDefaults: { addExtraLib: (text: string, filePath?: string) => ExtraLibDisposable };
    };
  }).typescript;
  if (!ts) return;
  for (const libPath of extraLibPathsForPath(path, input.nodeModuleMirrorRoots)) {
    const uri = workspaceUri(input.monaco, libPath).toString();
    if (input.extraLibs.has(uri)) continue;
    const typescriptLib = ts.typescriptDefaults.addExtraLib(content, uri);
    const javascriptLib = ts.javascriptDefaults.addExtraLib(content, uri);
    input.extraLibs.set(uri, {
      dispose: () => {
        typescriptLib.dispose();
        javascriptLib.dispose();
      },
    });
  }
}

function splitPackageImport(specifier: string) {
  const parts = specifier.split('/');
  const packageParts = specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1);
  return {
    name: packageParts.join('/'),
    subpath: parts.slice(packageParts.length).join('/'),
  };
}

function typesPackageFor(packageName: string) {
  if (!packageName.startsWith('@')) return `@types/${packageName}`;
  const [scope, name] = packageName.slice(1).split('/');
  return `@types/${scope}__${name}`;
}

function declarationEntryCandidates(
  packageRoot: string,
  subpath: string,
  packageJson: Record<string, unknown> | null,
) {
  const entries = new Set<string>();
  if (!subpath) {
    addDeclarationEntry(entries, packageRoot, packageJson?.types);
    addDeclarationEntry(entries, packageRoot, packageJson?.typings);
  }
  const exportKey = subpath ? `./${subpath}` : '.';
  for (const entry of exportTypeEntries(packageJson?.exports, exportKey)) {
    addDeclarationEntry(entries, packageRoot, entry);
  }
  const base = subpath ? `${packageRoot}/${subpath}` : `${packageRoot}/index`;
  entries.add(`${base}.d.ts`);
  entries.add(`${base}.d.mts`);
  entries.add(`${base}.d.cts`);
  entries.add(`${base}/index.d.ts`);
  return [...entries];
}

function addDeclarationEntry(entries: Set<string>, packageRoot: string, value: unknown) {
  if (typeof value !== 'string') return;
  const path = value.replace(/^\.\//, '');
  entries.add(normalizeEditorPath(`${packageRoot}/${path}`));
}

function exportTypeEntries(exportsValue: unknown, key: string) {
  if (!exportsValue || typeof exportsValue !== 'object') return [] as string[];
  const exportsRecord = exportsValue as Record<string, unknown>;
  return collectTypeEntries(exportsRecord[key] ?? (key === '.' && !Object.keys(exportsRecord).some((name) => name.startsWith('.')) ? exportsValue : null));
}

function collectTypeEntries(value: unknown): string[] {
  if (typeof value === 'string') return value.endsWith('.d.ts') || value.endsWith('.d.mts') || value.endsWith('.d.cts') ? [value] : [];
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [
    ...collectTypeEntries(record.types),
    ...Object.entries(record)
      .filter(([key]) => key !== 'types')
      .flatMap(([, nested]) => collectTypeEntries(nested)),
  ];
}

function declarationPathCandidates(path: string) {
  if (/\.d\.[cm]?ts$/i.test(path)) return [path];
  const emittedPath = path.replace(/\.[cm]?jsx?$/i, '');
  return [
    `${path}.d.ts`,
    `${path}.d.mts`,
    `${path}.d.cts`,
    `${emittedPath}.d.ts`,
    `${emittedPath}.d.mts`,
    `${emittedPath}.d.cts`,
    `${path}/index.d.ts`,
  ];
}

function parsePackageJson(text: string) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function declarationReferencePaths(text: string) {
  return [...text.matchAll(/\/\/\/\s*<reference\s+path=['"]([^'"]+)['"]/g)]
    .flatMap((match) => match[1] ? [match[1]] : []);
}

function declarationReferenceTypes(text: string) {
  return [...text.matchAll(/\/\/\/\s*<reference\s+types=['"]([^'"]+)['"]/g)]
    .flatMap((match) => match[1] ? [match[1]] : []);
}

/* look up monaco's registered language id for a file path by querying the
   editor's own language registry. `monaco.languages.getLanguages()` returns
   every contribution registered by `editor.main` (the basic-languages
   bundle), each with the file extensions, recognized filenames (Dockerfile,
   Makefile, …), and aliases it claims. matching against that registry means
   we automatically pick up any language monaco ships with — no whitelist to
   keep in sync. falls back to plaintext if nothing claims the file. */
function monacoLanguageForPath(monaco: MonacoModule, path: string): string {
  if (!path) return 'plaintext';
  const filename = (path.split('/').pop() ?? '').toLowerCase();
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot) : '';
  const langs = (monaco as unknown as {
    languages: {
      getLanguages: () => Array<{
        id: string;
        extensions?: string[];
        filenames?: string[];
        aliases?: string[];
      }>;
    };
  }).languages.getLanguages();
  for (const lang of langs) {
    if (ext && lang.extensions?.some((e) => e.toLowerCase() === ext)) return lang.id;
    if (lang.filenames?.some((f) => f.toLowerCase() === filename)) return lang.id;
  }
  /* aliases/ids without dotted extensions (e.g. "Dockerfile.dev") — last
     ditch: check if the bare filename or trailing token matches a language
     id or alias. */
  const tail = dot >= 0 ? filename.slice(dot + 1) : filename;
  for (const lang of langs) {
    if (lang.id.toLowerCase() === tail) return lang.id;
    if (lang.aliases?.some((a) => a.toLowerCase() === tail)) return lang.id;
  }
  return 'plaintext';
}

function editorLanguageForPath(monaco: MonacoModule, path: string, projectConfig: ProjectLanguageConfig): string {
  return projectLanguageForPath(projectConfig, path) ?? monacoLanguageForPath(monaco, path);
}

function projectLanguageDefinitions(config: ProjectLanguageConfig) {
  const byId = new Map<string, { id: string; extensions: Set<string>; filenames: Set<string>; aliases: string[] }>();
  const ensure = (id: string) => {
    let current = byId.get(id);
    if (!current) {
      current = { id, extensions: new Set(), filenames: new Set(), aliases: [id] };
      byId.set(id, current);
    }
    return current;
  };
  for (const server of config.servers) {
    for (const extension of server.extensions ?? []) {
      const id = languageIdForKey(server, extension);
      if (id) ensure(id).extensions.add(`.${stripLeadingDot(extension)}`);
    }
    for (const filename of server.filenames ?? []) {
      const id = languageIdForKey(server, filename);
      if (id) ensure(id).filenames.add(filename);
    }
    for (const [key, id] of Object.entries(server.languageIds ?? {})) {
      const target = ensure(id);
      if (server.filenames?.some((filename) => filename.toLowerCase() === key.toLowerCase())) {
        target.filenames.add(key);
      } else {
        target.extensions.add(`.${stripLeadingDot(key)}`);
      }
    }
  }
  return [...byId.values()].map((language) => ({
    id: language.id,
    extensions: [...language.extensions],
    filenames: [...language.filenames],
    aliases: language.aliases,
  }));
}

export function projectLanguageForPath(config: ProjectLanguageConfig, path: string): string | null {
  if (!path) return null;
  const filename = path.split(/[\\/]/).pop() ?? path;
  const lowerFilename = filename.toLowerCase();
  const dot = lowerFilename.lastIndexOf('.');
  const ext = dot >= 0 ? stripLeadingDot(lowerFilename.slice(dot + 1)) : '';
  for (const server of config.servers) {
    const id = languageIdForKey(server, lowerFilename)
      ?? languageIdForKey(server, filename)
      ?? (ext ? languageIdForKey(server, ext) : null);
    if (id) return id;
  }
  return null;
}

function languageIdForKey(server: ProjectLanguageServer, key: string): string | null {
  const normalized = stripLeadingDot(key);
  const ids = server.languageIds ?? {};
  return ids[key] ?? ids[normalized] ?? ids[key.toLowerCase()] ?? ids[normalized.toLowerCase()] ?? null;
}

function editorLanguageLabelForPath(monaco: MonacoModule | null, path: string, projectConfig: ProjectLanguageConfig): string {
  const projectLanguage = projectLanguageForPath(projectConfig, path);
  if (projectLanguage) return projectLanguage;
  if (monaco) {
    const language = monacoLanguageForPath(monaco, path);
    if (language && language !== 'plaintext') return language;
  }
  return fallbackLanguageLabelForPath(path);
}

function fallbackLanguageLabelForPath(path: string): string {
  if (!path) return 'text';
  const filename = path.split('/').pop() ?? path;
  const lower = filename.toLowerCase();
  const filenameLanguage: Record<string, string> = {
    dockerfile: 'dockerfile',
    containerfile: 'dockerfile',
    makefile: 'makefile',
    gemfile: 'ruby',
    rakefile: 'ruby',
  };
  if (filenameLanguage[lower]) return filenameLanguage[lower];
  if (lower.startsWith('.env')) return 'env';
  const dot = lower.lastIndexOf('.');
  if (dot < 0 || dot === lower.length - 1) return 'text';
  return lower.slice(dot + 1);
}

function markerToIssue(marker: EditorMarker, file: string, index: number): EditorIssue {
  return {
    id: `monaco-${file}-${marker.source ?? ''}-${markerCode(marker.code)}-${marker.startLineNumber}-${marker.startColumn}-${index}`,
    severity: markerSeverity(marker.severity),
    source: marker.source ?? 'monaco',
    file,
    line: marker.startLineNumber,
    column: marker.startColumn,
    message: marker.message,
    range: {
      startLineNumber: marker.startLineNumber,
      startColumn: marker.startColumn,
      endLineNumber: marker.endLineNumber,
      endColumn: marker.endColumn,
    },
  };
}

function diagnosticToIssue(diagnostic: Diagnostic): EditorIssue {
  return {
    id: `host-${diagnostic.id}`,
    severity: diagnostic.severity,
    source: diagnostic.source,
    file: diagnostic.file,
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.column + 1,
    message: diagnostic.message,
    range: {
      startLineNumber: diagnostic.range.start.line + 1,
      startColumn: diagnostic.range.start.column + 1,
      endLineNumber: diagnostic.range.end.line + 1,
      endColumn: diagnostic.range.end.column + 1,
    },
  };
}

function issueSeverityRank(severity: Diagnostic['severity']) {
  if (severity === 'error') return 0;
  if (severity === 'warn') return 1;
  if (severity === 'info') return 2;
  return 3;
}

function compareEditorIssues(a: EditorIssue, b: EditorIssue) {
  return issueSeverityRank(a.severity) - issueSeverityRank(b.severity)
    || a.file.localeCompare(b.file)
    || a.line - b.line
    || a.column - b.column;
}

function inferredFileMeta(path: string, diagnostics: number, language: string) {
  const name = path.split('/').pop() || path;
  return {
    name,
    language,
    diagnostics: diagnostics || undefined,
    dirty: false,
    status: undefined as FileMeta['status'],
    lines: [''],
  };
}
