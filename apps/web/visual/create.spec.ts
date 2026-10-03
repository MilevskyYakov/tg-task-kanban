import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));
const board = { id: 'board-1', name: 'Все доски', type: 'personal', status: 'active', role: 'owner' };
const projects = [{ id: 'project-1', board_id: board.id, name: 'Task Kanban' }];
const members = [{ id: 'user-2', first_name: 'Данил', username: 'danil' }, { id: 'user-1', first_name: 'Яков' }];

async function mockCreate(page: Page, failCreate = false, options: { filters?: Record<string, unknown>; view?: 'list' | 'kanban'; column?: string; haptic?: 'missing' | 'old' | 'throws'; warning?: string; pair?: boolean } = {}) {
  const requests: Record<string, any>[] = [];
  const savedTasks: Record<string, any>[] = [];
  await page.addInitScript(({ boardId, options }) => {
    localStorage.setItem('tasks.globalBoardId', boardId);
    localStorage.setItem('tasks.viewState', JSON.stringify({ view: options.view ?? 'list', grouping: 'deadline', filters: { scope: 'mine', project: '', assignee: '', status: '', priority: '', deadline: '', unassigned: false, search: '', ...options.filters }, scrollY: 0, kanbanStatus: options.column ?? 'todo' }));
  }, { boardId: board.id, options });
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.__haptics=[]; window.Telegram={WebApp:{initData:'visual-create',initDataUnsafe:{user:{id:1,first_name:'Яков'}},ready(){},expand(){},isVersionAtLeast(){return ${options.haptic !== 'old'}},${options.haptic === 'missing' ? '' : `HapticFeedback:{impactOccurred(style){window.__haptics.push(style);${options.haptic === 'throws' ? "throw new Error('Device unavailable')" : ''}}}`} }};`
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
        description: input.description, project_id: input.projectId, status: input.status, priority: input.priority, deadline: input.deadline,
        deadline_date: input.deadlineDate, deadline_timezone: input.deadlineTimezone, assignee_user_id: input.assigneeUserId,
        wait_reason: input.waitReason, blocked_by_task_id: input.blockerTaskId, overdue: false, wait_check_due: false };
      savedTasks.push(task);
      await route.fulfill({ json: { ...task, notificationWarning: options.warning } }); return;
    }
    const payload = path === '/api/auth/telegram' ? { userId: 'user-1' }
      : path === '/api/boards' ? { boards: [{ ...board, type: options.pair ? 'pair' : board.type }] }
      : path === `/api/boards/${board.id}` ? { ...board, type: options.pair ? 'pair' : board.type }
      : path.endsWith('/projects') ? { projects }
      : path.endsWith('/members') ? { members }
      : path.endsWith('/publications') ? { schedules: [] }
      : path.endsWith('/recurrences') ? { recurrences: [] }
      : path.endsWith('/task-filters') ? { filters: options.filters ?? {} }
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
    await expect(page.getByRole('textbox', { name: 'Описание', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Дополнительно' })).toHaveAttribute('aria-expanded', 'false');
    const close = await page.getByRole('button', { name: 'Закрыть', exact: true }).boundingBox();
    const heading = await page.getByRole('heading', { name: 'Новая задача' }).boundingBox();
    expect(heading!.x).toBeGreaterThanOrEqual(close!.x + close!.width + 8);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const action = await page.locator('.create-action').boundingBox();
    expect((action?.y ?? 844) + (action?.height ?? 0)).toBeLessThanOrEqual(845);
    await expect(page.getByRole('button', { name: /Срок.*18:00/ })).toBeVisible();
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/create-${width}x844.png` });
    await page.getByRole('button', { name: 'Дополнительно', exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const additional = await page.locator('.create-additional-fields').boundingBox();
    const footer = await page.locator('.create-action').boundingBox();
    expect(additional!.y + additional!.height).toBeLessThanOrEqual(footer!.y);
    await page.screenshot({ path: `${evidence}/create-bottom-${width}.png` });
  });
}

