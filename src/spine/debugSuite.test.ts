import { describe, expect, test, vi } from 'vitest';
import { HostRpcServer } from '../../packages/host/src';
import type { DebugRunner } from '../../packages/host/src';

/* A mock DebugRunner that stands in for the Tauri dap.rs/debug_capture.rs
   bridge. The host owns state/timeline/trust/summarization; the runner only
   performs the raw DAP/capture op. Tests drive the host through these seams. */
function mockRunner(overrides: Partial<DebugRunner> = {}): DebugRunner {
  return {
    start: async () => ({ sessionId: 'dap-1' }),
    setBreakpoints: async (_p) => ({ breakpoints: [{ verified: true, line: 18 }] }),
    continue: async () => ({
      stop: { reason: 'breakpoint', threadId: 1, frameId: 1000, file: 'UserCard.tsx', line: 18 },
    }),
    stepOver: async () => ({ stop: { reason: 'step', threadId: 1, frameId: 1000, file: 'UserCard.tsx', line: 19 } }),
    stepIn: async () => ({ stop: { reason: 'step', threadId: 1, frameId: 1001, file: 'UserCard.tsx', line: 5 } }),
    stepOut: async () => ({ stop: { reason: 'step', threadId: 1, frameId: 1000, file: 'UserCard.tsx', line: 20 } }),
    pause: async () => ({ stop: { reason: 'pause', threadId: 1, frameId: 1000, file: 'UserCard.tsx', line: 18 } }),
    stackTrace: async () => ({ frames: [{ id: 1000, name: 'render', file: 'UserCard.tsx', line: 18 }] }),
    scopes: async () => ({ scopes: [{ name: 'Local', variablesReference: 2000 }] }),
    variables: async () => ({ variables: [{ name: 'avatarUrl', value: 'undefined', type: 'undefined', variablesReference: 0 }] }),
    evaluate: async () => ({ result: 'undefined', type: 'undefined', variablesReference: 0 }),
    capture: {
      screenshot: async () => ({ mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }),
      console: async () => ({ entries: [{ level: 'error', text: 'avatarUrl is undefined' }] }),
    },
    ...overrides,
  };
}

const SCENARIO = { title: 'avatar missing on /settings', whatsWrong: 'no avatar renders on /settings' };
const START_PARAMS = {
  scenario: SCENARIO,
  adapter: 'vscode-js-debug',
  config: { request: 'launch', program: 'server.js' },
};

