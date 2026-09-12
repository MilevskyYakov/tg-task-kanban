import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));
const board = { id: 'board-1', name: 'Все доски', type: 'personal', status: 'active', role: 'owner' };
const projects = [{ id: 'project-1', board_id: board.id, name: 'Task Kanban' }];
const members = [{ id: 'user-2', first_name: 'Данил', username: 'danil' }, { id: 'user-1', first_name: 'Яков' }];

async function mockCreate(page: Page, failCreate = false) {
  const requests: Record<string, any>[] = [];
  const savedTasks: Record<string, any>[] = [];
  await page.addInitScript((boardId) => {
    localStorage.setItem('tasks.globalBoardId', boardId);
    localStorage.setItem('tasks.viewState', JSON.stringify({ view: 'list', grouping: 'deadline', filters: { scope: 'mine', project: '', assignee: '', status: '', priority: '', deadline: '', unassigned: false, search: '' }, scrollY: 0, kanbanStatus: 'todo' }));
  }, board.id);
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: "window.Telegram={WebApp:{initData:'visual-create',initDataUnsafe:{user:{id:1,first_name:'Яков'}},ready(){},expand(){}}};"
  }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/tasks')) requests.push(request.postDataJSON());
    if (failCreate && request.method() === 'POST' && path.endsWith('/tasks')) {
      await route.fulfill({ status: 500, json: { error: 'Не удалось создать задачу' } });
      return;
    }
    if (request.method() === 'POST' && path.endsWith('/tasks')) {
      const input = request.postDataJSON();
      const task = { id: `created-${savedTasks.length}`, board_id: board.id, creator_user_id: 'user-1', title: input.title,
        description: input.description, status: input.status, priority: input.priority, deadline: input.deadline,
        deadline_date: input.deadlineDate, deadline_timezone: input.deadlineTimezone, assignee_user_id: input.assigneeUserId,
        wait_reason: input.waitReason, blocked_by_task_id: input.blockerTaskId, overdue: false, wait_check_due: false };
      savedTasks.push(task);
      await route.fulfill({ json: task }); return;
    }
    const payload = path === '/api/auth/telegram' ? { userId: 'user-1' }
      : path === '/api/boards' ? { boards: [board] }
      : path.endsWith('/projects') ? { projects }
      : path.endsWith('/members') ? { members }
      : path.endsWith('/publications') ? { schedules: [] }
      : path.endsWith('/recurrences') ? { recurrences: [] }
      : path.endsWith('/task-filters') ? { filters: {} }
      : path.endsWith('/collaboration') ? { checklist: [], comments: [], attachments: [], timeline: [] }
      : { tasks: savedTasks };
    await route.fulfill({ json: payload });
  });
  return { requests, savedTasks };
}

