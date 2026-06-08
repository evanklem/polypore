import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import App from './App';
import { Launcher } from './Launcher';
import { getWorkspacePreset } from './workspaces/presets';
import { GitMenu } from './components/topbar/GitMenu';
import { HostRpcServer } from '../packages/host/src';
import { createLoopbackHost } from '../packages/sdk/src/host';
import { PreviewPanel } from '../plugins/preview/component';
import { DiffHistoryPanel } from '../plugins/diff-history/component';
import { DebugPanel } from '../plugins/debug/component';
import { MemoryPanel } from '../plugins/memory/component';
import { ProblemsPanel } from '../plugins/problems/component';
import { EditorPanel, projectLanguageForPath } from '../plugins/editor/component';
import type { Diagnostic } from '../packages/sdk/src';

function chatPluginSource(): Window {
  const frame = document.createElement('iframe');
  frame.className = 'plugin-iframe';
  frame.title = 'polypore.chat';
  document.body.appendChild(frame);
  expect(frame.contentWindow).toBeTruthy();
  return frame.contentWindow!;
}

function fireLegacyChatMessage(data: { type: string; toolId?: string; agent?: string }) {
  fireEvent(window, new MessageEvent('message', {
    data: { source: 'polypore.chat', ...data },
    source: chatPluginSource(),
  }));
}

test('launcher shows the project picker immediately on boot', () => {
  render(<Launcher onOpen={vi.fn()} />);

  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByRole('main', { name: /polypore project launcher/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /open folder/i })).toBeEnabled();
});

test('confirm decider cleanup restores a deny default', async () => {
  const spy = vi.spyOn(HostRpcServer.prototype, 'setConfirmDecider');

  try {
    const { unmount } = render(<App />);
    unmount();

    const cleanupDecider = spy.mock.calls.at(-1)?.[0];
    expect(cleanupDecider).toBeTypeOf('function');
    const decision = cleanupDecider
      ? await Promise.resolve(cleanupDecider({ kind: 'generic', message: 'cleanup probe' }))
      : true;
    expect(decision).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

test('mcp host rpc listener denies disallowed methods in the renderer', async () => {
  const previousTauri = (window as typeof window & { __TAURI__?: unknown }).__TAURI__;
  const listeners = new Map<string, (message: { payload: unknown }) => unknown>();
  const invoke = vi.fn(async (command: string) => {
    if (command === 'project_status') return { path: '', name: 'polypore', branch: 'main', dirty: false };
    if (command === 'project_recent') return [];
    if (command === 'project_recent_list') return [];
    if (command === 'project_agent_status') return [];
    return null;
  });
  const listen = vi.fn((event: string, handler: (message: { payload: unknown }) => unknown) => {
    listeners.set(event, handler);
    return Promise.resolve(vi.fn());
  });
  Object.defineProperty(window, '__TAURI__', {
    configurable: true,
    value: { core: { invoke }, event: { listen } },
  });

  try {
    const { unmount } = render(<App />);
    await waitFor(() => expect(listen).toHaveBeenCalledWith('polypore://mcp-host-rpc', expect.any(Function)));

    await listeners.get('polypore://mcp-host-rpc')?.({
      payload: { id: 'rpc-1', method: 'secrets.reveal', params: { id: 'api-key' } },
    });

    expect(invoke).toHaveBeenCalledWith('mcp_host_rpc_respond', {
      id: 'rpc-1',
      response: expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          message: expect.stringContaining('mcp host broker method not allowed: secrets.reveal'),
        }),
      }),
    });
    unmount();
  } finally {
    Object.defineProperty(window, '__TAURI__', {
      configurable: true,
      value: previousTauri,
    });
  }
});

test('boot launcher can select a browser folder when desktop shell is unavailable', async () => {
  const onOpen = vi.fn();
  const handle = { kind: 'directory' as const, name: 'client-app' };
  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value: vi.fn().mockResolvedValue(handle),
  });

  render(<Launcher onOpen={onOpen} />);

  fireEvent.click(screen.getByRole('button', { name: /open folder/i }));

  await waitFor(() => expect(onOpen).toHaveBeenCalledWith({
    path: 'browser://client-app',
    name: 'client-app',
  }));
  expect((window as typeof window & {
    __POLYPORE_BROWSER_PROJECTS__?: Map<string, unknown>;
  }).__POLYPORE_BROWSER_PROJECTS__?.has('browser://client-app')).toBe(true);

  Reflect.deleteProperty(window, 'showDirectoryPicker');
});

test('selecting a project shows a workspace loading screen while panels mount', async () => {
  const handle = { kind: 'directory' as const, name: 'visual-project' };
  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value: vi.fn().mockResolvedValue(handle),
  });

  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: /open folder/i }));

  await waitFor(() => expect(screen.getByText(/forming workspace/i)).toBeInTheDocument());
  await waitFor(() => expect(screen.queryByText(/forming workspace/i)).not.toBeInTheDocument());

  Reflect.deleteProperty(window, 'showDirectoryPicker');
});

test('new-project wizard creates a blank browser folder through the selected parent handle', async () => {
  const onOpen = vi.fn();
  const writes: string[] = [];
  const child = {
    kind: 'directory' as const,
    name: 'new-tool',
    getFileHandle: vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({
        write: vi.fn(async (value: string) => { writes.push(value); }),
        close: vi.fn(async () => {}),
      }),
    }),
  };
  const parent = {
    kind: 'directory' as const,
    name: 'projects',
    getDirectoryHandle: vi.fn().mockResolvedValue(child),
  };
  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value: vi.fn().mockResolvedValue(parent),
  });

  render(<Launcher onOpen={onOpen} initialMode="new" />);

  fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'new-tool' } });
  fireEvent.click(screen.getByRole('button', { name: /browse/i }));
  await waitFor(() => expect(screen.getByDisplayValue('browser://projects')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /create project/i }));

  await waitFor(() => expect(parent.getDirectoryHandle).toHaveBeenCalledWith('new-tool', { create: true }));
  const gitignore = writes.join('\n');
  expect(gitignore).toContain('node_modules/');
  expect(gitignore).toContain('target/');
  expect(gitignore).toContain('__pycache__/');
  expect(onOpen).toHaveBeenCalledWith({ path: 'browser://new-tool', name: 'new-tool' });

  Reflect.deleteProperty(window, 'showDirectoryPicker');
});

test('new-project wizard orders template categories without privileging web stacks', async () => {
  const previousTauri = (window as typeof window & { __TAURI__?: unknown }).__TAURI__;
  const templates = [
    { id: 'web', label: 'web app', category: 'web frontend', language: 'typescript', summary: 'web', command: 'x', requires: 'x' },
    { id: 'blank', label: 'blank folder', category: 'general', language: 'any', summary: 'blank', command: 'blank', requires: '' },
    { id: 'python', label: 'python', category: 'python', language: 'python', summary: 'python', command: 'x', requires: 'x' },
    { id: 'elixir', label: 'elixir', category: 'beam', language: 'elixir', summary: 'elixir', command: 'x', requires: 'x' },
  ];
  Object.defineProperty(window, '__TAURI__', {
    configurable: true,
    value: {
      core: {
        invoke: vi.fn(async (command: string) => {
          if (command === 'project_recent_list') return [];
          if (command === 'project_templates') return templates;
          return null;
        }),
      },
    },
  });

  try {
    render(<Launcher onOpen={vi.fn()} initialMode="new" />);

    await screen.findByText('web frontend');
    const listbox = screen.getByRole('listbox', { name: /project templates/i });
    const headings = within(listbox).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['general', 'beam', 'python', 'web frontend']);
  } finally {
    Object.defineProperty(window, '__TAURI__', {
      configurable: true,
      value: previousTauri,
    });
  }
});

test('new-project wizard rejects names that do not start with a letter or number', async () => {
  const onOpen = vi.fn();
  const parent = {
    kind: 'directory' as const,
    name: 'projects',
    getDirectoryHandle: vi.fn(),
  };
  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value: vi.fn().mockResolvedValue(parent),
  });

  render(<Launcher onOpen={onOpen} initialMode="new" />);

  fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: '-new-tool' } });
  fireEvent.click(screen.getByRole('button', { name: /browse/i }));

  await waitFor(() => expect(screen.getByDisplayValue('browser://projects')).toBeInTheDocument());
  expect(screen.getByText(/start with a letter or number/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /create project/i })).toBeDisabled();
  expect(parent.getDirectoryHandle).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();

  Reflect.deleteProperty(window, 'showDirectoryPicker');
});

test('renders the default glassy operator workspace shell', () => {
  render(<App />);

  expect(screen.getByText('polypore v0.1.0')).toBeInTheDocument();
  expect(screen.getByText('workspace')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /git branch none/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^help$/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /\/handoff/i })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^settings$/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /hide chat panel|show chat panel/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /\/compact/i })).not.toBeInTheDocument();
  expect(screen.getByRole('tab', { name: /run preview/i })).toBeInTheDocument();
  /* new preview is auto-detect — surfaces a single "run in window" button
     where the old "preview setup" intro used to sit. */
  expect(screen.getByRole('button', { name: /run in window/i })).toBeInTheDocument();
});

test('git branch header opens a compact git actions menu', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: /git branch none/i }));

  expect(screen.getByRole('menu', { name: /git actions/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /^status$/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /^fetch$/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /pull --ff-only/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /^push$/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /show log/i })).toBeInTheDocument();
});

test('git menu displays the project upstream ref instead of assuming origin branch', () => {
  render(<GitMenu
    status={{
      path: '/workspace/repo',
      name: 'repo',
      branch: 'feature',
      upstream: 'trunk',
      dirty: false,
    }}
    onStatusChange={vi.fn()}
    isOpen
    onToggle={vi.fn()}
    tauriInvoke={vi.fn()}
  />);

  expect(screen.getByRole('menu', { name: /git actions/i })).toBeInTheDocument();
  expect(screen.getByText('trunk')).toBeInTheDocument();
  expect(screen.queryByText('origin/feature')).not.toBeInTheDocument();
});

test('project label opens project actions and launcher', async () => {
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: /project polypore/i }));

  expect(screen.getByRole('menu', { name: /project actions/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /new project.*create from a scaffold/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /open folder/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /project launcher/i })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('menuitem', { name: /project launcher/i }));
  expect(screen.getByRole('dialog', { name: /project launcher/i })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: /^close$/i })).toBeInTheDocument());
});

