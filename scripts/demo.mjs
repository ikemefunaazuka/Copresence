#!/usr/bin/env node
/**
 * `npm run demo` — boots the real server (via `tsx`, no separate build
 * step needed for the server itself) on a fixed local port, mints a
 * session the same way a user clicking "Start a new session" would, and
 * opens two browser windows already pointed at it. Assumes
 * `packages/protocol` and `packages/client` are already built — the root
 * `demo` script does that first, same as `verify` does for everything
 * else that depends on them.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const PORT = process.env.DEMO_PORT ?? '3000';
const BASE_URL = `http://127.0.0.1:${PORT}`;

const CHROME_CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'],
};

/**
 * Prefers launching Chrome/Edge directly with `--new-window` so the demo
 * actually gets two separate windows (the point of recording it side by
 * side) rather than two tabs in one. Falls back to the OS's default
 * "open this URL" handler — likely a new tab in whatever's already
 * running — when no known browser binary is found; still functional,
 * just not as photogenic.
 */
function openWindow(url) {
  const chrome = (CHROME_CANDIDATES[process.platform] ?? []).find((path) => existsSync(path));
  if (chrome) {
    spawn(chrome, ['--new-window', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

async function waitForHealthy(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/healthz`);
      if (res.ok) return;
    } catch {
      // not listening yet — retry until the deadline
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

const server = spawn('npx', ['tsx', 'apps/server/src/index.ts'], {
  env: { ...process.env, PORT, LOG_LEVEL: process.env.LOG_LEVEL ?? 'info' },
  stdio: 'inherit',
  shell: process.platform === 'win32', // `npx` resolves via a .cmd shim on Windows, which needs a shell
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.kill();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.on('exit', (code) => {
  if (!shuttingDown) process.exit(code ?? 1);
});

try {
  await waitForHealthy();

  const res = await fetch(`${BASE_URL}/s/new`);
  const sessionUrl = res.url; // fetch follows the redirect; .url is the final /s/<sid> address

  console.log(`\nCopresence demo session ready:\n  ${sessionUrl}\n`);
  openWindow(sessionUrl);
  openWindow(sessionUrl);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  shutdown();
  process.exitCode = 1;
}
