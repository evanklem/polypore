import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let nextId = 1;
const repoRoot = process.cwd();

function requestMessage(method, params = {}, env = {}, cwd = repoRoot) {
  const id = nextId++;
  const input = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
  const output = execFileSync(process.execPath, [path.join(repoRoot, 'packages/mcp-server/src/server.mjs')], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
  const lines = output.split('\n').filter(Boolean);
  return JSON.parse(lines.at(-1));
}

function request(method, params = {}, env = {}, cwd = repoRoot) {
  const msg = requestMessage(method, params, env, cwd);
  if (msg.error) throw new Error(msg.error.message);
  return msg.result;
}

function tool(name, args = {}, env = {}, cwd = repoRoot) {
  return request('tools/call', { name, arguments: args }, env, cwd);
}

request('initialize');
const verifyProject = mkdtempSync(path.join(tmpdir(), 'polypore-mcp-verify-'));
try {
  writeFileSync(path.join(verifyProject, 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'node -e "process.stdout.write(\\"typed-ok\\")"',
    },
  }, null, 2));
  const verified = tool('polypore.verify.run', { id: 'typecheck' }, {}, verifyProject);
  if (verified.run.exitCode !== 0 || !verified.run.output.includes('typed-ok')) {
    throw new Error('verify.run did not execute the typecheck script in the target project');
  }
  const binDir = path.join(verifyProject, 'bin');
  mkdirSync(binDir);
  writeFileSync(path.join(verifyProject, 'Cargo.toml'), '[package]\nname = "verify-smoke"\nversion = "0.1.0"\nedition = "2021"\n');
  writeFileSync(path.join(binDir, 'cargo'), '#!/usr/bin/env node\nprocess.stdout.write(`fake-cargo ${process.argv.slice(2).join(" ")}`);\n');
  chmodSync(path.join(binDir, 'cargo'), 0o755);
  const cargoVerified = tool('polypore.verify.run', { id: 'cargo-check' }, {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
  }, verifyProject);
  if (cargoVerified.run.exitCode !== 0 || !cargoVerified.run.output.includes('fake-cargo check')) {
    throw new Error('verify.run did not execute the Cargo autodetected command');
  }
  tool('polypore.verify.declare', {
    commands: [
      {
        id: 'custom-check',
        label: 'custom check',
        command: 'node -e "process.stdout.write(\\"declared-ok\\")"',
        required: true,
      },
    ],
  }, {}, verifyProject);
  const declaredVerified = tool('polypore.verify.run', { id: 'custom-check' }, {}, verifyProject);
  if (declaredVerified.run.exitCode !== 0 || !declaredVerified.run.output.includes('declared-ok')) {
    throw new Error('verify.run did not execute a declared custom command');
  }
  const invalidVerify = requestMessage('tools/call', {
    name: 'polypore.verify.run',
    arguments: { id: 'typecheck; echo unsafe' },
  }, {}, verifyProject);
  if (!invalidVerify.error || invalidVerify.error.code !== -32602) {
    throw new Error('verify.run accepted an undeclared command id');
  }
  mkdirSync(path.join(verifyProject, '.polypore'), { recursive: true });
  writeFileSync(path.join(verifyProject, 'app.roc'), 'roc source');
  writeFileSync(path.join(verifyProject, '.polypore', 'formatters.json'), JSON.stringify({
    formatters: [{
      id: 'roc-format',
      label: 'roc format',
      command: 'node -e "const fs=require(\\"fs\\"); const p=process.argv[1]; fs.writeFileSync(p, fs.readFileSync(p, \\"utf8\\").toUpperCase())" {file}',
      extensions: ['roc'],
    }],
  }, null, 2));
  const formatted = tool('polypore.format.run', { id: 'roc-format', file: 'app.roc' }, {}, verifyProject);
  if (formatted.run.exitCode !== 0 || readFileSync(path.join(verifyProject, 'app.roc'), 'utf8') !== 'ROC SOURCE') {
    throw new Error('format.run did not execute the declared formatter command');
  }
} finally {
  rmSync(verifyProject, { recursive: true, force: true });
}
const fetched = tool('polypore.plugins.fetch', { url: 'plugins/chat', ref: 'local' });
const scanned = tool('polypore.plugins.scan', { stagingPath: fetched.stagingPath });
if (!scanned.candidates.length) throw new Error('expected plugin candidate');
const candidate = scanned.candidates[0];
const inspected = tool('polypore.plugins.inspect', {
  stagingPath: fetched.stagingPath,
  manifestPath: candidate.manifestPath,
});
if (inspected.errors.length) throw new Error(inspected.errors.join(', '));
const installed = tool('polypore.plugins.install', {
  stagingPath: fetched.stagingPath,
  manifestPath: candidate.manifestPath,
  scope: 'project',
});
if (!installed.installed) throw new Error(`install failed: ${installed.reason}`);
const listed = tool('polypore.plugins.list');
if (!listed.plugins.some((plugin) => plugin.id === 'polypore.chat')) throw new Error('installed plugin missing');
tool('polypore.skills.create', { id: 'pipeline-smoke', body: '# pipeline-smoke\n' });
const skills = tool('polypore.skills.list', { scope: 'project' });
if (!skills.skills.some((skill) => skill.id === 'pipeline-smoke')) throw new Error('created skill missing');
/* the skill is written into the real project's .polypore/skills — delete it
   again so the smoke test leaves no artifact in the working tree. */
