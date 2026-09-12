import { expect, test, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../api/src/app';
import { createDatabase, login } from '../../api/src/db';
import type { Config } from '../../api/src/config';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));

for (const width of [390, 320]) {
  test(`entry guides, three paths and storage-unavailable boot ${width}`, async ({ page }) => {
    let start = 'help';
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage unavailable'); } }));
    await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ contentType: 'application/javascript', body: `window.Telegram={WebApp:{initData:'entry-test',initDataUnsafe:{start_param:'${start}'},ready(){},expand(){},openTelegramLink(url){window.groupLink=url;}}};` }));
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/auth/telegram') return route.fulfill({ json: { userId: '1' } });
      if (path === '/api/bot-entry') return route.fulfill({ json: { groupUrl: 'https://t.me/test_bot?startgroup=tasks' } });
      if (path === '/api/boards') return route.fulfill({ json: { boards: [{ id: 'personal', name: 'Личная доска', type: 'personal', role: 'owner', status: 'active' }] } });
      return route.fulfill({ json: { tasks: [], members: [], projects: [], recurrences: [], filters: {} } });
    });
    await mkdir(evidence, { recursive: true });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Личные и общие задачи в Telegram' })).toBeVisible();
    await page.screenshot({ path: `${evidence}/entry-help-${width}.png` });
    await page.getByRole('button', { name: 'Доска для группы', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Общие задачи в вашей группе.' })).toBeVisible();
    await page.screenshot({ path: `${evidence}/entry-group-guide-${width}.png` });
    await page.getByRole('button', { name: 'Добавить бота в группу' }).click();
    expect(await page.evaluate(() => (window as unknown as {groupLink: string}).groupLink)).toBe('https://t.me/test_bot?startgroup=tasks');
    await page.getByRole('button', { name: 'Назад', exact: true }).click();
    await page.getByRole('button', { name: 'Доска на двоих', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Работайте вдвоём. Группа не нужна.' })).toBeVisible();
    await page.screenshot({ path: `${evidence}/entry-pair-guide-${width}.png` });
    await page.getByRole('button', { name: 'Создать доску', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Название доски' })).toBeVisible();
    start = 'personal';
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Всё своё — в одном месте.' })).toBeVisible();
    await page.getByRole('button', { name: 'Открыть личные задачи' }).click();
    await expect(page.getByRole('heading', { name: 'Начните с первой задачи.' })).toBeVisible();
    await page.getByRole('button', { name: 'Добавить задачу', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Что нужно сделать?' })).toBeVisible();
    start = '';
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Задачи', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Как начать' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByRole('button', { name: 'Помощь', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Как начать' })).toBeFocused();
    await page.getByRole('button', { name: 'Доска для группы', exact: true }).click();
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: 'Добавить бота в группу' })).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test(`group first and repeated pin entry, two real API/DB sessions ${width}`, async ({ page, browser }) => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is required for entry browser/API/DB tests');
    const db = createDatabase(url);
    const stamp = randomBytes(6).readUIntBE(0, 6);
    const config: Config = { botToken: 'test', databaseUrl: url, sessionSecret: 'isolated-entry-browser', initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 3600,
      host: '127.0.0.1', port: 0, production: false, webhookSecret: 'entry-browser-webhook', publicUrl: 'https://example.test', botUsername: 'test_bot' };
    const owner = await login(db, { id: stamp, first_name: 'Администратор' }, 3600, config.sessionSecret);
    const guest = await login(db, { id: stamp + 1, first_name: 'Участник' }, 3600, config.sessionSecret);
    const personal = (await db.query("SELECT id FROM boards WHERE owner_user_id = $1 AND type = 'personal'", [owner.userId])).rows[0].id;
    const app = buildApp(config, db);
    const second = await browser.newPage({ viewport: { width, height: 844 } });
    let token = '';
    let photoCount = 0;
    let start = '';
    let loseActivation = true;
    let activationCalls = 0;
    const errors: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
      if (String(input).endsWith('/sendPhoto')) {
        photoCount++;
        token = new URL(JSON.parse(String((options?.body as FormData).get('reply_markup'))).inline_keyboard[0][0].url).searchParams.get('startapp')!;
        return Response.json({ ok: true, result: { message_id: 1 } });
      }
      expect(String(input).endsWith('/getChatMember')).toBe(true);
      return Response.json({ ok: true, result: { status: String(JSON.parse(String(options?.body)).user_id) === String(stamp) ? 'administrator' : 'member' } });
    };
    const join = { update_id: stamp, my_chat_member: { date: 1_700_000_000, chat: { id: -stamp, type: 'supergroup', title: 'Студия' }, old_chat_member: { status: 'left', user: { is_bot: true } }, new_chat_member: { status: 'member', user: { is_bot: true } } } };
    const webhook = () => app.inject({ method: 'POST', url: '/api/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': config.webhookSecret }, payload: join });
    const attach = async (target: Page, person: typeof owner) => {
      target.on('pageerror', (error) => errors.push(error.message));
      await target.setViewportSize({ width, height: 844 });
      await target.addInitScript((id) => { localStorage.clear(); localStorage.setItem('tasks.globalBoardId', id); }, personal);
      await target.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ contentType: 'application/javascript', body: `window.Telegram={WebApp:{initData:'entry-browser-test',initDataUnsafe:{start_param:${JSON.stringify(start)}},ready(){},expand(){},close(){window.groupClosed=true;}}};` }));
      await target.route('**/api/**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname + new URL(request.url()).search;
        if (path === '/api/auth/telegram') return route.fulfill({ json: { userId: person.userId } });
        const response = await app.inject({ method: request.method() as 'GET' | 'POST' | 'PATCH' | 'PUT', url: path, cookies: { session: person.token }, payload: request.postData() ? request.postDataJSON() : undefined });
        if (path.endsWith('/activate')) {
          activationCalls++;
          if (loseActivation) { loseActivation = false; await new Promise((resolve) => setTimeout(resolve, 200)); return route.fulfill({ status: 503, json: { error: 'Lost activation response' } }); }
        }
        await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
      });
      await target.goto('/');
    };
    try {
      expect((await webhook()).json().delivery).toBe('sent');
      start = token;
      await mkdir(evidence, { recursive: true });
      await attach(second, guest);
      await expect(second.getByRole('heading', { name: 'Ожидаем администратора.' })).toBeVisible();
      await second.screenshot({ path: `${evidence}/entry-group-wait-${width}.png` });
      await expect(second.getByRole('button', { name: 'Начать работу' })).toHaveCount(0);
      await attach(page, owner);
      await expect(page.getByRole('heading', { name: 'Начните работу вместе с командой.' })).toBeVisible();
      await page.screenshot({ path: `${evidence}/entry-group-setup-${width}.png` });
      await page.getByRole('button', { name: 'Назад', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Личная доска', exact: true })).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem('tasks.globalBoardId'))).toBe(personal);
      await page.reload();
      await page.getByRole('button', { name: 'Начать работу' }).click();
      await expect(page.getByRole('button', { name: 'Запускаем…' })).toBeDisabled();
      await expect(page.getByRole('alert')).toContainText('Не удалось подтвердить запуск');
      await page.screenshot({ path: `${evidence}/entry-group-setup-error-${width}.png` });
      await page.getByRole('button', { name: 'Проверить состояние' }).click();
      await expect(page.getByRole('heading', { name: 'Начните с первой задачи.' })).toBeVisible();
      expect(activationCalls).toBe(1);
      await page.screenshot({ path: `${evidence}/entry-group-empty-${width}.png` });
      await page.getByRole('button', { name: 'Добавить задачу', exact: true }).click();
      await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Первая задача команды');
      await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
      await expect(page.getByRole('button', { name: /Первая задача команды/ })).toBeVisible();
      await second.getByRole('button', { name: 'Проверить готовность' }).click();
      await second.getByRole('button', { name: /Бэклог/ }).click();
      await expect(second.getByRole('button', { name: /Первая задача команды/ })).toBeVisible();
      await webhook();
      await second.reload();
      await expect(second.getByRole('button', { name: 'Студия', exact: true })).toBeVisible();
      await expect(second.getByRole('heading', { name: /Как начать|Ожидаем|Начните работу/ })).toHaveCount(0);
      await second.getByRole('button', { name: 'Все', exact: true }).click();
      await expect(second.getByRole('button', { name: /Первая задача команды/ })).toBeVisible();
      await second.screenshot({ path: `${evidence}/entry-group-return-${width}.png` });
      const task = (await db.query('SELECT id, board_id FROM tasks WHERE creator_user_id = $1', [owner.userId])).rows[0];
      start = `task_${task.board_id}_${task.id}`;
      await second.reload();
      await expect(second.getByRole('textbox', { name: 'Название задачи', exact: true })).toHaveValue('Первая задача команды');
      await second.getByRole('button', { name: 'Назад к задачам' }).click();
      await expect(second.getByRole('button', { name: 'Студия', exact: true })).toBeVisible();
      join.update_id++; join.my_chat_member.date++; join.my_chat_member.old_chat_member.status = 'member'; join.my_chat_member.new_chat_member.status = 'left';
      await webhook();
      start = token;
      await second.reload();
      await expect(second.getByRole('heading', { name: 'Доска временно заморожена.' })).toBeVisible();
      await expect(second.getByRole('button', { name: 'Начать работу' })).toHaveCount(0);
      await second.screenshot({ path: `${evidence}/entry-group-frozen-${width}.png` });
      join.update_id++; join.my_chat_member.date++; join.my_chat_member.old_chat_member.status = 'left'; join.my_chat_member.new_chat_member.status = 'member';
      await webhook();
      await second.getByRole('button', { name: 'Проверить состояние' }).click();
      await expect(second.getByRole('button', { name: 'Студия', exact: true })).toBeVisible();
      expect(photoCount).toBe(1);
      expect(await page.evaluate(() => localStorage.getItem('tasks.globalBoardId'))).toBe(personal);
      start = '';
      await page.reload();
      await expect(page.getByRole('button', { name: 'Личная доска', exact: true })).toBeVisible();
      expect(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      await second.close(); await app.close();
      await db.query('DELETE FROM boards WHERE telegram_chat_id = $1 OR owner_user_id = ANY($2)', [-stamp, [owner.userId, guest.userId]]);
      await db.query('DELETE FROM users WHERE id = ANY($1)', [[owner.userId, guest.userId]]);
      await db.end();
    }
  });
}

test('saved frozen group allows leaving setup without changing ordinary board', async ({ page }) => {
  const board = { id: 'group', name: 'Студия', type: 'chat', role: 'member', status: 'frozen' };
  await page.addInitScript(() => localStorage.setItem('tasks.globalBoardId', 'group'));
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ contentType: 'application/javascript', body: "window.Telegram={WebApp:{initData:'test',ready(){},expand(){}}};" }));
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/telegram') return route.fulfill({ json: { userId: '1' } });
    if (path === '/api/boards') return route.fulfill({ json: { boards: [board] } });
    if (path.endsWith('/setup')) return route.fulfill({ json: { board, canActivate: false } });
    return route.fulfill({ json: { tasks: [], projects: [], members: [], recurrences: [], schedules: [], filters: {} } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Доска временно заморожена.' })).toBeVisible();
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Рабочее пространство', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Настройки', exact: true }).first().click();
  await page.getByRole('button', { name: 'Помощь', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Как начать', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('tasks.globalBoardId'))).toBe('group');
});

test('group link failure retries same context; invalid link has safe return', async ({ page }) => {
  let invalid = false;
  let offline = true;
  let redeemCalls = 0;
  await page.setViewportSize({ width: 320, height: 844 });
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ contentType: 'application/javascript', body: "window.Telegram={WebApp:{initData:'test',initDataUnsafe:{start_param:'board_invalid'},ready(){},expand(){}}};" }));
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/telegram') return route.fulfill({ json: { userId: '1' } });
    if (path.endsWith('/redeem')) { redeemCalls++; return route.fulfill({ status: offline ? 503 : invalid ? 404 : 200, json: offline || invalid ? { error: 'Unavailable' } : { id: 'group' } }); }
    if (path === '/api/boards') return route.fulfill({ json: { boards: [{ id: 'group', name: 'Студия', type: 'chat', role: 'member', status: 'active' }] } });
    return route.fulfill({ json: { tasks: [], projects: [], members: [], recurrences: [], schedules: [], filters: {} } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Не удалось открыть доску' })).toBeVisible();
  offline = false;
  const before = redeemCalls;
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.getByRole('button', { name: 'Студия', exact: true })).toBeVisible();
  expect(redeemCalls).toBeGreaterThan(before);
  invalid = true;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Доска недоступна' })).toBeVisible();
  await expect(page.getByText('Студия', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/entry-group-invalid-320.png` });
  await page.getByRole('button', { name: 'К моим задачам' }).click();
  await expect(page.getByRole('heading', { name: 'Задачи', exact: true })).toBeVisible();
});
