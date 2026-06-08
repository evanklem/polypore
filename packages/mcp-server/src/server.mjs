#!/usr/bin/env node

import crypto from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import Ajv from 'ajv';

const cwd = process.cwd();
const projectDir = path.join(cwd, '.polypore');
const cacheDir = path.join(os.homedir(), '.cache', 'polypore');
const stagingRoot = path.join(cacheDir, 'staging');
const statePath = path.join(projectDir, 'mcp-state.json');
const ajv = new Ajv({ allErrors: true });
const looseObjectSchema = { type: 'object', additionalProperties: true };
const stringId = { type: 'string', minLength: 1 };
const stringArray = { type: 'array', items: { type: 'string' } };
const canonicalToolSchema = JSON.parse(readFileSync(modulePath('../../../schemas/mcp-tools.schema.json', 'schemas/mcp-tools.schema.json'), 'utf8'));
ajv.addSchema(canonicalToolSchema, canonicalToolSchema.$id);

function modulePath(moduleRelativePath, cwdRelativePath) {
  try {
    return fileURLToPath(new URL(moduleRelativePath, import.meta.url));
  } catch {
    return path.join(cwd, cwdRelativePath);
  }
}

const toolSchemas = {
  'polypore.manual': objectSchema({ section: { type: 'string' } }),
  'polypore.state.get': objectSchema({ key: stringId }, ['key']),
  'polypore.tasks.add': objectSchema({ label: stringId, panelHint: { type: 'string' } }, ['label']),
  'polypore.tasks.list': objectSchema(),
  'polypore.diagnostics.list': objectSchema({ severity: { type: 'string' }, file: { type: 'string' } }),
  'polypore.verify.run': objectSchema({ id: stringId }, ['id']),
  'polypore.verify.results': objectSchema(),
  'polypore.verify.declare': objectSchema({
    commands: {
      type: 'array',
      items: objectSchema({
        id: stringId,
        label: { type: 'string' },
        command: stringId,
        required: { type: 'boolean' },
      }, ['id', 'command']),
    },
  }, ['commands']),
  'polypore.format.run': objectSchema({ id: stringId, file: { type: 'string' } }, ['id']),
  'polypore.memory.read': objectSchema({ path: stringId }, ['path']),
  'polypore.memory.write': objectSchema({ path: stringId, content: { type: 'string' } }, ['path', 'content']),
  'polypore.memory.link': objectSchema({ from: stringId, to: stringId, displayText: { type: 'string' } }, ['from', 'to']),
  'polypore.memory.handoff': objectSchema({ summary: stringId, nextSteps: stringArray, context: stringArray }, ['summary']),
  'polypore.phase.report': objectSchema({
    phase: stringId,
    status: { type: 'string', enum: ['pending', 'active', 'blocked', 'done'] },
  }, ['phase', 'status']),
  'polypore.workflow.update': objectSchema({
    nodes: { type: 'array', items: looseObjectSchema },
    edges: { type: 'array', items: looseObjectSchema },
  }, ['nodes', 'edges']),
  'polypore.panel.open': objectSchema({ id: stringId, area: { type: 'string', enum: ['center', 'left', 'right', 'bottom'] } }, ['id']),
  'polypore.panel.close': objectSchema({ instanceId: stringId }, ['instanceId']),
  'polypore.ui.notify': objectSchema({
    level: { type: 'string', enum: ['info', 'success', 'warning', 'error'] },
    msg: stringId,
  }, ['level', 'msg']),
  'polypore.preview.register': objectSchema({
    kind: { type: 'string', enum: ['site', 'desktop', 'mobile', 'cli', 'game', 'test'] },
    command: stringId,
    target: stringId,
  }, ['kind', 'command', 'target']),
  'polypore.preview.refresh': objectSchema({ id: { type: 'string' } }),
  'polypore.history.events': objectSchema({ limit: { type: 'integer', minimum: 1 } }),
  'polypore.history.fork': objectSchema({ eventId: stringId }, ['eventId']),
  'polypore.adr.record': objectSchema({ title: stringId, body: { type: 'string' } }, ['title', 'body']),
  'polypore.mcp.invoke': objectSchema({
    server: stringId,
    method: stringId,
    args: looseObjectSchema,
    authRef: { type: 'string' },
  }, ['server', 'method']),
  'polypore.plugins.fetch': objectSchema({ url: stringId, ref: { type: 'string' } }, ['url']),
  'polypore.plugins.scan': objectSchema({ stagingPath: stringId }, ['stagingPath']),
  'polypore.plugins.inspect': objectSchema({ stagingPath: stringId, manifestPath: stringId }, ['stagingPath', 'manifestPath']),
  'polypore.plugins.install': objectSchema({
    stagingPath: stringId,
    manifestPath: stringId,
    scope: { type: 'string', enum: ['project', 'user'] },
  }, ['stagingPath', 'manifestPath']),
  'polypore.plugins.list': objectSchema({ scope: { type: 'string', enum: ['project', 'user', 'builtin'] } }),
  'polypore.plugins.enable': objectSchema({ id: stringId }, ['id']),
  'polypore.plugins.disable': objectSchema({ id: stringId }, ['id']),
  'polypore.plugins.uninstall': objectSchema({ id: stringId }, ['id']),
  'polypore.secrets.list': objectSchema({ scope: { type: 'string', enum: ['project', 'user'] } }),
  'polypore.secrets.has': objectSchema({ id: stringId, scope: { type: 'string', enum: ['project', 'user'] } }, ['id']),
  'polypore.secrets.use': objectSchema({
    id: stringId,
    scope: { type: 'string', enum: ['project', 'user'] },
    request: objectSchema({
      url: stringId,
      method: { type: 'string' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      body: {},
      timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
      allowInsecure: { type: 'boolean' },
    }, ['url']),
  }, ['id', 'request']),
  'polypore.skills.list': objectSchema({ scope: { type: 'string', enum: ['project', 'user'] } }),
  'polypore.skills.read': objectSchema({ id: stringId }, ['id']),
  'polypore.skills.invoke': objectSchema({ id: stringId, sessionId: { type: 'string' }, args: looseObjectSchema }, ['id']),
  'polypore.skills.create': {
    ...objectSchema({ id: stringId, name: stringId, body: { type: 'string' } }, ['body']),
    anyOf: [{ required: ['id'] }, { required: ['name'] }],
  },
  'polypore.skills.update': objectSchema({ id: stringId, body: { type: 'string' } }, ['id', 'body']),
  'polypore.skills.delete': objectSchema({ id: stringId }, ['id']),
  'polypore.skillsets.list': objectSchema(),
  'polypore.skillsets.read': objectSchema({ id: stringId }, ['id']),
  'polypore.skillsets.upsert': objectSchema({
    id: { type: 'string' },
    title: stringId,
    summary: { type: 'string' },
    version: { type: 'string' },
  }, ['title']),
  'polypore.skillsets.delete': objectSchema({ id: stringId }, ['id']),
  'polypore.skills.publish': objectSchema({
    id: stringId,
    agents: { type: 'array', items: { type: 'string', enum: ['claude', 'codex'] } },
  }, ['id', 'agents']),
  'polypore.mcp.servers.list': objectSchema({ scope: { type: 'string', enum: ['project', 'user', 'polypore'] } }),
  'polypore.mcp.servers.upsert': objectSchema({
    id: { type: 'string' },
    name: stringId,
    url: stringId,
    scope: { type: 'string', enum: ['project', 'user', 'polypore'] },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    authRef: { type: 'string' },
    allowInsecure: { type: 'boolean' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
  }, ['name', 'url']),
  'polypore.mcp.servers.delete': objectSchema({ id: stringId }, ['id']),
  'polypore.mcp.servers.test': objectSchema({ id: stringId }, ['id']),
  'polypore.formation.upsert': objectSchema({
    nodes: { type: 'array', items: looseObjectSchema },
    edges: { type: 'array', items: looseObjectSchema },
  }, ['nodes', 'edges']),
  /* ── agentic debug suite ── */
  'polypore.debug.probe': objectSchema({
    adapter: { type: 'string' },
    config: looseObjectSchema,
  }),
  'polypore.debug.start': objectSchema({
    scenario: objectSchema({ title: stringId, whatsWrong: { type: 'string' } }, ['title']),
    adapter: { type: 'string' },
    config: looseObjectSchema,
    trust: { type: 'string', enum: ['observe', 'evaluate', 'off'] },
  }, ['scenario']),
  'polypore.debug.setBreakpoints': objectSchema({
    file: stringId,
    breakpoints: {
      type: 'array',
      items: objectSchema({
        line: { type: 'integer', minimum: 1 },
        condition: { type: 'string' },
        hitCondition: { type: 'string' },
        logMessage: { type: 'string' },
      }, ['line']),
    },
    setBy: { type: 'string', enum: ['agent', 'human'] },
  }, ['file', 'breakpoints']),
  'polypore.debug.addBreakpoint': objectSchema({ file: stringId, line: { type: 'integer', minimum: 1 }, condition: { type: 'string' } }, ['file', 'line']),
  'polypore.debug.removeBreakpoint': objectSchema({ file: stringId, line: { type: 'integer', minimum: 1 } }, ['file', 'line']),
  'polypore.debug.continue': objectSchema({ threadId: { type: 'integer' } }),
  'polypore.debug.stepOver': objectSchema({ threadId: { type: 'integer' } }),
  'polypore.debug.stepIn': objectSchema({ threadId: { type: 'integer' } }),
  'polypore.debug.stepOut': objectSchema({ threadId: { type: 'integer' } }),
  'polypore.debug.pause': objectSchema({ threadId: { type: 'integer' } }),
  'polypore.debug.stackTrace': objectSchema({ threadId: { type: 'integer' } }),
  'polypore.debug.scopes': objectSchema({ frameId: { type: 'integer' } }, ['frameId']),
  'polypore.debug.variables': objectSchema({ variablesReference: { type: 'integer' } }, ['variablesReference']),
  'polypore.debug.evaluate': objectSchema({ expression: stringId, frameId: { type: 'integer' } }, ['expression']),
  'polypore.debug.capture.screenshot': objectSchema({ target: { type: 'string' } }),
  'polypore.debug.capture.console': objectSchema({ limit: { type: 'integer', minimum: 1 } }),
  'polypore.debug.capture.dom': objectSchema({ selector: { type: 'string' } }),
  'polypore.debug.capture.network': objectSchema(),
  'polypore.debug.roadblock': objectSchema({ ask: stringId }, ['ask']),
  'polypore.debug.roadblock.resolve': objectSchema(),
  'polypore.debug.rootCause': objectSchema({ summary: stringId, file: { type: 'string' }, line: { type: 'integer' } }, ['summary']),
  'polypore.debug.sessions': objectSchema(),
  'polypore.debug.select': objectSchema({ id: stringId }, ['id']),
  'polypore.debug.state': objectSchema(),
  'polypore.debug.stop': objectSchema(),
  /* web auto-nav (phase 1.5, optional — degrades to a roadblock) */
  'polypore.debug.capabilities': objectSchema(),
  'polypore.debug.navigate': objectSchema({ url: stringId }, ['url']),
  'polypore.debug.click': objectSchema({ selector: stringId }, ['selector']),
  'polypore.debug.fill': objectSchema({ selector: stringId, text: { type: 'string' } }, ['selector', 'text']),
  'polypore.debug.login': objectSchema({
    url: { type: 'string' },
    usernameSelector: stringId,
    passwordSelector: stringId,
    usernameSecret: stringId,
    passwordSecret: stringId,
    submitSelector: { type: 'string' },
    scope: { type: 'string', enum: ['project', 'user'] },
  }, ['usernameSelector', 'passwordSelector', 'usernameSecret', 'passwordSecret']),
};

const validators = new Map(
  Object.entries(toolSchemas).map(([name, fallbackSchema]) => [
    name,
    ajv.getSchema(`${canonicalToolSchema.$id}#/definitions/${name}.input`) ?? ajv.compile(fallbackSchema),
  ]),
);

const builtinPlugins = [
  'polypore.chat',
  'polypore.preview',
  'polypore.editor',
  'polypore.diff-history',
  'polypore.terminal',
  'polypore.verify',
  'polypore.memory',
  'polypore.agent',
  'polypore.problems',
].map((id) => ({ id, enabled: true, scope: 'builtin', source: 'bundled' }));

const hostRpcTools = new Map(Object.entries({
  'polypore.state.get': 'state.get',
  'polypore.workspace.describe': 'workspace.describe',
  'polypore.editor.open': 'editor.open',
  'polypore.editor.read': 'editor.read',
  'polypore.editor.search': 'editor.search',
  'polypore.tasks.add': 'tasks.add',
  'polypore.tasks.list': 'tasks.list',
  'polypore.tasks.update': 'tasks.update',
  'polypore.diagnostics.list': 'diagnostics.list',
  'polypore.verify.run': 'verify.run',
  'polypore.verify.results': 'verify.runs',
  'polypore.memory.bases': 'knowledge.bases',
  'polypore.memory.list': 'knowledge.list',
  'polypore.memory.read': 'knowledge.read',
  'polypore.memory.write': 'knowledge.write',
  'polypore.memory.link': 'knowledge.link',
  'polypore.memory.handoff': 'knowledge.handoff',
  'polypore.adr.record': 'adr.record',
  'polypore.phase.report': 'phase.report',
  'polypore.workflow.update': 'workflow.update',
  'polypore.panel.open': 'panel.open',
  'polypore.panel.close': 'panel.close',
  'polypore.ui.notify': 'ui.notify',
  'polypore.preview.register': 'preview.register',
  'polypore.preview.refresh': 'preview.refresh',
  'polypore.history.events': 'history.events',
  'polypore.history.fork': 'history.fork',
  'polypore.plugins.list': 'plugins.list',
  'polypore.plugins.enable': 'plugins.enable',
  'polypore.plugins.disable': 'plugins.disable',
  'polypore.skills.list': 'skills.list',
  'polypore.skills.read': 'skills.read',
  'polypore.skills.invoke': 'skills.invoke',
  'polypore.skills.delete': 'skills.delete',
  'polypore.skillsets.list': 'skillsets.list',
  'polypore.skillsets.read': 'skillsets.read',
  'polypore.skillsets.upsert': 'skillsets.upsert',
  'polypore.skillsets.delete': 'skillsets.delete',
  'polypore.mcp.servers.list': 'mcp.servers.list',
  'polypore.mcp.servers.upsert': 'mcp.servers.upsert',
  'polypore.mcp.servers.delete': 'mcp.servers.delete',
  'polypore.mcp.servers.test': 'mcp.servers.test',
  'polypore.formation.upsert': 'formation.upsert',
  'polypore.debug.probe': 'debug.probe',
  'polypore.debug.start': 'debug.start',
  'polypore.debug.setBreakpoints': 'debug.setBreakpoints',
  'polypore.debug.addBreakpoint': 'debug.addBreakpoint',
  'polypore.debug.removeBreakpoint': 'debug.removeBreakpoint',
  'polypore.debug.continue': 'debug.continue',
  'polypore.debug.stepOver': 'debug.stepOver',
  'polypore.debug.stepIn': 'debug.stepIn',
  'polypore.debug.stepOut': 'debug.stepOut',
  'polypore.debug.pause': 'debug.pause',
  'polypore.debug.stackTrace': 'debug.stackTrace',
  'polypore.debug.scopes': 'debug.scopes',
  'polypore.debug.variables': 'debug.variables',
  'polypore.debug.evaluate': 'debug.evaluate',
  'polypore.debug.capture.screenshot': 'debug.capture.screenshot',
  'polypore.debug.capture.console': 'debug.capture.console',
  'polypore.debug.capture.dom': 'debug.capture.dom',
  'polypore.debug.capture.network': 'debug.capture.network',
  'polypore.debug.roadblock': 'debug.roadblock',
  'polypore.debug.roadblock.resolve': 'debug.roadblock.resolve',
  'polypore.debug.rootCause': 'debug.rootCause',
  'polypore.debug.sessions': 'debug.sessions',
  'polypore.debug.select': 'debug.select',
  'polypore.debug.state': 'debug.state',
  'polypore.debug.stop': 'debug.stop',
  'polypore.debug.capabilities': 'debug.capabilities',
  'polypore.debug.navigate': 'debug.navigate',
  'polypore.debug.click': 'debug.click',
  'polypore.debug.fill': 'debug.fill',
  'polypore.debug.login': 'debug.login',
}));

const tools = [
  tool('polypore.manual', 'read the polypore manual. omit args for the table of contents; pass a section slug (from the contents) to read one page.'),
  tool('polypore.state.get', 'read a non-secret polypore state key'),
  tool('polypore.workspace.describe', 'describe the active workspace: open panels, the active panel, and the workspace name'),
  tool('polypore.editor.open', 'open a file in the editor panel at an optional line/col; the human sees it immediately'),
  tool('polypore.editor.read', 'read a file through the editor (live buffer if open, else disk)'),
  tool('polypore.editor.search', 'search the project for a query (literal or regex), optionally scoped by glob; ripgrep-backed'),
  tool('polypore.tasks.add', 'add a task to the active task list'),
  tool('polypore.tasks.list', 'list active task records'),
  tool('polypore.tasks.update', 'update a task: toggle done, rename label, or re-parent'),
  tool('polypore.diagnostics.list', 'list current diagnostics'),
  tool('polypore.verify.run', 'run a declared verify command'),
  tool('polypore.verify.results', 'return verify run records'),
  tool('polypore.verify.declare', 'write .polypore/verify.json'),
  tool('polypore.format.run', 'run a declared formatter command from .polypore/formatters.json. pass file to substitute {file}, {path}, {basename}, and {dir}.'),
  tool('polypore.memory.bases', 'list registered knowledge bases with their id, name, root filesystem path, and scope (project or global). call this first to orient yourself — global bases can be anywhere on disk.'),
  tool('polypore.memory.list', 'list knowledge-base documents and folders'),
  tool('polypore.memory.read', 'read a file under .knowledge'),
  tool('polypore.memory.write', 'write a file under .knowledge'),
  tool('polypore.memory.link', 'append a markdown link between knowledge files'),
  tool('polypore.memory.handoff', 'write a handoff markdown document'),
  tool('polypore.phase.report', 'record phase status'),
  tool('polypore.workflow.update', 'record workflow graph nodes and edges'),
  tool('polypore.panel.open', 'open a panel in the host'),
  tool('polypore.panel.close', 'close a panel instance in the host'),
  tool('polypore.ui.notify', 'show a host notification'),
  tool('polypore.preview.register', 'register an active preview target'),
  tool('polypore.preview.refresh', 'request preview refresh'),
  tool('polypore.history.events', 'list history events'),
  tool('polypore.history.fork', 'create a worktree reference from a history event'),
  tool('polypore.adr.record', 'write an adr markdown document'),
  tool('polypore.mcp.invoke', 'invoke a configured user mcp server with optional secret-handle resolution'),
  tool('polypore.plugins.fetch', 'fetch a plugin repository into staging'),
  tool('polypore.plugins.scan', 'scan staging for valid polypore.json manifests'),
  tool('polypore.plugins.inspect', 'inspect a candidate plugin manifest and file list'),
  tool('polypore.plugins.install', 'install a candidate plugin after host confirmation'),
  tool('polypore.plugins.list', 'list installed polypore plugins'),
  tool('polypore.plugins.enable', 'enable an installed plugin'),
  tool('polypore.plugins.disable', 'disable an installed plugin'),
  tool('polypore.plugins.uninstall', 'uninstall an installed plugin'),
  tool('polypore.secrets.list', 'list masked secret handles. never repeat a secret value back to the user or agent.'),
  tool('polypore.secrets.has', 'check whether a secret handle is configured without returning its value'),
  tool('polypore.secrets.use', 'use a secret handle in a mediated request. never repeat a secret value back to the user or agent.'),
  tool('polypore.skills.list', 'list project and user skills'),
  tool('polypore.skills.read', 'read a skill by id'),
  tool('polypore.skills.invoke', 'record a skill invocation for a chat session'),
  tool('polypore.skills.create', 'create a project skill'),
  tool('polypore.skills.update', 'update a project skill'),
  tool('polypore.skills.delete', 'delete a project skill'),
  tool('polypore.skillsets.list', 'list installed skillsets (bundle of related skills, e.g. polyflow)'),
  tool('polypore.skillsets.read', 'read a skillset manifest and the skills inside it'),
  tool('polypore.skillsets.upsert', 'create or rename a user skillset (folder for skills)'),
  tool('polypore.skillsets.delete', 'delete a user skillset (builtins are read-only). skills inside become loose.'),
  tool('polypore.skills.publish', 'set which agents a polypore-owned skill is published to via symlink. agents = [] keeps it polypore-only. ["claude","codex"] = global.'),
  tool('polypore.mcp.servers.list', 'list registered mcp servers (polypore canonical store, agent-agnostic)'),
  tool('polypore.mcp.servers.upsert', 'add or update an mcp server. omit id to create a new one'),
  tool('polypore.mcp.servers.delete', 'remove an mcp server from the registry'),
  tool('polypore.mcp.servers.test', 'verify an mcp server is reachable via a synthetic tools/list probe'),
  tool('polypore.formation.upsert', 'replace the formation panel with a new nodes/edges spec'),
  /* agentic debug suite — give the chat agent ground-truth runtime state so it
     stops guessing. the debug panel is a passive visualizer of these calls. */
  tool('polypore.debug.probe', 'validate debug adapter metadata and PATH availability before starting a session. pass adapter explicitly, set config.type for a known DAP adapter, or set config.adapterCommand for a custom DAP server.'),
  tool('polypore.debug.start', 'begin a debug session from a Scenario {title, whatsWrong}. pass adapter explicitly, set config.type for a known DAP adapter, or set config.adapterCommand for a custom DAP server. trust defaults to "observe" (no evaluate).'),
  tool('polypore.debug.setBreakpoints', 'set/clear breakpoints for a file (condition, hitCondition, logMessage supported)'),
  tool('polypore.debug.addBreakpoint', 'arm a single breakpoint (works before a session starts; replayed on start). the human can also set these in the debug panel.'),
  tool('polypore.debug.removeBreakpoint', 'clear a single armed breakpoint by file + line'),
  tool('polypore.debug.continue', 'resume execution; blocks until the next stop or termination, returns the new stop location + attribution'),
  tool('polypore.debug.stepOver', 'step over; blocks until the next stop'),
  tool('polypore.debug.stepIn', 'step into; blocks until the next stop'),
  tool('polypore.debug.stepOut', 'step out; blocks until the next stop'),
  tool('polypore.debug.pause', 'pause a running program; blocks until it stops'),
  tool('polypore.debug.stackTrace', 'list stack frames for the paused thread'),
  tool('polypore.debug.scopes', 'list variable scopes for a frame'),
  tool('polypore.debug.variables', 'inspect a variables reference (summarized — capped, with drillable refs for nested values)'),
  tool('polypore.debug.evaluate', 'evaluate an expression in a frame. refused unless the session trust level is "evaluate"; output is scrubbed of secrets.'),
  tool('polypore.debug.capture.screenshot', 'capture a screenshot of the debuggee surface'),
  tool('polypore.debug.capture.console', 'capture recent console output from the debuggee'),
  tool('polypore.debug.capture.dom', 'capture DOM/CSS (needs a CDP attachment — deferred; returns a clear error in slice 1)'),
  tool('polypore.debug.capture.network', 'capture network activity (needs a CDP attachment — deferred; returns a clear error in slice 1)'),
  tool('polypore.debug.roadblock', 'raise a roadblock asking the human to reproduce a state you cannot reach (login, click-through). non-blocking — re-issue your call after they continue.'),
  tool('polypore.debug.roadblock.resolve', 'mark the current roadblock resolved (normally the human clicks this in the panel)'),
  tool('polypore.debug.rootCause', 'record the root cause (summary + optional file/line) — mirrored read-only in the panel; propose the fix in chat'),
  tool('polypore.debug.sessions', 'list debug sessions and the active session id'),
  tool('polypore.debug.select', 'switch the active debug session'),
  tool('polypore.debug.state', 'read the current debug state: session, timeline, current stop, roadblock'),
  tool('polypore.debug.stop', 'end the active debug session'),
  tool('polypore.debug.capabilities', 'check optional reproduction capabilities (e.g. webAutoNav when playwright is installed). when false, driving tools degrade to a roadblock handoff.'),
  tool('polypore.debug.navigate', 'navigate the web surface to a URL (web auto-nav). degrades to a roadblock when playwright is not installed.'),
  tool('polypore.debug.click', 'click a selector on the web surface (web auto-nav). degrades to a roadblock when unavailable.'),
  tool('polypore.debug.fill', 'fill a selector with text on the web surface (web auto-nav). degrades to a roadblock when unavailable.'),
  tool('polypore.debug.login', 'log in by injecting secret HANDLES into username/password fields — the shell resolves handles to values, you never see the secret. degrades to a roadblock when unavailable.'),
];

function tool(name, description) {
  return { name, description, inputSchema: expandRefs(canonicalToolSchema.definitions?.[`${name}.input`] ?? toolSchemas[name] ?? looseObjectSchema) };
}

function expandRefs(schema) {
  if (Array.isArray(schema)) return schema.map(expandRefs);
  if (!schema || typeof schema !== 'object') return schema;
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/definitions/')) {
    const key = schema.$ref.slice('#/definitions/'.length);
    const target = canonicalToolSchema.definitions?.[key];
    if (target) return expandRefs(target);
  }
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, expandRefs(value)]));
}

