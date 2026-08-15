import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));
const board = { id: 'board-1', name: 'Task Kanban', type: 'personal', status: 'active', role: 'owner' };
const tasks = [
  { id: '1', board_id: board.id, board_name: board.name, title: 'Подготовить UX-спецификацию', project_name: 'Task Kanban', assignee_user_id: 'user', assignee_name: 'Данил Кузнецов', creator_user_id: 'user', status: 'in_progress', priority: 'normal', deadline: '2026-08-15T18:00:00Z', overdue: false, wait_check_due: false, checklist_completed: 2, checklist_total: 4 },
  { id: '2', board_id: board.id, board_name: board.name, title: 'Подготовить сценарий публикации', project_name: 'kAIros', assignee_user_id: 'user', assignee_name: 'Данил Кузнецов', creator_user_id: 'user', status: 'in_progress', priority: 'normal', deadline: '2026-08-15T14:00:00Z', overdue: false, wait_check_due: false },
  { id: '3', board_id: board.id, board_name: board.name, title: 'Новая задача', assignee_user_id: 'user', creator_user_id: 'user', status: 'todo', priority: 'normal', overdue: false, wait_check_due: false },
  { id: '4', board_id: board.id, board_name: board.name, title: 'Заблокированная задача', assignee_user_id: 'user', creator_user_id: 'user', status: 'waiting', priority: 'normal', overdue: false, wait_check_due: false }
];

async function mockKanban(page: Page, failPatch = false) {
  await page.addInitScript((boardId) => {
    localStorage.setItem('tasks.globalBoardId', boardId);
    localStorage.setItem('tasks.viewState', JSON.stringify({ view: 'kanban', grouping: 'deadline', filters: { scope: 'all', project: '', assignee: '', status: '', priority: '', deadline: '', unassigned: false, search: '' }, scrollY: 0, kanbanStatus: 'in_progress' }));
  }, board.id);
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ contentType: 'application/javascript', body: "window.Telegram={WebApp:{initData:'visual-kanban',initDataUnsafe:{user:{id:1,first_name:'Яков'}},ready(){},expand(){}}};" }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (failPatch && request.method() === 'PATCH' && path.endsWith('/tasks/1')) { await route.fulfill({ status: 500, json: { error: 'Не удалось изменить статус' } }); return; }
    const payload = path === '/api/auth/telegram' ? { userId: 'user' }
      : path === '/api/boards' ? { boards: [board] }
      : path.endsWith('/task-filters') ? { filters: {} }
      : path.endsWith('/projects') ? { projects: [] }
      : path.endsWith('/members') ? { members: [] }
      : path.endsWith('/publications') ? { schedules: [] }
      : path.endsWith('/recurrences') ? { recurrences: [] }
      : { tasks };
    await route.fulfill({ json: payload });
  });
}

for (const width of [390, 320]) {
  test(`kanban ${width}x844 matches one-column contract`, async ({ page }) => {
    await mockKanban(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('.active-kanban-column')).toHaveCount(1);
    await expect(page.locator('.kanban-task-row')).toHaveCount(2);
    await expect(page.locator('.mobile-kanban select, .mobile-kanban .kanban-column')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/kanban-${width}x844.png` });
  });
}

test('kanban exposes status sheet and rolls back a rejected change', async ({ page }) => {
  await mockKanban(page, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /Статус В работе/ }).first().click();
  await expect(page.getByRole('dialog', { name: 'Статус' })).toBeVisible();
  await page.getByRole('radio', { name: 'Новая' }).click();
  await expect(page.getByRole('status')).toContainText('Статус не изменён');
  await expect(page.locator('.kanban-task-row')).toHaveCount(2);
});