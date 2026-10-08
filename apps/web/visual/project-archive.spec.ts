import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../../api/src/app';
import { createDatabase, createProject, createRecurrence, createTask, login, updateProject } from '../../api/src/db';
import type { Config } from '../../api/src/config';

for (const width of [390, 320]) test(`archived project: edit, complete, apply and pause via real API/DB at ${width}px`, async ({ page }) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required for project archive tests');
  const db = createDatabase(databaseUrl);
  const config: Config = { botToken: 'test', databaseUrl, sessionSecret: 'isolated-archive-browser-secret', initDataMaxAgeSeconds: 60,
    sessionMaxAgeSeconds: 3600, host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-archive-webhook',
    publicUrl: 'https://example.test', botUsername: 'test_bot' };
  const user = await login(db, { id: randomBytes(6).readUIntBE(0, 6), first_name: 'Archive test' }, 3600, config.sessionSecret);
  const board = (await db.query('SELECT id,name FROM boards WHERE owner_user_id=$1', [user.userId])).rows[0];
  const app = buildApp(config, db);
  const errors: string[] = [];
  const writes: { path: string; input: Record<string, any>; status: number }[] = [];
  try {
    const project = await createProject(db, user.userId, board.id, 'Historical project');
    const active = await createProject(db, user.userId, board.id, 'Active project');
    const recurrence = await createRecurrence(db, user.userId, board.id, { title: 'Original series', projectId: project.id,
      frequency: 'daily', localTime: '09:00', timezone: 'UTC', startAt: '2099-01-01T09:00:00Z' });
    const task = await createTask(db, user.userId, board.id, { title: 'Original task', projectId: project.id, assigneeUserId: user.userId });
    await db.query('UPDATE tasks SET recurrence_template_id=$2, occurrence_at=$3 WHERE id=$1', [task.id, recurrence.id, '2099-01-01T09:00:00Z']);
    await updateProject(db, user.userId, board.id, project.id, { archived: true });
    const readTask = async () => (await db.query('SELECT * FROM tasks WHERE id=$1', [task.id])).rows[0];
    const readSeries = async () => (await db.query('SELECT * FROM recurrence_templates WHERE id=$1', [recurrence.id])).rows[0];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript((id) => localStorage.setItem('tasks.globalBoardId', id), board.id);
    await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ contentType: 'application/javascript',
      body: `window.Telegram={WebApp:{initData:'isolated-archive-test',initDataUnsafe:{start_param:'task_${board.id}_${task.id}'},ready(){},expand(){}}};` }));
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/auth/telegram') return route.fulfill({ json: { userId: user.userId } });
      const input = request.postData() ? request.postDataJSON() : undefined;
      const response = await app.inject({ method: request.method() as 'GET' | 'POST' | 'PATCH', url: url.pathname + url.search,
        cookies: { session: user.token }, payload: input });
      if (request.method() === 'PATCH') writes.push({ path: url.pathname + url.search, input, status: response.statusCode });
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });
    await page.goto('/');
    const title = page.getByRole('textbox', { name: 'Название задачи' });
    const projectButton = page.getByRole('button', { name: /Проект Historical project/ });
    await expect(title).toHaveValue('Original task');
    await expect(projectButton).toBeVisible();
    await title.fill('Edited after archive');
    await title.blur();
    await expect(page.locator('.detail-save-state')).toHaveText('Сохранено');
    expect((await readTask()).title).toBe('Edited after archive');
    expect((await readTask()).project_id).toBe(project.id);
    await page.reload();
    await expect(title).toHaveValue('Edited after archive');
    await expect(projectButton).toBeVisible();
    await page.getByRole('button', { name: 'Назад к задачам' }).click();
    await page.locator('.unassessed-tasks summary').click();
    await page.locator('.task-summary').filter({ hasText: 'Edited after archive' }).click();
    await expect(projectButton).toBeVisible();
    await projectButton.click();
    const choices = page.getByRole('dialog', { name: 'Проект', exact: true });
    await expect(choices.getByRole('radio', { name: project.name })).toHaveCount(0);
    await expect(choices.getByRole('radio', { name: active.name })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Другие действия' }).click();
    await page.getByRole('button', { name: 'Применить к будущим повторам', exact: true }).click();
    await page.getByRole('dialog', { name: 'Будущие повторы' }).getByRole('button', { name: 'Применить', exact: true }).click();
    await expect(page.locator('.detail-series-result')).toHaveText('Применено к будущим повторам');
    expect((await readSeries()).title).toBe('Edited after archive');
    expect((await readSeries()).project_id).toBe(project.id);
    expect(writes.find((write) => write.path.endsWith('?scope=future'))?.input.projectId).toBe(project.id);
    await page.getByRole('button', { name: 'Другие действия' }).click();
    await page.locator('.detail-status-action').click();
    await page.getByRole('radio', { name: 'Готово', exact: true }).click();
    await expect(page.locator('.detail-save-state')).toHaveText('Сохранено');
    expect((await readTask()).status).toBe('done');
    await page.getByRole('button', { name: 'Назад к задачам' }).click();
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByRole('button', { name: /Автоматизация/ }).click();
    await page.getByRole('button', { name: new RegExp(board.name) }).click();
    const series = page.locator('.automation-row').filter({ hasText: 'Edited after archive' });
    await series.getByRole('button', { name: 'Пауза', exact: true }).click();
    await expect(series.getByRole('button', { name: 'Включить', exact: true })).toBeVisible();
    expect((await readSeries()).paused_at).not.toBeNull();
    expect((await readSeries()).project_id).toBe(project.id);
    expect(writes).toHaveLength(4);
    expect(writes.every((write) => write.status === 200)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await app.close();
    await db.query('DELETE FROM boards WHERE owner_user_id=$1', [user.userId]);
    await db.query('DELETE FROM users WHERE id=$1', [user.userId]);
    await db.end();
  }
});
