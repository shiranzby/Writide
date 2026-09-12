import { test, expect } from '@playwright/test';
import { mockWebdav } from './fixtures/webdav-server.mjs';

async function connect(page, url) {
  await page.route('**/api/workspace', route => route.fulfill({ json: { documents: [], folders: [], activeId: null } }));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await page.locator('[data-command="settings"]').first().click();
  await page.locator('[data-command="open-webdav"]').click();
  const dialog = page.getByRole('dialog', { name: '连接 WebDAV' });
  await dialog.locator('[name="url"]').fill(url);
  await dialog.locator('[name="username"]').fill('writer');
  await dialog.locator('[name="password"]').fill('secret');
  await dialog.locator('[name="allowHttp"]').check();
  await dialog.getByRole('button', { name: '连接', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test('sidebar loading stays silent while directory errors remain visible and retryable', async ({ page }) => {
  const dav = await mockWebdav();
  dav.folders.add('pending');
  dav.files.set('pending/note.md', { data: Buffer.from('note'), etag: '"note"' });
  let release: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let failOnce = true;
  await page.route('**/api/webdav', async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'list' && body.path === 'pending' && failOnce) {
      await gate; failOnce = false;
      await route.fulfill({ status: 500, json: { error: 'Directory unavailable' } });
    } else await route.continue();
  });
  try {
    await connect(page, dav.url);
    const folder = page.locator('.folder-row').filter({ hasText: 'pending' });
    await expect(folder).toHaveAttribute('aria-busy', 'true');
    await expect(folder).toHaveText('pending');
    expect(await folder.getAttribute('title')).toBeNull();
    release();
    await expect(folder).toContainText('加载失败');
    await expect(folder).toHaveAttribute('title', 'Directory unavailable');
    await folder.click();
    await expect(page.locator('.file-row').filter({ hasText: 'note' })).toBeVisible();
    await expect(folder).toHaveText('pending');
    expect(dav.calls.some(call => ['PUT', 'DELETE', 'MOVE'].includes(call.method))).toBe(false);
  } finally { release(); await dav.close(); }
});

test('folder expansion prefetches just one further level; editing does not scan unopened branches; deep file restores', async ({ page }) => {
  const dav = await mockWebdav({ pageSize: 2 });
  for (const folder of ['一级', '一级/二级', '一级/二级/三级', '隐藏', '隐藏/内部', '隐藏/内部/保留']) dav.folders.add(folder);
  dav.files.set('一级/二级/深层.md', { data: Buffer.from('deep original'), etag: '"deep"' });
  dav.files.set('隐藏/内部/保留/不动.md', { data: Buffer.from('untouched'), etag: '"hidden"' });
  try {
    await connect(page, dav.url);
    await expect(page.locator('#typora-editor .cm-content')).toContainText('原文');
    await expect.poll(() => dav.calls.some(call => call.path === '隐藏')).toBe(true);
    expect(dav.calls.some(call => call.path === '隐藏/内部')).toBe(false);
    await page.locator('.folder-row').filter({ has: page.locator('strong', { hasText: /^一级$/ }) }).click();
    await expect.poll(() => dav.calls.some(call => call.path === '一级/二级')).toBe(true);
    expect(dav.calls.some(call => call.path === '一级/二级/三级')).toBe(false);
    await page.locator('.folder-row').filter({ has: page.locator('strong', { hasText: /^二级$/ }) }).click();
    await page.locator('.file-row').filter({ hasText: '深层' }).click();
    await expect(page.locator('#typora-editor .cm-content')).toContainText('deep original');
    await page.locator('#typora-editor .cm-content').focus();
    await page.keyboard.press('Control+End'); await page.keyboard.type(' changed');
    await expect.poll(() => dav.files.get('一级/二级/深层.md').data.toString()).toBe('deep original changed');
    expect(dav.calls.some(call => call.path.startsWith('隐藏/内部'))).toBe(false);
    expect(dav.files.get('隐藏/内部/保留/不动.md').data.toString()).toBe('untouched');
    expect(dav.calls.some(call => call.method === 'PROPFIND' && call.path.endsWith('.md'))).toBe(false);
    await page.reload();
    await expect(page.locator('#typora-editor .cm-content')).toContainText('deep original changed');
  } finally { await dav.close(); }
});

test('600 remote images load near the viewport, use direct GET and repeated views reuse cache', async ({ page }, info) => {
  test.setTimeout(60000);
  const dav = await mockWebdav();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=', 'base64');
  dav.folders.add('说明.assets');
  const images = [];
  for (let i = 0; i < 600; i++) {
    dav.files.set(`说明.assets/${i}.png`, { data: png, etag: `"${i}"` });
    images.push(`<img src="./说明.assets/${i}.png" width="600" height="400" alt="img-${i}" />`);
  }
  dav.files.set('说明.md', { data: Buffer.from('# Gallery\n\n' + images.join('\n\n') + '\n\nEND'), etag: '"gallery"' });
  try {
    await connect(page, dav.url);
    await expect.poll(() => dav.calls.filter(call => call.method === 'GET' && call.path.endsWith('.png')).length).toBeGreaterThan(0);
    await expect.poll(() => page.locator('#typora-editor img[data-original-src]').first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
    const count = () => dav.calls.filter(call => call.method === 'GET' && call.path.endsWith('.png')).length;
    expect(count()).toBeLessThan(12);
    expect(dav.calls.some(call => call.method === 'PROPFIND' && call.path.startsWith('说明.assets'))).toBe(false);
    await page.screenshot({ path: info.outputPath('dav-lazy-gallery.png') });
    await page.locator('#typora-editor .cm-content').focus();
    await page.keyboard.press('Control+End');
    await expect.poll(() => dav.calls.some(call => call.method === 'GET' && call.path.endsWith('/599.png'))).toBe(true);
    expect(count()).toBeLessThan(24);
    const before = count();
    await page.keyboard.press('Control+Home');
    await expect.poll(() => page.locator('#typora-editor img[data-original-src]').first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
    expect(count()).toBeLessThanOrEqual(before + 2);
    expect(dav.files.get('说明.md').data.toString()).not.toContain('blob:');
  } finally { await dav.close(); }
});

test('middle outline target preloads five earlier and five later images; rolling read-ahead overlaps GETs', async ({ page }) => {
  const dav = await mockWebdav({ imageDelayMs: 500 });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=', 'base64');
  dav.folders.add('说明.assets');
  const sections = [];
  for (let i = 0; i < 30; i++) {
    dav.files.set(`说明.assets/${i}.png`, { data: png, etag: `"${i}"` });
    sections.push(`## Section ${i}\n\n<img src="./说明.assets/${i}.png" width="600" height="400" />`);
  }
  dav.files.set('说明.md', { data: Buffer.from(sections.join('\n\n')), etag: '"sections"' });
  try {
    await connect(page, dav.url);
    await expect.poll(() => dav.calls.filter(call => call.method === 'GET' && call.path.endsWith('.png')).length).toBeGreaterThanOrEqual(5);
    await expect.poll(() => dav.metrics.activeImages).toBe(0);
    dav.calls.length = 0; dav.metrics.peakImages = 0;
    await page.locator('[data-panel="outline"]').click();
    await page.locator('.outline-row').filter({ hasText: /^Section 15$/ }).click();
    await expect.poll(() => Array.from({ length: 10 }, (_, i) => i + 10).every(i => dav.calls.some(call => call.method === 'GET' && call.path === `说明.assets/${i}.png`))).toBe(true);
    await expect.poll(() => dav.metrics.activeImages).toBe(0);
    // HTTP/1.1 browsers can cap same-origin API connections below our ten-job limit.
    expect(dav.metrics.peakImages).toBeGreaterThan(2);
    expect(dav.metrics.peakImages).toBeLessThanOrEqual(10);
    expect(dav.calls.filter(call => call.method === 'GET' && call.path.endsWith('.png')).length).toBeLessThanOrEqual(12);
    await expect.poll(() => page.locator('#typora-editor .cm-content').evaluate((el: any) => {
      const view = el.cmTile.root.view, box = view.coordsAtPos(view.state.selection.main.head);
      const surface = view.dom.closest('#typora-view').getBoundingClientRect();
      return box.top >= surface.top && box.bottom <= surface.bottom;
    })).toBe(true);
    await page.locator('#typora-view').hover();
    await page.mouse.wheel(0, 1500);
    await expect.poll(() => dav.calls.some(call => call.method === 'GET' && call.path === '说明.assets/20.png')).toBe(true);
    expect(dav.calls.filter(call => call.method === 'GET' && call.path.endsWith('.png')).length).toBeLessThan(25);
  } finally { await dav.close(); }
});
