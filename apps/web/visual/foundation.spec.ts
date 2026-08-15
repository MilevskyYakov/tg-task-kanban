import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));

for (const width of [390, 320]) {
  test(`foundation ${width}x844 is stable, local and accessible`, async ({ page }) => {
    const fontRequests: string[] = [];
    page.on('request', (request) => { if (request.resourceType() === 'font') fontRequests.push(request.url()); });
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/?fixture=foundation');
    await page.evaluate(() => document.fonts.ready);

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(255, 255, 255)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(fontRequests.length).toBeGreaterThan(0);
    expect(fontRequests.every((url) => new URL(url).origin === 'http://127.0.0.1:4173')).toBe(true);

    const opener = page.getByRole('button', { name: /Доска.*Kairos/ });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Выберите доску' });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('button', { name: 'Закрыть' })).toBeFocused();
    for (const button of await dialog.getByRole('button').all()) {
      const box = await button.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    }
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: /Личные задачи/ })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Закрыть' })).toBeFocused();

    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/foundation-sheet-${width}x844.png` });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await page.screenshot({ path: `${evidence}/foundation-${width}x844.png` });

    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button, input')].every((element) => element.scrollHeight <= element.offsetHeight || getComputedStyle(element).overflowY !== 'hidden'))).toBe(true);
  });
}

test('boot survives unavailable WebView storage', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      Object.defineProperty(Storage.prototype, method, { value: () => { throw new DOMException('denied', 'SecurityError'); } });
    }
  });
  await page.goto('/?fixture=foundation');
  expect(errors).toEqual([]);
  await expect(page.locator('.foundation-fixture')).toBeVisible();
});
