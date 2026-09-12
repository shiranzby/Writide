import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebdavService } from '../server/webdav-service.mjs';
import { mockWebdav } from './fixtures/webdav-server.mjs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { writeWorkspaceFile } from '../server/workspace-file-write.mjs';

test('server rename destination rejects collisions while the original stays intact', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'writide-rename-'));
  try {
    const original = path.join(directory, 'original.md'), occupied = path.join(directory, 'occupied.md');
    await writeFile(original, '# Original\r\n'); await writeFile(occupied, 'keep');
    await assert.rejects(writeWorkspaceFile(occupied, '# Original\r\n', true), /已存在/);
    assert.equal(await readFile(original, 'utf8'), '# Original\r\n'); assert.equal(await readFile(occupied, 'utf8'), 'keep');
    const target = path.join(directory, 'new.md'); await writeWorkspaceFile(target, '# Original\r\n', true);
    assert.equal(await readFile(target, 'utf8'), '# Original\r\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('DAV document rename uses conditional non-overwriting MOVE and preserves Markdown bytes', async () => {
  const dav = await mockWebdav();
  const content = '# 原文\r\n\r\n![图片](./原文.assets/image.png)\r\n';
  dav.files.set('原文.md', { data: Buffer.from(content), etag: '"original"' });
  dav.files.set('occupied.md', { data: Buffer.from('keep'), etag: '"keep"' });
  try {
    const service = createWebdavService();
    const { session } = await service.run({ action: 'connect', url: dav.url, username: 'writer', password: 'secret' });
    const move = destination => service.run({ action: 'rename', session, path: '原文.md', destination, content, etag: '"original"' });
    await assert.rejects(move('occupied.md'), error => error.status === 412);
    assert.equal(dav.files.get('occupied.md').data.toString(), 'keep');
    await assert.rejects(move('../outside.md'), /超出/);
    await assert.rejects(move('other/renamed.md'), /同一目录/);
    dav.files.set('原文.md', { data: Buffer.from('external'), etag: '"changed"' });
    await assert.rejects(move('new.md'), error => error.status === 412);
    assert.equal(dav.files.get('原文.md').data.toString(), 'external');
    dav.files.set('原文.md', { data: Buffer.from(content), etag: '"original"' });
    const result = await move('新名称.md');
    assert.equal(result.path, '新名称.md'); assert.equal(result.changed, false);
    assert.equal(dav.files.has('原文.md'), false);
    assert.equal(dav.files.get('新名称.md').data.toString(), content);
    assert.ok(dav.calls.filter(call => call.method === 'MOVE').every(call => call.overwrite === 'F' && call.match === '"original"'));
    assert.equal(dav.calls.some(call => call.method === 'PUT' || call.method === 'DELETE'), false);
  } finally { await dav.close(); }
});
