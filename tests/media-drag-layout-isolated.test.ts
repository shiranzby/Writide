import { test, expect } from '@playwright/test';

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

for (const [startProgress, progress] of [[0, .25], [0, .5], [0, .8], [.8, .25]]) {
  test(`delayed images keep the held scrollbar geometry stable ${startProgress} to ${progress}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const source = 'opening\n\n' + Array.from({ length: 30 }, (_, i) => `section ${i}\n\n![photo ${i}](/stable-drag-${i}.svg)\n\n`).join('') + 'ending';
    await page.route('**/api/workspace', route => route.fulfill({ json: {
      documents: [{ id: 'stable-drag', name: 'Drag', content: source }], folders: [], activeId: 'stable-drag', _revision: 1,
    } }));
    let released = false;
    await page.route('**/stable-drag-*.svg', async route => {
      while (!released) await new Promise(resolve => setTimeout(resolve, 20));
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="1200"><rect width="500" height="1200" fill="#729e83"/></svg>' });
    });
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
      const surface = page.locator('#typora-view');
      if (startProgress) {
        await surface.evaluate((el, p) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * p; }, startProgress);
        await page.waitForTimeout(200);
      }
      const d = await surface.evaluate(el => {
        const r = el.getBoundingClientRect();
        return { x: r.right - 7, top: r.top, height: el.clientHeight, total: el.scrollHeight, scroll: el.scrollTop };
      });
      const thumb = d.height * d.height / d.total;
      const firstY = d.top + thumb / 2 + (d.height - thumb) * d.scroll / (d.total - d.height);
      const targetY = d.top + thumb / 2 + (d.height - thumb) * progress;
      // Native arrow buttons/minimum thumb size vary across platforms. First
      // measure this identical gesture with image responses still blocked.
      await page.mouse.move(d.x, firstY); await page.mouse.down();
      await page.mouse.move(d.x, targetY, { steps: 12 }); await page.mouse.up();
      const expectedProgress = await surface.evaluate(el => el.scrollTop / (el.scrollHeight - el.clientHeight));
      await surface.evaluate((el, top) => { el.scrollTop = top; }, d.scroll);
      await page.waitForTimeout(100);
      await page.mouse.move(d.x, firstY); await page.mouse.down();
      await page.mouse.move(d.x, firstY + (targetY - firstY) / 2, { steps: 6 });
      released = true;
      await expect.poll(() => page.locator('#typora-editor img').evaluateAll(images => images.some((img: HTMLImageElement) => img.naturalHeight === 1200))).toBe(true);
      await page.mouse.move(d.x, targetY, { steps: 6 });
      await page.waitForTimeout(180);
      expect(Math.abs(await surface.evaluate(el => el.scrollHeight) - d.total)).toBeLessThan(30);
      const selected = await surface.evaluate(el => el.scrollTop / (el.scrollHeight - el.clientHeight));
      expect(Math.abs(selected - expectedProgress), JSON.stringify({ d, selected, expectedProgress, errors })).toBeLessThan(.015);
      const anchor = await page.locator('#typora-editor .cm-content').evaluate((el: any) => {
        const view = el.cmTile.root.view, surface = el.closest('#typora-view').getBoundingClientRect();
        const block = view.lineBlockAtHeight(surface.top + 80 - view.documentTop);
        return { from: block.from, offset: block.top + view.documentTop - surface.top };
      });
      await page.mouse.up();
      await page.waitForTimeout(350);
      const offset = await page.locator('#typora-editor .cm-content').evaluate((el: any, from) => {
        const view = el.cmTile.root.view;
        return view.lineBlockAt(from).top + view.documentTop - el.closest('#typora-view').getBoundingClientRect().top;
      }, anchor.from);
      expect(Math.abs(offset - anchor.offset)).toBeLessThan(35);
      if (progress === .5) await page.screenshot({ path: info.outputPath('released-source-anchor.png') });
      expect(await page.locator('#typora-editor .cm-content').evaluate((el: any) => el.cmTile.root.view.state.doc.toString())).toBe(source);
      const top = await surface.evaluate(el => el.scrollTop);
      await surface.hover(); await page.mouse.wheel(0, -300);
      await expect.poll(() => surface.evaluate(el => el.scrollTop)).toBeLessThan(top - 100);
      expect(errors).toEqual([]);
    } finally { released = true; await page.mouse.up(); }
  });
}