test('topbar workspace control opens its custom dropdown menu', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: /workspace default/i }));
  expect(screen.getByRole('menu', { name: /workspace presets/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitemradio', { name: /default 9 panels/i })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('menuitem', { name: /save current workspace/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /reset workspace/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /manage workspaces/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /permission mode/i })).not.toBeInTheDocument();
});

test('default workspace preset owns the 1/3 chat and 2/3 work area layout', () => {
  const preset = getWorkspacePreset('Default');

  expect(preset.name).toBe('Default');
  expect(preset.layout[0]).toEqual({ slot: 'codex', position: 'left', size: 1 / 3 });
  expect(preset.layout[1]).toEqual({ slot: 'claude', position: 'left', tabIndex: 0 });
  expect(preset.layout.slice(2).every((item) => item.position === 'center')).toBe(true);
  expect(preset.panels).toHaveLength(9);
});

test('topbar keeps handoff out of the global chrome', () => {
  render(<App />);

  /* agent workflow controls such as handoff live in chat / panels, not in
     the global header chrome. */
  expect(screen.queryByRole('button', { name: /\/handoff/i })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^settings$/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^help$/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /agent runtime/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^interrupt agent$/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/^lsp /i)).not.toBeInTheDocument();
  expect(screen.queryByText(/^updates /i)).not.toBeInTheDocument();
  expect(screen.queryByText(/^mcp /i)).not.toBeInTheDocument();
});

test('global settings stores and masks credential handles', async () => {
  try { window.localStorage?.clear?.(); } catch {}
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));

  expect(screen.getByRole('dialog', { name: /^settings$/i })).toBeInTheDocument();
  const settingsNav = screen.getByRole('navigation', { name: /settings sections/i });
  expect(screen.getByRole('region', { name: /panels/i })).toBeInTheDocument();
  fireEvent.click(within(settingsNav).getByRole('button', { name: /^credentials/i }));
  expect(screen.getByRole('region', { name: /credentials/i })).toBeInTheDocument();
  expect(screen.getByText(/no credentials configured/i)).toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText('GITHUB_TOKEN'), { target: { value: 'github token' } });
  fireEvent.change(screen.getByPlaceholderText(/paste once/i), { target: { value: 'ghp-test-value' } });
  fireEvent.click(screen.getByRole('button', { name: /save credential/i }));

  expect(screen.getByText('github-token')).toBeInTheDocument();
  expect(screen.queryByText('ghp-test-value')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /remove github-token/i }));
  expect(screen.getByText(/no credentials configured/i)).toBeInTheDocument();

  fireEvent.click(within(settingsNav).getByRole('button', { name: /^extensions/i }));
  expect(screen.getByRole('region', { name: /extensions/i })).toBeInTheDocument();
  expect(await screen.findByText('polypore.chat.codex')).toBeInTheDocument();
  expect(await screen.findByText('polypore.chat.claude')).toBeInTheDocument();

  fireEvent.click(within(settingsNav).getByRole('button', { name: /agents/i }));
  const agentsRegion = screen.getByRole('region', { name: /agents/i });
  expect(agentsRegion).toBeInTheDocument();
  expect(within(agentsRegion).getByText('codex')).toBeInTheDocument();
});

test('tool cards navigate to the agent view with skills and a pannable formation', async () => {
  render(<App />);

  fireLegacyChatMessage({ type: 'tool-card', toolId: 'tool-1' });

  /* agent panel exposes bundled cross-agent skills, formation canvas, and the +node picker. */
  expect(await screen.findByText('formation')).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: /polyflow/i })).toBeInTheDocument();
  expect(screen.queryByText(/no skills configured/i)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /\+ node/i })).toBeInTheDocument();
  expect(screen.queryByText('mcp servers')).not.toBeInTheDocument();
  expect(screen.queryByText('quick actions')).not.toBeInTheDocument();
});

test('legacy chat bridge ignores messages without a plugin iframe source', () => {
  render(<App />);

  fireEvent(window, new MessageEvent('message', {
    data: { source: 'polypore.chat', type: 'tool-card', toolId: 'tool-1' },
  }));

  expect(screen.queryByText('formation')).not.toBeInTheDocument();
});

test('legacy chat bridge ignores spoofed messages from non-chat plugin iframes', () => {
  render(<App />);
  const frame = document.createElement('iframe');
  frame.className = 'plugin-iframe';
  frame.title = 'polypore.other';
  document.body.appendChild(frame);

  fireEvent(window, new MessageEvent('message', {
    data: { source: 'polypore.chat', type: 'tool-card', toolId: 'tool-1' },
    source: frame.contentWindow,
  }));

  expect(screen.queryByText('formation')).not.toBeInTheDocument();
});

test('a new skill can be drafted from the skills pane', async () => {
  render(<App />);

  fireEvent.click(screen.getByRole('tab', { name: /ai agent/i }));
  fireEvent.click(screen.getByRole('button', { name: /\+ skill/i }));
  const dialog = await screen.findByRole('dialog', { name: /create skill/i });
  fireEvent.change(within(dialog).getByPlaceholderText('skill name'), { target: { value: 'repo-mapper' } });
  fireEvent.change(within(dialog).getByPlaceholderText('# skill instructions in markdown...'), {
    target: { value: 'Map repository structure before editing.' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: /save skill/i }));

  expect(await screen.findByText('repo-mapper')).toBeInTheDocument();
  expect(screen.getByText('Map repository structure before editing.')).toBeInTheDocument();
});

test('agent formation can place a node from the bank picker', async () => {
  render(<App />);

  fireEvent.click(screen.getByRole('tab', { name: /ai agent/i }));
  fireEvent.click(screen.getByRole('button', { name: /\+ node/i }));
  /* picker opens with built-in role templates; clicking one drops it on canvas. */
  const overseerOptions = await screen.findAllByText('overseer');
  fireEvent.click(overseerOptions[0]);

  expect(await screen.findAllByText('overseer')).not.toHaveLength(0);
});

test('codex and claude render as first-class agent terminals', async () => {
  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value: vi.fn().mockResolvedValue({ kind: 'directory' as const, name: 'agent-terminal-project' }),
  });

  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /open folder/i }));

  expect(await screen.findByRole('tab', { name: /cd codex/i })).toBeInTheDocument();
  expect(await screen.findByRole('tab', { name: /cl claude/i })).toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: /\/> chat/i })).not.toBeInTheDocument();
  const tabs = screen.getAllByRole('tab');
  const codexTabIndex = tabs.findIndex((tab) => /cd codex/i.test(tab.getAttribute('aria-label') ?? ''));
  const claudeTabIndex = tabs.findIndex((tab) => /cl claude/i.test(tab.getAttribute('aria-label') ?? ''));
  expect(claudeTabIndex).toBeGreaterThanOrEqual(0);
  expect(claudeTabIndex).toBeLessThan(codexTabIndex);
  expect(await screen.findByRole('region', { name: /claude terminal/i })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: /cd codex/i }));
  expect(screen.queryByTitle('polypore.chat.codex')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^codex$/i })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: /cl claude/i }));
  expect(screen.queryByTitle('polypore.chat.claude')).not.toBeInTheDocument();

  Reflect.deleteProperty(window, 'showDirectoryPicker');
});

test('opens the terminal as a main tab', async () => {
  render(<App />);

  fireEvent.click(screen.getByRole('tab', { name: /\$ terminal/i }));

  expect(screen.getByRole('region', { name: /bash terminal/i })).toBeInTheDocument();
  const quickLaunch = screen.getAllByLabelText('quick launch')
    .find((element) => within(element).queryByRole('button', { name: 'git status' }));
  expect(quickLaunch).toBeTruthy();
  const shellQuickLaunch = quickLaunch!;
  expect(within(shellQuickLaunch).getByRole('button', { name: 'git status' })).toBeInTheDocument();
  expect(within(shellQuickLaunch).getByRole('button', { name: 'pwd' })).toBeInTheDocument();
  expect(within(shellQuickLaunch).getByRole('button', { name: 'ls' })).toBeInTheDocument();
  expect(within(shellQuickLaunch).queryByRole('button', { name: /^claude$/i })).not.toBeInTheDocument();
  expect(within(shellQuickLaunch).queryByRole('button', { name: /^codex$/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/compiled successfully/i)).not.toBeInTheDocument();
});

/* the terminal panel used to render a React <input> for commands and an
   echoing <pre> for output. it now hosts a real xterm.js emulator wired
   to a portable_pty-backed shell, so input/output flow through the
   emulator instead of through React state. xterm requires browser APIs
   (matchMedia, canvas, DPR) that jsdom doesn't provide, so the panel
   short-circuits in jsdom — there's nothing meaningful left to assert
   at this level. real-shell behavior is covered by manual verification
   and the rust-side pty tests; this test is intentionally removed
   rather than replaced with a fragile mock. */

test('preview auto-detects and can run inside or outside the window', async () => {
  render(<App />);

  /* the preview no longer presents a target grid — it auto-detects from
     package.json / cargo.toml / pyproject and surfaces the inferred
     command for the user (or agent) to edit, then run. exercises the
     gate via the launcher path: both buttons are present, run-in-window
     may be enabled or disabled depending on what the active project's
     detected script resolves to. */
  expect(await screen.findByText(/run in window/i)).toBeInTheDocument();
  expect(screen.getByText(/open externally/i)).toBeInTheDocument();
});

test('preview run buttons use the detected dev URL and external opener', async () => {
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'client-app',
        scripts: {
          dev: 'vite --host 127.0.0.1 --port 1420',
          preview: 'vite preview --host 127.0.0.1 --port 4173',
        },
      }),
    },
  });
  const opened: string[] = [];
  server.setExternalOpener(async (url) => {
    opened.push(url);
    return true;
  });
  server.setTerminalRunner({
    spawn: async (command) => ({
      id: 'pty-client-dev',
      command,
      status: 'running',
      output: '',
      pid: 4142,
      exitCode: null,
    }),
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('http://127.0.0.1:1420')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /run in window/i }));
  expect(await screen.findByText(/embedded preview/i)).toBeInTheDocument();
  expect(screen.getByTitle('project preview')).toHaveAttribute('src', 'http://127.0.0.1:1420');

  fireEvent.click(screen.getByRole('button', { name: /open outside/i }));
  await waitFor(() => expect(opened).toEqual(['http://127.0.0.1:1420']));
  expect(screen.getByText(/opened outside/i)).toBeInTheDocument();
});

test('preview loads project-declared runtime commands before auto-detected runtimes', async () => {
  const server = new HostRpcServer({
    files: {
      '.polypore/runtime.json': JSON.stringify({
        runtimes: [{
          label: 'roc app',
          defaultUrl: 'http://localhost:8000',
          commands: [{ name: 'dev', command: 'roc run app.roc', kind: 'site' }],
        }],
      }),
      'package.json': JSON.stringify({
        name: 'node-client',
        scripts: {
          dev: 'vite --host 127.0.0.1 --port 1420',
        },
      }),
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('roc run app.roc')).toBeInTheDocument();
  expect(screen.getByDisplayValue('http://localhost:8000')).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /roc app/i })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('option', { name: /node · node-client/i })).toBeInTheDocument();
});

