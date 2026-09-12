import { test, expect } from '@playwright/test';

for (const fail of [false, true]) test(`authorized folder rename keeps attachments and handles copy failure: ${fail}`, async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const writes: string[] = [];
  await page.route('**/api/workspace', route => {
    if (route.request().method() !== 'GET') writes.push(route.request().method());
    return route.fulfill({ json: { documents: [], folders: [], activeId: null } });
  });
  await page.addInitScript(async ({ fail }) => {
    const root = await navigator.storage.getDirectory();
    await root.getDirectoryHandle('archive', { create: true });
    const old = await root.getDirectoryHandle('old', { create: true });
    const assets = await old.getDirectoryHandle('note.assets', { create: true });
    const write = async (dir, name, content) => {
      const file = await dir.getFileHandle(name, { create: true }), writer = await file.createWritable();
      await writer.write(content); await writer.close();
    };
    await write(old, 'note.md', '# Original\r\n![image](./note.assets/image.png)\r\n');
    await write(assets, 'image.png', Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII='), c => c.charCodeAt(0)));
    await write(old, '.hidden', 'keep hidden');
    await old.getDirectoryHandle('empty', { create: true });
    const writable = FileSystemFileHandle.prototype.createWritable;
    if (fail) FileSystemFileHandle.prototype.createWritable = async function(options) {
      if (this.name === 'image.png') throw new Error('Fixture disk full');
      return writable.call(this, options);
    };
    (window as any).showDirectoryPicker = async () => root;
    (window as any).__migrationRoot = root;
  }, { fail });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await page.waitForFunction(() => Boolean((window as any).__migrationRoot));
  await page.locator('[data-menu="file"]').click();
  await page.locator('#menu-popover [data-command="open-folder"]').click();
  await expect(page.locator('#workspace-root-drop')).toHaveAttribute('data-provider-kind', 'directory');
  const folder = page.locator('.folder-row').filter({ hasText: /^old$/ });
  await folder.click();
  await page.locator('.file-row').filter({ hasText: 'note' }).click();
  await folder.click({ button: 'right' });
  const alerts: string[] = [];
  page.on('dialog', async dialog => {
    if (dialog.type() === 'prompt') await dialog.accept('renamed');
    else { alerts.push(dialog.message()); await dialog.accept(); }
  });
  await page.locator('[data-context-command="rename"]').click();
  await expect(page.locator('#save-state')).toHaveText(fail ? '迁移未完成' : '已保存');
  const state = await page.evaluate(async () => {
    const root = (window as any).__migrationRoot, directories = [];
    for await (const [name] of root.entries()) directories.push(name);
    const name = directories.includes('old') ? 'old' : 'renamed';
    const dir = await root.getDirectoryHandle(name);
    const image = await (await (await dir.getDirectoryHandle('note.assets')).getFileHandle('image.png')).getFile();
    return { directories, source: await (await (await dir.getFileHandle('note.md')).getFile()).text(), size: image.size,
      hidden: await (await (await dir.getFileHandle('.hidden')).getFile()).text() };
  });
  expect(state.source).toBe('# Original\r\n![image](./note.assets/image.png)\r\n');
  expect(state.size).toBeGreaterThan(60); expect(state.hidden).toBe('keep hidden');
  expect(state.directories.includes('old')).toBe(fail);
  expect(writes).toEqual([]);
  if (fail) {
    expect(alerts.join('\n')).toContain('原路径未删除');
    await expect(page.locator('.folder-row').filter({ hasText: /^old$/ })).toBeVisible();
  } else {
    await page.locator('#typora-editor .cm-content').focus();
    await page.keyboard.press('Control+End'); await page.keyboard.type('after rename');
    await expect.poll(() => page.evaluate(async () => {
      const root = (window as any).__migrationRoot;
      return (await (await (await root.getDirectoryHandle('renamed')).getFileHandle('note.md')).getFile()).text();
    })).toContain('after rename');
    await expect.poll(() => page.locator('#typora-editor img[alt="image"]').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
    await page.locator('.folder-row').filter({ hasText: /^renamed$/ }).dragTo(page.locator('.folder-row').filter({ hasText: /^empty$/ }));
    expect(await page.evaluate(async () => {
      const root = (window as any).__migrationRoot;
      const current = await root.getDirectoryHandle('renamed');
      try { await (await current.getDirectoryHandle('empty')).getDirectoryHandle('renamed'); return false; } catch { return true; }
    })).toBe(true);
    await page.locator('.folder-row').filter({ hasText: /^renamed$/ }).dragTo(page.locator('.folder-row').filter({ hasText: /^archive$/ }));
    expect(errors).toEqual([]);
    await expect.poll(() => page.evaluate(async () => {
      try {
        const root = (window as any).__migrationRoot;
        const moved = await (await root.getDirectoryHandle('archive')).getDirectoryHandle('renamed');
        return (await (await moved.getFileHandle('note.md')).getFile()).text();
      } catch { return ''; }
    })).toContain('after rename');
    await expect.poll(() => page.evaluate(async () => {
      const root = (window as any).__migrationRoot;
      try { await root.getDirectoryHandle('renamed'); return true; } catch { return false; }
    })).toBe(false);
    await page.locator('#typora-editor .cm-content').focus();
    await page.keyboard.press('Control+End'); await page.keyboard.type(' after move');
    await expect.poll(() => page.evaluate(async () => {
      const root = (window as any).__migrationRoot;
      const moved = await (await root.getDirectoryHandle('archive')).getDirectoryHandle('renamed');
      return (await (await moved.getFileHandle('note.md')).getFile()).text();
    })).toContain('after move');
  }
  expect(errors).toEqual([]);
});
