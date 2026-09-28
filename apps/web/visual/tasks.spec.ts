import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));
const board = { id: 'board-1', name: 'Primex', type: 'chat', status: 'active', role: 'owner' };
const tasks = [
  { id: '1', board_id: board.id, board_name: board.name, title: 'Согласовать смету с клиентом', project_id: 'primex', project_name: 'Primex', assignee_user_id: 'user', assignee_name: 'Яков Милевский', creator_user_id: 'user', status: 'todo', priority: 'urgent', deadline: '2026-08-14T12:00:00Z', overdue: true, wait_check_due: false },
  { id: '2', board_id: board.id, board_name: board.name, title: 'Подготовить сценарий публикации', project_id: 'kairos', project_name: 'kAIros', assignee_user_id: 'user', assignee_name: 'Данил Кузнецов', creator_user_id: 'user', status: 'in_progress', priority: 'normal', deadline: '2026-08-15T14:00:00Z', overdue: false, wait_check_due: false },
  { id: '3', board_id: board.id, board_name: board.name, title: 'Обновить тарифы на сайте', project_id: 'vpn', project_name: 'VPN', assignee_user_id: 'user', assignee_name: 'Влад Лапин', creator_user_id: 'user', status: 'waiting', priority: 'normal', deadline: '2026-08-15T18:00:00Z', wait_reason: 'Ждём новые цены', overdue: false, wait_check_due: false },
  { id: '4', board_id: board.id, board_name: board.name, title: 'Проверить отчёт за неделю', project_id: 'primex', project_name: 'Primex', assignee_user_id: 'user', assignee_name: 'Яков Милевский', creator_user_id: 'user', status: 'todo', priority: 'normal', deadline: '2026-08-18T12:00:00Z', overdue: false, wait_check_due: false },
  { id: '5', board_id: board.id, board_name: board.name, title: 'Собрать идеи для онбординга', project_id: 'task', project_name: 'Task Kanban', assignee_user_id: 'user', assignee_name: 'Данил Кузнецов', creator_user_id: 'user', status: 'todo', priority: 'normal', overdue: false, wait_check_due: false }
];

async function mockTasks(page: Page) {
  await page.addInitScript(() => {
    localStorage.removeItem('tasks.globalBoardId');
    localStorage.setItem('tasks.viewState', JSON.stringify({ view: 'list', grouping: 'deadline', filters: { scope: 'mine', project: '', assignee: '', status: '', priority: '', deadline: '', unassigned: false, search: '' }, scrollY: 0, kanbanStatus: 'todo' }));
  });
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: "window.Telegram={WebApp:{initData:'visual-tasks',initDataUnsafe:{user:{id:1,first_name:'Яков',last_name:'Милевский'}},ready(){},expand(){}}};"
  }));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const payload = path === '/api/auth/telegram' ? { userId: 'user' }
      : path === '/api/boards' ? { boards: [board, { ...board, id: 'board-2', name: 'Task Kanban', type: 'personal' }] }
      : path === '/api/tasks/mine' ? { tasks }
      : path.endsWith('/task-filters') ? { filters: {} }
      : path.endsWith('/projects') ? { projects: [] }
      : path.endsWith('/members') ? { members: [] }
      : path.endsWith('/publications') ? { schedules: [] }
      : path.endsWith('/recurrences') ? { recurrences: [] }
      : path.endsWith('/collaboration') ? { checklist: [], comments: [], attachments: [], timeline: [] }
      : { tasks };
    await route.fulfill({ json: payload });
  });
}

