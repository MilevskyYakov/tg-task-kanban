import { expect, test, type Page } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../api/src/app';
import { createDatabase, createProject, createTask, login } from '../../api/src/db';
import type { Config } from '../../api/src/config';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for backlog browser/API/DB tests');

for (const width of [390, 320]) {
  test(`backlog collection and two-member claim through real API/DB ${width}`, async ({ page, browser }) => {
    const db = createDatabase(url);
    const stamp = randomBytes(6).readUIntBE(0, 6);
    const config: Config = { botToken: 'test', databaseUrl: url, sessionSecret: 'isolated-visual-secret', initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 3600,
      host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-visual-webhook', publicUrl: 'https://example.test', botUsername: 'test_bot' };
    const owner = await login(db, { id: stamp, first_name: 'Автор' }, 3600, config.sessionSecret);
    const member = await login(db, { id: stamp + 1, first_name: 'Анна' }, 3600, config.sessionSecret);
    const boardId = randomUUID();
    const app = buildApp(config, db);
    const second = await browser.newPage({ viewport: { width, height: 844 } });
    const requests: Record<string, any>[] = [];
    const errors: string[] = [];
    let failure = 'none';
    let releaseBulk: (() => void) | undefined;
    const bulkGate = new Promise<void>((resolve) => { releaseBulk = resolve; });
    let releaseLoad: (() => void) | undefined;
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
    const attempts = new Map<string, number>();
    try {
      await db.query("INSERT INTO boards (id, type, name, telegram_chat_id, status) VALUES ($1, 'chat', 'Команда', $2, 'active')", [boardId, -stamp]);
      for (const person of [owner, member]) await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'member')", [boardId, person.userId]);
      const project = await createProject(db, owner.userId, boardId, 'Запуск сайта');
      const candidate = await createTask(db, owner.userId, boardId, { title: 'Согласовать бюджет', projectId: project.id });
      for (const status of ['in_progress', 'waiting', 'done'] as const) await createTask(db, owner.userId, boardId, { title: `Статус ${status}`, status, ...(status === 'waiting' ? { waitReason: 'Проверка' } : {}) });
      const attach = async (target: Page, person: typeof owner) => {
        target.on('pageerror', (error) => errors.push(error.message));
        await target.addInitScript((id) => localStorage.setItem('tasks.globalBoardId', id), boardId);
        await target.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ contentType: 'application/javascript', body: "window.Telegram={WebApp:{initData:'isolated-browser-test',ready(){},expand(){}}};" }));
        await target.route('**/api/**', async (route) => {
          const request = route.request();
          const path = new URL(request.url()).pathname + new URL(request.url()).search;
          if (path === '/api/auth/telegram') return route.fulfill({ json: { userId: person.userId } });
          const payload = request.postData() ? request.postDataJSON() : undefined;
          if (failure === 'load' && request.method() === 'GET' && path.endsWith('/tasks')) {
            await loadGate;
            return route.fulfill({ status: 503, json: { error: 'Нет связи' } });
          }
          if (request.method() === 'POST' && path.endsWith('/tasks')) {
            requests.push(payload);
            const attempt = (attempts.get(payload.requestId) ?? 0) + 1;
            attempts.set(payload.requestId, attempt);
            if (failure === 'bulk' && payload.title === 'Согласовать бюджет' && attempt === 1) await bulkGate;
            if (failure === 'bulk' && payload.title === 'Проверить страницу' && attempt === 1) return route.fulfill({ status: 503, json: { error: 'Временный отказ' } });
          }
          const response = await app.inject({ method: request.method() as 'GET' | 'POST' | 'PATCH' | 'PUT', url: path, cookies: { session: person.token }, payload });
          if (failure === 'claim-response' && path.endsWith('/claim') && response.statusCode === 200) {
            failure = 'none';
            return route.abort('failed');
          }
          if (failure === 'bulk' && payload?.title === 'Подготовить тексты' && attempts.get(payload.requestId) === 1) return route.abort('failed');
          await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
        });
        await target.goto('/');
        await expect(target.getByRole('button', { name: 'Бэклог 1', exact: true })).toBeVisible();
      };
      await page.setViewportSize({ width, height: 844 });
      await attach(page, owner);
      await attach(second, member);
      await mkdir(evidence, { recursive: true });
      const shot = async (name: string) => {
        await page.evaluate(() => document.fonts.ready);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: `${evidence}/issue78-${name}-${width}.png` });
      };
      await page.getByRole('button', { name: 'Бэклог 1', exact: true }).click();
      await expect(page.locator('.backlog-row')).toHaveCount(1);
      await shot('backlog');
      await page.getByRole('button', { name: /Проект.*Все проекты/ }).click();
      await page.getByRole('radio', { name: 'Запуск сайта' }).click();
      await expect(page.getByRole('button', { name: /Проект.*Запуск сайта/ })).toBeFocused();
      await page.getByRole('button', { name: 'Вставить список' }).click();
      await page.getByRole('textbox', { name: 'Список задач' }).fill(`Согласовать бюджет\n\n${'я'.repeat(201)}\nПроверить страницу`);
      await page.getByRole('button', { name: 'Проверить список' }).click();
      await expect(page.getByRole('button', { name: 'Создать 3 задачи' })).toBeDisabled();
      await expect(page.getByRole('alert')).toContainText('200 символов');
      await shot('bulk-invalid');
      await page.getByRole('button', { name: 'Изменить текст' }).click();
      await page.getByRole('textbox', { name: 'Список задач' }).fill('Согласовать бюджет\n\nПодготовить тексты\nПроверить страницу');
      await shot('bulk-input');
      await page.getByRole('button', { name: 'Проверить список' }).click();
      await shot('bulk-preview');
      failure = 'bulk';
      await page.getByRole('button', { name: 'Создать 3 задачи' }).click();
      await expect(page.getByRole('button', { name: 'Сохраняем…' })).toBeDisabled();
      await page.getByRole('button', { name: 'Сохраняем…' }).dispatchEvent('click');
      releaseBulk!();
      await expect(page.getByRole('heading', { name: 'Сохранено 1 из 3' })).toBeVisible();
      await shot('bulk-partial');
      await page.getByRole('button', { name: 'К бэклогу', exact: true }).last().click();
      await page.getByRole('button', { name: 'Продолжить список' }).click();
      await expect(page.getByRole('heading', { name: 'Сохранено 1 из 3' })).toBeVisible();
      await page.getByRole('button', { name: 'Повторить: 2' }).click();
      await expect(page.getByRole('heading', { name: '3 задачи в бэклоге' })).toBeVisible();
      await shot('bulk-success');
      expect(requests.length).toBe(5);
      expect(new Set(requests.map((item) => item.requestId)).size).toBe(3);
      const batch = (await db.query('SELECT * FROM tasks WHERE board_id = $1 AND create_request_id IS NOT NULL', [boardId])).rows;
      expect(batch).toHaveLength(3);
      expect(batch.every((item) => item.project_id === project.id && item.status === 'todo' && !item.deadline && !item.assignee_user_id)).toBe(true);
      await page.getByRole('button', { name: 'Открыть бэклог' }).click();
      await expect(page.locator('.backlog-row')).toHaveCount(4);

      // Both users see the same unassigned task; instant claim from the row keeps the backlog open.
      await shot('backlog-rows');
      await second.getByRole('button', { name: 'Бэклог 1', exact: true }).click();
      await second.locator('.backlog-row').filter({ hasText: candidate.title }).last().getByRole('button', { name: 'Взять себе' }).click();
      await expect(second.getByRole('status')).toContainText('Задача теперь ваша');
      await expect(second.getByRole('button', { name: /^Бэклог/ })).toHaveAttribute('aria-pressed', 'true');
      await expect(second.locator('.backlog-row').filter({ hasText: candidate.title })).toHaveCount(0);
      expect((await db.query('SELECT status, assignee_user_id FROM tasks WHERE id = $1', [candidate.id])).rows[0]).toEqual({ status: 'todo', assignee_user_id: member.userId });
      // Competing claim from the first user loses; the row leaves the backlog after the refresh.
      await page.locator('.backlog-row').filter({ hasText: candidate.title }).last().getByRole('button', { name: 'Взять себе' }).click();
      await expect(page.getByRole('status')).toContainText('Задача уже назначена: Анна');
      await shot('claim-conflict');
      await expect(page.locator('.backlog-row')).toHaveCount(3);
      // Lost response: no false success; the refresh reflects the server-side claim
      // (the harness aborts after the API returned 200) and stays on the backlog.
      failure = 'claim-response';
      await page.locator('.backlog-row').filter({ hasText: 'Проверить страницу' }).getByRole('button', { name: 'Взять себе' }).click();
      await expect(page.getByRole('status')).toContainText('Нет подтверждения сервера');
      await expect(page.getByRole('button', { name: /^Бэклог/ })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.backlog-row').filter({ hasText: 'Проверить страницу' })).toHaveCount(0);
      await expect(page.locator('.backlog-row')).toHaveCount(2);
      failure = 'none';
      // Consecutive claims without leaving the backlog: next row is claimable immediately.
      await page.locator('.backlog-row').filter({ hasText: 'Подготовить тексты' }).getByRole('button', { name: 'Взять себе' }).click();
      await expect(page.getByRole('status')).toContainText('Задача теперь ваша');
      await expect(page.getByRole('button', { name: /^Бэклог/ })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.backlog-row')).toHaveCount(1);
      await shot('claim-success');
      expect((await db.query('SELECT count(*)::int AS c FROM tasks WHERE board_id = $1 AND status = $2 AND assignee_user_id IS NOT NULL', [boardId, 'todo'])).rows[0].c).toBe(3);

      await page.getByRole('button', { name: 'Все', exact: true }).click();
      await page.getByRole('button', { name: 'Фильтры', exact: true }).click();
      await page.getByRole('button', { name: 'Другие фильтры' }).click();
      // «Все» keeps the project filter; clear it to see unassigned tasks of all projects.
      await page.getByRole('button', { name: /Проект.*Запуск сайта/ }).click();
      await page.getByRole('radio', { name: 'Все проекты' }).click();
      await page.getByRole('checkbox', { name: 'Без ответственного', exact: true }).click();
      await page.getByRole('button', { name: /Показать .* задач/ }).click();
      await expect(page.locator('.main-task-row').filter({ hasText: 'Статус in_progress' })).toBeVisible();
      await expect(page.locator('.main-task-row').filter({ hasText: 'Статус waiting' })).toBeVisible();
      await shot('all-unassigned');
      await page.getByRole('button', { name: /Фильтры/ }).click();
      await page.getByRole('button', { name: 'Другие фильтры' }).click();
      await page.getByRole('button', { name: /Статус.*Без завершённых/ }).click();
      await page.getByRole('radio', { name: 'Готово', exact: true }).click();
      await page.getByRole('button', { name: /Показать .* задач/ }).click();
      await expect(page.locator('.main-task-row').filter({ hasText: 'Статус done' })).toBeVisible();

      await page.getByRole('button', { name: 'Бэклог 1', exact: true }).click();
      await page.getByRole('button', { name: /Проект.*Все проекты/ }).click();
      await page.getByRole('radio', { name: 'Запуск сайта' }).click();
      await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
      await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Первая в серии');
      await page.getByRole('button', { name: /Статус.*К выполнению/ }).click();
      await page.getByRole('radio', { name: 'Блокер' }).click();
      await page.getByRole('button', { name: 'Применить' }).click();
      await page.getByRole('textbox', { name: 'Внешняя причина', exact: true }).fill('Ждём данные');
      await page.getByRole('button', { name: 'Подтвердить блокер' }).click();
      await page.getByRole('button', { name: 'Дополнительно' }).click();
      await page.getByRole('textbox', { name: 'Описание', exact: true }).fill('Только первая задача');
      await page.getByRole('button', { name: /Приоритет.*Обычный/ }).click();
      await page.getByRole('radio', { name: 'Срочный' }).click();
      await page.getByRole('button', { name: 'Создать и добавить ещё' }).click();
      await expect(page.getByRole('textbox', { name: 'Что нужно сделать?' })).toHaveValue('');
      await expect(page.getByRole('textbox', { name: 'Что нужно сделать?' })).toBeFocused();
      await expect(page.getByRole('button', { name: /Проект.*Запуск сайта/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Дополнительно' })).toHaveAttribute('aria-expanded', 'false');
      await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Вторая в серии');
      await shot('repeat');
      await page.getByRole('button', { name: 'Создать и добавить ещё' }).click();
      await expect(page.getByRole('textbox', { name: 'Что нужно сделать?' })).toHaveValue('');
      const last = requests.at(-1)!;
      expect(last).toMatchObject({ projectId: project.id, status: 'todo', priority: 'normal', assigneeUserId: null, description: null, deadline: null, deadlineDate: null, waitReason: null, blockerTaskId: null, waitCheckAt: null, notifyAssignee: false });
      await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Третья в серии');
      await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
      await expect(page.locator('.backlog-row').filter({ hasText: 'Третья в серии' })).toBeVisible();
      failure = 'load';
      await page.reload();
      await page.getByRole('button', { name: /^Бэклог/ }).click();
      await expect(page.getByRole('status', { name: 'Загрузка общей очереди' })).toBeVisible();
      await shot('backlog-loading');
      releaseLoad!();
      await expect(page.getByRole('alert')).toContainText('Очередь не обновилась');
      await shot('backlog-error');
      failure = 'none';
      await db.query("UPDATE tasks SET archived_at = now() WHERE board_id = $1 AND status = 'todo' AND assignee_user_id IS NULL", [boardId]);
      await page.getByRole('button', { name: 'Повторить', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Всё разобрано' })).toBeVisible();
      await shot('backlog-empty');
      expect(errors).toEqual([]);
    } finally {
      releaseBulk?.();
      releaseLoad?.();
      await second.close();
      await app.close();
      await db.query('DELETE FROM boards WHERE id = $1 OR owner_user_id = ANY($2)', [boardId, [owner.userId, member.userId]]);
      await db.query('DELETE FROM users WHERE id = ANY($1)', [[owner.userId, member.userId]]);
      await db.end();
    }
  });
}
