/* knowledge-base (memory panel) + adr handlers — registered against the core server by
   registerBuiltinHandlers(). HostInternals documents exactly which
   server state this domain touches. */

import type { HostInternals } from './internals';
import type { KnowledgeBasePreset, KnowledgeBaseScope } from '../rpc-server';
import {
  browserDirectoryPicker,
  browserKnowledgeBase,
  fileSlug,
  knowledgeDocName,
  listBrowserKnowledge,
  memoryKnowledgeBase,
  readBrowserKnowledge,
  renderHandoffDoc,
  seedMemoryKnowledgePreset,
  writeBrowserKnowledge,
} from '../rpc-server';

export function registerKnowledgeHandlers(host: HostInternals) {
  host.registerHandler('knowledge.bases', async () => {
    if (host.knowledgeAdapter?.bases) return { bases: await host.knowledgeAdapter.bases() };
    if (host.knowledgeBases.length > 0) return { bases: host.knowledgeBases };
    return { bases: host.knowledge.size > 0 ? [memoryKnowledgeBase()] : [] };
  });
  host.registerHandler('knowledge.openFolder', async () => {
    if (host.knowledgeAdapter?.openFolder) return { base: await host.knowledgeAdapter.openFolder() };
    const picker = browserDirectoryPicker();
    if (picker) {
      const handle = await picker();
      if (!handle) return { base: null };
      const base = browserKnowledgeBase(handle);
      host.browserKnowledgeHandles.set(base.id, handle);
      host.knowledgeBases = [base, ...host.knowledgeBases.filter((item) => item.id !== base.id)];
      return { base };
    }
    throw new Error('folder picker unavailable');
  });
  host.registerHandler('knowledge.suggestBaseLocation', async (params) => {
    const input = params as { name: string; scope: KnowledgeBaseScope };
    if (host.knowledgeAdapter?.suggestBaseLocation) {
      return { location: await host.knowledgeAdapter.suggestBaseLocation(input) };
    }
    return { location: `memory://documents/${fileSlug(input.name || 'documents')}` };
  });
  host.registerHandler('knowledge.pickBaseLocation', async () => {
    if (host.knowledgeAdapter?.pickBaseLocation) return await host.knowledgeAdapter.pickBaseLocation();
    const picker = browserDirectoryPicker();
    if (!picker) return { location: null };
    const handle = await picker();
    if (!handle) return { location: null };
    const base = browserKnowledgeBase(handle);
    host.browserKnowledgeHandles.set(base.id, handle);
    host.knowledgeBases = [base, ...host.knowledgeBases.filter((item) => item.id !== base.id)];
    return { location: base.root, scope: base.scope };
  });
  host.registerHandler('knowledge.createBase', async (params) => {
    const input = params as {
      name: string;
      scope: KnowledgeBaseScope;
      preset: KnowledgeBasePreset;
      root?: string;
      folders?: string[];
    };
    if (host.knowledgeAdapter?.createBase) return { base: await host.knowledgeAdapter.createBase(input) };
    const existing = input.root
      ? host.knowledgeBases.find((item) => item.root === input.root)
      : null;
    if (existing) {
      const base = {
        ...existing,
        name: input.name || existing.name,
        scope: input.scope,
      };
      host.knowledgeBases = [base, ...host.knowledgeBases.filter((item) => item.id !== base.id)];
      return { base };
    }
    const base = {
      ...memoryKnowledgeBase(),
      name: input.name || memoryKnowledgeBase().name,
      root: input.root || memoryKnowledgeBase().root,
      scope: input.scope,
      suggestedScope: input.scope,
    };
    if (host.knowledge.size === 0) seedMemoryKnowledgePreset(host.knowledge, base.name, input.preset, input.folders);
    host.knowledgeBases = [base];
    return { base };
  });
  host.registerHandler('knowledge.setBaseScope', async (params) => {
    const { id, scope } = params as { id: string; scope: KnowledgeBaseScope };
    if (host.knowledgeAdapter?.setBaseScope) {
      return { base: await host.knowledgeAdapter.setBaseScope(id, scope) };
    }
    const current = host.knowledgeBases.find((base) => base.id === id) ?? memoryKnowledgeBase();
    const base = { ...current, scope };
    host.knowledgeBases = [base, ...host.knowledgeBases.filter((item) => item.id !== id)];
    return { base };
  });
  host.registerHandler('knowledge.renameBase', async (params) => {
    const { id, name } = params as { id: string; name: string };
    const trimmed = (name ?? '').trim();
    if (!trimmed) throw new Error('memory base name is required');
    if (host.knowledgeAdapter?.renameBase) {
      return { base: await host.knowledgeAdapter.renameBase(id, trimmed) };
    }
    const current = host.knowledgeBases.find((base) => base.id === id) ?? memoryKnowledgeBase();
    const base = { ...current, name: trimmed };
    host.knowledgeBases = [base, ...host.knowledgeBases.filter((item) => item.id !== id)];
    return { base };
  });
  host.registerHandler('knowledge.deleteBase', async (params) => {
    const { id } = params as { id: string };
    if (host.knowledgeAdapter?.deleteBase) {
      await host.knowledgeAdapter.deleteBase(id);
      return { deleted: true };
    }
    host.knowledgeBases = host.knowledgeBases.filter((item) => item.id !== id);
    return { deleted: true };
  });
  host.registerHandler('knowledge.createFolder', async (params) => {
    const { path, baseId } = params as { path: string; baseId?: string };
    if (host.knowledgeAdapter?.createFolder) {
      await host.knowledgeAdapter.createFolder(path, baseId);
      return { created: true };
    }
    /* in-memory fallback: seed an index.md so the folder is observable
       through knowledge.list, which only returns nodes derived from the
       path keys in host.knowledge. */
    const cleaned = path.replace(/^\/+|\/+$/g, '');
    if (!cleaned) throw new Error('folder name is required');
    const indexPath = `${cleaned}/index.md`;
    if (host.knowledge.has(indexPath)) throw new Error(`folder already exists: ${cleaned}`);
    const leaf = cleaned.split('/').pop() || 'folder';
    const heading = leaf.charAt(0).toUpperCase() + leaf.slice(1);
    host.knowledge.set(indexPath, `# ${heading}\n\n`);
    return { created: true };
  });
  host.registerHandler('knowledge.renameFolder', async (params) => {
    const { from, to, baseId } = params as { from: string; to: string; baseId?: string };
    if (host.knowledgeAdapter?.renameFolder) {
      await host.knowledgeAdapter.renameFolder(from, to, baseId);
      return { renamed: true };
    }
    const src = from.replace(/^\/+|\/+$/g, '');
    const dst = to.replace(/^\/+|\/+$/g, '');
    if (!src || !dst) throw new Error('both folder names are required');
    const prefix = `${src}/`;
    const keys = [...host.knowledge.keys()].filter((key) => key.startsWith(prefix));
    if (keys.length === 0) throw new Error(`folder not found: ${src}`);
    const collision = [...host.knowledge.keys()].some((key) => key.startsWith(`${dst}/`));
    if (collision) throw new Error(`folder already exists: ${dst}`);
    for (const key of keys) {
      const value = host.knowledge.get(key)!;
      host.knowledge.delete(key);
      host.knowledge.set(`${dst}/${key.slice(prefix.length)}`, value);
    }
    return { renamed: true };
  });
  host.registerHandler('knowledge.deleteFolder', async (params) => {
    const { path, baseId } = params as { path: string; baseId?: string };
    if (host.knowledgeAdapter?.deleteFolder) {
      await host.knowledgeAdapter.deleteFolder(path, baseId);
      return { deleted: true };
    }
    const cleaned = path.replace(/^\/+|\/+$/g, '');
    if (!cleaned) throw new Error('folder name is required');
    const prefix = `${cleaned}/`;
    const keys = [...host.knowledge.keys()].filter((key) => key.startsWith(prefix));
    if (keys.length === 0) throw new Error(`folder not found: ${cleaned}`);
    for (const key of keys) host.knowledge.delete(key);
    return { deleted: true };
  });
  host.registerHandler('knowledge.deleteDoc', async (params) => {
    const { path, baseId } = params as { path: string; baseId?: string };
    if (host.knowledgeAdapter?.deleteDoc) {
      await host.knowledgeAdapter.deleteDoc(path, baseId);
      return { deleted: true };
    }
    const cleaned = path.replace(/^\/+|\/+$/g, '');
    if (!cleaned) throw new Error('file path is required');
    if (!host.knowledge.has(cleaned)) throw new Error(`file not found: ${cleaned}`);
    host.knowledge.delete(cleaned);
    return { deleted: true };
  });
  host.registerHandler('knowledge.list', async (params) => {
    const { baseId } = params as { baseId?: string };
    if (host.knowledgeAdapter?.list) return { nodes: await host.knowledgeAdapter.list(baseId) };
    const handle = baseId ? host.browserKnowledgeHandles.get(baseId) : null;
    if (handle) return { nodes: await listBrowserKnowledge(handle) };
    return { nodes: [...host.knowledge.keys()].map((path) => ({ kind: 'doc', path })) };
  });
  host.registerHandler('knowledge.read', async (params) => {
    const { path, baseId } = params as { path: string; baseId?: string };
    if (host.knowledgeAdapter?.read) return { path, content: await host.knowledgeAdapter.read(path, baseId) };
    const handle = baseId ? host.browserKnowledgeHandles.get(baseId) : null;
    if (handle) return { path, content: await readBrowserKnowledge(handle, path) };
    const content = host.knowledge.get(path);
    if (content == null) throw new Error(`knowledge doc not found: ${path}`);
    return { path, content };
  });
  host.registerHandler('knowledge.write', async (params) => {
    const { path, content, baseId } = params as { path: string; content: string; baseId?: string };
    if (host.knowledgeAdapter?.write) {
      await host.knowledgeAdapter.write(path, content, baseId);
      host.publish('knowledge:changed', { path });
      return { written: true, path };
    }
    const handle = baseId ? host.browserKnowledgeHandles.get(baseId) : null;
    if (handle) {
      await writeBrowserKnowledge(handle, path, content);
      host.publish('knowledge:changed', { path });
      return { written: true, path };
    }
    host.knowledge.set(path, content);
    host.publish('knowledge:changed', { path });
    return { written: true, path };
  });
  host.registerHandler('knowledge.link', async (params) => {
    const { from, to, displayText, baseId } = params as { from: string; to: string; displayText?: string; baseId?: string };
    const current = await host.readKnowledgeRaw(from, baseId);
    const link = `[${displayText ?? to}](${to})`;
    await host.writeKnowledgeRaw(from, `${current.replace(/\s*$/, '')}\n\n${link}\n`, baseId);
    host.publish('knowledge:changed', { path: from });
    return { linked: true, from, to };
  });
  host.registerHandler('knowledge.handoff', async (params) => {
    const { summary, nextSteps, context, baseId } = params as { summary: string; nextSteps?: string[]; context?: string[]; baseId?: string };
    const path = `handoffs/${knowledgeDocName(summary)}.md`;
    const body = renderHandoffDoc(summary, nextSteps ?? [], context ?? []);
    await host.writeKnowledgeRaw(path, body, baseId);
    host.publish('knowledge:changed', { path });
    return { written: true, path };
  });
  host.registerHandler('adr.record', async (params) => {
    const { title, body, baseId } = params as { title: string; body?: string; baseId?: string };
    const path = `adrs/${knowledgeDocName(title)}.md`;
    const content = `# ${title}\n\n${body ?? ''}\n`;
    await host.writeKnowledgeRaw(path, content, baseId);
    host.publish('knowledge:changed', { path });
    return { recorded: true, path };
  });
  
  /* tasks */
}
