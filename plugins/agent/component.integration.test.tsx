import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { AgentPanel } from './component';
import type { PolyporeHost } from '../../packages/sdk/src/host';

/* a deliberately minimal host stub. fills in just what AgentPanel calls on
   mount, with empty default returns so the render is deterministic. tests
   override specific methods to assert wiring. */
function makeStubHost(overrides: Partial<{
  mcpServers: unknown[];
  discoveredMcps: unknown[];
  secrets: unknown[];
  skills: unknown[];
  skillsets: unknown[];
  discoverFn: () => Promise<{ servers: unknown[] }>;
  setFn: (input: unknown) => Promise<{ secret: unknown }>;
  chatSessions: unknown[];
  chatSendFn: (sessionId: string, body: string) => Promise<unknown>;
  stateValues: Record<string, unknown>;
}> = {}) {
  const discover = overrides.discoverFn ?? vi.fn().mockResolvedValue({ servers: overrides.discoveredMcps ?? [] });
  const set = overrides.setFn ?? vi.fn().mockResolvedValue({ secret: { id: 'x', scope: 'project', service: '', hint: '****', configured: true, updatedAt: 1 } });
  const skillRecords = overrides.skills ?? [];
  const skillsDelete = vi.fn().mockResolvedValue({ deleted: true });
  const skillsWrite = vi.fn((skill: Record<string, unknown>) => Promise.resolve({
    skill: { summary: '', ...skill },
    written: true,
  }));
  const secretsDelete = vi.fn().mockResolvedValue({ removed: true });
  const mcpDelete = vi.fn().mockResolvedValue({ deleted: true });
  const mcpUpsert = vi.fn((server: { id?: string; name: string; url: string; scope?: string; authRef?: string }) => Promise.resolve({
    server: { id: server.id ?? 'mcp-new', scope: server.scope ?? 'polypore', ...server },
  }));
  const chatSend = overrides.chatSendFn ?? vi.fn().mockResolvedValue({});
  const chatSessions = vi.fn().mockResolvedValue({ sessions: overrides.chatSessions ?? [] });
  const stateGet = vi.fn((key: string) => Promise.resolve({ value: overrides.stateValues?.[key] ?? null }));
  const host = {
    state: {
      get: stateGet,
      subscribe: vi.fn().mockReturnValue(() => {}),
      set: vi.fn(),
    },
    skills: {
      list: vi.fn().mockResolvedValue({ skills: skillRecords }),
      read: vi.fn((id: string) => {
        const skill = skillRecords.find((item) => (item as { id?: string }).id === id);
        return skill ? Promise.resolve({ skill }) : Promise.reject(new Error(`skill not found: ${id}`));
      }),
      write: skillsWrite, delete: skillsDelete, invoke: vi.fn(), publish: vi.fn().mockResolvedValue({ published: true }),
    },
    skillsets: {
      list: vi.fn().mockResolvedValue({ skillsets: overrides.skillsets ?? [] }),
      read: vi.fn(), upsert: vi.fn(), delete: vi.fn(),
    },
    secrets: {
      list: vi.fn().mockResolvedValue({ secrets: overrides.secrets ?? [] }),
      has: vi.fn(), reveal: vi.fn(), use: vi.fn(),
      set, delete: secretsDelete,
    },
    mcp: {
      servers: {
        list: vi.fn().mockResolvedValue({ servers: overrides.mcpServers ?? [] }),
        upsert: mcpUpsert, delete: mcpDelete, test: vi.fn(),
      },
      discover,
      invoke: vi.fn(),
    },
    ui: { notify: vi.fn(), confirm: vi.fn().mockResolvedValue({ confirmed: true }), openExternal: vi.fn() },
    chat: { send: chatSend, history: vi.fn().mockResolvedValue({ messages: [] }), sessions: chatSessions },
    history: { list: vi.fn().mockResolvedValue({ events: [] }), record: vi.fn() },
    /* the panel calls a lot of other methods on mount in branches we don't
       care about — proxy unknown sub-objects to a no-op object. */
  } as unknown as PolyporeHost;
  return { host, discover, set, secretsDelete, skillsDelete, skillsWrite, mcpDelete, mcpUpsert, chatSend, chatSessions, stateGet };
}

