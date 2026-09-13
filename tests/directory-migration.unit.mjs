import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateDirectoryEntry, planDirectoryMoves, migrateDocumentWithAssets, documentAssetMoves } from '../src/directory-migration.js';

function filesystem(initial, hooks = {}) {
  const files = new Map(Object.entries(initial).map(([path, value]) => [path, new Blob([value])]));
  const dirs = new Set(['', 'old/empty']);
  for (const path of files.keys()) {
    const names = path.split('/'); names.pop();
    while (names.length) { dirs.add(names.join('/')); names.pop(); }
  }
  const missing = () => { throw new DOMException('missing', 'NotFoundError'); };
  const file = path => ({ kind: 'file', getFile: async () => files.get(path) || missing(), createWritable: async () => {
    let next;
    return { write: async blob => { await hooks.write?.(path); next = blob; }, abort: async () => {},
      close: async () => { files.set(path, next); await hooks.close?.(path, files, dirs); } };
  } });
  const dir = path => ({ kind: 'directory',
    entries: async function* () {
      const prefix = path ? path + '/' : '';
      for (const value of dirs) if (value.startsWith(prefix) && value !== path && !value.slice(prefix.length).includes('/')) yield [value.slice(prefix.length), dir(value)];
      for (const value of files.keys()) if (value.startsWith(prefix) && !value.slice(prefix.length).includes('/')) yield [value.slice(prefix.length), file(value)];
    },
    getDirectoryHandle: async (name, options = {}) => {
      const next = path ? path + '/' + name : name;
      if (files.has(next)) throw new Error('file exists');
      if (!dirs.has(next) && !options.create) missing();
      dirs.add(next); return dir(next);
    },
    getFileHandle: async (name, options = {}) => {
      const next = path ? path + '/' + name : name;
      if (dirs.has(next)) throw new Error('directory exists');
      if (!files.has(next) && !options.create) missing();
      if (!files.has(next)) files.set(next, new Blob([]));
      return file(next);
    },
    removeEntry: async (name, options = {}) => {
      assert.notEqual(options.recursive, true, 'migration must never recursively delete');
      const next = path ? path + '/' + name : name;
      await hooks.remove?.(next, files, dirs);
      if (files.delete(next)) return;
      if ([...files.keys(), ...dirs].some(key => key.startsWith(next + '/'))) throw new Error('not empty');
      dirs.delete(next);
    },
  });
  return { root: dir(''), files, dirs };
}

const original = { 'old/note.md': '# 原文\r\n![图](./note.assets/a.png)\r\n',
  'old/note.assets/a.png': new Uint8Array([0, 255, 3, 128]), 'old/.hidden': 'hidden', 'old/nested/other.bin': 'attachment' };
const move = { from: 'old', to: 'new', kind: 'directory' };

test('document transfer copies verified shared assets before removing the source document', async () => {
  const fs = filesystem(original); fs.dirs.add('archive');
  await migrateDocumentWithAssets(fs.root, { from: 'old/note.md', to: 'archive/note.md', kind: 'file' }, [{ src: './note.assets/a.png' }]);
  assert.equal(fs.files.has('old/note.md'), false);
  assert.equal(await fs.files.get('archive/note.md').text(), original['old/note.md']);
  assert.deepEqual(await fs.files.get('archive/note.assets/a.png').arrayBuffer(), await fs.files.get('old/note.assets/a.png').arrayBuffer());
});

test('attachment failure preserves source document and collisions are not overwritten', async () => {
  const fs = filesystem(original, { write: path => { if (path.endsWith('a.png')) throw new Error('full'); } }); fs.dirs.add('archive');
  await assert.rejects(migrateDocumentWithAssets(fs.root, { from: 'old/note.md', to: 'archive/note.md', kind: 'file' }, [{ src: './note.assets/a.png' }]));
  assert.ok(fs.files.has('old/note.md')); assert.equal(fs.files.has('archive/note.md'), false);
  assert.throws(() => documentAssetMoves('old/a.md', 'archive/a.md', [{ src: '../shared/x.png' }]));
});

test('folder migration preserves binary assets, hidden files, empty directories and CRLF', async () => {
  const fs = filesystem(original);
  const before = new Map(fs.files);
  assert.deepEqual(await migrateDirectoryEntry(fs.root, move), { retained: [] });
  assert.equal(fs.dirs.has('old'), false); assert.ok(fs.dirs.has('new/empty'));
  for (const [path, bytes] of before) {
    assert.equal(fs.files.has(path), false);
    assert.deepEqual(await fs.files.get(path.replace(/^old/, 'new')).arrayBuffer(), await bytes.arrayBuffer());
  }
});

test('write failure and destination collision do not delete any original', async () => {
  for (const collision of [true, false]) {
    const fs = filesystem({ ...original, ...(collision ? { 'new/keep.bin': 'keep' } : {}) }, {
      write: path => { if (!collision && path.endsWith('a.png')) throw new Error('disk full'); },
    });
    await assert.rejects(migrateDirectoryEntry(fs.root, move), collision ? /已存在/ : /原路径未删除/);
    for (const path of Object.keys(original)) assert.ok(fs.files.has(path));
    if (collision) assert.equal(await fs.files.get('new/keep.bin').text(), 'keep');
  }
});

test('external changes while copying preserve both source and destination', async () => {
  for (const target of ['old/note.md', 'new/note.md', 'old/new.bin']) {
    const fs = filesystem(original, { close: (path, files) => {
      if (path.endsWith('other.bin')) files.set(target, new Blob(['external']));
    } });
    await assert.rejects(migrateDirectoryEntry(fs.root, move), /已变化/);
    assert.equal(await fs.files.get(target).text(), 'external');
    for (const path of Object.keys(original)) assert.ok(fs.files.has(path));
  }
});

test('cleanup failure keeps a verified destination and reports retained source', async () => {
  const fs = filesystem(original, { remove: path => { if (path.endsWith('a.png')) throw new Error('denied'); } });
  const result = await migrateDirectoryEntry(fs.root, move);
  assert.ok(result.retained.length); assert.ok(fs.files.has('old/note.assets/a.png'));
  assert.ok(fs.files.has('new/note.assets/a.png')); assert.ok(fs.files.has('new/note.md'));
});

test('move plans collapse descendants and reject self moves or mixed descendant relocation', () => {
  const snapshot = new Map([['folder', { type: 'folder', path: 'old' }], ['doc', { type: 'document', path: 'old/note.md' }]]);
  const layout = { folders: [{ id: 'folder', relativePath: 'new' }], documents: [{ id: 'doc', relativePath: 'new/note.md' }] };
  assert.deepEqual(planDirectoryMoves(layout, snapshot), [move]);
  layout.documents[0].relativePath = 'elsewhere/note.md';
  assert.throws(() => planDirectoryMoves(layout, snapshot), /分步/);
  assert.throws(() => planDirectoryMoves({ folders: [{ id: 'folder', relativePath: 'old/child' }], documents: [] }, snapshot), /自身/);
  assert.throws(() => planDirectoryMoves({ folders: [{ id: 'folder', relativePath: '../escape' }], documents: [] }, snapshot), /授权目录/);
});

test('standalone document move also copies and verifies before deleting', async () => {
  const fs = filesystem(original);
  await migrateDirectoryEntry(fs.root, { from: 'old/note.md', to: 'new.md', kind: 'file' });
  assert.equal(await fs.files.get('new.md').text(), original['old/note.md']);
  assert.ok(fs.files.has('old/note.assets/a.png'));
});