describe('Slice 0 — debug contract', () => {
  test('host.debug.start returns a session id and publishes debug state', async () => {
    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner());
    const published: any[] = [];
    server.subscribe('state:debug', (value) => published.push(value));

    const response = await server.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });

    expect(response.ok).toBe(true);
    if (response.ok) {
      const result = response.result as { session: { id: string; status: string; trust: string; scenario: typeof SCENARIO } };
      expect(result.session.id).toBeTruthy();
      expect(result.session.scenario.title).toBe(SCENARIO.title);
      expect(result.session.trust).toBe('observe');
    }
    expect(published.length).toBeGreaterThanOrEqual(1);
    const state = published[published.length - 1];
    expect(state.session.scenario.title).toBe(SCENARIO.title);
    expect(Array.isArray(state.timeline)).toBe(true);
    expect(state.status).toBeTruthy();
  });

  test('debug.start infers a non-JavaScript adapter from config.type', async () => {
    const server = new HostRpcServer();
    const starts: Array<{ adapter: string; config: Record<string, unknown> }> = [];
    server.setDebugRunner(mockRunner({
      start: async (params) => {
        starts.push(params);
        return { sessionId: 'dap-1' };
      },
    }));

    const response = await server.handle({
      kind: 'request',
      id: 1,
      method: 'debug.start',
      params: {
        scenario: SCENARIO,
        config: { type: 'python', request: 'launch', program: 'app.py' },
      },
    });

    expect(response.ok).toBe(true);
    expect(starts[0]?.adapter).toBe('debugpy');
  });

  test('debug.probe resolves adapter metadata before probing availability', async () => {
    const server = new HostRpcServer();
    const probes: Array<{ adapter: string; config: Record<string, unknown> }> = [];
    server.setDebugRunner(mockRunner({
      probe: async (params) => {
        probes.push(params);
        return {
          adapter: params.adapter,
          command: 'dlv',
          available: false,
          detail: 'not available: cannot find binary',
        };
      },
    }));

    const response = await server.handle({
      kind: 'request',
      id: 1,
      method: 'debug.probe',
      params: {
        config: { type: 'go', request: 'launch', program: 'main.go' },
      },
    });

    expect(response.ok).toBe(true);
    expect(probes[0]?.adapter).toBe('delve');
    if (response.ok) {
      expect(response.result).toEqual({
        adapter: 'delve',
        command: 'dlv',
        available: false,
        detail: 'not available: cannot find binary',
      });
    }
  });

  test('debug.start requires adapter metadata instead of defaulting to JavaScript', async () => {
    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner());

    const response = await server.handle({
      kind: 'request',
      id: 1,
      method: 'debug.start',
      params: {
        scenario: SCENARIO,
        config: { request: 'launch' },
      },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('invalid_params');
      expect(response.error.message).toMatch(/debug adapter is required/i);
    }
  });

  test('debug.start without a runner reports the session unavailable', async () => {
    const server = new HostRpcServer();
    const response = await server.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.message).toMatch(/debug/i);
  });

  test('debug.state returns the current session and timeline', async () => {
    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner());
    await server.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });

    const response = await server.handle({ kind: 'request', id: 2, method: 'debug.state', params: {} });
    expect(response.ok).toBe(true);
    if (response.ok) {
      const state = response.result as { session: { scenario: typeof SCENARIO } | null; timeline: unknown[]; status: string };
      expect(state.session?.scenario.title).toBe(SCENARIO.title);
      expect(Array.isArray(state.timeline)).toBe(true);
    }
  });

  test('each debug.* call appends one timeline card', async () => {
    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner());
    await server.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });
    await server.handle({
      kind: 'request', id: 2, method: 'debug.setBreakpoints',
      params: { file: 'UserCard.tsx', breakpoints: [{ line: 18 }] },
    });

    const response = await server.handle({ kind: 'request', id: 3, method: 'debug.state', params: {} });
    expect(response.ok).toBe(true);
    if (response.ok) {
      const state = response.result as { timeline: Array<{ kind: string; status: string }> };
      expect(state.timeline.length).toBeGreaterThanOrEqual(2);
      expect(state.timeline.every((card) => card.status === 'done' || card.status === 'failed' || card.status === 'running')).toBe(true);
      expect(state.timeline.some((card) => card.kind === 'start')).toBe(true);
      expect(state.timeline.some((card) => card.kind === 'setBreakpoints')).toBe(true);
    }
  });
});

describe('Slice 1 — thin end-to-end (breakpoint + continue → stopped card)', () => {
  test('setting a breakpoint and continuing yields a stopped card with {reason, initiatedBy}', async () => {
    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner());
    await server.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });
    await server.handle({
      kind: 'request', id: 2, method: 'debug.setBreakpoints',
      params: { file: 'UserCard.tsx', breakpoints: [{ line: 18 }] },
    });

    const cont = await server.handle({ kind: 'request', id: 3, method: 'debug.continue', params: {} });
    expect(cont.ok).toBe(true);
    if (cont.ok) {
      const result = cont.result as { stop: { reason: string; line: number; initiatedBy: string } };
      expect(result.stop.reason).toBe('breakpoint');
      expect(result.stop.line).toBe(18);
      expect(result.stop.initiatedBy).toBe('agent');
    }

    const state = await server.handle({ kind: 'request', id: 4, method: 'debug.state', params: {} });
    expect(state.ok).toBe(true);
    if (state.ok) {
      const s = state.result as {
        status: string;
        stop: { reason: string; initiatedBy: string } | null;
        timeline: Array<{ kind: string; status: string; payload?: any }>;
      };
      expect(s.status).toBe('paused');
      expect(s.stop?.reason).toBe('breakpoint');
      const stopCard = s.timeline.find((card) => card.kind === 'continue');
      expect(stopCard?.status).toBe('done');
      expect(stopCard?.payload.stop.reason).toBe('breakpoint');
    }
  });

  test('a human-hit breakpoint can resolve the agent continue call (attribution preserved)', async () => {
    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner({
      continue: async () => ({ stop: { reason: 'breakpoint', threadId: 1, frameId: 1000, file: 'UserCard.tsx', line: 42, initiatedBy: 'human' } }),
    }));
    await server.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });
    const cont = await server.handle({ kind: 'request', id: 2, method: 'debug.continue', params: {} });
    expect(cont.ok).toBe(true);
    if (cont.ok) expect((cont.result as { stop: { initiatedBy: string } }).stop.initiatedBy).toBe('human');
  });
});

