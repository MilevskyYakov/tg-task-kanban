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
  test(`kanban ${width}x844 shows the active column and neighbouring peek`, async ({ page }) => {
    await mockKanban(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('.active-kanban-column')).toHaveCount(4);
    await expect(page.locator('#kanban-in_progress .kanban-task-row')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'В работе 2', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const active = await page.locator('#kanban-in_progress').boundingBox();
    const next = await page.locator('#kanban-waiting').boundingBox();
    const track = await page.locator('.kanban-track').boundingBox();
    expect(Math.abs(active!.x - track!.x)).toBeLessThanOrEqual(3);
    expect(next!.x).toBeLessThan(track!.x + track!.width - 20);
    expect(next!.x + next!.width).toBeGreaterThan(track!.x + track!.width);
    await expect(page.locator('.mobile-kanban select, .mobile-kanban .kanban-column')).toHaveCount(0);
    const cards = page.locator('#kanban-in_progress .kanban-task-row');
    await expect(cards.first()).not.toHaveCSS('box-shadow', 'none');
    const firstCard = (await cards.nth(0).boundingBox())!;
    const secondCard = (await cards.nth(1).boundingBox())!;
    expect(secondCard.y - firstCard.y - firstCard.height).toBeGreaterThanOrEqual(10);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/kanban-${width}x844.png` });
  });
}

test('kanban exposes status sheet and rolls back a rejected change', async ({ page }) => {
  await mockKanban(page, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Сменить статус: Подготовить UX-спецификацию' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Статус' })).toBeVisible();
  await page.getByRole('radio', { name: 'Новая' }).click();
  await expect(page.getByRole('status')).toContainText('Статус не изменён');
  await expect(page.locator('#kanban-in_progress .kanban-task-row')).toHaveCount(2);
});

test('native horizontal scrolling, tabs and keyboard select columns without changing tasks', async ({ page }) => {
  await mockKanban(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const writes: string[] = [];
  page.on('request', (request) => { if (request.method() === 'PATCH') writes.push(request.url()); });
  await page.goto('/');
  const track = page.getByRole('region', { name: 'Колонки канбана' });
  const waiting = page.getByRole('button', { name: 'Блокер 1', exact: true });
  await expect(page.getByRole('button', { name: 'В работе 2', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await track.hover();
  await page.mouse.wheel(300, 0);
  await expect(waiting).toHaveAttribute('aria-pressed', 'true');
  await track.focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('button', { name: 'Готово 0', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#kanban-done')).toBeInViewport({ ratio: .95 });
  await page.keyboard.press('Home');
  await expect(page.getByRole('button', { name: 'Новая 1', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await waiting.click();
  await expect(page.locator('#kanban-waiting')).toBeInViewport({ ratio: .95 });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('tasks.viewState')!).kanbanStatus)).toBe('waiting');
  expect(writes).toEqual([]);
});

test('touch swipe scrolls columns and vertical swipe remains page scrolling', async ({ page }) => {
  await mockKanban(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#kanban-in_progress')).toBeInViewport({ ratio: .95 });
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const box = (await page.locator('#kanban-in_progress').boundingBox())!;
  const x = Math.round(box.x + box.width - 20), y = Math.round(box.y + 36);
  await client.send('Input.synthesizeScrollGesture', { x, y, xDistance: -280, yDistance: 0, gestureSourceType: 'touch', speed: 600 });
  await expect(page.getByRole('button', { name: 'Блокер 1', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await client.send('Input.synthesizeScrollGesture', { x: 180, y, xDistance: 0, yDistance: -100, gestureSourceType: 'touch', speed: 400 });
  await expect(page.getByRole('button', { name: 'Блокер 1', exact: true })).toHaveAttribute('aria-pressed', 'true');
});