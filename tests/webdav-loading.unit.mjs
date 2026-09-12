import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebdavService } from '../server/webdav-service.mjs';
import { createDavTransport } from '../server/webdav-transport.mjs';
import { createDavTree } from '../src/webdav-tree.js';
import { mockWebdav } from './fixtures/webdav-server.mjs';

test('subdirectory connection reuses only authorized subtree credentials and never lists the vault root', async () => {
  const dav = await mockWebdav({ pageSize: 2 });
  dav.folders.add('typora'); dav.folders.add('typora/中文'); dav.folders.add('elsewhere');
  dav.files.set('typora/笔记.md', { data: Buffer.from('note'), etag: '"note"' });
  let saved;
  const credentials = { read: async () => saved, write: async value => { saved = value; } };
  try {
    const service = createWebdavService({ credentials });
    const root = await service.run({ action: 'connect', url: dav.url, username: 'writer', password: 'secret', remember: true });
    dav.calls.length = 0;
    const sub = await service.run({ action: 'connect', url: dav.url + 'typora', username: 'writer', password: '', remember: true });
    assert.equal(sub.url, dav.url + 'typora/');
    const file = await service.run({ action: 'read', session: sub.session, path: '笔记.md' });
    await service.run({ action: 'write', session: sub.session, path: '笔记.md', data: Buffer.from('edited').toString('base64'), etag: file.etag });
    assert.equal(dav.files.get('typora/笔记.md').data.toString(), 'edited');
    assert.ok(dav.calls.every(call => call.path.startsWith('typora')));
    await service.run({ action: 'forget-password' });
    assert.equal(saved, null);
    assert.equal((await service.run({ action: 'resume', session: sub.session, url: sub.url, username: 'writer', automatic: false })).session, sub.session);
    await assert.rejects(service.run({ action: 'resume', session: sub.session, url: sub.url, username: 'writer', automatic: true }));
    const nested = await service.run({ action: 'connect', session: sub.session, url: sub.url + '中文', username: 'writer', password: '' });
    assert.equal(new URL(nested.url).pathname, '/dav/typora/%E4%B8%AD%E6%96%87/');
    await assert.rejects(service.run({ action: 'connect', session: sub.session, url: dav.url + 'elsewhere', username: 'writer', password: '' }));
    await service.run({ action: 'read', session: root.session, path: '说明.md' });
  } finally { await dav.close(); }
});

test('slow image response headers overlap but a late success does not erase concurrent cooldown', async () => {
  const pending = [];
  const request = createDavTransport({ fetcher: () => new Promise(resolve => pending.push(resolve)) });
  const a = request('http://dav.invalid/a');
  const b = request('http://dav.invalid/b');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[0](new Response(null, { status: 503, headers: { 'Retry-After': '60' } }));
  await assert.rejects(a, error => error.status === 503);
  pending[1](new Response(null)); await b;
  await assert.rejects(request('http://dav.invalid/c'), error => error.status === 503);
  assert.equal(pending.length, 2);
});

test('750-entry pages follow Link, reuse pages and only enumerate the requested level', async () => {
  const dav = await mockWebdav({ pageSize: 750 });
  for (let i = 0; i < 800; i++) dav.files.set(`文件${i}.md`, { data: Buffer.from('body'), etag: '"v1"' });
  dav.folders.add('一级'); dav.folders.add('一级/二级'); dav.folders.add('一级/二级/三级');
  dav.files.set('一级/二级/三级/末页.md', { data: Buffer.from('deep'), etag: '"deep"' });
  try {
    const service = createWebdavService();
    const { session } = await service.run({ action: 'connect', url: dav.url, username: 'writer', password: 'secret' });
    const tree = createDavTree({ readDirectoryPage: (path, cursor) => service.run({ action: 'list', session, path, cursor }) }, (kind, path) => kind + path);
    await tree.load();
    assert.equal(tree.workspace.documents.length, 801);
    assert.equal(dav.calls.length, 2);
    assert.ok(dav.calls[1].query.includes('offset=750'));
    assert.equal(dav.calls.some(call => call.method === 'GET'), false);
    await tree.prefetch();
    assert.deepEqual(tree.workspace.folders.map(folder => folder.sourcePath), ['一级', '一级/二级']);
    const before = dav.calls.length;
    await tree.load('一级', 'folder一级');
    assert.equal(dav.calls.length, before);
    await tree.prefetch('folder一级');
    assert.ok(tree.workspace.folders.some(folder => folder.sourcePath === '一级/二级/三级'));
    assert.equal(dav.calls.some(call => call.path === '一级/二级/三级'), false);
    await tree.restorePath('一级/二级/三级/末页.md');
    assert.ok(tree.workspace.documents.some(doc => doc.sourcePath === '一级/二级/三级/末页.md'));
  } finally { await dav.close(); }
});

test('pagination rejects cross-origin, sibling directory and repeating continuation without sending credentials', async () => {
  for (const link of ['https://evil.invalid/dav/?page=2', '/dav/other/?page=2', '/dav/']) {
    const dav = await mockWebdav({ pageSize: 1, nextLink: () => link });
    try {
      const service = createWebdavService();
      await assert.rejects(service.run({ action: 'connect', url: dav.url, username: 'writer', password: 'secret' }), /分页/);
      assert.equal(dav.calls.length, 1);
    } finally { await dav.close(); }
  }
});

test('image reads share an account cache, bypass directory stat, invalidate after conditional write', async () => {
  const dav = await mockWebdav();
  dav.files.set('图.png', { data: Buffer.from([1, 2, 3]), etag: '"img"' });
  try {
    const service = createWebdavService(), config = { action: 'connect', url: dav.url, username: 'writer', password: 'secret' };
    const first = await service.run(config), second = await service.run(config);
    const read = session => service.run({ action: 'read', session, path: '图.png', media: true });
    assert.equal((await read(first.session)).data, 'AQID');
    assert.equal((await read(second.session)).data, 'AQID');
    assert.equal(dav.calls.filter(call => call.method === 'GET').length, 1);
    assert.equal(dav.calls.some(call => call.method === 'PROPFIND' && call.path === '图.png'), false);
    await service.run({ action: 'write', session: first.session, path: '图.png', data: 'BAUG', etag: '"img"' });
    assert.equal((await read(second.session)).data, 'BAUG');
  } finally { await dav.close(); }
});

test('rolling free-account budget halts image bursts but reserves conditional writes and limits speculation', async () => {
  let clock = 0, calls = 0;
  const request = createDavTransport({ now: () => clock, sleep: async ms => { clock += ms; }, fetcher: async (_url, options) => {
    assert.equal(new Headers(options.headers).has('x-paper-dav-work'), false);
    calls++; return new Response(null, { status: 200 });
  } });
  const url = 'https://dav.jianguoyun.com/dav/';
  for (let i = 0; i < 60; i++) await request(url, { method: 'PROPFIND', headers: { 'X-Paper-Dav-Work': 'prefetch' } });
  await assert.rejects(request(url, { headers: { 'X-Paper-Dav-Work': 'prefetch' } }), error => error.status === 429);
  for (let i = 60; i < 480; i++) await request(url);
  for (let i = 0; i < 120; i++) await assert.rejects(request(url), error => error.status === 429);
  assert.equal(calls, 480);
  await request(url, { method: 'PUT' });
  await request(url, { headers: { 'X-Paper-Dav-Work': 'write' } });
  assert.equal(calls, 482);
  clock += 1800000;
  await request(url);
  assert.equal(calls, 483);
});
