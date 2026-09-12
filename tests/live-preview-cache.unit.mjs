import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { liveMarkdownPreview } from '../src/markdown-live-preview.js';

test('same-line caret moves reuse decorations while range, line and text changes update', () => {
  let preparations = 0;
  const extension = liveMarkdownPreview({ render: text => text, prepareRender: () => { preparations++; return {}; } });
  const field = extension[0];
  let state = EditorState.create({ doc: 'first **bold**\n\n> - second', extensions: [markdown(), extension] });
  const initial = state.field(field).decorations;
  state = state.update({ selection: { anchor: 2 } }).state;
  assert.equal(state.field(field).decorations, initial);
  state = state.update({ selection: { anchor: 2, head: 5 } }).state;
  assert.notEqual(state.field(field).decorations, initial);
  const ranged = state.field(field).decorations;
  state = state.update({ selection: { anchor: state.doc.length } }).state;
  assert.notEqual(state.field(field).decorations, ranged);
  assert.equal(preparations, 1);
  const unchanged = state.field(field).decorations;
  state = state.update({ changes: { from: state.doc.length, insert: ' new' } }).state;
  assert.notEqual(state.field(field).decorations, unchanged);
  assert.equal(preparations, 2);
  assert.equal(state.doc.toString(), 'first **bold**\n\n> - second new');
});

test('unmodified block render cache survives edits but reference changes invalidate it', () => {
  let renders = 0;
  const extension = liveMarkdownPreview({
    render: text => { renders++; return text; },
    prepareRender: source => ({ references: { DOC: { href: source.includes('changed') ? '/changed' : '/initial' } } }),
  });
  let state = EditorState.create({ doc: 'text\n\n```js\nconst a = 1;\n```', extensions: [markdown(), extension] });
  const first = renders;
  assert.ok(first > 0);
  state = state.update({ changes: { from: 0, insert: 'x' } }).state;
  assert.equal(renders, first);
  state = state.update({ changes: { from: 0, insert: 'changed' } }).state;
  assert.ok(renders > first);
});
