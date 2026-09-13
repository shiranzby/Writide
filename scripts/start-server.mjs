import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { open, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const port = Number(process.env.PORT || 5173);
const identity = createHash('sha256').update(root).digest('hex');
const url = `http://127.0.0.1:${port}`;
const logPath = path.join(root, port === 5173 ? 'writide.log' : `writide-${port}.log`);
const say = message => console.log(`[Writide] ${message}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const listening = target => new Promise(resolve => {
  const socket = createConnection({ host: '127.0.0.1', port: target });
  const done = value => { socket.destroy(); resolve(value); };
  socket.setTimeout(500, () => done(true));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
});
async function healthy() {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800) });
    const result = await response.json();
    return response.ok && result.app === 'Writide' && result.instance === identity;
  } catch { return false; }
}
function ready() {
  say(`Ready at ${url}/`);
  if (process.argv.includes('--no-browser')) return;
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', `${url}/`] : [`${url}/`];
  const browser = spawn(process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', args,
    { detached: true, stdio: 'ignore', windowsHide: true });
  browser.on('error', error => say(`Open ${url}/ manually: ${error.message}`));
  browser.unref();
}
async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65534) throw new Error('PORT must be between 1 and 65534.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('Node.js 22.12 or newer is required.');
  if (await healthy()) { say('This checkout is already running.'); return ready(); }
  if (await listening(port)) throw new Error(`Port ${port} is occupied or an older backend is running. Save your work and use stop-writide.bat, or choose another PORT. Nothing was stopped.`);
  if (await listening(port + 1)) throw new Error(`HMR port ${port + 1} is occupied. Choose another PORT. Nothing was stopped.`);
  try { await import('vite'); }
  catch { throw new Error('Dependencies are missing or broken. Run npm ci in this project, then start again.'); }
  await mkdir(path.join(root, 'Workspace'), { recursive: true });
  const log = await open(logPath, 'w');
  say(`Starting server; log: ${logPath}`);
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root, env: { ...process.env, PORT: String(port) }, detached: true,
    windowsHide: true, stdio: ['ignore', log.fd, log.fd],
  });
  let failure;
  child.once('error', error => { failure = error.message; });
  child.once('exit', (code, signal) => { failure = `Server exited (${signal || code}).`; });
  await log.close();
  child.unref();
  const started = Date.now();
  let progress = 0;
  while (Date.now() - started < 20000) {
    if (failure) {
      const tail = (await readFile(logPath, 'utf8')).split(/\r?\n/).slice(-18).join('\n');
      throw new Error(`${failure}\n${tail}`);
    }
    if (await healthy()) return ready();
    if (Date.now() - started >= progress) {
      say(`Waiting for server (${Math.round((Date.now() - started) / 1000)}s / 20s)...`);
      progress += 3000;
    }
    await delay(200);
  }
  throw new Error(`Server is not ready after 20 seconds. Check ${logPath}. No existing server was stopped.`);
}
main().catch(error => { console.error(`[Writide] ERROR: ${error.message}`); process.exitCode = 1; });
