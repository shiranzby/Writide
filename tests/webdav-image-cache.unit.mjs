import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createImageCache } from '../server/webdav-image-cache.mjs';
import { createWebdavService } from '../server/webdav-service.mjs';
import { mockWebdav } from './fixtures/webdav-server.mjs';

const png = (size = 40) => {
  const bytes = Buffer.alloc(size); Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes);
  bytes.writeUInt32BE(1200, 16); bytes.writeUInt32BE(800, 20); return bytes;
};
const scope = createHash('sha256').update('test-account').digest('hex');
const configFor = dav => ({ action: 'connect', url: dav.url, username: 'writer', password: 'secret' });
const temporary = () => mkdtemp(path.join(tmpdir(), 'writide-cache-'));

test('recreated service uses persisted bytes and natural dimensions without image GETs', async () => {
  const directory = await temporary(), dav = await mockWebdav();
  dav.folders.add('笔记.assets');
  dav.files.set('笔记.assets/测试图.png', { data: png(), etag: 'opaque-nutstore-tag' });
  try {
    const create = () => createWebdavService({ imageCache: createImageCache({ directory }) });
    let service = create(), connection = await service.run(configFor(dav));
    const get = () => service.run({ action: 'read', session: connection.session, path: '笔记.assets/测试图.png', media: true });
    const first = await get(); assert.equal(first.cache.state, 'download');
    assert.equal(first.cache.width, 1200); assert.equal(first.cache.height, 800);
    service = create(); connection = await service.run(configFor(dav)); dav.calls.length = 0;
    const second = await get(); assert.equal(second.cache.state, 'hit'); assert.equal(second.data, first.data);
    const dims = await service.run({ action: 'cache-dimensions', session: connection.session, paths: ['笔记.assets/测试图.png'] });
    assert.deepEqual(dims.images['/笔记.assets/测试图.png'], { width: 1200, height: 800 });
    assert.equal(dav.calls.length, 0);
    assert.ok(!(await readFile(path.join(directory, 'index.json'), 'utf8')).includes('secret'));
    await assert.rejects(service.run({ action: 'cache-dimensions', session: connection.session, paths: ['../secret'] }));
    await assert.rejects(service.run({ action: 'cache-status', session: 'other' }));
  } finally { await dav.close(); await rm(directory, { recursive: true, force: true }); }
});

test('expired images share paginated directory checks; only a changed file downloads', async () => {
  const directory = await temporary(), dav = await mockWebdav({ pageSize: 2 });
  let clock = 100000;
  dav.folders.add('a');
  for (const name of ['one', 'two', 'three']) dav.files.set(`a/${name}.png`, { data: png(), etag: name });
  try {
    const cache = createImageCache({ directory, now: () => clock });
    const service = createWebdavService({ imageCache: cache }), { session } = await service.run(configFor(dav));
    const get = name => service.run({ action: 'read', session, path: `a/${name}.png`, media: true });
    await Promise.all(['one', 'two', 'three'].map(get));
    dav.files.set('a/two.png', { data: png(50), etag: 'two-changed' });
    clock += 31 * 60000; dav.calls.length = 0;
    const images = await Promise.all(['one', 'two', 'three'].map(get));
    assert.deepEqual(images.map(image => image.cache.state), ['hit', 'download', 'hit']);
    assert.equal(dav.calls.filter(call => call.method === 'PROPFIND').length, 2);
    assert.deepEqual(dav.calls.filter(call => call.method === 'GET').map(call => call.path), ['a/two.png']);
    assert.ok(dav.calls.every(call => call.path === 'a' || call.path === 'a/two.png'));
  } finally { await dav.close(); await rm(directory, { recursive: true, force: true }); }
});

test('corruption refetches, account isolation holds, capacity settings persist, and clearing is cache-only', async () => {
  const directory = await temporary();
  try {
    const cache = createImageCache({ directory });
    let requests = 0;
    const remote = async () => { requests++; return { data: png(700000).toString('base64'), etag: 'v1', type: 'image/png' }; };
    const list = async () => ({ entries: [] });
    await cache.configure({ enabled: true, maxBytes: 1024 ** 2, checkInterval: 60000 });
    await cache.read(scope, '/a.png', remote, list);
    const other = createHash('sha256').update('other').digest('hex');
    await cache.read(other, '/a.png', remote, list);
    assert.equal(requests, 2); assert.equal((await cache.status()).count, 1);
    const index = JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8'));
    await writeFile(path.join(directory, index.entries[0][0] + '.bin'), 'broken');
    await cache.read(other, '/a.png', remote, list); assert.equal(requests, 3);
    const reopened = createImageCache({ directory });
    assert.equal((await reopened.status()).maxBytes, 1024 ** 2);
    await writeFile(path.join(directory, 'not-a-cache.txt'), 'keep');
    await reopened.clear(); assert.equal((await reopened.status()).bytes, 0);
    assert.equal(await readFile(path.join(directory, 'not-a-cache.txt'), 'utf8'), 'keep');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('offline stale bytes are labelled, denied access is not masked, writes invalidate pending reads', async () => {
  const directory = await temporary();
  let clock = 100000;
  try {
    const cache = createImageCache({ directory, now: () => clock });
    const remote = async () => ({ data: png().toString('base64'), etag: 'v1' });
    await cache.read(scope, '/a.png', remote, async () => ({ entries: [] }));
    clock += 31 * 60000;
    const stale = await cache.read(scope, '/a.png', remote, async () => { throw Object.assign(new Error('offline'), { status: 503 }); });
    assert.equal(stale.cache.state, 'stale'); assert.ok(stale.cache.warning);
    await assert.rejects(cache.read(scope, '/a.png', remote, async () => { throw Object.assign(new Error('denied'), { status: 403 }); }), error => error.status === 403);
    let release;
    const pending = cache.read(scope, '/pending.png', () => new Promise(resolve => { release = resolve; }), async () => ({ entries: [] }));
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await cache.invalidate(scope, '/pending.png'); release(await remote()); await pending;
    assert.deepEqual((await cache.dimensions(scope, ['/pending.png'])).images, {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an unwritable cache location does not prevent online image reads and reports the failure', async () => {
  const directory = await temporary();
  try {
    const file = path.join(directory, 'occupied'); await writeFile(file, 'not a directory');
    const cache = createImageCache({ directory: file });
    const image = await cache.read(scope, '/a.png', async () => ({ data: png().toString('base64'), etag: 'v1' }), async () => ({ entries: [] }));
    assert.equal(image.cache.state, 'download'); assert.ok(image.cache.warning); assert.equal(image.data, png().toString('base64'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
