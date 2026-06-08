#!/usr/bin/env node
/**
 * One-shot splitter: parses src/App.css into top-level CSS blocks (rules,
 * @media, @keyframes, @supports) and routes each block to a focused output
 * file based on its leading selector. Preserves source order within each
 * destination file, and reassembles the output's cascade by re-importing the
 * files in the original block order from App.tsx.
 *
 * Run once: `node scripts/split-app-css.mjs`. Then commit the produced files
 * and delete src/App.css.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const inputPath = resolve(root, 'src/App.css');
const css = readFileSync(inputPath, 'utf8');

/* ---------- 1. parse: walk top-level blocks (depth-0 brace pairs) ---------- */

const blocks = [];
{
  let i = 0;
  let depth = 0;
  let blockStart = 0;
  let inBlock = false;
  let inComment = false;
  let inString = null; // ' or " or null
  const flushLeading = (end) => {
    const text = css.slice(blockStart, end);
    if (text.trim()) blocks.push({ kind: 'raw', text });
    blockStart = end;
  };
  while (i < css.length) {
    const ch = css[i];
    const next = css[i + 1];
    if (inComment) {
      if (ch === '*' && next === '/') { inComment = false; i += 2; continue; }
      i++; continue;
    }
    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inString) inString = null;
      i++; continue;
    }
    if (ch === '/' && next === '*') { inComment = true; i += 2; continue; }
    if (ch === '"' || ch === "'") { inString = ch; i++; continue; }
    if (ch === '{') {
      if (depth === 0 && !inBlock) {
        flushLeading(i);
        inBlock = true;
      }
      depth++;
      i++; continue;
    }
    if (ch === '}') {
      depth--;
      i++;
      if (depth === 0 && inBlock) {
        const text = css.slice(blockStart, i);
        blocks.push({ kind: 'rule', text });
        blockStart = i;
        inBlock = false;
      }
      continue;
    }
    i++;
  }
  if (blockStart < css.length) {
    const tail = css.slice(blockStart);
    if (tail.trim()) blocks.push({ kind: 'raw', text: tail });
  }
}

/* ---------- 2. classify: assign each block to a destination bucket -------- */

const buckets = {
  base:        { path: 'src/styles/base.css',                          rules: [] },
  shell:       { path: 'src/styles/shell.css',                         rules: [] },
  dockview:    { path: 'src/styles/dockview.css',                      rules: [] },
  topbar:      { path: 'src/components/topbar/topbar.css',             rules: [] },
  bottombar:   { path: 'src/components/BottomBar.css',                 rules: [] },
  overlays:    { path: 'src/components/overlays/overlays.css',         rules: [] },
  launcher:    { path: 'src/styles/launcher.css',                      rules: [] },
  preview:     { path: 'plugins/preview/preview.css',                  rules: [] },
  memory:      { path: 'plugins/memory/memory.css',                    rules: [] },
  agent:       { path: 'plugins/agent/agent.css',                      rules: [] },
  editor:      { path: 'plugins/editor/editor.css',                    rules: [] },
  diffHistory: { path: 'plugins/diff-history/diff-history.css',        rules: [] },
  verify:      { path: 'plugins/verify/verify.css',                    rules: [] },
  terminal:    { path: 'plugins/terminal/terminal.css',                rules: [] },
  problems:    { path: 'plugins/problems/problems.css',                rules: [] },
  chat:        { path: 'src/styles/chat-extras.css',                   rules: [] },
};

/**
 * Each rule is classified by inspecting its selector list. Priority order
 * matters: more specific tests run first. Class roots are normalized to the
 * first dash-separated token (e.g. ".memory-shell" → "memory").
 */
function bucketFor(blockText) {
  const head = blockText.split('{')[0];
  // @-rules: @media, @keyframes, @supports, @font-face — route by the SELECTOR
  // inside @media; else default to shell.
  if (head.trim().startsWith('@')) {
    // For @media/@supports nested rules: inspect inside body for hints.
    const body = blockText.slice(blockText.indexOf('{') + 1, blockText.lastIndexOf('}'));
    const innerKey = classifyByLeadingClass(body) || classifyByLeadingClass(head);
    if (innerKey) return innerKey;
    return 'shell';
  }
  const cls = classifyByLeadingClass(head);
  if (cls) return cls;
  // Bare tag selectors (html, body, *, button, input) → base
  if (/^\s*([\w*]+\b\s*[,\s]?)+\s*$/.test(head.replace(/[>+~]/g, ' '))) return 'base';
  return 'misc';
}

