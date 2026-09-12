import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { inlineFormatTransaction } from '../src/markdown-inline-format.js';

for (const [name, source, from, to, command, expected] of [
  ['mixed bold', '**one** two', 0, 11, 'bold', '**one two**'],
  ['remove bold', '**one**', 2, 5, 'bold', 'one'],
  ['partial bold', '**abcdef**', 4, 6, 'bold', '**ab**cd**ef**'],
  ['keep italic', '**one *two*** three', 0, 19, 'bold', '**one *two* three**'],
  ['remove italic', '*one*', 1, 4, 'italic', 'one'],
  ['mixed strike', '~~one~~ two', 0, 11, 'strike', '~~one two~~'],
  ['remove underline', '<u>one</u>', 3, 6, 'underline', 'one'],
  ['merge underline', '<u>one</u> two', 0, 14, 'underline', '<u>one two</u>'],
  ['remove inline code', '`one`', 1, 4, 'inline-code', 'one'],
  ['paragraph boundaries', 'one\n\ntwo', 0, 8, 'bold', '**one**\n\n**two**'],
  ['edge spaces', ' one ', 0, 5, 'bold', ' **one** '],
  ['keep inline code', 'one `two`', 0, 9, 'bold', '**one `two`**'],
  ['list markers are not bold', '- one\n- two', 0, 11, 'bold', '- **one**\n- **two**'],
  ['quote markers are not italic', '> one\n> two', 0, 11, 'italic', '> *one*\n> *two*'],
  ['heading markers are not bold', '# one\n\n## two', 0, 13, 'bold', '# **one**\n\n## **two**'],
  ['task marker stays structural', '- [x] one', 0, 9, 'bold', '- [x] **one**'],
  ['mixed list bold merges', '- **one** two\n- three', 0, 21, 'bold', '- **one two**\n- **three**'],
]) {
  test(name, () => {
    const state = EditorState.create({ doc: source, selection: { anchor: from, head: to }, extensions: [markdown()] });
    const transaction = inlineFormatTransaction(state, command);
    assert.ok(transaction);
    assert.equal(state.update(transaction).state.doc.toString(), expected);
  });
}

for (const command of ['bold', 'italic', 'strike', 'underline', 'inline-code']) {
  test(`${command} toggles twice across nested structures without changing markers`, () => {
    const source = '# title\n\n> - [x] first\n>   - second\n\n1. third';
    let state = EditorState.create({ doc: source, selection: { anchor: 0, head: source.length } });
    const first = inlineFormatTransaction(state, command);
    assert.ok(first);
    state = state.update(first).state;
    state = state.update({ selection: { anchor: 0, head: state.doc.length } }).state;
    const second = inlineFormatTransaction(state, command);
    assert.ok(second);
    assert.equal(state.update(second).state.doc.toString(), source);
  });
}
