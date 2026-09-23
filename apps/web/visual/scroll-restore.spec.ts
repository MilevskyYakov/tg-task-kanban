import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));
const board = { id: 'board-1', name: 'Primex', type: 'personal', status: 'active', role: 'owner' };
const listTitles = Array.from({ length: 30 }, (_, index) => `Задача №${index + 1} для проверки возврата`);
const listTasks = listTitles.map((title, index) => ({
  id: `task-${index + 1}`, board_id: board.id, board_name: board.name, title,
  project_id: 'primex', project_name: 'Primex',
  assignee_user_id: 'user', assignee_name: 'Яков Милевский', creator_user_id: 'user',
  status: 'todo', priority: 'normal', deadline: '2026-08-14T12:00:00Z', overdue: true, wait_check_due: false
}));
const backlogTasks = listTitles.map((title, index) => ({
  id: `task-${index + 1}`, board_id: board.id, board_name: board.name, title,
  project_id: 'primex', project_name: 'Primex', creator_user_id: 'user',
  status: 'todo', priority: 'normal', deadline: '2026-08-14T12:00:00Z', overdue: false, wait_check_due: false
}));
const collaboration = {
  checklist: [
    { id: 'check-1', text: 'Уточнить объём', position: 0, completed_at: '2026-08-14T10:00:00Z' },
    { id: 'check-2', text: 'Согласовать срок', position: 1 }
  ],
  comments: Array.from({ length: 12 }, (_, index) => ({
    id: `comment-${index + 1}`, author_name: 'Яков Милевский', body: `Комментарий №${index + 1} для высоты карточки`, created_at: '2026-08-14T12:00:00Z'
  })),
  attachments: [],
  timeline: [{ id: 'timeline-1', action: 'создал задачу', actor_name: 'Яков Милевский', created_at: '2026-08-14T12:00:00Z' }]
};

type MockOptions = {
  view?: 'list' | 'kanban';
  backlog?: boolean;
  delayTaskId?: string;
  delayMs?: number;
  failCollaboration?: boolean;
};

async function mockScrollList(page: Page, options: MockOptions = {}) {
  const { view = 'list', backlog = false, delayTaskId, delayMs = 3500, failCollaboration = false } = options;
  const tasks = backlog ? backlogTasks : listTasks;
  await page.addInitScript(({ boardId, view }) => {
    localStorage.setItem('tasks.globalBoardId', boardId);
    localStorage.setItem('tasks.viewState', JSON.stringify({
      view, grouping: 'deadline',
      filters: { scope: 'mine', project: '', assignee: '', status: '', priority: '', deadline: '', unassigned: false, search: '' },
      scrollY: 0, kanbanStatus: 'todo'
    }));
  }, { boardId: board.id, view });
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: "window.Telegram={WebApp:{initData:'scroll-restore',initDataUnsafe:{user:{id:1,first_name:'Яков'}},ready(){},expand(){}}};"
  }));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/collaboration')) {
      if (failCollaboration) { await route.fulfill({ status: 500, json: { error: 'Нет связи с доской' } }); return; }
      if (delayTaskId && path.endsWith(`/tasks/${delayTaskId}/collaboration`)) await new Promise((resolve) => setTimeout(resolve, delayMs));
      await route.fulfill({ json: collaboration });
      return;
    }
    const payload = path === '/api/auth/telegram' ? { userId: 'user' }
      : path === '/api/boards' ? { boards: [board] }
      : path.endsWith('/projects') ? { projects: [{ id: 'primex', name: 'Primex' }] }
      : path.endsWith('/members') ? { members: [{ id: 'user', first_name: 'Яков Милевский' }] }
      : path.endsWith('/task-filters') ? { filters: {} }
      : path.endsWith('/publications') ? { schedules: [] }
      : path.endsWith('/recurrences') ? { recurrences: [] }
      : { tasks };
    await route.fulfill({ json: payload });
  });
}

async function openList(page: Page, width: number, options: MockOptions = {}) {
  await mockScrollList(page, options);
  await page.setViewportSize({ width, height: 844 });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  if (options.backlog) {
    await page.getByRole('button', { name: /Бэклог/ }).click();
    await expect(page.locator('.backlog-row')).toHaveCount(30);
  } else if (options.view === 'kanban') {
    await expect(page.locator('.kanban-task-row')).toHaveCount(30);
  } else {
    await expect(page.locator('.main-task-row')).toHaveCount(30);
  }
}

const rowSelector = (options: MockOptions) => options.backlog ? '.backlog-row' : options.view === 'kanban' ? '.kanban-task-row' : '.main-task-row';

async function scrollToPosition(page: Page, target: number) {
  await page.evaluate((top) => window.scrollTo(0, top), target);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(target - 10);
}

