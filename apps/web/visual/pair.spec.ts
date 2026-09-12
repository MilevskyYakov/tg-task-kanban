import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../../api/src/app';
import { createDatabase, createTask, login } from '../../api/src/db';
import type { Config } from '../../api/src/config';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));
const boardId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const token = `pair_${'x'.repeat(32)}`;
async function setup(page: Page, options: { member?: boolean; archived?: boolean; invite?: boolean; full?: boolean; invalid?: boolean; empty?: boolean } = {}) {
  const state = {
    board: { id: boardId, name: 'Запуск сайта', type: 'pair', status: options.archived ? 'archived' : 'active', role: options.member ? 'member' : 'owner' },
    members: [{ id: '1', first_name: 'Алексей', role: 'owner' }, { id: '2', first_name: 'Мария', role: 'member' }],
    joined: !options.invite, removed: false, created: !options.empty, createFailed: false, archiveFailed: false, restoreFailed: false, leaveFailed: false,
    calls: [] as { method: string; path: string; body: any }[]
  };
  if (options.empty) state.members = state.members.slice(0, 1);
  await page.addInitScript(({ id, invite }) => { localStorage.clear(); if (!invite) localStorage.setItem('tasks.globalBoardId', id); }, { id: boardId, invite: options.invite });
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ contentType: 'application/javascript', body: `window.Telegram={WebApp:{initData:'pair-visual-test',initDataUnsafe:{${options.invite ? `start_param:'${token}',` : ''}user:{first_name:'Алексей'}},ready(){},expand(){},openTelegramLink(){window.pairShared=true;}}};` }));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const body = route.request().postDataJSON();
    state.calls.push({ path, method, body });
    const fail = (status: number, error: string) => route.fulfill({ status, json: { error } });
    if (path === '/api/auth/telegram') return route.fulfill({ json: { userId: options.member ? '2' : '1' } });
    if (path === '/api/boards') return route.fulfill({ json: { boards: state.created && state.joined && !state.removed ? [state.board] : [] } });
    if (path === '/api/boards/pair') {
      state.created = true;
      state.board.name = body.name;
      if (state.createFailed) { state.createFailed = false; return fail(503, 'Не удалось создать доску. Название сохранено.'); }
      return route.fulfill({ json: state.board });
    }
    if (path === '/api/board-links/preview') return options.invalid ? fail(404, 'Приглашение больше не действует') : route.fulfill({ json: { id: boardId, name: state.board.name, owner_name: 'Алексей', full: options.full ?? false, joined: state.joined } });
    if (path === '/api/board-links/redeem') {
      expect(body.acceptedHistory).toBe(true);
      state.joined = true;
      return route.fulfill({ json: state.board });
    }
    if (path === `/api/boards/${boardId}`) return state.removed ? fail(404, 'board not found') : route.fulfill({ json: state.board });
    if (path.endsWith('/invites')) return route.fulfill({ json: method === 'DELETE' ? { revoked: true } : { url: `https://t.me/test_bot?startapp=${token}` } });
    if (path.endsWith('/participant')) { const removed = state.members.some((member) => member.id === body.participantId); state.members = state.members.filter((member) => member.id !== body.participantId); return route.fulfill({ json: { removed } }); }
    if (path.endsWith('/leave')) {
      if (state.removed) return fail(403, 'Нет доступа к управлению доской');
      state.removed = true;
      if (state.leaveFailed) { state.leaveFailed = false; return fail(503, 'Не удалось подтвердить выход'); }
      return route.fulfill({ json: { removed: true } });
    }
    if (path.endsWith('/archive')) {
      if (!body.archived && state.restoreFailed) { state.restoreFailed = false; return fail(503, 'Не удалось восстановить. Доска осталась в архиве.'); }
      state.board.status = body.archived ? 'archived' : 'active';
      if (state.archiveFailed) { state.archiveFailed = false; return fail(503, 'Не удалось подтвердить архивирование'); }
      return route.fulfill({ json: state.board });
    }
    if (path.endsWith('/members')) return route.fulfill({ json: { members: state.members } });
    if (path.endsWith('/projects')) return route.fulfill({ json: { projects: [] } });
    if (path.endsWith('/recurrences')) return route.fulfill({ json: { recurrences: [] } });
    if (path.endsWith('/collaboration')) return route.fulfill({ json: { comments: [{ id: 'comment', body: 'История сохранена', author_name: 'Мария', created_at: '2026-09-01T12:00:00Z' }], checklist: [], attachments: [], timeline: [] } });
    if (path.endsWith('/task-filters')) return route.fulfill({ json: { filters: { scope: 'all' } } });
    const tasks = state.created ? [{ id: taskId, board_id: boardId, board_status: state.board.status, title: 'Проверить макет', creator_user_id: '1', assignee_user_id: '2', status: 'todo', priority: 'normal', overdue: false }] : [];
    return route.fulfill({ json: { tasks } });
  });
  await mkdir(evidence, { recursive: true });
  return state;
}

