/* debug-suite handlers — sessions, breakpoints, stepping, capture, roadblocks — registered against the core server by
   registerBuiltinHandlers(). HostInternals documents exactly which
   server state this domain touches. */

import type { HostInternals } from './internals';
import type {
  DebugAdapterProbe,
  DebugBreakpointRecord,
  DebugBreakpointSpec,
  DebugRootCause,
  DebugScenario,
  DebugTrust,
} from '../rpc-server';
import {
  debugErrMessage,
  resolveDebugAdapter,
  summarizeVariables,
  truncateDebugString,
} from '../rpc-server';

export function registerDebugHandlers(host: HostInternals) {
  host.registerHandler('debug.probe', async (params) => {
    const p = params as {
      adapter?: string;
      config?: Record<string, unknown>;
    };
    const config = p.config ?? {};
    let adapter = '';
    try {
      adapter = resolveDebugAdapter(p.adapter, config);
    } catch (err) {
      return {
        adapter: typeof p.adapter === 'string' ? p.adapter : '',
        command: '',
        available: false,
        detail: debugErrMessage(err),
      } satisfies DebugAdapterProbe;
    }
    if (!host.debugRunner?.probe) {
      return {
        adapter,
        command: '',
        available: false,
        detail: host.debugRunner
          ? 'debug adapter probing is not available in this shell'
          : 'debug is not available without the desktop shell',
      } satisfies DebugAdapterProbe;
    }
    return host.debugRunner.probe({ adapter, config });
  });
  
  host.registerHandler('debug.start', async (params) => {
    const p = params as {
      scenario?: DebugScenario;
      adapter?: string;
      config?: Record<string, unknown>;
      trust?: DebugTrust;
    };
    const runner = host.requireDebugRunner();
    const config = p.config ?? {};
    const adapter = resolveDebugAdapter(p.adapter, config);
    const scenario: DebugScenario = {
      title: p.scenario?.title ?? 'debug session',
      whatsWrong: p.scenario?.whatsWrong,
    };
    const card = host.newDebugCard('start', `start · ${scenario.title}`, 'agent');
    try {
      const started = await runner.start({ adapter, config });
      const session = host.openDebugSession(adapter, scenario, p.trust ?? 'observe', started.sessionId);
      if (runner.capabilities) {
        try {
          host.debug.capabilities = await runner.capabilities({ sessionId: started.sessionId });
        } catch {
          host.debug.capabilities = { webAutoNav: false };
        }
      }
      /* replay any breakpoints the human armed before the session existed. */
      await host.replayBreakpoints(runner, started.sessionId);
      if (started.blocked) {
        host.raiseRoadblock(started.ask ?? 'reproduce the broken state, then continue');
        host.finishDebugCard(card, { status: 'done', payload: { sessionId: started.sessionId, blocked: true, ask: started.ask } });
        return { session, blocked: true, ask: started.ask };
      }
      session.status = 'inspecting';
      host.debug.status = 'inspecting';
      host.finishDebugCard(card, { status: 'done', payload: { sessionId: started.sessionId } });
      return { session };
    } catch (err) {
      host.finishDebugCard(card, { status: 'failed', error: debugErrMessage(err) });
      throw err;
    }
  });
  
  host.registerHandler('debug.setBreakpoints', async (params) => {
    const runner = host.requireDebugRunner();
    const session = host.activeDebugSession();
    const p = params as { file: string; breakpoints?: DebugBreakpointSpec[]; setBy?: 'agent' | 'human' };
    const setBy = p.setBy ?? 'agent';
    const specs = p.breakpoints ?? [];
    const card = host.newDebugCard('setBreakpoints', `bp · ${p.file} (${specs.length})`, setBy);
    try {
      const res = await runner.setBreakpoints({ sessionId: host.dapSessionId(session), file: p.file, breakpoints: specs });
      const verified = res.breakpoints ?? [];
      const records: DebugBreakpointRecord[] = specs.map((bp, index) => ({
        file: p.file,
        line: bp.line,
        setBy,
        condition: bp.condition,
        hitCondition: bp.hitCondition,
        logMessage: bp.logMessage,
        verified: verified[index]?.verified,
      }));
      host.debug.breakpoints = [...host.debug.breakpoints.filter((b) => b.file !== p.file), ...records];
      host.finishDebugCard(card, { status: 'done', payload: { file: p.file, breakpoints: records } });
      return { breakpoints: records };
    } catch (err) {
      host.finishDebugCard(card, { status: 'failed', error: debugErrMessage(err) });
      throw err;
    }
  });
  
  /* human (or agent) arms a single breakpoint — works with no active session
     (it's stored as intent and replayed on start), so the user can set
     breakpoints for the AI to hit before debugging even begins. */
  host.registerHandler('debug.addBreakpoint', async (params) => {
    const p = params as { file: string; line: number; condition?: string; setBy?: 'agent' | 'human' };
    const setBy = p.setBy ?? 'human';
    if (!host.debug.breakpoints.some((bp) => bp.file === p.file && bp.line === p.line)) {
      host.debug.breakpoints = [...host.debug.breakpoints, { file: p.file, line: p.line, setBy, condition: p.condition }];
    }
    await host.syncBreakpointsForFile(p.file);
    host.publishDebug();
    return { breakpoints: host.debug.breakpoints.map((bp) => ({ ...bp })) };
  });
  host.registerHandler('debug.removeBreakpoint', async (params) => {
    const { file, line } = params as { file: string; line: number };
    host.debug.breakpoints = host.debug.breakpoints.filter((bp) => !(bp.file === file && bp.line === line));
    await host.syncBreakpointsForFile(file);
    host.publishDebug();
    return { breakpoints: host.debug.breakpoints.map((bp) => ({ ...bp })) };
  });
  
  host.registerHandler('debug.continue', async (params) => {
    const runner = host.requireDebugRunner();
    return host.execDebugStop('continue', params, (args) => runner.continue(args));
  });
  host.registerHandler('debug.stepOver', async (params) => {
    const runner = host.requireDebugRunner();
    return host.execDebugStop('stepOver', params, (args) => runner.stepOver(args));
  });
  host.registerHandler('debug.stepIn', async (params) => {
    const runner = host.requireDebugRunner();
    return host.execDebugStop('stepIn', params, (args) => runner.stepIn(args));
  });
  host.registerHandler('debug.stepOut', async (params) => {
    const runner = host.requireDebugRunner();
    return host.execDebugStop('stepOut', params, (args) => runner.stepOut(args));
  });
  host.registerHandler('debug.pause', async (params) => {
    const runner = host.requireDebugRunner();
    return host.execDebugStop('pause', params, (args) => runner.pause(args));
  });
  
  host.registerHandler('debug.stackTrace', async (params) => {
    const runner = host.requireDebugRunner();
    const session = host.activeDebugSession();
    const p = (params as { threadId?: number }) ?? {};
    const card = host.newDebugCard('stackTrace', 'stackTrace', 'agent');
    try {
      const res = await runner.stackTrace({ sessionId: host.dapSessionId(session), threadId: p.threadId });
      const frames = (res.frames ?? []).slice(0, 50);
      host.finishDebugCard(card, { status: 'done', payload: { frames } });
      return { frames, total: res.frames?.length ?? frames.length };
    } catch (err) {
      host.finishDebugCard(card, { status: 'failed', error: debugErrMessage(err) });
      throw err;
    }
  });
  
  host.registerHandler('debug.scopes', async (params) => {
    const runner = host.requireDebugRunner();
    const session = host.activeDebugSession();
    const { frameId } = params as { frameId: number };
    const card = host.newDebugCard('scopes', `scopes · frame ${frameId}`, 'agent');
    try {
      const res = await runner.scopes({ sessionId: host.dapSessionId(session), frameId });
      host.finishDebugCard(card, { status: 'done', payload: { scopes: res.scopes } });
      return { scopes: res.scopes };
    } catch (err) {
      host.finishDebugCard(card, { status: 'failed', error: debugErrMessage(err) });
      throw err;
    }
  });
  
  host.registerHandler('debug.variables', async (params) => {
    const runner = host.requireDebugRunner();
    const session = host.activeDebugSession();
    const { variablesReference } = params as { variablesReference: number };
    const card = host.newDebugCard('variables', `variables · ref ${variablesReference}`, 'agent');
    try {
      const res = await runner.variables({ sessionId: host.dapSessionId(session), variablesReference });
      const summary = summarizeVariables(res.variables ?? []);
      host.finishDebugCard(card, { status: 'done', payload: summary });
      return summary;
    } catch (err) {
      host.finishDebugCard(card, { status: 'failed', error: debugErrMessage(err) });
      throw err;
    }
  });
  
  host.registerHandler('debug.evaluate', async (params) => {
    const runner = host.requireDebugRunner();
    const session = host.activeDebugSession();
    const p = params as { expression: string; frameId?: number };
    /* trust gate — not a per-call confirm (that murders the loop); the
       human sets the level and the live card log is the guardrail. */
    if (session.trust !== 'evaluate') {
      throw new Error(`evaluate is refused in "${session.trust}" trust mode — raise the session to "evaluate" first`);
    }
    const card = host.newDebugCard('evaluate', `eval · ${p.expression}`, 'agent');
    try {
      const res = await runner.evaluate({ sessionId: host.dapSessionId(session), expression: p.expression, frameId: p.frameId });
      const scrub = host.debugScrubber ?? ((text: string) => text);
      const result = truncateDebugString(await scrub(res.result ?? '')).value;
      const hasRef = Boolean(res.variablesReference && res.variablesReference > 0);
      host.finishDebugCard(card, { status: 'done', payload: { expression: p.expression, result, type: res.type } });
      return { result, type: res.type, ref: hasRef ? res.variablesReference : undefined, more: hasRef || undefined };
    } catch (err) {
      host.finishDebugCard(card, { status: 'failed', error: debugErrMessage(err) });
      throw err;
    }
  });
  
  host.registerHandler('debug.setTrust', (params) => {
    const session = host.activeDebugSession();
    const { trust } = params as { trust: DebugTrust };
    session.trust = trust;
    host.publishDebug();
    return { trust };
  });
  
  /* roadblock handoff — non-blocking: the tool returns immediately, the
     panel shows the banner, the human reproduces the state in the app's
     own window and clicks continue (debug.roadblock.resolve). */
  host.registerHandler('debug.roadblock', (params) => {
    const { ask } = params as { ask?: string };
    host.raiseRoadblock(ask ?? 'reproduce the broken state, then continue');
    return { blocked: true, ask: host.debug.roadblock?.ask };
  });
  host.registerHandler('debug.roadblock.resolve', () => {
    const had = Boolean(host.debug.roadblock);
    host.debug.roadblock = null;
    host.debug.status = host.debug.session ? 'inspecting' : 'idle';
    if (host.debug.session) host.debug.session.status = host.debug.status;
    if (had) {
      const card = host.newDebugCard('roadblock', 'continued', 'human');
      host.finishDebugCard(card, { status: 'done', payload: { resolved: true } });
    } else {
      host.publishDebug();
    }
    return { resolved: had };
  });
  
  /* capture route — screenshot + console reuse preview_native; DOM/network
     need a CDP attachment (deferred), surfaced as a clear error. */
  host.registerHandler('debug.capture.screenshot', async (params) => {
    const runner = host.requireDebugRunner();
    const session = host.activeDebugSession();
    const p = (params as { target?: string }) ?? {};
    const card = host.newDebugCard('screenshot', 'screenshot', 'agent');
    try {
      const screenshot = await runner.capture.screenshot({ sessionId: host.dapSessionId(session), target: p.target });
      host.finishDebugCard(card, { status: 'done', payload: { mimeType: screenshot.mimeType, dataBase64: screenshot.dataBase64 } });
      return { screenshot };
    } catch (err) {
      host.finishDebugCard(card, { status: 'failed', error: debugErrMessage(err) });
      throw err;
    }
  });
  host.registerHandler('debug.capture.console', async (params) => {
    const runner = host.requireDebugRunner();
    const session = host.activeDebugSession();
    const p = (params as { limit?: number }) ?? {};
    const card = host.newDebugCard('console', 'console', 'agent');
    try {
      const res = await runner.capture.console({ sessionId: host.dapSessionId(session), limit: p.limit });
      host.finishDebugCard(card, { status: 'done', payload: { entries: res.entries } });
      return { entries: res.entries };
    } catch (err) {
      host.finishDebugCard(card, { status: 'failed', error: debugErrMessage(err) });
      throw err;
    }
  });
  host.registerHandler('debug.capture.dom', async (params) => {
    const runner = host.requireDebugRunner();
    const session = host.activeDebugSession();
    const card = host.newDebugCard('dom', 'dom', 'agent');
    try {
      if (!runner.capture.dom) throw new Error('DOM capture needs a CDP attachment (deferred to phase 1.5 — see spec §5a / §11)');
      const dom = await runner.capture.dom({ sessionId: host.dapSessionId(session), selector: (params as { selector?: string })?.selector });
      host.finishDebugCard(card, { status: 'done', payload: { dom } });
      return { dom };
    } catch (err) {
      host.finishDebugCard(card, { status: 'failed', error: debugErrMessage(err) });
      throw err;
    }
  });
  host.registerHandler('debug.capture.network', async () => {
    const runner = host.requireDebugRunner();
    const session = host.activeDebugSession();
    const card = host.newDebugCard('network', 'network', 'agent');
    try {
      if (!runner.capture.network) throw new Error('network capture needs a CDP attachment (deferred to phase 1.5 — see spec §5a / §11)');
      const network = await runner.capture.network({ sessionId: host.dapSessionId(session) });
      host.finishDebugCard(card, { status: 'done', payload: { network } });
      return { network };
    } catch (err) {
      host.finishDebugCard(card, { status: 'failed', error: debugErrMessage(err) });
      throw err;
    }
  });
  
  host.registerHandler('debug.rootCause', (params) => {
    const { summary, file, line } = params as DebugRootCause;
    host.debug.rootCause = { summary, file, line };
    host.debug.status = 'root-caused';
    if (host.debug.session) host.debug.session.status = 'root-caused';
    const card = host.newDebugCard('rootCause', summary, 'agent');
    host.finishDebugCard(card, { status: 'done', payload: { summary, file, line } });
    return { rootCause: host.debug.rootCause };
  });
  
  /* web auto-nav (phase 1.5, optional) — drives the web surface when the
     shell detected playwright; otherwise degrades to the roadblock handoff. */
  host.registerHandler('debug.capabilities', () => ({ ...host.debug.capabilities }));
  host.registerHandler('debug.navigate', async (params) => {
    const { url } = params as { url: string };
    return host.execDrive('navigate', `navigate · ${url}`, `open ${url} in the app, then continue`, { url },
      (drive, session) => drive.navigate({ sessionId: host.dapSessionId(session), url }));
  });
  host.registerHandler('debug.click', async (params) => {
    const { selector } = params as { selector: string };
    return host.execDrive('click', `click · ${selector}`, `click ${selector} in the app, then continue`, { selector },
      (drive, session) => drive.click({ sessionId: host.dapSessionId(session), selector }));
  });
  host.registerHandler('debug.fill', async (params) => {
    const { selector, text } = params as { selector: string; text: string };
    return host.execDrive('fill', `fill · ${selector}`, `fill ${selector} in the app, then continue`, { selector },
      (drive, session) => drive.fill({ sessionId: host.dapSessionId(session), selector, text }));
  });
  host.registerHandler('debug.login', async (params) => {
    const p = params as {
      url?: string;
      usernameSelector: string;
      passwordSelector: string;
      usernameSecret: string;
      passwordSecret: string;
      submitSelector?: string;
      scope?: 'user' | 'project';
    };
    /* the card records only selectors + secret HANDLES — never values; the
       shell resolves handles to values and types them, so the agent and the
       timeline never see the raw secret. */
    const cardPayload = {
      usernameSelector: p.usernameSelector,
      passwordSelector: p.passwordSelector,
      usernameSecret: p.usernameSecret,
      passwordSecret: p.passwordSecret,
    };
    return host.execDrive('login', 'login', 'log in to the app, then continue', cardPayload,
      (drive, session) => drive.login({ sessionId: host.dapSessionId(session), ...p }));
  });
  
  host.registerHandler('debug.sessions', () => ({
    sessions: host.debug.sessions.map((session) => ({ ...session })),
    activeId: host.debug.session?.id ?? null,
  }));
  host.registerHandler('debug.select', (params) => {
    const { id } = params as { id: string };
    const next = host.debug.sessions.find((session) => session.id === id);
    if (!next) throw new Error(`debug session not found: ${id}`);
    host.debug.session = next;
    host.debug.status = next.status;
    host.publishDebug();
    return { session: { ...next } };
  });
  host.registerHandler('debug.state', () => host.debugSnapshot());
  host.registerHandler('debug.stop', async () => {
    const session = host.debug.session;
    if (host.debugRunner?.stop && session) {
      try {
        await host.debugRunner.stop({ sessionId: host.dapSessionId(session) });
      } catch {
        /* best-effort teardown */
      }
    }
    if (session) {
      session.status = 'idle';
      host.debug.sessions = host.debug.sessions.filter((item) => item.id !== session.id);
      host.debug.session = host.debug.sessions[host.debug.sessions.length - 1] ?? null;
    }
    host.debug.stop = null;
    host.debug.roadblock = null;
    host.debug.status = host.debug.session ? host.debug.session.status : 'idle';
    host.publishDebug();
    return { stopped: true };
  });
  
  /* plugins */
}
