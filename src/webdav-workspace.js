export const DEFAULT_DAV_URL = 'https://dav.jianguoyun.com/dav/Typora/';
let token;
let features = {};
export async function webdavRequest(body, refreshed = false) {
  if (!token) {
    const response = await fetch('/api/webdav/session');
    if (!response.ok) throw new Error('WebDAV需要本机服务，请用BAT或npm start启动后连接');
    const session = await response.json();
    if (session.version !== 4) throw new Error('WebDAV后端版本过旧，请先导出未保存修改，再停止旧服务并用BAT重新启动；仅刷新网页不能升级后端');
    token = session.token;
    features = session.features || {};
    if (!token) throw new Error('WebDAV本机服务不可用，请重启服务');
  }
  if (body.action === 'rename' && !features.documentRename) throw new Error('当前后端尚未加载文档重命名功能，请先保存或导出修改，再停止旧服务并重新启动BAT');
  if (body.action === 'move' && !features.documentMove) throw new Error('请保存修改并重启后端以启用文档移动');
  const response = await fetch('/api/webdav', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Paper-Dav-Token': token }, body: JSON.stringify(body) });
  const responseText = await response.text();
  let result = {};
  try { result = responseText ? JSON.parse(responseText) : {}; } catch { /* Preserve non-JSON proxy errors below. */ }
  if (!response.ok) {
    if (response.status === 403 && !refreshed) { token = null; return webdavRequest(body, true); }
    const message = result.error || (response.status === 403 ? '服务拒绝写入，请检查反向代理来源设置' : `WebDAV请求失败（${response.status}）`);
    throw Object.assign(new Error(message), { code: result.code || (response.status === 412 ? 'WORKSPACE_CONFLICT' : 'WEBDAV_ERROR'), status: response.status, retryAt: result.retryAt });
  }
  return result;
}
export function rememberDavSession(config) {
  sessionStorage.setItem('paper-webdav-session', config.session);
  localStorage.setItem('paper-webdav-connection', JSON.stringify({ url: config.url, username: config.username, session: config.session, autoLogin: config.autoLogin }));
}
export async function resumeWebdav(config, automatic = true) {
  let shared;
  try { shared = JSON.parse(localStorage.getItem('paper-webdav-connection')); } catch { /* Ignore old corrupt metadata. */ }
  const session = config.session || (shared?.url === config.url && shared.username === config.username ? shared.session : undefined);
  const result = await webdavRequest({ action: 'resume', url: config.url, username: config.username, session, automatic });
  Object.assign(config, result); rememberDavSession(config);
  return config;
}
function childPath(parent, name) {
  if (!name || /[\\/\x00-\x1f]/.test(name) || ['.', '..'].includes(name)) throw new Error('无效远端文件名');
  return parent ? `${parent}/${name}` : name;
}
export function webdavHandle(config) {
  const versions = new Map();
  let reconnect;
  const call = async (action, path, extra = {}) => {
    try { return await webdavRequest({ action, session: config.session, path, ...extra }); }
    catch (error) {
      if (error.code !== 'DAV_SESSION_EXPIRED') throw error;
      await (reconnect ||= resumeWebdav(config, false).finally(() => { reconnect = null; }));
      // Retain the original ETag. Reauthentication must never accept a newer body.
      return webdavRequest({ action, session: config.session, path, ...extra });
    }
  };
  function handle(path, kind) {
    return {
      kind, name: path.split('/').pop() || new URL(config.url).hostname,
      webdav: config,
      imageDimensions: paths => call('cache-dimensions', '', { paths }),
      cacheAction: (action, extra = {}) => call(`cache-${action}`, '', extra),
      async renameFileAtPath(target, destination, content) {
        const result = await call('rename', target, { destination, content, etag: versions.get(target) });
        versions.delete(target); versions.set(destination, result.etag);
        return result;
      },
      async moveFileAtPath(target, destination, content) {
        const result = await call('move', target, { destination, content, etag: versions.get(target) });
        versions.delete(target); versions.set(destination, result.etag);
        return result;
      },
      readDirectoryPage: (target, cursor, background = false) => call('list', target, { cursor, background }),
      readFileAtPath: (target, media = false) => handle(target, 'file').getFile(media),
      async writeFileAtPath(target, content) {
        if (!versions.has(target)) {
          const info = await call('stat', target);
          if (!info.missing) throw Object.assign(new Error('远端已存在同名文件，未覆盖'), { code: 'WORKSPACE_CONFLICT' });
          versions.set(target, null);
        }
        const writable = await handle(target, 'file').createWritable();
        await writable.write(content); await writable.close();
      },
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
      async *entries() {
        let cursor = null;
        const visited = new Set();
        do {
          const page = await call('list', path, { cursor });
          for (const item of page.entries) yield [item.name, handle(childPath(path, item.name), item.kind)];
          cursor = page.nextCursor;
          if (cursor && visited.has(cursor)) throw new Error('WebDAV分页循环，未加载完整目录');
          visited.add(cursor);
        } while (cursor);
      },
      async getDirectoryHandle(name, { create = false } = {}) {
        const target = childPath(path, name), info = await call('stat', target);
        if (info.missing && create) await call('mkdir', target);
        else if (info.missing) throw new DOMException('目录不存在', 'NotFoundError');
        else if (info.kind !== 'directory') throw new Error('目标不是目录');
        return handle(target, 'directory');
      },
      async getFileHandle(name, { create = false } = {}) {
        const target = childPath(path, name), info = await call('stat', target);
        if (info.missing && !create) throw new DOMException('文件不存在', 'NotFoundError');
        if (info.missing && versions.has(target) && versions.get(target) !== null) throw Object.assign(new Error('远端文件已删除，未重新创建；请保留本地修改'), { code: 'WORKSPACE_CONFLICT' });
        if (!info.missing && info.kind !== 'file') throw new Error('目标不是文件');
        if (info.missing) versions.set(target, null);
        return handle(target, 'file');
      },
      async getFile(media = false) {
        // A newly created handle has no remote bytes until its first close().
        if (versions.has(path) && versions.get(path) === null) return new File([], this.name);
        const result = await call('read', path, { media });
        versions.set(path, result.etag || '');
        const file = new File([Uint8Array.from(atob(result.data), char => char.charCodeAt(0))], this.name,
          { type: result.type, lastModified: Date.parse(result.modified) || Date.now() });
        file.cache = result.cache;
        return file;
      },
      async createWritable() {
        let data, aborted = false;
        return {
          async write(value) { data = value instanceof Blob ? value : new Blob([value]); },
          async close() {
            if (aborted || !data) throw new Error('没有待写入数据');
            if (!versions.has(path)) throw new Error('请先读取远端文件再编辑');
            const bytes = new Uint8Array(await data.arrayBuffer());
            let binary = '';
            for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            const result = await call('write', path, { data: btoa(binary), etag: versions.get(path) });
            versions.set(path, result.etag);
          },
          async abort() { aborted = true; },
        };
      },
      async removeEntry() { throw new Error('WebDAV首版暂不支持删除或重命名远端文件'); },
    };
  }
  return handle('', 'directory');
}
