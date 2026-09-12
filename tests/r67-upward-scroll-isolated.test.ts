import { test, expect } from '@playwright/test';

test('upward wheel reading is not pulled down when later images finish loading', async ({ page }) => {
  const source = '# Start\n\n' + 'before paragraph\n\n'.repeat(30) + '## Reading\n\n'
    + 'reading paragraph\n\n'.repeat(4)
    + Array.from({ length: 12 }, (_, i) => `![later ${i}](/r67-${i}.svg)`).join(' ') + '\n\nend\n';
  let released = false;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/workspace', route => route.fulfill({ json: {
    documents: [{ id: 'r67', name: 'R67', content: source }], folders: [], activeId: 'r67', _revision: 1,
  } }));
  await page.route('**/r67-*.svg', async route => {
    while (!released) await new Promise(resolve => setTimeout(resolve, 20));
    await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="1100"><rect width="500" height="1100" fill="#729e83"/></svg>' });
  });
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
    await page.locator('[data-panel="outline"]').click();
    await page.locator('.outline-row').filter({ hasText: /^Reading$/ }).click();
    const surface = page.locator('#typora-view');
    const reading = page.locator('#typora-editor .cm-line').filter({ hasText: /^## Reading$/ });
    await expect(reading).toBeInViewport();
    const before = await surface.evaluate(el => el.scrollTop);
    await surface.hover(); await page.mouse.wheel(0, -150);
    await expect.poll(() => surface.evaluate(el => el.scrollTop)).toBeLessThan(before - 100);
    const chosen = await surface.evaluate(el => ({ top: el.scrollTop, total: el.scrollHeight }));
    released = true;
    await expect.poll(() => surface.evaluate(el => el.scrollHeight)).toBeGreaterThan(chosen.total + 5000);
    await expect.poll(() => surface.evaluate(el => el.scrollTop)).toBeLessThanOrEqual(chosen.top + 30);
    await expect(reading).toBeInViewport();
    for (let i = 0; i < 3; i++) {
      const top = await surface.evaluate(el => el.scrollTop);
      await page.mouse.wheel(0, -200);
      await expect.poll(() => surface.evaluate(el => el.scrollTop)).toBeLessThan(top - 100);
    }
    expect(errors).toEqual([]);
    expect(await page.locator('#typora-editor .cm-content').evaluate((el: any) => el.cmTile.root.view.state.doc.toString())).toBe(source);
  } finally { released = true; }
});
