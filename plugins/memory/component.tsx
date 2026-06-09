import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BuiltinPluginProps } from '../shared';
import type { FileNode, FileTreeContextInfo } from '../shared';
import { PanelHeader, ResizeHandle, useResizableSplit } from '../shared';
import {
  AGENT_PANEL_SLOTS,
  type ChatContextStats,
  type ChatMessageSummary,
  type ChatSessionSummary,
  type ChatTarget,
  type ContextDoc,
  type ContextDocState,
  type ContextInventoryItem,
  type KnowledgeBase,
  type KnowledgeBasePreset,
  type KnowledgeBaseScope,
  type KnowledgeIndex,
  type KnowledgeNode,
  type MemoryContext,
  type TerminalContextStats,
  buildContextInventory,
  byteSize,
  flattenFiles,
  folderAncestors,
  folderPaths,
  chatContextStatsForTarget,
  chatPanelTitle,
  chatSessionMatchesTarget,
  chatTargetsFromDockview,
  chatTargetsFromState,
  defaultBaseId,
  defaultChatSessionId,
  estimateTokensFromText,
  formatBytes,
  formatContextSize,
  formatTokens,
  knowledgeTreeFromNodes,
  pathFromContextItem,
  readTerminalContextStats,
  reconcileChatTargets,
  resolveChatSession,
  sameChatContextStats,
  sameChatTargets,
  sameFileTrees,
  sameKnowledgeBases,
  sameStringMaps,
  sameTerminalContextStats,
  sameTerminalStatsRecord,
  sortKnowledgeBases,
  statsFromChatMessages,
} from './memoryUtils';

export type { ContextDocState, ContextDoc } from './memoryUtils';

const EMPTY_CONTEXT_ITEMS: string[] = [];
const EMPTY_CONTEXT_BY_CHAT: Record<string, string[]> = {};
const noopContextHandler = () => {};

const BASE_PRESETS: Array<{
  id: KnowledgeBasePreset;
  title: string;
  detail: string;
  scope: KnowledgeBaseScope;
  folders: string[];
}> = [
  {
    id: 'basic',
    title: 'basic wiki',
    detail: 'raw sources and ai-maintained wiki notes',
    scope: 'global',
    folders: ['raw', 'wiki'],
  },
  {
    id: 'blank',
    title: 'blank base',
    detail: 'one index file and room to grow',
    scope: 'project',
    folders: [],
  },
];

