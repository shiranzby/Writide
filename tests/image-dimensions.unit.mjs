import test from 'node:test';
import assert from 'node:assert/strict';
import { imageDimensions } from '../server/image-dimensions.mjs';

test('reads bounded dimensions from common web image headers', () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);

  const gif = Buffer.alloc(10);
  gif.write('GIF89a', 0, 'ascii');
  gif.writeUInt16LE(320, 6);
  gif.writeUInt16LE(200, 8);

  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  webp.write('VP8X', 12, 'ascii');
  webp.writeUIntLE(799, 24, 3);
  webp.writeUIntLE(599, 27, 3);

  assert.deepEqual(imageDimensions(png), { width: 640, height: 480 });
  assert.deepEqual(imageDimensions(gif), { width: 320, height: 200 });
  assert.deepEqual(imageDimensions(webp), { width: 800, height: 600 });
});

test('rejects unsupported and truncated input without scanning indefinitely', () => {
  assert.equal(imageDimensions(Buffer.from('not an image')), null);
  assert.equal(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff])), null);
  assert.equal(imageDimensions(Buffer.alloc(0)), null);
});
