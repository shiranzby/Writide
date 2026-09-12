import { test, expect } from '@playwright/test';

test('wrapped preview and active code keep physical lines, gutters and copy text', async ({ page, context }, testInfo) => {
  const long = '/* ' + 'long highlighted comment '.repeat(12);
  const body = `${long}\nsecond comment */\n\nfinish();`;
  const source = `before\n\n\`\`\`javascript\n${body}\n\`\`\`\n\nafter`;
  let saved = source;
  await page.addInitScript(() => localStorage.setItem('paper-settings-v1', JSON.stringify({ codeWrap: true })));
  await page.route('**/api/**', async route => {
    if (route.request().method() === 'PUT') saved = route.request().postDataJSON().documents[0].content;
    await route.fulfill({ json: { documents: [{ id: 'wrap', name: 'Wrap', content: saved, parentId: null }], folders: [], activeId: 'wrap', _revision: 1 } });
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  const root = page.locator('#typora-editor');
  const code = root.locator('.paper-code-pre code');
  const metrics = await code.evaluate(el => ({ height: el.getBoundingClientRect().height,
    lineHeight: parseFloat(getComputedStyle(el).lineHeight), width: el.clientWidth, scrollWidth: el.scrollWidth }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width + 1);
  expect(metrics.height).toBeGreaterThan(metrics.lineHeight * 5);
  await expect(code).toHaveText(body);
  const lines = code.locator('.paper-code-source-line');
  await expect(lines).toHaveCount(4);
  await expect(lines.nth(1).locator('.hljs-comment')).toHaveText('second comment */');
  const boxes = await lines.evaluateAll(els => els.map(el => {
    const box = el.getBoundingClientRect();
    return { y: box.y, height: box.height, number: getComputedStyle(el, '::before').content };
  }));
  expect(boxes[0].height).toBeGreaterThan(metrics.lineHeight * 2);
  expect(boxes[2].height).toBeGreaterThanOrEqual(metrics.lineHeight - 1);
  boxes.forEach((box, i) => {
    expect(box.number).toBe(`"${i + 1}"`);
    if (i) expect(Math.abs(box.y - boxes[i - 1].y - boxes[i - 1].height)).toBeLessThan(1);
  });
  await lines.last().click({ position: { x: 60, y: 10 } });
  const active = root.locator('.cm-line[data-code-line]');
  await expect(active).toHaveCount(4);
  const activeMetrics = await active.evaluateAll(els => els.map(el => {
    const style = getComputedStyle(el), number = getComputedStyle(el, '::before');
    return { height: el.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight),
      number: number.content, font: style.fontSize, numberFont: number.fontSize,
      top: parseFloat(number.top), padding: parseFloat(style.paddingTop) };
  }));
  expect(activeMetrics[0].height).toBeGreaterThan(activeMetrics[0].lineHeight * 2);
  activeMetrics.forEach((row, i) => {
    expect(row.number).toBe(`"${i + 1}"`);
    expect(row.numberFont).toBe(row.font);
    expect(row.top).toBe(row.padding);
  });
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(body);
  expect(saved).toBe(source);
  await page.getByRole('button', { name: '视图', exact: true }).click();
  await page.getByRole('button', { name: '源码 / 预览分栏', exact: true }).click();
  const preview = page.locator('#split-preview .paper-code-pre code');
  await expect(preview).toHaveText(body);
  expect(await preview.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('wrapped-code-split.png') });
  await page.locator('[data-command="settings"]').first().click();
  await page.locator('[data-settings-tab="markdown"]').click();
  await page.locator('#setting-code-wrap').uncheck();
  await page.locator('[data-command="close-settings"]').click();
  const scroller = page.locator('#split-preview .paper-code-preview-body');
  await expect.poll(() => scroller.evaluate(el => el.scrollWidth > el.clientWidth + 100)).toBe(true);
  await expect(page.locator('#split-preview .paper-code-gutter')).toBeVisible();
  await expect(page.locator('#split-preview .paper-code-gutter')).toHaveText('1\n2\n3\n4');
  await page.locator('[data-command="settings"]').first().click();
  await page.locator('#setting-code-wrap').check();
  await page.locator('[data-command="close-settings"]').click();
  await page.locator('#theme-toggle').click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(() => scroller.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await expect(preview).toHaveText(body);
  expect(saved).toBe(source);
  await expect(page.locator('#split-view .cm-selectionBackground').first()).toHaveCSS('background-color', 'rgba(128, 128, 128, 0.22)');
  await page.screenshot({ path: testInfo.outputPath('wrapped-code-dark.png') });
});