function objectSchema(properties = {}, required = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function error(id, code, message, data) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } })}\n`);
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch {
    return { tasks: [], verifyRuns: [], diagnostics: [], history: [], plugins: [], previews: [], notifications: [], panels: [], workflow: null, phases: [], mcpServers: [] };
  }
}

async function writeState(state) {
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function handleTool(name, args = {}) {
  validateToolInput(name, args);
  const state = await readState();

  if (name === 'polypore.manual') {
    return content(await buildManual(args.section));
  }
  if (hostRpcConfigured() && name === 'polypore.tasks.update') {
    /* MCP exposes a flat shape; the host RPC takes { id, patch }. */
    const { id, ...rest } = args;
    return hostRpcCall('tasks.update', { id, patch: rest });
  }
  if (hostRpcConfigured() && hostRpcTools.has(name)) {
    return hostRpcCall(hostRpcTools.get(name), args);
  }
  if (hostRpcConfigured() && (name === 'polypore.skills.create' || name === 'polypore.skills.update')) {
    const id = slug(args.id ?? args.name);
    return hostRpcCall('skills.write', {
      ...args,
      id,
      name: args.name ?? id,
    });
  }
  if (name === 'polypore.state.get') return { value: state[args.key] ?? null };
  if (name === 'polypore.workspace.describe') {
    return {
      workspace: state.workspace ?? 'Default',
      panels: state.panels ?? [],
      activePanel: state.activePanel ?? null,
    };
  }
  if (name === 'polypore.editor.open') {
    /* standalone has no live editor surface; record the intent so the next
       broker-backed read/describe reflects it, and echo the request. */
    const target = resolveUnder(cwd, args.path);
    return { opened: rel(target), line: args.line ?? null, col: args.col ?? null, live: false };
  }
  if (name === 'polypore.editor.read') {
    const target = resolveUnder(cwd, args.path);
    return { path: rel(target), content: await fs.readFile(target, 'utf8') };
  }
  if (name === 'polypore.editor.search') return searchProject(args);
  if (name === 'polypore.tasks.add') {
    const task = { id: `task-${Date.now()}`, label: String(args.label ?? 'task'), status: 'pending', panelHint: args.panelHint ?? null };
    state.tasks.unshift(task);
    await writeState(state);
    return { task };
  }
  if (name === 'polypore.tasks.list') return { tasks: state.tasks };
  if (name === 'polypore.tasks.update') {
    const task = (state.tasks ?? []).find((item) => item.id === args.id);
    if (!task) throw Object.assign(new Error(`task not found: ${args.id}`), { code: -32602 });
    if (args.done !== undefined) task.status = args.done ? 'done' : 'pending';
    if (args.label !== undefined) task.label = String(args.label);
    if (args.parentId !== undefined) task.parentId = args.parentId;
    if (args.panelHint !== undefined) task.panelHint = args.panelHint;
    await writeState(state);
    return { task };
  }
  if (name === 'polypore.memory.bases') return { bases: listKnowledgeBases() };
  if (name === 'polypore.memory.list') return { documents: await listKnowledge() };
  if (name === 'polypore.diagnostics.list') return { diagnostics: filterDiagnostics(state.diagnostics, args) };
  if (name === 'polypore.verify.declare') {
    const verifyPath = path.join(projectDir, 'verify.json');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(verifyPath, `${JSON.stringify(args.commands ?? [], null, 2)}\n`);
    return { declared: true, path: rel(verifyPath) };
  }
  if (name === 'polypore.verify.run') {
    const run = runVerify(args.id ?? 'typecheck');
    state.verifyRuns.unshift(run);
    await writeState(state);
    return { run };
  }
  if (name === 'polypore.format.run') return { run: runFormatter(args.id, args.file) };
  if (name === 'polypore.verify.results') return { runs: state.verifyRuns };
  if (name === 'polypore.memory.read') return { content: await fs.readFile(resolveKnowledge(args.path), 'utf8') };
  if (name === 'polypore.memory.write') {
    const target = resolveKnowledge(args.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, String(args.content ?? ''));
    return { written: true, path: rel(target) };
  }
  if (name === 'polypore.memory.link') {
    const from = resolveKnowledge(args.from);
    const link = `[${args.displayText ?? args.to}](${args.to})`;
    await fs.appendFile(from, `\n${link}\n`);
    return { linked: true };
  }
  if (name === 'polypore.memory.handoff') {
    const target = path.join(cwd, '.knowledge', 'handoffs', `${new Date().toISOString().slice(0, 10)}-${slug(args.summary ?? 'handoff')}.md`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `# handoff\n\n${args.summary ?? ''}\n\n## next steps\n${(args.nextSteps ?? []).map((x) => `- ${x}`).join('\n')}\n\n## context\n${(args.context ?? []).map((x) => `- ${x}`).join('\n')}\n`);
    return { path: rel(target) };
  }
  if (name === 'polypore.phase.report') {
    state.phases.unshift({ phase: args.phase, status: args.status, ts: Date.now() });
    await writeState(state);
    return { reported: true };
  }
  if (name === 'polypore.workflow.update') {
    state.workflow = { nodes: args.nodes ?? [], edges: args.edges ?? [], ts: Date.now() };
    await writeState(state);
    return { updated: true };
  }
  if (name === 'polypore.panel.open') {
    const instance = { instanceId: `${args.id}:${state.panels.length + 1}`, id: args.id, area: args.area ?? 'center' };
    state.panels.push(instance);
    await writeState(state);
    return { instanceId: instance.instanceId };
  }
  if (name === 'polypore.panel.close') {
    state.panels = state.panels.filter((panel) => panel.instanceId !== args.instanceId);
    await writeState(state);
    return { closed: true };
  }
  if (name === 'polypore.ui.notify') {
    state.notifications.unshift({ level: args.level ?? 'info', msg: args.msg ?? '', ts: Date.now() });
    await writeState(state);
    return { shown: true };
  }
  if (name === 'polypore.preview.register') {
    const registeredAt = Date.now();
    const target = {
      id: `preview-${registeredAt}`,
      kind: args.kind ?? 'site',
      label: args.target || args.command || 'preview',
      command: args.command ?? '',
      target: args.target ?? '',
      registeredAt,
    };
    state.previews.unshift(target);
    await writeState(state);
    return { target };
  }
  if (name === 'polypore.preview.refresh') return { refreshed: true };
  if (name === 'polypore.history.events') return { events: state.history };
  if (name === 'polypore.history.fork') return { worktree: { id: `worktree-${Date.now()}`, eventId: args.eventId, path: rel(cwd) } };
  if (name === 'polypore.adr.record') {
    const target = path.join(cwd, '.knowledge', 'adrs', `${new Date().toISOString().slice(0, 10)}-${slug(args.title ?? 'adr')}.md`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `# ${args.title ?? 'adr'}\n\n${args.body ?? ''}\n`);
    return { path: rel(target) };
  }
  if (name === 'polypore.mcp.invoke') return invokeMcp(state, args);
  if (name === 'polypore.plugins.fetch') return fetchPlugin(args);
  if (name === 'polypore.plugins.scan') return scanPlugins(args.stagingPath);
  if (name === 'polypore.plugins.inspect') return inspectPlugin(args.stagingPath, args.manifestPath);
  if (name === 'polypore.plugins.install') return installPlugin(state, args);
  if (name === 'polypore.plugins.list') return { plugins: [...builtinPlugins, ...state.plugins].filter((p) => !args.scope || p.scope === args.scope || p.scope === 'builtin') };
  if (name === 'polypore.plugins.enable' || name === 'polypore.plugins.disable') {
    const enabled = name.endsWith('enable');
    if (!state.plugins.some((plugin) => plugin.id === args.id)) {
      return { enabled: false, reason: 'not_found', id: args.id };
    }
    state.plugins = state.plugins.map((plugin) => plugin.id === args.id ? { ...plugin, enabled } : plugin);
    await writeState(state);
    return { enabled, id: args.id };
  }
  if (name === 'polypore.plugins.uninstall') {
    if (!state.plugins.some((plugin) => plugin.id === args.id)) {
      return { uninstalled: false, reason: 'not_found', id: args.id };
    }
    if (hostRpcConfigured()) {
      const confirmation = await hostRpcCall('plugins.confirmUninstall', { id: args.id });
      if (!confirmation.confirmed) return { uninstalled: false, reason: 'user_declined' };
    }
    state.plugins = state.plugins.filter((plugin) => plugin.id !== args.id);
    await writeState(state);
    if (hostRpcConfigured()) await hostRpcCall('plugins.uninstall', { id: args.id });
    return { uninstalled: true, id: args.id };
  }
  if (name === 'polypore.secrets.list') return { secrets: await listSecrets(args.scope) };
  if (name === 'polypore.secrets.has') return secretHas(args);
  if (name === 'polypore.secrets.use') return useSecret(args);
  if (name === 'polypore.skills.list') return { skills: await listSkills(args.scope) };
  if (name === 'polypore.skills.read') return { skill: await readSkill(args.id) };
  if (name === 'polypore.skills.invoke') return { invoked: true };
  if (name === 'polypore.skills.create' || name === 'polypore.skills.update') return writeSkill(args);
  if (name === 'polypore.skills.delete') return deleteSkill(args.id);
  if (name === 'polypore.skills.publish') {
    const { id, agents } = args;
    /* tell the host to update its in-memory publishedTo */
    if (hostRpcConfigured()) await hostRpcCall('skills.publish', { id, agents }).catch(() => {});
    if (!agents.length) {
      await unpublishSkillFromAgents(id);
      return { published: [] };
    }
    /* read the skill body (and name) from host (if running) or from disk */
    let body = '';
    let skillName = id;
    if (hostRpcConfigured()) {
      try {
        const skill = (await hostRpcCall('skills.read', { id })).skill;
        body = skill?.body ?? '';
        skillName = skill?.name ?? id;
      } catch {}
    } else {
      try { body = await fs.readFile(resolveSkillPath(projectSkillsDir(), id), 'utf8'); } catch {}
      try { body = await fs.readFile(path.join(projectSkillsDir(), id, 'SKILL.md'), 'utf8'); } catch {}
    }
    /* write as dir-based skill: {id}/SKILL.md with frontmatter — the format
       that Claude Code slash-completion and Polypore's slash catalog expect. */
    const skillDir = path.join(projectSkillsDir(), id);
    await fs.mkdir(skillDir, { recursive: true });
    const description = (body.split('\n').find((l) => l.trim() && !l.trim().startsWith('---')) ?? '').slice(0, 100);
    const skillMd = `---\nname: ${skillName}\ndescription: ${description}\n---\n\n${body}`;
    const skillFilePath = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(skillFilePath, skillMd);
    /* remove legacy flat .md file for the same id if it exists */
    try { await fs.unlink(resolveSkillPath(projectSkillsDir(), id)); } catch {}
    await publishSkillToAgents(id, skillFilePath);
    return { published: agents };
  }
  if (name === 'polypore.skillsets.list') return { skillsets: await listSkillsets() };
  if (name === 'polypore.skillsets.read') return readSkillset(args.id);
  if (name === 'polypore.mcp.servers.list') {
    const servers = await readMcpServers(state);
    return { servers: args.scope ? servers.filter((s) => s.scope === args.scope) : servers };
  }
  if (name === 'polypore.mcp.servers.upsert') {
    const id = args.id ?? `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const server = {
      id,
      name: args.name,
      url: args.url,
      scope: args.scope ?? 'polypore',
      headers: args.headers,
      authRef: args.authRef,
      allowInsecure: args.allowInsecure,
      timeoutMs: args.timeoutMs,
    };
    state.mcpServers = [server, ...(state.mcpServers ?? []).filter((s) => s.id !== id)];
    await writeState(state);
    return { server };
  }
  if (name === 'polypore.mcp.servers.delete') {
    if (!(state.mcpServers ?? []).some((s) => s.id === args.id)) {
      return { deleted: false, reason: 'not_found' };
    }
    state.mcpServers = (state.mcpServers ?? []).filter((s) => s.id !== args.id);
    await writeState(state);
    return { deleted: true, id: args.id };
  }
  if (name === 'polypore.mcp.servers.test') {
    const server = (state.mcpServers ?? []).find((s) => s.id === args.id);
    if (!server) throw Object.assign(new Error(`mcp server not found: ${args.id}`), { code: -32602 });
    try {
      const response = await httpRequest(
        server.url,
        'POST',
        { 'content-type': 'application/json' },
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        Math.min(server.timeoutMs ?? 5000, 10000),
      );
      const ok = response.status >= 200 && response.status < 400;
      const lastTest = { ok, ts: Date.now(), status: response.status };
      state.mcpServers = (state.mcpServers ?? []).map((s) => s.id === args.id ? { ...s, lastTest } : s);
      await writeState(state);
      return { ok, status: response.status };
    } catch (err) {
      const lastTest = { ok: false, ts: Date.now(), error: err instanceof Error ? err.message : 'unknown' };
      state.mcpServers = (state.mcpServers ?? []).map((s) => s.id === args.id ? { ...s, lastTest } : s);
      await writeState(state);
      return { ok: false, error: lastTest.error };
    }
  }
  if (name === 'polypore.formation.upsert') {
    state.formation = { nodes: args.nodes ?? [], edges: args.edges ?? [], ts: Date.now() };
    /* also mirror into the workflow field so existing kb listeners pick it up */
    state.workflow = state.formation;
    await writeState(state);
    return { upserted: true, nodes: state.formation.nodes.length, edges: state.formation.edges.length };
  }

  throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32601 });
}

function validateToolInput(name, args) {
  const validate = validators.get(name);
  if (!validate) throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32601 });
  if (!validate(args ?? {})) {
    throw Object.assign(new Error('invalid_params'), {
      code: -32602,
      data: validate.errors?.map((err) => ({
        path: err.instancePath || '/',
        message: err.message,
        keyword: err.keyword,
      })),
    });
  }
}

function content(text) {
  return { content: [{ type: 'text', text }] };
}

/* The manual corpus, agent side. Mirrors the file convention the frontend
 * reader uses (src/manual/manualCorpus.ts): concept prose under docs/manual/**,
 * per-panel prose in plugins/<id>/MANUAL.md, facts derived from the manifest.
 * No shared code across the two runtimes — the files on disk are the contract. */
const MANUAL_GROUP_ORDER = ['the ide', 'the agent & mcp', 'panels', 'workflows', 'reference'];

function parseManualFrontMatter(raw) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) return { meta: {}, body: raw };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: raw.slice(match[0].length) };
}

async function readManualSections({ root = cwd } = {}) {
  const sections = [];

  const docRoots = [path.join(root, 'docs', 'manual')];
  for (const root of docRoots) {
    try {
      for (const file of (await walk(root)).filter((item) => item.endsWith('.md'))) {
        const { meta, body } = parseManualFrontMatter(await fs.readFile(file, 'utf8'));
        const slug = path.relative(root, file).replace(/\.md$/, '').split(path.sep).join('/');
        sections.push({
          slug,
          title: meta.title ?? slug,
          group: meta.group ?? 'the ide',
          order: Number.isFinite(Number(meta.order)) ? Number(meta.order) : 0,
          body,
        });
      }
    } catch {}
  }

  const pluginRoots = [path.join(root, 'plugins')];
  const seen = new Set();
  for (const root of pluginRoots) {
    let manifestFiles;
    try {
      manifestFiles = (await walk(root)).filter((item) => path.basename(item) === 'polypore.json');
    } catch {
      continue;
    }
    for (const file of manifestFiles) {
      let manifest;
      try {
        manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        continue;
      }
      if (!manifest.id || seen.has(manifest.id)) continue;
      seen.add(manifest.id);
      let body = '';
      try {
        body = await fs.readFile(path.join(path.dirname(file), 'MANUAL.md'), 'utf8');
      } catch {}
      sections.push({
        slug: `panels/${manifest.id}`,
        title: manifest.title ?? manifest.id,
        group: 'panels',
        order: 0,
        body,
        facts: {
          id: manifest.id,
          version: manifest.version ?? '0.1.0',
          permissions: manifest.permissions ?? [],
          capabilities: manifest.capabilities ?? [],
          category: manifest.category ?? 'other',
        },
      });
    }
  }

  return sections;
}

function manualIndex(sections) {
  const byName = new Map();
  for (const section of sections) {
    if (!byName.has(section.group)) byName.set(section.group, []);
    byName.get(section.group).push(section);
  }
  const names = [
    ...MANUAL_GROUP_ORDER.filter((name) => byName.has(name)),
    ...[...byName.keys()].filter((name) => !MANUAL_GROUP_ORDER.includes(name)),
  ];
  return names
    .map((name) => {
      const items = byName
        .get(name)
        .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
        .map((section) => `- \`${section.slug}\` — ${section.title}`)
        .join('\n');
      return `### ${name}\n${items}`;
    })
    .join('\n\n');
}

