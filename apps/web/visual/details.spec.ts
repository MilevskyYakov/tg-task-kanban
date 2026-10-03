import { expect, test, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../api/src/app';
import { createDatabase, createTask, login } from '../../api/src/db';
import type { Config } from '../../api/src/config';
import { expectEditorAboveKeyboard, setKeyboardViewport } from './keyboard-fixture';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));
const board = { id: 'board-1', name: 'Task Kanban', type: 'personal', status: 'active', role: 'owner' };
const task = {
  id: 'task-1', board_id: board.id, board_name: board.name, title: 'Подготовить UX-спецификацию',
  description: 'Зафиксировать структуру экранов и состояния перед разработкой.\n\nОписать создание задачи, просмотр карточки и редактирование описания. Для каждого сценария показать основной экран, пустое состояние и ошибку.\n\nСохранить привычную навигацию и сделать описание главным содержанием карточки.', project_id: 'project-1', project_name: 'Task Kanban',
  assignee_user_id: 'user-2', assignee_name: 'Данил', creator_user_id: 'user-1', status: 'in_progress', priority: 'normal',
  deadline: '2026-08-15T18:00:00Z', overdue: false, wait_check_due: false, checklist_completed: 2, checklist_total: 4, issue_url: '', version: '1'
};
const collaboration = {
  checklist: [
    { id: 'check-1', text: 'Определить структуру экранов', position: 0, completed_at: '2026-08-14T10:00:00Z' },
    { id: 'check-2', text: 'Согласовать основной сценарий', position: 1, completed_at: '2026-08-14T11:00:00Z' },
    { id: 'check-3', text: 'Описать состояния блокера', position: 2 },
    { id: 'check-4', text: 'Подготовить implementation backlog', position: 3 }
  ],
  comments: [{ id: 'comment-1', body: 'Добавил финальные правки по срокам.', author_name: 'Яков Милевский', created_at: '2026-08-14T12:00:00Z' }],
  attachments: [{ id: 'attachment-1', kind: 'telegram', file_name: 'ux-flow.pdf', created_at: '2026-08-14T12:10:00Z' }],
  timeline: [{ id: 'timeline-1', action: 'обновил задачу', actor_name: 'Яков Милевский', created_at: '2026-08-14T12:00:00Z' }]
};

type DetailsOptions = { failSave?: boolean; readOnly?: boolean; taskOverrides?: Partial<typeof task>; projectName?: string; memberName?: string };

async function mockDetails(page: Page, { failSave = false, readOnly = false, taskOverrides = {}, projectName = 'Task Kanban', memberName = 'Данил' }: DetailsOptions = {}) {
  const detailTask = { ...task, ...taskOverrides };
  const detailBoard = readOnly ? { ...board, status: 'frozen' } : board;
  let savedTask: Record<string, any> = { ...detailTask };
  let shouldFailSave = failSave;
  let revision = Number(detailTask.version ?? 1);
  const requests: Record<string, any>[] = [];
  await page.addInitScript((boardId) => {
    localStorage.setItem('tasks.globalBoardId', boardId);
    if (!localStorage.getItem('test.detailsUserId')) localStorage.setItem('test.detailsUserId', 'user-2');
    localStorage.setItem('tasks.viewState', JSON.stringify({ view: 'list', grouping: 'deadline', filters: { scope: 'all', project: '', assignee: '', status: '', priority: '', deadline: '', unassigned: false, search: '' }, scrollY: 0, kanbanStatus: 'todo' }));
  }, board.id);
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: "window.Telegram={WebApp:{initData:'visual-details',initDataUnsafe:{user:{id:1,first_name:'Яков'}},ready(){},expand(){}}};"
  }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (shouldFailSave && request.method() === 'PATCH' && path.endsWith(`/tasks/${task.id}`)) {
      shouldFailSave = false;
      await route.fulfill({ status: 500, json: { error: 'Не удалось сохранить задачу' } });
      return;
    }
    if (request.method() === 'PATCH' && path.endsWith(`/tasks/${task.id}`)) {
      const input = request.postDataJSON();
      requests.push(input);
      if (input.expectedVersion !== undefined && input.expectedVersion !== String(revision)) {
        await route.fulfill({ status: 409, json: { error: 'version conflict', expectedVersion: input.expectedVersion, task: { ...savedTask, version: String(revision) } } });
        return;
      }
      revision += 1;
      savedTask = { ...savedTask, ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'expectedVersion' && key !== 'notifyAssignee')) , version: String(revision) };
      if ('projectId' in input) savedTask.project_id = input.projectId;
      if ('assigneeUserId' in input) savedTask.assignee_user_id = input.assigneeUserId;
      if ('blockerTaskId' in input) savedTask.blocked_by_task_id = input.blockerTaskId;
      if ('waitReason' in input) savedTask.wait_reason = input.waitReason;
      if ('waitCheckAt' in input) savedTask.wait_check_at = input.waitCheckAt;
      if ('issueUrl' in input) savedTask.issue_url = input.issueUrl;
      if ('deadline' in input) savedTask.deadline = input.deadline;
      if ('deadlineDate' in input) savedTask.deadline_date = input.deadlineDate;
      if ('deadlineTimezone' in input) savedTask.deadline_timezone = input.deadlineTimezone;
      await route.fulfill({ json: savedTask });
      return;
    }
    if (path === '/api/auth/telegram') return route.fulfill({ json: { userId: await page.evaluate(() => localStorage.getItem('test.detailsUserId') ?? 'user-2') } });
    const payload = path === '/api/boards' ? { boards: [detailBoard] }
      : path.endsWith('/collaboration') ? collaboration
      : path.endsWith('/projects') ? { projects: [{ id: 'project-1', name: projectName }] }
      : path.endsWith('/members') ? { members: [{ id: 'user-2', first_name: memberName }] }
      : path.endsWith('/publications') ? { schedules: [] }
      : path.endsWith('/recurrences') ? { recurrences: [] }
      : path.endsWith('/task-filters') ? { filters: {} }
      : path.endsWith(`/tasks/${task.id}`) ? savedTask
      : { tasks: [savedTask] };
    await route.fulfill({ json: payload });
  });
  return requests;
}

async function openDetails(page: Page, width: number, options: DetailsOptions = {}) {
  const requests = await mockDetails(page, options);
  await page.setViewportSize({ width, height: 844 });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button').filter({ hasText: options.taskOverrides?.title ?? task.title }).first().click();
  await expect(page.getByRole('heading', { name: 'Детали задачи' })).toBeAttached();
  return requests;
}

