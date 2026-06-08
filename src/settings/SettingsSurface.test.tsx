import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { SettingsSurface } from './SettingsSurface';
import type { GlobalSettingsServices } from './tabs/types';

function stubServices(): GlobalSettingsServices {
  return {
    host: {
      plugins: {
        list: async () => ({ plugins: [] }),
        enable: async (id: string) => ({ id, enabled: true }),
        disable: async (id: string) => ({ id, disabled: true }),
      },
    },
    secretStore: { onChange: () => () => {}, has: () => false },
    tauriInvoke: () => null,
    localSecretRefs: () => [],
    secretHandle: (value: string) => value.toLowerCase().replace(/\s+/g, '-'),
    agentMeta: { codex: { icon: 'cd', label: 'codex' }, claude: { icon: 'cl', label: 'claude' } },
  } as unknown as GlobalSettingsServices;
}

describe('SettingsSurface', () => {
  test('defaults to panels and lists the settings sections', () => {
    render(<SettingsSurface services={stubServices()} onClose={() => {}} />);
    const nav = screen.getByRole('navigation', { name: /settings sections/i });
    for (const name of ['panels', 'project', 'extensions', 'agents', 'credentials', 'appearance']) {
      expect(within(nav).getByRole('button', { name: new RegExp(`^${name}`) })).toBeTruthy();
    }
    expect(within(nav).queryByRole('button', { name: /^overview/i })).toBeNull();
    expect(screen.getByRole('region', { name: /panels/i })).toBeTruthy();
  });

  test('filters settings sections from the side navigation search', () => {
    render(<SettingsSurface services={stubServices()} onClose={() => {}} />);
    const nav = screen.getByRole('navigation', { name: /settings sections/i });

    fireEvent.change(screen.getByLabelText('find settings'), { target: { value: 'agent' } });

    expect(within(nav).getByRole('button', { name: /^agents/i })).toBeTruthy();
    expect(within(nav).queryByRole('button', { name: /^panels/i })).toBeNull();
  });

  test('agents section waits for an explicit probe before checking binaries', async () => {
    const tauriInvoke = vi.fn(async () => [
      { agent: 'codex', available: true, path: '/usr/bin/codex' },
      { agent: 'claude', available: false, path: null },
    ]);
    const services = { ...stubServices(), tauriInvoke } as unknown as GlobalSettingsServices;

    render(<SettingsSurface services={services} initialSection="agents" onClose={() => {}} />);

    expect(screen.getByRole('region', { name: /agents/i })).toBeTruthy();
    expect(tauriInvoke).not.toHaveBeenCalled();
    expect(screen.getAllByText('not checked').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /probe all/i }));

    await waitFor(() => expect(tauriInvoke).toHaveBeenCalledWith('project_agent_status'));
    expect(await screen.findByText('/usr/bin/codex')).toBeTruthy();
    expect(screen.getByText('missing')).toBeTruthy();
  });

  test('panels section deep-links to a selected panel and project-backed settings', async () => {
    const services = {
      ...stubServices(),
      host: {
        plugins: {
          list: async () => ({ plugins: [] }),
          enable: async (id: string) => ({ id, enabled: true }),
          disable: async (id: string) => ({ id, disabled: true }),
        },
        editor: {
          read: vi.fn(async () => { throw new Error('not found'); }),
          applyEdit: vi.fn(),
        },
      },
    } as unknown as GlobalSettingsServices;

    render(
      <SettingsSurface
        services={services}
        initialSection="panels"
        initialPanelSlot="preview"
        panelCatalog={[{
          slot: 'preview',
          id: 'polypore.preview',
          icon: 'run',
          label: 'preview',
          title: 'preview',
          version: '0.1.0',
          category: 'runtime',
          defaultArea: 'center',
          permissions: ['editor.read', 'terminal.spawn'],
          capabilities: ['streaming'],
          enabled: true,
          source: 'builtin',
          manual: { summary: 'The active runtime surface for your project', tips: [] },
        }]}
        onClose={() => {}}
      />,
    );

    expect(screen.getByRole('region', { name: /panels/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^preview$/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /open runtime commands/i }));

    expect(await screen.findByRole('region', { name: /project/i })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('group', { name: /runtime commands/i })).toHaveClass('settings-fieldset--focus'),
    );
  });

  test('project section writes runtime, language server, verify, diagnostics, formatter, and file tree config files', async () => {
    const writes: Record<string, string> = {};
    const services = {
      ...stubServices(),
      host: {
        plugins: { list: async () => ({ plugins: [] }) },
        editor: {
          read: vi.fn(async (path: string) => {
            if (writes[path] != null) return { path, content: writes[path] };
            throw new Error(`file not found: ${path}`);
          }),
          applyEdit: vi.fn(async (path: string, edits: Array<{ newText: string }>) => {
            writes[path] = edits[0].newText;
            return { applied: edits.length };
          }),
        },
      },
    } as unknown as GlobalSettingsServices;

    render(<SettingsSurface services={services} initialSection="project" onClose={() => {}} />);
    expect(await screen.findByText('no runtime commands configured')).toBeTruthy();

    // editors are revealed on demand (state-first) — open each group's add form first
    fireEvent.click(screen.getByRole('button', { name: 'add to runtime commands' }));
    fireEvent.change(screen.getByLabelText('runtime label'), { target: { value: 'roc app' } });
    fireEvent.change(screen.getByLabelText('runtime command name'), { target: { value: 'dev' } });
    fireEvent.change(screen.getByLabelText('runtime command'), { target: { value: 'roc run app.roc' } });
    fireEvent.change(screen.getByLabelText('runtime url'), { target: { value: 'http://localhost:8000' } });
    fireEvent.click(screen.getByRole('button', { name: 'add runtime' }));

    await waitFor(() => expect(writes['.polypore/runtime.json']).toBeTruthy());
    expect(JSON.parse(writes['.polypore/runtime.json'])).toEqual({
      runtimes: [{
        label: 'roc app',
        hint: 'dev',
        defaultUrl: 'http://localhost:8000',
        commands: [{ name: 'dev', command: 'roc run app.roc', kind: 'site' }],
      }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'add to language servers' }));
    fireEvent.change(screen.getByLabelText('language server id'), { target: { value: 'roc-lsp' } });
    fireEvent.change(screen.getByLabelText('language server command'), { target: { value: 'roc_language_server' } });
    fireEvent.change(screen.getByLabelText('language server args'), { target: { value: '--stdio' } });
    fireEvent.change(screen.getByLabelText('language server extensions'), { target: { value: '.roc' } });
    fireEvent.change(screen.getByLabelText('language server language ids'), { target: { value: 'roc=roc' } });
    fireEvent.click(screen.getByRole('button', { name: 'add server' }));

    await waitFor(() => expect(writes['.polypore/language-servers.json']).toBeTruthy());
    expect(JSON.parse(writes['.polypore/language-servers.json'])).toEqual({
      servers: [{
        id: 'roc-lsp',
        command: 'roc_language_server',
        args: ['--stdio'],
        extensions: ['roc'],
        languageIds: { roc: 'roc' },
      }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'add to verify commands' }));
    fireEvent.change(screen.getByLabelText('verify id'), { target: { value: 'roc-check' } });
    fireEvent.change(screen.getByLabelText('verify command'), { target: { value: 'roc check' } });
    fireEvent.click(screen.getByRole('button', { name: 'add check' }));

    await waitFor(() => expect(writes['.polypore/verify.json']).toBeTruthy());
    expect(JSON.parse(writes['.polypore/verify.json'])).toEqual([{
      id: 'roc-check',
      label: 'roc-check',
      command: 'roc check',
      required: true,
    }]);

    fireEvent.click(screen.getByRole('button', { name: 'add to diagnostics sources' }));
    fireEvent.change(screen.getByLabelText('diagnostics id'), { target: { value: 'roc-diag' } });
    fireEvent.change(screen.getByLabelText('diagnostics command'), { target: { value: 'roc check --format=gcc' } });
    fireEvent.click(screen.getByLabelText('diagnostics parser'), {});
    fireEvent.change(screen.getByLabelText('diagnostics parser'), { target: { value: 'generic-colon' } });
    fireEvent.click(screen.getByRole('button', { name: 'add source' }));

    await waitFor(() => expect(writes['.polypore/diagnostics.json']).toBeTruthy());
    expect(JSON.parse(writes['.polypore/diagnostics.json'])).toEqual({
      sources: [{ id: 'roc-diag', command: 'roc check --format=gcc' }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'add to formatter commands' }));
    fireEvent.change(screen.getByLabelText('formatter id'), { target: { value: 'roc-format' } });
    fireEvent.change(screen.getByLabelText('formatter label'), { target: { value: 'roc format' } });
    fireEvent.change(screen.getByLabelText('formatter command'), { target: { value: 'roc format app.roc' } });
    fireEvent.change(screen.getByLabelText('formatter extensions'), { target: { value: '.roc' } });
    fireEvent.click(screen.getByRole('button', { name: 'add formatter' }));

    await waitFor(() => expect(writes['.polypore/formatters.json']).toBeTruthy());
    expect(JSON.parse(writes['.polypore/formatters.json'])).toEqual({
      formatters: [{
        id: 'roc-format',
        label: 'roc format',
        command: 'roc format app.roc',
        extensions: ['roc'],
      }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'add to file tree filters' }));
    fireEvent.change(screen.getByLabelText('file tree include dirs'), { target: { value: 'src-tauri/target' } });
    fireEvent.change(screen.getByLabelText('file tree exclude dirs'), { target: { value: 'generated, vendor/cache' } });
    fireEvent.change(screen.getByLabelText('file tree text extensions'), { target: { value: '.roc, rlib' } });
    fireEvent.change(screen.getByLabelText('file tree binary extensions'), { target: { value: '.snap' } });
    fireEvent.click(screen.getByRole('button', { name: 'save filters' }));

    await waitFor(() => expect(writes['.polypore/file-tree.json']).toBeTruthy());
    expect(JSON.parse(writes['.polypore/file-tree.json'])).toEqual({
      includeDirs: ['src-tauri/target'],
      excludeDirs: ['generated', 'vendor/cache'],
      textExtensions: ['roc', 'rlib'],
      binaryExtensions: ['snap'],
    });
  });

  test('extensions section keeps install-by-id behind the advanced layer', async () => {
    render(<SettingsSurface services={stubServices()} initialSection="extensions" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('no plugins registered')).toBeTruthy());

    // the raw install form is hidden until advanced is opened
    expect(screen.queryByPlaceholderText('plugin id')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /advanced · install by id/i }));
    expect(screen.getByPlaceholderText('plugin id')).toBeTruthy();
  });

  test('source review hands a fetch/scan/inspect instruction to the agent', async () => {
    const onRequestAgent = vi.fn();
    render(
      <SettingsSurface
        services={stubServices()}
        initialSection="extensions"
        onRequestAgent={onRequestAgent}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('no plugins registered')).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText('git url or repo'), {
      target: { value: 'github.com/acme/cool-panel' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ask agent to inspect' }));

    expect(onRequestAgent).toHaveBeenCalledTimes(1);
    const prompt = onRequestAgent.mock.calls[0][0];
    expect(prompt).toContain('github.com/acme/cool-panel');
    expect(prompt).toMatch(/fetch/i);
    expect(prompt).toMatch(/wait for my confirmation before installing/i);
  });
});