test('preview restores the selected runtime for the active project', async () => {
  const clearPreviewRuntimePrefs = () => {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith('polypore.preview.runtime.v1:')) window.localStorage.removeItem(key);
    }
  };
  clearPreviewRuntimePrefs();
  const files = {
    '.polypore/runtime.json': JSON.stringify({
      runtimes: [{
        label: 'roc app',
        defaultUrl: 'http://localhost:8000',
        commands: [{ name: 'dev', command: 'roc run app.roc', kind: 'site' }],
      }],
    }),
    'package.json': JSON.stringify({
      name: 'node-client',
      scripts: {
        dev: 'vite --host 127.0.0.1 --port 1420',
      },
    }),
  };
  const renderPreview = () => {
    const server = new HostRpcServer({
      state: { project: { path: '/workspace/polyglot-preview', name: 'polyglot-preview' } },
      files,
    });
    const host = createLoopbackHost(
      (request) => server.handle(request),
      (topic, fn) => server.subscribe(topic, fn),
    );
    return render(<PreviewPanel
      host={host}
      header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
    />);
  };

  const first = renderPreview();
  expect(await screen.findByDisplayValue('roc run app.roc')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('option', { name: /node · node-client/i }));
  expect(await screen.findByDisplayValue('npm run dev')).toBeInTheDocument();
  first.unmount();

  renderPreview();
  expect(await screen.findByDisplayValue('npm run dev')).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /node · node-client/i })).toHaveAttribute('aria-selected', 'true');
  clearPreviewRuntimePrefs();
});

test('preview uses the project package manager when listing and running node scripts', async () => {
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'pnpm-client',
        packageManager: 'pnpm@9.0.0',
        scripts: {
          dev: 'vite --host 127.0.0.1 --port 1420',
        },
      }),
      'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    },
  });
  const spawned: string[] = [];
  server.setTerminalRunner({
    spawn: async (command) => {
      spawned.push(command);
      return {
        id: 'pty-pnpm-dev',
        command,
        status: 'running',
        output: '',
        pid: 6060,
        exitCode: null,
      };
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('pnpm run dev')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /run in window/i }));
  expect(await screen.findByText(/embedded preview/i)).toBeInTheDocument();
  expect(screen.getByTitle('project preview')).toHaveAttribute('src', 'http://127.0.0.1:1420');
  fireEvent.click(screen.getByRole('button', { name: /^logs$/i }));
  expect(screen.getByText(/\$ pnpm run dev/i)).toBeInTheDocument();
  expect(spawned).toEqual(['pnpm run dev -- --host 127.0.0.1 --port 1420']);
});

test('preview treats Tauri scripts as native-only — vite dev embeds, tauri dev is external-only', async () => {
  /* the `dev` script (vite) is embeddable; the `app` script (tauri dev)
     is a native desktop runtime, so switching scripts swaps the panel
     from a "run in window" CTA to an external-only CTA. */
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'desktop-client',
        scripts: {
          dev: 'vite --host 127.0.0.1 --port 1420',
          app: 'tauri dev',
        },
      }),
      'src-tauri/tauri.conf.json': JSON.stringify({
        build: {
          devUrl: 'http://127.0.0.1:1420',
        },
      }),
    },
  });
  const opened: string[] = [];
  server.setExternalOpener(async (url) => {
    opened.push(url);
    return true;
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run dev')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /run in window/i })).toBeEnabled();

  fireEvent.click(screen.getByRole('radio', { name: /appnpm run app/i }));
  expect(screen.getByDisplayValue('npm run app')).toBeInTheDocument();

  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('button', { name: /open externally/i }));
  await waitFor(() => expect(screen.getByText(/running externally/i)).toBeInTheDocument());
  expect(opened).toEqual([]);
});

test('preview reads Tauri devUrl when an app script has no url-like command (external-only)', async () => {
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'desktop-only',
        scripts: {
          app: 'tauri dev',
        },
      }),
      'src-tauri/tauri.conf.json': JSON.stringify({
        build: {
          devUrl: 'http://127.0.0.1:1420',
        },
      }),
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run app')).toBeInTheDocument();
  expect(await screen.findByDisplayValue('http://127.0.0.1:1420')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /open externally/i })).toBeEnabled();
});

test('preview keeps Tauri commands external-only even when no native bridge is available', async () => {
  /* regression: previously, when the native preview bridge was
     unavailable we would iframe the dev URL as a fallback. now tauri is
     never embedded — bridge-or-no-bridge, the CTA collapses to
     "open externally". */
  const previousTauri = (window as typeof window & { __TAURI__?: unknown }).__TAURI__;
  Object.defineProperty(window, '__TAURI__', {
    configurable: true,
    value: undefined,
  });
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'desktop-url-fallback',
        scripts: {
          app: 'tauri dev',
        },
      }),
      'src-tauri/tauri.conf.json': JSON.stringify({
        build: {
          devUrl: 'http://127.0.0.1:1420',
        },
      }),
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run app')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /open externally/i })).toBeEnabled();

  Object.defineProperty(window, '__TAURI__', {
    configurable: true,
    value: previousTauri,
  });
});

test('preview reads Tauri devUrl from a root tauri config', async () => {
  /* devUrl source detection — pure URL-resolution test. tauri itself
     stays external-only; the assertion focuses on the resolved URL. */
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'root-tauri-config',
        scripts: {
          app: 'tauri dev',
        },
      }),
      'tauri.conf.json': JSON.stringify({
        build: {
          devUrl: 'http://127.0.0.1:1430',
        },
      }),
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run app')).toBeInTheDocument();
  expect(await screen.findByDisplayValue('http://127.0.0.1:1430')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument();
});

test('preview reads Tauri devUrl from json5 and toml configs', async () => {
  const json5Server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'json5-tauri-config',
        scripts: {
          app: 'tauri dev',
        },
      }),
      'src-tauri/tauri.conf.json5': `{
        // development URL
        "build": {
          "devUrl": "http://127.0.0.1:1440",
        },
      }`,
    },
  });
  const json5Host = createLoopbackHost(
    (request) => json5Server.handle(request),
    (topic, fn) => json5Server.subscribe(topic, fn),
  );
  const { unmount } = render(<PreviewPanel
    host={json5Host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run app')).toBeInTheDocument();
  expect(await screen.findByDisplayValue('http://127.0.0.1:1440')).toBeInTheDocument();
  unmount();

  const tomlServer = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'toml-tauri-config',
        scripts: {
          app: 'tauri dev',
        },
      }),
      'src-tauri/Tauri.toml': '[build]\ndevUrl = "http://127.0.0.1:1450"\n',
    },
  });
  const tomlHost = createLoopbackHost(
    (request) => tomlServer.handle(request),
    (topic, fn) => tomlServer.subscribe(topic, fn),
  );
  render(<PreviewPanel
    host={tomlHost}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run app')).toBeInTheDocument();
  expect(await screen.findByDisplayValue('http://127.0.0.1:1450')).toBeInTheDocument();
});

test('preview detects Rust Tauri projects as native-only (no run-in-window)', async () => {
  /* tauri ships a real OS window; iframing the dev URL would swap the
     desktop runtime for a plain browser context — APIs missing, IPC
     missing — so the panel refuses to embed even though a devUrl is
     present. only "open externally" is offered. */
  const server = new HostRpcServer({
    files: {
      'Cargo.toml': '[package]\nname = "rust-tauri-app"\nversion = "0.1.0"\n[dependencies]\ntauri = "2"\n',
      'src-tauri/tauri.conf.json': JSON.stringify({
        build: {
          devUrl: 'http://127.0.0.1:1420',
        },
      }),
    },
  });
  const spawned: string[] = [];
  server.setTerminalRunner({
    spawn: async (command) => {
      spawned.push(command);
      return {
        id: 'pty-cargo-tauri',
        command,
        status: 'running',
        output: '',
        pid: 4545,
        exitCode: null,
      };
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('cargo tauri dev')).toBeInTheDocument();
  expect(await screen.findByDisplayValue('http://127.0.0.1:1420')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /open externally/i }));
  expect(await screen.findByText(/running externally/i)).toBeInTheDocument();
  expect(spawned).toEqual(['cargo tauri dev']);
});

test('preview detects Go modules and runs go run in the embedded terminal', async () => {
  const server = new HostRpcServer({
    files: {
      'go.mod': 'module example.com/guiapp\n\ngo 1.22\n',
    },
  });
  const spawned: string[] = [];
  server.setTerminalRunner({
    spawn: async (command) => {
      spawned.push(command);
      return {
        id: 'pty-go-run',
        command,
        status: 'running',
        output: '',
        pid: 5656,
        exitCode: null,
      };
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('go run .')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /run in window/i }));
  expect(await screen.findByLabelText(/interactive preview terminal/i)).toBeInTheDocument();
  expect(screen.getByText(/\$ go run \./i)).toBeInTheDocument();
  expect(spawned).toEqual(['go run .']);
});

test('preview detects Python pyproject app scripts and runs them in the embedded terminal', async () => {
  const server = new HostRpcServer({
    files: {
      'pyproject.toml': '[project]\nname = "python-gui"\n[project.scripts]\napp = "python_gui.main:main"\n',
    },
  });
  const spawned: string[] = [];
  server.setTerminalRunner({
    spawn: async (command) => {
      spawned.push(command);
      return {
        id: 'pty-python-app',
        command,
        status: 'running',
        output: '',
        pid: 5757,
        exitCode: null,
      };
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('python -m python_gui.main')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /run in window/i }));
  expect(await screen.findByLabelText(/interactive preview terminal/i)).toBeInTheDocument();
  expect(screen.getByText(/\$ python -m python_gui\.main/i)).toBeInTheDocument();
  expect(spawned).toEqual(['python -m python_gui.main']);
});

test('preview disables run-in-window for Makefile launch targets with no embeddable url', async () => {
  const server = new HostRpcServer({
    files: {
      Makefile: '.PHONY: launch test\nlaunch:\n\tcalculator --debug\n\ntest:\n\tpytest\n',
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('make launch')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /open externally/i })).toBeEnabled();
});