async function openFilledCreate(page: Page, width: number) {
  await mockCreate(page);
  await page.setViewportSize({ width, height: 844 });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: 'Создать задачу' }).click();
  await expect(page.getByRole('heading', { name: 'Новая задача' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Подготовить UX-спецификацию');
  await expect(page.getByRole('button', { name: /Проект.*Без проекта/ })).toBeEnabled();
  await page.getByRole('button', { name: /Проект.*Без проекта/ }).click();
  await expect(page.getByRole('radio', { name: 'Без проекта' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: /Проект.*Task Kanban/ })).toBeVisible();
  await page.getByRole('button', { name: /Исполнитель.*Без ответственного/ }).click();
  await page.getByRole('radio', { name: 'Данил' }).click();
  await page.getByRole('button', { name: /Срок.*Без срока/ }).click();
  await page.getByRole('radio', { name: 'Дата и время' }).click();
  await page.getByLabel('Дата срока').fill('2026-08-15');
  await page.getByLabel('Время срока').fill('18:00');
  await page.getByRole('button', { name: 'Применить' }).click();
}

for (const width of [390, 320]) {
  test(`create ${width}x844 matches contract anatomy`, async ({ page }) => {
    await openFilledCreate(page, width);
    await expect(page.locator('.create-screen select, .create-screen details, .create-screen summary')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Создать задачу' })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const action = await page.locator('.create-action').boundingBox();
    expect((action?.y ?? 844) + (action?.height ?? 0)).toBeLessThanOrEqual(845);
    await expect(page.getByRole('button', { name: /Срок.*18:00/ })).toBeVisible();
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/create-${width}x844.png` });
  });
}

test('create keeps input after failed request', async ({ page }) => {
  await mockCreate(page, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать задачу' }).click();
  const title = page.getByRole('textbox', { name: 'Что нужно сделать?' });
  await title.fill('Не терять этот текст');
  await page.getByRole('button', { name: 'Создать задачу' }).click();
  await expect(page.getByRole('status')).toContainText('Не удалось создать задачу');
  await expect(title).toHaveValue('Не терять этот текст');
});

test('create submit stays reachable when visual viewport shrinks for keyboard', async ({ page }) => {
  await openFilledCreate(page, 320);
  await page.getByRole('button', { name: 'Дополнительно' }).click();
  await page.setViewportSize({ width: 320, height: 520 });
  const description = page.getByRole('textbox', { name: 'Описание' });
  await description.focus();
  const action = await page.locator('.create-action').boundingBox();
  const field = await description.boundingBox();
  expect((action?.y ?? 520) + (action?.height ?? 0)).toBeLessThanOrEqual(521);
  expect((field?.y ?? 520) + (field?.height ?? 0)).toBeLessThanOrEqual(action?.y ?? 0);
  await page.screenshot({ path: `${evidence}/create-320x520-keyboard.png` });
});

for (const width of [390, 320]) {
  test(`deadline modes, status and reopening ${width}`, async ({ page }) => {
    const { requests } = await mockCreate(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Создать задачу' }).click();
    await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Подготовить план запуска');
    await page.getByRole('button', { name: /Исполнитель.*Без ответственного/ }).click();
    await page.getByRole('radio', { name: 'Яков' }).click();
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/issue77-create-none-${width}.png` });
    await page.getByRole('button', { name: /Срок.*Без срока/ }).click();
    await expect(page.getByRole('radio', { name: 'Без срока' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Отмена' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('radio', { name: 'Без срока' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.getByLabel('Дата срока').fill('2026-09-18');
    await expect(page.getByLabel('Время срока')).toHaveCount(0);
    await page.screenshot({ path: `${evidence}/issue77-deadline-date-${width}.png` });
    await page.getByRole('button', { name: 'Применить' }).click();
    await expect(page.getByRole('button', { name: /Срок.*весь день/ })).toBeFocused();
    await page.getByRole('button', { name: /Срок.*весь день/ }).click();
    await page.getByRole('radio', { name: 'Дата и время' }).click();
    await page.getByRole('button', { name: 'Применить' }).click();
    await expect(page.getByRole('alert')).toContainText('дату и время');
    await page.getByLabel('Время срока').fill('18:00');
    await page.screenshot({ path: `${evidence}/issue77-deadline-time-${width}.png` });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /Срок.*весь день/ })).toBeVisible();
    await page.getByRole('button', { name: /Статус.*К выполнению/ }).click();
    await page.getByRole('radio', { name: 'В работе' }).click();
    await page.screenshot({ path: `${evidence}/issue77-status-${width}.png` });
    await page.getByRole('button', { name: 'Применить' }).click();
    await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Задача создана');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ deadline: null, deadlineDate: '2026-09-18', status: 'in_progress' });
    expect(requests[0].deadlineTimezone).toBeTruthy();
    await page.reload();
    await page.getByRole('button', { name: /Подготовить план запуска/ }).click();
    await page.getByRole('button', { name: /Срок.*весь день/ }).click();
    await expect(page.getByLabel('Дата срока')).toHaveValue('2026-09-18');
    await expect(page.getByRole('radio', { name: 'Только дата' })).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${evidence}/issue77-details-date-${width}.png` });
  });

  test(`initial blocker and completion refusal ${width}`, async ({ page }) => {
    const { requests, savedTasks } = await mockCreate(page);
    savedTasks.push({ id: 'blocker-1', board_id: board.id, creator_user_id: 'user-1', title: 'Согласовать бюджет', status: 'todo', priority: 'normal', overdue: false, wait_check_due: false });
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Создать задачу' }).click();
    await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Подготовить план запуска');
    await page.getByRole('button', { name: /Статус.*К выполнению/ }).click();
    await page.getByRole('radio', { name: 'Блокер' }).click();
    await page.getByRole('button', { name: 'Применить' }).click();
    await expect(page.getByRole('button', { name: 'Подтвердить блокер' })).toBeDisabled();
    await page.getByLabel('Внешняя причина', { exact: true }).fill('Ждём подтверждение бюджета от клиента');
    await page.screenshot({ path: `${evidence}/issue77-blocker-external-${width}.png` });
    await page.getByRole('radio', { name: 'Другая задача' }).click();
    await page.getByRole('radio', { name: 'Согласовать бюджет' }).click();
    await page.screenshot({ path: `${evidence}/issue77-blocker-task-${width}.png` });
    await page.getByRole('button', { name: 'Подтвердить блокер' }).click();
    await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Задача создана');
    expect(requests[0]).toMatchObject({ status: 'waiting', blockerTaskId: 'blocker-1', waitReason: null, deadline: null, deadlineDate: null });
    await page.getByRole('button', { name: 'Создать задачу' }).click();
    await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Перенести завершённую задачу');
    await page.getByRole('button', { name: /Исполнитель.*Без ответственного/ }).click();
    await page.getByRole('radio', { name: 'Данил' }).click();
    await page.getByRole('button', { name: /Статус.*К выполнению/ }).click();
    await page.getByRole('radio', { name: 'Готово' }).click();
    await page.getByRole('button', { name: 'Применить' }).click();
    await expect(page.getByRole('alert')).toContainText('только назначенный исполнитель');
    await expect(page.getByRole('button', { name: 'Создать задачу', exact: true })).toBeDisabled();
    await page.screenshot({ path: `${evidence}/issue77-done-denied-${width}.png` });
    expect(requests).toHaveLength(1);
  });
}

test('pending create locks input and reuses request id after a failed response', async ({ page }) => {
  await mockCreate(page);
  const payloads: Record<string, any>[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/boards/*/tasks', async (route) => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    payloads.push(route.request().postDataJSON());
    if (payloads.length === 1) await pending;
    await route.fulfill({ status: 500, json: { error: 'Не удалось подтвердить сохранение' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать задачу' }).click();
  const title = page.getByRole('textbox', { name: 'Что нужно сделать?' });
  await title.fill('Сохранить один раз');
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Создаём…' })).toBeDisabled();
  await expect(title).toBeDisabled();
  await page.locator('.create-screen form').evaluate((form) => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(payloads).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${evidence}/issue77-create-pending-390.png` });
  release();
  await expect(page.getByRole('status')).toContainText('Не удалось подтвердить сохранение');
  await expect(title).toHaveValue('Сохранить один раз');
  await page.screenshot({ path: `${evidence}/issue77-create-error-390.png` });
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect.poll(() => payloads.length).toBe(2);
  expect(payloads[1]).toEqual(payloads[0]);
});

