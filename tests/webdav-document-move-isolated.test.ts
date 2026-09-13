import { test, expect } from '@playwright/test';
import { mockWebdav } from './fixtures/webdav-server.mjs';

test('DAV drag moves document with verified assets and edits the new path', async ({ page }) => {
  const dav = await mockWebdav();
  const source = '# 原文\r\n![图](./说明.assets/a.png)\r\n';
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=', 'base64');
  dav.files.set('说明.md', { data: Buffer.from(source), etag: '"original"' });
  dav.folders.add('说明.assets'); dav.folders.add('archive');
  dav.files.set('说明.assets/a.png', { data: bytes, etag: '"image"' });
  try {
    const alerts: string[] = [];
    page.on('dialog', async dialog => { alerts.push(dialog.message()); await dialog.accept(); });
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
    await page.locator('.file-row').filter({ hasText: '说明' }).dragTo(page.locator('.folder-row').filter({ hasText: /^archive$/ }));
    await expect.poll(() => ({ moved: dav.files.has('archive/说明.md'), alerts, calls: dav.calls.filter(c => ['MOVE', 'PUT'].includes(c.method)) })).toMatchObject({ moved: true, alerts: [] });
    expect(dav.files.has('说明.md')).toBe(false);
    expect(dav.files.get('archive/说明.md').data.toString()).toBe(source);
    expect(dav.files.get('archive/说明.assets/a.png').data.equals(bytes)).toBe(true);
    expect(dav.files.get('说明.assets/a.png').data.equals(bytes)).toBe(true);
    await page.locator('#typora-editor .cm-content').focus();
    await page.keyboard.press('Control+End'); await page.keyboard.type(' edited');
    await expect.poll(() => dav.files.get('archive/说明.md').data.toString()).toContain('edited');
    expect(dav.files.has('说明.md')).toBe(false);
  } finally { await dav.close(); }
});