test('preview disables run-in-window for justfile app recipes with no embeddable url', async () => {
  const server = new HostRpcServer({
    files: {
      justfile: 'app:\n\tcalculator --debug\n\ntest:\n\tpytest\n',
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('just app')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument();
});

test('preview prefers app-like task targets over test targets', async () => {
  const server = new HostRpcServer({
    files: {
      justfile: 'test:\n\tpytest\n\nlaunch:\n\tcalculator\n',
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('just launch')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument();
});

test('preview detects Taskfile app tasks and runs them in-window', async () => {
  const server = new HostRpcServer({
    files: {
      'Taskfile.yml': 'version: "3"\ntasks:\n  test:\n    cmds:\n      - pytest\n  app:\n    cmds:\n      - calculator --debug\n',
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('task app')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument();
});

test('preview detects alternate task runner manifest filenames', async () => {
  const server = new HostRpcServer({
    files: {
      'Taskfile.yaml': 'version: "3"\ntasks:\n  launch:\n    cmds:\n      - calculator\n',
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('task launch')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument();
});

const previewRuntimeManifestCases: Array<{
  label: string;
  files: Record<string, string>;
  command: string;
  url?: string;
}> = [
  {
    label: 'Maven Spring Boot',
    files: {
      'pom.xml': '<project><artifactId>orders</artifactId><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>',
    },
    command: 'mvn spring-boot:run',
    url: 'http://localhost:8080',
  },
  {
    label: 'Rails',
    files: {
      Gemfile: 'gem "rails"\n',
      'config/application.rb': 'module Shop\n  class Application < Rails::Application\n  end\nend\n',
    },
    command: 'bundle exec rails server',
    url: 'http://localhost:3000',
  },
  {
    label: 'Laravel',
    files: {
      'composer.json': JSON.stringify({
        name: 'shop/api',
        require: { 'laravel/framework': '^11.0' },
      }),
      artisan: '#!/usr/bin/env php\n',
    },
    command: 'php artisan serve',
    url: 'http://localhost:8000',
  },
  {
    label: '.NET web',
    files: {
      'Shop.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
    },
    command: 'dotnet run',
    url: 'http://localhost:5000',
  },
  {
    label: 'Docker Compose',
    files: {
      'compose.yml': 'services:\n  web:\n    image: nginx\n',
    },
    command: 'docker compose up',
  },
];

test.each(previewRuntimeManifestCases)('preview detects $label runtime manifests', async ({ files, command, url }) => {
  const server = new HostRpcServer({ files });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue(command)).toBeInTheDocument();
  if (url) expect(await screen.findByDisplayValue(url)).toBeInTheDocument();
});

test('preview classifies common desktop app commands as native (run-in-window disabled)', async () => {
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'electron-client',
        scripts: {
          electron: 'electron .',
        },
      }),
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run electron')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument();
});

test('preview treats launch scripts with executable arguments as native (run-in-window disabled)', async () => {
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'native-launch-args',
        scripts: {
          launch: 'calculator --debug',
        },
      }),
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run launch')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument();
});

test('preview reclassifies manually edited commands as native and disables run-in-window', async () => {
  const server = new HostRpcServer({ files: {} });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  const commandInput = await screen.findByLabelText(/command/i);
  fireEvent.change(commandInput, { target: { value: 'electron .' } });
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument(),
  );
});

test('preview disables run-in-window for package exec desktop commands', async () => {
  const server = new HostRpcServer({ files: {} });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  const commandInput = await screen.findByLabelText(/command/i);
  fireEvent.change(commandInput, { target: { value: 'npx electron .' } });
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument(),
  );
});

test('preview disables run-in-window for env-prefixed desktop commands', async () => {
  const server = new HostRpcServer({ files: {} });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  const commandInput = await screen.findByLabelText(/command/i);
  fireEvent.change(commandInput, { target: { value: 'env ELECTRON_ENABLE_LOGGING=1 electron .' } });
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument(),
  );
});

test('preview disables run-in-window when the user manually types a native executable with arguments', async () => {
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'manual-native-args',
        scripts: { dev: 'vite --host 127.0.0.1 --port 1420' },
      }),
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run dev')).toBeInTheDocument();
  /* dev script is enabled (vite, site kind, url known) */
  expect(screen.getByRole('button', { name: /run in window/i })).toBeEnabled();
  /* editing to a native executable disables it */
  fireEvent.change(screen.getByPlaceholderText('command to run'), { target: { value: 'calculator --debug' } });
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument(),
  );
});

test('preview disables run-in-window for macOS open app launchers', async () => {
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'manual-open-native',
        scripts: { dev: 'vite --host 127.0.0.1 --port 1420' },
      }),
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run dev')).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('command to run'), { target: { value: 'open -a Calculator' } });
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument(),
  );
});

test('preview treats macOS open URL commands as URL previews', async () => {
  const previousTauri = (window as typeof window & { __TAURI__?: unknown }).__TAURI__;
  Object.defineProperty(window, '__TAURI__', {
    configurable: true,
    value: undefined,
  });
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'manual-open-url',
        scripts: {
          dev: 'vite --host 127.0.0.1 --port 1420',
        },
      }),
    },
  });
  server.setTerminalRunner({
    spawn: async (command) => ({
      id: 'pty-manual-open-url',
      command,
      status: 'running',
      output: 'opened http://localhost:9400\n',
      pid: 3135,
      exitCode: null,
    }),
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run dev')).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('command to run'), { target: { value: 'open http://localhost:9400' } });
  fireEvent.click(screen.getByRole('button', { name: /run in window/i }));

  expect(await screen.findByText(/embedded preview/i)).toBeInTheDocument();
  expect(screen.getByTitle('project preview')).toHaveAttribute('src', 'http://localhost:9400');
  expect(screen.queryByText(/native window unavailable/i)).not.toBeInTheDocument();

  Object.defineProperty(window, '__TAURI__', {
    configurable: true,
    value: previousTauri,
  });
});

test('preview disables run-in-window for Windows shell native launchers', async () => {
  const exactCommand = 'powershell -NoProfile -Command "Start-Process \'C:\\Program Files\\Native App\\app.exe\'"';
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'manual-windows-launcher',
        scripts: { dev: 'vite --host 127.0.0.1 --port 1420' },
      }),
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run dev')).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('command to run'), { target: { value: exactCommand } });
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument(),
  );
});

test('preview disables run-in-window for Linux app launchers', async () => {
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'manual-linux-launcher',
        scripts: { dev: 'vite --host 127.0.0.1 --port 1420' },
      }),
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run dev')).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('command to run'), { target: { value: 'flatpak run org.example.NativeApp' } });
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument(),
  );
});

test('preview treats Linux xdg-open URL commands as URL previews', async () => {
  const previousTauri = (window as typeof window & { __TAURI__?: unknown }).__TAURI__;
  Object.defineProperty(window, '__TAURI__', {
    configurable: true,
    value: undefined,
  });
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'manual-xdg-url',
        scripts: {
          dev: 'vite --host 127.0.0.1 --port 1420',
        },
      }),
    },
  });
  server.setTerminalRunner({
    spawn: async (command) => ({
      id: 'pty-manual-xdg-url',
      command,
      status: 'running',
      output: 'opened http://localhost:9500\n',
      pid: 3138,
      exitCode: null,
    }),
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run dev')).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('command to run'), { target: { value: 'xdg-open http://localhost:9500' } });
  fireEvent.click(screen.getByRole('button', { name: /run in window/i }));

  expect(await screen.findByText(/embedded preview/i)).toBeInTheDocument();
  expect(screen.getByTitle('project preview')).toHaveAttribute('src', 'http://localhost:9500');
  expect(screen.queryByText(/native window unavailable/i)).not.toBeInTheDocument();

  Object.defineProperty(window, '__TAURI__', {
    configurable: true,
    value: previousTauri,
  });
});

test('preview disables run-in-window for quoted executable paths with spaces', async () => {
  const exactCommand = '"C:\\Program Files\\Native App\\app.exe" --debug';
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'manual-quoted-native',
        scripts: { dev: 'vite --host 127.0.0.1 --port 1420' },
      }),
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run dev')).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('command to run'), { target: { value: exactCommand } });
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument(),
  );
});

test('preview disables run-in-window for mobile simulator commands', async () => {
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'mobile-app',
        scripts: { ios: 'expo run:ios --simulator' },
      }),
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run ios')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument();
});

test('preview disables run-in-window for mobile commands even when output prints a URL', async () => {
  /* mobile-simulator commands always launch their own window; even if metro
     prints a localhost url, we cannot iframe the simulator surface. */
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'mobile-url-app',
        scripts: { android: 'expo run:android --emulator' },
      }),
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run android')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument();
});

test('preview clears a stale detected url and disables run-in-window when edited to a native app', async () => {
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'web-to-native',
        scripts: { dev: 'vite --host 127.0.0.1 --port 1420' },
      }),
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('http://127.0.0.1:1420')).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('command to run'), { target: { value: 'electron .' } });
  expect(screen.getByPlaceholderText('http://localhost:3000')).toHaveValue('');
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument(),
  );
});

test('preview reads Tauri devUrl when the command is manually edited to Tauri (external-only)', async () => {
  /* even though a Tauri devUrl is detected, the command is native — the
     "run in window" path is hidden and only "open externally" is offered. */
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'manual-tauri',
        scripts: {
          dev: 'vite --host 127.0.0.1 --port 5173',
          app: 'tauri dev',
        },
      }),
      'src-tauri/tauri.conf.json': JSON.stringify({
        build: {
          devUrl: 'http://127.0.0.1:1420',
        },
      }),
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('http://127.0.0.1:5173')).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('command to run'), { target: { value: 'npm run app' } });
  await waitFor(() =>
    expect(screen.getByPlaceholderText('http://localhost:3000')).toHaveValue('http://127.0.0.1:1420'),
  );
  expect(screen.queryByRole('button', { name: /run in window/i })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /open externally/i })).toBeEnabled();
});

