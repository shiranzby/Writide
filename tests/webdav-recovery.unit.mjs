import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDavTransport } from '../server/webdav-transport.mjs';
import { createCredentialStore } from '../server/webdav-credentials.mjs';
import { createWebdavService } from '../server/webdav-service.mjs';
import { mockWebdav } from './fixtures/webdav-server.mjs';

test('Nutstore pacing shares account queue and 503 cooldown respects Retry-After without retrying PUT', async () => {
  let clock = 1000, calls = 0, limited = false;
  const times = [];
  const request = createDavTransport({ now: () => clock, sleep: async ms => { clock += ms; }, fetcher: async () => {
    calls++; times.push(clock);
    return new Response('', { status: limited ? 503 : 200, headers: limited ? { 'Retry-After': '90' } : {} });
  } });
  await Promise.all([request('https://dav.jianguoyun.com/dav/'), request('https://dav.jianguoyun.com/dav/a')]);
  assert.equal(times[1] - times[0], 150);
  limited = true;
  await assert.rejects(request('https://dav.jianguoyun.com/dav/a', { method: 'PUT' }), error => error.retryAt === clock + 90000);
  const before = calls;
  await assert.rejects(request('https://dav.jianguoyun.com/dav/b'), error => error.status === 503);
  assert.equal(calls, before);
  clock += 90000; limited = false;
  assert.equal((await request('https://dav.jianguoyun.com/dav/')).status, 200);
});

test('saved preferences restore after server recreation and forgetting disables automatic login', async () => {
  const dav = await mockWebdav();
  let saved = null;
  const credentials = { read: async () => saved, write: async value => { saved = value; } };
  try {
    let service = createWebdavService({ credentials });
    const config = { url: dav.url, username: 'writer', password: 'secret', remember: true, autoLogin: true };
    const first = await service.run({ action: 'connect', ...config });
    assert.equal((await service.run({ action: 'preferences' })).remember, true);
    assert.equal(JSON.stringify(await service.run({ action: 'preferences' })).includes('secret'), false);
    const count = dav.calls.length;
    await service.run({ action: 'list', session: first.session });
    assert.equal(dav.calls.length, count, 'connect root listing reused');
    service = createWebdavService({ credentials });
    const resumed = await service.run({ action: 'resume', url: dav.url, username: 'writer', session: first.session, automatic: true });
    assert.notEqual(first.session, resumed.session);
    await service.run({ action: 'forget-password' });
    await assert.rejects(service.run({ action: 'resume', url: dav.url, username: 'writer', session: resumed.session, automatic: true }), error => error.status === 401);
    assert.equal(saved, null);
  } finally { await dav.close(); }
});

test('Windows credential store persists encrypted bytes and supports explicit removal', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'writide-credentials-'));
  const file = path.join(dir, 'credentials.dpapi');
  try {
    const store = createCredentialStore(file);
    const profile = { url: 'https://example.invalid/dav/', username: 'test', password: 'test-password-only', autoLogin: true };
    await store.write(profile);
    const raw = await readFile(file, 'utf8');
    assert.equal(raw.includes(profile.password), false);
    assert.deepEqual(await createCredentialStore(file).read(), profile);
    await store.write(null);
    assert.equal(await store.read(), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Docker credential store encrypts at rest and restores automatic login after recreation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'writide-portable-credentials-'));
  const file = path.join(dir, 'credentials.enc');
  const keyFile = path.join(dir, 'credentials.key');
  const dav = await mockWebdav();
  try {
    const profile = { url: dav.url, username: 'writer', password: 'secret', remember: true, autoLogin: true };
    const firstStore = createCredentialStore(file, { platform: 'linux', keyFile });
    const firstService = createWebdavService({ credentials: firstStore });
    const connected = await firstService.run({ action: 'connect', ...profile });
    const encrypted = await readFile(file, 'utf8');
    const key = await readFile(keyFile, 'utf8');
    assert.equal(encrypted.includes(profile.password), false);
    assert.equal(key.includes(profile.password), false);
    assert.deepEqual(await createCredentialStore(file, { platform: 'linux', keyFile }).read(), {
      url: profile.url, username: profile.username, password: profile.password, autoLogin: true,
    });
    const restoredService = createWebdavService({ credentials: createCredentialStore(file, { platform: 'linux', keyFile }) });
    const resumed = await restoredService.run({ action: 'resume', url: dav.url, username: profile.username, session: connected.session, automatic: true });
    assert.notEqual(resumed.session, connected.session);
    await createCredentialStore(file, { platform: 'linux', keyFile }).write(null);
    assert.equal(await firstStore.read(), null);
  } finally { await dav.close(); await rm(dir, { recursive: true, force: true }); }
});
