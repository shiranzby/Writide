import { test, expect } from '@playwright/test';
import { mockWebdav } from './fixtures/webdav-server.mjs';

for (const mode of ['typora', 'source', 'split']) test(`outline jumps to source heading in ${mode}, including duplicates and CRLF`, async ({ page }) => {
  const source = '# Same\r\n\r\n' + 'long paragraph\r\n\r\n'.repeat(100) + '## Same\r\n\r\n' + 'tail\r\n\r\n'.repeat(30);
  let writes = 0;
  await page.addInitScript(mode => localStorage.setItem('paper-settings-v1', JSON.stringify({ viewMode: mode })), mode);
  await page.route('**/api/workspace', route => {
    if (route.request().method() !== 'GET') writes++;
    return route.fulfill({ json: { documents: [{ id: 'outline', name: 'Outline', content: source }], folders: [], activeId: 'outline' } });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await page.locator('[data-panel="outline"]').click();
  await expect(page.locator('.outline-row')).toHaveCount(2);
  await page.locator('.outline-row').nth(1).click();
  const editor = page.locator(mode === 'typora' ? '#typora-editor .cm-editor' : '#split-editor .cm-editor');
  await expect.poll(() => editor.evaluate(el => {
    const view = (el.querySelector('.cm-content') as any).cmTile.root.view;
    const range = view.state.selection.main;
    const line = view.state.doc.lineAt(range.head);
    const caret = view.coordsAtPos(range.head);
    const surface = (view.dom.closest('#typora-view') || view.scrollDOM).getBoundingClientRect();
    return { line: line.text, visible: Boolean(caret && caret.top >= surface.top && caret.bottom <= surface.bottom) };
  })).toEqual({ line: '## Same', visible: true });
  if (mode === 'split') await expect.poll(() => page.locator('#split-preview h2').evaluate(el => {
    const box = el.getBoundingClientRect(), root = el.closest('#split-preview').getBoundingClientRect();
    return box.top >= root.top && box.bottom <= root.bottom;
  })).toBe(true);
  await page.locator('.outline-row').first().click();
  await expect.poll(() => editor.evaluate(el => {
    return (el.querySelector('.cm-content') as any).cmTile.root.view.state.selection.main.head;
  })).toBe(0);
  expect(writes).toBe(0);
});

test('changing root URL to subfolder reuses current login without reading other application directories', async ({ page }) => {
  const dav = await mockWebdav();
  dav.folders.add('typora'); dav.folders.add('other-app');
  dav.files.set('typora/专用.md', { data: Buffer.from('subfolder note'), etag: '"sub"' });
  try {
    await page.route('**/api/workspace', route => route.fulfill({ json: { documents: [], folders: [], activeId: null } }));
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
    const open = async () => {
      await page.locator('[data-command="settings"]').first().click();
      await page.locator('[data-command="open-webdav"]').click();
      return page.getByRole('dialog', { name: '连接 WebDAV' });
    };
    let dialog = await open();
    await dialog.locator('[name="url"]').fill(dav.url);
    await dialog.locator('[name="username"]').fill('writer');
    await dialog.locator('[name="password"]').fill('secret');
    await dialog.locator('[name="allowHttp"]').check();
    await dialog.getByRole('button', { name: '连接', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('#typora-editor .cm-content')).toContainText('原文');
    await expect.poll(() => dav.calls.some(call => call.path === 'other-app')).toBe(true);
    dialog = await open();
    await dialog.locator('[name="url"]').fill(dav.url + 'typora');
    await dialog.locator('[name="password"]').fill('');
    await dialog.locator('[name="allowHttp"]').check();
    dav.calls.length = 0;
    await dialog.getByRole('button', { name: '连接', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('#typora-editor .cm-content')).toContainText('subfolder note');
    expect(dav.calls.every(call => call.path === 'typora' || call.path.startsWith('typora/'))).toBe(true);
  } finally { await dav.close(); }
});