test('create keeps input after failed request', async ({ page }) => {
  await mockCreate(page, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать задачу' }).click();
  const title = page.getByRole('textbox', { name: 'Что нужно сделать?' });
  await title.fill('Не терять этот текст');
  const description = page.getByRole('textbox', { name: 'Описание', exact: true });
  await description.fill('Детали задачи тоже должны сохраниться');
  await page.getByRole('button', { name: 'Создать задачу' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Не удалось создать задачу' })).toContainText('Не удалось создать задачу');
  await expect(title).toHaveValue('Не терять этот текст');
  await expect(description).toHaveValue('Детали задачи тоже должны сохраниться');
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
    await expect(page.getByRole('status').filter({ hasText: 'Задача создана' })).toContainText('Задача создана');
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

  test(`initial blocker and instant completion ${width}`, async ({ page }) => {
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
    await expect(page.getByRole('status').filter({ hasText: 'Задача создана' })).toContainText('Задача создана');
    expect(requests[0]).toMatchObject({ status: 'waiting', blockerTaskId: 'blocker-1', waitReason: null, deadline: null, deadlineDate: null });
    await page.getByRole('button', { name: 'Создать задачу' }).click();
    await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Перенести завершённую задачу');
    await page.getByRole('button', { name: /Исполнитель.*Без ответственного/ }).click();
    await page.getByRole('radio', { name: 'Данил' }).click();
    await page.getByRole('button', { name: /Статус.*К выполнению/ }).click();
    await page.getByRole('radio', { name: 'Готово' }).click();
    await page.getByRole('button', { name: 'Применить' }).click();
    await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Задача создана' })).toContainText('Задача создана');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ status: 'done', assigneeUserId: 'user-2' });
    await page.screenshot({ path: `${evidence}/issue105-done-allowed-${width}.png` });
  });
}

test('create does not change task filters after submit', async ({ page }) => {
  const { requests } = await mockCreate(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: 'Создать задачу' }).click();
  await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Задача в проекте');
  await page.getByRole('textbox', { name: 'Описание', exact: true }).fill('Описание из основного блока');
  await page.getByRole('button', { name: /Проект.*Без проекта/ }).click();
  await page.getByRole('radio', { name: 'Task Kanban' }).click();
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Задача создана' })).toContainText('Задача создана');
  expect(requests[0]).toMatchObject({ projectId: 'project-1', status: 'todo', description: 'Описание из основного блока' });
  await expect(page.getByText('Задача создана, но скрыта фильтрами', { exact: true })).toBeVisible();
  await expect(page.locator('.main-task-row')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Мои', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tasks.viewState') ?? '{}'));
  expect(stored.filters).toMatchObject({ scope: 'mine', project: '', status: '' });
  await expect(page.locator('.filter-count')).toHaveText('1');
});

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
  await expect(page.getByRole('status').filter({ hasText: 'Не удалось подтвердить сохранение' })).toContainText('Не удалось подтвердить сохранение');
  await expect(title).toHaveValue('Сохранить один раз');
  await page.screenshot({ path: `${evidence}/issue77-create-error-390.png` });
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect.poll(() => payloads.length).toBe(2);
  expect(payloads[1]).toEqual(payloads[0]);
});

