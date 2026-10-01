import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));
for (const [width, height] of [[1440, 1000], [390, 844], [320, 844], [320, 520]]) {
  test(`landing content, configured entry and accessibility ${width}x${height}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.abort());
    await page.route('**/api/bot-entry', (route) => route.fulfill({ json: { botUrl: 'https://t.me/current_test_bot?start=landing' } }));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Дела под рукой' })).toBeVisible();
    const cta = page.getByRole('link', { name: 'Открыть в Telegram', exact: true }).first();
    await expect(cta).toHaveAttribute('href', 'https://t.me/current_test_bot?start=landing');
    await expect(cta).toBeInViewport();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'К содержанию' })).toBeFocused();
    await page.getByRole('heading', { name: 'Дела под рукой' }).click();
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'Таска — дела под рукой');
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/brand/favicon.png');
    expect(await page.locator('.landing-preview img').evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
    await page.evaluate(() => document.fonts.ready);
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/landing-${width}x${height}.png`, fullPage: true });
    await page.getByText('Telegram не открылся?', { exact: true }).click();
    await expect(page.getByRole('link', { name: '@current_test_bot' })).toHaveAttribute('href', 'https://t.me/current_test_bot?start=landing');
    await page.route('**/fonts/**', (route) => route.abort());
    await page.addStyleTag({ content: ':root { font-size: 200%; --font-ui: system-ui, sans-serif; } * { backdrop-filter: none !important; }' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await cta.scrollIntoViewIfNeeded();
    await expect(cta).toBeInViewport();
    const box = await cta.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(errors).toEqual([]);
  });
}

test('landing never invents a bot URL on unavailable or untrusted configuration', async ({ page }) => {
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ body: '' }));
  let mode = 'offline';
  await page.route('**/api/bot-entry', (route) => mode === 'offline' ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: { botUrl: mode === 'hostile' ? 'https://example.test/steal' : 'https://t.me/current_test_bot?start=landing' } }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Не удалось подготовить вход');
  await expect(page.getByRole('link', { name: 'Открыть в Telegram' })).toHaveCount(0);
  mode = 'hostile';
  await page.getByRole('button', { name: 'Повторить', exact: true }).first().click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('a[href*="example.test"]')).toHaveCount(0);
  mode = 'ready';
  await page.getByRole('button', { name: 'Повторить', exact: true }).first().click();
  await expect(page.getByRole('link', { name: 'Открыть в Telegram' }).first()).toHaveAttribute('href', 'https://t.me/current_test_bot?start=landing');
});