test.describe('keyboard viewport', () => {
  test('short card uses the new scroll range after keyboard padding changes', async ({ page }) => {
    await mockDetails(page, { taskOverrides: { description: 'Строка описания\n'.repeat(30) } });
    await page.route('**/collaboration', (route) => route.fulfill({ json: { checklist: [], comments: [], attachments: [], timeline: [] } }));
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('button', { name: /Подготовить UX-спецификацию/ }).first().click();
    await page.locator('.detail-description-actions').getByRole('button', { name: 'Изменить', exact: true }).click();
    await setKeyboardViewport(page, 360, 24);
    const description = page.getByRole('textbox', { name: 'Описание', exact: true });
    await expectEditorAboveKeyboard(description, 360, 24);
    await expect.poll(() => description.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  });
  for (const width of [320, 390]) test(`long description and comment stay above the keyboard ${width}`, async ({ page, browserName }) => {
    await openDetails(page, width, { taskOverrides: { description: 'Строка длинного описания\n'.repeat(40) } });
    await page.locator('.detail-description-actions').getByRole('button', { name: 'Изменить', exact: true }).click();
    const description = page.getByRole('textbox', { name: 'Описание', exact: true });
    await expect(description).toBeFocused();
    await setKeyboardViewport(page, 360, 24);
    await expect(page.locator('.comment-composer')).toHaveCSS('position', 'static');
    await expectEditorAboveKeyboard(description, 360, 24);
    await page.keyboard.type('Дополнение');
    await expect(description).toHaveValue('Строка длинного описания\n'.repeat(40) + 'Дополнение');
    await expectEditorAboveKeyboard(description, 360, 24);
    await expect.poll(() => description.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/keyboard-details-${browserName}-${width}.png`, clip: { x: 0, y: 24, width, height: 360 } });
    await description.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(3, 3));
    await page.keyboard.press('KeyX');
    expect(await description.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(4);
    await expectEditorAboveKeyboard(description, 360, 24);
    const comment = page.locator('.comment-composer input:not([type=file])');
    await comment.evaluate((element: HTMLInputElement) => element.focus({ preventScroll: true }));
    await expectEditorAboveKeyboard(comment, 360, 24);
    await page.keyboard.type('Черновик комментария');
    await expect(comment).toHaveValue('Черновик комментария');
    await setKeyboardViewport(page, 844);
    await expect(page.locator('.comment-composer')).toHaveCSS('position', 'fixed');
    await expect(comment).toHaveValue('Черновик комментария');
  });
});

async function flushAutosave(page: Page) {
  // The save-state line announces the flush result; wait until it settles on «Сохранено»
  // or an error, not merely the transient «Сохраняется…» of an earlier edit (issue #129).
  await expect(async () => {
    const text = await page.locator('.detail-save-state').textContent();
    expect(text).toMatch(/Сохранено|Не сохранено/i);
    expect(text).not.toBe('Сохраняется…');
  }).toPass({ timeout: 5000 });
}

for (const width of [390, 320]) {
  test(`details ${width}x844 matches approved read-first anatomy`, async ({ page }) => {
    await openDetails(page, width);
    await expect(page.locator('.task-details select, .task-details details, .task-details summary')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /В работе/ })).toBeVisible();
    await expect(page.locator('.detail-property-grid > .action-row')).toHaveCount(4);
    await expect(page.locator('.detail-heading')).not.toHaveCSS('box-shadow', 'none');
    await expect(page.locator('.detail-property-grid > .action-row').first()).not.toHaveCSS('box-shadow', 'none');
    const hero = (await page.locator('.detail-heading').boundingBox())!;
    const properties = (await page.locator('.detail-property-grid').boundingBox())!;
    expect(properties.y - hero.y - hero.height).toBeGreaterThanOrEqual(12);
    await expect(page.getByRole('heading', { name: 'Описание' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Чек-лист' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Обсуждение' })).toBeVisible();
    const titleField = page.getByRole('textbox', { name: 'Название задачи' });
    await expect(titleField).toHaveValue(task.title);
    expect(await titleField.evaluate((element) => element.clientHeight / parseFloat(getComputedStyle(element).lineHeight))).toBeLessThanOrEqual(2);
    for (const selector of ['.detail-status-action', '.detail-progress']) {
      await expect(page.locator(selector)).toHaveCSS('white-space', 'nowrap');
      expect(await page.locator(selector).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    const status = (await page.locator('.detail-status-action').boundingBox())!;
    const progress = (await page.locator('.detail-progress').boundingBox())!;
    expect(Math.abs(status.y + status.height / 2 - progress.y - progress.height / 2)).toBeLessThanOrEqual(1);
    const send = (await page.getByRole('button', { name: 'Отправить комментарий' }).boundingBox())!;
    const plane = (await page.getByRole('button', { name: 'Отправить комментарий' }).locator('svg').boundingBox())!;
    expect(send.width).toBe(send.height);
    expect(Math.abs(send.x + send.width / 2 - plane.x - plane.width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(send.y + send.height / 2 - plane.y - plane.height / 2)).toBeLessThanOrEqual(1);
    await expect(page.locator('.detail-description-read')).toHaveText(task.description);
    await expect(page.getByRole('textbox', { name: 'Описание' })).toHaveCount(0);
    await page.getByRole('button', { name: /В работе/ }).click();
    await expect(page.getByRole('dialog', { name: 'Статус' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'В работе' })).toBeFocused();
    await page.keyboard.press('Escape');
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const composer = await page.locator('.comment-composer').boundingBox();
    expect((composer?.y ?? 844) + (composer?.height ?? 0)).toBeLessThanOrEqual(845);
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/details-${width}x844.png` });
    await page.locator('.detail-discussion').scrollIntoViewIfNeeded();
    await expect(page.locator('.detail-discussion article').first()).not.toHaveCSS('box-shadow', 'none');
    await page.screenshot({ path: `${evidence}/details-bottom-${width}.png` });
    await page.getByRole('button', { name: 'Изменить', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Описание' });
    await expect(editor).toBeFocused();
    // No global save button anymore: the editor closes onto autosave, not a submit (issue #129).
    await expect(page.getByRole('button', { name: 'Сохранить изменения' })).toHaveCount(0);
    expect(await editor.evaluate((element) => getComputedStyle(element).overflowY)).toBe('hidden');
    await page.screenshot({ path: `${evidence}/details-${width}x844-edit.png` });
  });
}

test('details autosaves a title edit without any save button and confirms on the server', async ({ page }) => {
  const requests = await openDetails(page, 390);
  const title = page.getByRole('textbox', { name: 'Название задачи' });
  await title.fill('Автосохранённое название');
  await flushAutosave(page);
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].title).toBe('Автосохранённое название');
  expect(requests[0].expectedVersion).toBe('1');
  // Only the changed field is sent: status/deadline/assignee are not overwritten (issue #129).
  expect(Object.keys(requests[0]).filter((key) => !['expectedVersion', 'confirmIncompleteChecklist'].includes(key))).toEqual(['title']);
});

for (const outcome of ['success', 'lost response', 'conflict', 'server choice'] as const) {
  test(`invalid neighbor survives partial acknowledgement: ${outcome}`, async ({ page }) => {
    const requests = await openDetails(page, 320);
    const conflicting = outcome === 'conflict' || outcome === 'server choice';
    let server = { ...task, ...(conflicting ? { title: 'Remote title', version: '2' } : {}) };
    await page.route('**/api/boards/board-1/tasks/task-1', async (route) => {
      if (route.request().method() !== 'PATCH') return route.fulfill({ json: server });
      const input = route.request().postDataJSON();
      requests.push(input);
      if (input.expectedVersion !== server.version) return route.fulfill({ status: 409, json: { error: 'version conflict', task: server } });
      server = { ...server, title: input.title ?? server.title, version: String(Number(server.version) + 1) };
      if (outcome === 'lost response') return route.abort();
      await route.fulfill({ json: server });
    });
    const issue = page.locator('.detail-github');
    await issue.getByRole('button', { name: 'Добавить GitHub issue' }).click();
    await issue.getByRole('textbox').fill('owner/');
    await page.getByRole('textbox', { name: 'Название задачи' }).fill('Valid partial title');
    if (conflicting) await page.getByRole('button', { name: outcome === 'server choice' ? 'Оставить серверную версию' : 'Моя правка поверх серверной', exact: true }).click();
    await expect.poll(() => server.title).toBe(outcome === 'server choice' ? 'Remote title' : 'Valid partial title');
    await expect(page.locator('.detail-save-state')).toHaveText('Ожидает отправки');
    await expect(issue.getByRole('textbox')).toHaveValue('owner/');
    await expect(issue.getByRole('alert')).toBeVisible();
    if (outcome === 'success') {
      await mkdir(evidence, { recursive: true });
      for (const [width, height, textSize] of [[390, 844, 100], [320, 844, 100], [320, 520, 100], [1280, 900, 100], [320, 844, 200]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate((size) => { document.documentElement.style.fontSize = `${size}%`; }, textSize);
        await issue.getByRole('alert').scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: `${evidence}/issue-144-invalid-link-${width}x${height}-${textSize}.png` });
      }
      await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    }
    expect(requests.every((input) => !('issueUrl' in input))).toBe(true);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('tasks.draft.v1.["user-2","board-1","task-1"]')!).draft.issueUrl)).toBe('owner/');
    // Reverting the invalid field requires no request, but must clear the pending label.
    const count = requests.length;
    await issue.getByRole('textbox').fill('');
    await expect(page.locator('.detail-save-state')).toHaveText('Сохранено');
    await page.waitForTimeout(1000);
    expect(requests).toHaveLength(count);
  });
}

