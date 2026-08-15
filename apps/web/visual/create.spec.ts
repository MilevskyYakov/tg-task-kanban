import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));
const board = { id: 'board-1', name: 'Все доски', type: 'personal', status: 'active', role: 'owner' };
const projects = [{ id: 'project-1', board_id: board.id, name: 'Task Kanban' }];
const members = [{ id: 'user-2', first_name: 'Данил', username: 'danil' }];

async function mockCreate(page: Page, failCreate = false) {
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
    if (failCreate && request.method() === 'POST' && path.endsWith('/tasks')) {
      await route.fulfill({ status: 500, json: { error: 'Не удалось создать задачу' } });
      return;
    }
    const payload = path === '/api/auth/telegram' ? { userId: 'user-1' }
      : path === '/api/boards' ? { boards: [board] }
      : path.endsWith('/projects') ? { projects }
      : path.endsWith('/members') ? { members }
      : path.endsWith('/publications') ? { schedules: [] }
      : path.endsWith('/recurrences') ? { recurrences: [] }
      : path.endsWith('/task-filters') ? { filters: {} }
      : { tasks: [] };
    await route.fulfill({ json: payload });
  });
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
  await page.getByRole('radio', { name: 'Task Kanban' }).click();
  await page.getByRole('button', { name: /Исполнитель.*Без ответственного/ }).click();
  await page.getByRole('radio', { name: 'Данил' }).click();
  await page.getByLabel('Дата срока').fill('2026-08-15');
  await page.getByLabel('Время срока').fill('18:00');
}

for (const width of [390, 320]) {
  test(`create ${width}x844 matches contract anatomy`, async ({ page }) => {
    await openFilledCreate(page, width);
    await expect(page.locator('.create-screen select, .create-screen details, .create-screen summary')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Создать задачу' })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const action = await page.locator('.create-action').boundingBox();
    expect((action?.y ?? 844) + (action?.height ?? 0)).toBeLessThanOrEqual(845);
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
