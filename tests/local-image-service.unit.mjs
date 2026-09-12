import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalImageService } from '../server/local-image-service.mjs';

test('scoped image rename changes the real file, preserves bytes and rejects collisions/traversal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-image-service-'));
  try {
    await mkdir(path.join(root, 'doc.assets'));
    const content = 'before\r\n\r\n![pic](./doc.assets/original.png)\r\n';
    await writeFile(path.join(root, 'doc.md'), content);
    const bytes = Buffer.from([137, 80, 78, 71, 0, 1, 255]);
    await writeFile(path.join(root, 'doc.assets/original.png'), bytes);
    let revealed;
    const service = createLocalImageService({ workspaceRoot: root, reveal: file => { revealed = file; } });
    await assert.rejects(service.grant({ rootPath: root, documentPath: '../other.md', expectedContent: content }));
    await assert.rejects(service.grant({ rootPath: root, documentPath: 'doc.md', expectedContent: 'wrong' }));
    const { grantId } = await service.grant({ rootPath: root, documentPath: 'doc.md', expectedContent: content });
    await assert.rejects(service.run({ grantId: 'bad', action: 'rename', href: './doc.assets/original.png', newName: 'x.png' }));
    await assert.rejects(service.run({ grantId, action: 'rename', href: '../outside.png', newName: 'x.png' }));
    await assert.rejects(service.run({ grantId, action: 'rename', href: './doc.assets/original.png', newName: '../x.png' }));
    await assert.rejects(service.run({ grantId, action: 'rename', href: './doc.assets/original.png', newName: 'x.exe' }));
    await service.run({ grantId, action: 'reveal', href: './doc.assets/original.png' });
    assert.equal(revealed, await realpath(path.join(root, 'doc.assets/original.png')));
    await writeFile(path.join(root, 'doc.assets/taken.png'), 'keep');
    await assert.rejects(service.run({ grantId, action: 'rename', href: './doc.assets/original.png', newName: 'taken.png' }), { code: 'EEXIST' });
    assert.equal(await readFile(path.join(root, 'doc.assets/taken.png'), 'utf8'), 'keep');
    const result = await service.run({ grantId, action: 'rename', href: './doc.assets/original.png', newName: 'new image.png' });
    assert.equal(result.href, './doc.assets/new%20image.png');
    assert.deepEqual(await readFile(path.join(root, 'doc.assets/new image.png')), bytes);
    await assert.rejects(stat(path.join(root, 'doc.assets/original.png')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(root, 'doc.md'), 'utf8'), content);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});