test('restored invalid deadline stays editable while an independent title saves', async ({ page }) => {
  const requests = await openDetails(page, 390);
  await page.getByRole('textbox', { name: 'Название задачи' }).fill('Independent restored title');
  await page.evaluate(() => {
    const key = 'tasks.draft.v1.["user-2","board-1","task-1"]';
    const stored = JSON.parse(localStorage.getItem(key)!);
    stored.draft.due = { ...stored.draft.due, mode: 'datetime', time: '' };
    localStorage.setItem(key, JSON.stringify(stored));
  });
  await page.reload();
  await page.getByRole('button').filter({ hasText: task.title }).first().click();
  await expect(page.getByRole('alert')).toContainText('Укажите корректные дату и время');
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].title).toBe('Independent restored title');
  expect(requests[0]).not.toHaveProperty('deadline');
  await expect(page.locator('.detail-save-state')).toHaveText('Ожидает отправки');
  await page.getByRole('button', { name: /^Срок/ }).click();
  await expect(page.getByLabel('Время срока')).toHaveValue('');
  await page.getByLabel('Время срока').fill('12:34');
  await page.getByRole('button', { name: 'Применить' }).click();
  await flushAutosave(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('details flushes the last edit when leaving the card immediately', async ({ page }) => {
  const requests = await openDetails(page, 390);
  const title = page.getByRole('textbox', { name: 'Название задачи' });
  await title.fill('Правка перед выходом');
  await page.getByRole('button', { name: 'Назад к задачам' }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].title).toBe('Правка перед выходом');
});

test('details keeps edited input after failed save and resends it once', async ({ page }) => {
  const requests = await openDetails(page, 390, { failSave: true });
  const title = page.getByRole('textbox', { name: 'Название задачи' });
  await title.fill('Не терять эту правку');
  await expect(page.locator('.detail-save-state')).toHaveText(/Не сохранено/, { timeout: 5000 });
  await expect(title).toHaveValue('Не терять эту правку');
  // Reconnect (online event) retries the queued patch; nothing is lost.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].title).toBe('Не терять эту правку');
  await expect(page.locator('.detail-save-state')).toHaveText('Сохранено', { timeout: 5000 });
});

test('details restores the latest edit after reload before debounce and confirms it on the server', async ({ page }) => {
  const requests = await openDetails(page, 390);
  const title = 'Правка до debounce';
  await page.getByRole('textbox', { name: 'Название задачи' }).fill(title);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('tasks.draft.v1.["user-2","board-1","task-1"]'))).toContain(title);
  await page.reload();
  await page.getByRole('button').filter({ hasText: task.title }).first().click();
  await expect(page.getByRole('textbox', { name: 'Название задачи' })).toHaveValue(title);
  await flushAutosave(page);
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].title).toBe(title);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('tasks.draft.v1.["user-2","board-1","task-1"]'))).toBeNull();
});

test('details reopens a failed offline draft and sends it once after reconnect', async ({ page }) => {
  const requests = await openDetails(page, 390, { failSave: true });
  const title = 'Правка после обрыва связи';
  await page.getByRole('textbox', { name: 'Название задачи' }).fill(title);
  await expect(page.locator('.detail-save-state')).toHaveText(/Не сохранено/, { timeout: 5000 });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('tasks.draft.v1.["user-2","board-1","task-1"]'))).toContain(title);
  await page.reload();
  await page.getByRole('button').filter({ hasText: task.title }).first().click();
  await expect(page.getByRole('textbox', { name: 'Название задачи' })).toHaveValue(title);
  await flushAutosave(page);
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].title).toBe(title);
});

test('details restores invalid local input without sending it or claiming it saved', async ({ page }) => {
  const requests = await openDetails(page, 390);
  await page.getByRole('textbox', { name: 'Название задачи' }).fill('');
  await expect(page.locator('.detail-save-state')).toHaveText('Ожидает отправки');
  await page.reload();
  await page.getByRole('button').filter({ hasText: task.title }).first().click();
  const title = page.getByRole('textbox', { name: 'Название задачи' });
  await expect(title).toHaveValue('');
  await expect(page.locator('.detail-save-state')).toHaveText('Ожидает отправки');
  expect(requests).toHaveLength(0);
  await title.fill('Исправленная правка');
  await flushAutosave(page);
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].title).toBe('Исправленная правка');
});

test('details does not show or send draft while board is read-only', async ({ page }) => {
  const requests = await openDetails(page, 390, { readOnly: true });
  await page.evaluate((description) => localStorage.setItem('tasks.draft.v1.["user-2","board-1","task-1"]', JSON.stringify({ version: 1, draft: {
    title: 'Чужая правка', description, status: 'in_progress', projectId: 'project-1', assigneeUserId: 'user-2',
    due: { mode: 'datetime', date: '2026-08-15', time: '18:00', timezone: 'UTC' }, priority: 'normal', blockerTaskId: '',
    issueUrl: '', waitReason: '', waitCheckAt: ''
  } })), task.description);
  await page.reload();
  await page.getByRole('button').filter({ hasText: task.title }).first().click();
  await expect(page.getByRole('textbox', { name: 'Название задачи' })).toHaveValue(task.title);
  await page.waitForTimeout(1000);
  expect(requests).toHaveLength(0);
});

test('corrupt draft storage warns and falls back to the server task', async ({ page }) => {
  await openDetails(page, 390);
  await page.evaluate(() => localStorage.setItem('tasks.draft.v1.["user-2","board-1","task-1"]', '{broken'));
  await page.reload();
  await page.getByRole('button').filter({ hasText: task.title }).first().click();
  await expect(page.getByRole('textbox', { name: 'Название задачи' })).toHaveValue(task.title);
  await expect(page.getByRole('alert')).toContainText('Локальная копия недоступна или повреждена');
});

test('quota failure warns before closing with unsaved edits', async ({ page }) => {
  await openDetails(page, 390);
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('tasks.draft.v1.')) throw new DOMException('quota exceeded', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await page.getByRole('textbox', { name: 'Название задачи' }).fill('Правка без места в storage');
  await expect(page.getByRole('alert')).toContainText('Локальная копия недоступна или повреждена');
});

test('another account never restores or sends the previous account draft', async ({ page }) => {
  const requests = await openDetails(page, 390, { failSave: true });
  const title = 'Локальная правка первого пользователя';
  await page.getByRole('textbox', { name: 'Название задачи' }).fill(title);
  await expect(page.locator('.detail-save-state')).toHaveText(/Не сохранено/, { timeout: 5000 });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('tasks.draft.v1.["user-2","board-1","task-1"]'))).toContain(title);
  await page.evaluate(() => localStorage.setItem('test.detailsUserId', 'user-1'));
  const filtersLoaded = page.waitForResponse((response) => response.url().includes('/task-filters') && response.request().method() === 'GET');
  await page.reload();
  await filtersLoaded;
  await expect(page.getByRole('heading', { name: 'Задачи' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Название задачи' })).toHaveCount(0);
  await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect(requests).toHaveLength(0);
});

test('failed autosave queue write does not warn when durable draft storage succeeds', async ({ page }) => {
  await openDetails(page, 390);
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('tasks.autosave.')) throw new DOMException('quota exceeded', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await page.getByRole('textbox', { name: 'Название задачи' }).fill('Черновик сохранён отдельно');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('tasks.draft.v1.["user-2","board-1","task-1"]'))).toContain('Черновик сохранён отдельно');
  await expect(page.locator('.detail-error')).toHaveCount(0);
});

