#!/usr/bin/env node
/*
 * Polypore web auto-nav driver (phase 1.5).
 *
 * Spawned by src-tauri/src/webdriver.rs with cwd = the project root, so
 * `import('playwright')` resolves the project's own install. Launches a headed
 * Chromium and speaks Content-Length-framed JSON over stdio — the same framing
 * the rest of the shell uses, but plain request/response (no events).
 *
 * Protocol:
 *   ← (greeting)            { ready: true }   |  { ready: false, error }
 *   → { seq, command, args }
 *   ← { seq, ok: true, result? }  |  { seq, ok: false, error }
 *
 * Commands: navigate {url} · click {selector} · fill {selector, value} · close.
 *
 * Secret values arrive already-resolved in `fill` args from the trusted Rust
 * side; this script never sees secret handles and never logs field values.
 */

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    try {
      ({ chromium } = await import('@playwright/test'));
    } catch (err) {
      writeMessage({ ready: false, error: `playwright is not installed: ${err?.message ?? err}` });
      process.exit(0);
      return;
    }
  }

  let browser;
  let page;
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    page = await context.newPage();
  } catch (err) {
    writeMessage({ ready: false, error: `failed to launch browser: ${err?.message ?? err}` });
    process.exit(0);
    return;
  }

  writeMessage({ ready: true });

  async function handle(command, args) {
    switch (command) {
      case 'navigate':
        await page.goto(args.url, { waitUntil: 'load' });
        return { url: page.url() };
      case 'click':
        await page.click(args.selector);
        return {};
      case 'fill':
        /* never log args.value — it may be a resolved secret. */
        await page.fill(args.selector, args.value ?? '');
        return {};
      case 'screenshot': {
        const buffer = await page.screenshot();
        return { mimeType: 'image/png', dataBase64: buffer.toString('base64') };
      }
      case 'close':
        await browser.close();
        return {};
      default:
        throw new Error(`unknown command: ${command}`);
    }
  }

  // frame reader over stdin
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buffer.slice(0, headerEnd).toString('utf8');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.slice(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.slice(bodyStart + length);
      let request;
      try {
        request = JSON.parse(body);
      } catch {
        continue;
      }
      try {
        const result = await handle(request.command, request.args ?? {});
        writeMessage({ seq: request.seq, ok: true, result });
        if (request.command === 'close') process.exit(0);
      } catch (err) {
        writeMessage({ seq: request.seq, ok: false, error: err?.message ?? String(err) });
      }
    }
  });

  process.stdin.on('end', async () => {
    try { await browser.close(); } catch { /* ignore */ }
    process.exit(0);
  });
}

main().catch((err) => {
  writeMessage({ ready: false, error: err?.message ?? String(err) });
  process.exit(1);
});
