import { spawn } from 'node:child_process';
import net from 'node:net';

const DEV_URL = 'http://127.0.0.1:1420';
const DEV_HOST = '127.0.0.1';
const DEV_PORT = 1420;

async function serverIsReady() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    const response = await fetch(DEV_URL, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

async function portIsOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: DEV_HOST, port: DEV_PORT });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

if (await serverIsReady() || await portIsOpen()) {
  console.log(`Vite dev server already running at ${DEV_URL}`);
  process.exit(0);
}

const child = spawn('npm', ['run', 'dev'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