function renderManualSection(section) {
  const facts = section.facts
    ? `\n\n_id: ${section.facts.id} · version: ${section.facts.version}`
      + ` · permissions: ${section.facts.permissions.join(', ') || 'none'}`
      + ` · capabilities: ${section.facts.capabilities.join(', ') || 'none'}_`
    : '';
  return `# ${section.title}${facts}\n\n${section.body || 'no prose authored yet.'}`;
}

async function buildManual(section) {
  const sections = await readManualSections();
  if (section) {
    const match = sections.find((item) => item.slug === section);
    if (!match) {
      return `no manual section "${section}". available sections:\n\n${manualIndex(sections)}`;
    }
    return renderManualSection(match);
  }
  return [
    '# polypore manual',
    'polypore is a desktop ide for driving agentic coding sessions. secrets never return values; plugin installs require host confirmation.',
    'request one section by slug via the `section` argument, e.g. `{ "section": "agent-mcp/secrets" }`.',
    '## contents',
    manualIndex(sections),
  ].join('\n\n');
}

function rel(target) {
  return path.relative(cwd, target) || '.';
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48) || 'item';
}

/* ripgrep-backed project search with a graceful degrade. rg is preferred for
 * speed + gitignore awareness; when it isn't on PATH we fall back to a bounded
 * manual walk so the tool still answers. */