test('create requires fresh notification consent when the assignee changes', async ({ page }) => {
  const { requests } = await mockCreate(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать задачу' }).click();
  await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Assignment consent');
  await page.getByRole('button', { name: /^Исполнитель/ }).click();
  await page.getByRole('radio', { name: 'Данил', exact: true }).click();
  await page.getByRole('button', { name: 'Дополнительно' }).click();
  const notify = page.getByRole('checkbox', { name: 'Уведомить исполнителя' });
  await expect(notify).not.toBeChecked();
  await notify.check();
  await page.getByRole('button', { name: /^Исполнитель/ }).click();
  await page.getByRole('radio', { name: 'Яков', exact: true }).click();
  await expect(notify).not.toBeChecked();
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ assigneeUserId: 'user-1', notifyAssignee: false });
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

const motionEvidence = fileURLToPath(new URL('../../../artifacts/evidence/issue-171/', import.meta.url));
test.beforeAll(async () => { await mkdir(motionEvidence, { recursive: true }); });
const haptics = (page: Page) => page.evaluate(() => (window as any).__haptics as string[]);
test('one live-region update per receipt, no repeat on return or reload', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await mockCreate(page);
  await startCreation(page);
  await page.clock.install();
  await page.evaluate(() => {
    const region = document.querySelector('.creation-announcement')!;
    (window as any).__creationAnnouncements = [];
    new MutationObserver(() => {
      if (region.textContent) (window as any).__creationAnnouncements.push(region.textContent);
    }).observe(region, { childList: true, characterData: true, subtree: true });
    (window as any).__creationRegion = region;
  });
  await page.locator('.create-action button').first().click();
  await expect(page.locator('.create-action button').first()).toHaveAttribute('data-create-state', 'success');
  await page.clock.runFor(350);
  await expect(page.locator('.created-result')).toBeVisible();
  await page.clock.runFor(61_000);
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__creationAnnouncements)).toEqual(['Задача создана: Ощутимый результат.']);
  expect(await page.evaluate(() => document.querySelector('.creation-announcement') === (window as any).__creationRegion)).toBe(true);
  await expect(page.locator('.created-result [role=status]')).toHaveCount(0);
  await expect(page.locator('.created-result')).toBeVisible();
});
async function startCreation(page: Page, title = 'Ощутимый результат') {
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill(title);
}

