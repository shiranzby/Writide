import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
function launch(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/start-server.mjs', '--no-browser'], {
      cwd: root, env: { ...process.env, PORT: String(port) }, windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}
test('invalid ports fail immediately without starting a server', async () => {
  const result = await launch('not-a-port');
  assert.equal(result.code, 1); assert.match(result.output, /PORT must/);
});
for (const same of [false, true]) test(`existing listener is ${same ? 'reused for this checkout' : 'not mistaken for Writide'}`, async () => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ app: same ? 'Writide' : 'other', instance: createHash('sha256').update(root).digest('hex') }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await launch(server.address().port);
    assert.equal(result.code, same ? 0 : 1);
    assert.match(result.output, same ? /already running/ : /occupied/);
    assert.equal(server.listening, true);
    assert.doesNotMatch(result.output, /Starting server;/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
