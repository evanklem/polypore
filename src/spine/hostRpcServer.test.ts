import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { HostRpcServer, PluginLoader, createMemorySecretStore, hostRpcValidatedMethods } from '../../packages/host/src';
import { testPanelManifest } from './testPanel';

describe('HostRpcServer real-data adapters', () => {
  test('all registered host rpc methods have param validators', () => {
    const server = new HostRpcServer();
    const validated = hostRpcValidatedMethods();

    expect(server.registeredMethods().filter((method) => !validated.has(method)).sort()).toEqual([]);
  });

  test('rejects malformed params before dispatching a handler', async () => {
    const server = new HostRpcServer();
    const resize = vi.fn();
    server.setTerminalRunner({
      spawn: vi.fn(async () => ({ id: 'pty-1', command: '', status: 'running', output: '' })),
      resize,
    });

    const response = await server.handle({
      kind: 'request',
      id: 90,
      method: 'terminal.resize',
      params: { id: 'pty-1', cols: 'wide', rows: 24 },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('invalid_params');
      expect(response.error.message).toMatch(/params failed schema validation/i);
    }
    expect(resize).not.toHaveBeenCalled();
  });

  test('resetProjectState clears volatile project stores without dropping configuration', async () => {
    const server = new HostRpcServer({
      chatSessions: [{ id: 'codex-old', agent: 'codex', title: 'old project', createdAt: 1, worktreeId: 'wt-old' }],
      chatMessages: {
        'codex-old': [{ id: 'm-old', sessionId: 'codex-old', by: 'user', ts: 1, text: 'old project question' }],
      },
      diagnostics: [{
        id: 'diag-old',
        severity: 'error',
        source: 'test',
        file: 'old.ts',
        range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
        message: 'old diagnostic',
      }],
      files: { 'old.ts': 'const oldProject = true;\n' },
      historyEvents: [{
        id: 'ev-old',
        ts: 1,
        taskId: 'active',
        source: 'agent',
        kind: 'tool-call',
        affectedFiles: ['old.ts'],
        summary: 'old tool call',
        worktreeId: 'wt-old',
      }],
      tasks: [{ id: 'task-old', label: 'old task', done: false, createdAt: 1, createdBy: 'user' }],
      verifyRuns: [{
        id: 'verify-old',
        label: 'old verify',
        command: 'npm test',
        required: false,
        status: 'pending',
        exitCode: null,
        ranAt: 1,
        output: '',
        durationMs: null,
      }],
      plugins: [{
        id: 'polypore.chat',
        version: '0.1.0',
        enabled: true,
        scope: 'builtin',
        installedAt: 1,
      }],
      skills: [{ id: 'repo-mapper', name: 'repo mapper', summary: 'maps repos' }],
    });
    const resetEvents: unknown[] = [];
    server.subscribe('project:state-reset', (payload) => resetEvents.push(payload));
    server.setActiveWorktreeId('wt-old');

    server.resetProjectState({
      state: { activeAgent: 'codex', contextUsedPct: 0 },
      plugins: [{
        id: 'polypore.chat',
        version: '0.1.0',
        enabled: true,
        scope: 'builtin',
        installedAt: 1,
      }],
      skills: [{ id: 'repo-mapper', name: 'repo mapper', summary: 'maps repos' }],
    });

    const chatSessions = await server.handle({ kind: 'request', id: 31, method: 'chat.sessions', params: {} });
    const chatHistory = await server.handle({ kind: 'request', id: 32, method: 'chat.history', params: { sessionId: 'codex-old' } });
    const diagnostics = await server.handle({ kind: 'request', id: 33, method: 'diagnostics.list', params: {} });
    const tasks = await server.handle({ kind: 'request', id: 34, method: 'tasks.list', params: {} });
    const verify = await server.handle({ kind: 'request', id: 35, method: 'verify.runs', params: {} });
    const history = await server.handle({ kind: 'request', id: 36, method: 'history.events', params: {} });
    const oldFile = await server.handle({ kind: 'request', id: 37, method: 'editor.read', params: { path: 'old.ts' } });
    const plugins = await server.handle({ kind: 'request', id: 38, method: 'plugins.list', params: {} });
    const skills = await server.handle({ kind: 'request', id: 39, method: 'skills.list', params: {} });
    const debug = await server.handle({ kind: 'request', id: 40, method: 'debug.state', params: {} });

    expect(resetEvents).toHaveLength(1);
    expect(server.getActiveWorktreeId()).toBe('main');
    expect(chatSessions.ok).toBe(true);
    expect(chatHistory.ok).toBe(true);
    expect(diagnostics.ok).toBe(true);
    expect(tasks.ok).toBe(true);
    expect(verify.ok).toBe(true);
    expect(history.ok).toBe(true);
    expect(oldFile.ok).toBe(false);
    expect(plugins.ok).toBe(true);
    expect(skills.ok).toBe(true);
    expect(debug.ok).toBe(true);
    if (chatSessions.ok) expect(chatSessions.result).toEqual({ sessions: [] });
    if (chatHistory.ok) expect(chatHistory.result).toEqual({ sessionId: 'codex-old', messages: [] });
    if (diagnostics.ok) expect(diagnostics.result).toEqual({ diagnostics: [] });
    if (tasks.ok) expect(tasks.result).toEqual({ tasks: [] });
    if (verify.ok) expect(verify.result).toEqual({ runs: [] });
    if (history.ok) expect(history.result).toEqual({ events: [] });
    if (plugins.ok) expect(plugins.result).toEqual({
      plugins: [expect.objectContaining({ id: 'polypore.chat', enabled: true })],
    });
    if (skills.ok) expect(skills.result).toEqual({
      skills: [expect.objectContaining({ id: 'repo-mapper' })],
    });
    if (debug.ok) expect(debug.result).toMatchObject({ session: null, timeline: [], status: 'idle' });
  });

  test('chat.send passes prior turns to the agent dispatcher and stores the final answer', async () => {
    const transcripts: Array<Array<{ by: 'user' | 'agent' | 'tool'; text: string }>> = [];
    const server = new HostRpcServer({
      chatSessions: [{ id: 'codex-main', agent: 'codex', title: 'codex', createdAt: 1 }],
      chatMessages: {
        'codex-main': [
          { id: 'm1', sessionId: 'codex-main', by: 'user', ts: 1, text: 'First question?' },
          { id: 'm2', sessionId: 'codex-main', by: 'agent', ts: 2, text: 'First answer.' },
        ],
      },
    });
    server.setAgentDispatcher(async ({ transcript }) => {
      transcripts.push(transcript);
      return {
        adapter: 'stdio',
        responseText: 'Second answer with:\n- a list\n- another item',
        events: [{ kind: 'tool-call', toolName: 'read', summary: 'read files' }],
        streamed: false,
      };
    });

    const response = await server.handle({
      kind: 'request',
      id: 10,
      method: 'chat.send',
      params: { sessionId: 'codex-main', text: 'Second question?' },
    });
    const history = await server.handle({
      kind: 'request',
      id: 11,
      method: 'chat.history',
      params: { sessionId: 'codex-main' },
    });

    expect(response.ok).toBe(true);
    expect(transcripts[0]).toEqual([
      { by: 'user', text: 'First question?' },
      { by: 'agent', text: 'First answer.' },
      { by: 'user', text: 'Second question?' },
    ]);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.result).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({ by: 'agent', text: expect.stringContaining('- a list') }),
        ]),
      });
    }
  });

  test('agent runtime events stay bound to the session worktree', async () => {
    const writes: string[] = [];
    const server = new HostRpcServer({
      chatSessions: [{ id: 'codex-wt-a', agent: 'codex', title: 'codex', createdAt: 1, worktreeId: 'wt-a' }],
    });
    server.setActiveWorktreeId('wt-b');
    server.setHistoryAdapter({
      signalWrite: (worktreeId) => writes.push(worktreeId),
    });

    server.recordAgentRuntimeEvent({
      agent: 'codex',
      adapter: 'stdio',
      sessionId: 'codex-wt-a',
      event: { kind: 'tool-call', toolName: 'edit', summary: 'edited files' },
    });

    const wtAEvents = await server.handle({
      kind: 'request',
      id: 13,
      method: 'history.events',
      params: { worktreeId: 'wt-a' },
    });
    const wtBEvents = await server.handle({
      kind: 'request',
      id: 14,
      method: 'history.events',
      params: { worktreeId: 'wt-b' },
    });

    expect(writes).toEqual(['wt-a']);
    expect(wtAEvents.ok).toBe(true);
    expect(wtBEvents.ok).toBe(true);
    if (wtAEvents.ok && wtBEvents.ok) {
      expect(wtAEvents.result).toMatchObject({
        events: [expect.objectContaining({ worktreeId: 'wt-a', payload: { sessionId: 'codex-wt-a' } })],
      });
      expect(wtBEvents.result).toMatchObject({ events: [] });
    }
  });

  test('agent.commands returns agent-native commands and project skills for the active runtime', async () => {
    const server = new HostRpcServer({
      skills: [{ id: 'repo-mapper', name: 'repo mapper', summary: 'maps repository structure' }],
    });
    server.setAgentCommandProvider(async (agent) => [
      { command: '/goal ', title: 'goal', detail: `set ${agent} goal`, source: 'agent', agent },
    ]);

    const response = await server.handle({
      kind: 'request',
      id: 12,
      method: 'agent.commands',
      params: { agent: 'claude' },
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toMatchObject({
        agent: 'claude',
        commands: expect.arrayContaining([
          expect.objectContaining({ command: '/goal ', source: 'agent', agent: 'claude' }),
          expect.objectContaining({ command: '/repo-mapper', source: 'skill', agent: 'claude' }),
        ]),
      });
    }
  });

  test('editor.tree delegates to the filesystem adapter when available', async () => {
    const server = new HostRpcServer({
      fileTree: [{ kind: 'file', name: 'initial.ts', path: 'initial.ts' }],
    });
    server.setFileSystemAdapter({
      listTree: async () => [{ kind: 'file', name: 'real.ts', path: 'src/real.ts' }],
    });

    const response = await server.handle({
      kind: 'request',
      id: 1,
      method: 'editor.tree',
      params: {},
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toEqual({
        tree: [{ kind: 'file', name: 'real.ts', path: 'src/real.ts' }],
      });
    }
  });

  test('editor.listDir delegates one directory level to the filesystem adapter', async () => {
    const server = new HostRpcServer({});
    server.setFileSystemAdapter({
      listDir: async (path) => [
        { kind: 'folder', name: 'nested', children: [] },
        { kind: 'file', name: 'app.ts', path: `${path}/app.ts` },
      ],
    });

    const response = await server.handle({
      kind: 'request',
      id: 1,
      method: 'editor.listDir',
      params: { path: 'src' },
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toEqual({
        tree: [
          { kind: 'folder', name: 'nested', children: [] },
          { kind: 'file', name: 'app.ts', path: 'src/app.ts' },
        ],
      });
    }
  });

  test('editor.listFiles delegates the workspace index to the filesystem adapter', async () => {
    const server = new HostRpcServer({});
    server.setFileSystemAdapter({
      listFiles: async () => ['README.md', 'src/deep/nested/leaf.rs'],
    });

    const response = await server.handle({
      kind: 'request',
      id: 1,
      method: 'editor.listFiles',
      params: {},
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toEqual({ files: ['README.md', 'src/deep/nested/leaf.rs'] });
    }
  });

  test('ui.openExternal delegates to the configured external opener', async () => {
    const opened: string[] = [];
    const server = new HostRpcServer();
    server.setExternalOpener(async (url) => {
      opened.push(url);
      return true;
    });

    const response = await server.handle({
      kind: 'request',
      id: 22,
      method: 'ui.openExternal',
      params: { url: 'http://127.0.0.1:1420' },
    });

    expect(response.ok).toBe(true);
    if (response.ok) expect(response.result).toEqual({ opened: true });
    expect(opened).toEqual(['http://127.0.0.1:1420']);
  });

  test('editor.applyEdit updates in-memory files with typed text edits', async () => {
    const server = new HostRpcServer({
      files: { 'src/app.ts': 'const value = 1;\nconsole.log(value);\n' },
    });

    const edited = await server.handle({
      kind: 'request',
      id: 19,
      method: 'editor.applyEdit',
      params: {
        path: 'src/app.ts',
        edits: [{
          range: { start: { line: 0, column: 14 }, end: { line: 0, column: 15 } },
          newText: '2',
        }],
      },
    });
    const read = await server.handle({
      kind: 'request',
      id: 20,
      method: 'editor.read',
      params: { path: 'src/app.ts' },
    });

    expect(edited.ok).toBe(true);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.result).toMatchObject({ content: 'const value = 2;\nconsole.log(value);\n' });
  });

  test('editor.applyEdit writes typed full-document edits through the filesystem adapter', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const server = new HostRpcServer();
    server.setFileSystemAdapter({
      readText: async () => 'old',
      writeText: async (path, content) => { writes.push({ path, content }); },
    });

    const response = await server.handle({
      kind: 'request',
      id: 21,
      method: 'editor.applyEdit',
      params: {
        path: 'notes.md',
        edits: [{
          range: { start: { line: 0, column: 0 }, end: { line: 0, column: 3 } },
          newText: 'new',
        }],
      },
    });

    expect(response.ok).toBe(true);
    expect(writes).toEqual([{ path: 'notes.md', content: 'new' }]);
  });

  test('knowledge calls delegate to the knowledge adapter when available', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const server = new HostRpcServer({ knowledge: { 'memory.md': 'in-memory' } });
    server.setKnowledgeAdapter({
      list: async () => [{ kind: 'doc', path: 'real.md' }],
      read: async (path) => `disk:${path}`,
      write: async (path, content) => { writes.push({ path, content }); },
    });

    const list = await server.handle({ kind: 'request', id: 2, method: 'knowledge.list', params: {} });
    const read = await server.handle({ kind: 'request', id: 3, method: 'knowledge.read', params: { path: 'real.md' } });
    const write = await server.handle({ kind: 'request', id: 4, method: 'knowledge.write', params: { path: 'real.md', content: 'updated' } });

    expect(list.ok).toBe(true);
    expect(read.ok).toBe(true);
    expect(write.ok).toBe(true);
    if (list.ok) expect(list.result).toEqual({ nodes: [{ kind: 'doc', path: 'real.md' }] });
    if (read.ok) expect(read.result).toEqual({ path: 'real.md', content: 'disk:real.md' });
    expect(writes).toEqual([{ path: 'real.md', content: 'updated' }]);
  });

  test('task calls delegate to the task adapter when available', async () => {
    const server = new HostRpcServer();
    const task = {
      id: 'task-1',
      label: 'persisted task',
      done: false,
      createdAt: 1,
      createdBy: 'user' as const,
    };
    server.setTaskAdapter({
      list: async () => [task],
      add: async (input) => ({ ...task, id: 'task-2', label: input.label }),
      update: async (id, patch) => ({ ...task, id, ...patch }),
    });

    const list = await server.handle({ kind: 'request', id: 5, method: 'tasks.list', params: {} });
    const add = await server.handle({ kind: 'request', id: 6, method: 'tasks.add', params: { label: 'new task' } });
    const update = await server.handle({ kind: 'request', id: 7, method: 'tasks.update', params: { id: 'task-1', patch: { done: true } } });

    expect(list.ok).toBe(true);
    expect(add.ok).toBe(true);
    expect(update.ok).toBe(true);
    if (list.ok) expect(list.result).toEqual({ tasks: [task] });
    if (add.ok) expect(add.result).toMatchObject({ task: { id: 'task-2', label: 'new task' } });
    if (update.ok) expect(update.result).toMatchObject({ task: { id: 'task-1', done: true } });
  });

  test('verify calls delegate to the verify adapter when available', async () => {
    const run = {
      id: 'typecheck',
      label: 'typecheck',
      command: 'npm run typecheck',
      required: true,
      status: 'ok' as const,
      exitCode: 0,
      ranAt: 1,
      output: 'clean',
      durationMs: 10,
    };
    const server = new HostRpcServer();
    server.setVerifyAdapter({
      runs: async () => [run],
      run: async (id) => ({ ...run, id, ranAt: 2 }),
    });

    const list = await server.handle({ kind: 'request', id: 8, method: 'verify.runs', params: {} });
    const executed = await server.handle({ kind: 'request', id: 9, method: 'verify.run', params: { id: 'typecheck' } });

    expect(list.ok).toBe(true);
    expect(executed.ok).toBe(true);
    if (list.ok) expect(list.result).toEqual({ runs: [run] });
    if (executed.ok) expect(executed.result).toMatchObject({ run: { id: 'typecheck', ranAt: 2 } });
  });

  test('skills.write accepts mcp update payloads without losing the skill name', async () => {
    const server = new HostRpcServer({
      skills: [{ id: 'repo-mapper', name: 'repo mapper', summary: 'old summary' }],
    });

    const write = await server.handle({
      kind: 'request',
      id: 12,
      method: 'skills.write',
      params: { id: 'repo-mapper', body: '# repo mapper\n\nmap project structure quickly.' },
    });
    const read = await server.handle({
      kind: 'request',
      id: 13,
      method: 'skills.read',
      params: { id: 'repo-mapper' },
    });

    expect(write.ok).toBe(true);
    expect(read.ok).toBe(true);
    if (write.ok) {
      expect(write.result).toMatchObject({
        skill: {
          id: 'repo-mapper',
          name: 'repo mapper',
          summary: 'old summary',
          body: expect.stringContaining('map project structure'),
        },
      });
    }
    if (read.ok) {
      expect(read.result).toMatchObject({
        skill: { id: 'repo-mapper', name: 'repo mapper' },
      });
    }
  });

  test('skills.delete removes existing skills and fails for missing ids', async () => {
    const server = new HostRpcServer({
      skills: [{ id: 'repo-mapper', name: 'repo mapper', summary: 'maps repos' }],
    });

    const deleted = await server.handle({
      kind: 'request',
      id: 16,
      method: 'skills.delete',
      params: { id: 'repo-mapper' },
    });
    const missing = await server.handle({
      kind: 'request',
      id: 17,
      method: 'skills.delete',
      params: { id: 'repo-mapper' },
    });
    const list = await server.handle({
      kind: 'request',
      id: 18,
      method: 'skills.list',
      params: {},
    });

    expect(deleted.ok).toBe(true);
    if (deleted.ok) expect(deleted.result).toEqual({ deleted: true, id: 'repo-mapper' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toContain('skill not found');
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.result).toEqual({ skills: [] });
  });

  test('secrets.has respects user and project scope', async () => {
    const store = createMemorySecretStore();
    store.set({ id: 'api-key', value: 'user-secret', scope: 'user', service: 'test' });
    store.set({ id: 'api-key', value: 'project-secret', scope: 'project', service: 'test' });
    const server = new HostRpcServer();
    server.setSecretStore(store);

    const user = await server.handle({
      kind: 'request',
      id: 23,
      method: 'secrets.has',
      params: { id: 'api-key', scope: 'user' },
    });
    const project = await server.handle({
      kind: 'request',
      id: 24,
      method: 'secrets.has',
      params: { id: 'api-key', scope: 'project' },
    });
    store.delete('api-key', 'project');
    const missingProject = await server.handle({
      kind: 'request',
      id: 25,
      method: 'secrets.has',
      params: { id: 'api-key', scope: 'project' },
    });
    const stillUser = await server.handle({
      kind: 'request',
      id: 26,
      method: 'secrets.has',
      params: { id: 'api-key', scope: 'user' },
    });

    expect(user.ok).toBe(true);
    expect(project.ok).toBe(true);
    expect(missingProject.ok).toBe(true);
    expect(stillUser.ok).toBe(true);
    if (user.ok) expect(user.result).toMatchObject({ id: 'api-key', scope: 'user', has: true });
    if (project.ok) expect(project.result).toMatchObject({ id: 'api-key', scope: 'project', has: true });
    if (missingProject.ok) expect(missingProject.result).toMatchObject({ id: 'api-key', scope: 'project', has: false });
    if (stillUser.ok) expect(stillUser.result).toMatchObject({ id: 'api-key', scope: 'user', has: true });
  });

  test('plugin mutations fail when the plugin id is unknown', async () => {
    const server = new HostRpcServer({
      plugins: [{
        id: 'polypore.chat',
        version: '0.1.0',
        enabled: true,
        scope: 'project',
        source: 'local',
        installedAt: 1,
      }],
    });

    const disable = await server.handle({
      kind: 'request',
      id: 14,
      method: 'plugins.disable',
      params: { id: 'missing.plugin' },
    });
    const uninstall = await server.handle({
      kind: 'request',
      id: 15,
      method: 'plugins.uninstall',
      params: { id: 'missing.plugin' },
    });

    expect(disable.ok).toBe(false);
    expect(uninstall.ok).toBe(false);
    if (!disable.ok) expect(disable.error.message).toContain('plugin not found');
    if (!uninstall.ok) expect(uninstall.error.message).toContain('plugin not found');
  });

  test('plugins.install carries manifest + entryUrl through to the listed ref', async () => {
    const server = new HostRpcServer();
    const entryUrl = `plugin://${testPanelManifest.id}/index.html`;

    /* the sidecar hands a bare plugin record plus the manifest/entryUrl as
       siblings. the renderer reconstructs a URL-mode iframe panel only when
       both manifest and entryUrl land on the PluginRef. */
    const installed = await server.handle({
      kind: 'request',
      id: 90,
      method: 'plugins.install',
      params: {
        plugin: {
          id: testPanelManifest.id,
          version: '0.1.0',
          scope: 'project',
          enabled: true,
          installedAt: 1,
          source: '/tmp/staged',
          permissions: testPanelManifest.permissions,
        },
        manifest: testPanelManifest,
        scope: 'project',
        entryUrl,
      },
    });

    expect(installed.ok).toBe(true);
    if (installed.ok) {
      const { plugin } = installed.result as { plugin: { manifest?: unknown; entryUrl?: string } };
      expect(plugin.manifest).toEqual(testPanelManifest);
      expect(plugin.entryUrl).toBe(entryUrl);
    }

    const listed = await server.handle({ kind: 'request', id: 91, method: 'plugins.list', params: {} });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const { plugins } = listed.result as { plugins: Array<{ id: string; manifest?: unknown; entryUrl?: string }> };
      const ref = plugins.find((p) => p.id === testPanelManifest.id);
      expect(ref?.manifest).toEqual(testPanelManifest);
      expect(ref?.entryUrl).toBe(entryUrl);
    }
  });

  test('plugins.disable and plugins.uninstall persist through the plugin-store adapter', async () => {
    const server = new HostRpcServer({
      plugins: [{
        id: 'acme.widget',
        version: '1.0.0',
        scope: 'project',
        enabled: true,
        installedAt: 1,
        source: '/installed',
      }],
    });
    const setEnabled = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    server.setPluginStore({ setEnabled, remove });

    const disabled = await server.handle({
      kind: 'request', id: 80, method: 'plugins.disable', params: { id: 'acme.widget' },
    });
    expect(disabled.ok).toBe(true);
    expect(setEnabled).toHaveBeenCalledWith('acme.widget', false);

    const enabled = await server.handle({
      kind: 'request', id: 81, method: 'plugins.enable', params: { id: 'acme.widget' },
    });
    expect(enabled.ok).toBe(true);
    expect(setEnabled).toHaveBeenCalledWith('acme.widget', true);

    const uninstalled = await server.handle({
      kind: 'request', id: 82, method: 'plugins.uninstall', params: { id: 'acme.widget' },
    });
    expect(uninstalled.ok).toBe(true);
    expect(remove).toHaveBeenCalledWith('acme.widget');

    const listed = await server.handle({ kind: 'request', id: 83, method: 'plugins.list', params: {} });
    if (listed.ok) {
      const { plugins } = listed.result as { plugins: Array<{ id: string }> };
      expect(plugins.find((p) => p.id === 'acme.widget')).toBeUndefined();
    }
  });

  test('plugin toggles still succeed without a plugin-store adapter', async () => {
    const server = new HostRpcServer({
      plugins: [{ id: 'acme.widget', version: '1.0.0', scope: 'project', enabled: true, installedAt: 1, source: '/x' }],
    });
    const disabled = await server.handle({
      kind: 'request', id: 84, method: 'plugins.disable', params: { id: 'acme.widget' },
    });
    expect(disabled.ok).toBe(true);
  });

  test('panel.open publishes the requested target area', async () => {
    const server = new HostRpcServer();
    const opened: unknown[] = [];
    server.subscribe('panel:opened', (payload) => opened.push(payload));
    await server.handle({
      kind: 'request',
      id: 19,
      method: 'manifest.register',
      params: {
        manifest: {
          schemaVersion: 1,
          id: 'polypore.problems',
          title: 'problems',
          icon: '!',
          version: '0.1.0',
          entry: 'index.html',
          permissions: ['diagnostics.read'],
          capabilities: [],
          category: 'verify',
        },
      },
    });

    const response = await server.handle({
      kind: 'request',
      id: 20,
      method: 'panel.open',
      params: { id: 'polypore.problems', area: 'bottom' },
    });

    expect(response.ok).toBe(true);
    if (response.ok) expect(response.result).toMatchObject({ area: 'bottom' });
    expect(opened).toEqual([
      expect.objectContaining({ panelId: 'polypore.problems', area: 'bottom' }),
    ]);
  });

  test('diagnostics.document delegates unsaved buffer diagnostics without updating project diagnostics', async () => {
    const server = new HostRpcServer({ diagnostics: [{
      id: 'saved',
      severity: 'error',
      source: 'saved-check',
      file: 'saved.ts',
      range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
      message: 'saved file error',
    }] });
    server.setDiagnosticsDocumentProvider(async (path, content) => [{
      id: 'live',
      severity: 'error',
      source: 'test-lsp',
      file: path,
      range: { start: { line: 1, column: 2 }, end: { line: 1, column: content.length } },
      message: 'unsaved document error',
    }]);

    const response = await server.handle({
      kind: 'request',
      id: 21,
      method: 'diagnostics.document',
      params: { path: 'live.ts', content: 'broken' },
    });
    const saved = await server.handle({
      kind: 'request',
      id: 22,
      method: 'diagnostics.list',
      params: {},
    });

    expect(response.ok).toBe(true);
    if (response.ok) expect(response.result).toEqual({
      diagnostics: [expect.objectContaining({ id: 'live', file: 'live.ts', source: 'test-lsp' })],
    });
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.result).toEqual({
      diagnostics: [expect.objectContaining({ id: 'saved', file: 'saved.ts' })],
    });
  });

  test('ui.notify accepts canonical warning and success levels', async () => {
    const server = new HostRpcServer();

    const warning = await server.handle({
      kind: 'request',
      id: 21,
      method: 'ui.notify',
      params: { level: 'warning', msg: 'careful' },
    });
    const success = await server.handle({
      kind: 'request',
      id: 22,
      method: 'ui.notify',
      params: { level: 'success', msg: 'done' },
    });

    expect(warning.ok).toBe(true);
    expect(success.ok).toBe(true);
    expect(server.listNotifications()).toEqual([
      expect.objectContaining({ level: 'success', msg: 'done' }),
      expect.objectContaining({ level: 'warning', msg: 'careful' }),
    ]);
  });

  test('history.diff delegates to the history adapter when available', async () => {
    const server = new HostRpcServer();
    server.setHistoryAdapter({
      diff: async (request) => ({
        mode: request.mode,
        file: request.file ?? null,
        changedFiles: request.file ? [request.file] : ['src/App.tsx'],
        diff: 'diff --git a/src/App.tsx b/src/App.tsx',
        exitCode: 0,
      }),
    });

    const response = await server.handle({
      kind: 'request',
      id: 5,
      method: 'history.diff',
      params: { mode: 'working', file: 'src/App.tsx' },
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toEqual({
        diff: {
          mode: 'working',
          file: 'src/App.tsx',
          changedFiles: ['src/App.tsx'],
          diff: 'diff --git a/src/App.tsx b/src/App.tsx',
          exitCode: 0,
        },
      });
    }
  });

  test('history.fork delegates to the history adapter when available', async () => {
    const server = new HostRpcServer({
      historyEvents: [{
        id: 'event-1',
        ts: 1,
        taskId: 'active',
        source: 'agent',
        kind: 'tool-call',
        affectedFiles: ['src/App.tsx'],
        summary: 'edited app',
      }],
    });
    server.setHistoryAdapter({
      fork: async (eventId) => ({
        id: 'wt-1',
        path: '/workspace/project-fork',
        branch: 'polypore/fork/event-1',
        forkedFromEventId: eventId,
      }),
    });

    const response = await server.handle({
      kind: 'request',
      id: 6,
      method: 'history.fork',
      params: { eventId: 'event-1' },
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toEqual({
        worktree: {
          id: 'wt-1',
          path: '/workspace/project-fork',
          branch: 'polypore/fork/event-1',
          forkedFromEventId: 'event-1',
        },
      });
    }
  });

  test('worktrees.create delegates to the history adapter', async () => {
    const server = new HostRpcServer();
    server.setHistoryAdapter({
      createWorktree: async ({ branch, path }) => ({
        id: 'wt-ui',
        path: path ?? '/workspace/project-ui',
        branch: branch ?? 'polypore/worktree/ui',
        forkedFromEventId: 'manual',
      }),
    });

    const response = await server.handle({
      kind: 'request',
      id: 61,
      method: 'worktrees.create',
      params: { branch: 'polypore/worktree/ui', path: '/workspace/project-ui' },
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toEqual({
        worktree: {
          id: 'wt-ui',
          path: '/workspace/project-ui',
          branch: 'polypore/worktree/ui',
          forkedFromEventId: 'manual',
        },
      });
    }
  });

  test('history.revert delegates to the history adapter with selected files', async () => {
    const server = new HostRpcServer({
      historyEvents: [{
        id: 'event-2',
        ts: 2,
        taskId: 'active',
        source: 'agent',
        kind: 'file-edit',
        affectedFiles: ['src/App.tsx'],
        summary: 'edited app',
      }],
    });
    server.setHistoryAdapter({
      revert: async (_eventId, files) => ({
        files,
        output: 'restored',
        exitCode: 0,
      }),
    });

    const response = await server.handle({
      kind: 'request',
      id: 7,
      method: 'history.revert',
      params: { eventId: 'event-2', files: ['src/App.tsx'] },
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toEqual({
        reverted: {
          files: ['src/App.tsx'],
          output: 'restored',
          exitCode: 0,
        },
      });
    }
  });
});

describe('PluginLoader manifest permissions', () => {
  function mountTestPlugin(manifest = testPanelManifest) {
    const server = new HostRpcServer({
      files: { 'secret.txt': 'do not leak' },
    });
    const loader = new PluginLoader();
    const iframe = document.createElement('iframe');
    const pluginWindow = { postMessage: vi.fn() };
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: pluginWindow,
    });
    const handle = loader.mount({ iframe, manifest, server });
    const send = (method: string, params: unknown, id = 1) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          __polypore: true,
          pluginId: manifest.id,
          envelope: { kind: 'request', id, method, params },
        },
        source: pluginWindow as unknown as Window,
      }));
    };
    return { handle, pluginWindow, send };
  }

  test('blocks undeclared host methods before they reach the server', async () => {
    const { handle, pluginWindow, send } = mountTestPlugin({
      ...testPanelManifest,
      permissions: ['ui.notify'],
    });

    send('editor.read', { path: 'secret.txt' }, 10);
    await vi.waitFor(() => expect(pluginWindow.postMessage).toHaveBeenCalled());

    expect(pluginWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          ok: false,
          id: 10,
          error: expect.objectContaining({
            code: 'permission_not_declared',
            message: expect.stringContaining('editor.read requires undeclared permission editor.read'),
          }),
        }),
      }),
      '*',
    );
    handle.dispose();
  });

  test('allows declared host methods through the bridge', async () => {
    const { handle, pluginWindow, send } = mountTestPlugin({
      ...testPanelManifest,
      permissions: ['ui.notify'],
    });

    send('ui.notify', { level: 'info', msg: 'hello' }, 11);
    await vi.waitFor(() => expect(pluginWindow.postMessage).toHaveBeenCalled());

    expect(pluginWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          ok: true,
          id: 11,
          result: { shown: true },
        }),
      }),
      '*',
    );
    handle.dispose();
  });

  test('preview manifest declares terminal.write for interactive in-window runs', async () => {
    const manifest = JSON.parse(readFileSync('plugins/preview/polypore.json', 'utf8')) as typeof testPanelManifest;
    const writes: Array<{ id: string; data: string }> = [];
    const server = new HostRpcServer();
    server.setTerminalRunner({
      spawn: async (command) => ({
        id: 'pty-preview',
        command,
        status: 'running',
        output: '',
        pid: null,
        exitCode: null,
      }),
      write: async (id, data) => {
        writes.push({ id, data });
        return true;
      },
    });
    const loader = new PluginLoader();
    const iframe = document.createElement('iframe');
    const pluginWindow = { postMessage: vi.fn() };
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: pluginWindow,
    });
    const handle = loader.mount({ iframe, manifest, server });

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        __polypore: true,
        pluginId: manifest.id,
        envelope: {
          kind: 'request',
          id: 13,
          method: 'terminal.write',
          params: { id: 'pty-preview', data: 'x' },
        },
      },
      source: pluginWindow as unknown as Window,
    }));
    await vi.waitFor(() => expect(pluginWindow.postMessage).toHaveBeenCalled());

    expect(writes).toEqual([{ id: 'pty-preview', data: 'x' }]);
    expect(pluginWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          ok: true,
          id: 13,
        }),
      }),
      '*',
    );
    handle.dispose();
  });

  test('all SDK request methods are permission-gated or explicit lifecycle calls', () => {
    const sdkRuntime = readFileSync('packages/sdk/src/client-runtime.js', 'utf8');
    const pluginLoader = readFileSync('packages/host/src/plugin-loader.ts', 'utf8');
    const requestedMethods = new Set(
      [...sdkRuntime.matchAll(/request\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]),
    );
    const permissionMappedMethods = new Set(
      [...pluginLoader.matchAll(/case\s+['"]([^'"]+)['"]\s*:/g)].map((match) => match[1]),
    );
    const lifecycleMethods = new Set(['plugin.ready']);
    const missing = [...requestedMethods]
      .filter((method) => !permissionMappedMethods.has(method) && !lifecycleMethods.has(method))
      .sort();

    expect(missing).toEqual([]);
  });

  test('blocks privileged SDK methods that used to fall through without permission checks', async () => {
    const { handle, pluginWindow, send } = mountTestPlugin({
      ...testPanelManifest,
      permissions: ['ui.notify'],
    });
    const cases: Array<{ method: string; params: unknown; permission: string }> = [
      { method: 'diagnostics.deepScan', params: {}, permission: 'diagnostics.read' },
      { method: 'worktrees.list', params: {}, permission: 'workspace.read' },
      { method: 'worktrees.create', params: {}, permission: 'workspace.write' },
      { method: 'mcp.discover', params: {}, permission: 'mcp.invoke' },
      { method: 'mcp.servers.upsert', params: { id: 'local', name: 'local', transport: 'http', url: 'http://127.0.0.1' }, permission: 'mcp.invoke' },
      { method: 'formation.upsert', params: { nodes: [], edges: [] }, permission: 'workspace.write' },
    ];

    for (const [index, item] of cases.entries()) {
      pluginWindow.postMessage.mockClear();
      send(item.method, item.params, 100 + index);
      await vi.waitFor(() => expect(pluginWindow.postMessage).toHaveBeenCalled());
      expect(pluginWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          envelope: expect.objectContaining({
            ok: false,
            id: 100 + index,
            error: expect.objectContaining({
              code: 'permission_not_declared',
              message: expect.stringContaining(`${item.method} requires undeclared permission ${item.permission}`),
            }),
          }),
        }),
        '*',
      );
    }

    handle.dispose();
  });

  test('blocks host-internal secret methods from iframe plugins even with secrets.use', async () => {
    const { handle, pluginWindow, send } = mountTestPlugin({
      ...testPanelManifest,
      permissions: ['secrets.use'],
    });
    const cases = [
      { method: 'secrets.reveal', params: { id: 'api-key' } },
      { method: 'secrets.set', params: { id: 'api-key', value: 'secret' } },
      { method: 'secrets.delete', params: { id: 'api-key' } },
    ];

    for (const [index, item] of cases.entries()) {
      pluginWindow.postMessage.mockClear();
      send(item.method, item.params, 200 + index);
      await vi.waitFor(() => expect(pluginWindow.postMessage).toHaveBeenCalled());
      expect(pluginWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          envelope: expect.objectContaining({
            ok: false,
            id: 200 + index,
            error: expect.objectContaining({
              code: 'permission_not_declared',
              message: expect.stringContaining(`${item.method} is not available to iframe plugins`),
            }),
          }),
        }),
        '*',
      );
    }

    handle.dispose();
  });

  test('blocks unmapped iframe plugin methods by default', async () => {
    const { handle, pluginWindow, send } = mountTestPlugin({
      ...testPanelManifest,
      permissions: ['ui.notify', 'secrets.use', 'plugins.write'],
    });

    send('host.internal.futureMethod', {}, 300);
    await vi.waitFor(() => expect(pluginWindow.postMessage).toHaveBeenCalled());

    expect(pluginWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          ok: false,
          id: 300,
          error: expect.objectContaining({
            code: 'permission_not_declared',
            message: expect.stringContaining('host.internal.futureMethod is not available to iframe plugins'),
          }),
        }),
      }),
      '*',
    );
    handle.dispose();
  });

  test('blocks subscriptions to undeclared data topics', async () => {
    const { handle, pluginWindow, send } = mountTestPlugin({
      ...testPanelManifest,
      permissions: ['ui.notify'],
    });

    send('host.subscribe', { topic: 'tasks:changed' }, 12);
    await vi.waitFor(() => expect(pluginWindow.postMessage).toHaveBeenCalled());

    expect(pluginWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          ok: false,
          id: 12,
          error: expect.objectContaining({
            code: 'permission_not_declared',
            message: expect.stringContaining('subscription tasks:changed requires undeclared permission tasks.read'),
          }),
        }),
      }),
      '*',
    );
    handle.dispose();
  });
});