test('details draft and partial fields persist through real API and database', async ({ page }) => {
  // This scenario includes multiple reloads and sequential debounced DB writes.
  test.setTimeout(60_000);
  const databaseUrl = process.env.TEST_DATABASE_URL;
  test.skip(!databaseUrl, 'TEST_DATABASE_URL required for API/DB verification');
  const db = createDatabase(databaseUrl!);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const config: Config = { botToken: 'test', databaseUrl: databaseUrl!, sessionSecret: 'task-details-draft-test-secret', initDataMaxAgeSeconds: 60,
    sessionMaxAgeSeconds: 3600, host: '127.0.0.1', port: 0, production: false, webhookSecret: 'task-details-draft-test-webhook',
    publicUrl: 'https://example.test', botUsername: 'test_bot' };
  let owner: Awaited<ReturnType<typeof login>> | undefined;
  let boardId = '';
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    owner = await login(db, { id: stamp, first_name: 'Draft test' }, 3600, config.sessionSecret);
    boardId = (await db.query<{id: string}>("SELECT id FROM boards WHERE type = 'personal' AND owner_user_id = $1", [owner.userId])).rows[0].id;
    const exact = '2030-01-02T12:34:56.789Z';
    const created = await createTask(db, owner.userId, boardId, { title: 'Server title before edit', status: 'waiting', waitReason: 'Initial vendor', waitCheckAt: exact,
      deadline: exact, issueUrl: 'https://github.com/o/r/issues/9' });
    const blocker = await createTask(db, owner.userId, boardId, { title: 'Synthetic blocker' });
    if (!created) throw new Error('Could not create API/DB test task');
    app = buildApp(config, db);
    await page.addInitScript((id) => localStorage.setItem('tasks.globalBoardId', id), boardId);
    await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
      contentType: 'application/javascript',
      body: `window.Telegram={WebApp:{initData:'task-details-draft-test',initDataUnsafe:{start_param:'task_${boardId}_${created.id}'},ready(){},expand(){}}};`
    }));
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/auth/telegram') return route.fulfill({ json: { userId: owner!.userId } });
      const response = await app!.inject({ method: request.method() as 'GET' | 'POST' | 'PATCH' | 'PUT',
        url: url.pathname + url.search, cookies: { session: owner!.token },
        payload: request.postData() ? request.postDataJSON() : undefined });
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const title = page.getByRole('textbox', { name: 'Название задачи' });
    await expect(title).toHaveValue('Server title before edit');
    await title.fill('Persisted through the API');
    const draftKey = `tasks.draft.v1.${JSON.stringify([owner.userId, boardId, created.id])}`;
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), draftKey)).toContain('Persisted through the API');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Детали задачи' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Название задачи' })).toHaveValue('Persisted through the API');
    await expect(page.locator('.detail-save-state')).toHaveText('Сохранено', { timeout: 10000 });
    const persisted = await db.query<{title: string}>('SELECT title FROM tasks WHERE id = $1 AND board_id = $2', [created.id, boardId]);
    expect(persisted.rows[0]?.title).toBe('Persisted through the API');
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), draftKey)).toBeNull();
    const read = async () => (await db.query('SELECT * FROM tasks WHERE id=$1', [created.id])).rows[0];
    const issue = page.locator('.detail-github');
    await issue.getByRole('button', { name: 'Изменить' }).click();
    await issue.getByRole('textbox').fill('owner/');
    await title.fill('Valid beside invalid link');
    await page.locator('.detail-description-actions').getByRole('button', { name: 'Добавить описание' }).click();
    await page.getByRole('textbox', { name: 'Описание', exact: true }).fill('Independent description');
    await expect.poll(async () => (await read()).description).toBe('Independent description');
    expect((await read()).title).toBe('Valid beside invalid link');
    expect((await read()).issue_url).toBe('https://github.com/o/r/issues/9');
    expect((await read()).wait_check_at.toISOString()).toBe(exact);
    expect((await read()).deadline.toISOString()).toBe(exact);
    await expect(issue.getByRole('alert')).toContainText('Ссылка на issue');
    await expect(issue.getByRole('textbox')).toHaveValue('owner/');
    await expect(page.locator('.detail-save-state')).toHaveText('Ожидает отправки');
    await page.reload();
    await expect(title).toHaveValue('Valid beside invalid link');
    await expect(issue.getByRole('alert')).toBeVisible();
    await issue.getByRole('button', { name: 'Изменить' }).click();
    await expect(issue.getByRole('textbox')).toHaveValue('owner/');
    await issue.getByRole('textbox').fill('o/r#9');
    await issue.getByRole('button', { name: 'Готово' }).click();
    await title.fill('');
    await page.locator('.detail-description-actions').getByRole('button', { name: 'Изменить' }).click();
    await page.getByRole('textbox', { name: 'Описание', exact: true }).fill('Description beside empty title');
    await expect.poll(async () => (await read()).description).toBe('Description beside empty title');
    expect((await read()).title).toBe('Valid beside invalid link');
    await expect(title).toHaveValue('');
    await expect(title).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#detail-title-error')).toBeVisible();
    await page.setViewportSize({ width: 320, height: 520 });
    await mkdir(evidence, { recursive: true });
    await title.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}/issue-144-invalid-title.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.reload();
    await expect(title).toHaveValue('');
    await title.fill('Repaired title');
    await flushAutosave(page);
    await page.getByLabel('Внешняя причина', { exact: true }).fill('Changed vendor');
    await flushAutosave(page);
    expect((await read()).wait_reason).toBe('Changed vendor');
    expect((await read()).wait_check_at.toISOString()).toBe(exact);
    await page.getByLabel('Дата проверки', { exact: true }).fill('2030-04-05');
    await flushAutosave(page);
    expect((await read()).wait_check_at.toISOString()).toBe('2030-04-05T00:00:00.000Z');
    await page.getByRole('button', { name: /^Задача-блокер/ }).click();
    await page.getByRole('radio', { name: 'Synthetic blocker', exact: true }).click();
    await flushAutosave(page);
    expect((await read()).blocked_by_task_id).toBe(blocker.id);
    expect((await read()).wait_reason).toBeNull();
    await page.getByRole('button', { name: /^Задача-блокер/ }).click();
    await page.getByRole('radio', { name: 'Внешняя причина', exact: true }).click();
    await expect(page.locator('#detail-reason-error')).toBeVisible();
    await title.fill('Independent beside incomplete blocker');
    await expect.poll(async () => (await read()).title).toBe('Independent beside incomplete blocker');
    expect((await read()).blocked_by_task_id).toBe(blocker.id);
    await expect(page.getByLabel('Внешняя причина', { exact: true })).toHaveValue('');
    await page.getByLabel('Внешняя причина', { exact: true }).fill('External again');
    await flushAutosave(page);
    expect((await read()).blocked_by_task_id).toBeNull();
    expect((await read()).wait_reason).toBe('External again');
    const chooseStatus = async (name: string) => {
      await page.locator('.detail-status-action').click();
      await page.getByRole('radio', { name, exact: true }).click();
    };
    await chooseStatus('В работе');
    await flushAutosave(page);
    expect((await read()).wait_reason).toBeNull();
    expect((await read()).wait_check_at).toBeNull();
    await chooseStatus('Блокер');
    await expect(page.locator('#detail-reason-error')).toBeVisible();
    await title.fill('Valid beside incomplete entry');
    await expect.poll(async () => (await read()).title).toBe('Valid beside incomplete entry');
    expect((await read()).status).toBe('in_progress');
    await expect(page.locator('.detail-status-action')).toContainText('Блокер');
    await page.getByLabel('Внешняя причина', { exact: true }).fill('Complete entry');
    await flushAutosave(page);
    expect((await read()).status).toBe('waiting');
    expect((await read()).wait_reason).toBe('Complete entry');
    expect((await read()).deadline.toISOString()).toBe(exact);
    expect((await read()).issue_url).toBe('https://github.com/o/r/issues/9');
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), draftKey)).toBeNull();
  } finally {
    await page.close();
    if (app) await app.close();
    if (boardId) await db.query('DELETE FROM boards WHERE id = $1', [boardId]);
    if (owner) await db.query('DELETE FROM users WHERE id = $1', [owner.userId]);
    await db.end();
  }
});

