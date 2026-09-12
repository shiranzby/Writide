import { test, expect } from '@playwright/test';

async function open(page, content, dark = false) {
  let saved = content;
  await page.addInitScript(dark => localStorage.setItem('paper-settings-v1', JSON.stringify({ theme: dark ? 'dark' : 'light' })), dark);
  await page.route('**/api/**', async route => {
    if (route.request().method() === 'PUT') saved = route.request().postDataJSON().documents[0].content;
    await route.fulfill({ json: { documents: [{ id: 'r60', name: 'R60', content: saved, parentId: null }], folders: [], activeId: 'r60', _revision: 1 } });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  return () => saved;
}

for (const type of ['code', 'math']) for (const dark of [false, true]) {
  test(`${type} visible select-all and left-click dismissal in ${dark ? 'dark' : 'light'}`, async ({ page }, testInfo) => {
    const fence = type === 'code' ? '```' : '$$';
    const source = `before\n\n${fence}\nalpha\n\nbeta\n${fence}\n\nafter`;
    const saved = await open(page, source, dark);
    const root = page.locator('#typora-editor');
    await root.locator(type === 'code' ? '.paper-code-pre' : '.paper-math-block').click();
    const lines = root.locator(type === 'code' ? '[data-code-line]' : '.live-math-source');
    await expect(lines).toHaveCount(3);
    const blank = (await lines.nth(1).boundingBox())!;
    const clip = { x: Math.floor(blank.x + blank.width / 2), y: Math.floor(blank.y + blank.height / 2), width: 8, height: 8 };
    const before = await page.screenshot({ clip });
    await page.keyboard.press('Control+a');
    await expect(root.locator('.paper-selection-layer .cm-selectionBackground').first()).toBeVisible();
    // Sample a blank body's pixels: a CSS color behind an opaque block is not a pass.
    await expect.poll(async () => (await page.screenshot({ clip })).equals(before)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`${type}-selected.png`) });
    await lines.last().click();
    await expect(page.locator('#context-menu')).toBeHidden();
    const selection = (await root.getAttribute('data-source-selection'))!.split(':');
    expect(selection[0]).toBe(selection[1]);
    await lines.last().click({ button: 'right' });
    await expect(page.locator('#context-menu')).toBeVisible();
    await lines.first().click();
    await expect(page.locator('#context-menu')).toBeHidden();
    expect(saved()).toBe(source);
  });
}

for (const mark of ['', '**', '*', '~~', '`']) test(`table visible boundaries with ${mark || 'plain'} text`, async ({ page }) => {
  const source = `before\n\n| A | B |\n| --- | --- |\n| ${mark}one${mark} | ${mark}two${mark} |\n\nafter`;
  const saved = await open(page, source);
  const root = page.locator('#typora-editor');
  await page.getByRole('cell', { name: 'two', exact: true }).click();
  await expect(root).toHaveAttribute('data-source-selection', `${source.indexOf('two')}:${source.indexOf('two')}`);
  await page.keyboard.press('ArrowLeft');
  const end = source.indexOf('one') + 3;
  await expect(root).toHaveAttribute('data-source-selection', `${end}:${end}`);
  await page.keyboard.press('ArrowLeft');
  await expect(root).toHaveAttribute('data-source-selection', `${end - 1}:${end - 1}`);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(root).toHaveAttribute('data-source-selection', `${source.indexOf('two')}:${source.indexOf('two')}`);
  expect(saved()).toBe(source);
});

test('search and replace stay on separate rows at wide and narrow desktop widths', async ({ page }, testInfo) => {
  await open(page, 'Alpha alpha');
  await page.locator('#typora-editor .cm-content').focus();
  await page.keyboard.press('Control+f');
  const panel = page.locator('.cm-search');
  for (const width of [1800, 1000]) {
    await page.setViewportSize({ width, height: 800 });
    const search = (await panel.locator('[name="search"]').boundingBox())!;
    const replace = (await panel.locator('input[name="replace"]').boundingBox())!;
    expect(replace.y).toBeGreaterThanOrEqual(search.y + search.height + 4);
    await expect(panel.locator('[name="word"]')).toBeHidden();
    await expect(panel.locator('[name="case"]')).toBeVisible();
    await expect(panel.locator('[name="re"]')).toBeVisible();
    const bounds = (await panel.boundingBox())!;
    const close = (await panel.locator('button[name="close"]').boundingBox())!;
    const lastOption = (await panel.locator('label:has(input[name="re"])').boundingBox())!;
    const caseOption = (await panel.locator('label:has(input[name="case"])').boundingBox())!;
    expect(Math.abs(lastOption.y - replace.y)).toBeLessThan(2);
    expect(Math.abs(caseOption.y - search.y)).toBeLessThan(2);
    expect(lastOption.x).toBe(caseOption.x);
    const fonts = await panel.evaluate(el => [...['button[name="select"]', 'label:has(input[name="case"])', 'label:has(input[name="re"])', 'input[name="search"]', 'input[name="replace"]']
      .map(selector => getComputedStyle(el.querySelector(selector)!).fontSize),
      ...['search', 'replace'].map(name => getComputedStyle(el.querySelector(`input[name="${name}"]`)!, '::placeholder').fontSize)]);
    expect(new Set(fonts).size).toBe(1);
    expect(lastOption.x + lastOption.width).toBeLessThanOrEqual(close.x);
    expect(close.x + close.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    await page.screenshot({ path: testInfo.outputPath(`search-${width}.png`) });
  }
});