test('preview terminal frame forwards keyboard input to cli commands', async () => {
  const writes: Array<{ id: string; data: string }> = [];
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'cli-tool',
        scripts: {
          start: 'node repl.js',
        },
      }),
    },
  });
  server.setTerminalRunner({
    spawn: async (command) => ({
      id: 'pty-cli',
      command,
      status: 'running',
      output: 'ready> ',
      pid: null,
      exitCode: null,
    }),
    write: async (id, data) => {
      writes.push({ id, data });
      return true;
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run start')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /run in window/i }));
  const terminal = await screen.findByLabelText(/interactive preview terminal/i);
  await waitFor(() => expect(terminal).toHaveFocus());
  expect(terminal).toHaveTextContent(/ready>/);
  expect(terminal).not.toHaveTextContent('native preview bridge unavailable');
  fireEvent.keyDown(terminal, { key: 'a' });
  fireEvent.keyDown(terminal, { key: 'Enter' });
  fireEvent.keyDown(terminal, { key: 'c', ctrlKey: true });
  fireEvent.paste(terminal, {
    clipboardData: {
      getData: () => 'pasted input',
    },
  });

  await waitFor(() => expect(writes).toEqual([
    { id: 'pty-cli', data: 'a' },
    { id: 'pty-cli', data: '\r' },
    { id: 'pty-cli', data: '\x03' },
    { id: 'pty-cli', data: 'pasted input' },
  ]));
});

test('preview terminal listener stays attached across run state updates', async () => {
  const server = new HostRpcServer({
    files: {
      'package.json': JSON.stringify({
        name: 'cli-tool',
        scripts: {
          start: 'node repl.js',
        },
      }),
    },
  });
  server.setTerminalRunner({
    spawn: async (command) => ({
      id: 'pty-stable',
      command,
      status: 'running',
      output: '',
      pid: null,
      exitCode: null,
    }),
  });
  const terminalSubscriptions: Array<() => void> = [];
  let terminalUnsubscribeCount = 0;
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => {
      const unsubscribe = server.subscribe(topic, fn);
      if (topic !== 'terminal:event') return unsubscribe;
      terminalSubscriptions.push(unsubscribe);
      return () => {
        terminalUnsubscribeCount += 1;
        unsubscribe();
      };
    },
  );

  render(<PreviewPanel
    host={host}
    header={{ label: 'preview', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByDisplayValue('npm run start')).toBeInTheDocument();
  expect(terminalSubscriptions).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /run in window/i }));
  const terminal = await screen.findByLabelText(/interactive preview terminal/i);

  expect(terminalSubscriptions).toHaveLength(1);
  expect(terminalUnsubscribeCount).toBe(0);
  act(() => {
    server.publish('terminal:event', {
      id: 'pty-stable',
      command: 'npm run start',
      kind: 'output',
      data: 'streamed output\n',
    });
  });

  await waitFor(() => expect(terminal).toHaveTextContent('streamed output'));
});

test('documents panel shows setup state when no bases are configured', async () => {
  const server = new HostRpcServer();
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<MemoryPanel
    host={host}
    header={{ label: 'documents', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
    context={{
      contextItems: [],
      contextByChat: {},
      onAddContext: vi.fn(),
      onRemoveContext: vi.fn(),
    }}
  />);

  expect(screen.queryByText('active context')).not.toBeInTheDocument();
  expect(screen.queryByText('recommend handoff at 80%')).not.toBeInTheDocument();
  expect(screen.queryByText('excluded: node_modules/**')).not.toBeInTheDocument();
  expect(screen.queryByText('rules: lowercase ui copy')).not.toBeInTheDocument();
  expect(screen.getByText('drag documents here')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /write handoff/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^compress$/i })).not.toBeInTheDocument();
  expect(await screen.findByText('no bases yet')).toBeInTheDocument();
  expect(screen.getByText('no document selected')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /open folder/i }).length).toBeGreaterThan(0);
  expect(screen.getAllByRole('button', { name: /create base/i }).length).toBeGreaterThan(0);
  expect(screen.queryByRole('button', { name: /^load$/i })).not.toBeInTheDocument();
});

test('documents setup creates a preset base with folder navigation', async () => {
  const server = new HostRpcServer();
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<MemoryPanel
    host={host}
    header={{ label: 'documents', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
    context={{
      contextItems: [],
      contextByChat: {},
      onAddContext: vi.fn(),
      onRemoveContext: vi.fn(),
    }}
  />);

  expect(await screen.findByText('no bases yet')).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: /^create base$/i })[0]);
  const dialog = screen.getByRole('dialog', { name: /setup documents/i });
  expect(dialog).toBeInTheDocument();
  expect(await screen.findByDisplayValue('memory://documents/project-memory')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^choose$/i })).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: /^create base$/i }));

  expect(await screen.findByRole('button', { name: 'raw' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'wiki' })).toBeInTheDocument();
  const editor = await screen.findByLabelText(/edit raw\/index\.md/i) as HTMLTextAreaElement;
  expect(editor.value).toContain('# Raw');
});

test('documents base selector hides absolute folder paths under base names', async () => {
  const server = new HostRpcServer();
  server.setKnowledgeAdapter({
    bases: vi.fn().mockResolvedValue([
      {
        id: 'global-memory',
        name: 'chat memory',
        root: '/home/user/memory',
        scope: 'global',
        suggestedScope: 'global',
      },
      {
        id: 'project-memory',
        name: 'project memory',
        root: '/home/user/project/.knowledge/project-memory',
        scope: 'project',
        suggestedScope: 'project',
      },
    ]),
    list: vi.fn().mockResolvedValue([]),
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<MemoryPanel
    host={host}
    header={{ label: 'documents', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
    context={{
      contextItems: [],
      contextByChat: {},
      onAddContext: vi.fn(),
      onRemoveContext: vi.fn(),
    }}
  />);

  const globalGroup = await screen.findByRole('region', { name: /global memory bases/i });
  const projectGroup = await screen.findByRole('region', { name: /project memory bases/i });

  expect(within(globalGroup).getByText('chat memory')).toBeInTheDocument();
  expect(within(projectGroup).getByText('project memory')).toBeInTheDocument();
  expect(within(globalGroup).queryByText('/home/user/memory')).not.toBeInTheDocument();
  expect(within(projectGroup).queryByText('/home/user/project/.knowledge/project-memory')).not.toBeInTheDocument();
  expect(screen.getByText('/home/user/project/.knowledge/project-memory')).toBeInTheDocument();
});

test('documents can open a browser folder base', async () => {
  const server = new HostRpcServer();
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );
  const fileHandle = {
    kind: 'file',
    name: 'start.md',
    getFile: vi.fn().mockResolvedValue({ text: vi.fn().mockResolvedValue('# Start\n\n') }),
  };
  const notesHandle = {
    kind: 'directory',
    name: 'notes',
    getFileHandle: vi.fn().mockResolvedValue(fileHandle),
    async *entries() {
      yield ['start.md', fileHandle];
    },
  };
  const folder = {
    kind: 'directory',
    name: 'research',
    getDirectoryHandle: vi.fn().mockResolvedValue(notesHandle),
    async *entries() {
      yield ['notes', notesHandle];
    },
  };
  Object.defineProperty(globalThis, 'showDirectoryPicker', {
    configurable: true,
    value: vi.fn().mockResolvedValue(folder),
  });

  render(<MemoryPanel
    host={host}
    header={{ label: 'documents', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
    context={{
      contextItems: [],
      contextByChat: {},
      onAddContext: vi.fn(),
      onRemoveContext: vi.fn(),
    }}
  />);

  expect(await screen.findByText('no bases yet')).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: /open folder/i })[0]);

  expect((await screen.findAllByText('research')).length).toBeGreaterThan(0);
  expect(screen.getByRole('button', { name: 'notes' })).toBeInTheDocument();
  const browserEditor = await screen.findByLabelText(/edit notes\/start\.md/i) as HTMLTextAreaElement;
  expect(browserEditor.value).toContain('# Start');

  Reflect.deleteProperty(globalThis, 'showDirectoryPicker');
});

test('memory targets open chats and renders nested notes', async () => {
  const server = new HostRpcServer({
    knowledge: {
      'notes/start.md': '# Start\n\nSee [[roadmap]].',
      'roadmap.md': '# Roadmap\n\n- ship memory',
    },
  });
  server.setState('agentPanels', [
    { id: 'codex', agent: 'codex', title: 'codex', active: true },
    { id: 'claude-2', agent: 'claude', title: 'claude 2', active: false },
  ]);
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );
  const onAddContext = vi.fn();

  render(<MemoryPanel
    host={host}
    header={{ label: 'memory', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
    context={{
      contextItems: [],
      contextByChat: {
        codex: ['included: notes/start.md'],
        'claude-2': ['included: roadmap.md'],
      },
      onAddContext,
      onRemoveContext: vi.fn(),
    }}
  />);

  expect(await screen.findByText('start.md')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'notes' })).toBeInTheDocument();
  const memoryEditor = await screen.findByLabelText(/edit notes\/start\.md/i) as HTMLTextAreaElement;
  expect(memoryEditor.value).toContain('# Start');

  fireEvent.change(screen.getByLabelText('context chat'), { target: { value: 'claude-2' } });
  fireEvent.drop(screen.getByLabelText(/loaded context for claude 2/i), {
    dataTransfer: {
      getData: vi.fn(() => 'notes/start.md'),
    },
  });

  expect(onAddContext).toHaveBeenCalledWith('included: memory://documents/notes/start.md', 'claude-2');
});

test('memory keeps missing per-chat context stable', async () => {
  const server = new HostRpcServer({
    knowledge: {
      'notes/start.md': '# Start\n\n',
    },
  });
  server.setState('agentPanels', [
    { id: 'codex', agent: 'codex', title: 'codex', active: true },
  ]);
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );
  const originalError = console.error;
  const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (!String(args[0]).includes('Maximum update depth')) originalError(...args);
  });

  try {
    render(<MemoryPanel
      host={host}
      header={{ label: 'memory', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
      context={{
        contextItems: [],
        contextByChat: {},
        onAddContext: vi.fn(),
        onRemoveContext: vi.fn(),
      }}
    />);

    const contextList = await screen.findByLabelText(/loaded context for codex/i);
    expect(within(contextList).getByText('drag documents here')).toBeInTheDocument();
    await new Promise((resolve) => { window.setTimeout(resolve, 25); });
    expect(consoleError.mock.calls.some((args) => (
      String(args[0]).includes('Maximum update depth')
    ))).toBe(false);
  } finally {
    consoleError.mockRestore();
  }
});