const stubHeader = { title: 'agent', subtitle: '', onClose: () => {} };

describe('AgentPanel integration', () => {
  beforeEach(() => {
    for (const key of ['polypore.agent.formation.v2', 'polypore.agent.templates.v1', 'polypore.agent.formation']) {
      try { window.localStorage.removeItem?.(key); } catch {}
    }
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('agent_panel_renders_discovered_mcp_rows_on_mount', async () => {
    const { host } = makeStubHost({
      mcpServers: [],
      discoveredMcps: [
        { name: 'github', origins: ['claude'], transport: 'http', url: 'https://github.example/mcp' },
        { name: 'context7', origins: ['claude', 'codex'], transport: 'stdio', command: 'npx', args: ['-y', '@context7/mcp'] },
      ],
    });
    render(<AgentPanel host={host} header={stubHeader as never} />);
    /* the rail renders after a microtask + state update from mount effects;
       waitFor handles that. */
    expect(await screen.findByText('github')).toBeInTheDocument();
    expect(await screen.findByText('context7')).toBeInTheDocument();
    expect(await screen.findByText('claude+codex')).toBeInTheDocument();
  });

  test('mcp_empty_state_cta_invokes_host_mcp_discover', async () => {
    const discover = vi.fn().mockResolvedValue({ servers: [] });
    const { host } = makeStubHost({ discoverFn: discover });
    render(<AgentPanel host={host} header={stubHeader as never} />);
    /* mount calls discover once. clicking the CTA should call it again. */
    const cta = await screen.findByRole('button', { name: /scan agent configs/i });
    discover.mockClear();
    fireEvent.click(cta);
    expect(discover).toHaveBeenCalledTimes(1);
  });

  test('agent_panel_renders_builtin_polypore_mcp_row', async () => {
    const { host } = makeStubHost();
    render(<AgentPanel host={host} header={stubHeader as never} />);

    expect(await screen.findByText('polypore-ide')).toBeInTheDocument();
    expect(screen.getByText('node packages/mcp-server/src/server.mjs')).toBeInTheDocument();
    expect(screen.queryByText('builtin')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /manage polypore-ide/i })).toBeInTheDocument();
  });

  test('mcp_rows_open_settings_and_managed_servers_can_be_deleted', async () => {
    const { host, mcpDelete, mcpUpsert } = makeStubHost({
      mcpServers: [{ id: 'mcp-github', name: 'github', url: 'https://github.example/mcp', scope: 'polypore' }],
      discoveredMcps: [{ name: 'context7', origins: ['claude'], transport: 'stdio', command: 'npx', args: ['-y', '@context7/mcp'] }],
    });
    render(<AgentPanel host={host} header={stubHeader as never} />);

    fireEvent.click(await screen.findByRole('button', { name: /manage github/i }));
    let dialog = await screen.findByRole('dialog', { name: /github settings/i });
    fireEvent.change(within(dialog).getByDisplayValue('github'), { target: { value: 'github-main' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));
    await vi.waitFor(() => {
      expect(mcpUpsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'mcp-github', name: 'github-main' }));
    });
    expect(await screen.findByText('github-main')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: /manage github-main/i }));
    dialog = await screen.findByRole('dialog', { name: /github-main settings/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    await vi.waitFor(() => {
      expect(mcpDelete).toHaveBeenCalledWith('mcp-github');
      expect(screen.queryByText('github-main')).not.toBeInTheDocument();
    });

    fireEvent.click(await screen.findByRole('button', { name: /manage context7/i }));
    dialog = await screen.findByRole('dialog', { name: /context7 settings/i });
    expect(within(dialog).getByText(/managed in the source agent config/i)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
    expect(screen.getByText('context7')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: /manage polypore-ide/i }));
    dialog = await screen.findByRole('dialog', { name: /polypore-ide settings/i });
    expect(within(dialog).getByText(/built in mcp/i)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });

  test('skills_header_owns_folder_add_and_folder_summary_is_hidden', async () => {
    const { host } = makeStubHost({
      skills: [{ id: 'tdd-loop', name: 'tdd loop', summary: 'skill summary', skillsetId: 'polyflow', origin: 'builtin' }],
      skillsets: [{
        id: 'polyflow',
        title: 'polyflow',
        version: '0.1.0',
        builtin: true,
        summary: 'polypore-native iterative TDD loop',
        skills: ['tdd-loop'],
      }],
    });
    render(<AgentPanel host={host} header={stubHeader as never} />);

    /* + folder opens an overlay sheet (like new skill/server/secret) rather
       than an inline form that pushed the skill list down. */
    fireEvent.click(await screen.findByRole('button', { name: /\+ folder/i }));
    const folderDialog = await screen.findByRole('dialog', { name: /create folder/i });
    expect(within(folderDialog).getByPlaceholderText('folder name')).toBeInTheDocument();
    fireEvent.click(within(folderDialog).getByRole('button', { name: /cancel/i }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /create folder/i })).not.toBeInTheDocument();
    });

    fireEvent.click(await screen.findByRole('button', { name: /polyflow/i }));
    expect(screen.queryByText('polypore-native iterative TDD loop')).not.toBeInTheDocument();
  });

  test('skillset_manifest_skills_render_when_skill_list_is_incomplete', async () => {
    const { host } = makeStubHost({
      skills: [],
      skillsets: [{
        id: 'polyflow',
        title: 'polyflow',
        version: '0.1.0',
        builtin: true,
        skills: ['polyflow', 'polyflow-tdd'],
      }],
    });
    render(<AgentPanel host={host} header={stubHeader as never} />);

    fireEvent.click(await screen.findByRole('button', { name: /polyflow/i }));
    expect(await screen.findByText('polyflow-tdd')).toBeInTheDocument();
  });

  test('skill_create_form_saves_body_text', async () => {
    const { host, skillsWrite } = makeStubHost();
    render(<AgentPanel host={host} header={stubHeader as never} />);

    fireEvent.click(await screen.findByRole('button', { name: /\+ skill/i }));
    const dialog = await screen.findByRole('dialog', { name: /create skill/i });
    fireEvent.change(within(dialog).getByPlaceholderText('skill name'), { target: { value: 'repo mapper' } });
    fireEvent.change(within(dialog).getByPlaceholderText('# skill instructions in markdown...'), { target: { value: 'Map repository structure before editing.' } });
    /* scope is now a segmented radio control (matching the editor), not a select */
    fireEvent.click(within(dialog).getByLabelText(/codex/i));
    fireEvent.click(within(dialog).getByRole('button', { name: /save skill/i }));

    await vi.waitFor(() => {
      expect(skillsWrite).toHaveBeenCalledWith(expect.objectContaining({
        name: 'repo mapper',
        body: 'Map repository structure before editing.',
        publishedTo: ['codex'],
      }));
    });
  });

  test('skill_edit_form_saves_name_body_folder_and_scope', async () => {
    const { host, skillsWrite } = makeStubHost({
      skills: [{
        id: 'repo-mapper',
        name: 'repo mapper',
        summary: 'maps repos',
        body: 'Map the current repository.',
        origin: 'polypore',
      }],
      skillsets: [{ id: 'team-skills', title: 'team skills', version: '0.1.0', skills: [] }],
    });
    render(<AgentPanel host={host} header={stubHeader as never} />);

    fireEvent.click(await screen.findByText('repo mapper'));
    const dialog = await screen.findByRole('dialog', { name: /repo mapper skill editor/i });
    fireEvent.change(within(dialog).getByLabelText(/skill name/i), { target: { value: 'repo cartographer' } });
    fireEvent.change(within(dialog).getByLabelText(/folder/i), { target: { value: 'team-skills' } });
    fireEvent.click(within(dialog).getByLabelText(/codex/i));
    fireEvent.click(within(dialog).getByRole('button', { name: /^source$/i }));
    fireEvent.change(within(dialog).getByPlaceholderText('# skill body in markdown...'), {
      target: { value: 'Map repository structure before editing.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /save skill/i }));

    await vi.waitFor(() => {
      expect(skillsWrite).toHaveBeenCalledWith(expect.objectContaining({
        id: 'repo-mapper',
        name: 'repo cartographer',
        body: 'Map repository structure before editing.',
        skillsetId: 'team-skills',
        publishedTo: ['codex'],
      }));
    });
  });

  test('claude_origin_skills_can_be_removed', async () => {
    const { host, skillsDelete } = makeStubHost({
      skills: [{ id: 'claude-reviewer', name: 'claude reviewer', summary: 'review skill', origin: 'claude' }],
    });
    render(<AgentPanel host={host} header={stubHeader as never} />);

    expect(await screen.findByText('claude reviewer')).toBeInTheDocument();
    /* delete moved into the skill editor sheet — open it via the row gear,
       then click delete. */
    fireEvent.click(screen.getByRole('button', { name: /settings for skill claude reviewer/i }));
    const dialog = await screen.findByRole('dialog', { name: /claude reviewer skill editor/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    await vi.waitFor(() => {
      expect(skillsDelete).toHaveBeenCalledWith('claude-reviewer');
    });
    expect(screen.queryByText('claude reviewer')).not.toBeInTheDocument();
  });

  test('skill_editor_renders_instruction_body_on_open', async () => {
    /* opening a skill with a body must show its instructions in the default
       "rendered" view — not the "No instructions yet" empty state. guards the
       regression where bundled skill bodies failed to load and every editor
       opened blank. */
    const { host } = makeStubHost({
      skills: [{
        id: 'polyflow-tdd',
        name: 'polyflow-tdd',
        summary: 'vertical-slice TDD',
        body: '# polyflow tdd\n\nWrite a failing seam test first.',
        skillsetId: 'polyflow',
        origin: 'builtin',
      }],
      skillsets: [{ id: 'polyflow', title: 'polyflow', version: '0.1.0', builtin: true, skills: ['polyflow-tdd'] }],
    });
    render(<AgentPanel host={host} header={stubHeader as never} />);

    fireEvent.click(await screen.findByRole('button', { name: /polyflow/i }));
    fireEvent.click(await screen.findByText('polyflow-tdd'));
    const dialog = await screen.findByRole('dialog', { name: /polyflow-tdd skill editor/i });
    expect(within(dialog).queryByText(/No instructions yet/i)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Write a failing seam test first/i)).toBeInTheDocument();
  });

  test('secrets_empty_state_cta_opens_create_form', async () => {
    const { host } = makeStubHost();
    render(<AgentPanel host={host} header={stubHeader as never} />);
    /* with no secrets, the empty state CTA opens the form. */
    const cta = await screen.findByRole('button', { name: /add a project secret/i });
    fireEvent.click(cta);
    /* form is now visible — the password input is the load-bearing new field. */
    expect(await screen.findByPlaceholderText('value')).toBeInTheDocument();
  });

  test('secret_create_form_save_calls_host_secrets_set', async () => {
    const set = vi.fn().mockResolvedValue({ secret: { id: 'github-pat', scope: 'project', service: 'github', hint: '****', configured: true, updatedAt: 1 } });
    const { host } = makeStubHost({ setFn: set });
    render(<AgentPanel host={host} header={stubHeader as never} />);

    fireEvent.click(await screen.findByRole('button', { name: /add a project secret/i }));
    fireEvent.change(await screen.findByPlaceholderText('handle (e.g. github-pat)'), { target: { value: 'github-pat' } });
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: 'ghp_secret' } });
    fireEvent.change(screen.getByPlaceholderText('service (optional)'), { target: { value: 'github' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await vi.waitFor(() => {
      expect(set).toHaveBeenCalledWith(expect.objectContaining({
        id: 'github-pat',
        value: 'ghp_secret',
        scope: 'project',
        service: 'github',
      }));
    });
  });

  test('secret_settings_sheet_deletes_via_host', async () => {
    const { host, secretsDelete } = makeStubHost({
      secrets: [{ id: 'github-pat', scope: 'project', service: 'github', hint: 'ghp_…abcd', configured: true }],
    });
    render(<AgentPanel host={host} header={stubHeader as never} />);

    expect(await screen.findByText('github-pat')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /settings for secret github-pat/i }));
    const dialog = await screen.findByRole('dialog', { name: /github-pat settings/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    await vi.waitFor(() => {
      expect(secretsDelete).toHaveBeenCalledWith('github-pat', 'project');
    });
  });

  test('formation_send_to_chat_injects_prompt_bundle_into_open_terminal', async () => {
    /* send to chat now delivers into the running claude/codex pty (the same
       polypore:terminal-send path verify uses) rather than the headless ACP
       chat — so we assert the event reaches the open terminal session. */
    const { host } = makeStubHost();
    const sends: Array<{ panelId: string; text: string }> = [];
    const onSend = (event: Event) => {
      const detail = (event as CustomEvent).detail as { panelId: string; text: string };
      sends.push({ panelId: detail.panelId, text: detail.text });
    };
    window.addEventListener('polypore:terminal-send', onSend as EventListener);
    (window as unknown as { __polyporeDockview?: unknown }).__polyporeDockview = {
      listPanels: () => [{ id: 'claude-1', slot: 'claude', title: 'claude' }],
      focusPanel: () => {},
      focusOrAdd: () => {},
    };
    (window as unknown as { __polyporeTerminalPanels?: Set<string> }).__polyporeTerminalPanels = new Set(['claude-1']);

    try {
      render(<AgentPanel host={host} header={stubHeader as never} />);

      fireEvent.click(await screen.findByRole('button', { name: /load starter team/i }));
      await vi.waitFor(() => {
        expect(screen.getByRole('button', { name: /send to chat/i })).not.toBeDisabled();
      });
      fireEvent.click(screen.getByRole('button', { name: /send to chat/i }));

      await vi.waitFor(() => {
        expect(sends.length).toBe(1);
      });
      expect(sends[0].panelId).toBe('claude-1');
      expect(sends[0].text).toContain('# Agent formation');
      expect(sends[0].text).toContain('overseer');
      expect(sends[0].text).toContain('## Handoff routes');
    } finally {
      window.removeEventListener('polypore:terminal-send', onSend as EventListener);
      delete (window as unknown as { __polyporeDockview?: unknown }).__polyporeDockview;
      delete (window as unknown as { __polyporeTerminalPanels?: Set<string> }).__polyporeTerminalPanels;
    }
  });

  test('add_node_picker_places_template_without_opening_role_editor', async () => {
    const { host } = makeStubHost();
    render(<AgentPanel host={host} header={stubHeader as never} />);

    fireEvent.click((await screen.findAllByRole('button', { name: /\+ node/i }))[0]);
    const dialog = await screen.findByRole('dialog', { name: /add node/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /^frontend$/i }));

    expect(await screen.findByRole('button', { name: /frontend idle/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /frontend role editor/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/placed frontend/i)).not.toBeInTheDocument();
  });

  test('builtin_node_presets_default_to_inherited_model', async () => {
    const { host } = makeStubHost();
    render(<AgentPanel host={host} header={stubHeader as never} />);

    fireEvent.click((await screen.findAllByRole('button', { name: /\+ node/i }))[0]);
    const picker = await screen.findByRole('dialog', { name: /add node/i });
    fireEvent.click(within(picker).getByRole('button', { name: /^frontend$/i }));

    const node = await screen.findByRole('button', { name: /frontend idle/i });
    fireEvent.pointerDown(node, { button: 0, clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(node, { clientX: 20, clientY: 20, pointerId: 1 });
    const editor = await screen.findByRole('dialog', { name: /frontend role editor/i });
    expect(within(editor).getByLabelText('model')).toHaveValue('inherit');
  });

  test('builtin_templates_can_be_edited_from_the_node_picker', async () => {
    const { host } = makeStubHost();
    render(<AgentPanel host={host} header={stubHeader as never} />);

    fireEvent.click((await screen.findAllByRole('button', { name: /\+ node/i }))[0]);
    const picker = await screen.findByRole('dialog', { name: /add node/i });
    const frontendItem = within(picker).getByRole('button', { name: /^frontend$/i }).closest('.node-bank__item');
    expect(frontendItem).not.toBeNull();
    fireEvent.click(within(frontendItem as HTMLElement).getByRole('button', { name: /edit template/i }));

    const editor = await screen.findByRole('dialog', { name: /frontend template editor/i });
    fireEvent.change(within(editor).getByDisplayValue('frontend'), { target: { value: 'ui builder' } });
    fireEvent.click(within(editor).getByRole('button', { name: /save template/i }));

    expect(await within(picker).findByRole('button', { name: /^ui builder/i })).toBeInTheDocument();
  });

  test('formation_initial_view_matches_reset_view', async () => {
    const { host } = makeStubHost({
      stateValues: {
        formation: [
          { id: 'node-overseer', role: 'overseer', detail: '', status: 'idle', prompt: '', model: 'claude-opus', skills: [], tools: [], x: 80, y: 80, root: true },
          { id: 'node-qa', role: 'qa', detail: '', status: 'idle', prompt: '', model: 'claude-sonnet', skills: [], tools: [], x: 800, y: 500 },
        ],
      },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
      toJSON: () => ({}),
    });
    const { container } = render(<AgentPanel host={host} header={stubHeader as never} />);

    await screen.findByRole('button', { name: /overseer idle/i });
    const world = container.querySelector('.formation-canvas__world') as HTMLElement;
    await vi.waitFor(() => {
      expect(world.style.transform).not.toBe('translate(0px, 0px) scale(1)');
    });
    const initialTransform = world.style.transform;

    fireEvent.click(screen.getByRole('button', { name: /reset view/i }));

    await vi.waitFor(() => {
      expect(world.style.transform).toBe(initialTransform);
    });
  });

  test('dragging_output_to_empty_canvas_opens_picker_and_adds_connected_node', async () => {
    const { host } = makeStubHost();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
      toJSON: () => ({}),
    });
    render(<AgentPanel host={host} header={stubHeader as never} />);

    fireEvent.click(await screen.findByRole('button', { name: /load starter team/i }));
    const port = await screen.findByRole('button', { name: /drag from overseer to connect/i });
    fireEvent.pointerDown(port, { button: 0, clientX: 180, clientY: 138, pointerId: 1 });
    fireEvent.pointerUp(port, { clientX: 520, clientY: 320, pointerId: 1 });

    const picker = await screen.findByRole('dialog', { name: /connect node/i });
    fireEvent.change(within(picker).getByPlaceholderText('search compatible roles...'), { target: { value: 'security' } });
    fireEvent.click(within(picker).getByRole('button', { name: /security/i }));

    await vi.waitFor(() => {
      expect(screen.getByText('4 roles')).toBeInTheDocument();
      expect(screen.getByText('3 handoffs')).toBeInTheDocument();
    });
    expect(screen.queryByRole('dialog', { name: /connect node/i })).not.toBeInTheDocument();
  });

  test('dragging_orphan_input_to_existing_output_adds_handoff', async () => {
    const formation = [
      { id: 'root', role: 'chat', detail: '', status: 'idle', prompt: '', model: 'claude', skills: [], tools: [], x: 80, y: 60, root: true },
      { id: 'source', role: 'overseer', detail: '', status: 'idle', prompt: '', model: 'claude-opus', skills: [], tools: [], x: 80, y: 220 },
      { id: 'target', role: 'frontend', detail: '', status: 'idle', prompt: '', model: 'claude-sonnet', skills: [], tools: [], x: 360, y: 220 },
    ];
    const { host } = makeStubHost({ stateValues: { formation } });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
      toJSON: () => ({}),
    });
    const { container } = render(<AgentPanel host={host} header={stubHeader as never} />);

    const frontend = await screen.findByRole('button', { name: /frontend idle/i });
    expect(frontend).toHaveClass('formation-node--orphan');
    const world = container.querySelector('.formation-canvas__world') as HTMLElement;
    await vi.waitFor(() => {
      expect(world.style.transform).toMatch(/translate\(/);
    });
    const transform = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(world.style.transform);
    expect(transform).not.toBeNull();
    const [, panXRaw, panYRaw, zoomRaw] = transform as RegExpExecArray;
    const panX = Number(panXRaw);
    const panY = Number(panYRaw);
    const zoom = Number(zoomRaw);
    const toClient = (x: number, y: number) => ({ clientX: panX + x * zoom, clientY: panY + y * zoom });

    const input = await screen.findByRole('button', { name: /drag to frontend to connect/i });
    fireEvent.pointerDown(input, { button: 0, ...toClient(460, 213), pointerId: 1 });
    fireEvent.pointerUp(input, { ...toClient(180, 249), pointerId: 1 });

    await vi.waitFor(() => {
      expect(screen.getByText('1 handoffs')).toBeInTheDocument();
    });
  });
});