test('details serializes flushes and sends latest edit with confirmed version', async ({ page }) => {
  const requests = await openDetails(page, 390);
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let serverTask = { ...task };
  let revision = Number(task.version);
  let active = 0;
  let maxActive = 0;

  await page.route('**/api/boards/board-1/tasks/task-1', async (route) => {
    if (route.request().method() !== 'PATCH') { await route.fallback(); return; }
    const input = route.request().postDataJSON();
    requests.push(input);
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (requests.length === 1) { markFirstStarted(); await firstGate; }
      if (input.expectedVersion !== serverTask.version) {
        await route.fulfill({ status: 409, json: { error: 'version conflict', expectedVersion: input.expectedVersion, task: serverTask } });
        return;
      }
      revision += 1;
      serverTask = { ...serverTask, title: input.title ?? serverTask.title, version: String(revision) };
      await route.fulfill({ json: serverTask });
    } finally { active -= 1; }
  });

  const title = page.getByRole('textbox', { name: 'Название задачи' });
  await title.fill('A');
  await title.blur();
  await firstStarted;
  await title.fill('B');
  await title.blur();
  await title.fill('C');
  await title.blur();
  await page.waitForTimeout(100);
  expect(requests).toHaveLength(1);
  expect(await title.inputValue()).toBe('C');

  releaseFirst();
  await expect.poll(() => requests.length).toBe(2);
  await expect(page.locator('.detail-save-state')).toHaveText('Сохранено', { timeout: 5000 });
  expect(requests.map(({ title: value, expectedVersion }) => [value, expectedVersion])).toEqual([['A', '1'], ['C', '2']]);
  expect(maxActive).toBe(1);
  expect(serverTask.title).toBe('C');
});

test('reverting to the base while a partial save is in flight keeps durable intent', async ({ page }) => {
  const requests = await openDetails(page, 390);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let server = { ...task };
  await page.route('**/api/boards/board-1/tasks/task-1', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fulfill({ json: server });
    const input = route.request().postDataJSON();
    requests.push(input);
    if (requests.length === 1) await gate;
    server = { ...server, title: input.title, version: String(Number(server.version) + 1) };
    await route.fulfill({ json: server });
  });
  const title = page.getByRole('textbox', { name: 'Название задачи' });
  await title.fill('In-flight title');
  await title.blur();
  await expect.poll(() => requests.length).toBe(1);
  await title.fill(task.title);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('tasks.draft.v1.["user-2","board-1","task-1"]')!).draft.title)).toBe(task.title);
  release();
  await expect(page.locator('.detail-save-state')).toHaveText('Сохранено');
  expect(requests.map((input) => input.title)).toEqual(['In-flight title', task.title]);
  expect(server.title).toBe(task.title);
});

test('details retries latest draft after an older save fails', async ({ page }) => {
  const requests = await openDetails(page, 390);
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let serverTask = { ...task };
  let revision = Number(task.version);

  await page.route('**/api/boards/board-1/tasks/task-1', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') { await route.fulfill({ json: serverTask }); return; }
    if (request.method() !== 'PATCH') { await route.fallback(); return; }
    const input = request.postDataJSON();
    requests.push(input);
    if (requests.length === 1) {
      markFirstStarted();
      await firstGate;
      await route.fulfill({ status: 500, json: { error: 'temporary failure' } });
      return;
    }
    revision += 1;
    serverTask = { ...serverTask, title: input.title ?? serverTask.title, version: String(revision) };
    await route.fulfill({ json: serverTask });
  });

  const title = page.getByRole('textbox', { name: 'Название задачи' });
  await title.fill('Older request');
  await title.blur();
  await firstStarted;
  await title.fill('Latest intent');
  await title.blur();
  releaseFirst();
  await expect(page.locator('.detail-save-state')).toHaveText(/Не сохранено/, { timeout: 5000 });
  expect(requests).toHaveLength(1);

  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => requests.length).toBe(2);
  await expect(page.locator('.detail-save-state')).toHaveText('Сохранено', { timeout: 5000 });
  expect(requests.map(({ title: value, expectedVersion }) => [value, expectedVersion])).toEqual([['Older request', '1'], ['Latest intent', '1']]);
  expect(serverTask.title).toBe('Latest intent');
});

test('details reconciles a committed edit when PATCH response is lost', async ({ page }) => {
  const requests = await openDetails(page, 390);
  let serverTask = { ...task };
  let revision = Number(task.version);

  await page.route('**/api/boards/board-1/tasks/task-1', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') { await route.fulfill({ json: serverTask }); return; }
    if (request.method() !== 'PATCH') { await route.fallback(); return; }
    const input = request.postDataJSON();
    requests.push(input);
    revision += 1;
    serverTask = { ...serverTask, title: input.title ?? serverTask.title, version: String(revision) };
    await route.abort();
  });

  const title = page.getByRole('textbox', { name: 'Название задачи' });
  await title.fill('Confirmed by refresh');
  await title.blur();
  await expect(page.locator('.detail-save-state')).toHaveText('Сохранено', { timeout: 5000 });
  expect(requests).toHaveLength(1);
  expect(serverTask.title).toBe('Confirmed by refresh');
  expect(await title.inputValue()).toBe('Confirmed by refresh');
  expect(await page.evaluate(() => localStorage.getItem('tasks.autosave.["user-2","board-1","task-1"]'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('tasks.draft.v1.["user-2","board-1","task-1"]'))).toBeNull();
});

test('details does not automatically retry auth, not-found, or validation errors', async ({ page }) => {
  const requests = await openDetails(page, 390);
  let status = 401;
  await page.route('**/api/boards/board-1/tasks/task-1', async (route) => {
    if (route.request().method() !== 'PATCH') { await route.fallback(); return; }
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status, json: { error: `save rejected: ${status}` } });
  });

  const title = page.getByRole('textbox', { name: 'Название задачи' });
  for (const nextStatus of [401, 403, 404, 422]) {
    status = nextStatus;
    await title.fill(`Rejected ${nextStatus}`);
    await title.blur();
    await expect.poll(() => requests.length).toBe([401, 403, 404, 422].indexOf(nextStatus) + 1);
    await expect(page.locator('.detail-save-state')).toHaveText(/Не сохранено/, { timeout: 5000 });
    await page.waitForTimeout(950);
    expect(requests).toHaveLength([401, 403, 404, 422].indexOf(nextStatus) + 1);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(100);
    expect(requests).toHaveLength([401, 403, 404, 422].indexOf(nextStatus) + 1);
  }
});

test('details cancels reverted title diff and keeps independent field edit', async ({ page }) => {
  const requests = await openDetails(page, 390);
  const title = page.getByRole('textbox', { name: 'Название задачи' });
  await title.fill('Устаревшее название');
  await title.fill(task.title);
  await page.waitForTimeout(1000);
  expect(requests).toHaveLength(0);

  await page.locator('.detail-description-actions').getByRole('button', { name: 'Изменить' }).click();
  await page.getByRole('textbox', { name: 'Описание' }).fill('Новое описание');
  await flushAutosave(page);
  expect(requests).toHaveLength(1);
  expect(requests[0].description).toBe('Новое описание');
  expect(requests[0]).not.toHaveProperty('title');
});

test('description stays read-only until edit, autosaves on done, resizes both ways', async ({ page }) => {
  const requests = await openDetails(page, 390);
  const readOnlyText = page.locator('.detail-description-read');
  expect(await readOnlyText.textContent()).toBe(task.description);
  await readOnlyText.click();
  await expect(page.getByRole('textbox', { name: 'Описание' })).toHaveCount(0);
  await page.locator('.detail-description-actions').getByRole('button', { name: 'Изменить' }).click();
  const editor = page.getByRole('textbox', { name: 'Описание' });
  await expect(editor).toBeFocused();
  await editor.fill('Короткий текст.');
  const shortHeight = await editor.evaluate((element) => element.clientHeight);
  await editor.fill(`Короткая строка.\n\n${'ОченьДлинноесловобезпробелов'.repeat(30)}\n\nЕщё один абзац.`);
  const expandedHeight = await editor.evaluate((element) => element.clientHeight);
  expect(expandedHeight).toBeGreaterThan(shortHeight);
  await editor.fill('Короткий текст.');
  await expect.poll(() => editor.evaluate((element) => element.clientHeight)).toBeLessThan(expandedHeight);
  await page.locator('.detail-description-actions').getByRole('button', { name: 'Готово' }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].description).toBe('Короткий текст.');
});

