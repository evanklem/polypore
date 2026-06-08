#!/usr/bin/env node
/* Headless screenshot helper for the dev preview surfaces.
 * Usage: node scripts/shoot.mjs <outfile> <query>
 *   node scripts/shoot.mjs /tmp/settings-overview.png "surface=settings&section=overview" */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [, , out, query = ''] = process.argv;
if (!out) { console.error('need outfile'); process.exit(1); }
const url = `http://127.0.0.1:1420/preview-theme.html?${query}`;
const profile = mkdtempSync(join(tmpdir(), 'shoot-'));
execFileSync('chromium', [
  '--headless', '--no-sandbox', '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=1440,900',
  `--screenshot=${out}`,
  `--user-data-dir=${profile}`,
  '--virtual-time-budget=2500',
  url,
], { stdio: 'inherit' });
console.log('wrote', out);
