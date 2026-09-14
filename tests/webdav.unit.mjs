import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebdavService, supportsConditionalEtag } from '../server/webdav-service.mjs';
import { mockWebdav } from './fixtures/webdav-server.mjs';
import { restoreWorkspaceFile, rememberWorkspace } from '../src/workspace-session.js';

test('real DAV protocol reads Unicode, writes conditionally and rejects conflicts and traversal', async () => {
  const dav = await mockWebdav();
  try {
    const service = createWebdavService();
    await assert.rejects(service.run({ action: 'connect', url: dav.url, username: 'wrong', password: 'secret' }));
    const { session } = await service.run({ action: 'connect', url: dav.url, username: 'writer', password: 'secret' });
    const run = (action, extra = {}) => service.run({ action, session, ...extra });
    assert.equal((await run('list')).entries[0].name, '说明.md');
    const read = await run('read', { path: '说明.md' });
    assert.equal(Buffer.from(read.data, 'base64').toString(), '# 远端文档\n\n原文');
    const content = Buffer.from('中文新内容\r\n').toString('base64');
    const saved = await run('write', { path: '说明.md', data: content, etag: read.etag });
    assert.ok(saved.etag);
    await assert.rejects(run('write', { path: '说明.md', data: content, etag: read.etag }), error => error.status === 412);
    await assert.rejects(run('write', { path: '说明.md', data: content, etag: '' }));
    await assert.rejects(run('read', { path: '../private' }));
    await run('mkdir', { path: '图片.assets' });
    await run('write', { path: '图片.assets/图.png', data: 'AQID', etag: null });
    assert.deepEqual(dav.files.get('图片.assets/图.png').data, Buffer.from([1, 2, 3]));
    await assert.rejects(run('write', { path: '图片.assets/图.png', data: 'BAUG', etag: null }));
    await run('disconnect');
    await assert.rejects(run('list'), error => error.status === 401);
  } finally { await dav.close(); }
});

test('conditional ETag accepts Nutstore opaque versions without weakening other providers', () => {
  assert.equal(supportsConditionalEtag('https://dav.jianguoyun.com/dav/Typora/', 'vu5yBJMNCTK83lmhe5dlKw'), true);
  assert.equal(supportsConditionalEtag('https://dav.jianguoyun.com/dav/Typora/', 'bad tag'), false);
  assert.equal(supportsConditionalEtag('https://example.test/dav/', 'vu5yBJMNCTK83lmhe5dlKw'), false);
  assert.equal(supportsConditionalEtag('https://example.test/dav/', '"standard"'), true);
  assert.equal(supportsConditionalEtag('https://example.test/dav/', ''), false);
});

test('startup restores last file by source path, missing file and workspace-only stay closed', () => {
  const data = new Map(), storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const workspace = { documents: [{ id: 'a', sourcePath: 'a.md' }, { id: 'b', sourcePath: '深/文档.md' }], folders: [], activeId: 'b' };
  rememberWorkspace({ kind: 'directory', id: 'd' }, workspace, storage);
  const previous = JSON.parse([...data.values()][0]);
  assert.equal(restoreWorkspaceFile({ ...workspace, activeId: 'a' }, 'last', previous).activeId, 'b');
  assert.equal(restoreWorkspaceFile(workspace, 'last-directory', previous).activeId, null);
  assert.equal(restoreWorkspaceFile({ ...workspace, documents: [workspace.documents[0]] }, 'last', previous).activeId, null);
});