test('description copy waits for clipboard success and preserves exact paragraphs', async ({ page }) => {
  await openDetails(page, 390);
  await page.evaluate(() => {
    const target = window as Window & { __clipboardText?: string; __resolveClipboard?: () => void };
    Object.defineProperty(target, '__resolveClipboard', { configurable: true, writable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: (text: string) => new Promise<void>((resolve) => {
        target.__clipboardText = text;
        target.__resolveClipboard = resolve;
      })
    } });
  });
  await page.getByRole('button', { name: 'Скопировать' }).click();
  await expect(page.locator('.detail-copy-feedback')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as Window & { __clipboardText?: string }).__clipboardText)).toBe(task.description);
  await page.evaluate(() => (window as Window & { __resolveClipboard?: () => void }).__resolveClipboard?.());
  await expect(page.locator('.detail-copy-feedback')).toHaveText('Описание скопировано');
});

for (const mode of ['rejected', 'unavailable'] as const) {
  test(`description copy reports ${mode} clipboard without false success`, async ({ page }) => {
    await openDetails(page, 390);
    await page.evaluate((clipboardMode) => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboardMode === 'rejected'
        ? { writeText: async () => { throw new Error('denied'); } }
        : undefined });
    }, mode);
    await page.getByRole('button', { name: 'Скопировать' }).click();
    await expect(page.getByRole('alert')).toContainText('Не удалось скопировать');
    await expect(page.locator('.detail-copy-feedback.success')).toHaveCount(0);
  });
}

test('read-only details allow copy but not description editing or task changes', async ({ page }) => {
  await openDetails(page, 390, { readOnly: true });
  await expect(page.locator('.detail-description-read')).toHaveText(task.description);
  await expect(page.getByRole('button', { name: 'Изменить', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Сохранить изменения' })).toHaveCount(0);
  await expect(page.locator('.detail-save-state')).toHaveCount(0);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => undefined } }));
  await page.getByRole('button', { name: 'Скопировать' }).click();
  await expect(page.locator('.detail-copy-feedback.success')).toHaveText('Описание скопировано');
});

test('empty description has compact add action and cannot report empty copy as success', async ({ page }) => {
  const requests = await openDetails(page, 320, { taskOverrides: { description: '' } });
  await expect(page.getByText('Описание не добавлено')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Скопировать' })).toBeDisabled();
  await page.locator('.detail-description-actions').getByRole('button', { name: 'Добавить описание' }).click();
  await page.getByRole('textbox', { name: 'Описание' }).fill('Новое описание.');
  await page.locator('.detail-description-actions').getByRole('button', { name: 'Готово' }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].description).toBe('Новое описание.');
});

test('description patch survives closing and reopening from server-backed task list', async ({ page }) => {
  const requests = await openDetails(page, 390);
  await page.locator('.detail-description-actions').getByRole('button', { name: 'Изменить' }).click();
  const description = 'Первый абзац.\n\nВторой абзац после повторного открытия.';
  await page.getByRole('textbox', { name: 'Описание' }).fill(description);
  await page.locator('.detail-description-actions').getByRole('button', { name: 'Готово' }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].description).toBe(description);
  await page.getByRole('button', { name: 'Назад к задачам' }).click();
  await page.getByRole('button').filter({ hasText: task.title }).first().click();
  await expect(page.locator('.detail-description-read')).toHaveText(description);
});

