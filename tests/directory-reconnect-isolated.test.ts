import { test, expect } from '@playwright/test';

async function installStoredDirectory(page, permission: 'prompt' | 'granted' = 'prompt', second = false) {
  const requests: string[] = [];
  await page.route('**/api/**', async route => {
    requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await route.fulfill({ status: 500, json: { error: 'Mapped directory must not use server workspace' } });
  });
  await page.addInitScript(({ permission, second }) => {
    let granted = sessionStorage.getItem('test-granted') === 'yes' || permission === 'granted';
    (window as any).__permissionReply = 'granted';
    const source = 'before\n\n![sample](./assets/sample.png)\n\nafter';
    const file = {
      kind: 'file', name: 'mapped.md',
      getFile: async () => new File([sessionStorage.getItem('test-content') || source], 'mapped.md'),
      createWritable: async () => ({
        write: async (value: string) => sessionStorage.setItem('test-content', value), close: async () => {},
      }),
    };
    const root: any = {
      kind: 'directory', name: 'SavedNotes',
      queryPermission: async () => granted ? 'granted' : 'prompt',
      requestPermission: async () => {
        const reply = (window as any).__permissionReply;
        granted = reply === 'granted';
        if (granted) sessionStorage.setItem('test-granted', 'yes');
        return reply;
      },
      entries: async function* () {
        if (!granted) throw new Error('Reading before authorization');
        if (sessionStorage.getItem('test-deleted') !== 'yes') yield ['mapped.md', file];
        if (second) yield ['z-last.md', { ...file, name: 'z-last.md', getFile: async () => new File(['last document'], 'z-last.md') }];
      },
      getDirectoryHandle: async (name: string) => {
        if (name !== 'assets') throw new Error('Unknown folder');
        return { getFileHandle: async () => ({ getFile: async () => {
          const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII='), c => c.charCodeAt(0));
          return new File([png], 'sample.png', { type: 'image/png' });
        } }) };
      },
      getFileHandle: async () => file,
    };
    // Keep real IndexedDB lifecycle; substitute only the unserializable test handle.
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function(key) {
      const request = get.call(this, key);
      if (this.name === 'handles' && key === 'active-directory') {
        Object.defineProperty(request, 'result', { get: () => root });
      }
      return request;
    };
    (window as any).showDirectoryPicker = async () => { throw new Error('Existing handle must be reused'); };
  }, { permission, second });
  return requests;
}

test('stored directory prompts to reconnect, then restores images and source writes without server fallback', async ({ page }) => {
  const requests = await installStoredDirectory(page);
  await page.goto('/');
  const root = page.locator('#workspace-root-drop');
  await expect(root).toHaveAttribute('data-provider-kind', 'directory-pending');
  await expect(root).toContainText('SavedNotes（重新连接）');
  await expect(page.locator('#save-state')).toHaveText('目录待连接');
  await expect(page.locator('#file-list .file-row')).toHaveCount(0);
  expect(await page.locator('#typora-view').evaluate(el => el.inert)).toBe(true);
  expect(requests).toEqual([]);
  await root.click();
  await expect(root).toHaveAttribute('data-provider-kind', 'directory');
  await expect(page.locator('#file-list .file-row')).toHaveCount(1);
  const image = page.locator('#typora-editor img[alt="sample"]');
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
  await page.locator('#typora-editor .cm-content').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' saved');
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('test-content'))).toBe('before\n\n![sample](./assets/sample.png)\n\nafter saved');
  await page.reload();
  await expect(root).toHaveAttribute('data-provider-kind', 'directory');
  await expect(page.locator('#typora-editor .cm-content')).toContainText('after saved');
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
  expect(requests).toEqual([]);
});

test('mapped workspace restores the last clicked path rather than the first scanned file', async ({ page }) => {
  const requests = await installStoredDirectory(page, 'granted', true);
  await page.goto('/');
  await page.locator('.file-row').filter({ hasText: 'z-last' }).click();
  await page.reload();
  await expect(page.locator('.file-row.active')).toContainText('z-last');
  await expect(page.locator('#typora-editor .cm-content')).toContainText('last document');
  expect(requests).toEqual([]);
});

test('denied reconnect stays pending and retries; externally removed documents never return', async ({ page }) => {
  const requests = await installStoredDirectory(page);
  await page.goto('/');
  const root = page.locator('#workspace-root-drop');
  await expect(root).toHaveAttribute('data-provider-kind', 'directory-pending');
  await page.evaluate(() => { (window as any).__permissionReply = 'denied'; });
  page.once('dialog', dialog => dialog.accept());
  await root.click();
  await expect(root).toHaveAttribute('data-provider-kind', 'directory-pending');
  await expect(root).toBeEnabled();
  expect(requests).toEqual([]);
  await page.evaluate(() => { (window as any).__permissionReply = 'granted'; sessionStorage.setItem('test-deleted', 'yes'); });
  await root.click();
  await expect(root).toHaveAttribute('data-provider-kind', 'directory');
  await expect(page.locator('#file-list .file-row')).toHaveCount(0);
  await page.reload();
  await expect(root).toHaveAttribute('data-provider-kind', 'directory');
  await expect(page.locator('#file-list .file-row')).toHaveCount(0);
  expect(requests).toEqual([]);
});
