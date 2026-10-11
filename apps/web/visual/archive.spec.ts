import { expect, test } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../../api/src/app';
import { createDatabase, createTask, login, setTaskArchived, updateTask } from '../../api/src/db';
import type { Config } from '../../api/src/config';

for (const scenario of ['member', 'admin', 'owner', 'creator', 'assignee', 'frozen', 'assignment race', 'board race', 'archive race', 'pending save', 'failed save', 'invalid draft'] as const) {
  test(`archive permissions and save boundary with real API/DB: ${scenario}`, async ({ page }) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');
    const db = createDatabase(databaseUrl);
    const stamp = randomBytes(6).readUIntBE(0, 6);
    const config: Config = { botToken: 'test', databaseUrl, sessionSecret: 'isolated-archive-ui', initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 3600,
      host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-test', publicUrl: 'https://example.test', botUsername: 'test_bot' };
    const creator = await login(db, { id: stamp, first_name: 'Synthetic creator' }, 3600, config.sessionSecret);
    const other = await login(db, { id: stamp + 1, first_name: 'Synthetic other' }, 3600, config.sessionSecret);
    const boardId = randomUUID();
    const app = buildApp(config, db);
    let releaseSave = () => {};
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
    try {
      await db.query("INSERT INTO boards (id,type,name,telegram_chat_id,status) VALUES ($1,'chat','Synthetic Reels',$2,'active')", [boardId, -stamp]);
      await db.query("INSERT INTO memberships (board_id,user_id,role) VALUES ($1,$2,'member'),($1,$3,$4)", [boardId, creator.userId, other.userId, ['admin', 'owner'].includes(scenario) ? scenario : 'member']);
      const assigned = ['assignee', 'assignment race'].includes(scenario);
      const viewer = ['member', 'admin', 'owner'].includes(scenario) || assigned ? other : creator;
      const task = await createTask(db, creator.userId, boardId, { title: 'Synthetic archive task', assigneeUserId: assigned ? other.userId : null });
      const path = `/api/boards/${boardId}/tasks/${task.id}`;
      if (scenario === 'frozen') await db.query("UPDATE boards SET status='frozen' WHERE id=$1", [boardId]);
      const snapshot = async () => (await db.query(`SELECT row_to_json(t) AS task,
        (SELECT count(*)::int FROM task_audit_events WHERE task_id=t.id) AS events
        FROM tasks t WHERE id=$1`, [task.id])).rows[0];
      let deletes = 0, patches = 0;
      let raceSnapshot: Awaited<ReturnType<typeof snapshot>>;
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewportSize({ width: 320, height: 844 });
      await page.route('https://telegram.org/js/telegram-web-app.js', route => route.fulfill({ contentType: 'application/javascript',
        body: `window.Telegram={WebApp:{initData:'isolated',initDataUnsafe:{start_param:'task_${boardId}_${task.id}'},ready(){},expand(){}}};` }));
      await page.route('**/api/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/api/auth/telegram') return route.fulfill({ json: { userId: viewer.userId } });
        if (url.pathname === path && request.method() === 'PATCH') {
          patches++;
          if (scenario === 'pending save') await saveGate;
          if (scenario === 'failed save') return route.fulfill({ status: 503, json: { error: 'Не удалось сохранить задачу' } });
        }
        if (url.pathname === path && request.method() === 'DELETE') {
          deletes++;
          if (scenario === 'assignment race') await updateTask(db, creator.userId, boardId, task.id, { assigneeUserId: null });
          if (scenario === 'board race') await db.query("UPDATE boards SET status='frozen' WHERE id=$1", [boardId]);
          if (scenario === 'archive race') await setTaskArchived(db, creator.userId, boardId, task.id, true);
          raceSnapshot = await snapshot();
        }
        const response = await app.inject({ method: request.method() as 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: url.pathname + url.search,
          cookies: { session: viewer.token }, payload: request.postData() ? request.postDataJSON() : undefined });
        await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
      });
      await page.goto('/');
      const title = page.getByRole('textbox', { name: 'Название задачи' });
      await expect(title).toHaveValue(task.title);
      if (['pending save', 'failed save', 'invalid draft'].includes(scenario)) await title.fill(scenario === 'invalid draft' ? '' : 'Edited before archive');
      await page.getByRole('button', { name: 'Другие действия' }).click();
      const archive = page.getByRole('button', { name: 'Архивировать задачу', exact: true });
      const before = await snapshot();
      if (['member', 'admin', 'owner', 'frozen'].includes(scenario)) {
        const reason = scenario === 'frozen' ? 'Доска доступна только для чтения' : 'Архивировать задачу может только её автор или исполнитель';
        await expect(archive).toBeDisabled();
        await expect(archive).toHaveAccessibleDescription(reason);
        await expect(page.locator('#detail-archive-restriction')).toBeVisible();
        expect(deletes).toBe(0);
        expect(await snapshot()).toEqual(before);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (scenario === 'admin') await page.screenshot({ path: test.info().outputPath('archive-restriction-320.png') });
      } else {
        await expect(archive).toBeEnabled();
        await archive.click();
        if (scenario === 'pending save') {
          await expect.poll(() => patches).toBe(1);
          await expect(archive).toBeDisabled();
          expect(deletes).toBe(0);
          releaseSave();
        }
        if (['assignment race', 'board race', 'archive race'].includes(scenario)) {
          const reason = scenario === 'assignment race' ? 'Архивировать задачу может только её автор или исполнитель'
            : scenario === 'board race' ? 'Доска доступна только для чтения' : 'Задача уже в архиве';
          await expect(page.getByRole('alert')).toHaveText(reason);
          await expect(title).toHaveValue(task.title);
          expect(await snapshot()).toEqual(raceSnapshot);
          expect(deletes).toBe(1);
        } else if (['failed save', 'invalid draft'].includes(scenario)) {
          await expect(page.getByRole('alert').filter({ hasText: 'Сначала сохраните правки задачи' })).toBeVisible();
          await expect(title).toHaveValue(scenario === 'invalid draft' ? '' : 'Edited before archive');
          expect(deletes).toBe(0);
          expect(await snapshot()).toEqual(before);
        } else {
          await expect(title).toHaveCount(0);
          const saved = await snapshot();
          expect(saved.task.archived_at).not.toBeNull();
          expect(saved.task.status).toBe('todo');
          expect(saved.task.title).toBe(scenario === 'pending save' ? 'Edited before archive' : task.title);
          expect(deletes).toBe(1);
          // Restore is a separate action and keeps the saved content/history.
          const restored = await app.inject({ method: 'POST', url: path + '/reopen', cookies: { session: viewer.token } });
          expect(restored.statusCode).toBe(200);
          expect((await snapshot()).task.archived_at).toBeNull();
        }
      }
      expect(errors).toEqual([]);
    } finally {
      releaseSave();
      await page.close();
      await app.close();
      await db.query('DELETE FROM boards WHERE id=$1 OR owner_user_id=ANY($2)', [boardId, [creator.userId, other.userId]]);
      await db.query('DELETE FROM users WHERE id=ANY($1)', [[creator.userId, other.userId]]);
      await db.end();
    }
  });
}
