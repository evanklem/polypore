import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';

const token = 'polypore-smoke-token';
const calls = [];
const mcpServersPath = '.polypore/mcp-servers.json';
let previousMcpServers = null;
let hadMcpServers = false;

const broker = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (req.method !== 'POST' || req.headers['x-polypore-token'] !== token) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: req.url, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/secrets/list') {
      res.end(JSON.stringify({
        secrets: [{
          id: 'anthropic-prod',
          scope: 'user',
          service: 'anthropic',
          hint: 'sk-ant...42a3',
          configured: true,
          createdAt: Date.now(),
          lastUsedAt: null,
        }],
      }));
      return;
    }
    if (req.url === '/secrets/has') {
      res.end(JSON.stringify({ configured: body.id === 'anthropic-prod' }));
      return;
    }
    if (req.url === '/secrets/use') {
      res.end(JSON.stringify({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true, id: body.id, request: body.request.body ?? null }),
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
});

await new Promise((resolve) => broker.listen(0, '127.0.0.1', resolve));
const address = broker.address();
const brokerUrl = `http://127.0.0.1:${address.port}`;

const child = spawn(process.execPath, ['packages/mcp-server/src/server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    POLYPORE_SECRET_BROKER_URL: brokerUrl,
    POLYPORE_SECRET_BROKER_TOKEN: token,
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
  const listed = await tool('polypore.secrets.list', {});
  if (!listed.secrets.some((item) => item.id === 'anthropic-prod' && item.configured)) throw new Error('broker list did not return masked secret');

  const has = await tool('polypore.secrets.has', { id: 'anthropic-prod', scope: 'user' });
  if (has.configured !== true) throw new Error('broker has did not report configured');

  const used = await tool('polypore.secrets.use', {
    id: 'anthropic-prod',
    scope: 'user',
    request: {
      url: 'https://example.test/echo',
      method: 'POST',
      headers: { authorization: 'bearer ${secret}' },
      body: { ping: true },
    },
  });
  if (used.status !== 200 || !used.body.includes('anthropic-prod')) throw new Error('broker use did not return mediated response');

  await fs.mkdir('.polypore', { recursive: true });
  try {
    previousMcpServers = await fs.readFile(mcpServersPath, 'utf8');
    hadMcpServers = true;
  } catch {}
  await fs.writeFile(mcpServersPath, JSON.stringify({
    servers: [{
      id: 'anthropic-api',
      url: 'https://example.test/mcp',
      headers: { authorization: 'bearer ${secret}' },
    }],
  }, null, 2));

  const invoked = await tool('polypore.mcp.invoke', {
    server: 'anthropic-api',
    method: 'messages.create',
    args: { model: 'claude-test' },
    authRef: 'anthropic-prod',
  });
  if (invoked.status !== 200) throw new Error('mcp.invoke did not delegate through broker');

  const paths = calls.map((call) => call.path);
  for (const required of ['/secrets/list', '/secrets/has', '/secrets/use']) {
    if (!paths.includes(required)) throw new Error(`missing broker call ${required}`);
  }
  const invokeCall = calls.find((call) => call.body.request?.url === 'https://example.test/mcp');
  if (!invokeCall) throw new Error('mcp.invoke did not use secret broker');
  if (JSON.stringify(calls).includes('sk-ant-secret')) throw new Error('secret value leaked into broker smoke output');

  console.log(JSON.stringify({ brokerCalls: calls.length, paths }, null, 2));
} finally {
  child.kill();
  if (hadMcpServers) await fs.writeFile(mcpServersPath, previousMcpServers);
  else await fs.rm(mcpServersPath, { force: true });
  broker.close();
}
