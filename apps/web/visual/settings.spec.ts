import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));
const boards = [
  { id: 'board-1', name: 'Primex', type: 'chat', status: 'active', role: 'owner' },
  { id: 'board-2', name: 'Task Kanban', type: 'personal', status: 'active', role: 'owner' }
];
const projects = [
  { id: 'project-1', board_id: 'board-1', name: 'Primex' },
  { id: 'project-2', board_id: 'board-1', name: 'kAIros' },
  { id: 'project-3', board_id: 'board-2', name: 'Task Kanban' }
];
const members = [{ id: 'user-2', first_name: 'Данил', username: 'danil' }];
const recurrences = [{ id: 'recurrence-1', board_id: 'board-1', title: 'План дня', frequency: 'daily', local_time: '09:00', timezone: 'Europe/Moscow' }];
const schedules = [{ kind: 'daily', enabled: true, weekdays: [1, 2, 3, 4, 5], local_time: '09:00', timezone: 'Europe/Moscow', included_statuses: ['todo', 'in_progress'] }];

async function mockSettings(page: Page, failRecurrence = false) {
  await page.addInitScript(() => {
    localStorage.removeItem('tasks.globalBoardId');
    localStorage.setItem('tasks.viewState', JSON.stringify({ view: 'list', grouping: 'deadline', filters: { scope: 'mine', project: '', assignee: '', status: '', priority: '', deadline: '', unassigned: false, search: '' }, scrollY: 0, kanbanStatus: 'todo' }));
  });
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: "window.Telegram={WebApp:{initData:'visual-settings',initDataUnsafe:{user:{id:1,first_name:'Яков',last_name:'Милевский',username:'yakov'}},ready(){},expand(){}}};"
  }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (failRecurrence && request.method() === 'POST' && path.endsWith('/recurrences')) {
      await route.fulfill({ status: 500, json: { error: 'Не удалось создать повтор' } });
      return;
    }
    const boardId = path.split('/')[3];
    const payload = path === '/api/auth/telegram' ? { userId: 'user-1' }
      : path === '/api/boards' ? { boards }
      : path === '/api/tasks/mine' ? { tasks: [] }
      : path.endsWith('/projects') ? { projects: projects.filter((item) => item.board_id === boardId) }
      : path.endsWith('/members') ? { members }
      : path.endsWith('/publications') ? { schedules: boardId === 'board-1' ? schedules : [] }
      : path.endsWith('/recurrences') ? { recurrences: boardId === 'board-1' ? recurrences : [] }
      : path.endsWith('/task-filters') ? { filters: {} }
      : { tasks: [] };
    await route.fulfill({ json: payload });
  });
}

async function openSettings(page: Page, width: number, failRecurrence = false) {
  await mockSettings(page, failRecurrence);
  await page.setViewportSize({ width, height: 844 });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: 'Настройки' }).click();
  await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible();
}

for (const width of [390, 320]) {
  test(`settings root ${width}x844 matches contract anatomy`, async ({ page }) => {
    await openSettings(page, width);
    await expect(page.locator('.settings-card')).toHaveCount(3);
    await expect(page.locator('.settings-card').nth(0)).toContainText('2 доски · 3 проекта');
    await expect(page.locator('.settings-card').nth(1)).toContainText('1 активный сценарий');
    await expect(page.locator('.settings-root select, .settings-root details, .settings-root summary')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/settings-${width}x844.png` });
  });
}

test('settings children use shared controls and keep failed input', async ({ page }) => {
  await openSettings(page, 320, true);

  await page.getByRole('button', { name: /Рабочее пространство/ }).click();
  await page.getByRole('button', { name: /Primex/ }).click();
  await expect(page.getByRole('heading', { name: 'Primex' })).toBeVisible();
  await expect(page.locator('.settings-screen select, .settings-screen details, .settings-screen summary')).toHaveCount(0);

  await page.getByRole('button', { name: /Настройки/ }).first().click();
  await page.getByRole('button', { name: /Автоматизация/ }).click();
  await page.getByRole('button', { name: /Primex/ }).click();
  await expect(page.getByRole('heading', { name: 'Primex' })).toBeVisible();
  await expect(page.locator('.settings-screen select, .settings-screen details, .settings-screen summary')).toHaveCount(0);
  const title = page.getByRole('textbox', { name: 'Название задачи' });
  await title.fill('Не терять повтор');
  await page.getByRole('button', { name: 'Добавить повтор' }).click();
  await expect(page.getByRole('status')).toContainText('Не удалось создать повтор');
  await expect(title).toHaveValue('Не терять повтор');

  await page.getByRole('button', { name: /Настройки/ }).first().click();
  await page.getByRole('button', { name: /Аккаунт/ }).click();
  await expect(page.locator('.settings-screen select, .settings-screen details, .settings-screen summary')).toHaveCount(0);
  await page.getByRole('button', { name: /Группировка задач.*По срокам/ }).click();
  await page.getByRole('radio', { name: 'По проектам' }).click();
  await expect(page.getByRole('button', { name: /Группировка задач.*По проектам/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${evidence}/settings-account-320x844.png` });
});

test('project creation ignores repeated submits while request is pending', async ({ page }) => {
  let creates = 0;
  await mockSettings(page);
  await page.route('**/api/boards/*/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    creates += 1;
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.fulfill({ json: { id: 'project-new', name: 'Новый', archived_at: null } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: /Рабочее пространство/ }).click();
  await page.getByRole('button', { name: /Primex/ }).click();
  const input = page.getByRole('textbox', { name: 'Название нового проекта' });
  await input.fill('Новый');
  await input.evaluate((element) => {
    const form = element.closest('form');
    for (let index = 0; index < 10; index += 1) form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('button', { name: 'Добавляем…' })).toBeDisabled();
  await expect(input).toHaveValue('');
  expect(creates).toBe(1);
});