describe('Tauri shell preview policy', () => {
  test('allows local preview URLs to render inside the desktop window', () => {
    const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
      app?: { security?: { csp?: string } };
    };
    const csp = config.app?.security?.csp ?? '';
    const frameSrc = /(?:^|;\s*)frame-src\s+([^;]+)/.exec(csp)?.[1] ?? '';

    expect(frameSrc).toContain('http:');
    expect(frameSrc).toContain('https:');
    expect(frameSrc).toContain('plugin:');
  });
});

describe('HostRpcServer agent-rail hooks', () => {
  test('host_mcp_discover_dispatches_to_registered_discoverer', async () => {
    const server = new HostRpcServer();
    const discoverer = vi.fn().mockResolvedValue({
      servers: [
        { name: 'github', origins: ['claude'], transport: 'http', url: 'https://example/mcp' },
      ],
    });
    server.setMcpDiscoverer(discoverer);

    const response = await server.handle({ kind: 'request', id: 1, method: 'mcp.discover', params: {} });

    expect(response.ok).toBe(true);
    expect(discoverer).toHaveBeenCalledTimes(1);
    if (response.ok) {
      expect(response.result).toMatchObject({ servers: [{ name: 'github', origins: ['claude'] }] });
    }
  });

  test('host_mcp_discover_returns_empty_when_no_discoverer', async () => {
    const server = new HostRpcServer();
    const response = await server.handle({ kind: 'request', id: 1, method: 'mcp.discover', params: {} });
    expect(response.ok).toBe(true);
    if (response.ok) expect(response.result).toEqual({ servers: [] });
  });

  test('host_mcp_test_uses_registered_tester', async () => {
    const server = new HostRpcServer({
      mcpServers: [{ id: 'mcp-1', name: 'github', url: 'https://example/mcp', scope: 'polypore' }],
    });
    const tester = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    server.setMcpTester(tester);

    const response = await server.handle({ kind: 'request', id: 2, method: 'mcp.servers.test', params: { id: 'mcp-1' } });

    expect(response.ok).toBe(true);
    expect(tester).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example/mcp', transport: 'http' }));
    if (response.ok) expect(response.result).toMatchObject({ ok: true, status: 200 });
  });

  test('host_mcp_test_falls_back_to_stub_without_tester', async () => {
    const server = new HostRpcServer({
      mcpServers: [{ id: 'mcp-1', name: 'github', url: 'https://example/mcp', scope: 'polypore' }],
    });
    const response = await server.handle({ kind: 'request', id: 3, method: 'mcp.servers.test', params: { id: 'mcp-1' } });
    expect(response.ok).toBe(true);
    if (response.ok) expect(response.result).toMatchObject({ ok: false, error: expect.stringContaining('desktop shell') });
  });

  test('host_secrets_set_writes_to_store_and_publishes', async () => {
    const store = createMemorySecretStore();
    const server = new HostRpcServer();
    server.setSecretStore(store);
    const decider = vi.fn().mockResolvedValue(true);
    server.setConfirmDecider(decider);
    const published: Array<{ secrets: unknown }> = [];
    server.subscribe('secrets:changed', (payload) => { published.push(payload as { secrets: unknown }); });

    const response = await server.handle({
      kind: 'request',
      id: 4,
      method: 'secrets.set',
      params: { id: 'api-key', value: 'shhh', scope: 'project', service: 'test' },
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toMatchObject({ secret: expect.objectContaining({ id: 'api-key', scope: 'project' }) });
    }
    expect(store.has('api-key', 'project')).toBe(true);
    expect(decider).toHaveBeenCalledWith({
      kind: 'secret-write',
      message: 'write secret "api-key"?',
      details: { id: 'api-key', scope: 'project', service: 'test' },
    });
    expect(JSON.stringify(decider.mock.calls[0][0])).not.toContain('shhh');
    expect(published.length).toBeGreaterThanOrEqual(1);
  });

  test('host_secrets_delete_removes_from_store_and_publishes', async () => {
    const store = createMemorySecretStore();
    store.set({ id: 'api-key', value: 'shhh', scope: 'project', service: 'test' });
    const server = new HostRpcServer();
    server.setSecretStore(store);
    const decider = vi.fn().mockResolvedValue(true);
    server.setConfirmDecider(decider);
    const published: Array<{ secrets: unknown }> = [];
    server.subscribe('secrets:changed', (payload) => { published.push(payload as { secrets: unknown }); });

    const response = await server.handle({
      kind: 'request',
      id: 41,
      method: 'secrets.delete',
      params: { id: 'api-key', scope: 'project' },
    });

    expect(response.ok).toBe(true);
    if (response.ok) expect(response.result).toMatchObject({ removed: true });
    expect(store.has('api-key', 'project')).toBe(false);
    expect(decider).toHaveBeenCalledWith({
      kind: 'secret-delete',
      message: 'delete secret "api-key"?',
      details: { id: 'api-key', scope: 'project' },
    });
    expect(published.length).toBeGreaterThanOrEqual(1);
  });

  test('host_secrets_delete_routes_through_deleter_when_set', async () => {
    const store = createMemorySecretStore();
    store.set({ id: 'api-key', value: 'shhh', scope: 'project', service: 'test' });
    const server = new HostRpcServer();
    server.setSecretStore(store);
    server.setConfirmDecider(() => true);
    const deleter = vi.fn().mockResolvedValue(true);
    server.setSecretDeleter(deleter);

    const response = await server.handle({
      kind: 'request',
      id: 42,
      method: 'secrets.delete',
      params: { id: 'api-key', scope: 'project' },
    });

    expect(response.ok).toBe(true);
    expect(deleter).toHaveBeenCalledWith({ id: 'api-key', scope: 'project' });
    /* store is mirrored so the masked list updates immediately */
    expect(store.has('api-key', 'project')).toBe(false);
  });

  test('host_secrets_mutations_are_denied_without_confirmation', async () => {
    const store = createMemorySecretStore();
    store.set({ id: 'api-key', value: 'shhh', scope: 'project', service: 'test' });
    const server = new HostRpcServer();
    server.setSecretStore(store);
    server.setConfirmDecider(() => false);

    const set = await server.handle({
      kind: 'request',
      id: 43,
      method: 'secrets.set',
      params: { id: 'api-key', value: 'new-secret', scope: 'project', service: 'test' },
    });
    const deleted = await server.handle({
      kind: 'request',
      id: 44,
      method: 'secrets.delete',
      params: { id: 'api-key', scope: 'project' },
    });

    expect(set.ok).toBe(false);
    expect(deleted.ok).toBe(false);
    if (!set.ok) expect(set.error.message).toMatch(/secret write denied/i);
    if (!deleted.ok) expect(deleted.error.message).toMatch(/secret delete denied/i);
    expect(store.reveal('api-key', 'project')).toBe('shhh');
  });

  test('host_secrets_set_throws_when_no_store_or_writer', async () => {
    const server = new HostRpcServer();
    const response = await server.handle({
      kind: 'request',
      id: 5,
      method: 'secrets.set',
      params: { id: 'x', value: 'y' },
    });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.message).toMatch(/secret store/i);
  });

  test('host_secrets_reveal_calls_confirm_decider', async () => {
    const store = createMemorySecretStore();
    store.set({ id: 'api-key', value: 'plain', scope: 'project', service: 'test' });
    const server = new HostRpcServer();
    server.setSecretStore(store);
    const decider = vi.fn().mockResolvedValue(true);
    server.setConfirmDecider(decider);

    const response = await server.handle({
      kind: 'request',
      id: 6,
      method: 'secrets.reveal',
      params: { id: 'api-key', scope: 'project' },
    });

    expect(response.ok).toBe(true);
    expect(decider).toHaveBeenCalledWith(expect.objectContaining({ kind: 'secret-reveal' }));
    if (response.ok) expect(response.result).toMatchObject({ value: 'plain', configured: true });
  });

  test('host_secrets_reveal_rejection_returns_null_value', async () => {
    const store = createMemorySecretStore();
    store.set({ id: 'api-key', value: 'plain', scope: 'project', service: 'test' });
    const server = new HostRpcServer();
    server.setSecretStore(store);
    server.setConfirmDecider(() => false);

    const response = await server.handle({
      kind: 'request',
      id: 7,
      method: 'secrets.reveal',
      params: { id: 'api-key', scope: 'project' },
    });

    expect(response.ok).toBe(true);
    if (response.ok) expect(response.result).toEqual({ value: null, configured: true });
  });

  test('host_secrets_reveal_uses_registered_revealer_when_set', async () => {
    const server = new HostRpcServer();
    server.setConfirmDecider(() => true);
    const revealer = vi.fn().mockResolvedValue({ value: 'from-keyring', configured: true });
    server.setSecretRevealer(revealer);

    const response = await server.handle({
      kind: 'request',
      id: 8,
      method: 'secrets.reveal',
      params: { id: 'api-key', scope: 'user' },
    });

    expect(response.ok).toBe(true);
    expect(revealer).toHaveBeenCalledWith({ id: 'api-key', scope: 'user' });
    if (response.ok) expect(response.result).toEqual({ value: 'from-keyring', configured: true });
  });
});

