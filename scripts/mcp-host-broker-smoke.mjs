import { spawn } from 'node:child_process';
import http from 'node:http';

const token = 'polypore-host-smoke-token';
const calls = [];

const broker = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (req.method !== 'POST' || req.url !== '/host/rpc' || req.headers['x-polypore-token'] !== token) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    const body = raw ? JSON.parse(raw) : {};
    calls.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (body.method === 'tasks.list') {
      res.end(JSON.stringify({ kind: 'response', id: 1, ok: true, result: { tasks: [{ id: 'host-task', label: 'from host' }] } }));
      return;
    }
    if (body.method === 'ui.notify') {
      res.end(JSON.stringify({ kind: 'response', id: 2, ok: true, result: { shown: true } }));
      return;
    }
    if (body.method === 'plugins.confirmInstall') {
      res.end(JSON.stringify({ kind: 'response', id: 3, ok: true, result: { confirmed: true, scope: 'user' } }));
      return;
    }
    if (body.method === 'plugins.install') {
      res.end(JSON.stringify({ kind: 'response', id: 4, ok: true, result: { installed: true, plugin: body.params.plugin } }));
      return;
    }
    if (body.method === 'plugins.confirmUninstall') {
      res.end(JSON.stringify({ kind: 'response', id: 5, ok: true, result: { confirmed: true } }));
      return;
    }
    if (body.method === 'plugins.uninstall') {
      res.end(JSON.stringify({ kind: 'response', id: 6, ok: true, result: { uninstalled: true, id: body.params.id } }));
      return;
    }
    if (body.method === 'skills.write') {
      res.end(JSON.stringify({
        kind: 'response',
        id: 7,
        ok: true,
        result: { written: true, skill: { id: body.params.id, name: body.params.name, body: body.params.body } },
      }));
      return;
    }
    res.end(JSON.stringify({ kind: 'response', id: 8, ok: false, error: { code: 'method_not_found', message: body.method } }));
  });
});

await new Promise((resolve) => broker.listen(0, '127.0.0.1', resolve));
const address = broker.address();
const brokerUrl = `http://127.0.0.1:${address.port}`;

const child = spawn(process.execPath, ['packages/mcp-server/src/server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    POLYPORE_HOST_RPC_URL: brokerUrl,
    POLYPORE_HOST_RPC_TOKEN: token,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let nextId = 1;
let output = '';
let errors = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { errors += chunk; });

function request(method, params = {}) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const line = output.split('\n').filter(Boolean).map((item) => JSON.parse(item)).find((msg) => msg.id === id);
      if (line?.error) reject(new Error(line.error.message));
      else if (line) resolve(line.result);
      else if (Date.now() - started > 5000) reject(new Error(`timeout waiting for ${method}: ${errors}`));
      else setTimeout(poll, 10);
    };
    poll();
  });
}

function tool(name, args = {}) {
  return request('tools/call', { name, arguments: args });
}

try {
  await request('initialize');
  const tasks = await tool('polypore.tasks.list', {});
  if (tasks.tasks?.[0]?.id !== 'host-task') throw new Error('tasks.list did not return host response');

  const notify = await tool('polypore.ui.notify', { level: 'info', msg: 'hello' });
  if (notify.shown !== true) throw new Error('ui.notify did not return host response');

  const fetched = await tool('polypore.plugins.fetch', { url: 'plugins/chat', ref: 'local' });
  const scanned = await tool('polypore.plugins.scan', { stagingPath: fetched.stagingPath });
  const installed = await tool('polypore.plugins.install', {
    stagingPath: fetched.stagingPath,
    manifestPath: scanned.candidates[0].manifestPath,
    scope: 'project',
  });
  if (installed.installed !== true) throw new Error('plugin install did not complete after host confirmation');
  if (installed.plugin.scope !== 'user') throw new Error('plugin install did not honor host-selected scope');
  const uninstalled = await tool('polypore.plugins.uninstall', { id: installed.plugin.id });
  if (uninstalled.uninstalled !== true) throw new Error('plugin uninstall did not complete after host confirmation');
  const skill = await tool('polypore.skills.create', { name: 'Broker Skill', body: '# broker skill\n' });
  if (skill.skill?.id !== 'broker-skill') throw new Error('skills.create did not normalize name to host skill id');

  const methods = calls.map((call) => call.method);
  for (const required of ['tasks.list', 'ui.notify', 'plugins.confirmInstall', 'plugins.install', 'plugins.confirmUninstall', 'plugins.uninstall', 'skills.write']) {
    if (!methods.includes(required)) throw new Error(`missing host rpc call ${required}`);
  }
  const skillWrite = calls.find((call) => call.method === 'skills.write');
  if (skillWrite?.params?.id !== 'broker-skill') throw new Error('skills.write received unnormalized id');

  console.log(JSON.stringify({ hostCalls: calls.length, methods }, null, 2));
} finally {
  child.kill();
  broker.close();
}
