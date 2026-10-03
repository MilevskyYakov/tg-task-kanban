import { expect, test } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/issue-170/', import.meta.url));
for (const [width, height] of [[1920, 1080], [1440, 1000], [1024, 768], [768, 1024], [390, 844], [320, 844], [320, 520]]) {
  test(`landing content, configured entry and accessibility ${width}x${height}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.abort());
    await page.route('**/api/bot-entry', (route) => route.fulfill({ json: { botUrl: 'https://t.me/current_test_bot?start=landing' } }));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Дела — рядом с перепиской' })).toBeVisible();
    const cta = page.getByRole('link', { name: 'Открыть в Telegram', exact: true }).first();
    await expect(cta).toHaveAttribute('href', 'https://t.me/current_test_bot?start=landing');
    await expect(cta).toBeInViewport();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'К содержанию' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#landing-content')).toBeFocused();
    await page.locator('#landing-content').evaluate((node) => (node as HTMLElement).blur());
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'Таска — дела под рукой');
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/brand/favicon.png');
    await expect(page.locator('.landing-label, .landing-scenario-number, .landing-preview figcaption')).toHaveCount(0);
    await expect(page.locator('.landing-section-rule')).toBeEmpty();
    await expect(page.locator('.landing-step-number')).toHaveText(['1', '2', '3']);
    await expect(page.locator('.landing details')).not.toContainText('Кнопка ведёт в бота, а не подтверждает вход.');
    await expect(page.locator('.landing-footer')).toContainText('Создано kAIros');
    await expect(page.locator('.landing-phone-screen img')).toHaveAttribute('alt', /демонстрационные задачи/);
    await expect(page.locator('.landing-phone-screen img')).toHaveJSProperty('naturalWidth', 880);
    await expect(page.locator('.landing-phone')).toHaveAttribute('data-device', 'iphone-17-pro-max');
    await expect(page.locator('.landing-dynamic-island')).toBeVisible();
    await expect(page.locator('.landing-start-art')).toBeVisible();
    await expect(page.locator('.landing img[src*="app-preview"]')).toHaveCount(0);
    const capture = JSON.parse(await readFile(new URL('../../../artifacts/ux/issue-170/asset-capture.json', import.meta.url), 'utf8'));
    expect(JSON.stringify(capture)).not.toMatch(/Primex|kAIros|VPN|Task Kanban/i);
    const cards = page.locator('.landing-hero-fragment img, .landing-task-fragment img, .landing-group-fragment img, .landing-start-task img');
    await expect(cards).toHaveCount(6);
    for (const card of await cards.all()) {
      await card.scrollIntoViewIfNeeded();
      await expect(card).toHaveJSProperty('complete', true);
      const dimensions = await card.evaluate((node: HTMLImageElement) => ({
        width: node.offsetWidth, height: node.offsetHeight, naturalWidth: node.naturalWidth, naturalHeight: node.naturalHeight,
        parentWidth: node.parentElement!.clientWidth, parentHeight: node.parentElement!.clientHeight,
        position: getComputedStyle(node).position, bounds: node.getBoundingClientRect().toJSON()
      }));
      expect(dimensions.naturalWidth).toBeGreaterThan(0);
      expect(dimensions.position).toBe('static');
      expect(Math.abs(dimensions.height - dimensions.width * dimensions.naturalHeight / dimensions.naturalWidth)).toBeLessThanOrEqual(1);
      expect(dimensions.width).toBeLessThanOrEqual(dimensions.parentWidth + 1);
      expect(dimensions.height).toBeLessThanOrEqual(dimensions.parentHeight + 1);
      expect(dimensions.bounds.x).toBeGreaterThanOrEqual(0);
      expect(dimensions.bounds.right).toBeLessThanOrEqual(width);
    }
    const copy = await readFile(new URL('../../../artifacts/ux/issue-170/approved-copy.md', import.meta.url), 'utf8');
    const paragraphs = copy.split('## Дословные принятые тексты')[1]!.split('## Подтверждение')[0]!
      .split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && !line.startsWith('**'));
    for (const paragraph of paragraphs) await expect(page.getByText(paragraph, { exact: true }).first()).toBeVisible();
    for (const name of ['Для себя', 'Вдвоём', 'В группе', 'Начать просто', 'Пусть договорённости становятся делами']) {
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    await expect(page.locator('.landing-cta')).toHaveCount(3);
    for (const link of await page.locator('.landing-cta').all()) await expect(link).toHaveAttribute('href', 'https://t.me/current_test_bot?start=landing');
    await page.evaluate(() => document.fonts.ready);
    await mkdir(evidence, { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${evidence}/landing-${width}x${height}.png`, fullPage: true });
    await page.getByText('Telegram не открылся?', { exact: true }).click();
    await expect(page.getByRole('link', { name: '@current_test_bot' })).toHaveAttribute('href', 'https://t.me/current_test_bot?start=landing');
    const initialFontSize = await page.locator('.landing-intro').evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    await page.addStyleTag({ content: ':root { font-size: 200%; --font-ui: system-ui, sans-serif; } * { backdrop-filter: none !important; }' });
    await expect.poll(() => page.locator('.landing-intro').evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBe(initialFontSize * 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const link of await page.locator('.landing-cta').all()) {
      await link.scrollIntoViewIfNeeded();
      await expect(link).toBeInViewport({ ratio: 1 });
      const box = await link.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: `${evidence}/landing-large-text-${width}x${height}.png`, fullPage: true });
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

