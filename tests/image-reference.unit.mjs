import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageReferenceReplacement as replace } from '../src/markdown-image-reference.js';

test('Unicode destination matches encoded preview without touching alt or title', () => {
  const source = '![./教程.assets/原图.png](./教程.assets/原图.png "原图.png")';
  assert.equal(replace(source, './%E6%95%99%E7%A8%8B.assets/%E5%8E%9F%E5%9B%BE.png', './教程.assets/新图.png'),
    '![./教程.assets/原图.png](./教程.assets/新图.png "原图.png")');
});
test('angled, escaped and HTML destinations preserve unrelated source', () => {
  assert.equal(replace('![x](<./a b.png>)', './a%20b.png', './new.png'), '![x](<./new.png>)');
  assert.equal(replace('![x](./a\\(b\\).png)', './a(b).png', './new.png'), '![x](./new.png)');
  assert.equal(replace('<img alt="src=\'fake.png\'" data-src="fake.png" src="./教程.assets/a&amp;b.png" style="zoom:50%" />',
    './%E6%95%99%E7%A8%8B.assets/a&b.png', './教程.assets/new.png'),
    '<img alt="src=\'fake.png\'" data-src="fake.png" src="./教程.assets/new.png" style="zoom:50%" />');
});
test('mismatched and non-image source fail closed', () => {
  assert.equal(replace('![x](./a.png)', './b.png', './new.png'), null);
  assert.equal(replace('text ./a.png', './a.png', './new.png'), null);
});

test('renames write readable Unicode but preserve reserved URL escapes', () => {
  const href = './' + encodeURIComponent('临时测试.assets') + '/' + encodeURIComponent('测试图片1#%20.png');
  assert.equal(replace('![](./old.png)', './old.png', href), '![](./临时测试.assets/测试图片1%23%2520.png)');
  assert.equal(replace('<img src="./old.png" style="zoom:50%;" />', './old.png', href),
    '<img src="./临时测试.assets/测试图片1%23%2520.png" style="zoom:50%;" />');
});