test('memory loaded context lists file sizes and selected chat size live', async () => {
  const server = new HostRpcServer({
    knowledge: {
      'notes/start.md': 'abcdefghij',
      'roadmap.md': '1234567890123456',
    },
    chatSessions: [{ id: 'codex-main', agent: 'codex', title: 'codex', createdAt: 1 }],
    chatMessages: {
      'codex-main': [
        { id: 'm1', sessionId: 'codex-main', by: 'user', ts: 1, text: 'First question?' },
        { id: 'm2', sessionId: 'codex-main', by: 'agent', ts: 2, text: 'First answer.' },
      ],
    },
  });
  server.setState('agentPanels', [
    { id: 'codex', agent: 'codex', title: 'codex', active: true },
  ]);
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<MemoryPanel
    host={host}
    header={{ label: 'memory', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
    context={{
      contextItems: [],
      contextByChat: {
        codex: ['included: notes/start.md', 'included: roadmap.md'],
      },
      onAddContext: vi.fn(),
      onRemoveContext: vi.fn(),
    }}
  />);

  const contextList = await screen.findByLabelText(/loaded context for codex/i);
  const startRow = (await within(contextList).findAllByRole('button', { name: /notes\/start\.md/i }))
    .find((button) => button.classList.contains('context-list__open'));
  if (!startRow) throw new Error('missing notes/start.md context row');
  await waitFor(() => expect(startRow).toHaveTextContent('10 B · 3 tok'));
  const roadmapRow = within(contextList).getAllByRole('button', { name: /roadmap\.md/i })
    .find((button) => button.classList.contains('context-list__open'));
  if (!roadmapRow) throw new Error('missing roadmap.md context row');
  expect(roadmapRow).toHaveTextContent('16 B · 4 tok');

  const chatRow = within(contextList).getByLabelText(/codex chat size/i);
  await waitFor(() => expect(chatRow).toHaveTextContent('2 turns'));
  expect(chatRow).toHaveTextContent(/\d+ B · \d+ tok/);

  await host.chat.send('codex-main', 'Third question?');
  await waitFor(() => expect(chatRow).toHaveTextContent('3 turns'));
});

test('memory loaded context uses live terminal stats for agent chat panels', async () => {
  const server = new HostRpcServer();
  server.setState('agentPanels', [
    { id: 'codex', agent: 'codex', title: 'codex', active: true },
  ]);
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );
  const previousStats = (window as typeof window & { __polyporeTerminalContextStats?: unknown }).__polyporeTerminalContextStats;
  (window as typeof window & { __polyporeTerminalContextStats?: unknown }).__polyporeTerminalContextStats = undefined;

  try {
    render(<MemoryPanel
      host={host}
      header={{ label: 'memory', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
      context={{
        contextItems: [],
        contextByChat: { codex: [] },
        onAddContext: vi.fn(),
        onRemoveContext: vi.fn(),
      }}
    />);

    const contextList = await screen.findByLabelText(/loaded context for codex/i);
    const chatRow = within(contextList).getByLabelText(/codex chat size/i);
    expect(chatRow).toHaveTextContent('0 B · 0 tok');

    window.dispatchEvent(new CustomEvent('polypore:terminal-context-stats', {
      detail: {
        panelId: 'codex',
        title: 'codex',
        agent: 'codex',
        inputChars: 8,
        outputChars: 12,
        transcriptChars: 20,
        transcriptBytes: 20,
        tokens: 5,
        updatedAt: Date.now(),
      },
    }));

    await waitFor(() => expect(chatRow).toHaveTextContent('20 B · 5 tok'));
  } finally {
    (window as typeof window & { __polyporeTerminalContextStats?: unknown }).__polyporeTerminalContextStats = previousStats;
  }
});

test('memory uses event subscriptions instead of polling intervals', async () => {
  const server = new HostRpcServer({
    knowledge: {
      'notes/start.md': '# Start\n\n',
    },
  });
  server.setState('agentPanels', [
    { id: 'codex', agent: 'codex', title: 'codex', active: true },
  ]);
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );
  const intervalSpy = vi.spyOn(window, 'setInterval');

  try {
    render(<MemoryPanel
      host={host}
      header={{ label: 'memory', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
      context={{
        contextItems: [],
        contextByChat: { codex: ['included: notes/start.md'] },
        onAddContext: vi.fn(),
        onRemoveContext: vi.fn(),
      }}
    />);

    expect(await screen.findByLabelText(/loaded context for codex/i)).toBeInTheDocument();
    expect(intervalSpy.mock.calls.filter((call) => call[1] === 1000)).toEqual([]);
  } finally {
    intervalSpy.mockRestore();
  }
});

test('memory detects open chats from dockview when agent panel state is empty', async () => {
  const server = new HostRpcServer({
    knowledge: {
      'notes/start.md': '# Start\n\n',
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );
  const onAddContext = vi.fn();
  const previousDockview = (window as typeof window & { __polyporeDockview?: unknown }).__polyporeDockview;
  (window as typeof window & {
    __polyporeDockview?: unknown;
  }).__polyporeDockview = {
    listPanels: () => [
      { id: 'codex', slot: 'codex', title: 'codex' },
      { id: 'claude-2', slot: 'claude', title: 'claude 2' },
    ],
  };

  try {
    render(<MemoryPanel
      host={host}
      header={{ label: 'memory', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
      context={{
        contextItems: [],
        contextByChat: {
          codex: ['included: notes/start.md'],
          'claude-2': [],
        },
        onAddContext,
        onRemoveContext: vi.fn(),
      }}
    />);

    const targetSelect = await screen.findByLabelText('context chat') as HTMLSelectElement;
    expect(within(targetSelect).getByRole('option', { name: 'codex' })).toBeInTheDocument();
    expect(within(targetSelect).getByRole('option', { name: 'claude 2' })).toBeInTheDocument();

    fireEvent.change(targetSelect, { target: { value: 'claude-2' } });
    fireEvent.drop(screen.getByLabelText(/loaded context for claude 2/i), {
      dataTransfer: {
        getData: vi.fn(() => 'notes/start.md'),
      },
    });

    expect(onAddContext).toHaveBeenCalledWith('included: memory://documents/notes/start.md', 'claude-2');
  } finally {
    (window as typeof window & { __polyporeDockview?: unknown }).__polyporeDockview = previousDockview;
  }
});

test('memory context renders documents from contextDocsByChat without remove or send buttons', async () => {
  const server = new HostRpcServer();
  server.setState('agentPanels', [
    { id: 'codex', agent: 'codex', title: 'codex', active: true },
  ]);
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<MemoryPanel
    host={host}
    header={{ label: 'memory', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
    context={{
      contextItems: [],
      contextByChat: {},
      contextDocsByChat: {
        codex: [
          { path: 'src/App.tsx', bytes: 4096, tokens: 2000, state: 'loaded', readCount: 1 },
        ],
      },
      onAddContext: vi.fn(),
      onRemoveContext: vi.fn(),
    }}
  />);

  expect(await screen.findByText('src/App.tsx')).toBeInTheDocument();
  expect(screen.getByText(/4\.0 KB.*2\.0k tok/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /remove .* from context/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^send$/i })).not.toBeInTheDocument();
});

test('memory context document rows replace matching legacy context labels', async () => {
  const server = new HostRpcServer();
  server.setState('agentPanels', [
    { id: 'codex', agent: 'codex', title: 'codex', active: true },
  ]);
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<MemoryPanel
    host={host}
    header={{ label: 'memory', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
    context={{
      contextItems: [],
      contextByChat: {
        codex: ['included: memory://documents/notes/start.md'],
      },
      contextDocsByChat: {
        codex: [
          {
            path: 'notes/start.md',
            bytes: 0,
            tokens: 0,
            state: 'queued',
            readCount: 0,
            contextItem: 'included: memory://documents/notes/start.md',
          },
        ],
      },
      onAddContext: vi.fn(),
      onRemoveContext: vi.fn(),
    }}
  />);

  expect(await screen.findByLabelText(/notes\/start\.md, queued/i)).toBeInTheDocument();
  expect(screen.getAllByText('notes/start.md')).toHaveLength(1);
});

test('memory context tags compacted documents with a compact marker', async () => {
  const server = new HostRpcServer();
  server.setState('agentPanels', [
    { id: 'codex', agent: 'codex', title: 'codex', active: true },
  ]);
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<MemoryPanel
    host={host}
    header={{ label: 'memory', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
    context={{
      contextItems: [],
      contextByChat: {},
      contextDocsByChat: {
        codex: [
          { path: 'docs/old-notes.md', bytes: 2048, tokens: 500, state: 'compacted', readCount: 1 },
        ],
      },
      onAddContext: vi.fn(),
      onRemoveContext: vi.fn(),
    }}
  />);

  const row = await screen.findByLabelText(/docs\/old-notes\.md, compacted/i);
  expect(within(row).getByText(/^compact$/)).toBeInTheDocument();
});

test('memory context queued documents can be cancelled before next send', async () => {
  const server = new HostRpcServer();
  server.setState('agentPanels', [
    { id: 'codex', agent: 'codex', title: 'codex', active: true },
  ]);
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );
  const onRemoveContext = vi.fn();

  render(<MemoryPanel
    host={host}
    header={{ label: 'memory', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
    context={{
      contextItems: [],
      contextByChat: {},
      contextDocsByChat: {
        codex: [
          { path: 'src/new.ts', bytes: 0, tokens: 0, state: 'queued', readCount: 0 },
        ],
      },
      onAddContext: vi.fn(),
      onRemoveContext,
    }}
  />);

  expect(await screen.findByText('new files send on next message')).toBeInTheDocument();
  const row = screen.getByLabelText(/src\/new\.ts, queued/i);
  fireEvent.click(within(row).getByRole('button', { name: /cancel queued src\/new\.ts/i }));
  expect(onRemoveContext).toHaveBeenCalledWith('included: src/new.ts', 'codex');
});

test('memory context tags documents read more than once with their read count', async () => {
  const server = new HostRpcServer();
  server.setState('agentPanels', [
    { id: 'codex', agent: 'codex', title: 'codex', active: true },
  ]);
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<MemoryPanel
    host={host}
    header={{ label: 'memory', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
    context={{
      contextItems: [],
      contextByChat: {},
      contextDocsByChat: {
        codex: [
          { path: 'src/foo.ts', bytes: 4096, tokens: 1000, state: 'loaded', readCount: 5 },
          { path: 'src/once.ts', bytes: 1024, tokens: 200, state: 'loaded', readCount: 1 },
        ],
      },
      onAddContext: vi.fn(),
      onRemoveContext: vi.fn(),
    }}
  />);

  const multiRow = await screen.findByLabelText(/src\/foo\.ts, loaded/i);
  expect(within(multiRow).getByText('5x')).toBeInTheDocument();

  const singleRow = screen.getByLabelText(/src\/once\.ts, loaded/i);
  expect(within(singleRow).queryByText('1x')).not.toBeInTheDocument();
});

test('editor tab exposes the workspace file directory sidebar without sample files', () => {
  render(<App />);

  fireEvent.click(screen.getByRole('tab', { name: /\{\} editor/i }));

  expect(screen.getByRole('complementary', { name: /select file/i })).toBeInTheDocument();
  expect(screen.getByText('search files...')).toBeInTheDocument();
  expect(screen.getByText('no file open')).toBeInTheDocument();
  expect(screen.getByText('open a file from the workspace tree')).toBeInTheDocument();

  fireEvent.click(screen.getByText('search files...'));
  expect(screen.getByRole('dialog', { name: /quick open/i })).toBeInTheDocument();
});

test('editor can create a browser-backed file without the desktop filesystem bridge', async () => {
  render(<App />);

  fireEvent.click(screen.getByRole('tab', { name: /\{\} editor/i }));
  fireEvent.click(screen.getByRole('button', { name: /new file/i }));
  fireEvent.change(screen.getByPlaceholderText('path/to/file'), { target: { value: 'src/new-file.ts' } });
  fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

  expect(await screen.findByText('created')).toBeInTheDocument();
  expect(screen.getByText('new-file.ts')).toBeInTheDocument();
  expect(screen.queryByText(/filesystem bridge unavailable/i)).not.toBeInTheDocument();
});

test('editor runs a project-declared formatter for the active file', async () => {
  const server = new HostRpcServer({
    files: {
      'src/main.roc': 'roc source',
      '.polypore/formatters.json': JSON.stringify({
        formatters: [{
          id: 'roc-format',
          label: 'roc format',
          command: 'roc format {file}',
          extensions: ['roc'],
        }],
      }),
    },
  });
  const spawned: string[] = [];
  server.setTerminalRunner({
    spawn: async (command) => {
      spawned.push(command);
      return {
        id: 'fmt-1',
        command,
        status: 'running',
        output: '',
        pid: null,
        exitCode: null,
      };
    },
  });
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<EditorPanel
    host={host}
    header={{ label: 'editor', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  await screen.findByText('search files...');
  await act(async () => { await host.editor.open('src/main.roc'); });
  const formatButton = await screen.findByRole('button', { name: /^format$/i });

  fireEvent.click(formatButton);
  await waitFor(() => expect(spawned).toEqual(["roc format 'src/main.roc'"]));
  act(() => {
    server.publish('terminal:event', {
      id: 'fmt-1',
      command: spawned[0],
      kind: 'exited',
      data: null,
      exitCode: 0,
    });
  });

  expect(await screen.findByText('roc format formatted')).toBeInTheDocument();
});

test('editor language mapping honors project-declared language ids', () => {
  expect(projectLanguageForPath({
    servers: [{
      id: 'roc-lsp',
      extensions: ['roc'],
      filenames: ['Rocfile'],
      languageIds: { roc: 'roc', rocfile: 'roc-config' },
    }],
  }, 'src/main.roc')).toBe('roc');
  expect(projectLanguageForPath({
    servers: [{
      id: 'roc-lsp',
      filenames: ['Rocfile'],
      languageIds: { rocfile: 'roc-config' },
    }],
  }, 'Rocfile')).toBe('roc-config');
});

test('problems panel renders an empty state when diagnostics are clean', async () => {
  const host = {
    diagnostics: {
      list: vi.fn().mockResolvedValue({ diagnostics: [] }),
      onChange: vi.fn(() => () => {}),
    },
    editor: {
      open: vi.fn(),
    },
  };

  render(<ProblemsPanel
    host={host as never}
    header={{ label: 'problems', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByText('no problems reported')).toBeInTheDocument();
  expect(screen.getByText('0 items')).toBeInTheDocument();
});

test('problems panel preserves info and hint severities', async () => {
  const diagnostics: Diagnostic[] = [
    {
      id: 'info-1',
      source: 'lsp',
      severity: 'info',
      message: 'unused import can be removed',
      file: 'src/main.roc',
      range: { start: { line: 2, column: 0 }, end: { line: 2, column: 5 } },
    },
    {
      id: 'hint-1',
      source: 'lsp',
      severity: 'hint',
      message: 'consider extracting a helper',
      file: 'src/main.roc',
      range: { start: { line: 4, column: 0 }, end: { line: 4, column: 5 } },
    },
  ];
  const host = {
    diagnostics: {
      list: vi.fn().mockResolvedValue({ diagnostics }),
      onChange: vi.fn(() => () => {}),
    },
    editor: {
      open: vi.fn(),
    },
  };

  render(<ProblemsPanel
    host={host as never}
    header={{ label: 'problems', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  const info = await screen.findByText('info');
  const hint = screen.getByText('hint');
  expect(info.closest('button')).toHaveClass('problem-row--info');
  expect(hint.closest('button')).toHaveClass('problem-row--hint');
});

test('verify panel exposes problems, checks, and a fix queue with add+send controls', async () => {
  render(<App />);

  fireEvent.click(await screen.findByRole('tab', { name: /db debug/i }));

  expect(screen.getByText('problems')).toBeInTheDocument();
  expect(screen.getByText('checks')).toBeInTheDocument();
  expect(screen.getByText('queue')).toBeInTheDocument();
  expect(screen.getByText('no problems · clean')).toBeInTheDocument();
  expect(screen.queryByText('tools')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /send to chat/i })).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /^create \+$/i })).toHaveLength(2);
  expect(screen.getAllByRole('button', { name: /queue all/i })).toHaveLength(2);
  expect(screen.getByText(/drag problems and checks here/i)).toBeInTheDocument();

  fireEvent.click(screen.getAllByRole('button', { name: /^create \+$/i })[1]);
  fireEvent.change(screen.getByPlaceholderText('custom command'), { target: { value: 'true' } });
  fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
  fireEvent.click(screen.getByRole('button', { name: /queue custom/i }));
  const queueItem = document.querySelector('.queue-item');
  expect(queueItem).toBeTruthy();
  expect(within(queueItem as HTMLElement).getByText('custom')).toBeInTheDocument();
  expect(within(queueItem as HTMLElement).getByText('true')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /send to chat/i }));
  expect(await screen.findByRole('menu', { name: /send queue to chat/i })).toBeInTheDocument();
});

test('verify panel hides clean empty state while deep scan is running', async () => {
  let finishScan!: (value: { diagnostics: Diagnostic[] }) => void;
  const deepScan = vi.fn(() => new Promise<{ diagnostics: Diagnostic[] }>((resolve) => {
    finishScan = resolve;
  }));
  const host = {
    diagnostics: {
      list: vi.fn().mockResolvedValue({ diagnostics: [] }),
      onChange: vi.fn(() => () => {}),
      deepScan,
    },
    verify: {
      runs: vi.fn().mockResolvedValue({ runs: [] }),
      onChange: vi.fn(() => () => {}),
    },
  };

  render(<DebugPanel
    host={host as never}
    header={{ label: 'verify', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByText('no problems · clean')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /deep scan/i }));

  expect(await screen.findByText('running project scan')).toBeInTheDocument();
  expect(screen.queryByText('no problems · clean')).not.toBeInTheDocument();

  await waitFor(() => expect(deepScan).toHaveBeenCalled());
  finishScan({ diagnostics: [] });
  expect(await screen.findByText('deep scan · 0 findings')).toBeInTheDocument();
  expect(screen.getByText('no problems · clean')).toBeInTheDocument();
});

test('verify check rows only expose queue actions', async () => {
  const pendingRun = {
    id: 'npm-typecheck',
    label: 'typecheck',
    command: 'npm run typecheck',
    required: true,
    status: 'pending',
    exitCode: null,
    ranAt: null,
    output: '',
    durationMs: null,
  };
  const host = {
    diagnostics: {
      list: vi.fn().mockResolvedValue({ diagnostics: [] }),
      onChange: vi.fn(() => () => {}),
      deepScan: vi.fn().mockResolvedValue({ diagnostics: [] }),
    },
    verify: {
      runs: vi.fn().mockResolvedValue({ runs: [pendingRun] }),
      run: vi.fn(),
      onChange: vi.fn(() => () => {}),
    },
  };

  render(<DebugPanel
    host={host as never}
    header={{ label: 'verify', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(await screen.findByText('typecheck')).toBeInTheDocument();
  const checkRow = screen.getByText('typecheck').closest('.check-row');
  expect(checkRow).toBeTruthy();
  expect(within(checkRow as HTMLElement).queryByText('pending')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /run typecheck/i })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /queue typecheck/i }));

  const queueItem = document.querySelector('.queue-item');
  expect(queueItem).toBeTruthy();
  expect(within(queueItem as HTMLElement).getByText('typecheck')).toBeInTheDocument();
  expect(within(queueItem as HTMLElement).getByText('npm run typecheck')).toBeInTheDocument();
  expect(host.verify.run).not.toHaveBeenCalled();
});

test('custom verify checks are queued instead of run directly', async () => {
  const host = {
    diagnostics: {
      list: vi.fn().mockResolvedValue({ diagnostics: [] }),
      onChange: vi.fn(() => () => {}),
      deepScan: vi.fn().mockResolvedValue({ diagnostics: [] }),
    },
    verify: {
      runs: vi.fn().mockResolvedValue({ runs: [] }),
      run: vi.fn(),
      onChange: vi.fn(() => () => {}),
    },
  };

  render(<DebugPanel
    host={host as never}
    header={{ label: 'verify', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  fireEvent.click(screen.getAllByRole('button', { name: /^create \+$/i })[1]);
  fireEvent.change(screen.getByPlaceholderText('custom command'), { target: { value: 'npm run lint' } });
  fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(screen.queryByRole('button', { name: /run custom/i })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /queue custom/i }));

  const queueItem = document.querySelector('.queue-item');
  expect(queueItem).toBeTruthy();
  expect(within(queueItem as HTMLElement).getByText('custom')).toBeInTheDocument();
  expect(within(queueItem as HTMLElement).getByText('npm run lint')).toBeInTheDocument();
  expect(host.verify.run).not.toHaveBeenCalled();
});

test('verify queue sends prompts into the selected agent terminal without chat.send', async () => {
  const host = {
    raw: vi.fn(),
    diagnostics: {
      list: vi.fn().mockResolvedValue({ diagnostics: [] }),
      onChange: vi.fn(() => () => {}),
      deepScan: vi.fn().mockResolvedValue({ diagnostics: [] }),
    },
    verify: {
      runs: vi.fn().mockResolvedValue({ runs: [] }),
      onChange: vi.fn(() => () => {}),
    },
  };
  const sent: Array<{ panelId?: string; text?: string; submit?: boolean }> = [];
  const previousDockview = (window as typeof window & { __polyporeDockview?: unknown }).__polyporeDockview;
  const previousTerminals = (window as typeof window & { __polyporeTerminalPanels?: Set<string> }).__polyporeTerminalPanels;
  (window as typeof window & {
    __polyporeDockview?: unknown;
    __polyporeTerminalPanels?: Set<string>;
  }).__polyporeDockview = {
    listPanels: () => [{ id: 'codex', slot: 'codex', title: 'cd codex' }],
    focusOrAdd: vi.fn(),
  };
  (window as typeof window & { __polyporeTerminalPanels?: Set<string> }).__polyporeTerminalPanels = new Set(['codex']);
  const onTerminalSend = (event: Event) => sent.push((event as CustomEvent).detail);
  window.addEventListener('polypore:terminal-send', onTerminalSend);

  render(<DebugPanel
    host={host as never}
    header={{ label: 'verify', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  fireEvent.click(screen.getAllByRole('button', { name: /^create \+$/i })[1]);
  fireEvent.change(screen.getByPlaceholderText('custom command'), { target: { value: 'npm test' } });
  fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
  fireEvent.click(screen.getByRole('button', { name: /queue custom/i }));
  fireEvent.click(screen.getByRole('button', { name: /send to chat/i }));

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toMatchObject({ panelId: 'codex', submit: true });
  expect(sent[0].text).toContain('Please work through this verify queue.');
  expect(sent[0].text).toContain('npm test');
  expect(host.raw).not.toHaveBeenCalled();
  const queueItem = screen.getByText('sent').closest('.queue-item');
  expect(queueItem).toBeTruthy();
  expect(within(queueItem as HTMLElement).getByText('npm test')).toBeInTheDocument();
  await waitFor(() => expect(within(queueItem as HTMLElement).getByText('sent')).toBeInTheDocument());
  expect(within(queueItem as HTMLElement).queryByText('done')).not.toBeInTheDocument();
  expect(screen.getByText(/awaiting agent/i)).toBeInTheDocument();

  window.removeEventListener('polypore:terminal-send', onTerminalSend);
  (window as typeof window & { __polyporeDockview?: unknown }).__polyporeDockview = previousDockview;
  (window as typeof window & { __polyporeTerminalPanels?: Set<string> }).__polyporeTerminalPanels = previousTerminals;
});

test('verify diagnostic updates preserve custom problems', async () => {
  let publishDiagnostics: (event: { diagnostics: Diagnostic[] }) => void = () => {};
  const host = {
    diagnostics: {
      list: vi.fn().mockResolvedValue({ diagnostics: [] }),
      onChange: vi.fn((listener: (event: { diagnostics: Diagnostic[] }) => void) => {
        publishDiagnostics = listener;
        return () => {};
      }),
      deepScan: vi.fn().mockResolvedValue({ diagnostics: [] }),
    },
    verify: {
      runs: vi.fn().mockResolvedValue({ runs: [] }),
      onChange: vi.fn(() => () => {}),
    },
  };

  render(<DebugPanel
    host={host as never}
    header={{ label: 'verify', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  await waitFor(() => expect(host.diagnostics.onChange).toHaveBeenCalled());
  fireEvent.click(screen.getAllByRole('button', { name: /^create \+$/i })[0]);
  fireEvent.change(screen.getByPlaceholderText('problem to enqueue'), { target: { value: 'rename ambiguous variable' } });
  fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
  expect(screen.getByText('rename ambiguous variable')).toBeInTheDocument();

  act(() => publishDiagnostics({ diagnostics: [] }));

  expect(screen.getByText('rename ambiguous variable')).toBeInTheDocument();
});

test('a custom problem can be added via the + add control', async () => {
  render(<App />);

  fireEvent.click(await screen.findByRole('tab', { name: /db debug/i }));

  const addButtons = screen.getAllByRole('button', { name: /^create \+$/i });
  fireEvent.click(addButtons[0]);

  const input = screen.getByPlaceholderText('problem to enqueue');
  fireEvent.change(input, { target: { value: 'rename ambiguous variable' } });
  fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

  expect(screen.getByText('rename ambiguous variable')).toBeInTheDocument();
});

test('custom verify problems can be removed without sending the queue', async () => {
  const host = {
    diagnostics: {
      list: vi.fn().mockResolvedValue({ diagnostics: [] }),
      onChange: vi.fn(() => () => {}),
      deepScan: vi.fn().mockResolvedValue({ diagnostics: [] }),
    },
    verify: {
      runs: vi.fn().mockResolvedValue({ runs: [] }),
      onChange: vi.fn(() => () => {}),
    },
  };

  render(<DebugPanel
    host={host as never}
    header={{ label: 'verify', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  await waitFor(() => expect(host.diagnostics.list).toHaveBeenCalled());
  fireEvent.click(screen.getAllByRole('button', { name: /^create \+$/i })[0]);
  fireEvent.change(screen.getByPlaceholderText('problem to enqueue'), { target: { value: 'rename ambiguous variable' } });
  fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
  fireEvent.click(screen.getByRole('button', { name: /queue rename ambiguous variable/i }));

  expect(document.querySelector('.queue-item')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^remove rename ambiguous variable$/i }));

  expect(screen.queryByText('rename ambiguous variable')).not.toBeInTheDocument();
  expect(document.querySelector('.queue-item')).toBeFalsy();
});

test('custom verify checks can be removed without sending the queue', async () => {
  const host = {
    diagnostics: {
      list: vi.fn().mockResolvedValue({ diagnostics: [] }),
      onChange: vi.fn(() => () => {}),
      deepScan: vi.fn().mockResolvedValue({ diagnostics: [] }),
    },
    verify: {
      runs: vi.fn().mockResolvedValue({ runs: [] }),
      onChange: vi.fn(() => () => {}),
    },
  };

  render(<DebugPanel
    host={host as never}
    header={{ label: 'verify', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  await waitFor(() => expect(host.verify.runs).toHaveBeenCalled());
  fireEvent.click(screen.getAllByRole('button', { name: /^create \+$/i })[1]);
  fireEvent.change(screen.getByPlaceholderText('custom command'), { target: { value: 'npm run lint' } });
  fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
  fireEvent.click(screen.getByRole('button', { name: /queue custom/i }));

  expect(document.querySelector('.queue-item')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^remove custom check$/i }));

  expect(screen.queryByText('npm run lint')).not.toBeInTheDocument();
  expect(document.querySelector('.queue-item')).toBeFalsy();
});

test('every panel exposes a help control that opens a scoped manual', async () => {
  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: /open manual for preview/i }));

  expect(screen.getByRole('dialog', { name: /manual for preview/i })).toBeInTheDocument();
  expect(screen.getByText('manual · preview')).toBeInTheDocument();
  /* "open full docs" only appears when the panel's manual declares a real
     externalDocsUrl — no more github.com homepage placeholder. */
  expect(screen.queryByRole('button', { name: /open full docs/i })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /close manual/i }));
  expect(screen.queryByRole('dialog', { name: /manual for preview/i })).not.toBeInTheDocument();

  fireLegacyChatMessage({ type: 'open-help' });

  expect(screen.getByRole('dialog', { name: /manual for codex/i })).toBeInTheDocument();
});

test('manual ask sends the active section body to the agent terminal', async () => {
  const sent: Array<{ panelId?: string; text?: string; submit?: boolean }> = [];
  const previousDockview = (window as typeof window & { __polyporeDockview?: unknown }).__polyporeDockview;
  const previousTerminals = (window as typeof window & { __polyporeTerminalPanels?: Set<string> }).__polyporeTerminalPanels;
  const onTerminalSend = (event: Event) => sent.push((event as CustomEvent).detail);
  window.addEventListener('polypore:terminal-send', onTerminalSend);

  try {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /open manual for preview/i }));

    (window as typeof window & {
      __polyporeDockview?: unknown;
      __polyporeTerminalPanels?: Set<string>;
    }).__polyporeDockview = {
      listPanels: () => [{ id: 'codex', slot: 'codex', title: 'cd codex' }],
      focusOrAdd: vi.fn(),
      focusPanel: vi.fn(),
    };
    (window as typeof window & { __polyporeTerminalPanels?: Set<string> }).__polyporeTerminalPanels = new Set(['codex']);

    fireEvent.click(screen.getByRole('button', { name: /ask the agent about this/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ panelId: 'codex', submit: true });
    expect(sent[0].text).toContain('Slug: panels/polypore.preview');
    expect(sent[0].text).toContain('Manual body:');
    expect(sent[0].text).toContain('The active runtime surface for your project');
  } finally {
    window.removeEventListener('polypore:terminal-send', onTerminalSend);
    (window as typeof window & { __polyporeDockview?: unknown }).__polyporeDockview = previousDockview;
    (window as typeof window & { __polyporeTerminalPanels?: Set<string> }).__polyporeTerminalPanels = previousTerminals;
  }
});

test('panel settings controls open the integrated settings panels section', async () => {
  render(<App />);

  const previewSettings = await screen.findByRole('button', { name: /open panel settings for preview/i });
  fireEvent.click(previewSettings);

  expect(screen.getByRole('dialog', { name: /^settings$/i })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: /panels/i })).toBeInTheDocument();
  expect(screen.getByText('settings · preview')).toBeInTheDocument();
  expect(screen.getByText(/The active runtime surface for your project/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /open runtime commands/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /reset preview defaults/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /close settings/i }));

  expect(screen.queryByRole('dialog', { name: /^settings$/i })).not.toBeInTheDocument();

  fireLegacyChatMessage({ type: 'open-settings' });

  expect(screen.getByRole('dialog', { name: /^settings$/i })).toBeInTheDocument();
  expect(screen.getByText('settings · codex')).toBeInTheDocument();
});

test('diff tab shows changed files and supports working-tree and branch compare modes', () => {
  const server = new HostRpcServer();
  const host = createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );

  render(<DiffHistoryPanel
    host={host}
    header={{ label: 'diff', onOpenHelp: vi.fn(), onOpenSettings: vi.fn() }}
  />);

  expect(screen.getByText('changed files')).toBeInTheDocument();
  expect(screen.getByText('HEAD vs working tree')).toBeInTheDocument();
  expect(screen.getByText('HEAD')).toBeInTheDocument();
  expect(screen.getAllByText('working tree').length).toBeGreaterThan(1);
  expect(screen.getByRole('button', { name: /working tree/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^branch$/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^autosave$/i })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /compare/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /fork from here/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /revert\.\.\./i })).not.toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: /restore points/i })).not.toBeInTheDocument();
  expect(screen.getByText('no recorded file changes')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /^branch$/i }));
  expect(screen.getByText('upstream vs current branch')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /working tree/i }));
  expect(screen.getByText('HEAD vs working tree')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /^compare$/i }));
  expect(screen.getByRole('dialog', { name: /compare refs/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /HEAD vs working tree/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /upstream vs current branch/i })).toBeInTheDocument();
  expect(screen.queryByText(/HEAD~1/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/commit\.\.\./i)).not.toBeInTheDocument();
});