for (const width of [320, 390]) for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`creation feedback ${width} ${reducedMotion}: stable controls, server receipt, one accent`, async ({ page }) => {
    const { requests } = await mockCreate(page, false, { filters: { scope: 'all' } });
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/boards/*/tasks', async (route) => {
      if (route.request().method() === 'POST') await gate;
      await route.fallback();
    });
    await startCreation(page);
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.evaluate(() => {
      (window as any).__accents = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        (window as any).__accents.push(this.getAttribute('data-task-id'));
        return animate.apply(this, args);
      };
    });
    const buttons = page.locator('.create-action button');
    const geometry = await buttons.evaluateAll((items) => items.map((item) => { const { x, y, width, height } = item.getBoundingClientRect(); return { x, y, width, height }; }));
    // A cancelled press keeps its hit target and must not send a request.
    await buttons.first().hover(); await page.mouse.down();
    await page.screenshot({ path: `${motionEvidence}/press-${width}-${reducedMotion}.png` });
    await page.mouse.move(2, 2); await page.mouse.up();
    expect(requests).toHaveLength(0);
    await buttons.first().focus(); await page.keyboard.press('Enter');
    await expect(buttons.first()).toHaveText('Создать задачуСоздаём…');
    await expect(buttons.last()).toHaveAccessibleName('Создать и добавить ещё');
    await expect(page.locator('.create-check')).toHaveCount(0);
    expect(await haptics(page)).toEqual([]);
    await expect(page.getByRole('textbox', { name: 'Что нужно сделать?' })).toHaveValue('Ощутимый результат');
    await page.locator('.create-screen form').dispatchEvent('submit');
    expect(await buttons.evaluateAll((items) => items.map((item) => { const { x, y, width, height } = item.getBoundingClientRect(); return { x, y, width, height }; }))).toEqual(geometry);
    await page.screenshot({ path: `${motionEvidence}/pending-${width}-${reducedMotion}.png` });
    if (reducedMotion === 'reduce') await expect(page.locator('.create-spinner')).toHaveCSS('animation-name', 'none');
    release();
    if (reducedMotion === 'no-preference') {
      await expect(buttons.first()).toHaveAttribute('data-create-state', 'success');
      expect(await buttons.evaluateAll((items) => items.map((item) => { const { x, y, width, height } = item.getBoundingClientRect(); return { x, y, width, height }; }))).toEqual(geometry);
      await page.screenshot({ path: `${motionEvidence}/success-${width}.png` });
      await page.clock.runFor(299);
      await expect(page.getByRole('heading', { name: 'Новая задача' })).toBeVisible();
      await page.clock.runFor(1);
    }
    await expect(page.getByRole('heading', { name: 'Задачи', exact: true })).toBeVisible();
    await expect(page.locator('.main-task-row')).toHaveCount(1);
    await page.clock.runFor(30);
    await expect(page.getByRole('heading', { name: 'Задачи', exact: true })).toBeFocused();
    expect(requests).toHaveLength(1);
    expect(await haptics(page)).toEqual(['soft']);
    expect(await page.evaluate(() => (window as any).__accents)).toEqual(reducedMotion === 'reduce' ? [] : ['created-0']);
    await page.screenshot({ path: `${motionEvidence}/result-${width}-${reducedMotion}.png` });
    await page.getByRole('button', { name: 'Задачи', exact: true }).click();
    await expect(page.locator('.main-task-row')).toHaveCount(1);
    expect(await page.evaluate(() => (window as any).__accents)).toEqual(reducedMotion === 'reduce' ? [] : ['created-0']);
    expect(await haptics(page)).toEqual(['soft']);
    await page.getByRole('button', { name: 'Закрыть подтверждение' }).click();
    await page.getByRole('button', { name: 'Задачи', exact: true }).click();
    await expect(page.locator('.created-result')).toHaveCount(0);
  });
}

test('series success never blocks or clears the next input; pending belongs to its button', async ({ page }) => {
  const { requests } = await mockCreate(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await startCreation(page, 'Одинаковое название');
  await page.clock.install(); await page.clock.pauseAt(new Date());
  const title = page.getByRole('textbox', { name: 'Что нужно сделать?' });
  const another = page.locator('.create-action button').last();
  await another.click();
  await expect(another).toHaveAttribute('data-create-state', 'success');
  await expect(title).toBeFocused();
  await title.fill('Одинаковое название');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/boards/*/tasks', async (route) => {
    if (route.request().method() === 'POST') await gate;
    await route.fallback();
  });
  await another.click();
  await expect(another).toHaveAttribute('data-create-state', 'pending');
  await expect(page.locator('.create-action button').first()).toHaveAccessibleName('Создать задачу');
  await page.clock.runFor(1000);
  await expect(title).toHaveValue('Одинаковое название');
  await expect(another).toHaveAttribute('data-create-state', 'pending');
  expect(await haptics(page)).toEqual(['soft']);
  release();
  await expect(title).toHaveValue('');
  await title.fill('Третий ввод не стирать');
  await page.clock.runFor(1000);
  await expect(title).toHaveValue('Третий ввод не стирать');
  expect(requests).toHaveLength(2);
  expect(requests[0].requestId).not.toBe(requests[1].requestId);
  expect(await haptics(page)).toEqual(['soft', 'soft']);
});

for (const view of ['list', 'kanban'] as const) {
  test(`hidden creation in ${view} preserves context, warning and exact open/return`, async ({ page }) => {
    const filters = { scope: 'all', search: view === 'list' ? 'другое' : '', project: 'project-1' };
    await mockCreate(page, false, { filters, view, column: 'in_progress', warning: 'Уведомление исполнителю не доставлено' });
    await startCreation(page);
    await expect(page.getByRole('button', { name: /Проект.*Task Kanban/ })).toBeVisible();
    await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
    const notice = page.getByRole('region', { name: 'Результат создания' });
    await expect(notice).toContainText(view === 'list' ? 'Задача создана, но скрыта фильтрами' : 'Задача в другой колонке');
    await expect(notice).toContainText('Уведомление исполнителю не доставлено');
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('tasks.viewState')!));
    expect(before).toMatchObject({ view, filters, kanbanStatus: 'in_progress' });
    await page.getByRole('button', { name: 'Задачи', exact: true }).click();
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'Открыть', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Название задачи', exact: true })).toHaveValue('Ощутимый результат');
    await page.getByRole('button', { name: 'Назад к задачам' }).click();
    await expect(notice).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('tasks.viewState')!))).toMatchObject({ view, filters, kanbanStatus: 'in_progress' });
    expect(await haptics(page)).toEqual(['soft']);
  });
}

