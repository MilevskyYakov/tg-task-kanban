import { expect, type Locator, type Page } from '@playwright/test';

// Deterministic viewport geometry, not a physical iOS/Android keyboard test.
export async function setKeyboardViewport(page: Page, height: number, offsetTop = 0, scale = 1) {
  await page.evaluate(({ height, offsetTop, scale }) => {
    const viewport = window.visualViewport!;
    Object.defineProperties(viewport, {
      height: { configurable: true, get: () => height },
      offsetTop: { configurable: true, get: () => offsetTop },
      scale: { configurable: true, get: () => scale }
    });
    viewport.dispatchEvent(new Event('resize'));
  }, { height, offsetTop, scale });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

export async function expectEditorAboveKeyboard(editor: Locator, height: number, offsetTop = 0) {
  await expect.poll(() => editor.evaluate((element, { height, offsetTop }) => {
    const rect = element.getBoundingClientRect();
    return { above: Math.max(0, offsetTop - rect.top), below: Math.max(0, rect.bottom - offsetTop - height) };
  }, { height, offsetTop })).toEqual({ above: 0, below: 0 });
}
