import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { productionAccess } from '../server/production-http.mjs';

test('production has deployable defaults and rejects invalid explicit security settings', async () => {
  const access = productionAccess({});
  assert.deepEqual(access.status(), { username: 'admin', minLength: 8, usingDefaultPassword: true, fixedOrigin: null });
  const authorization = 'Basic ' + Buffer.from('admin:password').toString('base64');
  const response = () => ({ status: 0, setHeader() {}, writeHead(status) { this.status = status; }, end() {} });
  assert.equal(access({ headers: { host: 'writide:5173', origin: 'https://notes.example', 'sec-fetch-site': 'same-origin', authorization } }, response()), true);
  const crossSite = response();
  assert.equal(access({ headers: { host: 'writide:5173', origin: 'https://other.example', 'sec-fetch-site': 'cross-site', authorization } }, crossSite), false);
  assert.equal(crossSite.status, 403);
  const fixed = productionAccess({ WRITIDE_ORIGIN: 'https://notes.example' });
  assert.equal(fixed({ headers: { host: 'writide:5173', 'x-forwarded-host': 'notes.example', origin: 'https://notes.example', authorization } }, response()), true);
  assert.throws(() => productionAccess({ WRITIDE_ORIGIN: 'http://localhost/path', WRITIDE_PASSWORD: randomUUID() }));
  assert.throws(() => productionAccess({ WRITIDE_PASSWORD: 'short' }));
  let persisted;
  await access.changePassword('new-password', async state => { persisted = state; });
  assert.equal(persisted.username, 'admin');
  assert.doesNotMatch(JSON.stringify(persisted), /new-password/);
  const restored = productionAccess({});
  assert.equal(restored.restore(persisted), true);
  assert.equal(restored.status().usingDefaultPassword, false);
});

test('production serves built assets, protects APIs and uses only the configured data directory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'writide-container-'));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`, password = randomUUID();
  const authorization = 'Basic ' + Buffer.from(`admin:${password}`).toString('base64');
  let child;
  try {
    await mkdir(path.join(directory, 'Workspace'));
    await writeFile(path.join(directory, 'Workspace', 'sample.md'), '# container fixture\r\n');
    child = spawn(process.execPath, ['server.mjs'], { windowsHide: true, env: {
      ...process.env, NODE_ENV: 'production', PORT: String(port), WRITIDE_DATA_DIR: directory,
      WRITIDE_CACHE_DIR: path.join(directory, 'cache'), WRITIDE_ORIGIN: origin, WRITIDE_PASSWORD: password,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    let started = false;
    for (let i = 0; i < 80; i++) {
      try { started = (await fetch(origin + '/api/health')).ok; } catch {}
      if (started) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(started, output);
    assert.equal((await fetch(origin)).status, 401);
    assert.equal((await fetch(origin + '/api/workspace')).status, 401);
    assert.equal((await fetch(origin + '/api/webdav/session', { headers: { authorization, Origin: 'https://other.invalid' } })).status, 403);
    const page = await fetch(origin, { headers: { authorization } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.doesNotMatch(html, /@vite\/client/);
    const asset = html.match(/src="([^"]+\.js)"/)[1];
    assert.equal((await fetch(origin + asset, { headers: { authorization } })).status, 200);
    assert.equal((await fetch(origin + '/server.mjs', { headers: { authorization } })).status, 404);
    const workspace = await (await fetch(origin + '/api/workspace', { headers: { authorization } })).json();
    assert.equal(workspace.documents.length, 1);
    assert.equal(workspace.documents[0].content, '# container fixture\r\n');
    workspace.documents[0].content = '# saved container fixture\r\n';
    const saved = await fetch(origin + '/api/workspace', { method: 'PUT', headers: { authorization, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(workspace) });
    assert.equal(saved.status, 200, await saved.text());
    assert.equal(await readFile(path.join(directory, 'Workspace', 'sample.md'), 'utf8'), '# saved container fixture\r\n');
    assert.equal((await fetch(origin + '/api/local-images/session', { headers: { authorization } })).status, 400);
    const accessStatus = await (await fetch(origin + '/api/access', { headers: { authorization } })).json();
    assert.equal(accessStatus.usingDefaultPassword, false);
    const nextPassword = 'changed-container-password';
    const changed = await fetch(origin + '/api/access/password', { method: 'POST', headers: { authorization, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: nextPassword }) });
    assert.equal(changed.status, 200, await changed.text());
    assert.equal((await fetch(origin + '/api/workspace', { headers: { authorization } })).status, 401);
    const nextAuthorization = 'Basic ' + Buffer.from(`admin:${nextPassword}`).toString('base64');
    assert.equal((await fetch(origin + '/api/workspace', { headers: { authorization: nextAuthorization } })).status, 200);
    const accessFile = await readFile(path.join(directory, '.writide-access.json'), 'utf8');
    assert.doesNotMatch(accessFile, /changed-container-password/);
    const session = await (await fetch(origin + '/api/webdav/session', { headers: { authorization: nextAuthorization } })).json();
    assert.equal(session.features.documentMove, true);
  } finally {
    if (child && child.exitCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
