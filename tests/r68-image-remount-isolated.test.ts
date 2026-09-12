import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import { mockWebdav } from './fixtures/webdav-server.mjs';

test('remounted wide DAV images preserve intrinsic aspect ratio around two list lines', async ({ page }, info) => {
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 2560; canvas.height = 1390;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#729e83'; ctx.fillRect(0, 0, 2560, 1390);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  const source = '![first](./note.assets/first.png)\n\n'
    + '- **确定是按月结算，然后修改席位为2，右键网页空白处，点击检查打开开发者工具**\n'
    + '- 切换上面一栏位控制台页，点击控制台页左上角的图标清空\n\n'
    + '![second](./note.assets/second.png)\n\n' + 'tail paragraph\n\n'.repeat(150);
  const dav = await mockWebdav({ imageDelayMs: 250 });
  dav.files.clear(); dav.folders.add('note.assets');
  dav.files.set('note.md', { data: Buffer.from(source), etag: '"note"' });
  for (const name of ['first', 'second']) dav.files.set(`note.assets/${name}.png`, { data: png, etag: '"image"' });
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
    const first = page.locator('#typora-editor img[alt="first"]');
    const editor = page.locator('#typora-editor .cm-content');
    await expect.poll(() => first.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2560);
    expect(await first.evaluate(img => img.getBoundingClientRect().width)).toBeLessThan(900);
    expect(await first.evaluate(img => img.closest('[data-live-type="image"]').tagName)).toBe('DIV');
    await page.screenshot({ path: info.outputPath('standalone-images-and-list.png') });
    await editor.focus(); await page.keyboard.press('Control+End');
    await expect(first).toHaveCount(0);
    await page.keyboard.press('Control+Home');
    await expect.poll(() => first.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2560);
    const reserved = await first.evaluate((img: HTMLImageElement) => ({ width: Number(img.getAttribute('width')), height: Number(img.getAttribute('height')) }));
    expect(reserved.width / reserved.height).toBeCloseTo(2560 / 1390, 4);
    await page.locator('#typora-view').hover(); await page.mouse.wheel(0, 650);
    await expect.poll(() => page.locator('#typora-view').evaluate(el => el.scrollTop)).toBeGreaterThan(400);
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -160); await page.waitForTimeout(80); }
    await expect.poll(() => page.locator('#typora-view').evaluate(el => el.scrollTop)).toBeLessThan(3);
    expect(dav.files.get('note.md').data.toString()).toBe(source);
    expect(dav.calls.some(call => call.method === 'PUT')).toBe(false);
  } finally { await dav.close(); }
});

test('readonly reported document can scroll upward past the two-image list boundary', async ({ page }) => {
  test.skip(!process.env.PAPER_REPORTED_DOCUMENT, 'Optional local readonly acceptance fixture');
  test.setTimeout(60000);
  const file = process.env.PAPER_REPORTED_DOCUMENT!;
  const source = await readFile(file, 'utf8');
  const base = path.dirname(file), name = path.basename(file);
  const dav = await mockWebdav({ imageDelayMs: 200 });
  dav.files.clear(); dav.folders.add('typora');
  dav.files.set('typora/' + name, { data: Buffer.from(source), etag: '"reported"' });
  const parser = new MarkdownIt();
  for (const token of parser.parse(source, {})) for (const child of token.children || []) {
    if (child.type !== 'image') continue;
    const src = child.attrGet('src')!;
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src)) continue;
    const relative = decodeURIComponent(new URL(src, 'https://fixture.invalid/').pathname).slice(1);
    const local = path.resolve(base, relative);
    if (!local.startsWith(path.resolve(base) + path.sep)) throw new Error('Fixture image outside document folder');
    dav.files.set('typora/' + relative, { data: await readFile(local), etag: '"image"' });
  }
  try {
    await page.route('**/api/workspace', route => route.fulfill({ json: { documents: [], folders: [], activeId: null } }));
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
    await page.locator('[data-command="settings"]').first().click();
    await page.locator('[data-command="open-webdav"]').click();
    const dialog = page.getByRole('dialog', { name: '连接 WebDAV' });
    await dialog.locator('[name="url"]').fill(dav.url + 'typora/');
    await dialog.locator('[name="username"]').fill('writer');
    await dialog.locator('[name="password"]').fill('secret');
    await dialog.locator('[name="allowHttp"]').check();
    await dialog.getByRole('button', { name: '连接', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const editor = page.locator('#typora-editor .cm-content'), surface = page.locator('#typora-view');
    await editor.focus(); await page.keyboard.press('Control+f');
    await page.locator('.cm-search input[name="search"]').fill('确定是按月结算');
    await page.locator('.cm-search button[name="next"]').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#typora-editor .cm-line').filter({ hasText: '确定是按月结算' })).toBeInViewport();
    await editor.focus(); await page.keyboard.press('Control+End');
    await surface.hover();
    const trace = [];
    let crossed = false;
    for (let step = 0; step < 80; step++) {
      await page.mouse.wheel(0, -450);
      await page.waitForTimeout(100);
      const sample = await editor.evaluate((el: any) => {
        const view = el.cmTile.root.view;
        const root = el.closest('#typora-view'), rect = root.getBoundingClientRect();
        const pos = view.posAtCoords({ x: rect.left + rect.width / 2, y: rect.top + 100 }, false);
        return { top: root.scrollTop, height: root.scrollHeight, line: pos == null ? null : view.state.doc.lineAt(pos).number };
      });
      trace.push(sample);
      if (sample.line && sample.line < 300) { crossed = true; break; }
    }
    expect(crossed, JSON.stringify(trace.slice(-15))).toBe(true);
    expect(await editor.evaluate((el: any) => el.cmTile.root.view.state.doc.toString())).toBe(source.replace(/\r\n?/g, '\n'));
    expect(dav.calls.some(call => call.method === 'PUT')).toBe(false);
  } finally { await dav.close(); }
});
