import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));

for (const width of [390, 320]) {
  test(`Tasca entry, loading, auth failure and task access denial ${width}`, async ({ page }) => {
    let mode = 'outside';
    let release: (() => void) | undefined;
    const loading = new Promise<void>((resolve) => { release = resolve; });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
      contentType: 'application/javascript',
      body: mode === 'outside' ? '' : `window.Telegram={WebApp:{initData:'synthetic-brand-test',colorScheme:'dark',initDataUnsafe:{start_param:${JSON.stringify(mode === 'denied' ? 'task_11111111-1111-4111-8111-111111111111_22222222-2222-4222-8222-222222222222' : '')}},ready(){},expand(){}}};`
    }));
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/bot-entry') return route.fulfill({ json: { botUrl: 'https://t.me/kairostask_bot?start=landing' } });
      if (path === '/api/auth/telegram') {
        if (mode === 'loading') await loading;
        return route.fulfill({ status: mode === 'auth-error' ? 401 : 200, json: mode === 'auth-error' ? { error: 'Откройте приложение снова через бота.' } : { userId: 'synthetic' } });
      }
      if (mode === 'denied' && path.includes('/tasks/')) return route.fulfill({ status: 403, json: { error: 'Нет доступа' } });
      return route.fulfill({ json: { boards: [], tasks: [], projects: [], members: [] } });
    });
    await mkdir(evidence, { recursive: true });
    const shot = async () => {
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveTitle('Таска');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${evidence}/tasca-${mode}-${width}.png` });
    };
    try {
      await page.goto('/');
      await expect(page.getByRole('img', { name: 'Таска' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Открыть в Telegram' }).first()).toHaveAttribute('href', 'https://t.me/kairostask_bot?start=landing');
      await shot();
      mode = 'auth-error'; await page.reload();
      await expect(page.getByRole('heading', { name: 'Не удалось войти' })).toBeVisible();
      await shot();
      mode = 'loading'; await page.reload();
      await expect(page.getByRole('status', { name: 'Загрузка приложения' })).toBeVisible();
      await shot();
      release!();
      await expect(page.getByText('Назначенных задач пока нет.')).toBeVisible();
      mode = 'empty'; await shot();
      await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline')); });
      await expect(page.locator('.offline-banner')).toBeVisible();
      mode = 'offline'; await shot();
      mode = 'denied'; await page.reload();
      await expect(page.getByRole('heading', { name: 'Нет доступа к задаче' })).toBeVisible();
      await shot();
      await page.getByRole('button', { name: 'К задачам', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Задачи', exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    } finally { release?.(); }
  });
}
