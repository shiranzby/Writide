import { test, expect } from '@playwright/test';

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

test('scrollbar reaches the end when images load during the held drag', async ({ page }) => {
  const source = 'opening\n\n' + Array.from({ length: 24 }, (_, i) => `section ${i}\n\n![image ${i}](/drag-${i}.svg)\n\n`).join('') + 'ending';
  await page.route('**/api/**', route => route.fulfill({ json: {
    documents: [{ id: 'drag', name: 'Drag', content: source }], folders: [], activeId: 'drag', _revision: 1,
  } }));
  let released = -1;
  await page.route('**/drag-*.svg', async route => {
    const index = Number(route.request().url().match(/drag-(\d+)/)![1]);
    while (index > released) await new Promise(resolve => setTimeout(resolve, 20));
    await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="1400"><rect width="500" height="1400" fill="#9ab2c0"/></svg>' });
  });
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
    const surface = page.locator('#typora-view');
    const originalHead = await page.locator('#typora-editor .cm-content').evaluate((el: any) => el.cmTile.root.view.state.selection.main.head);
    const d = await surface.evaluate(el => {
      const r = el.getBoundingClientRect();
      return { x: r.right - 7, top: r.top, bottom: r.bottom, height: el.clientHeight, total: el.scrollHeight };
    });
    const start = d.top + d.height * d.height / d.total / 2;
    await page.mouse.move(d.x, start);
    await page.mouse.down();
    for (let step = 1; step <= 10; step++) {
      released = step * 2;
      await page.mouse.move(d.x, start + (d.bottom - 3 - start) * step / 10, { steps: 4 });
      await page.waitForTimeout(100);
    }
    await page.mouse.up();
    released = 100;
    await expect.poll(() => surface.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(3);
    await expect(page.locator('#typora-editor .cm-line').filter({ hasText: /^ending$/ })).toBeInViewport();
    expect(await page.locator('#typora-editor .cm-content').evaluate((el: any) => el.cmTile.root.view.state.selection.main.head)).toBe(originalHead);
    const end = await surface.evaluate(el => el.scrollTop);
    await surface.hover(); await page.mouse.wheel(0, -600);
    await expect.poll(() => surface.evaluate(el => el.scrollTop)).toBeLessThan(end - 100);
  } finally { released = 100; }
});

for (const progress of [1, .5]) for (const afterWheel of [false, true]) test(`first image load preserves a real scrollbar drag to ${progress}${afterWheel ? ' after wheel reading' : ''}`, async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const source = 'opening\n\n' + Array.from({ length: 12 }, (_, i) => `section ${i}\n\n![image ${i}](/r62-${i}.svg)\n\n`).join('') + 'ending';
  await page.route('**/api/**', route => route.fulfill({ json: {
    documents: [{ id: 'r62', name: 'R62', content: source }], folders: [], activeId: 'r62', _revision: 1,
  } }));
  let released = false;
  await page.route('**/r62-*.svg', async route => {
    while (!released) await new Promise(resolve => setTimeout(resolve, 50));
    await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="1100"><rect width="500" height="1100" fill="#9ab2c0"/></svg>' });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  const surface = page.locator('#typora-view');
  if (afterWheel) {
    await surface.hover();
    await page.mouse.wheel(0, 200);
    await expect.poll(() => surface.evaluate(el => el.scrollTop)).toBeGreaterThan(50);
    await page.mouse.wheel(0, -600);
    await expect.poll(() => surface.evaluate(el => el.scrollTop)).toBeLessThan(3);
  }
  const dimensions = await surface.evaluate(el => {
    const r = el.getBoundingClientRect();
    return { x: r.right - 7, top: r.top, bottom: r.bottom, height: el.clientHeight, total: el.scrollHeight };
  });
  expect(dimensions.total).toBeGreaterThan(dimensions.height);
  const thumbHeight = dimensions.height * dimensions.height / dimensions.total;
  await page.mouse.move(dimensions.x, dimensions.top + thumbHeight / 2);
  await page.mouse.down();
  await page.mouse.move(dimensions.x, progress === 1 ? dimensions.bottom - 3
    : dimensions.top + thumbHeight / 2 + (dimensions.height - thumbHeight) * progress, { steps: 10 });
  if (progress === 1) await page.mouse.up();
  const atBottom = () => surface.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  const actualProgress = () => surface.evaluate(el => el.scrollTop / (el.scrollHeight - el.clientHeight));
  if (progress === 1) await expect.poll(atBottom).toBeLessThan(3);
  else await expect.poll(actualProgress).toBeGreaterThan(.3);
  const chosen = await actualProgress();
  if (progress === .5) expect(chosen).toBeLessThan(.7);
  const anchor = progress === .5 ? await page.locator('#typora-editor .cm-content').evaluate((el: any) => {
    const view = el.cmTile.root.view, surface = el.closest('#typora-view').getBoundingClientRect();
    const block = view.lineBlockAtHeight(surface.top + 80 - view.documentTop);
    return { from: block.from, offset: block.top + view.documentTop - surface.top };
  }) : null;
  released = true;
  if (progress === .5) {
    await expect.poll(() => page.locator('#typora-editor img').evaluateAll(images => images.some((img: HTMLImageElement) => img.naturalHeight > 0))).toBe(true);
    expect(Math.abs(await surface.evaluate(el => el.scrollHeight) - dimensions.total)).toBeLessThan(30);
    await expect.poll(async () => Math.abs(await actualProgress() - chosen)).toBeLessThan(.02);
    await page.mouse.up();
    // R74: after release preserve the selected source block, not a changing ratio.
    await expect.poll(() => page.locator('#typora-editor .cm-content').evaluate((el: any, anchor) => {
      const view = el.cmTile.root.view;
      return Math.abs(view.lineBlockAt(anchor.from).top + view.documentTop - el.closest('#typora-view').getBoundingClientRect().top - anchor.offset);
    }, anchor)).toBeLessThan(35);
  } else await expect.poll(async () => Math.abs(await actualProgress() - chosen)).toBeLessThan(.02);
  await expect.poll(() => surface.evaluate(el => el.scrollHeight)).toBeGreaterThan(dimensions.total + 3000);
  if (progress === 1) {
    await expect.poll(atBottom).toBeLessThan(3);
    await expect(page.locator('#typora-editor .cm-line').filter({ hasText: /^ending$/ })).toBeInViewport();
  }
  const beforeUp = await surface.evaluate(el => el.scrollTop);
  await page.mouse.move(800, 400);
  await page.mouse.wheel(0, -600);
  await expect.poll(() => surface.evaluate(el => el.scrollTop)).toBeLessThan(beforeUp - 100);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('initial-images-scroll.png') });
});
