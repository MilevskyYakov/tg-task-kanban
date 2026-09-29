import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../api/src/app';
import { addChecklistItem, createDatabase, createTask, login, updateTask } from '../../api/src/db';
import type { Config } from '../../api/src/config';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));

for (const scenario of ['ordinary', 'accept', 'cancel', 'escape', 'reload', 'lost response', 'checklist race', 'version race', 'status conflict', 'permission revoked'] as const) {
  test(`completion through real API/DB: ${scenario}`, async ({ page }) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required for completion browser/API/DB tests');
    const db = createDatabase(databaseUrl);
    const config: Config = { botToken: 'test', databaseUrl, sessionSecret: 'isolated-completion-secret', initDataMaxAgeSeconds: 60,
      sessionMaxAgeSeconds: 3600, host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-completion-webhook',
      publicUrl: 'https://example.test', botUsername: 'test_bot' };
    const user = await login(db, { id: randomBytes(6).readUIntBE(0, 6), first_name: 'Completion test' }, 3600, config.sessionSecret);
    const boardId = (await db.query('SELECT id FROM boards WHERE owner_user_id=$1', [user.userId])).rows[0].id;
    const app = buildApp(config, db);
    const errors: string[] = [];
    const writes: { input: Record<string, any>; status: number }[] = [];
    try {
      const created = await createTask(db, user.userId, boardId, { title: 'Completion test', description: 'Base description', status: 'waiting', waitReason: 'External dependency' });
      if (!created) throw new Error('Could not create completion task');
      if (scenario !== 'ordinary') await addChecklistItem(db, user.userId, boardId, created.id, 'Unfinished step');
      const path = `/api/boards/${boardId}/tasks/${created.id}`;
      const readback = async () => (await db.query('SELECT title, description, status, wait_reason, revision::text AS version FROM tasks WHERE id=$1', [created.id])).rows[0];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript((id) => localStorage.setItem('tasks.globalBoardId', id), boardId);
      await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ contentType: 'application/javascript',
        body: `window.Telegram={WebApp:{initData:'isolated-completion-test',initDataUnsafe:{start_param:'task_${boardId}_${created.id}'},ready(){},expand(){}}};` }));
      await page.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/api/auth/telegram') return route.fulfill({ json: { userId: user.userId } });
        const input = request.postData() ? request.postDataJSON() : undefined;
        const response = await app.inject({ method: request.method() as 'GET' | 'POST' | 'PATCH' | 'PUT', url: url.pathname + url.search,
          cookies: { session: user.token }, payload: input });
        if (url.pathname === path && request.method() === 'PATCH') writes.push({ input, status: response.statusCode });
        if (scenario === 'lost response' && url.pathname === path && input?.confirmIncompleteChecklist && response.statusCode === 200) return route.abort('failed');
        await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
      });
      await page.goto('/');
      const title = page.getByRole('textbox', { name: 'Название задачи' });
      await expect(title).toHaveValue('Completion test');
      await page.locator('.detail-description-actions').getByRole('button', { name: 'Изменить' }).click();
      await page.getByRole('textbox', { name: 'Описание', exact: true }).fill('Independent description');
      await page.locator('.detail-status-action').click();
      await page.getByRole('radio', { name: 'Готово', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Завершить задачу?' });
      const conflict = page.getByRole('dialog', { name: 'Конфликт изменений' });
      if (scenario !== 'ordinary') {
        await expect(dialog).toContainText('Незавершённых пунктов: 1');
        await expect(conflict).toHaveCount(0);
        await expect(page.locator('.detail-save-state')).not.toHaveText('Сохранено');
        expect(await readback()).toMatchObject({ status: 'waiting', wait_reason: 'External dependency' });
        expect(writes.at(-1)).toMatchObject({ status: 409, input: { confirmIncompleteChecklist: false } });
        const count = writes.length;
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await page.waitForTimeout(1000);
        expect(writes).toHaveLength(count);
        await expect(dialog.getByRole('button', { name: 'Отмена', exact: true })).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(dialog.getByRole('button', { name: 'Завершить', exact: true })).toBeFocused();
        if (scenario === 'reload') {
          await page.reload();
          await expect(dialog).toContainText('Незавершённых пунктов: 1');
          expect(writes.at(-1)?.input.confirmIncompleteChecklist).toBe(false);
          expect((await readback()).status).toBe('waiting');
        }
        if (scenario === 'accept') {
          await mkdir(evidence, { recursive: true });
          for (const [width, height, size] of [[390, 844, 100], [320, 844, 100], [320, 520, 100], [1280, 900, 100], [320, 844, 200]]) {
            await page.setViewportSize({ width, height });
            await page.evaluate((value) => { document.documentElement.style.fontSize = `${value}%`; }, size);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await dialog.getByRole('button', { name: 'Завершить', exact: true }).scrollIntoViewIfNeeded();
            await expect(dialog.getByRole('button', { name: 'Завершить', exact: true })).toBeInViewport();
            await page.screenshot({ path: `${evidence}/issue145-completion-${width}x${height}-${size}.png` });
          }
        }
        if (scenario === 'checklist race') await addChecklistItem(db, user.userId, boardId, created.id, 'New step during confirmation');
        if (scenario === 'version race') await updateTask(db, user.userId, boardId, created.id, { title: 'Remote title' });
        if (scenario === 'status conflict') await updateTask(db, user.userId, boardId, created.id, { status: 'in_progress' });
        if (scenario === 'permission revoked') await db.query("UPDATE boards SET status='frozen' WHERE id=$1", [boardId]);
        if (scenario === 'cancel') await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
        else if (scenario === 'escape') await page.keyboard.press('Escape');
        else await dialog.getByRole('button', { name: 'Завершить', exact: true }).click();
        if (scenario === 'checklist race' || scenario === 'version race') {
          await expect.poll(() => writes.filter((write) => write.input.confirmIncompleteChecklist).length).toBe(1);
          await expect(dialog).toContainText(`Незавершённых пунктов: ${scenario === 'checklist race' ? 2 : 1}`);
          expect(writes.find((write) => write.input.confirmIncompleteChecklist)?.status).toBe(409);
          expect((await readback()).status).toBe('waiting');
          await dialog.getByRole('button', { name: 'Завершить', exact: true }).click();
        }
        if (scenario === 'status conflict') {
          await expect(conflict).toContainText('В работе');
          await expect(dialog).toHaveCount(0);
          expect((await readback()).status).toBe('in_progress');
          await conflict.getByRole('button', { name: 'Оставить серверную версию', exact: true }).click();
        }
        if (scenario === 'permission revoked') {
          await expect(page.getByRole('alert')).toContainText('task action is not allowed');
          expect((await readback()).status).toBe('waiting');
          const rejectedCount = writes.length;
          await page.evaluate(() => window.dispatchEvent(new Event('online')));
          await page.waitForTimeout(1000);
          expect(writes).toHaveLength(rejectedCount);
          expect(errors).toEqual([]);
          return;
        }
      }
      await expect(page.locator('.detail-save-state')).toHaveText('Сохранено');
      const cancelled = scenario === 'cancel' || scenario === 'escape';
      expect(await readback()).toMatchObject({ description: 'Independent description', status: cancelled ? 'waiting' : scenario === 'status conflict' ? 'in_progress' : 'done',
        wait_reason: cancelled ? 'External dependency' : null, title: scenario === 'version race' ? 'Remote title' : 'Completion test' });
      await expect(dialog).toHaveCount(0);
      await expect(conflict).toHaveCount(0);
      if (scenario !== 'ordinary') expect((await db.query('SELECT count(*)::int AS count FROM task_checklist_items WHERE task_id=$1 AND completed_at IS NULL', [created.id])).rows[0].count).toBe(scenario === 'checklist race' ? 2 : 1);
      const previousWrites = writes.length;
      await title.fill('Text after completion decision');
      await title.blur();
      await expect(page.locator('.detail-save-state')).toHaveText('Сохранено');
      expect(writes.slice(previousWrites)).toHaveLength(1);
      expect(writes.at(-1)?.input).not.toHaveProperty('status');
      expect(writes.at(-1)?.input.confirmIncompleteChecklist).toBe(false);
      await page.reload();
      await expect(title).toHaveValue('Text after completion decision');
      await expect(dialog).toHaveCount(0);
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