function searchProject(args = {}) {
  const query = String(args.query ?? '');
  if (!query) return { matches: [], query };
  const limit = Math.min(Number(args.limit) || 200, 1000);
  const rgArgs = ['--line-number', '--no-heading', '--color', 'never', '--max-count', '50'];
  if (!args.regex) rgArgs.push('--fixed-strings');
  if (args.glob) rgArgs.push('--glob', String(args.glob));
  rgArgs.push('--', query, '.');
  const probe = spawnSync('rg', rgArgs, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (!probe.error && typeof probe.stdout === 'string') {
    const matches = probe.stdout.split('\n').filter(Boolean).slice(0, limit).map((line) => {
      const m = /^(.*?):(\d+):(.*)$/.exec(line);
      return m ? { file: m[1], line: Number(m[2]), text: m[3].slice(0, 400) } : null;
    }).filter(Boolean);
    return { matches, query, engine: 'ripgrep' };
  }
  return { matches: [], query, engine: 'unavailable', note: 'ripgrep not found; install rg for project search in standalone mode' };
}

function knowledgeRegistryPath() {
  const override = process.env.POLYPORE_CONFIG_DIR;
  if (override) return path.join(override, 'documents', 'knowledge-bases.json');
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA;
    if (!appdata) return null;
    return path.join(appdata, 'polypore', 'documents', 'knowledge-bases.json');
  }
  return path.join(os.homedir(), '.config', 'polypore', 'documents', 'knowledge-bases.json');
}

