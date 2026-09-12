import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { saveDirectoryImage } from '../src/markdown-image-files.js';

test('nested mapped image is byte-identical in document assets and never overwrites a prior image', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'typora-image-test-'));
  const folder = location => ({
    getDirectoryHandle: async (name, options = {}) => {
      const next = path.join(location, name);
      if (options.create) await mkdir(next, { recursive: true });
      return folder(next);
    },
    getFileHandle: async name => ({ createWritable: async () => {
      let bytes;
      return { write: async blob => { bytes = Buffer.from(await blob.arrayBuffer()); },
        close: () => writeFile(path.join(location, name), bytes, { flag: 'wx' }) };
    } }),
  });
  try {
    await mkdir(path.join(root, 'notes'));
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 128]);
    const image = new Blob([bytes], { type: 'image/png' });
    const first = await saveDirectoryImage(folder(root), 'notes/document.md', image);
    const second = await saveDirectoryImage(folder(root), 'notes/document.md', image);
    assert.match(first, /^\.\/document\.assets\/image-.*\.png$/);
    assert.notEqual(first, second);
    assert.deepEqual(await readFile(path.resolve(root, 'notes', first)), Buffer.from(bytes));
    assert.deepEqual(await readFile(path.resolve(root, 'notes', second)), Buffer.from(bytes));
    await assert.rejects(saveDirectoryImage(folder(root), '../outside.md', image));
  } finally {
    // Only remove the exact directory returned by mkdtemp.
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});

test('failed directory writes surface an error rather than returning an embedded URI', async () => {
  const root = { getDirectoryHandle: async () => { throw new DOMException('Denied', 'NotAllowedError'); } };
  await assert.rejects(saveDirectoryImage(root, 'note.md', new Blob(['image'], { type: 'image/png' })), /Denied/);
});