test('version conflict shows both versions and keeps the local edit on «решить позже»', async ({ page }) => {
  await openDetails(page, 390, { taskOverrides: { version: '7' } });
  const title = page.getByRole('textbox', { name: 'Название задачи' });
  await title.fill('Моя версия названия');
  // Server reports a different revision than the one the client read.
  await page.route(`**/api/boards/${board.id}/tasks/${task.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    await route.fulfill({ status: 409, json: { error: 'version conflict', expectedVersion: '7', task: { ...task, title: 'Чужая версия названия', version: '8' } } });
  });
  await flushAutosave(page);
  await expect(page.getByRole('dialog', { name: 'Конфликт изменений' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Конфликт изменений' })).toContainText('Моя версия названия');
  await expect(page.getByRole('dialog', { name: 'Конфликт изменений' })).toContainText('Чужая версия названия');
  // Close via «Решить позже»: the local edit stays in the field, nothing is overwritten.
  await page.getByRole('button', { name: 'Решить позже' }).click();
  await expect(title).toHaveValue('Моя версия названия');
  // Leaving a deferred conflict preserves the input without an automatic overwrite.
  await page.route(`**/api/boards/${board.id}/tasks/${task.id}`, (route) => route.fallback());
  await page.getByRole('button', { name: 'Назад к задачам' }).click();
});

for (const keepLocal of [true, false]) {
  test(`conflict resolution preserves independent fields and clears rejected storage: local=${keepLocal}`, async ({ page }) => {
    const requests = await openDetails(page, 390);
    let server = { ...task, title: 'Серверное название', priority: 'urgent', version: '2' };
    await page.route('**/api/boards/board-1/tasks/task-1', async (route) => {
      if (route.request().method() !== 'PATCH') return route.fulfill({ json: server });
      const input = route.request().postDataJSON();
      requests.push(input);
      if (input.expectedVersion !== server.version) return route.fulfill({ status: 409, json: { error: 'version conflict', task: server } });
      server = { ...server, ...input, version: String(Number(server.version) + 1) };
      await route.fulfill({ json: server });
    });
    await page.locator('.detail-description-actions').getByRole('button', { name: 'Изменить' }).click();
    await page.getByRole('textbox', { name: 'Описание', exact: true }).fill('Независимое локальное описание');
    await page.getByRole('textbox', { name: 'Название задачи' }).fill('Локальное название');
    const dialog = page.getByRole('dialog', { name: 'Конфликт изменений' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Локальное название');
    await expect(dialog).toContainText('Серверное название');
    await expect(dialog.getByRole('button', { name: 'Моя правка поверх серверной', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Оставить серверную версию', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Решить позже' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Моя правка поверх серверной', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Разрешить конфликт', exact: true }).click();
    await dialog.getByRole('button', { name: keepLocal ? 'Моя правка поверх серверной' : 'Оставить серверную версию', exact: true }).click();
    await expect(page.locator('.detail-save-state')).toHaveText('Сохранено');
    expect(server.title).toBe(keepLocal ? 'Локальное название' : 'Серверное название');
    expect(server.description).toBe('Независимое локальное описание');
    expect(server.priority).toBe('urgent');
    expect(requests[1].expectedVersion).toBe('2');
    expect(requests[1]).not.toHaveProperty('priority');
    if (!keepLocal) expect(requests[1]).not.toHaveProperty('title');
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('tasks.draft.') || key.startsWith('tasks.autosave.')))).toEqual([]);
    await page.getByRole('textbox', { name: 'Название задачи' }).fill('Следующая правка');
    await expect(page.locator('.detail-save-state')).toHaveText('Сохранено');
    expect(requests[2].expectedVersion).toBe('3');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.getByRole('button', { name: 'Назад к задачам' }).click();
    await page.waitForTimeout(1000);
    expect(requests).toHaveLength(3);
  });
}

test('unversioned legacy draft requires explicit choice even after repeated reloads', async ({ page }) => {
  const requests = await openDetails(page, 390);
  await page.getByRole('textbox', { name: 'Название задачи' }).fill('Legacy local title');
  await page.evaluate(() => {
    const key = 'tasks.draft.v1.["user-2","board-1","task-1"]';
    const stored = JSON.parse(localStorage.getItem(key)!);
    delete stored.base;
    delete stored.serverVersion;
    localStorage.setItem(key, JSON.stringify(stored));
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.reload();
    await page.getByRole('button').filter({ hasText: task.title }).first().click();
    await expect(page.getByRole('dialog', { name: 'Конфликт изменений' })).toContainText('Legacy local title');
    await page.getByRole('button', { name: 'Решить позже' }).click();
    await page.waitForTimeout(1000);
    expect(requests).toHaveLength(0);
  }
  await page.getByRole('button', { name: 'Разрешить конфликт', exact: true }).click();
  await page.getByRole('button', { name: 'Оставить серверную версию', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Название задачи' })).toHaveValue(task.title);
  expect(requests).toHaveLength(0);
});

test('server choice with no remaining patch updates parent and does not replay on reopen', async ({ page }) => {
  const requests = await openDetails(page, 390);
  await page.route('**/api/boards/board-1/tasks/task-1', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 409, json: { error: 'version conflict', task: { ...task, title: 'Server accepted', version: '2' } } });
  });
  await page.getByRole('textbox', { name: 'Название задачи' }).fill('Rejected local');
  await page.getByRole('button', { name: 'Оставить серверную версию', exact: true }).click();
  await expect(page.locator('.detail-save-state')).toHaveText('Сохранено');
  await expect(page.getByRole('textbox', { name: 'Название задачи' })).toHaveValue('Server accepted');
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('tasks.draft.') || key.startsWith('tasks.autosave.')))).toEqual([]);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('button', { name: 'Назад к задачам' }).click();
  await page.getByRole('button').filter({ hasText: 'Server accepted' }).first().click();
  await expect(page.getByRole('textbox', { name: 'Название задачи' })).toHaveValue('Server accepted');
  await page.waitForTimeout(1000);
  expect(requests).toHaveLength(1);
});

test('resolution uses single-flight queue and preserves newer typing while the response is pending', async ({ page }) => {
  const requests = await openDetails(page, 390);
  let server = { ...task, title: 'Remote title', version: '2' };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/boards/board-1/tasks/task-1', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fulfill({ json: server });
    const input = route.request().postDataJSON();
    requests.push(input);
    if (input.expectedVersion !== server.version) return route.fulfill({ status: 409, json: { error: 'version conflict', task: server } });
    if (requests.length === 2) await gate;
    server = { ...server, title: input.title, version: String(Number(server.version) + 1) };
    await route.fulfill({ json: server });
  });
  const title = page.getByRole('textbox', { name: 'Название задачи' });
  await title.fill('Chosen local title');
  await page.getByRole('button', { name: 'Моя правка поверх серверной', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  await title.fill('Newer typing');
  await title.blur();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(100);
  expect(requests).toHaveLength(2);
  release();
  await expect(page.locator('.detail-save-state')).toHaveText('Сохранено');
  await expect(title).toHaveValue('Newer typing');
  expect(server.title).toBe('Newer typing');
  expect(requests.map((input) => input.expectedVersion)).toEqual(['1', '2', '3']);
});

for (const complete of [true, false]) {
  test(`checklist decision preserves newer text queued during the failed PATCH: ${complete}`, async ({ page }) => {
    const requests = await openDetails(page, 390);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/boards/board-1/tasks/task-1', async (route) => {
      if (route.request().method() !== 'PATCH' || requests.length) return route.fallback();
      requests.push(route.request().postDataJSON());
      await gate;
      await route.fulfill({ status: 409, json: { error: 'incomplete checklist confirmation required', incompleteChecklist: 2 } });
    });
    await page.locator('.detail-status-action').click();
    await page.getByRole('radio', { name: 'Готово', exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    const title = page.getByRole('textbox', { name: 'Название задачи' });
    await title.fill('Newer text during request');
    release();
    const dialog = page.getByRole('dialog', { name: 'Завершить задачу?' });
    await dialog.getByRole('button', { name: complete ? 'Завершить' : 'Отмена', exact: true }).click();
    await expect(page.locator('.detail-save-state')).toHaveText('Сохранено');
    await expect(title).toHaveValue('Newer text during request');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ title: 'Newer text during request', expectedVersion: '1', confirmIncompleteChecklist: complete });
    if (complete) expect(requests[1].status).toBe('done');
    else expect(requests[1]).not.toHaveProperty('status');
  });
}

test('exit flush keeps checklist confirmation visible and Escape cancels only completion', async ({ page }) => {
  const requests = await openDetails(page, 390);
  await page.route('**/api/boards/board-1/tasks/task-1', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 409, json: { error: 'incomplete checklist confirmation required', incompleteChecklist: 2 } });
  });
  await page.locator('.detail-status-action').click();
  await page.getByRole('radio', { name: 'Готово', exact: true }).click();
  await page.getByRole('button', { name: 'Назад к задачам' }).click();
  await expect(page.getByRole('dialog', { name: 'Завершить задачу?' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.detail-status-action')).toHaveText('В работе');
  await expect(page.locator('.detail-save-state')).toHaveText('Сохранено');
  await page.getByRole('button', { name: 'Назад к задачам' }).click();
  await expect(page.getByRole('heading', { name: 'Детали задачи' })).toHaveCount(0);
  expect(requests).toHaveLength(1);
});

for (const error of [{ error: 'checklist confirmation required', incompleteChecklist: 2 }, { error: 'task blocker would create dependency cycle' }]) {
  test(`non-version 409 remains its own error: ${error.error}`, async ({ page }) => {
    const requests = await openDetails(page, 390);
    await page.route('**/api/boards/board-1/tasks/task-1', async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      requests.push(route.request().postDataJSON());
      await route.fulfill({ status: 409, json: error });
    });
    await page.getByRole('textbox', { name: 'Название задачи' }).fill('Rejected edit');
    await expect(page.getByRole('alert')).toHaveText(error.error);
    await expect(page.getByRole('dialog', { name: 'Конфликт изменений' })).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(1000);
    expect(requests).toHaveLength(1);
  });
}

test('GitHub issue stays compact, opens safely, and autosaves edits', async ({ page }) => {
  const requests = await openDetails(page, 390, { taskOverrides: { issue_url: 'https://github.com/owner/repo/issues/7' } });
  const issue = page.locator('.detail-github');
  const link = issue.getByRole('link', { name: /owner\/repo#7/ });
  await expect(link).toHaveAttribute('href', 'https://github.com/owner/repo/issues/7');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(issue.getByRole('textbox')).toHaveCount(0);
  await issue.getByRole('button', { name: 'Изменить' }).click();
  await issue.getByRole('textbox', { name: 'Ссылка на GitHub issue' }).fill('owner/next#8');
  await issue.getByRole('button', { name: 'Готово' }).click();
  await flushAutosave(page);
  await expect(issue.getByRole('link', { name: /owner\/next#8/ })).toHaveAttribute('href', 'https://github.com/owner/next/issues/8');
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].issueUrl).toBe('owner/next#8');
  await issue.getByRole('button', { name: 'Изменить' }).click();
  await issue.getByRole('button', { name: 'Удалить' }).click();
  // The remove action leaves edit mode by itself and autosaves the cleared link.
  await expect(issue.getByRole('button', { name: 'Добавить GitHub issue' })).toBeVisible();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].issueUrl).toBeNull();
  await flushAutosave(page);
  await issue.getByRole('button', { name: 'Добавить GitHub issue' }).click();
  await issue.getByRole('textbox', { name: 'Ссылка на GitHub issue' }).fill('owner/added#9');
  await issue.getByRole('button', { name: 'Готово' }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2].issueUrl).toBe('owner/added#9');
  await flushAutosave(page);
});

for (const outcome of ['success', 'failure', 'lost response', 'newer assignment', 'local conflict', 'server conflict'] as const) {
  test(`assignment notification consent stays with its intended assignment: ${outcome}`, async ({ page }) => {
    await mockDetails(page);
    await page.route('**/api/boards/board-1/members', (route) => route.fulfill({ json: { members: [
      { id: 'user-1', first_name: 'Яков' }, { id: 'user-2', first_name: 'Данил' }, { id: 'user-3', first_name: 'Влад' }
    ] } }));
    let server = { ...task };
    const requests: Record<string, any>[] = [];
    let release!: () => void;
    const firstResponse = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/boards/board-1/tasks/task-1', async (route) => {
      if (route.request().method() !== 'PATCH') return route.fulfill({ json: server });
      const input = route.request().postDataJSON();
      requests.push(input);
      if (requests.length === 1) {
        if (outcome === 'failure') return route.fulfill({ status: 500, json: { error: 'Synthetic save failure' } });
        if (outcome.endsWith('conflict')) {
          server = { ...server, assignee_user_id: 'user-3', version: '2' };
          return route.fulfill({ status: 409, json: { error: 'version conflict', task: server } });
        }
        if (outcome === 'newer assignment') await firstResponse;
      }
      expect(input.expectedVersion).toBe(server.version);
      server = { ...server, title: input.title ?? server.title, assignee_user_id: input.assigneeUserId ?? server.assignee_user_id, version: String(Number(server.version) + 1) };
      if (outcome === 'lost response' && requests.length === 1) return route.abort();
      await route.fulfill({ json: server });
    });
    const choose = async (name: string) => {
      await page.getByRole('button', { name: /^Исполнитель/ }).click();
      await page.getByRole('radio', { name, exact: true }).click();
    };
    try {
      await page.goto('/');
      await page.getByRole('button').filter({ hasText: task.title }).first().click();
      await choose('Яков');
      const notify = page.getByRole('checkbox', { name: 'Уведомить нового исполнителя' });
      await expect(notify).not.toBeChecked();
      await notify.check();
      await expect.poll(() => requests.length).toBe(1);
      expect(requests[0]).toMatchObject({ assigneeUserId: 'user-1', notifyAssignee: true });
      if (outcome === 'failure') {
        await expect(page.locator('.detail-save-state')).toContainText('Не сохранено');
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
      } else if (outcome === 'newer assignment') {
        await choose('Влад');
        await expect(notify).not.toBeChecked();
        // A late acknowledgement must not consume a newer, explicitly chosen opt-in.
        await notify.check();
        release();
      } else if (outcome.endsWith('conflict')) {
        await page.getByRole('button', { name: outcome === 'local conflict' ? 'Моя правка поверх серверной' : 'Оставить серверную версию', exact: true }).click();
      }
      await expect(page.locator('.detail-save-state')).toHaveText('Сохранено');
      if (['failure', 'newer assignment', 'local conflict'].includes(outcome)) {
        expect(requests).toHaveLength(2);
        expect(requests[1]).toMatchObject({ assigneeUserId: outcome === 'newer assignment' ? 'user-3' : 'user-1', notifyAssignee: true });
      } else expect(requests).toHaveLength(1);
      const savedCount = requests.length;
      await choose('Данил');
      await expect(notify).not.toBeChecked();
      await expect.poll(() => requests.length).toBe(savedCount + 1);
      expect(requests.at(-1)).toMatchObject({ assigneeUserId: 'user-2', notifyAssignee: false });
      await expect(page.locator('.detail-save-state')).toHaveText('Сохранено');
      await page.getByRole('textbox', { name: 'Название задачи' }).fill('Independent later edit');
      await flushAutosave(page);
      expect(requests.at(-1)).not.toHaveProperty('notifyAssignee');
    } finally { release(); }
  });
}

test('compact property controls still open project, assignee, and priority sheets', async ({ page }) => {
  await openDetails(page, 390);
  const properties = page.locator('.detail-property-grid');
  for (const [index, title] of [[0, 'Проект'], [1, 'Исполнитель'], [3, 'Приоритет']] as const) {
    await properties.getByRole('button').nth(index).click();
    await expect(page.getByRole('dialog', { name: title })).toBeVisible();
    await page.keyboard.press('Escape');
  }
});

test('long title and metadata use full title width without viewport overflow', async ({ page }) => {
  const title = 'Подготовить длинное название задачи для проверки размещения значка и переноса текста '.repeat(2);
  await openDetails(page, 320, {
    taskOverrides: { title },
    projectName: 'ОченьДлинноенеразрывноеназваниепроекта'.repeat(3),
    memberName: 'ОченьДлинноеИмяИсполнителя'.repeat(3)
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const titleBox = await page.getByRole('textbox', { name: 'Название задачи' }).boundingBox();
  const heading = await page.locator('.detail-heading').boundingBox();
  expect(titleBox).not.toBeNull();
  expect(heading).not.toBeNull();
  expect(Math.abs(titleBox!.x - heading!.x - (heading!.x + heading!.width - titleBox!.x - titleBox!.width))).toBeLessThanOrEqual(1);
});

test('details wraps without horizontal overflow at 200 percent text size', async ({ page }) => {
  await openDetails(page, 320, { projectName: 'Длинное название проекта '.repeat(5), memberName: 'Длинное имя исполнителя '.repeat(5) });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('textbox', { name: 'Название задачи' })).toHaveValue(task.title);
  await expect(page.getByRole('button', { name: 'Сохранить изменения' })).toHaveCount(0);
});

test('details preserves desktop shell and full-width reading without horizontal overflow', async ({ page }) => {
  await openDetails(page, 1280);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('textbox', { name: 'Название задачи' })).toHaveValue(task.title);
  await expect(page.locator('.detail-description-read')).toHaveText(task.description);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/details-1280x900.png` });
});

