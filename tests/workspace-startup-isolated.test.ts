import { test, expect } from '@playwright/test';
import { mockWebdav } from './fixtures/webdav-server.mjs';

async function open(page) {
  let writes = 0;
  await page.route('**/api/workspace', route => {
    if (route.request().method() !== 'GET') writes++;
    return route.fulfill({ json: { documents: [{ id: 'a', name: 'First', content: 'first' }, { id: 'b', name: 'Last', content: 'last' }], folders: [], activeId: 'a', _revision: 1 } });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  return () => writes;
}
test('startup restores a clicked file without edits, workspace-only opens none, new workspace is isolated', async ({ page }) => {
  const writes = await open(page);
  await page.locator('.file-row').filter({ hasText: 'Last' }).click();
  await page.reload();
  await expect(page.locator('.file-row.active')).toContainText('Last');
  await page.locator('[data-command="settings"]').first().click();
  await page.locator('#setting-startup').selectOption('last-directory');
  await page.reload();
  await expect(page.locator('.file-row')).toHaveCount(2);
  await expect(page.locator('.document-tab')).toHaveCount(0);
  await expect(page.locator('#typora-view')).toHaveAttribute('inert', '');
  await page.locator('[data-command="settings"]').first().click();
  await page.locator('#setting-startup').selectOption('new');
  await page.reload();
  await expect(page.locator('.file-row')).toHaveCount(0);
  await page.locator('[data-command="new"]').first().click();
  await page.keyboard.type('new workspace body');
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('browser:') && localStorage[key].includes('new workspace body')))).toBe(true);
  expect(writes()).toBe(0);
  await page.locator('[data-command="settings"]').first().click();
  await page.locator('#setting-startup').selectOption('last');
  await page.reload();
  await expect(page.locator('#typora-editor .cm-content')).toContainText('new workspace body');
});

test('WebDAV connection edits real remote bytes, restores on reload and keeps local changes on conflict', async ({ page }, info) => {
  const dav = await mockWebdav();
  try {
    const writes = await open(page);
    await page.locator('[data-command="settings"]').first().click();
    await page.locator('[data-command="open-webdav"]').click();
    const dialog = page.getByRole('dialog', { name: '连接 WebDAV' });
    await dialog.locator('[name="url"]').fill(dav.url);
    await dialog.locator('[name="username"]').fill('writer');
    await dialog.locator('[name="password"]').fill('secret');
    await dialog.locator('[name="allowHttp"]').check();
    await page.screenshot({ path: info.outputPath('webdav-dialog.png') });
    await dialog.getByRole('button', { name: '连接', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('#workspace-root-drop')).toContainText('WebDAV');
    await page.locator('#typora-editor .cm-content').focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' edited');
    await expect.poll(() => dav.files.get('说明.md').data.toString()).toContain('edited');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=', 'base64');
    await page.locator('#image-input').setInputFiles({ name: '图片.png', mimeType: 'image/png', buffer: png });
    await expect.poll(() => [...dav.files.keys()].some(path => path.startsWith('说明.assets/'))).toBe(true);
    const imagePath = [...dav.files.keys()].find(path => path.startsWith('说明.assets/'))!;
    expect(dav.files.get(imagePath).data.equals(png)).toBe(true);
    await expect.poll(() => dav.files.get('说明.md').data.toString()).toContain('./说明.assets/');
    await expect.poll(() => page.locator('#typora-editor img[data-original-src]').first().evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('secret');
    await page.reload();
    await expect(page.locator('#typora-editor .cm-content')).toContainText('edited');
    await page.locator('[data-command="new"]').first().click();
    await page.keyboard.type('new remote note');
    await expect.poll(() => [...dav.files.values()].some(file => file.data.toString().includes('new remote note'))).toBe(true);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('paper-last-workspace-v1')!).lastFile.path)).toMatch(/\.md$/);
    await page.reload();
    await expect(page.locator('#typora-editor .cm-content')).toContainText('new remote note');
    await page.locator('.file-row').filter({ hasText: '说明' }).click();
    await expect(page.locator('#typora-editor .cm-content')).toContainText('edited');
    let offline = true;
    await page.route('**/api/webdav', route => {
      if (offline && route.request().postDataJSON()?.action === 'write') return route.fulfill({ status: 503, json: { error: 'temporary offline' } });
      return route.continue();
    });
    await page.locator('#typora-editor .cm-content').focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' retry');
    await expect(page.locator('#save-state')).toHaveText('保存失败');
    offline = false;
    await page.keyboard.type(' recovered');
    await expect.poll(() => dav.files.get('说明.md').data.toString()).toContain('retry recovered');
    dav.files.set('说明.md', { data: Buffer.from('external'), etag: '"external"' });
    await page.locator('#typora-editor .cm-content').focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' conflict');
    await expect(page.locator('#save-state')).toHaveText('保存冲突');
    expect(dav.files.get('说明.md').data.toString()).toBe('external');
    await expect(page.locator('#typora-editor .cm-content')).toContainText('conflict');
    expect(writes()).toBe(0);
    await page.screenshot({ path: info.outputPath('webdav-conflict.png') });
  } finally { await dav.close(); }
});

test('WebDAV bridge refuses cross-origin and tokenless requests', async ({ request }) => {
  expect((await request.post('/api/webdav', { data: { action: 'connect', url: 'http://127.0.0.1/' } })).status()).toBe(403);
  expect((await request.get('/api/webdav/session', { headers: { Origin: 'https://evil.invalid' } })).status()).toBe(403);
});