function listKnowledgeBases() {
  const registryPath = knowledgeRegistryPath();
  let registered = [];
  if (registryPath && existsSync(registryPath)) {
    try {
      const raw = readFileSync(registryPath, 'utf8');
      registered = JSON.parse(raw);
    } catch {
      registered = [];
    }
  }

  /* mirror visible_knowledge_bases: global scope always visible; project scope
     only when project_root matches cwd; base must exist on disk. */
  const bases = registered
    .filter((base) => {
      if (base.scope === 'global') return true;
      return base.project_root === cwd || base.project_root === path.resolve(cwd);
    })
    .filter((base) => base.root && existsSync(base.root))
    .map((base) => ({
      id: base.id,
      name: base.name,
      root: base.root,
      scope: base.scope,
      suggestedScope: base.suggested_scope ?? base.suggestedScope ?? base.scope,
    }));

  /* include the implicit project default (.knowledge) if it exists and isn't
     already covered by a registered entry. */
  const defaultRoot = path.resolve(cwd, '.knowledge');
  const alreadyListed = bases.some((base) => path.resolve(base.root) === defaultRoot);
  if (!alreadyListed && existsSync(defaultRoot)) {
    bases.push({
      id: `project-default`,
      name: 'project documents',
      root: defaultRoot,
      scope: 'project',
      suggestedScope: 'project',
    });
  }

  return bases;
}

async function listKnowledge() {
  const root = path.resolve(cwd, '.knowledge');
  const out = [];
  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        out.push({ path: path.relative(root, full), kind: 'folder' });
        await walk(full);
      } else if (entry.isFile()) {
        out.push({ path: path.relative(root, full), kind: 'document' });
      }
    }
  }
  await walk(root);
  return out;
}

function resolveKnowledge(inputPath = 'notes.md') {
  const root = path.resolve(cwd, '.knowledge');
  const raw = String(inputPath || 'notes.md');
  const knowledgePrefix = /^\.knowledge(?:[/\\]|$)/;
  const target = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(root, raw.replace(knowledgePrefix, ''));
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('path must stay under .knowledge');
  }
  rejectSymlinkSegments(root, target, 'knowledge paths may not contain symbolic links');
  return target;
}

function rejectSymlinkSegments(root, target, message) {
  const relative = path.relative(root, target);
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = root;
  if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(message);
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) throw new Error(message);
  }
}

function resolveStagingPath(inputPath) {
  const target = resolveUnder(stagingRoot, inputPath);
  rejectSymlinkSegments(stagingRoot, target, 'staging paths may not contain symbolic links');
  return target;
}

function resolveUnder(root, inputPath) {
  const base = path.resolve(root);
  const raw = String(inputPath ?? '');
  const target = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);
  const relative = path.relative(base, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`path must stay under ${base}`);
  }
  return target;
}

function isSafePluginId(id) {
  const value = String(id ?? '');
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)
    && !value.includes('..')
    && !value.includes('/')
    && !value.includes('\\');
}

function filterDiagnostics(diagnostics, args) {
  return diagnostics.filter((item) => (!args.severity || item.severity === args.severity) && (!args.file || item.file === args.file));
}

function declaredVerifyCommands() {
  const verifyPath = path.join(projectDir, 'verify.json');
  if (!existsSync(verifyPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(verifyPath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item.id !== 'string' || typeof item.command !== 'string') return [];
      const id = item.id.trim();
      const command = item.command.trim();
      if (!id || !command) return [];
      return [{
        id,
        label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : id,
        command,
        required: item.required !== false,
      }];
    });
  } catch {
    return [];
  }
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === 'string' && item.trim() ? [item.trim()] : []));
}

function stripLeadingDot(value) {
  return String(value ?? '').replace(/^\.+/, '').toLowerCase();
}

