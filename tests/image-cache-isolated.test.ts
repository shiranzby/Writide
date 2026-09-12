import { test, expect } from '@playwright/test';
import { mockWebdav } from './fixtures/webdav-server.mjs';

test('reopen reserves cached dimensions before image delivery; update and clear controls affect real cache', async ({ page }, info) => {
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 900;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#408370'; ctx.fillRect(0, 0, 600, 900);
    return canvas.toDataURL().split(',')[1];
  }), 'base64');
  const dav = await mockWebdav();
  dav.files.clear(); dav.folders.add('note.assets');
  const source = '# Cached gallery\n\n' + Array.from({ length: 6 }, (_, i) => `![photo${i}](./note.assets/${i}.png)\n\ncaption ${i}\n\n`).join('') + 'ending';
  dav.files.set('note.md', { data: Buffer.from(source), etag: '"note"' });
  for (let i = 0; i < 6; i++) dav.files.set(`note.assets/${i}.png`, { data: png, etag: `"image${i}"` });
  let release = true;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/api/workspace', route => route.fulfill({ json: { documents: [], folders: [], activeId: null } }));
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
    await page.locator('[data-command="settings"]').first().click();
    await page.locator('[data-command="open-webdav"]').click();
    const dialog = page.getByRole('dialog', { name: '连接 WebDAV' });
    await dialog.locator('[name="url"]').fill(dav.url);
    await dialog.locator('[name="username"]').fill('writer');
    await dialog.locator('[name="password"]').fill('secret');
    await dialog.locator('[name="allowHttp"]').check();
    await dialog.getByRole('button', { name: '连接', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.locator('#typora-editor .cm-content').focus(); await page.keyboard.press('Control+End');
    await expect.poll(() => dav.calls.filter(call => call.method === 'GET' && call.path.endsWith('.png')).length).toBe(6);
    await expect.poll(() => page.evaluate(async () => {
      const { webdavRequest } = await import('/src/webdav-workspace.js');
      const config = JSON.parse(localStorage.getItem('paper-webdav-connection')!);
      const result = await webdavRequest({ action: 'cache-dimensions', session: config.session,
        paths: Array.from({ length: 6 }, (_, i) => `note.assets/${i}.png`) });
      return Object.keys(result.images).length;
    })).toBe(6);
    await page.keyboard.press('Control+Home');
    await expect.poll(() => page.locator('#typora-editor img').first().evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(600);
    // Reload only the synthetic workspace. Hold image bytes, not local size metadata.
    await page.route('**/api/webdav', async route => {
      const body = route.request().postDataJSON();
      if (body.action === 'read' && body.media) while (!release) await new Promise(resolve => setTimeout(resolve, 20));
      await route.continue();
    });
    release = false; dav.calls.length = 0;
    await page.reload({ waitUntil: 'domcontentloaded' });
    const first = page.locator('#typora-editor img[alt="photo0"]');
    await expect(first).toHaveAttribute('width', '600'); await expect(first).toHaveAttribute('height', '900');
    expect(await first.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(0);
    const before = await first.boundingBox(); expect(before!.height / before!.width).toBeCloseTo(1.5, 2);
    const total = await page.locator('#typora-view').evaluate(el => el.scrollHeight);
    release = true;
    await expect.poll(() => first.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(600);
    const after = await first.boundingBox(); expect(Math.abs(after!.height - before!.height)).toBeLessThan(2);
    expect(Math.abs(await page.locator('#typora-view').evaluate(el => el.scrollHeight) - total)).toBeLessThan(120);
    expect(dav.calls.filter(call => call.method === 'GET' && call.path.endsWith('.png'))).toHaveLength(0);
    await page.locator('[data-command="settings"]').first().click();
    await page.locator('[data-settings-tab="cache"]').click();
    const form = page.locator('#image-cache-form');
    await expect(form.locator('fieldset')).toBeEnabled();
    await form.locator('[name="maxMiB"]').fill('64'); await form.locator('[name="minutes"]').fill('1');
    await form.getByRole('button', { name: '保存设置' }).click();
    await expect(form.locator('fieldset')).toBeEnabled();
    await expect(page.locator('#image-cache-stats')).toContainText('/ 64 MiB');
    dav.files.set('note.assets/0.png', { data: png, etag: '"image-changed"' }); dav.calls.length = 0;
    await form.getByRole('button', { name: '检查图片更新' }).click();
    await expect.poll(() => dav.calls.filter(call => call.method === 'GET' && call.path.endsWith('.png')).map(call => call.path)).toEqual(['note.assets/0.png']);
    await expect(first).toHaveJSProperty('naturalWidth', 600);
    await page.screenshot({ path: info.outputPath('image-cache-settings.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-settings-tab="cache"]').click();
    await expect(form.locator('fieldset')).toBeEnabled();
    expect(await page.locator('[data-settings-page="cache"]').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath('image-cache-settings-narrow.png') });
    page.once('dialog', dialog => dialog.accept());
    await form.getByRole('button', { name: '清理图片缓存' }).click();
    await expect.poll(() => page.locator('#image-cache-stats').textContent()).toContain('0.0 MiB');
    expect(dav.calls.some(call => call.method === 'PUT' || call.method === 'DELETE')).toBe(false);
    expect(dav.files.get('note.md')!.data.toString()).toBe(source);
    expect(errors).toEqual([]);
    // Restore shared test-server policy, not any user cache.
    await form.locator('[name="maxMiB"]').fill('1024'); await form.locator('[name="minutes"]').fill('30');
    await form.getByRole('button', { name: '保存设置' }).click();
    await expect(form.locator('fieldset')).toBeEnabled();
  } finally { release = true; await dav.close(); }
});
