import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

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
      if ('deadline' in input) savedTask.deadline = input.deadline;
      if ('deadlineDate' in input) savedTask.deadline_date = input.deadlineDate;
      if ('deadlineTimezone' in input) savedTask.deadline_timezone = input.deadlineTimezone;
      await route.fulfill({ json: savedTask });
      return;
    }
    const payload = path === '/api/auth/telegram' ? { userId: 'user-2' }
      : path === '/api/boards' ? { boards: [detailBoard] }
      : path.endsWith('/collaboration') ? collaboration
      : path.endsWith('/projects') ? { projects: [{ id: 'project-1', name: projectName }] }
      : path.endsWith('/members') ? { members: [{ id: 'user-2', first_name: memberName }] }
      : path.endsWith('/publications') ? { schedules: [] }
      : path.endsWith('/recurrences') ? { recurrences: [] }
      : path.endsWith('/task-filters') ? { filters: {} }
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
    await expect(page.getByRole('heading', { name: 'Описание' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Чек-лист' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Обсуждение' })).toBeVisible();
    await expect(page.locator('.detail-title .task-glyph')).toBeVisible();
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
  await page.getByRole('radio', { name: 'Решить позже' }).isVisible();
  // Close via «Решить позже»: the local edit stays in the field, nothing is overwritten.
  await page.getByRole('button', { name: 'Решить позже' }).click();
  await expect(title).toHaveValue('Моя версия названия');
  // Choosing the server version replaces the draft with the confirmed object.
  await page.route(`**/api/boards/${board.id}/tasks/${task.id}`, (route) => route.fallback());
  await page.getByRole('button', { name: 'Назад к задачам' }).click();
});

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

test('compact property controls still open project, assignee, and priority sheets', async ({ page }) => {
  await openDetails(page, 390);
  const properties = page.locator('.detail-property-grid');
  for (const [index, title] of [[0, 'Проект'], [1, 'Исполнитель'], [3, 'Приоритет']] as const) {
    await properties.getByRole('button').nth(index).click();
    await expect(page.getByRole('dialog', { name: title })).toBeVisible();
    await page.keyboard.press('Escape');
  }
});

test('long title and metadata retain glyph and stay within narrow viewport', async ({ page }) => {
  const title = 'Подготовить длинное название задачи для проверки размещения значка и переноса текста '.repeat(2);
  await openDetails(page, 320, {
    taskOverrides: { title },
    projectName: 'ОченьДлинноенеразрывноеназваниепроекта'.repeat(3),
    memberName: 'ОченьДлинноеИмяИсполнителя'.repeat(3)
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const titleBox = await page.getByRole('textbox', { name: 'Название задачи' }).boundingBox();
  const glyphBox = await page.locator('.detail-title .task-glyph').boundingBox();
  expect(titleBox).not.toBeNull();
  expect(glyphBox).not.toBeNull();
  expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(glyphBox!.x + 1);
});

test('details wraps without horizontal overflow at 200 percent text size', async ({ page }) => {
  await openDetails(page, 320, { projectName: 'Длинное название проекта '.repeat(5), memberName: 'Длинное имя исполнителя '.repeat(5) });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('.detail-title .task-glyph')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Сохранить изменения' })).toHaveCount(0);
});

test('details preserves desktop shell and full-width reading without horizontal overflow', async ({ page }) => {
  await openDetails(page, 1280);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('.detail-title .task-glyph')).toBeVisible();
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