test('Nutstore default address, password visibility and saved automatic recovery keep lazy documents and edits', async ({ page, context }, info) => {
  test.skip(process.platform !== 'win32', 'Windows DPAPI integration; protocol/store abstraction also tested in Node');
  test.setTimeout(60000);
  const dav = await mockWebdav();
  for (let i = 0; i < 20; i++) dav.files.set(`z${i}.md`, { data: Buffer.from(`other ${i}`), etag: `"other-${i}"` });
  try {
    await open(page);
    await page.locator('[data-command="settings"]').first().click();
    await page.locator('[data-command="open-webdav"]').click();
    const dialog = page.getByRole('dialog', { name: '连接 WebDAV' });
    await dialog.locator('[name="url"]').fill('');
    await expect(dialog.locator('[name="url"]')).toHaveAttribute('placeholder', 'https://dav.jianguoyun.com/dav/Typora/');
    await dialog.locator('[name="username"]').fill('writer');
    await dialog.locator('[name="password"]').fill('secret');
    await dialog.getByRole('button', { name: '显示密码' }).click();
    await expect(dialog.locator('[name="password"]')).toHaveAttribute('type', 'text');
    await dialog.getByRole('button', { name: '隐藏密码' }).click();
    await expect(dialog.locator('[name="password"]')).toHaveAttribute('type', 'password');
    let defaultUrl = '';
    await page.route('**/api/webdav', route => {
      const data = route.request().postDataJSON();
      if (data.action === 'connect' && data.url.includes('jianguoyun')) { defaultUrl = data.url; return route.fulfill({ status: 400, json: { error: 'Default address checked locally' } }); }
      return route.continue();
    });
    await dialog.getByRole('button', { name: '连接', exact: true }).click();
    await expect(dialog.locator('output')).toContainText('checked locally');
    expect(defaultUrl).toBe('https://dav.jianguoyun.com/dav/Typora/');
    await dialog.locator('[name="url"]').fill(dav.url);
    await dialog.locator('[name="allowHttp"]').check();
    await dialog.locator('[name="remember"]').check();
    await dialog.locator('[name="autoLogin"]').check();
    await page.screenshot({ path: info.outputPath('dav-options.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: info.outputPath('dav-options-narrow.png') });
    await page.setViewportSize({ width: 1280, height: 720 });
    await dialog.getByRole('button', { name: '连接', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('#typora-editor .cm-content')).toContainText('原文');
    expect(dav.calls.filter(call => call.method === 'GET').length).toBe(1);
    const other = await context.newPage();
    await other.goto('/');
    await expect(other.locator('#typora-editor .cm-content')).toContainText('原文');
    expect(dav.calls.filter(call => call.method === 'GET').length).toBe(2);
    expect(await other.evaluate(() => JSON.stringify(localStorage))).not.toContain('secret');
    await other.close();
    let limited = true, expired = true, tokenExpired = true;
    await page.route('**/api/webdav', route => {
      const data = route.request().postDataJSON();
      if (data.action === 'write' && tokenExpired) { tokenExpired = false; return route.fulfill({ status: 403, json: { error: 'local token expired' } }); }
      if (data.action === 'write' && expired) { expired = false; return route.fulfill({ status: 401, json: { code: 'DAV_SESSION_EXPIRED', error: 'session expired' } }); }
      if (data.action === 'write' && limited) { limited = false; return route.fulfill({ status: 503, json: { error: 'temporary busy', retryAt: Date.now() + 200 } }); }
      return route.continue();
    });
    await page.locator('#typora-editor .cm-content').focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' auto-recovered');
    await expect.poll(() => dav.files.get('说明.md').data.toString(), { timeout: 12000 }).toContain('auto-recovered');
    await expect(page.locator('#typora-editor .cm-content')).toContainText('auto-recovered');
    await page.locator('[data-command="settings"]').first().click();
    await page.locator('[data-command="open-webdav"]').click();
    await expect(dialog.locator('[name="remember"]')).toBeChecked();
    await dialog.getByRole('button', { name: '显示密码' }).click();
    await expect(dialog.locator('[name="password"]')).toHaveValue('secret');
    await dialog.getByRole('button', { name: '隐藏密码' }).click();
    await expect(dialog.getByRole('button', { name: '忘记密码' })).toHaveCount(0);
    await dialog.locator('[name="remember"]').uncheck();
    await expect(dialog.locator('output')).toContainText('已移除保存的密码');
    await expect(dialog.locator('[name="autoLogin"]')).not.toBeChecked();
    await expect(dialog.locator('[name="password"]')).toHaveValue('secret'); // Current form only; encrypted storage is erased.
    const noAuto = await context.newPage();
    await noAuto.goto('/');
    await expect(noAuto.locator('#workspace-root-drop')).toContainText('重新连接');
    await noAuto.close();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('[data-command="close-settings"]').click();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.locator('#typora-editor .cm-content').focus();
    await page.keyboard.press('Control+End'); await page.keyboard.type(' still-signed-in');
    await expect.poll(() => dav.files.get('说明.md').data.toString()).toContain('still-signed-in');
    await expect(page.locator('#save-state')).toHaveText('已保存');
  } finally { await dav.close(); }
});