test('landing remains usable without font, blur or motion', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.abort());
  await page.route('**/fonts/**', (route) => route.abort());
  await page.route('**/api/bot-entry', (route) => route.fulfill({ json: { botUrl: 'https://t.me/current_test_bot?start=landing' } }));
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: '.landing * { backdrop-filter: none !important; }' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  expect(await page.evaluate(() => document.fonts.check('16px Manrope'))).toBe(false);
  expect(await page.locator('.landing-phone').evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
  expect(await page.locator('.landing-phone').evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
  await expect(page.getByRole('link', { name: 'Открыть в Telegram' }).first()).toBeInViewport();
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/landing-fallback-320.png`, fullPage: true });
});

for (const width of [1440, 390]) {
  test(`landing entrance motion finishes without hiding content ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.abort());
    await page.route('**/api/bot-entry', (route) => route.fulfill({ json: { botUrl: 'https://t.me/current_test_bot?start=landing' } }));
    await page.goto('/');
    await expect(page.locator('.landing-phone')).toBeVisible();
    const motion = await page.locator('.landing-preview').evaluate((node) => {
      const animations = node.getAnimations({ subtree: true });
      const result = animations.map((animation) => ({
        name: (animation as CSSAnimation).animationName,
        iterations: animation.effect?.getTiming().iterations,
        frames: (animation.effect as KeyframeEffect).getKeyframes().map(({ opacity }) => opacity)
      }));
      for (const animation of animations) { animation.pause(); animation.currentTime = 500; }
      return result;
    });
    expect(motion.map(({ name }) => name).sort()).toEqual(['landing-fragment-in', 'landing-fragment-in', 'landing-phone-in']);
    expect(motion.every(({ iterations, frames }) => iterations === 1 && frames.includes('0') && frames.includes('1'))).toBe(true);
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/landing-motion-mid-${width}.png`, fullPage: true, animations: 'allow' });
    await page.locator('.landing-preview').evaluate(async (node) => {
      const animations = node.getAnimations({ subtree: true });
      animations.forEach((animation) => animation.play());
      await Promise.all(animations.map((animation) => animation.finished));
    });
    expect(await page.locator('.landing-phone').evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
    await expect(page.locator('.landing-copy .landing-cta')).toBeInViewport();
    await page.screenshot({ path: `${evidence}/landing-motion-end-${width}.png`, fullPage: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.locator('.landing-preview').evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0);
  });
}