function declaredFormatterCommands() {
  const formattersPath = path.join(projectDir, 'formatters.json');
  if (!existsSync(formattersPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(formattersPath, 'utf8'));
    const entries = parsed && typeof parsed === 'object' && Array.isArray(parsed.formatters)
      ? parsed.formatters
      : [];
    const seen = new Set();
    return entries.flatMap((item) => {
      if (!item || typeof item.id !== 'string' || typeof item.command !== 'string') return [];
      const id = item.id.trim();
      const command = item.command.trim();
      if (!id || !command || seen.has(id)) return [];
      seen.add(id);
      return [{
        id,
        label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : id,
        command,
        extensions: normalizeStringList(item.extensions).map(stripLeadingDot),
        filenames: normalizeStringList(item.filenames),
      }];
    });
  } catch {
    return [];
  }
}

function formatterMatchesPath(formatter, file) {
  if (!file) return true;
  const extensions = new Set((formatter.extensions ?? []).map(stripLeadingDot).filter(Boolean));
  const filenames = new Set((formatter.filenames ?? []).filter(Boolean));
  if (extensions.size === 0 && filenames.size === 0) return true;
  const basename = path.basename(file);
  const extension = stripLeadingDot(path.extname(basename).slice(1));
  return (extension && extensions.has(extension)) || filenames.has(basename) || filenames.has(file);
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "'\\''")}'`;
}

function formatCommandForFile(command, file) {
  if (!file) return command;
  const basename = path.basename(file);
  const dir = path.dirname(file) || '.';
  const replacements = { file, path: file, basename, dir };
  return command.replace(/\{(file|path|basename|dir)\}/g, (_match, key) => shellQuote(replacements[key] ?? ''));
}

function resolveFormatterCommand(id, file) {
  const requested = String(id ?? '').trim();
  const commands = declaredFormatterCommands().filter((command) => formatterMatchesPath(command, file));
  return commands.find((command) => command.id === requested) ?? null;
}

function runFormatter(id, file) {
  const formatter = resolveFormatterCommand(id, file);
  if (!formatter) {
    const available = declaredFormatterCommands()
      .filter((command) => formatterMatchesPath(command, file))
      .map((command) => command.id)
      .join(', ') || 'none declared';
    throw Object.assign(new Error(`formatter command not found: ${id}. Declare one in .polypore/formatters.json or use one of: ${available}`), { code: -32602 });
  }
  const started = Date.now();
  const command = formatCommandForFile(formatter.command, file);
  const result = spawnSync(command, [], {
    cwd,
    encoding: 'utf8',
    shell: true,
    timeout: 120_000,
    windowsHide: true,
  });
  return {
    id: formatter.id,
    label: formatter.label ?? formatter.id,
    command,
    file: file ?? null,
    exitCode: result.status ?? 1,
    ranAt: started,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`.slice(-12000),
  };
}

function packageManager() {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const declared = typeof packageJson.packageManager === 'string' ? packageJson.packageManager.split('@')[0] : '';
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared;
  } catch {
    /* fall through to lockfile inference */
  }
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(cwd, 'bun.lockb')) || existsSync(path.join(cwd, 'bun.lock'))) return 'bun';
  return 'npm';
}

function packageRunCommand(manager, name) {
  if (manager === 'npm') return `npm run ${name}`;
  if (manager === 'yarn') return `yarn ${name}`;
  return `${manager} run ${name}`;
}

function packageVerifyCommands() {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const scripts = packageJson && typeof packageJson === 'object' && packageJson.scripts && typeof packageJson.scripts === 'object'
      ? packageJson.scripts
      : null;
    if (!scripts) return [];
    const manager = packageManager();
    return ['lint', 'typecheck', 'check', 'test', 'build']
      .filter((name) => Object.prototype.hasOwnProperty.call(scripts, name))
      .map((name) => ({
        id: name,
        label: name,
        command: packageRunCommand(manager, name),
        required: true,
      }));
  } catch {
    return [];
  }
}

function hasAny(names) {
  return names.some((name) => existsSync(path.join(cwd, name)));
}

function projectFiles(limit = 600) {
  const skip = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.next', '.vite', 'coverage']);
  const files = [];
  const visit = (dir) => {
    if (files.length >= limit) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      if (skip.has(entry.name)) continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  visit(cwd);
  return files;
}

function hasFileWithExtension(extensions) {
  const wanted = new Set(extensions);
  return projectFiles().some((file) => wanted.has(path.extname(file).slice(1)));
}

function autoDetectedVerifyCommands() {
  const commands = [...packageVerifyCommands()];
  if (existsSync(path.join(cwd, 'Cargo.toml'))) commands.push({ id: 'cargo-check', label: 'cargo check', command: 'cargo check', required: true });
  else if (existsSync(path.join(cwd, 'src-tauri', 'Cargo.toml'))) commands.push({ id: 'cargo-check', label: 'cargo check', command: 'cargo check --manifest-path src-tauri/Cargo.toml', required: true });
  if (existsSync(path.join(cwd, 'go.mod'))) {
    commands.push({ id: 'go-test', label: 'go test', command: 'go test ./...', required: true });
    commands.push({ id: 'go-vet', label: 'go vet', command: 'go vet ./...', required: true });
  }
  if (hasAny(['pytest.ini', 'tox.ini', 'pyproject.toml'])) commands.push({ id: 'pytest', label: 'pytest', command: 'python3 -m pytest', required: true });
  if (hasAny(['pyproject.toml', 'ruff.toml'])) commands.push({ id: 'ruff', label: 'ruff check', command: 'python3 -m ruff check .', required: true });
  if (existsSync(path.join(cwd, 'pom.xml'))) commands.push({ id: 'maven-test', label: 'maven test', command: 'mvn test', required: true });
  if (hasAny(['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'])) {
    commands.push({
      id: 'gradle-test',
      label: 'gradle test',
      command: existsSync(path.join(cwd, 'gradlew')) ? './gradlew test' : 'gradle test',
      required: true,
    });
  }
  if (hasFileWithExtension(['sln', 'csproj', 'fsproj', 'vbproj'])) commands.push({ id: 'dotnet-test', label: 'dotnet test', command: 'dotnet test --nologo', required: true });
  if (existsSync(path.join(cwd, 'build.sbt'))) commands.push({ id: 'sbt-test', label: 'sbt test', command: 'sbt -batch test', required: true });
  if (existsSync(path.join(cwd, 'mix.exs'))) commands.push({ id: 'mix-test', label: 'mix test', command: 'mix test', required: true });
  if (existsSync(path.join(cwd, 'composer.json'))) commands.push({ id: 'composer-validate', label: 'composer validate', command: 'composer validate --no-check-publish --no-interaction', required: true });
  if (existsSync(path.join(cwd, 'Package.swift'))) commands.push({ id: 'swift-test', label: 'swift test', command: 'swift test', required: true });
  if (existsSync(path.join(cwd, 'pubspec.yaml'))) {
    const content = readFileSync(path.join(cwd, 'pubspec.yaml'), 'utf8');
    commands.push(content.includes('sdk: flutter') || content.includes('flutter:')
      ? { id: 'flutter-test', label: 'flutter test', command: 'flutter test', required: true }
      : { id: 'dart-test', label: 'dart test', command: 'dart test', required: true });
  }
  return commands;
}

function verifyCommands() {
  const byId = new Map();
  for (const command of [...autoDetectedVerifyCommands(), ...declaredVerifyCommands()]) {
    byId.set(command.id, command);
  }
  return [...byId.values()];
}

function resolveVerifyCommand(id) {
  const requested = String(id ?? '').trim();
  const commands = verifyCommands();
  return commands.find((command) => command.id === requested)
    || (requested === 'tests' ? commands.find((command) => command.id === 'test') : null)
    || null;
}

function runVerify(id) {
  const verify = resolveVerifyCommand(id);
  if (!verify) {
    throw Object.assign(new Error(`verify command not found: ${id}. Declare one with polypore.verify.declare or use one of: ${verifyCommands().map((command) => command.id).join(', ') || 'none detected'}`), { code: -32602 });
  }
  const started = Date.now();
  const result = spawnSync(verify.command, [], {
    cwd,
    encoding: 'utf8',
    shell: true,
    timeout: 120_000,
    windowsHide: true,
  });
  return {
    id: verify.id,
    label: verify.label ?? verify.id,
    command: verify.command,
    exitCode: result.status ?? 1,
    ranAt: started,
    required: verify.required !== false,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`.slice(-12000),
  };
}

async function fetchPlugin(args) {
  const hash = crypto.createHash('sha256').update(`${args.url}:${args.ref ?? 'HEAD'}:${Date.now()}`).digest('hex').slice(0, 12);
  const stagingPath = path.join(stagingRoot, hash);
  await fs.mkdir(path.dirname(stagingPath), { recursive: true });
  if (String(args.url).startsWith('https://github.com/')) {
    const cloneArgs = ['clone', '--depth', '1'];
    if (args.ref) cloneArgs.push('--branch', args.ref);
    cloneArgs.push(args.url, stagingPath);
    const clone = spawnSync('git', cloneArgs, { encoding: 'utf8', timeout: 120_000 });
    if (clone.status !== 0) throw new Error(clone.stderr || 'git clone failed');
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: stagingPath, encoding: 'utf8' }).stdout.trim();
    return { stagingPath, source: { kind: 'github', url: args.url, commit, ref: args.ref ?? 'HEAD' }, fileTree: await fileTree(stagingPath) };
  }
  const source = resolveUnder(cwd, args.url);
  rejectSymlinkSegments(cwd, source, 'local plugin paths may not contain symbolic links');
  await copyDir(source, stagingPath);
  return { stagingPath, source: { kind: 'local', url: source, commit: hash, ref: args.ref ?? 'local' }, fileTree: await fileTree(stagingPath) };
}

