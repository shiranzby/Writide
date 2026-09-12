import { test, expect } from '@playwright/test';
import { mockWebdav } from './fixtures/webdav-server.mjs';

test('restored long document renders late images and links without clicking the editor', async ({ page }) => {
  const source = '# Long\n\n' + 'A paragraph with **bold** content and a normal line.\n\n'.repeat(1400)
    + '![reopened](/reopen.svg)\n\n[Visible link](https://example.com/)\n\nending';
  await page.route('**/api/workspace', route => route.fulfill({ json: {
    documents: [{ id: 'long', name: 'Long', content: source }, { id: 'short', name: 'Short', content: '# Short' }],
    folders: [], activeId: 'long', _revision: 1,
  } }));
  await page.route('**/reopen.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#408370"/></svg>' }));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  const editor = page.locator('#typora-editor .cm-content');
  await editor.focus(); await page.keyboard.press('Control+End');
  await page.locator('.file-row[data-id="short"]').click();
  await page.locator('.document-tab[data-id="long"]').click();
  await expect(page.locator('#typora-editor img[alt="reopened"]')).toBeVisible();
  await expect(page.locator('#typora-editor [data-link-href="https://example.com/"]')).toHaveText('Visible link');
  expect(await editor.evaluate((el: any) => el.cmTile.root.view.state.doc.toString())).toBe(source);
});

test('double-click on a DAV tab renames the remote document and subsequent edits use the new path', async ({ page }) => {
  const dav = await mockWebdav();
  dav.files.clear(); dav.files.set('before.md', { data: Buffer.from('# Content\n\nkeep'), etag: '"original"' });
  try {
    await page.route('**/api/workspace', route => route.fulfill({ json: { documents: [], folders: [], activeId: null } }));
    await page.goto('/'); await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
    await page.locator('[data-command="settings"]').first().click(); await page.locator('[data-command="open-webdav"]').click();
    const dialog = page.getByRole('dialog', { name: '连接 WebDAV' });
    await dialog.locator('[name="url"]').fill(dav.url); await dialog.locator('[name="username"]').fill('writer');
    await dialog.locator('[name="password"]').fill('secret'); await dialog.locator('[name="allowHttp"]').check();
    await dialog.getByRole('button', { name: '连接', exact: true }).click(); await expect(dialog).not.toBeVisible();
    await expect(page.locator('#typora-editor .cm-content')).toContainText('keep');
    page.once('dialog', dialog => dialog.accept('after'));
    await page.locator('.document-tab.active').dblclick();
    await expect(page.locator('.document-tab.active > span')).toHaveText('after');
    expect(dav.files.has('before.md')).toBe(false); expect(dav.files.get('after.md')?.data.toString()).toBe('# Content\n\nkeep');
    await page.locator('#typora-editor .cm-content').focus(); await page.keyboard.press('Control+End'); await page.keyboard.type(' edited');
    await expect.poll(() => dav.files.get('after.md')?.data.toString()).toContain(' edited');
    expect(dav.calls.filter(call => call.method === 'PUT').every(call => call.path === 'after.md')).toBe(true);
  } finally { await dav.close(); }
});

test('active tab click keeps reading position, double-click renames without moving the editor', async ({ page }) => {
  let saved: any;
  const doc = { id: 'note', name: 'Original', content: '# Start\n\n' + 'paragraph\n\n'.repeat(150) };
  await page.route('**/api/workspace', async route => {
    if (route.request().method() === 'PUT') { saved = route.request().postDataJSON(); return route.fulfill({ json: { ok: true, workspace: { ...saved, _revision: 2 } } }); }
    return route.fulfill({ json: saved || { documents: [doc, { id: 'other', name: 'Other', content: 'other' }], folders: [], activeId: 'note', _revision: 1 } });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await page.locator('.file-row[data-id="other"]').click();
  await page.locator('.document-tab[data-id="note"]').click();
  const surface = page.locator('#typora-view');
  await surface.hover(); await page.mouse.wheel(0, 1200);
  await expect.poll(() => surface.evaluate(el => el.scrollTop)).toBeGreaterThan(500);
  await page.waitForTimeout(100);
  const top = await surface.evaluate(el => el.scrollTop);
  await page.locator('.document-tab[data-id="note"]').click();
  expect(Math.abs(await surface.evaluate(el => el.scrollTop) - top)).toBeLessThan(3);
  page.once('dialog', dialog => dialog.accept('Renamed'));
  await page.locator('.document-tab[data-id="note"]').dblclick();
  await expect(page.locator('.document-tab[data-id="note"] > span')).toHaveText('Renamed');
  expect(Math.abs(await surface.evaluate(el => el.scrollTop) - top)).toBeLessThan(3);
  await expect.poll(() => saved?.documents.find((item: any) => item.id === 'note')?.name).toBe('Renamed');
  expect(saved.documents.find((item: any) => item.id === 'note').content).toBe(doc.content);
});