export function MemoryPanel({ header, host, context }: BuiltinPluginProps) {
  const [contextWidth, onContextResize] = useResizableSplit({ axis: 'x', initial: 24, min: 16, max: 42 });
  const [libraryWidth, onLibraryResize] = useResizableSplit({ axis: 'x', initial: 34, min: 24, max: 58 });
  const panelLabel = header.label === 'documents' ? 'documents' : 'memory';
  const memory = (context ?? {}) as Partial<MemoryContext>;
  const sharedContextItems = memory.contextItems ?? EMPTY_CONTEXT_ITEMS;
  const contextByChat = memory.contextByChat ?? EMPTY_CONTEXT_BY_CHAT;
  const contextDocsByChat = memory.contextDocsByChat;
  const onAddContext = memory.onAddContext ?? noopContextHandler;
  const onRemoveContext = memory.onRemoveContext ?? noopContextHandler;
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [selectedBaseId, setSelectedBaseId] = useState('');
  const [knowledgeTree, setKnowledgeTree] = useState<FileNode[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [selectedContent, setSelectedContent] = useState('');
  const [chatTargets, setChatTargets] = useState<ChatTarget[]>([]);
  const [selectedChatId, setSelectedChatId] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [dirty, setDirty] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [newNotePath, setNewNotePath] = useState('');
  const [memPlusOpen, setMemPlusOpen] = useState(false);
  const [memPlusKind, setMemPlusKind] = useState<'document' | 'folder' | null>(null);
  const [memPlusName, setMemPlusName] = useState('');
  const [memPlusError, setMemPlusError] = useState('');
  const [memCtxMenu, setMemCtxMenu] = useState<{ x: number; y: number; info: FileTreeContextInfo } | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupName, setSetupName] = useState('project memory');
  const [setupScope, setSetupScope] = useState<KnowledgeBaseScope>('project');
  const [setupPreset, setSetupPreset] = useState<KnowledgeBasePreset>('basic');
  const [setupFolders, setSetupFolders] = useState<string[]>(() => (
    BASE_PRESETS.find((preset) => preset.id === 'basic')?.folders ?? []
  ));
  const [setupFoldersTouched, setSetupFoldersTouched] = useState(false);
  const [setupFolderDraft, setSetupFolderDraft] = useState('');
  const [setupLocation, setSetupLocation] = useState('');
  const [setupLocationTouched, setSetupLocationTouched] = useState(false);
  const [editBaseId, setEditBaseId] = useState('');
  const [editName, setEditName] = useState('');
  const [editScope, setEditScope] = useState<KnowledgeBaseScope>('project');
  const [editConfirmingDelete, setEditConfirmingDelete] = useState(false);
  const [editFolderDraft, setEditFolderDraft] = useState('');
  const [editRenamingFolder, setEditRenamingFolder] = useState('');
  const [editRenameDraft, setEditRenameDraft] = useState('');
  const [editFolderConfirmingDelete, setEditFolderConfirmingDelete] = useState('');
  const [notice, setNotice] = useState('');
  const [baseLoading, setBaseLoading] = useState(true);
  const [allDocsContent, setAllDocsContent] = useState<Map<string, string>>(new Map());
  const [contextFileContent, setContextFileContent] = useState<Map<string, string>>(new Map());
  const [hostChatStats, setHostChatStats] = useState<ChatContextStats | null>(null);
  const [terminalContextStats, setTerminalContextStats] = useState<Record<string, TerminalContextStats>>({});
  const selectedBase = useMemo(
    () => knowledgeBases.find((base) => base.id === selectedBaseId),
    [knowledgeBases, selectedBaseId],
  );
  const knowledgePaths = flattenFiles(knowledgeTree);
  /* fall back to the active panel (or the first one) when selectedChatId
     hasn't caught up to the published agentPanels yet — a stale id mustn't
     make us silently strand context as "shared". */
  const selectedChat = chatTargets.find((target) => target.id === selectedChatId)
    ?? chatTargets.find((target) => target.active)
    ?? chatTargets[0];
  const contextItems = selectedChat
    ? contextByChat[selectedChat.id] ?? EMPTY_CONTEXT_ITEMS
    : sharedContextItems;
  const contextDocs = contextDocsByChat && selectedChat
    ? contextDocsByChat[selectedChat.id]
    : undefined;
  const contextInventory = useMemo(() => buildContextInventory({
    items: contextItems,
    docs: allDocsContent,
    cachedFiles: contextFileContent,
    selectedPath,
    selectedContent,
  }), [allDocsContent, contextFileContent, contextItems, selectedContent, selectedPath]);
  const contextDocItemKeys = useMemo(() => new Set(
    (contextDocs ?? []).map((doc) => doc.contextItem ?? `included: ${doc.path}`),
  ), [contextDocs]);
  const visibleContextInventory = useMemo(
    () => contextInventory.filter((entry) => !contextDocItemKeys.has(entry.item)),
    [contextDocItemKeys, contextInventory],
  );
  const queuedCount = visibleContextInventory.length
    + (contextDocs?.filter((doc) => doc.state === 'queued').length ?? 0);
  const chatContextStats = selectedChat
    ? chatContextStatsForTarget(selectedChat, hostChatStats, terminalContextStats[selectedChat.id])
    : null;
  const contextDocTokens = (contextDocs ?? []).reduce((sum, doc) => sum + doc.tokens, 0);
  const contextDocBytes = (contextDocs ?? []).reduce((sum, doc) => sum + doc.bytes, 0);
  const contextTokens = visibleContextInventory.reduce((sum, item) => sum + item.tokens, 0)
    + contextDocTokens
    + (chatContextStats?.tokens ?? 0);
  const contextBytes = visibleContextInventory.reduce((sum, item) => sum + item.bytes, 0)
    + contextDocBytes
    + (chatContextStats?.bytes ?? 0);
  const projectBases = knowledgeBases.filter((base) => base.scope === 'project');
  const globalBases = knowledgeBases.filter((base) => base.scope === 'global');
  const backlinks = (() => {
    if (!selectedPath) return [];
    const baseName = selectedPath.split('/').pop()?.replace(/\.md$/i, '') ?? '';
    const matches: string[] = [];
    allDocsContent.forEach((content, path) => {
      if (path === selectedPath) return;
      if (content.includes(`[[${baseName}]]`) || content.includes(`[[${selectedPath}]]`)) {
        matches.push(path);
      }
    });
    return matches;
  })();

  const memPlusRef = useRef<HTMLDivElement | null>(null);
  const memPlusBtnRef = useRef<HTMLButtonElement | null>(null);
  const memPlusRowRef = useRef<HTMLDivElement | null>(null);
  const [memPlusPos, setMemPlusPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!memPlusOpen) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as Node;
      if (memPlusBtnRef.current?.contains(target)) return;
      if (memPlusRef.current?.contains(target)) return;
      if (memPlusRowRef.current?.contains(target)) return;
      setMemPlusOpen(false);
      setMemPlusKind(null);
      setMemPlusName('');
      setMemPlusError('');
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [memPlusOpen]);

  const loadKnowledgeBases = async () => {
    const result = await host.knowledge.bases();
    const bases = result.bases as KnowledgeBase[];
    setKnowledgeBases((current) => (sameKnowledgeBases(current, bases) ? current : bases));
    setSelectedBaseId((current) => (
      bases.some((base) => base.id === current) ? current : defaultBaseId(bases)
    ));
    return bases;
  };

  const loadKnowledgeIndex = async (baseId: string): Promise<KnowledgeIndex> => {
    const result = await host.knowledge.list(baseId);
    const tree = knowledgeTreeFromNodes(result.nodes as KnowledgeNode[]);
    const docs = new Map<string, string>();
    await Promise.all(flattenFiles(tree).map((path) => host.knowledge.read(path, baseId)
      .then((read) => { docs.set(path, read.content); })
      .catch(() => {})));
    return { tree, docs };
  };

  const openSetup = () => {
    const initial = BASE_PRESETS.find((preset) => preset.id === 'basic') ?? BASE_PRESETS[0];
    setSetupName('project memory');
    setSetupPreset(initial.id);
    setSetupScope(initial.scope);
    setSetupFolders(initial.folders);
    setSetupFoldersTouched(false);
    setSetupFolderDraft('');
    setSetupLocation('');
    setSetupLocationTouched(false);
    setSetupOpen(true);
  };

  const selectPreset = (preset: KnowledgeBasePreset) => {
    const entry = BASE_PRESETS.find((candidate) => candidate.id === preset);
    setSetupPreset(preset);
    if (entry) setSetupScope(entry.scope);
    /* swapping presets resets the folder draft unless the user has already
       made edits — otherwise switching presets would silently clobber
       customizations they wanted to keep. */
    if (entry && !setupFoldersTouched) {
      setSetupFolders(entry.folders);
    }
  };

  const addSetupFolder = () => {
    const cleaned = setupFolderDraft.replace(/^\/+|\/+$/g, '').trim();
    if (!cleaned) return;
    if (setupFolders.includes(cleaned)) {
      setNotice(`${cleaned} is already in the list`);
      setSetupFolderDraft('');
      return;
    }
    setSetupFolders((current) => [...current, cleaned]);
    setSetupFoldersTouched(true);
    setSetupFolderDraft('');
  };

  const removeSetupFolder = (folder: string) => {
    setSetupFolders((current) => current.filter((entry) => entry !== folder));
    setSetupFoldersTouched(true);
  };

  const refreshKnowledge = async (baseId = selectedBaseId) => {
    if (!baseId) {
      setKnowledgeTree((current) => (current.length === 0 ? current : []));
      setAllDocsContent((current) => (current.size === 0 ? current : new Map()));
      setSelectedPath((current) => (current === '' ? current : ''));
      return [];
    }
    const index = await loadKnowledgeIndex(baseId);
    setKnowledgeTree((current) => (sameFileTrees(current, index.tree) ? current : index.tree));
    setAllDocsContent((current) => (sameStringMaps(current, index.docs) ? current : index.docs));
    const paths = flattenFiles(index.tree);
    setSelectedPath((current) => (paths.includes(current) ? current : paths[0] || ''));
    return index.tree;
  };

  useEffect(() => {
    if (!memCtxMenu) return;
    const close = () => setMemCtxMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [memCtxMenu]);

  useEffect(() => {
    let cancelled = false;
    setBaseLoading(true);
    host.knowledge.bases().then((result) => {
      if (cancelled) return;
      const bases = result.bases as KnowledgeBase[];
      setKnowledgeBases((current) => (sameKnowledgeBases(current, bases) ? current : bases));
      setSelectedBaseId((current) => (
        bases.some((base) => base.id === current) ? current : defaultBaseId(bases)
      ));
      if (bases.length === 0) {
        setKnowledgeTree((current) => (current.length === 0 ? current : []));
        setAllDocsContent((current) => (current.size === 0 ? current : new Map()));
        setSelectedPath((current) => (current === '' ? current : ''));
      }
    }).catch((err) => {
      if (cancelled) return;
      setKnowledgeBases((current) => (current.length === 0 ? current : []));
      setKnowledgeTree((current) => (current.length === 0 ? current : []));
      setSelectedPath((current) => (current === '' ? current : ''));
      setNotice(err instanceof Error ? err.message : 'could not load memory');
    }).finally(() => {
      if (!cancelled) setBaseLoading(false);
    });
    return () => { cancelled = true; };
  }, [host]);

  useEffect(() => {
    if (!selectedBaseId) {
      setKnowledgeTree((current) => (current.length === 0 ? current : []));
      setAllDocsContent((current) => (current.size === 0 ? current : new Map()));
      setSelectedPath((current) => (current === '' ? current : ''));
      return undefined;
    }
    let cancelled = false;
    loadKnowledgeIndex(selectedBaseId).then((index) => {
      if (cancelled) return;
      setKnowledgeTree((current) => (sameFileTrees(current, index.tree) ? current : index.tree));
      setAllDocsContent((current) => (sameStringMaps(current, index.docs) ? current : index.docs));
      const paths = flattenFiles(index.tree);
      setSelectedPath((current) => (paths.includes(current) ? current : paths[0] || ''));
    }).catch((err) => {
      if (cancelled) return;
      setKnowledgeTree((current) => (current.length === 0 ? current : []));
      setAllDocsContent((current) => (current.size === 0 ? current : new Map()));
      setSelectedPath((current) => (current === '' ? current : ''));
      setNotice(err instanceof Error ? err.message : 'could not load memory');
    });
    return () => { cancelled = true; };
    /* selectedBaseId is the base boundary; explicit mutations call refreshKnowledge. */
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [host, selectedBaseId]);

  useEffect(() => {
    let cancelled = false;
    const syncTargets = (value: unknown) => {
      if (cancelled) return;
      const stateTargets = chatTargetsFromState(value);
      const panelTargets = chatTargetsFromDockview();
      const targets = reconcileChatTargets(stateTargets, panelTargets);
      setChatTargets((current) => (sameChatTargets(current, targets) ? current : targets));
      setSelectedChatId((current) => (
        targets.some((target) => target.id === current)
          ? current
          : targets.find((target) => target.active)?.id ?? targets[0]?.id ?? ''
      ));
    };
    host.state.get('agentPanels')
      .then((result) => syncTargets(result.value))
      .catch(() => syncTargets([]));
    const unsubscribe = host.state.subscribe('agentPanels', syncTargets);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [host]);

  useEffect(() => {
    const syncFromGlobal = () => {
      const next = readTerminalContextStats();
      setTerminalContextStats((current) => (
        sameTerminalStatsRecord(current, next) ? current : next
      ));
    };
    syncFromGlobal();
    const onStats = (event: Event) => {
      const detail = (event as CustomEvent<TerminalContextStats>).detail;
      if (!detail?.panelId) {
        syncFromGlobal();
        return;
      }
      setTerminalContextStats((current) => {
        if (detail.removed && !current[detail.panelId]) return current;
        if (!detail.removed && sameTerminalContextStats(current[detail.panelId], detail)) {
          return current;
        }
        const next = { ...current };
        if (detail.removed) delete next[detail.panelId];
        else next[detail.panelId] = detail;
        return next;
      });
    };
    window.addEventListener('polypore:terminal-context-stats', onStats as EventListener);
    return () => {
      window.removeEventListener('polypore:terminal-context-stats', onStats as EventListener);
    };
  }, []);

  useEffect(() => {
    const paths = [...new Set(contextItems.map(pathFromContextItem).filter(Boolean))];
    if (paths.length === 0) {
      setContextFileContent((current) => (current.size === 0 ? current : new Map()));
      return undefined;
    }
    let cancelled = false;
    const sync = async () => {
      const entries = await Promise.all(paths.map(async (path): Promise<[string, string] | null> => {
        if (allDocsContent.has(path)) return [path, allDocsContent.get(path) ?? ''];
        const content = await readContextFileContent(host, path, knowledgeBases);
        return content === null ? null : [path, content];
      }));
      if (cancelled) return;
      const next = new Map(entries.filter((entry): entry is [string, string] => entry !== null));
      setContextFileContent((current) => (sameStringMaps(current, next) ? current : next));
    };
    void sync();
    return () => {
      cancelled = true;
    };
  }, [allDocsContent, contextItems, host, knowledgeBases]);

  useEffect(() => {
    if (!selectedChat) {
      setHostChatStats(null);
      return undefined;
    }
    let cancelled = false;
    const sync = async () => {
      const stats = await readHostChatContextStats(host, selectedChat);
      if (!cancelled) {
        setHostChatStats((current) => (sameChatContextStats(current, stats) ? current : stats));
      }
    };
    void sync();
    const unsubscribe = host.chat.onMessage((event) => {
      if (chatSessionMatchesTarget(event.sessionId, selectedChat)) void sync();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [host, selectedChat?.agent, selectedChat?.id, selectedChat?.title]);

  useEffect(() => {
    if (!setupOpen || setupLocationTouched) return undefined;
    let cancelled = false;
    host.knowledge.suggestBaseLocation({
      name: setupName.trim() || 'memory',
      scope: setupScope,
    }).then((result) => {
      if (!cancelled) setSetupLocation(result.location);
    }).catch(() => {
      if (!cancelled) setSetupLocation('');
    });
    return () => { cancelled = true; };
  }, [host, setupOpen, setupName, setupScope, setupLocationTouched]);

  const openFolder = async () => {
    try {
      setNotice('opening folder');
      const result = await host.knowledge.openFolder();
      if (!result.base) {
        setNotice('no folder selected');
        return;
      }
      await loadKnowledgeBases();
      setSelectedBaseId(result.base.id);
      setNotice(`opened ${result.base.name}`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'could not open folder');
    }
  };

  const createBase = async () => {
    const name = setupName.trim();
    const root = setupLocation.trim();
    if (!name) {
      setNotice('memory base name is required');
      return;
    }
    try {
      const result = await host.knowledge.createBase({
        name,
        scope: setupScope,
        preset: setupPreset,
        root: root || undefined,
        folders: setupFolders,
      });
      await loadKnowledgeBases();
      setSelectedBaseId(result.base.id);
      setSetupOpen(false);
      setNotice(`created ${result.base.name}`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'could not create memory base');
    }
  };

  const chooseSetupLocation = async () => {
    try {
      setNotice('choosing memory folder');
      const result = await host.knowledge.pickBaseLocation();
      if (!result.location) {
        setNotice('no folder selected');
        return;
      }
      setSetupLocation(result.location);
      setSetupLocationTouched(true);
      if (result.scope) setSetupScope(result.scope);
      setNotice(`folder ${result.scope ?? setupScope}`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'could not choose memory folder');
    }
  };

  const openEditBase = (base: KnowledgeBase) => {
    setEditBaseId(base.id);
    setEditName(base.name);
    setEditScope(base.scope);
    setEditConfirmingDelete(false);
    setEditFolderDraft('');
    setEditRenamingFolder('');
    setEditRenameDraft('');
    setEditFolderConfirmingDelete('');
  };

  const closeEditBase = () => {
    setEditBaseId('');
    setEditConfirmingDelete(false);
    setEditFolderDraft('');
    setEditRenamingFolder('');
    setEditRenameDraft('');
    setEditFolderConfirmingDelete('');
  };

  const editingBase = knowledgeBases.find((base) => base.id === editBaseId);

  const saveEditBase = async () => {
    if (!editingBase) return;
    const trimmed = editName.trim();
    if (!trimmed) {
      setNotice('memory base name is required');
      return;
    }
    try {
      let next = editingBase;
      if (trimmed !== editingBase.name) {
        const renamed = await host.knowledge.renameBase(editingBase.id, trimmed);
        next = renamed.base as KnowledgeBase;
      }
      if (editScope !== editingBase.scope) {
        const scoped = await host.knowledge.setBaseScope(editingBase.id, editScope);
        next = scoped.base as KnowledgeBase;
      }
      setKnowledgeBases((current) => (
        sortKnowledgeBases(current.map((item) => (item.id === next.id ? next : item)))
      ));
      setNotice(`updated ${next.name}`);
      closeEditBase();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'could not update memory base');
    }
  };

  const editFolders = editingBase
    ? knowledgeTree
        .filter((node): node is Extract<FileNode, { kind: 'folder' }> => node.kind === 'folder')
        .map((node) => node.name)
    : [];

  const addEditFolder = async () => {
    if (!editingBase) return;
    const cleaned = editFolderDraft.replace(/^\/+|\/+$/g, '').trim();
    if (!cleaned) return;
    if (editFolders.includes(cleaned)) {
      setNotice(`${cleaned} already exists`);
      return;
    }
    try {
      await host.knowledge.createFolder(cleaned, editingBase.id);
      setEditFolderDraft('');
      await refreshKnowledge(editingBase.id);
      setNotice(`added ${cleaned}/`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'could not add folder');
    }
  };

  const startRenameFolder = (folder: string) => {
    setEditRenamingFolder(folder);
    setEditRenameDraft(folder);
    setEditFolderConfirmingDelete('');
  };

  const commitRenameFolder = async () => {
    if (!editingBase || !editRenamingFolder) return;
    const next = editRenameDraft.replace(/^\/+|\/+$/g, '').trim();
    if (!next) {
      setNotice('folder name is required');
      return;
    }
    if (next === editRenamingFolder) {
      setEditRenamingFolder('');
      return;
    }
    if (editFolders.includes(next)) {
      setNotice(`${next} already exists`);
      return;
    }
    try {
      await host.knowledge.renameFolder(editRenamingFolder, next, editingBase.id);
      setEditRenamingFolder('');
      setEditRenameDraft('');
      await refreshKnowledge(editingBase.id);
      setNotice(`renamed to ${next}/`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'could not rename folder');
    }
  };

  const removeEditFolder = async (folder: string) => {
    if (!editingBase) return;
    try {
      await host.knowledge.deleteFolder(folder, editingBase.id);
      setEditFolderConfirmingDelete('');
      await refreshKnowledge(editingBase.id);
      setNotice(`removed ${folder}/`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'could not remove folder');
    }
  };

  const deleteEditBase = async () => {
    if (!editingBase) return;
    try {
      await host.knowledge.deleteBase(editingBase.id);
      setKnowledgeBases((current) => current.filter((item) => item.id !== editingBase.id));
      setSelectedBaseId((current) => (current === editingBase.id ? '' : current));
      setNotice(`deleted ${editingBase.name}`);
      closeEditBase();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'could not delete memory base');
    }
  };

  const createNote = async () => {
    const path = newNotePath.trim().replace(/^\/+/, '');
    if (!selectedBase) {
      setNotice('choose a memory base first');
      return;
    }
    if (!path) {
      setNotice('document path is required');
      return;
    }
    if (path.includes('..') || path.includes('\0')) {
      setNotice('document path must stay inside its base');
      return;
    }
    const finalPath = path.endsWith('.md') ? path : `${path}.md`;
    const title = finalPath.split('/').pop()?.replace(/\.md$/i, '') || 'document';
    try {
      await host.knowledge.write(finalPath, `# ${title}\n\n`, selectedBase.id);
      setSelectedPath(finalPath);
      setSelectedContent(`# ${title}\n\n`);
      setShowPreview(false);
      setDirty(false);
      await refreshKnowledge(selectedBase.id);
      setNewNoteOpen(false);
      setNewNotePath('');
      setNotice('created');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'could not create document');
    }
  };

  const handleMemCtxMenu = (e: React.MouseEvent, info: FileTreeContextInfo) => {
    const menuWidth = 168;
    // folder: 4 items + 1 separator; file: 2 items + 1 separator
    const menuHeight = info.kind === 'folder' ? 132 : 80;
    const x = e.clientX + menuWidth > window.innerWidth ? e.clientX - menuWidth : e.clientX;
    const y = e.clientY + menuHeight > window.innerHeight ? e.clientY - menuHeight : e.clientY;
    setMemCtxMenu({ x, y, info });
  };

  const memCtxNewDoc = (folderPath: string) => {
    setMemCtxMenu(null);
    const dir = folderPath ? `${folderPath}/` : '';
    setNewNotePath(dir);
    setNewNoteOpen(true);
  };

  const memCtxRenameFolder = async (folderPath: string) => {
    setMemCtxMenu(null);
    if (!selectedBase) return;
    const name = folderPath.split('/').pop() ?? folderPath;
    const dir = folderPath.slice(0, folderPath.length - name.length);
    const { value } = await host.ui.inputBox({ prompt: `rename folder "${name}"`, value: name, placeholder: name });
    if (!value || value === name) return;
    try {
      await host.knowledge.renameFolder(folderPath, dir + value, selectedBase.id);
      await refreshKnowledge(selectedBase.id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'rename failed');
    }
  };

  const memCtxNewFolder = async (parentPath: string) => {
    setMemCtxMenu(null);
    if (!selectedBase) return;
    const { value } = await host.ui.inputBox({ prompt: 'new folder name', placeholder: 'folder-name' });
    if (!value) return;
    const fullPath = parentPath ? `${parentPath}/${value}` : value;
    try {
      await host.knowledge.createFolder(fullPath, selectedBase.id);
      await refreshKnowledge(selectedBase.id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'could not create folder');
    }
  };

  const createMemPlusEntry = async () => {
    if (!selectedBase || !memPlusKind) return;
    const raw = memPlusName.trim().replace(/^\/+/, '');
    if (!raw) { setMemPlusError(`${memPlusKind} name is required`); return; }
    if (raw.includes('..') || raw.includes('\0')) { setMemPlusError('path must stay inside the base'); return; }
    setMemPlusError('');
    if (memPlusKind === 'folder') {
      const path = raw.replace(/\/+$/, '');
      try {
        await host.knowledge.createFolder(path, selectedBase.id);
        await refreshKnowledge(selectedBase.id);
        setMemPlusOpen(false);
        setMemPlusName('');
      } catch (err) {
        setMemPlusError(err instanceof Error ? err.message : 'could not create folder');
      }
    } else {
      const finalPath = raw.endsWith('.md') ? raw : `${raw}.md`;
      const title = finalPath.split('/').pop()?.replace(/\.md$/i, '') || 'document';
      try {
        await host.knowledge.write(finalPath, `# ${title}\n\n`, selectedBase.id);
        setSelectedPath(finalPath);
        setSelectedContent(`# ${title}\n\n`);
        setShowPreview(false);
        setDirty(false);
        await refreshKnowledge(selectedBase.id);
        setMemPlusOpen(false);
        setMemPlusName('');
        setNotice('created');
      } catch (err) {
        setMemPlusError(err instanceof Error ? err.message : 'could not create document');
      }
    }
  };

  const memCtxDeleteFolder = async (folderPath: string) => {
    setMemCtxMenu(null);
    if (!selectedBase) return;
    const { confirmed } = await host.ui.confirm(`delete folder "${folderPath.split('/').pop()}" and all its documents?`);
    if (!confirmed) return;
    try {
      await host.knowledge.deleteFolder(folderPath, selectedBase.id);
      await refreshKnowledge(selectedBase.id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'delete failed');
    }
  };

  const memCtxDeleteDoc = async (path: string) => {
    setMemCtxMenu(null);
    if (!selectedBase) return;
    const { confirmed } = await host.ui.confirm(`delete "${path.split('/').pop()}"?`);
    if (!confirmed) return;
    try {
      await host.knowledge.deleteDoc(path, selectedBase.id);
      if (selectedPath === path) setSelectedPath('');
      await refreshKnowledge(selectedBase.id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'delete failed');
    }
  };

  const saveNote = async () => {
    if (!selectedPath || !selectedBase) return;
    try {
      await host.knowledge.write(selectedPath, selectedContent, selectedBase.id);
      setAllDocsContent((current) => new Map(current).set(selectedPath, selectedContent));
      setDirty(false);
      await refreshKnowledge(selectedBase.id);
      setNotice('saved');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'could not save document');
    }
  };

  /* autosave: write the buffer ~600ms after the user stops typing. removes
     the need for an explicit save button without losing edits if the panel
     unmounts mid-stream. */
  useEffect(() => {
    if (!dirty || !selectedPath || !selectedBase) return undefined;
    const handle = window.setTimeout(() => { void saveNote(); }, 600);
    return () => window.clearTimeout(handle);
    /* saveNote closes over selectedContent — re-running on content change
       is intentional debounce behavior. */
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [dirty, selectedContent, selectedPath, selectedBase]);

  const openContextItem = async (item: string) => {
    const path = pathFromContextItem(item);
    if (!path) return;
    if (knowledgePaths.includes(path)) {
      setSelectedPath(path);
      setShowPreview(false);
      setNotice(`opened ${path}`);
      return;
    }
    /* queued KB files are stored absolute (so @-mentions resolve regardless
       of cwd). reverse-resolve by stripping any base root prefix to find
       the matching knowledge-tree entry. */
    for (const base of knowledgeBases) {
      const prefix = `${base.root.replace(/\/+$/, '')}/`;
      if (path.startsWith(prefix)) {
        const relative = path.slice(prefix.length);
        if (flattenFiles(knowledgeTree).includes(relative) || base.id !== selectedBaseId) {
          if (base.id !== selectedBaseId) setSelectedBaseId(base.id);
          setSelectedPath(relative);
          setShowPreview(false);
          setNotice(`opened ${relative}`);
          return;
        }
      }
    }
    try {
      await host.editor.open(path);
      setNotice(`opened ${path}`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : `could not open ${path}`);
    }
  };

  const openWikilink = (link: string) => {
    const normalized = link.endsWith('.md') ? link : `${link}.md`;
    const target = knowledgePaths.find((path) => (
      path === normalized || path.endsWith(`/${normalized}`) || path.endsWith(`/${link}`)
    ));
    if (!target) {
      setNotice(`no document found for [[${link}]]`);
      return;
    }
    setSelectedPath(target);
    setShowPreview(false);
  };

  const loadIntoContext = (path: string) => {
    if (!path) return;
    /* resolve base-relative paths to absolute so the @-mention works
       regardless of the agent's cwd. without this, files from a global
       base (e.g., ~/Dev/memory/wiki/foo.md) would resolve to ./foo.md
       in the project, missing the file. */
    const absolutePath = selectedBase?.root && !path.startsWith('/')
      ? `${selectedBase.root.replace(/\/+$/, '')}/${path}`
      : path;
    onAddContext(`included: ${absolutePath}`, selectedChat?.id);
    setNotice(selectedChat ? `loaded ${path} for ${selectedChat.title}` : `loaded ${path}`);
  };

  useEffect(() => {
    if (!selectedPath || !selectedBase) {
      setSelectedContent((current) => (current === '' ? current : ''));
      setDirty((current) => (current === false ? current : false));
      return undefined;
    }
    let cancelled = false;
    host.knowledge.read(selectedPath, selectedBase.id).then((result) => {
      if (!cancelled) {
        setSelectedContent((current) => (current === result.content ? current : result.content));
        setDirty((current) => (current === false ? current : false));
      }
    }).catch(() => {
      if (!cancelled) {
        setSelectedContent((current) => (current === '' ? current : ''));
        setDirty((current) => (current === false ? current : false));
      }
    });
    return () => { cancelled = true; };
  }, [host, selectedPath, selectedBase]);

  useEffect(() => {
    if (!selectedPath.includes('/')) return;
    const selectedFolders = folderAncestors(selectedPath);
    setCollapsedFolders((current) => {
      if (!selectedFolders.some((path) => current.has(path))) return current;
      const next = new Set(current);
      selectedFolders.forEach((path) => next.delete(path));
      return next;
    });
  }, [selectedPath]);

  const chatLabel = chatTargets.length === 0
    ? 'no chat open'
    : selectedChat?.title ?? 'shared';
  const saveStatus = dirty ? 'saving' : notice;
  return (
    <div className="memory-shell">
      <PanelHeader {...header}>
        <span className="panel-header__title">{panelLabel}</span>
        <span className="panel-header__sep" aria-hidden="true" />
        <span className="panel-header__meta">{chatLabel}</span>
        <span className="panel-header__meta">
          {visibleContextInventory.length + (contextDocs?.length ?? 0)} loaded {contextTokens > 0 ? `(${formatTokens(contextTokens)})` : ''}
        </span>
        <span className="panel-header__meta">{knowledgeBases.length} bases</span>
      </PanelHeader>
      <div
        className="memory-grid"
        style={{ '--memory-context-width': `${contextWidth}%` } as React.CSSProperties}
      >
        <aside className="memory-context">
          <header className="memory-context__head">
            <h2>context</h2>
            <small title={`${contextTokens.toLocaleString()} tokens, ${formatBytes(contextBytes)} estimated from loaded files and chat`}>
              {contextTokens === 0 ? '0 tokens' : `${formatTokens(contextTokens)} tokens`}
            </small>
          </header>
          {chatTargets.length > 1 ? (
            <label className="memory-chat-target">
              <span>context for</span>
              <div className="memory-chat-target__select">
                <select
                  aria-label="context chat"
                  value={selectedChatId}
                  onChange={(event) => setSelectedChatId(event.target.value)}
                >
                  {chatTargets.map((target) => (
                    <option key={target.id} value={target.id}>{target.title}</option>
                  ))}
                </select>
                <span className="memory-chat-target__chevron" aria-hidden="true">v</span>
              </div>
            </label>
          ) : (
            <div className="memory-chat-target memory-chat-target--static">
              <span>context for</span>
              <strong>{chatLabel}</strong>
            </div>
          )}
          <div
            aria-label={`loaded context for ${selectedChat?.title ?? 'shared context'}`}
            className={`context-list ${dragOver ? 'context-list--drop' : ''}`}
            onDragOver={(event) => {
              const types = Array.from(event.dataTransfer.types ?? []);
              if (types.includes('application/x-knowledge-file')) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                setDragOver(true);
              }
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              const path = event.dataTransfer.getData('application/x-knowledge-file');
              if (path) loadIntoContext(path);
            }}
          >
            {selectedChat && chatContextStats && (
              <div className="context-list__row context-list__row--chat">
                <div
                  className="context-list__open context-list__open--chat"
                  role="status"
                  aria-label={`${selectedChat.title} chat size`}
                >
                  <span>chat itself</span>
                  <small title={`${chatContextStats.source}, updated live`}>
                    {formatContextSize(chatContextStats.bytes, chatContextStats.tokens)}
                    {chatContextStats.turns > 0 ? ` · ${chatContextStats.turns} turns` : ''}
                  </small>
                </div>
              </div>
            )}
            {contextDocs?.map((doc) => (
              <div
                className={`context-list__row context-list__row--${doc.state}`}
                key={doc.path}
                aria-label={`${doc.path}, ${doc.state}`}
              >
                <div className="context-list__open context-list__open--file" title={doc.path}>
                  <span>{doc.path}</span>
                  <small>{formatContextSize(doc.bytes, doc.tokens)}</small>
                </div>
                {doc.readCount > 1 && <span className="context-list__count">{doc.readCount}x</span>}
                {doc.state === 'compacted' && <span className="context-list__tag">compact</span>}
                {doc.state === 'queued' && (
                  <button
                    type="button"
                    className="context-list__remove"
                    aria-label={`cancel queued ${doc.path}`}
                    onClick={() => onRemoveContext(doc.contextItem ?? `included: ${doc.path}`, selectedChat?.id)}
                  >
                    x
                  </button>
                )}
              </div>
            ))}
            {visibleContextInventory.map((entry) => (
              <div
                className="context-list__row context-list__row--queued"
                key={entry.key}
                aria-label={`${entry.label}, queued`}
              >
                <button
                  type="button"
                  className={`context-list__open context-list__open--${entry.kind}`}
                  title={entry.label}
                  onClick={() => void openContextItem(entry.item)}
                >
                  <span>{entry.label}</span>
                  <small title={entry.missing ? 'content not found yet' : `${entry.bytes.toLocaleString()} bytes, ${entry.tokens.toLocaleString()} tokens`}>
                    {entry.missing ? 'size pending' : formatContextSize(entry.bytes, entry.tokens)}
                  </small>
                </button>
                <button
                  type="button"
                  className="context-list__remove"
                  aria-label={`cancel queued ${entry.label}`}
                  onClick={() => onRemoveContext(entry.item, selectedChat?.id)}
                >
                  x
                </button>
              </div>
            ))}
            {queuedCount > 0 && (
              <span className="context-list__pending-hint">new files send on next message</span>
            )}
            <span className="context-list__hint">
              {visibleContextInventory.length || contextDocs?.length ? 'drop more from documents' : 'drag documents here'}
            </span>
          </div>
        </aside>
        <ResizeHandle axis="x" label="resize memory context and documents" onDrag={onContextResize} />
        <section
          className="memory-workbench"
          style={{ '--memory-library-width': `${libraryWidth}%` } as React.CSSProperties}
        >
          <aside className="memory-library">
            <header className="memory-library__head">
              <button type="button" onClick={openSetup}>
                <span className="memory-library__head-plus" aria-hidden="true">+</span>
                create base
              </button>
              <button type="button" onClick={() => void openFolder()}>
                open folder
              </button>
            </header>
            {knowledgeBases.length === 0 ? (
              <DocumentsEmpty loading={baseLoading} />
            ) : (
              <>
                <KnowledgeBaseGroup
                  title="global"
                  hint="available in every project"
                  bases={globalBases}
                  activeId={selectedBaseId}
                  onSelect={setSelectedBaseId}
                  onEdit={openEditBase}
                />
                <KnowledgeBaseGroup
                  title="project"
                  hint="only shown in this project"
                  bases={projectBases}
                  activeId={selectedBaseId}
                  onSelect={setSelectedBaseId}
                  onEdit={openEditBase}
                />
                <div className="documents-tree-head">
                  <small title={selectedBase?.root ?? ''}>
                    <span>{selectedBase?.root ?? ''}</span>
                  </small>
                  <button
                    ref={memPlusBtnRef}
                    type="button"
                    className={`documents-tree-head__newdoc${memPlusOpen ? ' documents-tree-head__newdoc--open' : ''}`}
                    aria-label="new entry"
                    title={selectedBase ? `new entry in ${selectedBase.name}` : 'new entry'}
                    disabled={!selectedBase}
                    aria-expanded={memPlusOpen}
                    onClick={(e) => {
                      const nextOpen = !memPlusOpen;
                      if (nextOpen) {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setMemPlusPos({ top: rect.bottom + 4, left: rect.left });
                      }
                      setMemPlusOpen(nextOpen);
                      setMemPlusKind(null);
                      setMemPlusName('');
                      setMemPlusError('');
                    }}
                  >
                    +
                  </button>
                </div>
                <nav className="memory-library__list" aria-label="documents">
                  {memPlusOpen && selectedBase && memPlusKind !== null && (
                    <>
                      <div ref={memPlusRowRef} className="new-entry-row">
                        <span
                          className={`file-tree__icon ${memPlusKind === 'folder' ? 'file-tree__icon--folder' : 'file-tree__icon--file'}`}
                          aria-hidden="true"
                        />
                        <input
                          className="new-entry-row__input"
                          value={memPlusName}
                          placeholder={memPlusKind === 'folder' ? 'folder-name' : 'notes/decision.md'}
                          autoFocus
                          onChange={(e) => setMemPlusName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') { setMemPlusOpen(false); setMemPlusKind(null); setMemPlusName(''); setMemPlusError(''); }
                            if (e.key === 'Enter') void createMemPlusEntry();
                          }}
                        />
                      </div>
                      {memPlusError && <p className="new-entry-row__error">{memPlusError}</p>}
                    </>
                  )}
                  {knowledgePaths.length === 0 && <span className="verify-empty">no documents yet</span>}
                  <KnowledgeTree
                    nodes={knowledgeTree}
                    activePath={selectedPath}
                    onSelect={(path) => {
                      setSelectedPath(path);
                      setShowPreview(false);
                    }}
                    collapsedFolders={collapsedFolders}
                    onToggleFolder={(path) => setCollapsedFolders((current) => {
                      const next = new Set(current);
                      if (next.has(path)) next.delete(path);
                      else next.add(path);
                      return next;
                    })}
                    onContextMenu={handleMemCtxMenu}
                  />
                </nav>
              </>
            )}
          </aside>
          <ResizeHandle axis="x" label="resize memory library and document" onDrag={onLibraryResize} />
          <section className="memory-document">
            <header className="memory-document__head">
              <div className="memory-document__path">
                {selectedPath && <h2>{selectedPath}</h2>}
                {saveStatus && <small>{saveStatus}</small>}
              </div>
              {selectedPath && (
                <button
                  type="button"
                  className={`memory-document__toggle ${showPreview ? 'memory-document__toggle--active' : ''}`}
                  title={showPreview ? 'edit' : 'render markdown'}
                  onClick={() => setShowPreview((value) => !value)}
                >
                  preview
                </button>
              )}
            </header>
            <article aria-label={selectedPath ? `render ${selectedPath}` : 'selected document'}>
              {selectedPath ? (
                <>
                  {showPreview ? (
                    <NotePreview content={selectedContent} onOpenWikilink={openWikilink} />
                  ) : (
                    <textarea
                      aria-label={`edit ${selectedPath}`}
                      className="memory-document__editor"
                      value={selectedContent}
                      onChange={(event) => {
                        setSelectedContent(event.target.value);
                        setDirty(true);
                      }}
                    />
                  )}
                  {backlinks.length > 0 && (
                    <div className="memory-backlinks" aria-label="backlinks">
                      <strong>backlinks</strong>
                      {backlinks.map((path) => (
                        <button key={path} onClick={() => setSelectedPath(path)}>
                          {path}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <DocumentsPlaceholder
                  hasBases={knowledgeBases.length > 0}
                  selectedBase={selectedBase}
                  onNewDocument={() => setNewNoteOpen(true)}
                />
              )}
            </article>
          </section>
          {setupOpen && (
            <div className="documents-setup" role="dialog" aria-label={`setup ${panelLabel}`}>
              <header className="documents-setup__head">
                <strong>setup {panelLabel}</strong>
                <button type="button" onClick={() => setSetupOpen(false)}>close</button>
              </header>
              <div className="documents-setup__body">
                <div className="documents-setup__fields">
                  <label>
                    <span>name</span>
                    <input
                      value={setupName}
                      autoFocus
                      onChange={(event) => setSetupName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setSetupOpen(false);
                        if (event.key === 'Enter') void createBase();
                      }}
                    />
                  </label>
                  <label>
                    <span>scope</span>
                    <div className="memory-chat-target__select documents-setup__scope">
                      <select
                        value={setupScope}
                        onChange={(event) => setSetupScope(event.target.value as KnowledgeBaseScope)}
                      >
                        <option value="project">project — only this project</option>
                        <option value="global">global — every project</option>
                      </select>
                      <span className="memory-chat-target__chevron" aria-hidden="true">v</span>
                    </div>
                  </label>
                  <div className="documents-setup__location">
                    <label htmlFor="documents-setup-folder">folder</label>
                    <div className="documents-setup__location-row">
                      <input
                        id="documents-setup-folder"
                        value={setupLocation}
                        placeholder="memory folder"
                        onChange={(event) => {
                          setSetupLocation(event.target.value);
                          setSetupLocationTouched(true);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setSetupOpen(false);
                          if (event.key === 'Enter') void createBase();
                        }}
                      />
                      <button type="button" onClick={() => void chooseSetupLocation()}>choose</button>
                    </div>
                  </div>
                  <div className="documents-setup__folders">
                    <label htmlFor="documents-setup-folder-draft">folders</label>
                    <div className="documents-folders-list" aria-label="folder partitions">
                      {setupFolders.length === 0 && (
                        <span className="documents-folders-empty">no folders — just an index.md</span>
                      )}
                      {setupFolders.map((folder) => (
                        <span key={folder} className="documents-folder-chip">
                          {folder}/
                          <button
                            type="button"
                            aria-label={`remove ${folder} folder`}
                            onClick={() => removeSetupFolder(folder)}
                          >
                            x
                          </button>
                        </span>
                      ))}
                    </div>
                    <div className="documents-folders-add">
                      <input
                        id="documents-setup-folder-draft"
                        value={setupFolderDraft}
                        placeholder="add a folder (e.g. recipes)"
                        onChange={(event) => setSetupFolderDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setSetupOpen(false);
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            addSetupFolder();
                          }
                        }}
                      />
                      <button type="button" onClick={addSetupFolder} disabled={!setupFolderDraft.trim()}>
                        add
                      </button>
                    </div>
                  </div>
                </div>
                <div className="documents-setup__presets" role="radiogroup" aria-label="memory preset">
                  <span className="documents-setup__presets-label">preset</span>
                  <div className="documents-preset-list">
                    {BASE_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        role="radio"
                        aria-checked={setupPreset === preset.id}
                        className={setupPreset === preset.id ? 'documents-preset documents-preset--active' : 'documents-preset'}
                        onClick={() => selectPreset(preset.id)}
                      >
                        <strong>{preset.title}</strong>
                        <span>{preset.detail}</span>
                        {preset.folders.length > 0 && (
                          <small>{preset.folders.map((folder) => `${folder}/`).join('  ')}</small>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="documents-setup__actions">
                <button type="button" onClick={() => setSetupOpen(false)}>cancel</button>
                <button type="button" onClick={() => void createBase()}>create base</button>
              </div>
            </div>
          )}
          {newNoteOpen && (
            <div className="entry-dialog entry-dialog--memory" role="dialog" aria-label="new document">
              <header className="entry-dialog__header">
                <strong className="entry-dialog__title">new document</strong>
                <button type="button" className="entry-dialog__close" onClick={() => setNewNoteOpen(false)}>close</button>
              </header>
              {newNotePath.includes('/') && (
                <small className="entry-dialog__context">in {newNotePath.slice(0, newNotePath.lastIndexOf('/') + 1)}</small>
              )}
              <input
                className="entry-dialog__input"
                value={newNotePath}
                placeholder="notes/decision.md"
                autoFocus
                ref={(el) => el && (el.selectionStart = el.selectionEnd = el.value.length)}
                onChange={(event) => setNewNotePath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setNewNoteOpen(false);
                  if (event.key === 'Enter') void createNote();
                }}
              />
              <div className="entry-dialog__actions">
                <button type="button" onClick={() => setNewNoteOpen(false)}>cancel</button>
                <button type="button" className="entry-dialog__create" onClick={() => void createNote()}>create document</button>
              </div>
            </div>
          )}
        </section>
      </div>
      {editingBase && (
        <div className="documents-setup" role="dialog" aria-label={`edit ${editingBase.name}`}>
          <header className="documents-setup__head">
            <strong>edit memory base</strong>
            <button type="button" onClick={closeEditBase}>close</button>
          </header>
          <div className="documents-setup__body">
            <div className="documents-setup__fields">
              <label>
                <span>name</span>
                <input
                  value={editName}
                  autoFocus
                  onChange={(event) => setEditName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') closeEditBase();
                    if (event.key === 'Enter') void saveEditBase();
                  }}
                />
              </label>
              <label>
                <span>scope</span>
                <div className="memory-chat-target__select documents-setup__scope">
                  <select
                    value={editScope}
                    onChange={(event) => setEditScope(event.target.value as KnowledgeBaseScope)}
                  >
                    <option value="project">project — only this project</option>
                    <option value="global">global — every project</option>
                  </select>
                  <span className="memory-chat-target__chevron" aria-hidden="true">v</span>
                </div>
              </label>
              <div className="documents-setup__location">
                <span className="documents-setup__readonly-label">folder</span>
                <code className="documents-setup__readonly-value">{editingBase.root}</code>
              </div>
            </div>
            <div className="documents-setup__side">
              <span className="documents-setup__presets-label">folders</span>
              <div className="edit-folders" aria-label="folders in this base">
                {editFolders.length === 0 && (
                  <span className="edit-folders__empty">no folders yet</span>
                )}
                {editFolders.map((folder) => {
                  const isRenaming = editRenamingFolder === folder;
                  const isConfirmingDelete = editFolderConfirmingDelete === folder;
                  return (
                    <div className="edit-folder-row" key={folder}>
                      {isRenaming ? (
                        <input
                          className="edit-folder-row__input"
                          value={editRenameDraft}
                          autoFocus
                          onChange={(event) => setEditRenameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') setEditRenamingFolder('');
                            if (event.key === 'Enter') void commitRenameFolder();
                          }}
                        />
                      ) : (
                        <span className="edit-folder-row__name">{folder}/</span>
                      )}
                      <div className="edit-folder-row__actions">
                        {isRenaming ? (
                          <>
                            <button type="button" onClick={() => setEditRenamingFolder('')}>cancel</button>
                            <button type="button" onClick={() => void commitRenameFolder()}>save</button>
                          </>
                        ) : isConfirmingDelete ? (
                          <>
                            <button type="button" onClick={() => setEditFolderConfirmingDelete('')}>cancel</button>
                            <button
                              type="button"
                              className="edit-folder-row__delete"
                              onClick={() => void removeEditFolder(folder)}
                              title={`delete ${folder}/ and all its files`}
                            >
                              delete forever
                            </button>
                          </>
                        ) : (
                          <>
                            <button type="button" onClick={() => startRenameFolder(folder)}>rename</button>
                            <button
                              type="button"
                              onClick={() => setEditFolderConfirmingDelete(folder)}
                              title={`delete ${folder}/`}
                            >
                              delete
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="edit-folders__add">
                <input
                  value={editFolderDraft}
                  placeholder="add a folder (e.g. notes)"
                  onChange={(event) => setEditFolderDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') closeEditBase();
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void addEditFolder();
                    }
                  }}
                />
                <button type="button" onClick={() => void addEditFolder()} disabled={!editFolderDraft.trim()}>
                  add
                </button>
              </div>
              <div className="documents-setup__danger" role="group" aria-label="delete base">
                <strong>delete base</strong>
                {editConfirmingDelete ? (
                  <>
                    <p>
                      delete <strong>{editingBase.name}</strong> and remove all files under
                      {' '}
                      <code>{editingBase.root}</code>. this can&rsquo;t be undone.
                    </p>
                    <div className="documents-setup__danger-actions">
                      <button type="button" onClick={() => setEditConfirmingDelete(false)}>cancel</button>
                      <button
                        type="button"
                        className="documents-setup__danger-confirm"
                        onClick={() => void deleteEditBase()}
                      >
                        delete forever
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p>removes the base from the list and deletes every file under its folder.</p>
                    <button
                      type="button"
                      className="documents-setup__danger-trigger"
                      onClick={() => setEditConfirmingDelete(true)}
                    >
                      delete base
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="documents-setup__actions">
            <button type="button" onClick={closeEditBase}>cancel</button>
            <button type="button" onClick={() => void saveEditBase()}>save</button>
          </div>
        </div>
      )}
      {memPlusOpen && memPlusKind === null && memPlusPos && createPortal(
        <div
          ref={memPlusRef}
          className="plus-dropdown"
          style={{ top: memPlusPos.top, left: memPlusPos.left }}
          role="menu"
        >
          <button
            type="button"
            className="plus-dropdown__item"
            role="menuitem"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setMemPlusOpen(false); setMemPlusKind(null); }
              if (e.key === 'ArrowDown') { e.preventDefault(); (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus(); }
              if (e.key === 'ArrowUp') { e.preventDefault(); (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus(); }
            }}
            onClick={() => setMemPlusKind('folder')}
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
              if (e.key === 'Escape') { setMemPlusOpen(false); setMemPlusKind(null); }
              if (e.key === 'ArrowDown') { e.preventDefault(); (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus(); }
              if (e.key === 'ArrowUp') { e.preventDefault(); (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus(); }
            }}
            onClick={() => setMemPlusKind('document')}
          >
            <svg className="plus-dropdown__icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M4 0h5.293A1 1 0 0 1 10 .293L13.707 4a1 1 0 0 1 .293.707V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2zm5.5 1.5v2a1 1 0 0 0 1 1h2l-3-3z" />
            </svg>
            new document
          </button>
        </div>,
        document.body,
      )}
      {memCtxMenu && createPortal(
        <div
          className="ctx-menu"
          style={{ top: memCtxMenu.y, left: memCtxMenu.x }}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {memCtxMenu.info.kind === 'folder' && (
            <>
              <button className="ctx-menu__item" role="menuitem" onClick={() => memCtxNewDoc(memCtxMenu.info.path)}>
                <span className="ctx-menu__icon ctx-menu__icon--file" aria-hidden="true" />
                new document
              </button>
              <button className="ctx-menu__item" role="menuitem" onClick={() => void memCtxNewFolder(memCtxMenu.info.path)}>
                <span className="ctx-menu__icon ctx-menu__icon--folder" aria-hidden="true" />
                new folder
              </button>
              <div className="ctx-menu__sep" role="separator" />
              <button className="ctx-menu__item" role="menuitem" onClick={() => void memCtxRenameFolder(memCtxMenu.info.path)}>
                rename folder
              </button>
              <button className="ctx-menu__item ctx-menu__item--danger" role="menuitem" onClick={() => void memCtxDeleteFolder(memCtxMenu.info.path)}>
                delete folder
              </button>
            </>
          )}
          {memCtxMenu.info.kind === 'file' && (
            <>
              <button className="ctx-menu__item ctx-menu__item--danger" role="menuitem" onClick={() => void memCtxDeleteDoc(memCtxMenu.info.path)}>
                delete
              </button>
              <div className="ctx-menu__sep" role="separator" />
              <button className="ctx-menu__item" role="menuitem" onClick={() => { void navigator.clipboard.writeText(memCtxMenu.info.path); setMemCtxMenu(null); }}>
                copy path
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

function DocumentsEmpty({
  loading,
}: {
  loading: boolean;
}) {
  return (
    <div className="documents-empty">
      <strong>{loading ? 'loading memory' : 'no bases yet'}</strong>
      <span>
        {loading
          ? 'checking configured folders'
          : 'click create base to create a base, or open folder to attach an existing one'}
      </span>
    </div>
  );
}

function DocumentsPlaceholder({
  hasBases,
  selectedBase,
  onNewDocument,
}: {
  hasBases: boolean;
  selectedBase?: KnowledgeBase;
  onNewDocument: () => void;
}) {
  if (!hasBases) {
    return (
      <div className="documents-placeholder documents-placeholder--quiet">
        <h3>no document selected</h3>
        <p>connect a base from the list on the left.</p>
      </div>
    );
  }
  return (
    <div className="documents-placeholder documents-placeholder--ready">
      <h3>{selectedBase ? selectedBase.name : 'no document selected'}</h3>
      <p>{selectedBase ? 'pick a file from the tree or create a new one in this base.' : 'select a base from the list on the left.'}</p>
      {selectedBase && (
        <div>
          <button type="button" onClick={onNewDocument}>new document</button>
        </div>
      )}
    </div>
  );
}

function KnowledgeBaseGroup({
  title,
  hint,
  bases,
  activeId,
  onSelect,
  onEdit,
}: {
  title: KnowledgeBaseScope;
  hint: string;
  bases: KnowledgeBase[];
  activeId: string;
  onSelect: (id: string) => void;
  onEdit: (base: KnowledgeBase) => void;
}) {
  if (bases.length === 0) return null;
  return (
    <section className="documents-base-group" aria-label={`${title} memory bases`}>
      <header>
        <strong>{title}</strong>
        <small>{hint}</small>
      </header>
      {bases.map((base) => (
        <div
          key={base.id}
          className={base.id === activeId ? 'documents-base documents-base--active' : 'documents-base'}
        >
          <span className="documents-base__stripe" aria-hidden="true" />
          <button type="button" className="documents-base__select" onClick={() => onSelect(base.id)}>
            <strong>{base.name}</strong>
          </button>
          <button
            type="button"
            className="documents-base__edit"
            aria-label={`edit ${base.name}`}
            title={`edit ${base.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onEdit(base);
            }}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      ))}
    </section>
  );
}

async function readContextFileContent(
  host: BuiltinPluginProps['host'],
  path: string,
  bases: KnowledgeBase[],
): Promise<string | null> {
  for (const base of bases) {
    try {
      const read = await host.knowledge.read(path, base.id);
      return read.content;
    } catch {
      /* try the next base or fall back to the workspace editor API. */
    }
  }
  try {
    const read = await host.editor.read(path);
    return read.content;
  } catch {
    return null;
  }
}

async function readHostChatContextStats(
  host: BuiltinPluginProps['host'],
  target: ChatTarget,
): Promise<ChatContextStats | null> {
  try {
    const result = await host.chat.sessions();
    const sessions = result.sessions as ChatSessionSummary[];
    const session = resolveChatSession(sessions, target);
    const sessionId = session?.id ?? defaultChatSessionId(target);
    const history = await host.chat.history(sessionId);
    return statsFromChatMessages(history.messages as ChatMessageSummary[]);
  } catch {
    return null;
  }
}


function KnowledgeTree({
  nodes,
  activePath,
  collapsedFolders,
  onSelect,
  onToggleFolder,
  onContextMenu,
  parentPath = '',
  depth = 0,
}: {
  nodes: FileNode[];
  activePath: string;
  collapsedFolders: Set<string>;
  onSelect: (path: string) => void;
  onToggleFolder: (path: string) => void;
  onContextMenu?: (e: React.MouseEvent, info: FileTreeContextInfo) => void;
  parentPath?: string;
  depth?: number;
}) {
  return (
    <div className="knowledge-tree" role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map((node) => {
        if (node.kind === 'folder') {
          const path = parentPath ? `${parentPath}/${node.name}` : node.name;
          const collapsed = collapsedFolders.has(path);
          return (
            <div className="knowledge-tree__folder" key={path} role="treeitem" aria-expanded={!collapsed}>
              <button
                type="button"
                className="knowledge-tree__row knowledge-tree__row--folder"
                style={{ '--knowledge-depth': depth } as React.CSSProperties}
                onClick={() => onToggleFolder(path)}
                onContextMenu={onContextMenu ? (e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e, { kind: 'folder', path }); } : undefined}
              >
                <span className="knowledge-tree__chevron" aria-hidden="true">{collapsed ? '>' : 'v'}</span>
                <span className="knowledge-tree__folder-mark" aria-hidden="true" />
                <span>{node.name}</span>
              </button>
              {!collapsed && (
                <KnowledgeTree
                  nodes={node.children}
                  activePath={activePath}
                  collapsedFolders={collapsedFolders}
                  onSelect={onSelect}
                  onToggleFolder={onToggleFolder}
                  onContextMenu={onContextMenu}
                  parentPath={path}
                  depth={depth + 1}
                />
              )}
            </div>
          );
        }
        return (
          <button
            type="button"
            key={node.path}
            role="treeitem"
            className={node.path === activePath ? 'knowledge-tree__row knowledge-tree__row--file knowledge-tree__row--active' : 'knowledge-tree__row knowledge-tree__row--file'}
            style={{ '--knowledge-depth': depth } as React.CSSProperties}
            onClick={() => onSelect(node.path)}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'copy';
              event.dataTransfer.setData('application/x-knowledge-file', node.path);
              event.dataTransfer.setData('text/plain', node.path);
            }}
            onContextMenu={onContextMenu ? (e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e, { kind: 'file', path: node.path, folderPath: parentPath }); } : undefined}
          >
            <span className="knowledge-tree__file-mark" aria-hidden="true" />
            <span>{node.name}</span>
          </button>
        );
      })}
    </div>
  );
}

type NoteBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string };

function NotePreview({
  content,
  onOpenWikilink,
}: {
  content: string;
  onOpenWikilink: (link: string) => void;
}) {
  const blocks = noteBlocks(content);
  if (blocks.length === 0) return <p className="memory-preview__empty">empty document</p>;
  return (
    <div className="memory-preview">
      {blocks.map((block, index) => {
        if (block.kind === 'heading') {
          const Heading = `h${Math.min(block.level + 2, 6)}` as keyof JSX.IntrinsicElements;
          return <Heading key={`heading-${index}`}>{renderNoteInline(block.text, onOpenWikilink)}</Heading>;
        }
        if (block.kind === 'paragraph') {
          return <p key={`paragraph-${index}`}>{renderNoteInline(block.text, onOpenWikilink)}</p>;
        }
        if (block.kind === 'quote') {
          return <blockquote key={`quote-${index}`}>{renderNoteInline(block.text, onOpenWikilink)}</blockquote>;
        }
        if (block.kind === 'code') {
          return <pre key={`code-${index}`}><code>{block.text}</code></pre>;
        }
        const List = block.ordered ? 'ol' : 'ul';
        return (
          <List key={`list-${index}`}>
            {block.items.map((item, itemIndex) => (
              <li key={`item-${itemIndex}`}>{renderNoteInline(item, onOpenWikilink)}</li>
            ))}
          </List>
        );
      })}
    </div>
  );
}

function renderNoteInline(text: string, onOpenWikilink: (link: string) => void) {
  const rendered: React.ReactNode[] = [];
  let lastIndex = 0;
  [...text.matchAll(/\[\[([^\]]+)]]/g)].forEach((match, index) => {
    const start = match.index ?? 0;
    const link = match[1].trim();
    if (start > lastIndex) rendered.push(text.slice(lastIndex, start));
    rendered.push(
      <button
        key={`${link}-${index}`}
        type="button"
        className="memory-preview__wikilink"
        onClick={() => onOpenWikilink(link)}
      >
        [[{link}]]
      </button>,
    );
    lastIndex = start + match[0].length;
  });
  if (lastIndex < text.length) rendered.push(text.slice(lastIndex));
  return rendered.length > 0 ? rendered : text;
}

function noteBlocks(content: string): NoteBlock[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: NoteBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.trim().startsWith('```')) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, '').trim());
        index += 1;
      }
      blocks.push({ kind: 'quote', text: quote.join(' ') });
      continue;
    }
    const list = line.match(/^\s*(?:([-*])|(\d+\.))\s+(.+)$/);
    if (list) {
      const ordered = Boolean(list[2]);
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*(?:([-*])|(\d+\.))\s+(.+)$/);
        if (!item || Boolean(item[2]) !== ordered) break;
        items.push(item[3].trim());
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !startsNoteBlock(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    if (paragraph.length === 0) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
  }
  return blocks;
}

function startsNoteBlock(line: string): boolean {
  return line.trim().startsWith('```')
    || /^(#{1,6})\s+/.test(line)
    || /^\s*>\s?/.test(line)
    || /^\s*(?:[-*]|\d+\.)\s+/.test(line);
}