test('a new tab can be added and closed via the browser-style controls', () => {
  render(<App />);

  /* every dockview group hosts its own + button so users can add panels
     directly into the strip they clicked. grab the first one for this
     test — they all share the same dispatch logic. */
  fireEvent.click(screen.getAllByRole('button', { name: /open new tab/i })[0]);
  /* the add menu exposes each plugin as a role="menuitem"; clicking the
     terminal item adds a fresh terminal panel via dockview's API. */
  fireEvent.click(screen.getByRole('menuitem', { name: /\$ terminal/i }));

  const terminalTabs = screen.getAllByRole('tab', { name: /\$ terminal/i });
  expect(terminalTabs.length).toBeGreaterThanOrEqual(2);

  /* the newly-added tab lands in whichever dockview group hosted the +
     button we clicked, so identify it by its aria-selected state rather
     than DOM order. */
  const newTab = terminalTabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
  expect(newTab).toBeDefined();

  /* close the active terminal and check the count drops by exactly one. */
  const closeButton = newTab!.querySelector('button[aria-label*="close"]');
  expect(closeButton).not.toBeNull();
  fireEvent.click(closeButton!);

  expect(screen.getAllByRole('tab', { name: /\$ terminal/i }).length).toBe(terminalTabs.length - 1);
});