describe('Slice 2 — inspect + summarize + trust', () => {
  test('a deep object returns ≤ caps and a more ref; big strings truncate', async () => {
    const big = 'x'.repeat(5000);
    const children: any[] = [
      { name: 'nested', value: 'Object', type: 'object', variablesReference: 3000 },
      { name: 'huge', value: big, type: 'string', variablesReference: 0 },
    ];
    for (let i = 0; i < 60; i += 1) children.push({ name: `prop${i}`, value: String(i), type: 'number', variablesReference: 0 });

    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner({ variables: async () => ({ variables: children }) }));
    await server.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });

    const res = await server.handle({ kind: 'request', id: 2, method: 'debug.variables', params: { variablesReference: 2000 } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const out = res.result as { variables: Array<{ name: string; value: string; valueTruncated?: boolean; ref?: number; more?: boolean }>; total: number; truncated: boolean };
      expect(out.total).toBe(62);
      expect(out.truncated).toBe(true);
      expect(out.variables.length).toBeLessThanOrEqual(50);
      const nested = out.variables.find((v) => v.name === 'nested');
      expect(nested?.more).toBe(true);
      expect(nested?.ref).toBe(3000);
      const huge = out.variables.find((v) => v.name === 'huge');
      expect(huge?.valueTruncated).toBe(true);
      expect(huge!.value.length).toBeLessThan(big.length);
    }
  });

  test('evaluate is refused in observe mode and scrubbed after trust is raised', async () => {
    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner({ evaluate: async () => ({ result: 'token=sk-SEKRET-123', type: 'string', variablesReference: 0 }) }));
    server.setDebugScrubber((text) => text.replace('sk-SEKRET-123', '••••••'));
    await server.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });

    const refused = await server.handle({ kind: 'request', id: 2, method: 'debug.evaluate', params: { expression: 'avatarUrl', frameId: 1000 } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/observe/i);

    await server.handle({ kind: 'request', id: 3, method: 'debug.setTrust', params: { trust: 'evaluate' } });
    const allowed = await server.handle({ kind: 'request', id: 4, method: 'debug.evaluate', params: { expression: 'process.env.TOKEN', frameId: 1000 } });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      const out = allowed.result as { result: string };
      expect(out.result).toContain('••••••');
      expect(out.result).not.toContain('SEKRET');
    }
  });
});

describe('Slice 4 — roadblock handoff', () => {
  test('a blocked session shows the banner; resolve clears it and restores inspecting', async () => {
    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner());
    await server.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });

    const raised = await server.handle({ kind: 'request', id: 2, method: 'debug.roadblock', params: { ask: 'reach /settings' } });
    expect(raised.ok).toBe(true);
    if (raised.ok) expect((raised.result as { blocked: boolean; ask: string }).blocked).toBe(true);

    let state = await server.handle({ kind: 'request', id: 3, method: 'debug.state', params: {} });
    if (state.ok) {
      const s = state.result as { status: string; roadblock: { ask: string } | null };
      expect(s.status).toBe('blocked');
      expect(s.roadblock?.ask).toBe('reach /settings');
    }

    const resolved = await server.handle({ kind: 'request', id: 4, method: 'debug.roadblock.resolve', params: {} });
    expect(resolved.ok).toBe(true);
    state = await server.handle({ kind: 'request', id: 5, method: 'debug.state', params: {} });
    if (state.ok) {
      const s = state.result as { status: string; roadblock: unknown | null };
      expect(s.roadblock).toBeNull();
      expect(s.status).toBe('inspecting');
    }
  });

  test('a human can arm a breakpoint before any session exists; it persists and is gutter-visible', async () => {
    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner());
    // no debug.start yet
    const res = await server.handle({
      kind: 'request', id: 1, method: 'debug.addBreakpoint',
      params: { file: 'src/UserCard.tsx', line: 18 },
    });
    expect(res.ok).toBe(true);
    const state = await server.handle({ kind: 'request', id: 2, method: 'debug.state', params: {} });
    if (state.ok) {
      const bps = (state.result as { breakpoints: Array<{ file: string; line: number; setBy: string }> }).breakpoints;
      expect(bps).toHaveLength(1);
      expect(bps[0]).toMatchObject({ file: 'src/UserCard.tsx', line: 18, setBy: 'human' });
    }
  });

  test('armed breakpoints are replayed to the adapter when the session starts', async () => {
    const setBreakpoints = vi.fn().mockResolvedValue({ breakpoints: [{ verified: true, line: 18 }] });
    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner({ setBreakpoints }));
    await server.handle({ kind: 'request', id: 1, method: 'debug.addBreakpoint', params: { file: 'src/UserCard.tsx', line: 18 } });
    setBreakpoints.mockClear();
    await server.handle({ kind: 'request', id: 2, method: 'debug.start', params: START_PARAMS });
    expect(setBreakpoints).toHaveBeenCalledWith(expect.objectContaining({
      file: 'src/UserCard.tsx',
      breakpoints: [expect.objectContaining({ line: 18 })],
    }));
  });

  test('removeBreakpoint clears an armed breakpoint', async () => {
    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner());
    await server.handle({ kind: 'request', id: 1, method: 'debug.addBreakpoint', params: { file: 'a.ts', line: 5 } });
    await server.handle({ kind: 'request', id: 2, method: 'debug.removeBreakpoint', params: { file: 'a.ts', line: 5 } });
    const state = await server.handle({ kind: 'request', id: 3, method: 'debug.state', params: {} });
    if (state.ok) expect((state.result as { breakpoints: unknown[] }).breakpoints).toHaveLength(0);
  });

  test('a runner that reports blocked on start raises a roadblock', async () => {
    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner({ start: async () => ({ sessionId: 'dap-1', blocked: true, ask: 'log in first' }) }));
    const res = await server.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.result as { blocked: boolean }).blocked).toBe(true);
    const state = await server.handle({ kind: 'request', id: 2, method: 'debug.state', params: {} });
    if (state.ok) expect((state.result as { roadblock: { ask: string } | null }).roadblock?.ask).toBe('log in first');
  });
});

