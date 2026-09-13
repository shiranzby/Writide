import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export function productionAccess(env) {
  let origin = null;
  if (env.WRITIDE_ORIGIN) {
    origin = new URL(env.WRITIDE_ORIGIN);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('WRITIDE_ORIGIN must be the exact browser origin.');
  }
  const username = env.WRITIDE_USER || 'admin';
  const initialPassword = env.WRITIDE_PASSWORD || 'password';
  if (username.includes(':') || initialPassword.length < 8) throw new Error('Set WRITIDE_PASSWORD to at least 8 characters; username must not contain a colon.');
  let expected = createHash('sha256').update('Basic ' + Buffer.from(`${username}:${initialPassword}`).toString('base64')).digest();
  let usingDefaultPassword = initialPassword === 'password';
  const authenticate = (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    let requestOrigin = null;
    try { if (req.headers.origin) requestOrigin = new URL(req.headers.origin); } catch {}
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const effectiveHost = forwardedHost || req.headers.host;
    const originRejected = origin
      ? effectiveHost !== origin.host || (requestOrigin && requestOrigin.origin !== origin.origin)
      : Boolean(req.headers.origin && !requestOrigin);
    if (originRejected || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403); res.end('Origin not allowed'); return false;
    }
    const actual = createHash('sha256').update(req.headers.authorization || '').digest();
    if (!timingSafeEqual(actual, expected)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Writide", charset="UTF-8"' });
      res.end('Authentication required'); return false;
    }
    return true;
  };
  authenticate.restore = state => {
    if (!state || state.version !== 1 || state.username !== username || !/^[a-f0-9]{64}$/.test(state.authorizationHash || '')) return false;
    expected = Buffer.from(state.authorizationHash, 'hex');
    usingDefaultPassword = false;
    return true;
  };
  authenticate.status = () => ({ username, minLength: 8, usingDefaultPassword, fixedOrigin: origin?.origin || null });
  authenticate.changePassword = async (password, persist) => {
    if (typeof password !== 'string' || password.length < 8) throw new Error('访问密码至少需要8个字符');
    const next = createHash('sha256').update('Basic ' + Buffer.from(`${username}:${password}`).toString('base64')).digest();
    const state = { version: 1, username, authorizationHash: next.toString('hex') };
    await persist(state);
    expected = next;
    usingDefaultPassword = password === 'password';
    return authenticate.status();
  };
  return authenticate;
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
export async function serveProductionFile(root, pathname, req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  let relative;
  try { relative = decodeURIComponent(pathname); } catch { res.writeHead(400); res.end(); return; }
  const target = path.resolve(root, '.' + (relative === '/' ? '/index.html' : relative));
  try {
    const resolved = await realpath(target), base = await realpath(root);
    if (!resolved.startsWith(base + path.sep)) throw new Error('outside dist');
    const data = await readFile(resolved);
    res.writeHead(200, { 'Content-Type': types[path.extname(resolved)] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404); res.end('Not found'); }
}