// Returns a row fully inside the viewport so the click does not trigger Playwright auto-scroll.
async function pickVisibleRowIndex(page: Page, options: MockOptions) {
  const index = await page.locator(rowSelector(options)).evaluateAll((rows) => rows.findIndex((row) => {
    const rect = row.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight && rect.height > 0;
  }));
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

async function openRow(page: Page, index: number, options: MockOptions) {
  const row = page.locator(rowSelector(options)).nth(index);
  await row.locator('.task-summary').click();
  await expect(page.getByRole('heading', { name: 'Детали задачи' })).toBeAttached();
  return row;
}

async function expectRestored(page: Page, expectedY: number, row: ReturnType<Page['locator']>, tolerance = 60) {
  await expect(page.getByRole('heading', { name: 'Детали задачи' })).not.toBeAttached();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(expectedY + tolerance);
  await expect.poll(() => page.evaluate((top) => Math.abs(window.scrollY - top), expectedY)).toBeLessThanOrEqual(tolerance);
  await expect(row).toBeInViewport();
}

for (const width of [390, 320]) {
  test(`list ${width}x844: back returns to the original scroll position`, async ({ page }) => {
    await openList(page, width);
    await scrollToPosition(page, 1200);
    const index = await pickVisibleRowIndex(page, {});
    const row = page.locator(rowSelector({})).nth(index);
    await page.screenshot({ path: `${evidence}/scroll-restore-list-${width}-before.png` });
    await openRow(page, index, {});
    await page.evaluate(() => window.scrollTo(0, 800));
    await page.getByRole('button', { name: 'Назад к задачам' }).click();
    await expectRestored(page, 1200, row);
    await page.screenshot({ path: `${evidence}/scroll-restore-list-${width}-after.png` });
  });
}

test('two consecutive opens restore each entry point', async ({ page }) => {
  await openList(page, 390);
  await scrollToPosition(page, 700);
  const firstIndex = await pickVisibleRowIndex(page, {});
  const firstRow = page.locator(rowSelector({})).nth(firstIndex);
  await openRow(page, firstIndex, {});
  await page.getByRole('button', { name: 'Назад к задачам' }).click();
  await expectRestored(page, 700, firstRow);
  await scrollToPosition(page, 1500);
  const secondIndex = await pickVisibleRowIndex(page, {});
  const secondRow = page.locator(rowSelector({})).nth(secondIndex);
  await openRow(page, secondIndex, {});
  await page.getByRole('button', { name: 'Назад к задачам' }).click();
  await expectRestored(page, 1500, secondRow);
});

test('delayed response after cancel does not hijack the next open', async ({ page }) => {
  await openList(page, 390, { delayTaskId: 'task-1' });
  await scrollToPosition(page, 1200);
  const index = await pickVisibleRowIndex(page, {});
  const row = page.locator(rowSelector({})).nth(index);
  const cancelledTitle = listTitles[index];
  await page.locator(rowSelector({})).nth(index).locator('.task-summary').click();
  await expect(page.locator('.task-details')).toBeVisible();
  // The details body is still loading; the plain back button is the visible escape hatch.
  await page.locator('.task-details').getByRole('button', { name: 'Назад к задачам' }).click();
  await expectRestored(page, 1200, row);
  const otherIndex = (index + 5) % 30;
  await openRow(page, otherIndex, {});
  await expect(page.locator('.detail-title textarea')).toHaveValue(listTitles[otherIndex]);
  await page.waitForTimeout(4000);
  await expect(page.locator('.detail-title textarea')).toHaveValue(listTitles[otherIndex]);
  await expect(page.getByText(cancelledTitle)).toHaveCount(0);
  await page.getByRole('button', { name: 'Назад к задачам' }).click();
  await expectRestored(page, 1200, row);
});

test('failed load returns to the list with position and message', async ({ page }) => {
  await openList(page, 390, { failCollaboration: true });
  await scrollToPosition(page, 1200);
  const index = await pickVisibleRowIndex(page, {});
  const row = page.locator(rowSelector({})).nth(index);
  await row.locator('.task-summary').click();
  await expect(page.locator('.app-message')).toContainText('Нет связи с доской');
  await expect(page.locator('.main-task-row')).toHaveCount(30);
  await expectRestored(page, 1200, row);
});

test('kanban: back restores the original scroll position', async ({ page }) => {
  const options: MockOptions = { view: 'kanban' };
  await openList(page, 390, options);
  await scrollToPosition(page, 1000);
  const index = await pickVisibleRowIndex(page, options);
  const row = page.locator(rowSelector(options)).nth(index);
  await openRow(page, index, options);
  await page.getByRole('button', { name: 'Назад к задачам' }).click();
  await expectRestored(page, 1000, row);
});

test('backlog: back restores the original scroll position', async ({ page }) => {
  const options: MockOptions = { backlog: true };
  await openList(page, 390, options);
  await scrollToPosition(page, 1000);
  const index = await pickVisibleRowIndex(page, options);
  const row = page.locator(rowSelector(options)).nth(index);
  await openRow(page, index, options);
  await page.getByRole('button', { name: 'Назад к задачам' }).click();
  await expectRestored(page, 1000, row);
});