describe('HostRpcServer agent control surface (completeness)', () => {
  async function call(server: HostRpcServer, method: string, params: Record<string, unknown> = {}) {
    const response = await server.handle({ kind: 'request', id: 1, method, params });
    if (!response.ok) throw new Error(`${method} failed: ${response.error.message}`);
    return response.result as Record<string, unknown>;
  }

  test('editor.search scans in-memory buffers when no adapter is bound', async () => {
    const server = new HostRpcServer({
      files: { 'a.ts': 'const needle = 1;\nconst hay = 2;\n', 'b.ts': 'no match here\n' },
    });
    const result = await call(server, 'editor.search', { query: 'needle' });
    const matches = result.matches as Array<{ file: string; line: number }>;
    expect(matches).toEqual([{ file: 'a.ts', line: 1, text: 'const needle = 1;' }]);
  });

  test('editor.search honors regex and limit', async () => {
    const server = new HostRpcServer({ files: { 'a.ts': 'foo1\nfoo2\nfoo3\n' } });
    const result = await call(server, 'editor.search', { query: 'foo\\d', regex: true, limit: 2 });
    expect((result.matches as unknown[]).length).toBe(2);
  });

  test('workspace.describe reports workspace, active panel, and available panels', async () => {
    const server = new HostRpcServer({ state: { workspace: 'Default', activePanel: 'polypore.editor' } });
    const result = await call(server, 'workspace.describe');
    expect(result.workspace).toBe('Default');
    expect(result.activePanel).toBe('polypore.editor');
    expect(Array.isArray(result.panels)).toBe(true);
  });

  test('skills.invoke delivers the skill body into a chat session as a header-prefixed turn', async () => {
    const server = new HostRpcServer({
      skills: [{ id: 'ship-it', name: 'ship it', summary: 'deploy flow', body: 'Run the deploy checklist.' }],
    });
    const result = await call(server, 'skills.invoke', { id: 'ship-it', sessionId: 'codex-1' });
    expect(result.delivered).toBe(true);
    const history = await call(server, 'chat.history', { sessionId: 'codex-1' });
    const messages = history.messages as Array<{ by: string; text: string }>;
    expect(messages.some((m) => m.by === 'user' && m.text.includes('# Skill: ship it') && m.text.includes('Run the deploy checklist.'))).toBe(true);
  });

  test('skills.invoke without a session still resolves the body and does not deliver', async () => {
    const server = new HostRpcServer({ skills: [{ id: 's', name: 's', summary: '', body: 'B' }] });
    const result = await call(server, 'skills.invoke', { id: 's' });
    expect(result.delivered).toBe(false);
    expect(String(result.text)).toContain('B');
  });

  test('skills.invoke rejects an unknown skill', async () => {
    const server = new HostRpcServer();
    const response = await server.handle({ kind: 'request', id: 1, method: 'skills.invoke', params: { id: 'nope' } });
    expect(response.ok).toBe(false);
  });

  test('workflow.update and phase.report write readable state', async () => {
    const server = new HostRpcServer();
    await call(server, 'workflow.update', { nodes: [{ id: 'a' }], edges: [] });
    const workflow = await call(server, 'state.get', { key: 'workflow' });
    expect((workflow.value as { nodes: unknown[] }).nodes.length).toBe(1);

    await call(server, 'phase.report', { phase: 'build', status: 'active' });
    await call(server, 'phase.report', { phase: 'review', status: 'pending' });
    const phase = await call(server, 'state.get', { key: 'phase' });
    const value = phase.value as { current: string; phases: Array<{ phase: string }> };
    expect(value.current).toBe('review');
    expect(value.phases.map((p) => p.phase).sort()).toEqual(['build', 'review']);
  });

  test('knowledge.handoff and adr.record write real documents', async () => {
    const server = new HostRpcServer();
    const handoff = await call(server, 'knowledge.handoff', { summary: 'context full', nextSteps: ['resume X'] });
    const handoffDoc = await call(server, 'knowledge.read', { path: handoff.path as string });
    expect(String(handoffDoc.content)).toContain('context full');
    expect(String(handoffDoc.content)).toContain('resume X');

    const adr = await call(server, 'adr.record', { title: 'use rusqlite', body: 'over tauri-plugin-sql' });
    const adrDoc = await call(server, 'knowledge.read', { path: adr.path as string });
    expect(String(adrDoc.content)).toContain('# use rusqlite');
  });

  test('knowledge.link appends a markdown link to the source doc', async () => {
    const server = new HostRpcServer({ knowledge: { 'a.md': '# A\n' } });
    await call(server, 'knowledge.link', { from: 'a.md', to: 'b.md', displayText: 'see B' });
    const doc = await call(server, 'knowledge.read', { path: 'a.md' });
    expect(String(doc.content)).toContain('[see B](b.md)');
  });

  test('tasks.update toggles done state', async () => {
    const server = new HostRpcServer();
    const added = await call(server, 'tasks.add', { label: 'do thing' });
    const id = (added.task as { id: string }).id;
    await call(server, 'tasks.update', { id, patch: { done: true } });
    const listed = await call(server, 'tasks.list');
    const tasks = listed.tasks as Array<{ id: string; done?: boolean; status?: string }>;
    const updated = tasks.find((t) => t.id === id);
    expect(updated?.done ?? updated?.status === 'done').toBeTruthy();
  });
});