async function scanPlugins(stagingPath) {
  const root = resolveStagingPath(stagingPath);
  const files = await walk(root);
  const candidates = [];
  for (const file of files.filter((item) => path.basename(item) === 'polypore.json')) {
    try {
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      validateManifest(manifest);
      candidates.push({ manifestPath: path.relative(root, file), rootPath: path.relative(root, path.dirname(file)) || '.', manifest });
    } catch {
      // invalid manifests are available through inspect errors
    }
  }
  return { candidates };
}

async function inspectPlugin(stagingPath, manifestPath) {
  const rootPath = resolveStagingPath(stagingPath);
  const manifestFile = resolveUnder(rootPath, manifestPath);
  rejectSymlinkSegments(rootPath, manifestFile, 'plugin manifest paths may not contain symbolic links');
  const errors = [];
  let manifest = null;
  try {
    manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    validateManifest(manifest);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'invalid manifest');
  }
  const root = path.dirname(manifestFile);
  const files = await Promise.all((await walk(root)).map(async (file) => ({ path: path.relative(root, file), sizeBytes: (await fs.stat(file)).size })));
  return { manifest, files, totalSizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0), errors, warnings: [] };
}

async function installPlugin(state, args) {
  const inspection = await inspectPlugin(args.stagingPath, args.manifestPath);
  if (inspection.errors.length || !inspection.manifest) return { installed: false, reason: 'invalid_manifest', errors: inspection.errors };
  const stagedRoot = path.dirname(resolveUnder(resolveStagingPath(args.stagingPath), args.manifestPath));
  let scope = args.scope ?? 'project';
  if (hostRpcConfigured()) {
    const confirmation = await hostRpcCall('plugins.confirmInstall', {
      manifest: inspection.manifest,
      scope,
      stagingPath: args.stagingPath,
      manifestPath: args.manifestPath,
      files: inspection.files,
      totalSizeBytes: inspection.totalSizeBytes,
    });
    if (!confirmation.confirmed) return { installed: false, reason: 'user_declined' };
    if (confirmation.scope === 'project' || confirmation.scope === 'user') scope = confirmation.scope;
  }
  const target = path.join(projectDir, 'plugins', inspection.manifest.id);
  await fs.rm(target, { recursive: true, force: true });
  await copyDir(stagedRoot, target);
  const plugin = { id: inspection.manifest.id, enabled: true, scope, source: target, permissions: inspection.manifest.permissions ?? [] };
  state.plugins = [plugin, ...state.plugins.filter((item) => item.id !== plugin.id)];
  await writeState(state);
  if (hostRpcConfigured()) {
    await hostRpcCall('plugins.install', { plugin, manifest: inspection.manifest, source: target, scope });
  }
  return { installed: true, plugin };
}

async function invokeMcp(state, args) {
  const servers = await readMcpServers(state);
  const server = servers.find((item) => item.id === args.server || item.name === args.server);
  if (!server) throw Object.assign(new Error(`mcp server not configured: ${args.server}`), { code: -32602 });
  if (!server.url) throw Object.assign(new Error('only http mcp server invocation is configured for this sidecar'), { code: -32602 });
  if (!String(server.url).startsWith('https://') && server.allowInsecure !== true) {
    throw Object.assign(new Error('mcp server url must be https unless allowInsecure is true'), { code: -32602 });
  }

  if (args.authRef) {
    /* any authenticated invocation is mediated by the secret broker so the
       sidecar never touches the raw value. without a broker we refuse. */
    requireSecretBroker();
    return secretBrokerCall('/secrets/use', {
      id: args.authRef,
      request: {
        url: server.url,
        method: 'POST',
        headers: server.headers ?? {},
        body: { jsonrpc: '2.0', id: `polypore-${Date.now()}`, method: args.method, params: args.args ?? {} },
        timeoutMs: Math.min(server.timeoutMs ?? 30000, 120000),
        allowInsecure: server.allowInsecure === true,
      },
    });
  }

  const headers = Object.fromEntries(Object.entries(server.headers ?? {}).map(([key, value]) => [key, String(value)]));
  headers['content-type'] = headers['content-type'] ?? 'application/json';
  const response = await httpRequest(
    server.url,
    'POST',
    headers,
    JSON.stringify({ jsonrpc: '2.0', id: `polypore-${Date.now()}`, method: args.method, params: args.args ?? {} }),
    Math.min(server.timeoutMs ?? 30000, 120000),
  );
  return {
    status: response.status,
    headers: response.headers,
    body: response.body,
  };
}

async function readMcpServers(state) {
  const candidates = [
    path.join(projectDir, 'mcp-servers.json'),
    path.join(os.homedir(), '.config', 'polypore', 'mcp-servers.json'),
  ];
  const servers = [...(state.mcpServers ?? [])];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      servers.push(...(Array.isArray(parsed) ? parsed : parsed.servers ?? []));
    } catch {}
  }
  return servers;
}

function validateManifest(manifest) {
  for (const key of ['schemaVersion', 'id', 'title', 'icon', 'version', 'entry', 'permissions', 'capabilities', 'category']) {
    if (manifest[key] === undefined) throw new Error(`manifest missing ${key}`);
  }
  if (manifest.schemaVersion !== 1) throw new Error('unsupported manifest schema version');
  if (!isSafePluginId(manifest.id)) throw new Error('manifest id must be a dot/dash separated lowercase identifier');
}

/* The sidecar NEVER reads raw secret values from its own environment. Every
 * secret operation is mediated by the Rust secret broker, which holds the OS
 * keyring binding and scrubs values on the way out. Without a broker the
 * sidecar refuses rather than falling back to process.env — that fallback was
 * a foot-gun that contradicted the "agent never sees the value" contract. */
const STANDALONE_SECRET_ERROR =
  'secrets are only available through the polypore secret broker; the standalone mcp sidecar never reads secret values from its environment';

function requireSecretBroker() {
  if (!secretBrokerConfigured()) {
    throw Object.assign(new Error(STANDALONE_SECRET_ERROR), { code: -32011 });
  }
}

async function listSecrets(scope = 'user') {
  if (secretBrokerConfigured()) {
    const result = await secretBrokerCall('/secrets/list', { scope });
    return Array.isArray(result) ? result : result.secrets ?? [];
  }
  /* no broker → no visibility into secrets. honest empty rather than env scan. */
  return [];
}

async function secretHas(args) {
  if (secretBrokerConfigured()) return secretBrokerCall('/secrets/has', args);
  return { configured: false };
}

function mask(value) {
  return '********';
}

function substituteSecretString(value, secret) {
  if (!secret) return String(value);
  return String(value).replaceAll('${secret}', secret);
}

function scrubSecretString(value, secret) {
  if (!secret) return String(value);
  return String(value).replaceAll(secret, '[secret]');
}

function substituteSecretValue(value, secret) {
  if (typeof value === 'string') return substituteSecretString(value, secret);
  if (Array.isArray(value)) return value.map((item) => substituteSecretValue(item, secret));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteSecretValue(item, secret)]));
  }
  return value;
}

function scrubSecretHeaders(headers, secret) {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [
    key,
    Array.isArray(value)
      ? value.map((item) => scrubSecretString(item, secret))
      : scrubSecretString(value ?? '', secret),
  ]));
}

async function useSecret(args) {
  requireSecretBroker();
  return secretBrokerCall('/secrets/use', args);
}

function secretBrokerConfigured() {
  return Boolean(process.env.POLYPORE_SECRET_BROKER_URL && process.env.POLYPORE_SECRET_BROKER_TOKEN);
}

async function secretBrokerCall(route, payload) {
  const base = process.env.POLYPORE_SECRET_BROKER_URL;
  const token = process.env.POLYPORE_SECRET_BROKER_TOKEN;
  const response = await httpRequest(
    `${base}${route}`,
    'POST',
    {
      'content-type': 'application/json',
      'x-polypore-token': token,
    },
    JSON.stringify(payload ?? {}),
    120000,
  );
  let parsed = {};
  try {
    parsed = JSON.parse(response.body || '{}');
  } catch {
    throw Object.assign(new Error('invalid secret broker response'), { code: -32603 });
  }
  if (response.status && response.status >= 400) {
    if (String(parsed.error ?? '').includes('secret not available')) return { error: 'secret_not_configured', configured: false };
    throw Object.assign(new Error(parsed.error ?? 'secret broker error'), { code: -32603 });
  }
  return parsed;
}

function httpRequest(url, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('https://') ? https : http;
    const req = lib.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    if (body) req.write(body);
    req.end();
  });
}

function hostRpcConfigured() {
  return Boolean(process.env.POLYPORE_HOST_RPC_URL && process.env.POLYPORE_HOST_RPC_TOKEN);
}

async function hostRpcCall(method, params) {
  const response = await httpRequest(
    `${process.env.POLYPORE_HOST_RPC_URL}/host/rpc`,
    'POST',
    {
      'content-type': 'application/json',
      'x-polypore-token': process.env.POLYPORE_HOST_RPC_TOKEN,
    },
    JSON.stringify({ method, params: params ?? {} }),
    30000,
  );
  let parsed = {};
  try {
    parsed = JSON.parse(response.body || '{}');
  } catch {
    throw Object.assign(new Error('invalid host rpc response'), { code: -32603 });
  }
  if (response.status && response.status >= 400) {
    throw Object.assign(new Error(parsed.error ?? 'host rpc error'), { code: -32603 });
  }
  if (parsed.kind === 'response') {
    if (parsed.ok) return parsed.result ?? {};
    throw Object.assign(new Error(parsed.error?.message ?? 'host rpc failed'), {
      code: -32603,
      data: parsed.error,
    });
  }
  return parsed;
}

