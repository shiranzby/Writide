import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanMarkdownBlocks, blockSourceRange } from '../src/markdown-model.js';

for (const newline of ['\n', '\r\n']) {
  test(`quoted fence keeps exact source ranges (${JSON.stringify(newline)})`, () => {
    const body = '> > ```js\n> > first()\n> >   nested()\n> > ```'.replaceAll('\n', newline);
    const source = `> before${newline}${body}${newline}> after${newline}${newline}tail`;
    const blocks = scanMarkdownBlocks(source);
    assert.deepEqual(blocks.map(block => block.type), ['structured', 'code', 'structured', 'blank', 'paragraph']);
    assert.equal(blocks[1].closed, true);
    assert.equal(blocks[1].language, 'js');
    assert.equal(blocks[1].sourceText, body + newline);
    assert.equal(blockSourceRange(blocks[1], source).sourceText, `> > first()${newline}> >   nested()`);
    assert.equal(blocks.map(block => block.sourceText).join(''), source);
  });
}

test('unclosed quoted fence stops at the end of its quote container', () => {
  const source = '> ```js\n> code\n\noutside\n\n```txt\nother\n```';
  const blocks = scanMarkdownBlocks(source);
  assert.deepEqual(blocks.map(block => block.type), ['code', 'blank', 'paragraph', 'blank', 'code']);
  assert.equal(blocks[0].closed, false);
  assert.equal(blocks[0].sourceText, '> ```js\n> code\n');
  assert.equal(blocks[4].closed, true);
  assert.equal(blocks.map(block => block.sourceText).join(''), source);
});

for (const [opening, closing] of [['$$', '$$'], ['\\[', '\\]'], ['\\begin{align*}', '\\end{align*}']]) {
  test(`quoted math ${opening} preserves CRLF and empty body lines`, () => {
    const body = `> > ${opening}\r\n> > x > 1\r\n> > \r\n> > y = 2\r\n> > ${closing}\r\n`;
    const source = '> before\r\n' + body + '> after';
    const blocks = scanMarkdownBlocks(source);
    assert.deepEqual(blocks.map(block => block.type), ['structured', 'math', 'structured']);
    assert.equal(blocks[1].closed, true);
    assert.equal(blocks[1].quoteDepth, 2);
    assert.equal(blocks[1].sourceText, body);
    assert.equal(blockSourceRange(blocks[1], source).sourceText, '> > x > 1\r\n> > \r\n> > y = 2');
    assert.equal(blocks.map(block => block.sourceText).join(''), source);
    const unclosed = scanMarkdownBlocks(`> ${opening}\n> x\n\noutside\n${closing}`);
    assert.equal(unclosed[0].type, 'math');
    assert.equal(unclosed[0].closed, false);
    assert.equal(unclosed[0].sourceText, `> ${opening}\n> x\n`);
  });
}

for (const newline of ['\n', '\r\n']) {
  for (const [type, body] of [
    ['code', '  ```js\n  first\n  second\n  ```'],
    ['math', '  $$\n  x^2\n  $$'],
    ['table', '  | a | b |\n  | --- | --- |\n  | c | d |'],
  ]) test(`${type} directly after a list is a separate source range (${JSON.stringify(newline)})`, () => {
    const source = `- item\n${body}\n- sibling\n\ntail`.replaceAll('\n', newline);
    const blocks = scanMarkdownBlocks(source);
    assert.deepEqual(blocks.map(block => block.type), ['structured', type, 'structured', 'blank', 'paragraph']);
    assert.equal(blocks[1].sourceText, body.replaceAll('\n', newline) + newline);
    assert.equal(blocks.map(block => block.sourceText).join(''), source);
    if (type !== 'table') {
      assert.equal(blocks[1].closed, true);
      assert.equal(blockSourceRange(blocks[1], source).sourceText, body.split('\n').slice(1, -1).join(newline));
    }
  });
}
