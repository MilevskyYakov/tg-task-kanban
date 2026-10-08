import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../api/src/app';
import { createDatabase, createRecurrence, createTask, login, runRecurrenceScheduler, updateTask } from '../../api/src/db';
import type { Config } from '../../api/src/config';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));

for (const scenario of ['success', 'cancel', 'lost response', 'failure', 'denied', 'version race', 'pending save', 'invalid draft', 'failed autosave', 'plain', 'frozen', 'archived'] as const) {
  test(`explicit future apply through real API/DB: ${scenario}`, async ({ page }) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required for future apply tests');
    const db = createDatabase(databaseUrl);
    const config: Config = { botToken: 'test', databaseUrl, sessionSecret: 'isolated-future-secret', initDataMaxAgeSeconds: 60,
      sessionMaxAgeSeconds: 3600, host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-future-webhook',
      publicUrl: 'https://example.test', botUsername: 'test_bot' };
    const user = await login(db, { id: randomBytes(6).readUIntBE(0, 6), first_name: 'Future test' }, 3600, config.sessionSecret);
    const boardId = (await db.query('SELECT id FROM boards WHERE owner_user_id=$1', [user.userId])).rows[0].id;
    const app = buildApp(config, db);
    const errors: string[] = [];
    const writes: { future: boolean; input: Record<string, any>; status: number }[] = [];
    let fail = scenario === 'failure' || scenario === 'failed autosave';
    let loseResponse = scenario === 'lost response';
    let activeWrites = 0;
    let maxWrites = 0;
    try {
      const recurrence = await createRecurrence(db, user.userId, boardId, {
        title: 'Series title', description: 'Series description', frequency: 'daily', localTime: '09:00', timezone: 'UTC', startAt: '2026-01-01T09:00:00Z'
      });
      await runRecurrenceScheduler(db, new Date('2026-01-02T09:00:00Z'));
      const rows = (await db.query('SELECT * FROM tasks WHERE board_id=$1 ORDER BY occurrence_at', [boardId])).rows;
      const past = rows[0];
      const task = scenario === 'plain' ? await createTask(db, user.userId, boardId, { title: 'Series title' }) : rows[1];
      if (scenario === 'frozen') await db.query("UPDATE boards SET status='frozen' WHERE id=$1", [boardId]);
      if (scenario === 'archived') await db.query('UPDATE tasks SET archived_at=now() WHERE id=$1', [task.id]);
      const path = `/api/boards/${boardId}/tasks/${task.id}`;
      const readTask = async (id = task.id) => (await db.query('SELECT *, revision::text AS version FROM tasks WHERE id=$1', [id])).rows[0];
      const readTemplate = async () => (await db.query('SELECT * FROM recurrence_templates WHERE id=$1', [recurrence.id])).rows[0];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript((id) => localStorage.setItem('tasks.globalBoardId', id), boardId);
      await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ contentType: 'application/javascript',
        body: `window.Telegram={WebApp:{initData:'isolated-future-test',initDataUnsafe:{start_param:'task_${boardId}_${task.id}'},ready(){},expand(){}}};` }));
      await page.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/api/auth/telegram') return route.fulfill({ json: { userId: user.userId } });
        const input = request.postData() ? request.postDataJSON() : undefined;
        const saving = url.pathname === path && request.method() === 'PATCH';
        const future = url.searchParams.get('scope') === 'future';
        if (saving) {
          maxWrites = Math.max(maxWrites, ++activeWrites);
          if (scenario === 'pending save') await new Promise((resolve) => setTimeout(resolve, 250));
          if (fail && (future || scenario === 'failed autosave')) {
            writes.push({ future, input, status: 500 });
            activeWrites--;
            return route.fulfill({ status: 500, json: { error: 'Synthetic save failure' } });
          }
        }
        const response = await app.inject({ method: request.method() as 'GET' | 'POST' | 'PATCH' | 'PUT', url: url.pathname + url.search,
          cookies: { session: user.token }, payload: input });
        if (saving) {
          writes.push({ future, input, status: response.statusCode });
          activeWrites--;
          if (future && loseResponse && response.statusCode === 200) { loseResponse = false; return route.abort('failed'); }
        }
        await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
      });
      await page.goto('/');
      const title = page.getByRole('textbox', { name: 'Название задачи' });
      if (scenario === 'archived') {
        await expect(page.getByRole('heading', { name: 'Задача не найдена' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Применить к будущим повторам', exact: true })).toHaveCount(0);
        expect(writes).toEqual([]);
        return;
      }
      await expect(title).toHaveValue('Series title');
      const menu = page.getByRole('button', { name: 'Другие действия' });
      const open = page.getByRole('button', { name: 'Применить к будущим повторам', exact: true });
      const dialog = page.getByRole('dialog', { name: 'Будущие повторы' });
      const confirm = dialog.getByRole('button', { name: 'Применить', exact: true });
      const seriesStatus = page.locator('.detail-series-result');
      if (['plain', 'frozen'].includes(scenario)) {
        await menu.click();
        await expect(open).toHaveCount(0);
        await expect(page.getByRole('checkbox', { name: 'Изменить этот и будущие повторы' })).toHaveCount(0);
        expect(writes).toEqual([]);
        return;
      }
      if (scenario === 'invalid draft') {
        await title.fill('');
        await menu.click();
        await open.click();
        await expect(dialog).toHaveCount(0);
        await expect(page.locator('#detail-title-error')).toHaveText('Название задачи обязательно');
        await expect(seriesStatus).toContainText('Сначала сохраните');
        expect(writes.filter((write) => write.future)).toEqual([]);
        expect((await readTemplate()).title).toBe('Series title');
        return;
      }
      await title.fill('Applied title');
      if (scenario !== 'pending save') await title.blur();
      if (scenario === 'failed autosave') await expect(page.locator('.detail-save-state')).toContainText('Не сохранено');
      else if (scenario !== 'pending save') await expect(page.locator('.detail-save-state')).toHaveText('Сохранено');
      expect((await readTemplate()).title).toBe('Series title');
      await menu.click();
      await open.click();
      if (scenario === 'failed autosave') {
        await expect(dialog).toHaveCount(0);
        await expect(seriesStatus).toContainText('Сначала сохраните');
        expect(writes.filter((write) => write.future)).toEqual([]);
        return;
      }
      await expect(dialog).toContainText('Applied title');
      for (const label of ['Название', 'Описание', 'Проект', 'Исполнитель', 'Важность', 'Срочность']) await expect(dialog.getByRole('heading', { name: label, exact: true })).toBeVisible();
      await expect(dialog).toContainText('Статус, блокер, срок и уже созданные задачи не изменятся');
      await expect(dialog.locator('p').first()).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(confirm).toBeFocused();
      expect(writes.filter((write) => write.future)).toEqual([]);
      if (scenario === 'cancel') {
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(open).toBeFocused();
        expect((await readTemplate()).title).toBe('Series title');
      } else {
        if (scenario === 'success') {
          await mkdir(evidence, { recursive: true });
          for (const [width, height, size] of [[390, 844, 100], [320, 844, 100], [320, 520, 100], [1280, 900, 100], [320, 844, 200]]) {
            await page.setViewportSize({ width, height });
            await page.evaluate((value) => { document.documentElement.style.fontSize = `${value}%`; }, size);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await dialog.evaluate((element) => { element.scrollTop = 0; });
            await page.screenshot({ path: `${evidence}/issue148-future-top-${width}x${height}-${size}.png` });
            await confirm.scrollIntoViewIfNeeded();
            await expect(confirm).toBeInViewport();
            await page.screenshot({ path: `${evidence}/issue148-future-${width}x${height}-${size}.png` });
          }
          await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
          await page.setViewportSize({ width: 390, height: 844 });
        }
        if (scenario === 'version race') await updateTask(db, user.userId, boardId, task.id, { title: 'Concurrent title' });
        if (scenario === 'denied') await db.query("UPDATE boards SET status='frozen' WHERE id=$1", [boardId]);
        await confirm.click();
        if (['lost response', 'failure', 'denied', 'version race'].includes(scenario)) {
          await expect(seriesStatus).toHaveAttribute('role', 'alert');
          await expect(seriesStatus).not.toHaveText('Применено к будущим повторам');
          const count = writes.length;
          await page.evaluate(() => window.dispatchEvent(new Event('online')));
          await page.waitForTimeout(1000);
          expect(writes).toHaveLength(count);
          expect((await readTemplate()).title).toBe(scenario === 'lost response' ? 'Applied title' : 'Series title');
          if (scenario === 'denied') return;
          fail = false;
          await open.click();
          await expect(dialog).toContainText(scenario === 'version race' ? 'Concurrent title' : 'Applied title');
          await confirm.click();
        }
        await expect(seriesStatus).toHaveText('Применено к будущим повторам');
        expect((await readTemplate()).title).toBe(scenario === 'version race' ? 'Concurrent title' : 'Applied title');
        const payload = writes.filter((write) => write.future).at(-1)!.input;
        expect(Object.keys(payload).sort()).toEqual(['assigneeUserId', 'confirmIncompleteChecklist', 'description', 'expectedRecurrenceVersion', 'expectedVersion', 'importance', 'projectId', 'title', 'urgency']);
        expect((await readTask(past.id)).title).toBe('Series title');
        await runRecurrenceScheduler(db, new Date('2026-01-03T09:00:00Z'));
        const future = (await db.query('SELECT * FROM tasks WHERE board_id=$1 ORDER BY occurrence_at DESC LIMIT 1', [boardId])).rows[0];
        expect(future.title).toBe((await readTemplate()).title);
      }
      const templateBeforeEdit = await readTemplate();
      const previousCount = writes.length;
      await title.fill('Next instance-only title');
      await title.blur();
      await expect(page.locator('.detail-save-state')).toHaveText('Сохранено');
      expect(writes.slice(previousCount)).toHaveLength(1);
      expect(writes.at(-1)?.future).toBe(false);
      expect(await readTemplate()).toEqual(templateBeforeEdit);
      expect((await readTask()).title).toBe('Next instance-only title');
      expect(maxWrites).toBe(1);
      await page.reload();
      await expect(title).toHaveValue('Next instance-only title');
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      await app.close();
      await db.query('DELETE FROM boards WHERE owner_user_id=$1', [user.userId]);
      await db.query('DELETE FROM users WHERE id=$1', [user.userId]);
      await db.end();
    }
  });
}