for (const width of [390, 320]) {
  test(`tasks ${width}x844 matches contract anatomy`, async ({ page }) => {
    await mockTasks(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole('heading', { name: 'Задачи' })).toBeVisible();
    await expect(page.locator('.main-task-row')).toHaveCount(5);
    const cards = page.locator('.main-task-row');
    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();
    expect(second!.y - first!.y - first!.height).toBeGreaterThanOrEqual(10);
    expect(await cards.first().evaluate((card) => parseFloat(getComputedStyle(card).borderRadius))).toBeGreaterThanOrEqual(24);
    for (const control of await page.locator('.main-task-row button, .task-completion, .task-toolbar button').all()) {
      const box = await control.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.locator('.main-task-row select, .main-task-row .actions, .main-task-row small:not(.blocker-reason)')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const filter = page.locator('.filter-trigger');
    const filterBox = await filter.boundingBox();
    const countBox = await filter.locator('.filter-count').boundingBox();
    if (countBox && filterBox) expect(countBox.x + countBox.width).toBeLessThanOrEqual(filterBox.x + filterBox.width + 1);
    if (width === 320) {
      const glyphBox = await page.locator('.title-row').boundingBox();
      const boardBox = await page.locator('.board-selector').boundingBox();
      expect((glyphBox?.x ?? 0) + (glyphBox?.width ?? 0)).toBeLessThanOrEqual(boardBox?.x ?? 0);
    }
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/tasks-${width}x844.png` });
    // Capture the actual composited material without ink for contrast sampling.
    await page.locator('.grouped-task-list').screenshot({
      path: `${evidence}/tasca-material-${width}.png`,
      style: '.bottom-navigation { visibility: hidden !important; } .grouped-task-list * { color: transparent !important; -webkit-text-fill-color: transparent !important; } .task-summary, .task-meta *, .avatar, .blocker-reason { background: transparent !important; border-color: transparent !important; box-shadow: none !important; } .grouped-task-list svg, .grouped-task-list input { visibility: hidden !important; }'
    });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const last = await cards.last().boundingBox();
    const navigation = await page.locator('.bottom-navigation').boundingBox();
    expect(last!.y + last!.height).toBeLessThanOrEqual(navigation!.y);
    await page.screenshot({ path: `${evidence}/tasks-bottom-${width}.png` });
  });
}

test('tasks 320 board and filter sheets expose reachable controls', async ({ page }) => {
  await mockTasks(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /Все доски/ }).click();
  await expect(page.getByRole('dialog', { name: /доск/i })).toBeVisible();
  await page.screenshot({ path: `${evidence}/tasks-board-sheet-320x844.png` });
  await page.keyboard.press('Escape');
  await page.locator('.filter-trigger').click();
  const dialog = page.getByRole('dialog', { name: 'Фильтры' });
  await expect(dialog).toBeVisible();
  for (const control of await dialog.locator('button, input, select').all()) {
    const box = await control.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: `${evidence}/tasks-filter-sheet-320x844.png` });
});

test('search opens on demand, preserves query through filters, closes with focus return', async ({ page }) => {
  await mockTasks(page);
  await page.setViewportSize({ width: 320, height: 520 });
  await page.goto('/');
  const opener = page.getByRole('button', { name: 'Поиск задач', exact: true });
  const search = page.getByRole('searchbox', { name: 'Поиск задач' });
  await expect(search).toHaveCount(0);
  await opener.click();
  await expect(search).toBeFocused();
  await search.fill('смету');
  await expect(page.locator('.main-task-row')).toHaveCount(1);
  await page.locator('.main-task-row .task-summary').click();
  await expect(page.getByRole('textbox', { name: 'Название задачи', exact: true })).toHaveValue(tasks[0].title);
  await page.getByRole('button', { name: 'Назад к задачам' }).click();
  await expect(search).toHaveValue('смету');
  await expect(page.locator('.main-task-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Фильтры', exact: true }).click();
  await page.getByRole('button', { name: 'По проектам', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('смету');
  await expect(page.locator('.project-section')).toHaveCount(1);
  await search.focus();
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  await expect(search).toHaveCount(0);
  await expect(page.locator('.main-task-row')).toHaveCount(5);
  await page.getByRole('button', { name: 'Фильтры', exact: true }).click();
  await expect(page.getByRole('button', { name: 'По проектам', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

for (const width of [390, 320]) {
  test(`Tasca ${width}: fallback fonts, no blur, 200% text and Telegram dark remain usable`, async ({ page }) => {
    await mockTasks(page);
    await page.route('**/fonts/**', (route) => route.abort());
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await expect(page.locator('.main-task-row')).toHaveCount(5);
    await page.addStyleTag({ content: '*, *::before, *::after { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; } html { font-size: 200%; }' });
    await expect(page).toHaveTitle('Таска');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(237, 240, 234)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Поиск задач', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Поиск задач' }).fill('смету');
    await expect(page.locator('.main-task-row')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `${evidence}/tasca-fallback-${width}.png` });
    await page.getByRole('button', { name: 'Фильтры', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Фильтры' });
    await dialog.getByRole('button', { name: 'По проектам', exact: true }).click();
    await dialog.getByRole('button', { name: 'Показать 5 задач', exact: true }).click();
    await expect(dialog).toBeHidden();
  });
}
