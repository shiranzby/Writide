import { randomUUID, createHash } from 'node:crypto';
import { createClient, getPatcher } from 'webdav';
import { createDavTransport } from './webdav-transport.mjs';
import { readDirectoryPage } from './webdav-directory.mjs';

// Own WebDAV sessions and expose bounded operations to the local HTTP layer.

// This bridge is local-only. Never follow redirects with a user's credentials.
getPatcher().patch('fetch', createDavTransport());
const limit = 20 * 1024 * 1024;
const options = () => ({ signal: AbortSignal.timeout(15000) });
function safePath(value = '') {
  if (typeof value !== 'string' || value.includes('\\') || /[\x00-\x1f]/.test(value)
      || value.startsWith('/') || value.split('/').some(part => part === '.' || part === '..')) throw new Error('路径超出连接目录');
  return '/' + value;
}
function endpoint(value) {
  const url = new URL(value || 'https://dav.jianguoyun.com/dav/Typora/');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.hostname.startsWith('169.254.') || url.hostname === 'metadata.google.internal') throw new Error('请输入有效的 HTTP(S) WebDAV 目录地址，不要在地址中包含密码');
  url.pathname = url.pathname.replace(/\/*$/, '/');
  return url.href;
}
function credentialsCover(saved, url, username) {
  if (!saved || saved.username !== username) return false;
  const from = new URL(saved.url), to = new URL(url);
  // Reuse credentials only inside the already authorized origin and subtree.
  return from.origin === to.origin && decodeURIComponent(to.pathname).startsWith(decodeURIComponent(from.pathname).replace(/\/*$/, '/'));
}
export function supportsConditionalEtag(url, tag) {
  if (typeof tag !== 'string') return false;
  if (/^"[^\r\n]*"$/.test(tag)) return true;
  return new URL(url).hostname === 'dav.jianguoyun.com' && /^[A-Za-z0-9_-]+$/.test(tag);
}
export function createWebdavService({ credentials, imageCache } = {}) {
  const sessions = new Map();
  const media = new Map();
  let mediaBytes = 0;
  const evictMedia = key => {
    const entry = media.get(key);
    if (entry) { mediaBytes -= entry.bytes || 0; media.delete(key); }
  };
  return {
    async run(body) {
      if (body.action === 'preferences' || body.action === 'reveal-password') {
        const saved = await credentials?.read();
        if (body.action === 'reveal-password') return { password: credentialsCover(saved, endpoint(body.url), body.username) ? saved.password : '' };
        return saved ? { url: saved.url, username: saved.username, remember: true, autoLogin: saved.autoLogin } : {};
      }
      if (body.action === 'forget-password') {
        await credentials?.write(null);
        for (const item of sessions.values()) item.autoLogin = false;
        return {};
      }
      if (body.action === 'resume') {
        const url = endpoint(body.url), username = String(body.username || '');
        const live = sessions.get(body.session);
        if (live && live.url === url && live.username === username && (!body.automatic || live.autoLogin)) {
          live.used = Date.now();
          return { session: body.session, url, username, autoLogin: live.autoLogin };
        }
        const saved = await credentials?.read();
        if (!saved?.autoLogin || saved.url !== url || saved.username !== username) throw Object.assign(new Error('请手动连接WebDAV'), { status: 401, code: 'DAV_SESSION_EXPIRED' });
        return this.run({ action: 'connect', ...saved, remember: true });
      }
      if (body.action === 'connect') {
        const url = endpoint(body.url);
        const username = String(body.username || '');
        let password = String(body.password || '');
        if (!password) {
          const saved = await credentials?.read();
          if (credentialsCover(saved, url, username)) password = saved.password;
          if (!password) {
            const live = sessions.get(body.session);
            if (live && Date.now() - live.used <= 8 * 3600000 && credentialsCover(live, url, username)) password = live.password;
          }
        }
        if (body.remember && !credentials) throw new Error('当前服务不支持保存密码');
        const client = createClient(url, { username, password });
        const page = await readDirectoryPage(client, url, '/');
        if (body.remember) await credentials.write({ url, username, password, autoLogin: Boolean(body.autoLogin) });
        else if (body.remember === false) await credentials?.write(null);
        for (const item of sessions.values()) if (item.url === url && item.username === username) item.autoLogin = Boolean(body.autoLogin && body.remember);
        for (const [id, session] of sessions) if (Date.now() - session.used > 8 * 3600000) sessions.delete(id);
        if (sessions.size >= 20) throw new Error('连接过多，请断开不用的连接');
        const session = randomUUID();
        const account = createHash('sha256').update(JSON.stringify([url, username, password])).digest('hex');
        const cacheAccount = createHash('sha256').update(JSON.stringify([url, username])).digest('hex');
        sessions.set(session, { client, url, username, password, account, cacheAccount, autoLogin: Boolean(body.autoLogin && body.remember), used: Date.now(), lists: new Map([['/|', { page: Promise.resolve(page), time: Date.now() }]]) });
        return { session, url, username, autoLogin: Boolean(body.autoLogin && body.remember) };
      }
      const session = sessions.get(body.session);
      if (!session || Date.now() - session.used > 8 * 3600000) {
        sessions.delete(body.session);
        throw Object.assign(new Error('WebDAV连接已过期，请重新连接；未保存内容仍保留在编辑器中'), { status: 401, code: 'DAV_SESSION_EXPIRED' });
      }
      session.used = Date.now();
      if (body.action.startsWith('cache-')) {
        if (!imageCache) throw new Error('当前服务未启用图片磁盘缓存');
        if (body.action === 'cache-status') return imageCache.status();
        if (body.action === 'cache-configure') return imageCache.configure(body.settings || {});
        if (body.action === 'cache-clear') return imageCache.clear();
        if (body.action === 'cache-refresh') return imageCache.refresh(session.cacheAccount);
        if (body.action === 'cache-dimensions') {
          if (!Array.isArray(body.paths) || body.paths.length > 5000) throw new Error('图片尺寸请求过大');
          return imageCache.dimensions(session.cacheAccount, body.paths.map(value => safePath(value)));
        }
      }
      if (body.action === 'disconnect') {
        sessions.delete(body.session);
        for (const item of sessions.values()) if (item.url === session.url && item.username === session.username) item.autoLogin = false;
        const saved = await credentials?.read();
        if (saved?.url === session.url && saved.username === session.username) await credentials.write({ ...saved, autoLogin: false });
        return {};
      }
      const client = session.client, path = safePath(body.path);
      if (body.action === 'rename' || body.action === 'move') {
        const destination = safePath(body.destination);
        if (!/\.(md|markdown|txt)$/i.test(path) || !/\.(md|markdown|txt)$/i.test(destination)
            || (body.action === 'rename' && path.slice(0, path.lastIndexOf('/')) !== destination.slice(0, destination.lastIndexOf('/')))
            || (body.action === 'move' && path.split('/').at(-1) !== destination.split('/').at(-1))
            || destination === path) throw new Error('只支持同一目录内的文档重命名');
        const tag = body.etag;
        if (!supportsConditionalEtag(session.url, tag)) throw new Error('缺少可用于条件重命名的ETag，未移动文件');
        if (typeof body.content !== 'string' || Buffer.byteLength(body.content) > limit) throw new Error('无效文档内容');
        if (body.action === 'move') {
          const original = await client.getFileContents(path, { ...options(), details: true });
          if (original.headers.etag !== tag || !Buffer.from(original.data).equals(Buffer.from(body.content))) {
            throw Object.assign(new Error('移动前源文档已变化，未移动'), { status: 412 });
          }
        }
        await client.moveFile(path, destination, { ...options(), overwrite: false, headers: { 'If-Match': tag, 'X-Paper-Dav-Work': 'write' } });
        for (const item of sessions.values()) if (item.cacheAccount === session.cacheAccount) item.lists.clear();
        try {
          const result = await client.getFileContents(destination, { ...options(), details: true, headers: { 'X-Paper-Dav-Work': 'write' } });
          const changed = !Buffer.from(result.data).equals(Buffer.from(body.content));
          return { path: destination.slice(1), etag: changed ? tag : result.headers.etag || tag, changed };
        } catch {
          throw new Error('远端已执行重命名，但新文件读取核对失败；请保留本机内容，重新连接确认路径，不自动重试移动');
        }
      }
      if (body.action === 'list') {
        const key = path + '|' + (body.cursor || '');
        let cached = session.lists.get(key);
        if (!cached || Date.now() - cached.time > 60000) {
          cached = { page: readDirectoryPage(client, session.url, path, body.cursor, Boolean(body.background)), time: Date.now() };
          session.lists.set(key, cached);
          if (session.lists.size > 2048) session.lists.delete(session.lists.keys().next().value);
          cached.page.catch(() => { if (session.lists.get(key) === cached) session.lists.delete(key); });
        }
        return cached.page;
      }
      if (body.action === 'stat') {
        try { const info = await client.stat(path, options()); return { kind: info.type === 'directory' ? 'directory' : 'file', size: info.size }; }
        catch (error) { if (error.status === 404) return { missing: true }; throw error; }
      }
      if (body.action === 'mkdir') { await client.createDirectory(path, options()); session.lists.clear(); return {}; }
      if (body.action === 'read') {
        const read = async () => {
          const result = await client.getFileContents(path, { ...options(), details: true, headers: { 'X-Paper-Dav-Work': body.media ? 'image' : 'read' } });
          const buffer = Buffer.from(result.data);
          if (buffer.length > limit) throw new Error('单文件超过20MiB');
          return { data: buffer.toString('base64'), etag: result.headers.etag || null, type: result.headers['content-type'] || '', modified: result.headers['last-modified'] || '' };
        };
        if (!body.media) return read();
        if (imageCache) return imageCache.read(session.cacheAccount, path, read,
          (folder, cursor) => readDirectoryPage(client, session.url, folder, cursor, false, true));
        const key = session.account + path;
        for (const [old, entry] of media) if (Date.now() - entry.time > 300000) evictMedia(old);
        let cached = media.get(key);
        if (cached) { media.delete(key); media.set(key, cached); return cached.pending; }
        cached = { time: Date.now(), bytes: 0 };
        cached.pending = read().then(result => {
          if (media.get(key) === cached) {
            cached.bytes = result.data.length; mediaBytes += cached.bytes;
            while (mediaBytes > 64 * 1024 * 1024 || media.size > 512) evictMedia(media.keys().next().value);
          }
          return result;
        }).catch(error => { if (media.get(key) === cached) evictMedia(key); throw error; });
        media.set(key, cached);
        return cached.pending;
      }
      if (body.action === 'write') {
        evictMedia(session.account + path);
        await imageCache?.invalidate(session.cacheAccount, path);
        if (typeof body.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw new Error('无效文件内容');
        const data = Buffer.from(body.data, 'base64');
        if (data.length > limit) throw new Error('单文件超过20MiB');
        if (body.etag !== null && !supportsConditionalEtag(session.url, body.etag)) throw new Error('远端未提供可用于条件保存的ETag，拒绝无条件覆盖；请另存为新文件');
        const written = await client.putFileContents(path, data, { ...options(), overwrite: body.etag !== null,
          headers: body.etag === null ? {} : { 'If-Match': body.etag } });
        if (!written) throw Object.assign(new Error('远端已存在同名文件，未覆盖'), { status: 412 });
        session.lists.clear();
        // Re-read the exact bytes and ETag, never attach a newer version's ETag
        // to an older local body after another client's concurrent write.
        const result = await client.getFileContents(path, { ...options(), details: true, headers: { 'X-Paper-Dav-Work': 'write' } });
        if (!Buffer.from(result.data).equals(data)) throw Object.assign(new Error('远端内容已再次改变，请保留本地内容并重新连接核对'), { status: 412 });
        await imageCache?.invalidate(session.cacheAccount, path);
        return { etag: result.headers.etag || '' };
      }
      throw new Error('WebDAV首版暂不支持删除、移动或重命名远端文件');
    },
  };
}

export function webdavError(error) {
  if ([429, 503].includes(error.status)) return `远端服务暂时不可用或请求受限（${error.status}），${Math.max(1, Math.ceil(((error.retryAt || Date.now() + 30000) - Date.now()) / 1000))}秒后可重试；未保存修改仍保留`;
  if (error.status === 412) return '保存冲突：远端文件已变化，未覆盖。请导出本地修改后重新连接核对。';
  if (error.status === 401 || error.status === 403) return '连接失效或没有权限，请检查账号并重新连接；本地修改未丢弃。';
  if (error.status === 404) return 'WebDAV路径不存在（404），请核对目录名称和大小写；子目录可直接填写完整URL，不需要先连接网盘根目录。';
  if (error.status) return `WebDAV请求失败（${error.status}），未回退到本地工作区`;
  return error.message?.startsWith('fetch') ? '无法连接WebDAV，请检查地址、证书和网络（不跟随重定向）' : error.message;
}
