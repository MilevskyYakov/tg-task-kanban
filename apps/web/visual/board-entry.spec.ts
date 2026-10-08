import { expect, test, type Page } from '@playwright/test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../api/src/app';
import { createDatabase, createTask, login } from '../../api/src/db';
import { changePairInvite, createPairBoard, redeemPairInvite, removePairMember, setPairArchived } from '../../api/src/pair-boards';
import type { Config } from '../../api/src/config';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/issue-180/', import.meta.url));
for (const width of [390, 320]) {
  test(`board entry photo flow, exact board, access and UI states ${width}`, async ({ page, browser }) => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is required');
    const db = createDatabase(url);
    const stamp = randomBytes(6).readUIntBE(0, 6);
    const config: Config = { botToken: '180:synthetic-browser', databaseUrl: url, sessionSecret: 'entry-browser', initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 3600,
      host: '127.0.0.1', port: 0, production: false, webhookSecret: 'entry-browser-webhook', publicUrl: 'https://example.test', botUsername: 'test_bot' };
    const people = await Promise.all(['Owner', 'Guest', 'Outsider'].map((first_name, index) => login(db, { id: stamp + index, first_name }, 3600, config.sessionSecret)));
    const [owner, guest, outsider] = people;
    const board = await createPairBoard(db, owner.userId, 'Запуск сайта и совместная подготовка материалов для команды', randomUUID());
    const other = await createPairBoard(db, owner.userId, 'Другая доска', randomUUID());
    await redeemPairInvite(db, guest.userId, (await changePairInvite(db, owner.userId, board.id))!, true);
    await createTask(db, owner.userId, board.id, { title: 'Секретная задача нужной доски', assigneeUserId: owner.userId });
    const app = buildApp(config, db);
    const recipient = await browser.newPage();
    const foreign = await browser.newPage();
    const originalFetch = globalThis.fetch;
    const photos: FormData[] = [];
    globalThis.fetch = async (input, options) => {
      expect(String(input).endsWith('/sendPhoto')).toBe(true);
      expect(options?.body).toBeInstanceOf(FormData);
      photos.push(options!.body as FormData);
      return Response.json({ ok: true, result: { message_id: photos.length } });
    };
    let failEntry = false;
    let release: (() => void) | undefined;
    let pending: Promise<void> | undefined;
    const errors: string[] = [];
    const attach = async (target: Page, person: typeof owner, start: string, savedBoard?: string) => {
      await target.setViewportSize({ width, height: 844 });
      target.on('pageerror', (error) => errors.push(error.message));
      await target.addInitScript((id) => { localStorage.clear(); if (id) localStorage.setItem('tasks.globalBoardId', id); }, savedBoard);
      await target.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ contentType: 'application/javascript', body: `window.Telegram={WebApp:{initData:'synthetic-entry-browser',initDataUnsafe:{start_param:${JSON.stringify(start)}},ready(){},expand(){},openTelegramLink(url){window.entryUrl=url;}}};` }));
      await target.route('**/api/**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path === '/api/auth/telegram') return route.fulfill({ json: { userId: person.userId } });
        if (path.endsWith('/entry')) {
          if (pending) await pending;
          if (failEntry) return route.fulfill({ status: 503, json: { error: 'Нет связи. Повторите.' } });
        }
        const response = await app.inject({ method: request.method() as 'GET' | 'POST', url: path + new URL(request.url()).search,
          cookies: { session: person.token }, ...(request.postData() ? { payload: request.postData(), headers: { 'content-type': 'application/json' } } : {}) });
        await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
      });
    };
    try {
      await mkdir(evidence, { recursive: true });
      await attach(page, owner, `open_${board.id}`, other.id);
      await page.goto('/');
      const action = page.getByRole('button', { name: 'Вход в эту доску Получить сообщение для пересылки' });
      await expect(action).toBeVisible();
      await expect(page.getByRole('button', { name: board.name, exact: true })).toBeVisible();
      await page.locator('.unassessed-tasks > summary').click();
      await expect(page.getByText('Секретная задача нужной доски', { exact: true })).toBeVisible();
      await page.screenshot({ path: `${evidence}/actual-board-${width}.png`, fullPage: true });
      failEntry = true;
      await action.click();
      await expect(page.getByRole('alert')).toContainText('Нет связи');
      await page.screenshot({ path: `${evidence}/actual-error-${width}.png`, fullPage: true });
      failEntry = false;
      pending = new Promise<void>((resolve) => { release = resolve; });
      await action.click();
      await expect(page.getByRole('button', { name: 'Вход в эту доску Открываем бота…' })).toBeDisabled();
      release!(); pending = undefined;
      await expect.poll(() => page.evaluate(() => (window as unknown as {entryUrl?: string}).entryUrl)).toBe(`https://t.me/test_bot?start=entry_${board.id}`);
      await expect(page.getByRole('status')).toContainText('В чате бота нажмите «Начать»');
      expect(photos).toHaveLength(0);
      const response = await app.inject({ method: 'POST', url: '/api/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': config.webhookSecret }, payload: {
        update_id: stamp, message: { message_id: stamp, chat: { id: stamp, type: 'private' }, text: `/start entry_${board.id}` }
      } });
      expect(response.json().delivery).toBe('sent');
      expect(photos).toHaveLength(1);
      expect(photos[0].get('photo')).toBeInstanceOf(File);
      const link = JSON.parse(String(photos[0].get('reply_markup'))).inline_keyboard[0][0].url;
      expect(String(photos[0].get('caption'))).toContain(link);
      const launch = new URL(link).searchParams.get('startapp')!;
      await attach(recipient, guest, launch);
      await recipient.goto('/');
      await expect(recipient.getByRole('button', { name: board.name, exact: true })).toBeVisible();
      await recipient.getByRole('button', { name: 'Все', exact: true }).click();
      await recipient.locator('.unassessed-tasks > summary').click();
      await expect(recipient.getByText('Секретная задача нужной доски', { exact: true })).toBeVisible();
      await attach(foreign, outsider, launch);
      await foreign.goto('/');
      await expect(foreign.getByRole('heading', { name: 'Доска недоступна' })).toBeVisible();
      await expect(foreign.getByRole('alert')).toContainText('отдельное приглашение');
      await expect(foreign.getByText(board.name, { exact: true })).toHaveCount(0);
      await expect(foreign.getByText('Секретная задача нужной доски', { exact: true })).toHaveCount(0);
      await foreign.screenshot({ path: `${evidence}/actual-denied-${width}.png`, fullPage: true });
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await action.focus();
      await expect(action).toBeFocused();
      const box = await action.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: `${evidence}/actual-large-text-${width}.png`, fullPage: true });
      await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
      await setPairArchived(db, owner.userId, board.id, true);
      await page.reload();
      await expect(page.getByText('Доска в архиве. Задачи и история доступны только для чтения.')).toBeVisible();
      await expect(action).toBeEnabled();
      await setPairArchived(db, owner.userId, board.id, false);
      await removePairMember(db, owner.userId, board.id, guest.userId);
      await recipient.reload();
      await expect(recipient.getByRole('heading', { name: 'Доска недоступна' })).toBeVisible();
      // Navigating away must cancel the effect of an outstanding link request.
      await page.reload();
      await expect(action).toBeVisible();
      pending = new Promise<void>((resolve) => { release = resolve; });
      await action.click();
      await expect(page.getByRole('button', { name: 'Вход в эту доску Открываем бота…' })).toBeDisabled();
      await page.getByRole('button', { name: 'Настройки', exact: true }).click();
      release!(); pending = undefined;
      await expect(page.getByRole('heading', { name: 'Настройки', exact: true })).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await page.evaluate(() => (window as unknown as {entryUrl?: string}).entryUrl)).toBeUndefined();
      expect(errors).toEqual([]);
    } finally {
      release?.();
      await recipient.close(); await foreign.close();
      globalThis.fetch = originalFetch;
      await app.close();
      await db.query('DELETE FROM boards WHERE owner_user_id = ANY($1)', [people.map((person) => person.userId)]);
      await db.query('DELETE FROM users WHERE id = ANY($1)', [people.map((person) => person.userId)]);
      await db.query('DELETE FROM telegram_entry_deliveries WHERE key LIKE $1', [`%:command:${createHash('sha256').update(`${stamp}:${stamp}`).digest('hex')}`]);
      await db.end();
    }
  });
}
