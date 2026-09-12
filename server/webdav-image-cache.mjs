import { mkdir, readFile, writeFile, rename, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { imageDimensions } from './image-dimensions.mjs';

// The cache is disposable server data; remote images remain authoritative.

const hash = value => createHash('sha256').update(value).digest('hex');
const defaults = { enabled: true, maxBytes: 1024 * 1024 * 1024, checkInterval: 30 * 60000 };
const validHash = value => /^[a-f0-9]{64}$/.test(value);

// Cache files are disposable, but remote files and unsaved documents never are.
export function createImageCache({ directory, now = Date.now } = {}) {
  const root = path.resolve(directory), indexPath = path.join(root, 'index.json');
  const entries = new Map(), pending = new Map(), directories = new Map();
  let settings = { ...defaults }, queue = Promise.resolve(), epoch = 0, warning = '';
  let hits = 0, downloads = 0;
  const keyFor = (scope, file) => hash(scope + '\0' + file);
  const enqueue = operation => {
    const result = queue.then(operation); queue = result.catch(() => {}); return result;
  };
  const persist = async () => {
    const temp = path.join(root, `index-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify({ version: 1, settings, entries: [...entries] }), { mode: 0o600 });
      await rename(temp, indexPath);
    } finally { await rm(temp, { force: true }); }
  };
  const remove = async key => {
    entries.delete(key);
    // Only generated SHA-256 filenames in the dedicated cache directory.
    if (validHash(key)) await rm(path.join(root, key + '.bin'), { force: true });
  };
  const trim = async () => {
    let bytes = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [key, entry] of [...entries].sort((a, b) => a[1].used - b[1].used)) {
      if (bytes <= settings.maxBytes && entries.size <= 5000) break;
      bytes -= entry.bytes; await remove(key);
    }
  };
  const ready = (async () => {
    try {
      await mkdir(root, { recursive: true });
      try {
        const saved = JSON.parse(await readFile(indexPath, 'utf8'));
        if (saved.version !== 1 || !Array.isArray(saved.entries)) throw new Error('invalid cache index');
        if (typeof saved.settings?.enabled === 'boolean') settings.enabled = saved.settings.enabled;
        if (Number.isFinite(saved.settings?.maxBytes) && saved.settings.maxBytes >= 1024 * 1024 && saved.settings.maxBytes <= 10 * 1024 ** 3) settings.maxBytes = saved.settings.maxBytes;
        if (Number.isFinite(saved.settings?.checkInterval) && saved.settings.checkInterval >= 60000 && saved.settings.checkInterval <= 7 * 86400000) settings.checkInterval = saved.settings.checkInterval;
        for (const [key, entry] of saved.entries) {
          if (validHash(key) && validHash(entry?.scope) && typeof entry.path === 'string'
              && key === keyFor(entry.scope, entry.path) && validHash(entry.digest)
              && Number.isFinite(entry.bytes) && entry.bytes >= 0 && entry.bytes <= 20 * 1024 ** 2
              && Number.isFinite(entry.checked) && Number.isFinite(entry.used)) entries.set(key, entry);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') warning = '图片缓存索引不可用，将重新读取图片';
      }
      for (const file of await readdir(root)) {
        const key = file.replace(/\.bin$/, '');
        if (file === key + '.bin' && validHash(key) && !entries.has(key)) await rm(path.join(root, file), { force: true });
      }
      await trim();
    } catch { warning = '无法使用本机图片缓存目录，图片仍可在线读取'; }
  })();
  const fresh = time => Number.isFinite(time) && now() >= time && now() - time < settings.checkInterval;
  async function directoryVersions(scope, folder, list) {
    const key = keyFor(scope, folder);
    let cached = directories.get(key);
    if (!cached || !fresh(cached.time)) {
      const generation = epoch;
      cached = { time: now(), promise: (async () => {
        let cursor = null;
        const seen = new Set(), files = new Map();
        do {
          const page = await list(folder, cursor);
          for (const entry of page.entries) if (entry.kind === 'file') files.set(entry.name, entry);
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor)) throw new Error('图片目录分页循环，未完成版本检查');
          seen.add(cursor);
          if (files.size > 50000 || seen.size > 100) throw new Error('图片目录过大，未完成版本检查');
        } while (cursor);
        if (epoch !== generation) throw new Error('图片缓存已失效，请重新读取');
        return files;
      })() };
      directories.set(key, cached);
      if (directories.size > 128) directories.delete(directories.keys().next().value);
      cached.promise.catch(() => { if (directories.get(key) === cached) directories.delete(key); });
    }
    return { files: await cached.promise, checked: cached.time };
  }
  const resultFor = (entry, data, state, message = '') => ({ data: data.toString('base64'), etag: entry.etag,
    modified: entry.modified, type: entry.type, cache: { state, width: entry.width, height: entry.height, warning: message } });
  return {
    async read(scope, file, remote, list) {
      await ready;
      const key = keyFor(scope, file);
      if (pending.has(key)) return pending.get(key);
      const generation = epoch;
      const job = (async () => {
        let entry = settings.enabled && entries.get(key), data;
        if (entry) {
          try {
            data = await readFile(path.join(root, key + '.bin'));
            if (data.length !== entry.bytes || hash(data) !== entry.digest) throw new Error('invalid image cache');
          } catch { entry = null; }
        }
        if (entry && !fresh(entry.checked)) {
          try {
            const folder = file.slice(0, file.lastIndexOf('/')) || '/';
            const versions = await directoryVersions(scope, folder, list);
            const version = versions.files.get(file.slice(file.lastIndexOf('/') + 1));
            if (version?.etag && version.etag === entry.etag && (!Number.isFinite(version.size) || version.size === entry.bytes)) {
              entry = { ...entry, checked: versions.checked, used: now() };
              await enqueue(async () => { if (epoch === generation) { entries.set(key, entry); await persist(); } });
            } else entry = null;
          } catch (error) {
            if ([401, 403, 404].includes(error.status)) throw error;
            hits++;
            return resultFor(entry, data, 'stale', '图片版本检查失败，暂时显示本机缓存；联网后重新打开检查');
          }
        }
        if (entry) { entry.used = now(); hits++; return resultFor(entry, data, 'hit'); }
        downloads++;
        const response = await remote();
        const bytes = Buffer.from(response.data, 'base64');
        let width, height;
        const size = imageDimensions(bytes);
        if (size) ({ width, height } = size);
        const meta = { scope, path: file, bytes: bytes.length, digest: hash(bytes), etag: response.etag,
          modified: response.modified, type: response.type, width, height, checked: now(), used: now() };
        if (settings.enabled && bytes.length <= settings.maxBytes) {
          try {
            await enqueue(async () => {
              if (epoch !== generation || !settings.enabled) return;
              const temp = path.join(root, key + '-' + randomUUID() + '.tmp');
              try { await writeFile(temp, bytes, { mode: 0o600 }); await rename(temp, path.join(root, key + '.bin')); }
              finally { await rm(temp, { force: true }); }
              entries.set(key, meta); await trim(); await persist(); warning = '';
            });
          } catch { warning = '图片已读取，但本机缓存写入失败；请检查磁盘空间或目录权限'; }
        }
        return { ...response, cache: { state: settings.enabled ? 'download' : 'disabled', width, height, warning } };
      })();
      pending.set(key, job);
      try { return await job; } finally { if (pending.get(key) === job) pending.delete(key); }
    },
    async invalidate(scope, file) {
      await ready;
      const key = keyFor(scope, file);
      if (!entries.has(key) && !pending.has(key)) return;
      epoch++; pending.delete(key); directories.clear();
      await enqueue(async () => { await remove(key); await persist(); }).catch(() => { warning = '缓存失效记录写入失败'; });
    },
    async dimensions(scope, paths) {
      await ready;
      const result = {};
      if (settings.enabled) for (const file of paths) {
        const entry = entries.get(keyFor(scope, file));
        if (entry?.width > 0 && entry?.height > 0) result[file] = { width: entry.width, height: entry.height };
      }
      return { images: result, warning };
    },
    async status() {
      await ready;
      return { ...settings, bytes: [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0),
        count: entries.size, hits, downloads, warning };
    },
    async configure(value) {
      await ready;
      if (typeof value.enabled !== 'boolean' || !Number.isInteger(value.maxBytes) || value.maxBytes < 1024 ** 2 || value.maxBytes > 10 * 1024 ** 3
          || !Number.isInteger(value.checkInterval) || value.checkInterval < 60000 || value.checkInterval > 7 * 86400000) throw new Error('无效缓存设置');
      await enqueue(async () => { settings = { enabled: value.enabled, maxBytes: value.maxBytes, checkInterval: value.checkInterval }; epoch++; directories.clear(); pending.clear(); await trim(); await persist(); });
      return this.status();
    },
    async clear() {
      await ready;
      await enqueue(async () => { epoch++; directories.clear(); pending.clear(); for (const key of [...entries.keys()]) await remove(key); await persist(); });
      return this.status();
    },
    async refresh(scope) {
      await ready;
      await enqueue(async () => { epoch++; directories.clear(); pending.clear(); for (const entry of entries.values()) if (entry.scope === scope) entry.checked = 0; await persist(); });
      return this.status();
    },
  };
}