function classifyByLeadingClass(text) {
  // Collect every first-class token in the selector list, then vote on bucket.
  const matches = [...text.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
  if (!matches.length) return null;
  for (const cls of matches) {
    const b = bucketForClass(cls);
    if (b) return b;
  }
  return null;
}

function bucketForClass(cls) {
  // exact roots first
  if (cls === 'app-shell' || cls === 'dockspace' || cls === 'm1-spine-proof' || cls.startsWith('polypore-loading') || cls === 'active-surface' || cls === 'surface' || cls.startsWith('stage-')) return 'shell';
  if (cls.startsWith('polypore-dockview') || cls.startsWith('dv-') || cls.startsWith('dockview-') || cls === 'panel-header' || cls.startsWith('panel-header__') || cls.startsWith('panel-header-')) return 'dockview';
  if (cls === 'topbar' || cls.startsWith('topbar-') || cls.startsWith('segment') || cls.startsWith('project-menu') || cls.startsWith('git-') || cls.startsWith('branch-') || cls.startsWith('workspace-preset') || cls === 'settings-button' || cls === 'help-button' || cls.startsWith('agent-interrupt')) return 'topbar';
  if (cls === 'bottombar') return 'bottombar';
  if (cls.startsWith('panel-settings') || cls.startsWith('panel-help') || cls.startsWith('host-confirm') || cls.startsWith('global-settings') || cls.startsWith('credentials-panel') || cls.startsWith('credential-') || cls.startsWith('settings-tab') || cls.startsWith('settings-list') || cls.startsWith('settings-inline')) return 'overlays';
  if (cls.startsWith('project-launcher') || cls.startsWith('launcher-')) return 'launcher';
  if (cls.startsWith('preview-') || cls === 'preview') return 'preview';
  if (cls.startsWith('memory-') || cls.startsWith('documents-') || cls.startsWith('knowledge-')) return 'memory';
  if (cls.startsWith('agent-') || cls.startsWith('formation-') || cls.startsWith('node-') || cls.startsWith('skill-') || cls.startsWith('runtime-') || cls.startsWith('graph-')) return 'agent';
  if (cls.startsWith('editor-') || cls.startsWith('code-') || cls.startsWith('edit-')) return 'editor';
  if (cls.startsWith('diff-') || cls.startsWith('history-') || cls.startsWith('compare-') || cls.startsWith('inspector-')) return 'diffHistory';
  if (cls.startsWith('verify-') || cls.startsWith('check-') || cls.startsWith('queue-') || cls.startsWith('task-')) return 'verify';
  if (cls.startsWith('terminal-') || cls === 'terminal') return 'terminal';
  if (cls.startsWith('problem-')) return 'problems';
  if (cls.startsWith('chat-') || cls.startsWith('composer-') || cls === 'chat-box') return 'chat';
  if (cls.startsWith('file-tree') || cls.startsWith('file-bar')) return 'shell';
  if (cls.startsWith('context-') || cls.startsWith('tool-') || cls.startsWith('quick-') || cls.startsWith('tab-') || cls.startsWith('nav-') || cls.startsWith('plugin-') || cls.startsWith('host-')) return 'shell';
  if (cls.startsWith('app-')) return 'shell';
  return null;
}

/* ---------- 3. emit: write each bucket's rules + an index manifest -------- */

const order = []; // for the App.tsx import order, deduped
for (const block of blocks) {
  if (block.kind === 'raw') {
    // Free-floating comments/whitespace — attach to the most recent rule's
    // bucket if any, else to misc. Skip if pure whitespace.
    const trimmed = block.text.trim();
    if (!trimmed) continue;
    const lastBucket = order[order.length - 1] ?? 'misc';
    buckets[lastBucket].rules.push(block.text);
    continue;
  }
  const key = bucketFor(block.text);
  buckets[key].rules.push(block.text);
  if (order[order.length - 1] !== key) order.push(key);
}

const usedKeys = new Set(order);
for (const key of Object.keys(buckets)) {
  if (!buckets[key].rules.length) continue;
  const outPath = resolve(root, buckets[key].path);
  mkdirSync(dirname(outPath), { recursive: true });
  const header = `/* extracted from src/App.css — do not edit free-form; keep selectors\n   scoped to this component family so cascade stays predictable. */\n\n`;
  writeFileSync(outPath, header + buckets[key].rules.join('\n').trim() + '\n');
  usedKeys.add(key);
}

// Cascade order: take `order` (dedup), keep first occurrence — that mirrors
// the source order the rules appeared in App.css.
const seen = new Set();
const cascade = order.filter((k) => (seen.has(k) ? false : seen.add(k)));
// always pin base first if present
const finalOrder = ['base', ...cascade.filter((k) => k !== 'base')];

const importStatements = finalOrder
  .filter((k) => buckets[k].rules.length)
  .map((k) => `import '${importPathFor(buckets[k].path)}';`);

function importPathFor(p) {
  // produce a path relative to src/App.tsx
  const rel = p.replace(/^src\//, './');
  return rel.startsWith('./') ? rel : `../${p}`;
}

console.log('split complete:');
for (const key of Object.keys(buckets)) {
  const r = buckets[key].rules.length;
  if (r) console.log(`  ${key.padEnd(12)} ${String(r).padStart(4)} rules → ${buckets[key].path}`);
}
console.log('\ncascade-ordered imports:');
console.log(importStatements.join('\n'));
