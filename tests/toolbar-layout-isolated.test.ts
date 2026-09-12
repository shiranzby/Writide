import { test, expect } from '@playwright/test';

test('toolbar divider aligns across the resize strip and the setting survives reload', async ({ page }, info) => {
  const source = '# Writide\n\n以 Markdown 原文为核心的本地优先编辑器。\n\n## 当前工作\n\n- [x] 连续实时渲染\n- [x] 本地目录与 WebDAV\n- [x] KaTeX、Mermaid 与表格\n\n| 工作区 | 状态 |\n| --- | --- |\n| 本地目录 | 可用 |\n| WebDAV | 可用 |';
  await page.route('**/api/workspace', route => route.fulfill({ json: {
    documents: [{ id: 'toolbar', name: 'Writide Demo', content: source }], folders: [], activeId: 'toolbar',
  } }));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  const toolbar = page.locator('.format-toolbar');
  for (const width of [1280, 1000]) {
    await page.setViewportSize({ width, height: 800 });
    const geometry = await page.evaluate(() => {
      const tabs = document.querySelector('.sidebar-tabs').getBoundingClientRect();
      const bar = document.querySelector('.format-toolbar').getBoundingClientRect();
      const strip = document.querySelector('.sidebar-resizer');
      const rect = strip.getBoundingClientRect(), line = getComputedStyle(strip, '::before');
      return { left: tabs.bottom, right: bar.bottom, bridge: rect.top + parseFloat(line.top) + parseFloat(line.borderTopWidth), gap: bar.left - rect.right };
    });
    expect(Math.abs(geometry.left - geometry.right)).toBeLessThan(1);
    expect(Math.abs(geometry.bridge - geometry.right)).toBeLessThan(1);
    expect(Math.abs(geometry.gap)).toBeLessThan(1);
  }
  await page.screenshot({ path: info.outputPath('toolbar-on.png') });
  await page.locator('[data-command="settings"]').first().click();
  await page.locator('[data-settings-tab="appearance"]').click();
  await page.locator('#setting-toolbar').uncheck();
  await expect(toolbar).toBeHidden();
  await page.locator('[data-command="close-settings"]').click();
  expect(await page.locator('#typora-view').evaluate(el => el.getBoundingClientRect().top - document.querySelector('.app-header').getBoundingClientRect().bottom)).toBe(0);
  expect(await page.locator('.sidebar-resizer').evaluate(el => getComputedStyle(el, '::before').display)).toBe('none');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await expect(toolbar).toBeHidden();
  await page.screenshot({ path: info.outputPath('toolbar-off.png') });
  await page.locator('[data-command="settings"]').first().click();
  await page.locator('[data-settings-tab="appearance"]').click();
  await expect(page.locator('#setting-toolbar')).not.toBeChecked();
  await page.locator('#setting-toolbar').check();
  await page.locator('[data-theme="dark"]').click();
  await page.locator('[data-command="close-settings"]').click();
  await expect(toolbar).toBeVisible();
  await page.screenshot({ path: info.outputPath('toolbar-dark.png') });
  expect(await page.locator('#typora-editor .cm-content').evaluate((el: any) => el.cmTile.root.view.state.doc.toString())).toBe(source);
});