test('loading or failed reload never claims a filter mismatch or loses the receipt', async ({ page }) => {
  await mockCreate(page);
  await startCreation(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/boards/*/tasks', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await gate;
    await route.fulfill({ status: 503, json: { error: 'Нет связи' } });
  });
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Загрузка задач' })).toBeVisible();
  const notice = page.locator('.created-result');
  await expect(notice).toContainText('Задача создана');
  await expect(notice).not.toContainText('скрыта фильтрами');
  release();
  await expect(notice).toContainText('Список не обновился');
  await expect(notice.getByRole('button', { name: 'Открыть' })).toBeEnabled();
  expect(await haptics(page)).toEqual(['soft']);
});

for (const failure of [400, 401, 403, 404, 500, 'abort'] as const) {
  test(`create ${failure}: no false success, preserves input and retry identity`, async ({ page }) => {
    await mockCreate(page);
    const payloads: Record<string, any>[] = [];
    await page.route('**/api/boards/*/tasks', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      payloads.push(route.request().postDataJSON());
      if (payloads.length > 1) return route.fallback();
      if (failure === 'abort') return route.abort('timedout');
      await route.fulfill({ status: failure, json: { error: `Отказ ${failure}` } });
    });
    await startCreation(page);
    await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
    const title = page.getByRole('textbox', { name: 'Что нужно сделать?' });
    await expect(page.locator('.app-message')).toBeVisible();
    await expect(title).toHaveValue('Ощутимый результат');
    await expect(page.locator('.create-check, .created-result')).toHaveCount(0);
    expect(await haptics(page)).toEqual([]);
    if (failure === 500 || failure === 'abort') await expect(title).toBeDisabled();
    else await expect(title).toBeEnabled();
    await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
    await expect(page.locator('.created-result')).toBeVisible();
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toEqual(payloads[0]);
    expect(await haptics(page)).toEqual(['soft']);
  });
}

for (const haptic of ['missing', 'old', 'throws'] as const) {
  test(`haptic ${haptic} does not change successful creation`, async ({ page }) => {
    const { requests } = await mockCreate(page, false, { haptic });
    await startCreation(page);
    await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
    await expect(page.locator('.created-result')).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(await haptics(page)).toEqual(haptic === 'throws' ? ['soft'] : []);
  });
}

test('haptic preference can be disabled, persists on reload and is independent of reduced motion', async ({ page }) => {
  await mockCreate(page);
  await page.goto('/');
  const openAccount = async () => {
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByRole('button', { name: /Аккаунт/ }).click();
  };
  await openAccount();
  const setting = page.getByRole('checkbox', { name: 'Виброотклик при создании задачи' });
  await expect(setting).toBeChecked(); await setting.uncheck();
  await page.reload(); await openAccount(); await expect(setting).not.toBeChecked();
  await page.getByRole('button', { name: 'Задачи', exact: true }).click();
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Без вибрации');
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(page.locator('.created-result')).toBeVisible();
  expect(await haptics(page)).toEqual([]);
  await openAccount(); await setting.check();
  await page.reload(); await openAccount(); await expect(setting).toBeChecked();
  await page.getByRole('button', { name: 'Задачи', exact: true }).click();
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('С вибрацией');
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(page.locator('.created-result')).toBeVisible();
  expect(await haptics(page)).toEqual(['soft']);
});

test('leaving during success cancels old navigation, even after opening a new form', async ({ page }) => {
  await mockCreate(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await startCreation(page);
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(page.locator('[data-create-state=success]')).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  const title = page.getByRole('textbox', { name: 'Что нужно сделать?' });
  await title.fill('Новый ввод');
  await page.clock.runFor(1500);
  await expect(title).toHaveValue('Новый ввод');
  expect(await haptics(page)).toEqual(['soft']);
});

test('access loss removes a confirmed receipt and its announcement on return', async ({ page }) => {
  await mockCreate(page, false, { pair: true });
  await startCreation(page);
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(page.locator('.created-result')).toBeVisible();
  await expect(page.locator('.creation-announcement')).toContainText('Ощутимый результат');
  await page.route(`**/api/boards/${board.id}`, (route) => route.fulfill({ status: 403, json: { error: 'Доступ закрыт' } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Доступ закрыт' })).toBeVisible();
  await page.getByRole('button', { name: 'К моим задачам' }).click();
  await expect(page.locator('.creation-announcement')).toBeEmpty();
  await expect(page.locator('.created-result')).toHaveCount(0);
  expect(await haptics(page)).toEqual(['soft']);
});

test('access loss invalidates a late successful response', async ({ page }) => {
  await mockCreate(page, false, { pair: true });
  await startCreation(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/boards/*/tasks', async (route) => {
    if (route.request().method() === 'POST') await gate;
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(page.locator('[data-create-state=pending]')).toBeVisible();
  await page.route(`**/api/boards/${board.id}`, (route) => route.fulfill({ status: 403, json: { error: 'Доступ закрыт' } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Доступ закрыт' })).toBeVisible();
  release();
  await page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/tasks'));
  expect(await haptics(page)).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Доступ закрыт' })).toBeVisible();
});

for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  test(`320 keyboard and 200% text keep result actions reachable ${reducedMotion}`, async ({ page }) => {
    await mockCreate(page);
    await page.setViewportSize({ width: 320, height: 520 });
    await page.emulateMedia({ reducedMotion });
    await startCreation(page);
    await page.addStyleTag({ content: 'html { font-size: 200%; }' });
    await page.locator('.create-action button').last().click();
    await expect(page.getByRole('textbox', { name: 'Что нужно сделать?' })).toBeFocused();
    await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Продолжение');
    await expect(page.locator('.created-result')).toBeAttached();
    const open = page.locator('.created-result').getByRole('button', { name: 'Открыть' });
    await open.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const footer = (await page.locator('.create-action').boundingBox())!;
    const box = (await open.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(footer.y);
    await page.screenshot({ path: `${motionEvidence}/large-text-${reducedMotion}.png` });
  });
}

test('already confirmed receipt does not replay feedback or revive a dismissed result', async ({ page }) => {
  const { savedTasks } = await mockCreate(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await startCreation(page);
  await page.getByRole('button', { name: 'Создать и добавить ещё' }).click();
  await expect(page.locator('.created-result')).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть подтверждение' }).click();
  await page.route('**/api/boards/*/tasks', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({ json: savedTasks[0] });
  });
  await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Ощутимый результат');
  await page.getByRole('button', { name: 'Создать и добавить ещё' }).click();
  await expect(page.getByRole('textbox', { name: 'Что нужно сделать?' })).toHaveValue('');
  await expect(page.locator('.created-result, .create-check')).toHaveCount(0);
  expect(await haptics(page)).toEqual(['soft']);
});

test('background receipt never vibrates on return; unmount drops the old callback', async ({ page }) => {
  await mockCreate(page);
  await startCreation(page);
  await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }));
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(page.locator('.created-result')).toBeVisible();
  expect(await haptics(page)).toEqual([]);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus'));
  });
  expect(await haptics(page)).toEqual([]);
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Уход до ответа');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let arrived!: () => void;
  const arrival = new Promise<void>((resolve) => { arrived = resolve; });
  await page.route('**/api/boards/*/tasks', async (route) => {
    if (route.request().method() === 'POST') { arrived(); await gate; }
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await arrival;
  await page.reload();
  release();
  await expect(page.getByRole('heading', { name: 'Задачи', exact: true })).toBeVisible();
  await expect(page.locator('.created-result')).toHaveCount(0);
  expect(await haptics(page)).toEqual([]);
});

test('all-boards context does not mislabel a visible assigned result as another view', async ({ page }) => {
  await mockCreate(page);
  await startCreation(page);
  await page.getByRole('button', { name: /Исполнитель.*Без ответственного/ }).click();
  await page.getByRole('radio', { name: 'Яков', exact: true }).click();
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(page.locator('.main-task-row')).toHaveCount(1);
  await page.locator('.board-selector').click();
  await page.getByRole('radio', { name: /Все доски.*Назначенные вам/ }).click();
  await expect(page.locator('.main-task-row')).toHaveCount(1);
  await expect(page.locator('.created-result')).not.toContainText('другом представлении');
  await expect(page.locator('.created-result')).not.toContainText('скрыта фильтрами');
});

test('blocked preference storage reports session-only change without breaking creation', async ({ page }) => {
  await mockCreate(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: /Аккаунт/ }).click();
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); }; });
  await page.getByRole('checkbox', { name: 'Виброотклик при создании задачи' }).uncheck();
  await expect(page.getByRole('status')).toContainText('не удалось сохранить на устройстве');
  await page.getByRole('button', { name: 'Задачи', exact: true }).click();
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await page.getByRole('textbox', { name: 'Что нужно сделать?' }).fill('Без хранилища');
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(page.locator('.created-result')).toBeVisible();
  expect(await haptics(page)).toEqual([]);
});

for (const width of [320, 390]) {
  test(`record real creation motion ${width}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport: { width, height: 844 }, reducedMotion: 'no-preference', recordVideo: { dir: motionEvidence, size: { width, height: 844 } } });
    const page = await context.newPage();
    try {
      await mockCreate(page, false, { filters: { scope: 'all' } });
      await startCreation(page, 'Первый результат');
      await page.evaluate(() => {
        (window as any).__motion = [];
        let previous = '';
        const sample = () => {
          const buttons = [...document.querySelectorAll<HTMLElement>('.create-action button')];
          const state = buttons.map((item) => item.dataset.createState).join(',') || 'tasks';
          if (state !== previous) {
            (window as any).__motion.push({ time: performance.now(), state }); previous = state;
          }
          requestAnimationFrame(sample);
        };
        sample();
      });
      await page.locator('.create-action button').last().hover();
      await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up();
      await expect(page.locator('.created-result')).toBeVisible();
      await page.waitForTimeout(400);
      await page.getByRole('textbox', { name: 'Что нужно сделать?' }).pressSequentially('Следующая задача', { delay: 60 });
      await page.locator('.create-action button').first().hover();
      await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up();
      await expect(page.locator('.main-task-row')).toHaveCount(2);
      await page.waitForTimeout(800);
      const states = await page.evaluate(() => (window as any).__motion as { time: number; state: string }[]);
      const success = states.find((item) => item.state === 'success,idle')!;
      const returned = states.find((item) => item.state === 'tasks')!;
      const confirmationMs = returned.time - success.time;
      expect(confirmationMs).toBeGreaterThanOrEqual(280);
      expect(confirmationMs).toBeLessThan(1000);
      expect(await haptics(page)).toEqual(['soft', 'soft']);
      await writeFile(`${motionEvidence}/motion-${width}.json`, JSON.stringify({ width, confirmationMs, states }, null, 2));
      await page.screenshot({ path: `${motionEvidence}/motion-result-${width}.png` });
    } finally {
      await context.close();
      await page.video()!.saveAs(`${motionEvidence}/motion-${width}.webm`);
    }
  });
}
