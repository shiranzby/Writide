import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameDirectoryImage } from '../src/markdown-image-files.js';

function directory(files, failDelete = false, failWrite = false) {
  return {
    queryPermission: async () => 'granted',
    getDirectoryHandle: async () => directory(files, failDelete, failWrite),
    getFileHandle: async (name, options = {}) => {
      if (!files.has(name) && !options.create) throw new DOMException('Missing', 'NotFoundError');
      if (!files.has(name)) files.set(name, new Blob([]));
      return { getFile: async () => files.get(name), createWritable: async () => {
        let next;
        return { write: async data => { if (failWrite) throw new Error('Write failed'); next = data; }, close: async () => files.set(name, next) };
      } };
    },
    removeEntry: async name => { if (failDelete && name === 'old.png') throw new Error('Delete denied'); files.delete(name); },
  };
}

test('authorized handle renames Unicode image, preserves bytes and can roll back without any absolute path', async () => {
  const image = new Blob([new Uint8Array([0, 255, 128, 1])]);
  const files = new Map([['原 图.png', image]]);
  const result = await renameDirectoryImage(directory(files), 'notes/note.md', '../assets/%E5%8E%9F%20%E5%9B%BE.png', '新图.png');
  assert.equal(files.has('原 图.png'), false);
  assert.deepEqual(await files.get('新图.png').arrayBuffer(), await image.arrayBuffer());
  assert.equal(result.href, '../assets/%E6%96%B0%E5%9B%BE.png');
  await result.rollback();
  assert.equal(files.get('原 图.png'), image);
  assert.equal(files.has('新图.png'), false);
});

test('the same byte-preserving rename path keeps an original Markdown file on write failure', async () => {
  const source = new Blob(['# note\r\n![image](./old.assets/a.png)\r\n']);
  const files = new Map([['old.md', source]]);
  await assert.rejects(renameDirectoryImage(directory(files, false, true), 'old.md', './old.md', 'new.md'), /Write failed/);
  assert.equal(files.get('old.md'), source); assert.equal(files.has('new.md'), false);
  await renameDirectoryImage(directory(files), 'old.md', './old.md', 'new.md');
  assert.equal(await files.get('new.md').text(), await source.text()); assert.equal(files.has('old.md'), false);
});

test('source or destination changed during a copy is not deleted', async () => {
  for (const changed of ['old.md', 'new.md']) {
    const files = new Map([['old.md', new Blob(['original'])]]);
    const root = directory(files), base = root.getFileHandle;
    root.getFileHandle = async (...args) => {
      const handle = await base(...args);
      if (args[0] === 'new.md' && args[1]?.create) {
        const writable = handle.createWritable;
        handle.createWritable = async () => {
          const writer = await writable(), close = writer.close;
          writer.close = async () => { await close(); files.set(changed, new Blob(['external change'])); };
          return writer;
        };
      }
      return handle;
    };
    await assert.rejects(renameDirectoryImage(root, 'old.md', './old.md', 'new.md'), /已变化/);
    assert.equal(await files.get(changed).text(), 'external change');
    assert.ok(files.has('old.md'));
  }
});

test('rename refuses existing target and out-of-root paths; failed delete retains original and cleans new file', async () => {
  const original = new Blob(['old']);
  const files = new Map([['old.png', original], ['occupied.png', new Blob(['keep'])]]);
  await assert.rejects(renameDirectoryImage(directory(files), 'note.md', './old.png', 'occupied.png'), /同名/);
  await assert.rejects(renameDirectoryImage(directory(files), 'note.md', '../old.png', 'new.png'), /超出/);
  await assert.rejects(renameDirectoryImage(directory(files, true), 'note.md', './old.png', 'new.png'), /Delete denied/);
  assert.equal(files.get('old.png'), original);
  assert.equal(files.has('new.png'), false);
  assert.equal(await files.get('occupied.png').text(), 'keep');
});