tool('polypore.skills.delete', { id: 'pipeline-smoke' });
/* security posture: without a secret broker the standalone sidecar must NOT
   read secret values from its own environment. listing returns nothing and the
   value never appears, even when POLYPORE_SECRET_* is present in env. */
const secrets = tool('polypore.secrets.list', {}, { POLYPORE_SECRET_ANTHROPIC_PROD: 'sk-ant-test-value' });
if (secrets.secrets.length !== 0) throw new Error('standalone sidecar must not surface env secrets without a broker');
if (JSON.stringify(secrets).includes('sk-ant-test-value')) {
  throw new Error('secret value leaked into mcp output');
}
const secretHas = tool('polypore.secrets.has', { id: 'anthropic-prod' }, { POLYPORE_SECRET_ANTHROPIC_PROD: 'sk-ant-test-value' });
if (secretHas.configured !== false) throw new Error('standalone secrets.has must report not-configured without a broker');
let secretUseRefused = false;
try {
  tool('polypore.secrets.use', { id: 'anthropic-prod', request: { url: 'https://example.test' } }, { POLYPORE_SECRET_ANTHROPIC_PROD: 'sk-ant-test-value' });
} catch (err) {
  secretUseRefused = /secret broker/.test(err.message ?? '');
}
if (!secretUseRefused) throw new Error('standalone secrets.use must refuse without a broker');

const symlinkRoot = mkdtempSync(path.join(tmpdir(), 'polypore-mcp-kb-'));
mkdirSync(path.join(symlinkRoot, '.knowledge'), { recursive: true });
writeFileSync(path.join(symlinkRoot, 'outside.md'), 'outside');
symlinkSync(path.join(symlinkRoot, 'outside.md'), path.join(symlinkRoot, '.knowledge', 'linked.md'));
const symlinkRead = requestMessage('tools/call', {
  name: 'polypore.memory.read',
  arguments: { path: 'linked.md' },
}, {}, symlinkRoot);
if (!symlinkRead.error || !String(symlinkRead.error.message).includes('symbolic links')) {
  throw new Error('knowledge symlink read was not rejected');
}

const outsidePlugin = mkdtempSync(path.join(tmpdir(), 'polypore-plugin-outside-'));
writeFileSync(path.join(outsidePlugin, 'polypore.json'), JSON.stringify({
  schemaVersion: 1,
  id: 'outside.plugin',
  title: 'outside',
  icon: '!',
  version: '0.0.0',
  entry: 'index.html',
  permissions: [],
  capabilities: [],
  category: 'other',
}, null, 2));
const outsideFetch = requestMessage('tools/call', {
  name: 'polypore.plugins.fetch',
  arguments: { url: outsidePlugin },
});
if (!outsideFetch.error || !String(outsideFetch.error.message).includes('path must stay under')) {
  throw new Error('absolute local plugin fetch outside the project was not rejected');
}

const symlinkProjectRoot = mkdtempSync(path.join(tmpdir(), 'polypore-plugin-project-'));
const symlinkPlugin = mkdtempSync(path.join(symlinkProjectRoot, 'plugin-symlink-'));
writeFileSync(path.join(symlinkPlugin, 'polypore.json'), JSON.stringify({
  schemaVersion: 1,
  id: 'symlink.plugin',
  title: 'symlink',
  icon: '!',
  version: '0.0.0',
  entry: 'index.html',
  permissions: [],
  capabilities: [],
  category: 'other',
}, null, 2));
writeFileSync(path.join(symlinkPlugin, 'entry.js'), 'console.log("ok");\n');
symlinkSync(path.join(symlinkPlugin, 'entry.js'), path.join(symlinkPlugin, 'linked.js'));
const symlinkFetch = requestMessage('tools/call', {
  name: 'polypore.plugins.fetch',
  arguments: { url: path.relative(symlinkProjectRoot, symlinkPlugin) },
}, {}, symlinkProjectRoot);
if (!symlinkFetch.error || !String(symlinkFetch.error.message).includes('symbolic links')) {
  throw new Error('local plugin symlink was not rejected during fetch');
}

const stagingRoot = path.join(process.env.HOME, '.cache', 'polypore', 'staging');
mkdirSync(stagingRoot, { recursive: true });
const stagingOutside = mkdtempSync(path.join(tmpdir(), 'polypore-staging-outside-'));
const stagingLink = path.join(stagingRoot, `linked-${Date.now()}`);
symlinkSync(stagingOutside, stagingLink);
const symlinkScan = requestMessage('tools/call', {
  name: 'polypore.plugins.scan',
  arguments: { stagingPath: stagingLink },
});
if (!symlinkScan.error || !String(symlinkScan.error.message).includes('symbolic links')) {
  throw new Error('symlinked staging path was not rejected');
}
rmSync(stagingLink, { force: true, recursive: true });

console.log(JSON.stringify({
  plugin: installed.plugin.id,
  candidates: scanned.candidates.length,
  skills: skills.skills.length,
  secrets: secrets.secrets.length,
}, null, 2));
