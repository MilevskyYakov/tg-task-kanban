import { expect, test } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../api/src/app';
import { connectChatBoard, createDatabase, createTask, login } from '../../api/src/db';
import { createPairBoard } from '../../api/src/pair-boards';
import { assertSettingsLayout } from './settings-layout';
import type { Config } from '../../api/src/config';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for board deletion browser/API/DB tests');
const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));
for (const width of [390, 320]) test(`board deletion: confirmation, cancellation, retry and restore ${width}`, async ({page}) => {
  const db = createDatabase(url), stamp = randomBytes(6).readUIntBE(0, 6);
  const config: Config = {botToken: 'test', databaseUrl: url, sessionSecret: 'isolated-deletion-visual', initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 3600,
    host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-webhook', publicUrl: 'https://example.test', botUsername: 'test_bot'};
  const owner = await login(db, {id: stamp, first_name: 'Владелец'}, 3600, config.sessionSecret);
  const member = await login(db, {id: stamp + 1, first_name: 'Участник'}, 3600, config.sessionSecret);
  const board = await createPairBoard(db, owner.userId, 'Проверочная доска с сохранением данных', randomUUID());
  await db.query("INSERT INTO memberships VALUES ($1, $2, 'member')", [board.id, member.userId]);
  await createTask(db, owner.userId, board.id, {title: 'Не потерять задачу'});
  const app = buildApp(config, db), errors: string[] = [], writes: any[] = [];
  let person = owner, lost = false;
  try {
    await page.setViewportSize({width, height: 844});
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://telegram.org/js/telegram-web-app.js', route => route.fulfill({contentType: 'application/javascript', body: "window.Telegram={WebApp:{initData:'isolated',initDataUnsafe:{},ready(){},expand(){}}};"}));
    await page.route('**/api/**', async route => {
      const request = route.request(), target = new URL(request.url());
      if (target.pathname === '/api/auth/telegram') return route.fulfill({json: {userId: person.userId}});
      const payload = request.postData() ? request.postDataJSON() : undefined;
      const change = request.method() === 'POST' && target.pathname.endsWith('/deletion');
      if (change) writes.push(payload);
      const response = await app.inject({method: request.method() as 'GET' | 'POST' | 'PUT', url: target.pathname + target.search, payload, cookies: {session: person.token}});
      if (change && lost && response.statusCode === 200) { lost = false; return route.abort('failed'); }
      return route.fulfill({status: response.statusCode, contentType: 'application/json', body: response.body});
    });
    const workspace = async () => {
      await page.getByRole('button', {name: 'Настройки', exact: true}).click();
      await page.getByRole('button', {name: /Рабочее пространство/}).click();
    };
    const shot = async (name: string) => {
      await mkdir(evidence, {recursive: true});
      await page.evaluate(() => document.fonts.ready);
      await assertSettingsLayout(page, await page.locator('.sheet').count() ? '.sheet' : '.settings-screen');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({path: `${evidence}/issue191-${name}-${width}.png`});
    };
    await page.goto('/'); await workspace();
    await page.getByRole('button', {name: /Проверочная доска/}).click();
    await page.getByRole('button', {name: 'Удалить доску', exact: true}).click();
    await expect(page.getByText('Задачи: 1', {exact: true})).toBeVisible();
    await shot('confirmation');
    await page.evaluate(() => document.documentElement.style.fontSize = '200%');
    await shot('confirmation-text200');
    await page.getByRole('button', {name: 'Отмена', exact: true}).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', {name: 'Отмена', exact: true})).toBeInViewport();
    await shot('confirmation-text200-actions');
    await page.evaluate(() => document.documentElement.style.fontSize = '');
    await page.getByRole('button', {name: 'Отмена', exact: true}).click();
    expect(writes).toHaveLength(0);
    expect((await db.query('SELECT deleted_at FROM boards WHERE id=$1', [board.id])).rows[0].deleted_at).toBeNull();
    await page.getByRole('button', {name: 'Удалить доску', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Подтвердить удаление'})).toBeEnabled();
    await createTask(db, owner.userId, board.id, {title: 'Новая задача после открытия подтверждения'});
    await page.getByRole('button', {name: 'Подтвердить удаление'}).click();
    await expect(page.getByRole('alert')).toContainText('Доска изменилась');
    await expect(page.getByRole('button', {name: 'Подтвердить удаление'})).toHaveCount(0);
    await page.getByRole('button', {name: 'Проверить заново'}).click();
    await expect(page.getByText('Задачи: 2', {exact: true})).toBeVisible();
    lost = true;
    await page.getByRole('button', {name: 'Подтвердить удаление'}).click();
    await expect(page.getByRole('alert')).toContainText('Нет подтверждения результата');
    await shot('lost-response');
    await page.getByRole('button', {name: 'Проверить результат'}).click();
    await expect(page.getByText('Доска удалена. Данные сохранены.', {exact: true})).toBeVisible();
    expect(writes[1]).toEqual(writes[2]);
    expect((await db.query('SELECT count(*)::int AS count FROM board_lifecycle_events WHERE board_id=$1', [board.id])).rows[0].count).toBe(1);
    await expect(page.getByRole('button', {name: /Проверочная доска/})).toHaveCount(0);
    await page.getByRole('button', {name: 'Удалённые доски', exact: true}).click();
    await page.getByRole('button', {name: board.name, exact: true}).click();
    await page.getByRole('button', {name: 'Восстановить доску', exact: true}).click();
    await expect(page.getByText(/Повторы останутся на паузе/)).toBeVisible();
    await shot('restore');
    await page.getByRole('button', {name: 'Подтвердить восстановление'}).click();
    await expect(page.getByText('Удалённых досок нет.', {exact: true})).toBeVisible();
    expect((await db.query('SELECT count(*)::int AS count FROM tasks WHERE board_id=$1', [board.id])).rows[0].count).toBe(2);
    person = member; await page.reload(); await workspace();
    await page.getByRole('button', {name: /Проверочная доска/}).click();
    await expect(page.getByText('Удалять и восстанавливать доску может только владелец', {exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Удалить доску', exact: true})).toHaveCount(0);
    await shot('member-denied');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await db.query('DELETE FROM boards WHERE id=$1 OR owner_user_id=ANY($2::bigint[])', [board.id, [owner.userId, member.userId]]);
    await db.query('DELETE FROM users WHERE id=ANY($1::bigint[])', [[owner.userId, member.userId]]);
    await db.end();
  }
});

test('last chat board: common entry offers explicit create or restore, never remaps old board link', async ({page}) => {
  const db = createDatabase(url), stamp = randomBytes(6).readUIntBE(0, 6);
  const config: Config = {botToken: 'test', databaseUrl: url, sessionSecret: 'isolated-empty-chat', initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 3600,
    host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-webhook', publicUrl: 'https://example.test', botUsername: 'test_bot'};
  const owner = await login(db, {id: stamp, first_name: 'Администратор'}, 3600, config.sessionSecret);
  const board = (await connectChatBoard(db, -stamp, 'Чат без рабочих досок'))!;
  const app = buildApp(config, db), originalFetch = globalThis.fetch;
  let token = 'board_' + randomBytes(24).toString('base64url');
  globalThis.fetch = (async input => {
    if (!String(input).endsWith('/getChatMember')) throw new Error('No Telegram sends allowed');
    return Response.json({ok: true, result: {status: 'administrator'}});
  }) as typeof fetch;
  try {
    await db.query("UPDATE boards SET status='active' WHERE id=$1", [board.id]);
    await db.query("INSERT INTO memberships VALUES ($1,$2,'member')", [board.id, owner.userId]);
    await db.query("INSERT INTO board_links (token_hash,board_id,kind) VALUES ($1,$2,'chat_launch')", [createHash('sha256').update(token).digest('hex'), board.id]);
    const common = token;
    const context = (await app.inject({url: `/api/boards/${board.id}/chat`, cookies: {session: owner.token}})).json();
    const created = await app.inject({method: 'POST', url: `/api/boards/${board.id}/chat/boards`, cookies: {session: owner.token},
      payload: {name: 'Соседняя доска сохранена', requestId: randomUUID(), memberVersion: context.memberVersion, memberIds: [owner.userId]}});
    expect(created.statusCode).toBe(200);
    const sibling = created.json();
    const remove = async (id: string) => {
      const preview = (await app.inject({url: `/api/boards/${id}/deletion`, cookies: {session: owner.token}})).json();
      const result = await app.inject({method: 'POST', url: `/api/boards/${id}/deletion`, cookies: {session: owner.token},
        payload: {action: 'delete', requestId: randomUUID(), confirmation: preview.confirmation}});
      expect(result.statusCode).toBe(200);
    };
    await page.route('https://telegram.org/js/telegram-web-app.js', route => route.fulfill({contentType: 'application/javascript', body: `window.Telegram={WebApp:{initData:'isolated',initDataUnsafe:{start_param:${JSON.stringify(token)}},ready(){},expand(){}}};`}));
    await page.route('**/api/**', async route => {
      const request = route.request(), target = new URL(request.url());
      if (target.pathname === '/api/auth/telegram') return route.fulfill({json: {userId: owner.userId}});
      const response = await app.inject({method: request.method() as 'GET' | 'POST', url: target.pathname + target.search,
        payload: request.postData() ? request.postDataJSON() : undefined, cookies: {session: owner.token}});
      return route.fulfill({status: response.statusCode, contentType: 'application/json', body: response.body});
    });
    token = `open_${board.id}`; await page.goto('/');
    await expect(page.getByRole('button', {name: 'Чат без рабочих досок', exact: true})).toBeVisible();
    await remove(board.id);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('heading', {name: 'Доступ закрыт'})).toBeVisible();
    await page.getByRole('button', {name: 'К моим задачам'}).click();
    await page.getByRole('button', {name: 'Настройки', exact: true}).click();
    await page.getByRole('button', {name: /Рабочее пространство/}).click();
    await expect(page.getByRole('button', {name: /Соседняя доска сохранена/})).toBeVisible();
    await expect(page.getByRole('button', {name: /Чат без рабочих досок/})).toHaveCount(0);
    await remove(sibling.id);
    token = common; await page.reload();
    await expect(page.getByText('Доступных досок нет. Администратор может создать новую или восстановить удалённую.', {exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Добавить доску', exact: true})).toBeVisible();
    await page.getByRole('button', {name: 'Восстановить удалённую доску', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Чат без рабочих досок', exact: true})).toBeVisible();
    expect((await db.query('SELECT count(*)::int AS count FROM boards WHERE chat_root_id=$1 AND deleted_at IS NULL', [board.id])).rows[0].count).toBe(0);
    await page.screenshot({path: `${evidence}/issue191-empty-chat.png`});
    token = `open_${board.id}`; await page.reload();
    await expect(page.getByRole('heading', {name: 'Доска недоступна'})).toBeVisible();
  } finally {
    globalThis.fetch = originalFetch; await app.close();
    await db.query('DELETE FROM boards WHERE id=$1 OR owner_user_id=$2', [board.id, owner.userId]);
    await db.query('DELETE FROM users WHERE id=$1', [owner.userId]); await db.end();
  }
});