for (const width of [390, 320]) {
  test(`pair create, safe retry, invitation and revoked link ${width}`, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const state = await setup(page, { empty: true });
    state.createFailed = true;
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Все доски', exact: true }).click();
    await page.getByRole('button', { name: 'Создать доску на двоих' }).click();
    await page.getByRole('textbox', { name: 'Название доски' }).fill('Запуск сайта');
    await page.screenshot({ path: `${evidence}/pair-create-${width}.png` });
    await page.getByRole('button', { name: 'Создать доску', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Название сохранено');
    await expect(page.getByRole('textbox', { name: 'Название доски' })).toHaveValue('Запуск сайта');
    await page.getByRole('button', { name: 'Повторить создание' }).click();
    await expect(page.getByRole('heading', { name: 'Приглашение', exact: true })).toBeVisible();
    const creates = state.calls.filter((call) => call.path === '/api/boards/pair');
    expect(creates).toHaveLength(2);
    expect(creates[0].body.requestId).toBe(creates[1].body.requestId);
    await page.getByRole('button', { name: 'Создать приглашение', exact: true }).click();
    await expect(page.getByText(/Приглашённый увидит все задачи/)).toBeVisible();
    await page.getByRole('button', { name: 'Скопировать ссылку' }).click();
    await expect(page.getByRole('status')).toContainText('Ссылка скопирована');
    await page.getByRole('button', { name: 'Отправить приглашение' }).click();
    expect(await page.evaluate(() => (window as unknown as {pairShared: boolean}).pairShared)).toBe(true);
    await page.screenshot({ path: `${evidence}/pair-invite-owner-${width}.png` });
    await page.getByRole('button', { name: 'Отозвать ссылку' }).click();
    await expect(page.getByText('Доступ уже вступившего участника не изменится.')).toBeVisible();
    expect(state.calls.filter((call) => call.path.endsWith('/invites') && call.method === 'DELETE')).toHaveLength(0);
    await page.getByRole('button', { name: 'Отозвать ссылку', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Приглашение больше не действует.' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(state.calls.some((call) => call.path.includes('publications'))).toBe(false);
  });

  test(`pair consent before membership and direct board entry ${width}`, async ({ page }) => {
    const state = await setup(page, { invite: true, member: true });
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Запуск сайта' })).toBeVisible();
    await expect(page.getByText(/Приглашённый увидит все задачи/)).toBeVisible();
    expect(state.calls.filter((call) => call.path.endsWith('/redeem'))).toHaveLength(0);
    await page.screenshot({ path: `${evidence}/pair-accept-${width}.png` });
    await page.getByRole('button', { name: 'Присоединиться', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Запуск сайта', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Проверить макет/ })).toBeVisible();
    expect(state.calls.filter((call) => call.path.endsWith('/redeem'))).toHaveLength(1);
    expect(state.calls.some((call) => call.path.includes('publications'))).toBe(false);
  });
}

test('pair owner revokes access, archives with lost response and restores safely', async ({ page }) => {
  const state = await setup(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /Доступ Доска на двоих/ }).click();
  await page.getByRole('button', { name: 'Отозвать доступ Мария' }).click();
  await expect(page.getByText('Задачи останутся без исполнителя.')).toBeVisible();
  await page.screenshot({ path: `${evidence}/pair-revoke-320.png` });
  expect(state.calls.filter((call) => call.path.endsWith('/participant'))).toHaveLength(0);
  await page.getByRole('button', { name: 'Отозвать доступ', exact: true }).click();
  await expect(page.getByText(/Доступ участника отозван/)).toBeVisible();
  await page.getByRole('button', { name: 'Пригласить другого' }).click();
  await expect(page.getByText(/Прежние задачи и комментарии не будут скрыты/)).toBeVisible();
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  state.archiveFailed = true;
  await page.getByRole('button', { name: 'Архивировать доску' }).click();
  await expect(page.getByText('Восстановить доску сможете только вы.')).toBeVisible();
  await page.getByRole('button', { name: 'Архивировать доску', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Проверить состояние' })).toBeVisible();
  await page.getByRole('button', { name: 'Проверить состояние' }).click();
  await expect(page.getByRole('heading', { name: 'Доска в архиве' })).toBeVisible();
  state.restoreFailed = true;
  await page.getByRole('button', { name: 'Восстановить доску' }).click();
  await expect(page.getByRole('alert')).toContainText('Доска осталась в архиве');
  await page.screenshot({ path: `${evidence}/pair-restore-error-320.png` });
  await page.getByRole('button', { name: 'Повторить восстановление' }).click();
  await expect(page.getByRole('heading', { name: 'Доступ', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Отозвать ссылку', exact: true }).click();
  await page.getByRole('button', { name: 'Отозвать ссылку', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Приглашение больше не действует.' })).toBeVisible();
});

test('pair archived member has read-only task details and no owner controls', async ({ page }) => {
  await setup(page, { member: true, archived: true });
  await page.goto('/');
  await page.getByRole('button', { name: /Доступ Доска в архиве/ }).click();
  await expect(page.getByRole('button', { name: /Восстановить|Отозвать|Пригласить/ })).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/pair-archived-member.png` });
  await page.getByRole('button', { name: 'Просмотреть задачи' }).click();
  await expect(page.getByRole('checkbox', { name: /Завершить задачу/ })).toBeDisabled();
  await page.getByRole('button', { name: /Проверить макет/ }).click();
  await expect(page.getByText('История сохранена')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Название задачи', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Сохранить изменения' })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Комментарий', exact: true })).toHaveCount(0);
});

test('pair member leave and stale open app lose access', async ({ page }) => {
  const state = await setup(page, { member: true });
  await page.goto('/');
  await page.getByRole('button', { name: /Доступ Доска на двоих/ }).click();
  await expect(page.getByRole('button', { name: /Архивировать|Отозвать|Пригласить/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Выйти из доски' }).click();
  await expect(page.getByText('Задачи останутся без исполнителя.')).toBeVisible();
  await page.getByRole('button', { name: 'Выйти из доски', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вы вышли из доски.' })).toBeVisible();
  await page.getByRole('button', { name: 'К моим задачам' }).click();
  await expect(page.getByRole('button', { name: 'Все доски', exact: true })).toBeVisible();
  state.removed = false;
  await page.reload();
  await page.getByRole('button', { name: /Проверить макет/ }).click();
  await expect(page.getByText('История сохранена')).toBeVisible();
  state.removed = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Доступ закрыт' })).toBeVisible();
  await expect(page.getByText('История сохранена')).toHaveCount(0);
});

for (const invalid of [false, true]) test(`pair invitation ${invalid ? 'revoked' : 'full'} has safe return`, async ({ page }) => {
  await setup(page, { invite: true, invalid, full: !invalid });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: invalid ? 'Ссылка недоступна' : 'Доска уже занята' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Присоединиться' })).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/pair-invite-${invalid ? 'invalid' : 'full'}-320.png` });
  await page.getByRole('button', { name: 'К моим задачам' }).click();
  await expect(page.getByRole('heading', { name: 'Задачи', exact: true })).toBeVisible();
});

test('pair stale confirmation does not target a replacement member', async ({ page }) => {
  const state = await setup(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Доступ Доска на двоих/ }).click();
  await page.getByRole('button', { name: 'Отозвать доступ Мария' }).click();
  state.members = [state.members[0], { id: '3', first_name: 'Ольга', role: 'member' }];
  await page.getByRole('button', { name: 'Отозвать доступ', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Отозвать доступ Ольга' })).toBeVisible();
  expect(state.calls.find((call) => call.path.endsWith('/participant'))?.body.participantId).toBe('2');
});

test('pair lost leave response can be retried without trapping former member', async ({ page }) => {
  const state = await setup(page, { member: true });
  state.leaveFailed = true;
  await page.goto('/');
  await page.getByRole('button', { name: /Доступ Доска на двоих/ }).click();
  await page.getByRole('button', { name: 'Выйти из доски' }).click();
  await page.getByRole('button', { name: 'Выйти из доски', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Не удалось подтвердить выход');
  await page.getByRole('button', { name: 'Выйти из доски', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вы вышли из доски.' })).toBeVisible();
});

test('pair two browser sessions use real API/DB for creation, consent, collaboration and revocation', async ({ page, browser }) => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required for pair browser/API/DB tests');
  const db = createDatabase(url);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const config: Config = { botToken: 'test', databaseUrl: url, sessionSecret: 'isolated-pair-browser-secret', initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 3600,
    host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-pair-browser-webhook', publicUrl: 'https://example.test', botUsername: 'test_bot' };
  const owner = await login(db, { id: stamp, first_name: 'Автор' }, 3600, config.sessionSecret);
  const guest = await login(db, { id: stamp + 1, first_name: 'Мария' }, 3600, config.sessionSecret);
  const app = buildApp(config, db);
  const second = await browser.newPage({ viewport: { width: 320, height: 844 } });
  const errors: string[] = [];
  let inviteToken = '';
  let createdId = '';
  const attach = async (target: Page, person: typeof owner, start = '') => {
    target.on('pageerror', (error) => errors.push(error.message));
    await target.addInitScript(() => localStorage.clear());
    await target.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ contentType: 'application/javascript', body: `window.Telegram={WebApp:{initData:'isolated-browser-test',initDataUnsafe:{start_param:${JSON.stringify(start)}},ready(){},expand(){}}};` }));
    await target.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname + new URL(request.url()).search;
      if (path === '/api/auth/telegram') return route.fulfill({ json: { userId: person.userId } });
      const response = await app.inject({ method: request.method() as 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: path, cookies: { session: person.token }, payload: request.postData() ? request.postDataJSON() : undefined });
      if (path === '/api/boards/pair' && response.statusCode === 200) createdId = response.json().id;
      if (path.endsWith('/invites') && request.method() === 'POST' && response.statusCode === 200) inviteToken = new URL(response.json().url).searchParams.get('startapp')!;
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });
    await target.goto('/');
  };
  try {
    await attach(page, owner);
    await page.getByRole('button', { name: 'Все доски', exact: true }).click();
    await page.getByRole('button', { name: 'Создать доску на двоих' }).click();
    await page.getByRole('textbox', { name: 'Название доски' }).fill('Совместная доска');
    await page.getByRole('button', { name: 'Создать доску', exact: true }).click();
    await page.getByRole('button', { name: 'Создать приглашение', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Скопировать ссылку' })).toBeVisible();
    await attach(second, guest, inviteToken);
    await expect(second.getByText(/Приглашённый увидит все задачи/)).toBeVisible();
    expect((await db.query('SELECT count(*) FROM memberships WHERE board_id = $1', [createdId])).rows[0].count).toBe('1');
    await second.getByRole('button', { name: 'Присоединиться', exact: true }).click();
    await expect(second.getByRole('button', { name: 'Совместная доска', exact: true })).toBeVisible();
    await createTask(db, owner.userId, createdId, { title: 'Общая задача', assigneeUserId: guest.userId });
    await second.reload();
    await second.getByRole('button', { name: 'Открыть доску', exact: true }).click();
    await second.getByRole('button', { name: /Общая задача/ }).click();
    await second.getByRole('textbox', { name: 'Комментарий', exact: true }).fill('Совместное обсуждение');
    await second.getByRole('button', { name: 'Отправить комментарий' }).click();
    await expect(second.getByText('Совместное обсуждение')).toBeVisible();
    await page.getByRole('button', { name: 'К задачам', exact: true }).click();
    await page.getByRole('button', { name: /Доступ Доска на двоих/ }).click();
    await page.getByRole('button', { name: 'Отозвать доступ Мария' }).click();
    await page.getByRole('button', { name: 'Отозвать доступ', exact: true }).click();
    await expect(page.getByText(/Доступ участника отозван/)).toBeVisible();
    await second.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(second.getByRole('heading', { name: 'Доступ закрыт' })).toBeVisible();
    expect((await db.query('SELECT assignee_user_id FROM tasks WHERE board_id = $1', [createdId])).rows[0].assignee_user_id).toBeNull();
    expect((await db.query('SELECT body FROM task_comments WHERE board_id = $1', [createdId])).rows[0].body).toBe('Совместное обсуждение');
    expect(errors).toEqual([]);
  } finally {
    await second.close();
    await app.close();
    await db.query('DELETE FROM boards WHERE owner_user_id = ANY($1)', [[owner.userId, guest.userId]]);
    await db.query('DELETE FROM users WHERE id = ANY($1)', [[owner.userId, guest.userId]]);
    await db.end();
  }
});
