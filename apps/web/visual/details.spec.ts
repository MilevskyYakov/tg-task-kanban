import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));
const board = { id: 'board-1', name: 'Task Kanban', type: 'personal', status: 'active', role: 'owner' };
const task = {
  id: 'task-1', board_id: board.id, board_name: board.name, title: 'Подготовить UX-спецификацию',
  description: 'Зафиксировать структуру экранов и состояния перед разработкой.', project_id: 'project-1', project_name: 'Task Kanban',
  assignee_user_id: 'user-2', assignee_name: 'Данил', creator_user_id: 'user-1', status: 'in_progress', priority: 'normal',
  deadline: '2026-08-15T18:00:00Z', overdue: false, wait_check_due: false, checklist_completed: 2, checklist_total: 4
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

async function mockDetails(page: Page, failSave = false) {
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
    if (failSave && request.method() === 'PATCH' && path.endsWith(`/tasks/${task.id}`)) {
      await route.fulfill({ status: 500, json: { error: 'Не удалось сохранить задачу' } });
      return;
    }
    const payload = path === '/api/auth/telegram' ? { userId: 'user-2' }
      : path === '/api/boards' ? { boards: [board] }
      : path.endsWith('/collaboration') ? collaboration
      : path.endsWith('/projects') ? { projects: [{ id: 'project-1', name: 'Task Kanban' }] }
      : path.endsWith('/members') ? { members: [{ id: 'user-2', first_name: 'Данил' }] }
      : path.endsWith('/publications') ? { schedules: [] }
      : path.endsWith('/recurrences') ? { recurrences: [] }
      : path.endsWith('/task-filters') ? { filters: {} }
      : { tasks: [task] };
    await route.fulfill({ json: payload });
  });
}

async function openDetails(page: Page, width: number, failSave = false) {
  await mockDetails(page, failSave);
  await page.setViewportSize({ width, height: 844 });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: /Подготовить UX-спецификацию/ }).click();
  await expect(page.getByRole('heading', { name: 'Детали задачи' })).toBeAttached();
}

for (const width of [390, 320]) {
  test(`details ${width}x844 matches contract anatomy`, async ({ page }) => {
    await openDetails(page, width);
    await expect(page.locator('.task-details select, .task-details details, .task-details summary')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /В работе/ })).toBeVisible();
    await page.getByRole('button', { name: /В работе/ }).click();
    await expect(page.getByRole('dialog', { name: 'Статус' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'В работе' })).toBeFocused();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const composer = await page.locator('.comment-composer').boundingBox();
    expect((composer?.y ?? 844) + (composer?.height ?? 0)).toBeLessThanOrEqual(845);
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/details-${width}x844.png` });
  });
}

test('details keeps edited input after failed save', async ({ page }) => {
  await openDetails(page, 390, true);
  const title = page.getByRole('textbox', { name: 'Название задачи' });
  await title.fill('Не терять эту правку');
  await page.getByRole('button', { name: 'Сохранить изменения' }).click();
  await expect(page.getByRole('alert')).toContainText('Не удалось сохранить задачу');
  await expect(title).toHaveValue('Не терять эту правку');
});

test('details keeps composer reachable with a short visual viewport', async ({ page }) => {
  await openDetails(page, 320);
  await page.setViewportSize({ width: 320, height: 520 });
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