test('details keeps composer reachable with a short visual viewport', async ({ page }) => {
  await openDetails(page, 320);
  await page.setViewportSize({ width: 320, height: 520 });
  await mkdir(evidence, { recursive: true });
  const composer = page.locator('.comment-composer');
  await page.getByRole('textbox', { name: 'Комментарий' }).focus();
  const box = await composer.boundingBox();
  expect((box?.y ?? 520) + (box?.height ?? 0)).toBeLessThanOrEqual(521);
  await page.screenshot({ path: `${evidence}/details-320x520-keyboard.png` });
});

test('details separates destructive action in menu', async ({ page }) => {
  await openDetails(page, 390);
  await page.getByRole('button', { name: 'Другие действия' }).click();
  await expect(page.locator('.detail-danger-zone').getByRole('button', { name: 'Архивировать задачу' })).toBeVisible();
});

test('details autosaves every deadline mode without changing an untouched timestamp', async ({ page }) => {
  const requests = await mockDetails(page);
  await page.setViewportSize({ width: 320, height: 844 });
  const reopen = async () => {
    await page.goto('/');
    await page.getByRole('button', { name: /Подготовить UX-спецификацию/ }).click();
  };
  await reopen();
  // Opening without edits sends nothing: autosave diffs against the server object.
  await expect(page.locator('.detail-save-state')).toHaveText('', { timeout: 3000 });
  for (const [mode, name] of [['date', 'Только дата'], ['none', 'Без срока'], ['datetime', 'Дата и время']]) {
    await page.getByRole('button', { name: /^Срок/ }).click();
    await page.getByRole('radio', { name, exact: true }).click();
    if (mode !== 'none') await page.getByLabel('Дата срока').fill('2026-09-18');
    if (mode === 'datetime') await page.getByLabel('Время срока').fill('18:30');
    await page.getByRole('button', { name: 'Применить' }).click();
    await flushAutosave(page);
    const saved = requests.at(-1)!;
    expect(saved.deadlineDate).toBe(mode === 'date' ? '2026-09-18' : null);
    expect(Boolean(saved.deadline)).toBe(mode === 'datetime');
    await reopen();
    await page.getByRole('button', { name: /^Срок/ }).click();
    await expect(page.getByRole('radio', { name, exact: true })).toBeChecked();
    if (mode !== 'none') await expect(page.getByLabel('Дата срока')).toHaveValue('2026-09-18');
    if (mode === 'datetime') await expect(page.getByLabel('Время срока')).toHaveValue('18:30');
    await page.keyboard.press('Escape');
  }
});