describe('Slice 5 — capture route', () => {
  test('capture.screenshot produces an image card whose payload carries the image', async () => {
    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner());
    await server.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });

    const shot = await server.handle({ kind: 'request', id: 2, method: 'debug.capture.screenshot', params: {} });
    expect(shot.ok).toBe(true);
    if (shot.ok) {
      const out = shot.result as { screenshot: { mimeType: string; dataBase64: string } };
      expect(out.screenshot.mimeType).toBe('image/png');
      expect(out.screenshot.dataBase64).toBeTruthy();
    }

    const state = await server.handle({ kind: 'request', id: 3, method: 'debug.state', params: {} });
    if (state.ok) {
      const card = (state.result as { timeline: Array<{ kind: string; status: string; payload?: any }> })
        .timeline.find((item) => item.kind === 'screenshot');
      expect(card?.status).toBe('done');
      expect(card?.payload.mimeType).toBe('image/png');
    }
  });

  test('capture.console returns entries as a console card', async () => {
    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner());
    await server.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });
    const res = await server.handle({ kind: 'request', id: 2, method: 'debug.capture.console', params: {} });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.result as { entries: Array<{ text: string }> }).entries[0].text).toContain('avatarUrl');
  });

  test('DOM capture surfaces a clear needs-CDP error', async () => {
    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner());
    await server.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });
    const res = await server.handle({ kind: 'request', id: 2, method: 'debug.capture.dom', params: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/CDP/i);
  });
});

describe('Slice 6 — sessions, switcher, root cause', () => {
  test('multiple starts list under debug.sessions and the switcher follows the active session', async () => {
    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner());
    const a = await server.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });
    const b = await server.handle({ kind: 'request', id: 2, method: 'debug.start', params: { ...START_PARAMS, scenario: { title: 'second bug' } } });
    const firstId = a.ok ? (a.result as { session: { id: string } }).session.id : '';
    const secondId = b.ok ? (b.result as { session: { id: string } }).session.id : '';

    const sessions = await server.handle({ kind: 'request', id: 3, method: 'debug.sessions', params: {} });
    if (sessions.ok) {
      const out = sessions.result as { sessions: Array<{ id: string }>; activeId: string };
      expect(out.sessions.length).toBe(2);
      expect(out.activeId).toBe(secondId);
    }

    const selected = await server.handle({ kind: 'request', id: 4, method: 'debug.select', params: { id: firstId } });
    expect(selected.ok).toBe(true);
    const state = await server.handle({ kind: 'request', id: 5, method: 'debug.state', params: {} });
    if (state.ok) expect((state.result as { session: { id: string } }).session.id).toBe(firstId);
  });

  test('root cause is mirrored in state with jump-to-line coordinates', async () => {
    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner());
    await server.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });
    const res = await server.handle({
      kind: 'request', id: 2, method: 'debug.rootCause',
      params: { summary: 'avatarUrl never set by /api/me', file: 'UserCard.tsx', line: 18 },
    });
    expect(res.ok).toBe(true);
    const state = await server.handle({ kind: 'request', id: 3, method: 'debug.state', params: {} });
    if (state.ok) {
      const s = state.result as { status: string; rootCause: { summary: string; file: string; line: number } | null };
      expect(s.status).toBe('root-caused');
      expect(s.rootCause?.line).toBe(18);
      expect(s.rootCause?.file).toBe('UserCard.tsx');
    }
  });
});