async function listSkills(scope) {
  /* polypore's skill store is dir-per-skill (SKILL.md inside) OR top-level
     .md files, mixed at the same root. skillsets are sub-dirs that contain
     skillset.json plus skill subdirs. all three shapes coexist. */
  const dirs = scope === 'user' ? [userSkillsDir()] : scope === 'project' ? [projectSkillsDir()] : [projectSkillsDir(), userSkillsDir()];
  const skills = [];
  for (const dir of dirs) {
    try {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const stat = await fs.stat(full);
          skills.push({ id: path.basename(entry.name, '.md'), name: path.basename(entry.name, '.md'), scope: dir === projectSkillsDir() ? 'project' : 'user', origin: 'polypore', path: full, updatedAt: stat.mtimeMs });
          continue;
        }
        if (entry.isDirectory()) {
          const skillsetManifest = path.join(full, 'skillset.json');
          let skillsetId = null;
          try {
            const parsed = JSON.parse(await fs.readFile(skillsetManifest, 'utf8'));
            skillsetId = parsed.id;
          } catch {}
          if (skillsetId) {
            for (const inner of await fs.readdir(full, { withFileTypes: true })) {
              if (!inner.isDirectory()) continue;
              const skillFile = path.join(full, inner.name, 'SKILL.md');
              try {
                const stat = await fs.stat(skillFile);
                skills.push({ id: inner.name, name: inner.name, scope: dir === projectSkillsDir() ? 'project' : 'user', origin: 'polypore', skillsetId, path: skillFile, updatedAt: stat.mtimeMs });
              } catch {}
            }
          } else {
            const skillFile = path.join(full, 'SKILL.md');
            try {
              const stat = await fs.stat(skillFile);
              skills.push({ id: entry.name, name: entry.name, scope: dir === projectSkillsDir() ? 'project' : 'user', origin: 'polypore', path: skillFile, updatedAt: stat.mtimeMs });
            } catch {}
          }
        }
      }
    } catch {}
  }
  /* builtin polyflow skills live inside the polypore install. expose them so
     agents calling polypore.skills.list see them whether or not the user has
     a personal store yet. */
  if (!scope || scope === 'builtin') {
    try {
      const polyflowDir = polyflowPackageDir();
      const manifestPath = path.join(polyflowDir, 'skillset.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      for (const skillId of manifest.skills ?? []) {
        const skillFile = path.join(polyflowDir, skillId, 'SKILL.md');
        try {
          const stat = await fs.stat(skillFile);
          skills.push({ id: skillId, name: skillId, scope: 'builtin', origin: 'builtin', skillsetId: manifest.id, path: skillFile, updatedAt: stat.mtimeMs });
        } catch {}
      }
    } catch {}
  }
  return skills;
}

function polyflowPackageDir() {
  return path.resolve(new URL('../../polyflow', import.meta.url).pathname);
}

async function listSkillsets() {
  const skillsets = [];
  try {
    const polyflowDir = polyflowPackageDir();
    const manifestPath = path.join(polyflowDir, 'skillset.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    skillsets.push({ ...manifest, scope: 'builtin' });
  } catch {}
  /* project + user skillsets — each directory under skills/ with skillset.json */
  for (const dir of [projectSkillsDir(), userSkillsDir()]) {
    try {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          const parsed = JSON.parse(await fs.readFile(path.join(dir, entry.name, 'skillset.json'), 'utf8'));
          skillsets.push({ ...parsed, scope: dir === projectSkillsDir() ? 'project' : 'user' });
        } catch {}
      }
    } catch {}
  }
  return skillsets;
}

async function readSkillset(id) {
  const all = await listSkillsets();
  const skillset = all.find((s) => s.id === id);
  if (!skillset) throw Object.assign(new Error(`skillset not found: ${id}`), { code: -32602 });
  const allSkills = await listSkills();
  const skills = allSkills.filter((s) => s.skillsetId === id);
  return { skillset, skills };
}

async function readSkill(id) {
  const skillId = validateSkillId(id);
  for (const dir of [projectSkillsDir(), userSkillsDir()]) {
    const full = resolveSkillPath(dir, skillId);
    try {
      const body = await fs.readFile(full, 'utf8');
      return { id: skillId, name: skillId, scope: dir === projectSkillsDir() ? 'project' : 'user', path: full, body, frontmatter: {}, updatedAt: (await fs.stat(full)).mtimeMs };
    } catch {}
  }
  throw new Error(`skill not found: ${skillId}`);
}

async function writeSkill(args) {
  const id = slug(args.id ?? args.name);
  const full = resolveSkillPath(projectSkillsDir(), id);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, String(args.body ?? `# ${id}\n`));
  await publishSkillToAgents(id, full);
  return { skill: await readSkill(id) };
}

async function deleteSkill(id) {
  const skillId = validateSkillId(id);
  const full = resolveSkillPath(projectSkillsDir(), skillId);
  try {
    await fs.stat(full);
  } catch {
    return { deleted: false, reason: 'not_found', id: skillId };
  }
  await fs.rm(full);
  await unpublishSkillFromAgents(skillId);
  return { deleted: true, id: skillId };
}

const exportsManifestPath = () => path.join(os.homedir(), '.config', 'polypore', 'exports.json');
async function readExports() {
  try {
    return JSON.parse(await fs.readFile(exportsManifestPath(), 'utf8'));
  } catch {
    return { symlinks: [] };
  }
}
async function writeExports(value) {
  await fs.mkdir(path.dirname(exportsManifestPath()), { recursive: true });
  await fs.writeFile(exportsManifestPath(), JSON.stringify(value, null, 2));
}

function agentSkillRoots() {
  return [
    { agent: 'claude', dir: path.join(os.homedir(), '.claude', 'skills') },
    { agent: 'codex', dir: path.join(os.homedir(), '.codex', 'skills') },
  ];
}

async function publishSkillToAgents(skillId, sourcePath) {
  /* symlink the polypore-owned skill into each known agent's skills dir.
     on name collision, fall back to <id>-polypore. tracked in exports.json
     so unpublish leaves no orphans.

     directory-based skills (sourcePath ends with /SKILL.md) are linked as
     a directory symlink so Claude Code's slash-completion picks them up. flat
     .md skills are linked as a .md file symlink. */
  const isDirectorySkill = path.basename(sourcePath) === 'SKILL.md';
  const linkSource = isDirectorySkill ? path.dirname(sourcePath) : sourcePath;

  const exports = await readExports();
  for (const { agent, dir } of agentSkillRoots()) {
    try {
      await fs.stat(dir);
    } catch {
      continue; /* agent not installed — skip silently */
    }
    /* directory skills get no extension; flat file skills get .md */
    let targetName = isDirectorySkill ? skillId : `${skillId}.md`;
    let targetPath = path.join(dir, targetName);
    try {
      const existing = await fs.lstat(targetPath);
      if (existing.isSymbolicLink()) {
        /* our own previous link — refresh it. */
        await fs.unlink(targetPath);
      } else {
        /* collision with the agent's own skill — disambiguate. */
        targetName = isDirectorySkill ? `${skillId}-polypore` : `${skillId}-polypore.md`;
        targetPath = path.join(dir, targetName);
        try {
          await fs.unlink(targetPath);
        } catch {}
      }
    } catch {}
    try {
      await fs.symlink(linkSource, targetPath);
      exports.symlinks = (exports.symlinks ?? []).filter((entry) => entry.target !== targetPath);
      exports.symlinks.push({ agent, skillId, source: linkSource, target: targetPath });
    } catch (err) {
      /* symlink may fail on filesystems without symlink support; skip. */
    }
  }
  await writeExports(exports);
}

async function unpublishSkillFromAgents(skillId) {
  const exports = await readExports();
  const remaining = [];
  for (const entry of exports.symlinks ?? []) {
    if (entry.skillId !== skillId) {
      remaining.push(entry);
      continue;
    }
    try {
      const stat = await fs.lstat(entry.target);
      if (stat.isSymbolicLink()) await fs.unlink(entry.target);
    } catch {}
  }
  await writeExports({ ...exports, symlinks: remaining });
}

function validateSkillId(id) {
  const value = String(id ?? '');
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) {
    throw Object.assign(new Error('invalid skill id'), { code: -32602 });
  }
  return value;
}

function resolveSkillPath(dir, id) {
  return resolveUnder(dir, `${id}.md`);
}

function projectSkillsDir() {
  return path.join(projectDir, 'skills');
}

function userSkillsDir() {
  return path.join(os.homedir(), '.config', 'polypore', 'skills');
}

async function fileTree(root) {
  const children = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    if (entry.isSymbolicLink()) throw new Error('plugin directories may not contain symbolic links');
    const full = path.join(root, entry.name);
    children.push(entry.isDirectory() ? { kind: 'folder', name: entry.name, children: await fileTree(full) } : { kind: 'file', name: entry.name, path: full });
  }
  return children;
}

async function walk(root) {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    if (entry.isSymbolicLink()) throw new Error('plugin directories may not contain symbolic links');
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

async function copyDir(source, target) {
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    if (entry.isSymbolicLink()) throw new Error('plugin directories may not contain symbolic links');
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isDirectory()) await copyDir(src, dst);
    else await fs.copyFile(src, dst);
  }
}

async function handle(message) {
  try {
    if (message.method === 'initialize') {
      respond(message.id, { protocolVersion: '2024-11-05', serverInfo: { name: 'polypore-ide', version: '0.1.0' }, capabilities: { tools: {} } });
      return;
    }
    if (message.method === 'tools/list') {
      respond(message.id, { tools });
      return;
    }
    if (message.method === 'tools/call') {
      respond(message.id, await handleTool(message.params?.name, message.params?.arguments ?? {}));
      return;
    }
    if (message.id !== undefined) error(message.id, -32601, `unknown method: ${message.method}`);
  } catch (err) {
    error(message.id ?? null, err.code ?? -32000, err instanceof Error ? err.message : 'internal error', err.data);
  }
}

export {
  buildManual,
  manualIndex,
  parseManualFrontMatter,
  readManualSections,
  renderManualSection,
  toolSchemas,
};

function startStdioServer() {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    try {
      void handle(JSON.parse(line));
    } catch (err) {
      error(null, -32700, err instanceof Error ? err.message : 'parse error');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startStdioServer();
}
