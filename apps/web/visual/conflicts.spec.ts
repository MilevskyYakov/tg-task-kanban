import { expect, test, type Page } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../api/src/app';
import { createDatabase, createTask, login } from '../../api/src/db';
import type { Config } from '../../api/src/config';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));
const databaseUrl = process.env.TEST_DATABASE_URL;

for (const keepLocal of [true, false]) {
  test(`two clients resolve conflicts through real API/DB: local=${keepLocal}`, async ({ page, browser }) => {
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required for conflict browser/API/DB tests');
    const db = createDatabase(databaseUrl);
    const stamp = randomBytes(6).readUIntBE(0, 6);
    const config: Config = { botToken: 'test', databaseUrl, sessionSecret: 'isolated-conflict-secret', initDataMaxAgeSeconds: 60,
      sessionMaxAgeSeconds: 3600, host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-conflict-webhook',
      publicUrl: 'https://example.test', botUsername: 'test_bot' };
    const users: Awaited<ReturnType<typeof login>>[] = [];
    const boardId = randomUUID();
    const app = buildApp(config, db);
    const second = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const writes: { client: number; input: Record<string, any>; status: number }[] = [];
    const errors: string[] = [];
    try {
      users.push(await login(db, { id: stamp, first_name: 'First client' }, 3600, config.sessionSecret));
      users.push(await login(db, { id: stamp + 1, first_name: 'Second client' }, 3600, config.sessionSecret));
      await db.query("INSERT INTO boards (id, type, name, telegram_chat_id, status) VALUES ($1, 'chat', 'Conflict test', $2, 'active')", [boardId, -stamp]);
      for (const user of users) await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'member')", [boardId, user.userId]);
      const created = await createTask(db, users[0].userId, boardId, { title: 'Base title', description: 'Base description', status: 'in_progress' });
      if (!created) throw new Error('Could not create conflict test task');
      const path = `/api/boards/${boardId}/tasks/${created.id}`;
      const draftKey = `tasks.draft.v1.${JSON.stringify([users[0].userId, boardId, created.id])}`;
      const queueKey = `tasks.autosave.${JSON.stringify([users[0].userId, boardId, created.id])}`;
      const readback = async () => (await db.query('SELECT title, description, priority, revision::text AS version FROM tasks WHERE id=$1', [created.id])).rows[0];
      const attach = async (target: Page, client: number) => {
        target.on('pageerror', (error) => errors.push(error.message));
        await target.addInitScript((id) => localStorage.setItem('tasks.globalBoardId', id), boardId);
        await target.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ contentType: 'application/javascript',
          body: `window.Telegram={WebApp:{initData:'isolated-conflict-test',initDataUnsafe:{start_param:'task_${boardId}_${created.id}'},ready(){},expand(){}}};` }));
        await target.route('**/api/**', async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.pathname === '/api/auth/telegram') return route.fulfill({ json: { userId: users[client].userId } });
          const input = request.postData() ? request.postDataJSON() : undefined;
          const response = await app.inject({ method: request.method() as 'GET' | 'POST' | 'PATCH' | 'PUT', url: url.pathname + url.search,
            cookies: { session: users[client].token }, payload: input });
          if (url.pathname === path && request.method() === 'PATCH') writes.push({ client, input, status: response.statusCode });
          await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
        });
        await target.goto('/');
        await expect(target.getByRole('textbox', { name: 'Название задачи' })).toHaveValue('Base title');
      };
      await page.setViewportSize({ width: 390, height: 844 });
      await attach(page, 0);
      await attach(second, 1);
      const title = page.getByRole('textbox', { name: 'Название задачи' });
      const remoteTitle = second.getByRole('textbox', { name: 'Название задачи' });
      const saved = (target: Page) => expect(target.locator('.detail-save-state')).toHaveText('Сохранено');
      const dialog = page.getByRole('dialog', { name: 'Конфликт изменений' });

      await remoteTitle.fill('Remote title');
      await remoteTitle.blur();
      await saved(second);
      await second.getByRole('button', { name: /^Приоритет/ }).click();
      await second.getByRole('radio', { name: 'Срочная', exact: true }).click();
      await saved(second);
      const shownVersion = (await readback()).version;
      await page.locator('.detail-description-actions').getByRole('button', { name: 'Изменить' }).click();
      await page.getByRole('textbox', { name: 'Описание', exact: true }).fill('Independent local description');
      await title.fill('Local title');
      await expect(dialog).toContainText('Local title');
      await expect(dialog).toContainText('Remote title');
      expect(writes.filter((write) => write.client === 0).map((write) => write.status)).toEqual([409]);
      expect(await readback()).toMatchObject({ title: 'Remote title', description: 'Base description', priority: 'urgent' });

      // A deferred conflict survives online, exit and a fresh server snapshot on reload.
      await dialog.getByRole('button', { name: 'Решить позже' }).click();
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await title.fill('Latest local title');
      await title.blur();
      await page.waitForTimeout(1000);
      await expect(page.locator('.detail-save-state')).not.toHaveText('Сохранено');
      await page.getByRole('button', { name: 'Назад к задачам' }).click();
      await page.reload();
      await expect(dialog).toContainText('Latest local title');
      await expect(dialog).toContainText('Remote title');
      expect(writes.filter((write) => write.client === 0)).toHaveLength(1);

      await mkdir(evidence, { recursive: true });
      if (keepLocal) {
        for (const [width, height, textSize] of [[390, 844, 100], [320, 844, 100], [320, 520, 100], [1280, 900, 100], [320, 844, 200]]) {
          await page.setViewportSize({ width, height });
          await page.evaluate((size) => { document.documentElement.style.fontSize = `${size}%`; }, textSize);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await dialog.getByRole('button', { name: 'Решить позже' }).scrollIntoViewIfNeeded();
          await expect(dialog.getByRole('button', { name: 'Решить позже' })).toBeInViewport();
          await page.screenshot({ path: `${evidence}/issue143-conflict-${width}x${height}-${textSize}.png` });
        }
        await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
        await page.setViewportSize({ width: 390, height: 844 });
        // Another writer changes the SAME field after the displayed version. Never overwrite it silently.
        await remoteTitle.fill('Remote changed again');
        await remoteTitle.blur();
        await saved(second);
        await dialog.getByRole('button', { name: 'Моя правка поверх серверной', exact: true }).click();
        await expect(dialog).toContainText('Remote changed again');
        expect(writes.filter((write) => write.client === 0).at(-1)).toMatchObject({ status: 409, input: { expectedVersion: shownVersion } });
        expect((await readback()).title).toBe('Remote changed again');
      }
      const resolutionVersion = (await readback()).version;
      await dialog.getByRole('button', { name: keepLocal ? 'Моя правка поверх серверной' : 'Оставить серверную версию', exact: true }).click();
      await saved(page);
      const resolved = await readback();
      expect(resolved).toMatchObject({ title: keepLocal ? 'Latest local title' : 'Remote title', description: 'Independent local description', priority: 'urgent' });
      const resolution = writes.filter((write) => write.client === 0).at(-1)!;
      expect(resolution).toMatchObject({ status: 200, input: { expectedVersion: resolutionVersion } });
      expect(resolution.input).not.toHaveProperty('priority');
      if (!keepLocal) expect(resolution.input).not.toHaveProperty('title');
      await expect.poll(() => page.evaluate(([draft, queue]) => [localStorage.getItem(draft), localStorage.getItem(queue)], [draftKey, queueKey])).toEqual([null, null]);
      await title.fill('Next local edit');
      await title.blur();
      await saved(page);
      expect(writes.filter((write) => write.client === 0).at(-1)?.input.expectedVersion).toBe(resolved.version);
      const count = writes.length;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await page.getByRole('button', { name: 'Назад к задачам' }).click();
      await page.reload();
      await expect(title).toHaveValue('Next local edit');
      await page.waitForTimeout(1000);
      expect(writes).toHaveLength(count);

      // Stale client changes another field: rebase only its patch, retain the first client's title.
      await second.locator('.detail-description-actions').getByRole('button', { name: 'Изменить' }).click();
      await second.getByRole('textbox', { name: 'Описание', exact: true }).fill('Second client description');
      // The description ALSO changed since this client's base, so this is an explicit conflict.
      const secondDialog = second.getByRole('dialog', { name: 'Конфликт изменений' });
      await expect(secondDialog).toContainText('Independent local description');
      await secondDialog.getByRole('button', { name: 'Моя правка поверх серверной', exact: true }).click();
      await saved(second);
      expect(await readback()).toMatchObject({ title: 'Next local edit', description: 'Second client description', priority: 'urgent' });
      await title.fill('Independent title after remote description');
      await title.blur();
      await saved(page);
      await expect(dialog).toHaveCount(0);
      expect(await readback()).toMatchObject({ title: 'Independent title after remote description', description: 'Second client description' });
      await expect(page.locator('.detail-description-read')).toHaveText('Second client description');

      // The existing atomic guard admits only one writer of the same revision.
      const version = (await readback()).version;
      const racing = await Promise.all(users.map((user, index) => app.inject({ method: 'PATCH', url: path, cookies: { session: user.token },
        payload: { title: `Atomic winner ${index}`, expectedVersion: version } })));
      expect(racing.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      expect((await readback()).title).toBe(racing.find((response) => response.statusCode === 200)!.json().title);
      expect(errors).toEqual([]);
    } finally {
      await second.close();
      await page.close();
      await app.close();
      await db.query('DELETE FROM boards WHERE id=$1', [boardId]);
      for (const user of users) {
        await db.query('DELETE FROM boards WHERE owner_user_id=$1', [user.userId]);
        await db.query('DELETE FROM users WHERE id=$1', [user.userId]);
      }
      await db.end();
    }
  });
}