/* Phase 1.5 — web auto-nav is an OPTIONAL, detected capability. When the
   runner reports it (playwright installed), the agent drives the web surface;
   when absent, driving degrades to the existing roadblock handoff — one seam,
   no bifurcation. */
function drivingRunner(): DebugRunner {
  const navigate = vi.fn().mockResolvedValue({ url: 'http://localhost/settings', ok: true });
  const click = vi.fn().mockResolvedValue({ ok: true });
  const fill = vi.fn().mockResolvedValue({ ok: true });
  const login = vi.fn().mockResolvedValue({ ok: true });
  return {
    ...mockRunner(),
    capabilities: async () => ({ webAutoNav: true }),
    drive: { navigate, click, fill, login },
  } as DebugRunner;
}

describe('Phase 1.5 — web auto-nav (optional capability)', () => {
  test('debug.start records capabilities from the runner; default is no auto-nav', async () => {
    const plain = new HostRpcServer();
    plain.setDebugRunner(mockRunner());
    await plain.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });
    const plainState = await plain.handle({ kind: 'request', id: 2, method: 'debug.state', params: {} });
    if (plainState.ok) expect((plainState.result as { capabilities: { webAutoNav: boolean } }).capabilities.webAutoNav).toBe(false);

    const driving = new HostRpcServer();
    driving.setDebugRunner(drivingRunner());
    await driving.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });
    const cap = await driving.handle({ kind: 'request', id: 2, method: 'debug.capabilities', params: {} });
    if (cap.ok) expect((cap.result as { webAutoNav: boolean }).webAutoNav).toBe(true);
  });

  test('debug.navigate drives the surface when auto-nav is available', async () => {
    const server = new HostRpcServer();
    const runner = drivingRunner();
    server.setDebugRunner(runner);
    await server.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });
    const res = await server.handle({ kind: 'request', id: 2, method: 'debug.navigate', params: { url: 'http://localhost/settings' } });
    expect(res.ok).toBe(true);
    expect(runner.drive!.navigate).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://localhost/settings' }));
    const state = await server.handle({ kind: 'request', id: 3, method: 'debug.state', params: {} });
    if (state.ok) {
      const card = (state.result as { timeline: Array<{ kind: string }> }).timeline.find((c) => c.kind === 'navigate');
      expect(card).toBeTruthy();
    }
  });

  test('debug.navigate degrades to a roadblock when auto-nav is absent', async () => {
    const server = new HostRpcServer();
    server.setDebugRunner(mockRunner()); // no capabilities/drive
    await server.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });
    const res = await server.handle({ kind: 'request', id: 2, method: 'debug.navigate', params: { url: 'http://localhost/settings' } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const out = res.result as { blocked: boolean; ask: string };
      expect(out.blocked).toBe(true);
      expect(out.ask).toMatch(/settings/);
    }
    const state = await server.handle({ kind: 'request', id: 3, method: 'debug.state', params: {} });
    if (state.ok) {
      const s = state.result as { status: string; roadblock: { ask: string } | null };
      expect(s.status).toBe('blocked');
      expect(s.roadblock).not.toBeNull();
    }
  });

  test('debug.login passes secret HANDLES to the runner (never values) and logs a card', async () => {
    const server = new HostRpcServer();
    const runner = drivingRunner();
    server.setDebugRunner(runner);
    await server.handle({ kind: 'request', id: 1, method: 'debug.start', params: START_PARAMS });
    const res = await server.handle({
      kind: 'request', id: 2, method: 'debug.login',
      params: { usernameSelector: '#user', passwordSelector: '#pass', usernameSecret: 'LOGIN_USER', passwordSecret: 'LOGIN_PASS' },
    });
    expect(res.ok).toBe(true);
    expect(runner.drive!.login).toHaveBeenCalledWith(expect.objectContaining({
      usernameSecret: 'LOGIN_USER',
      passwordSecret: 'LOGIN_PASS',
    }));
    const state = await server.handle({ kind: 'request', id: 3, method: 'debug.state', params: {} });
    if (state.ok) {
      const card = (state.result as { timeline: Array<{ kind: string; payload?: any }> }).timeline.find((c) => c.kind === 'login');
      expect(card).toBeTruthy();
      // the card must not leak anything resembling a raw value — only handles/selectors.
      expect(JSON.stringify(card?.payload ?? {})).not.toMatch(/value/i);
    }
  });
});
