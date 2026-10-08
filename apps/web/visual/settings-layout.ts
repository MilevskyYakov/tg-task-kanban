import { expect, type Page } from '@playwright/test';

export async function assertSettingsLayout(page: Page, selector: string) {
  await page.evaluate(() => document.fonts.ready);
  const scope = page.locator(selector);
  await expect(scope.first()).toBeVisible();
  const overflow = await scope.locator('*').evaluateAll(elements => elements.filter(element => {
    if (!(element instanceof HTMLElement) || !element.getClientRects().length) return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1);
  }).map(element => `${element.tagName}.${element.className}`));
  expect(overflow, 'Settings content must not extend outside the viewport').toEqual([]);
  // One DOM snapshot: an async state change must not invalidate indexed locators mid-loop.
  const targets = await scope.locator('button, input:not([type=hidden]), select').evaluateAll(elements => elements.filter(element => element.getClientRects().length).map(element => {
    const target = element instanceof HTMLInputElement && element.type === 'checkbox' ? element.parentElement! : element;
    const { width, height } = target.getBoundingClientRect();
    return { width, height };
  }));
  for (const target of targets) {
    expect(target.height, 'Touch target height').toBeGreaterThanOrEqual(44);
    expect(target.width, 'Touch target width').toBeGreaterThanOrEqual(44);
  }
}