test('series resets assignee, deadline and notification while keeping project and board', async ({ page }) => {
  const { requests } = await mockCreate(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать задачу' }).click();
  await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Первая');
  await page.getByRole('button', { name: /Проект.*Без проекта/ }).click();
  await page.getByRole('radio', { name: 'Task Kanban' }).click();
  await page.getByRole('button', { name: /Исполнитель.*Без ответственного/ }).click();
  await page.getByRole('radio', { name: 'Данил' }).click();
  await page.getByRole('button', { name: /Срок.*Без срока/ }).click();
  await page.getByRole('radio', { name: 'Только дата' }).click();
  await page.getByLabel('Дата срока').fill('2026-09-18');
  await page.getByRole('button', { name: 'Применить' }).click();
  await page.getByRole('button', { name: 'Дополнительно' }).click();
  await page.getByRole('checkbox', { name: 'Уведомить исполнителя' }).check();
  await page.getByRole('button', { name: 'Создать и добавить ещё' }).click();
  await expect(page.getByRole('textbox', { name: 'Что нужно сделать?' })).toHaveValue('');
  await expect(page.getByRole('button', { name: /Проект.*Task Kanban/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Исполнитель.*Без ответственного/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Срок.*Без срока/ })).toBeVisible();
  await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Первая');
  await page.getByRole('button', { name: 'Создать и добавить ещё' }).click();
  await expect(page.getByRole('textbox', { name: 'Что нужно сделать?' })).toHaveValue('');
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({ assigneeUserId: 'user-2', notifyAssignee: true, deadlineDate: '2026-09-18' });
  expect(requests[1]).toMatchObject({ projectId: 'project-1', assigneeUserId: null, notifyAssignee: false, deadline: null, deadlineDate: null, status: 'todo' });
  expect(requests[0].requestId).not.toBe(requests[1].requestId);
});
