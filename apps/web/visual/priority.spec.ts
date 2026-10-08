import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/issue-177/', import.meta.url));
const board = { id: 'board-priority', name: 'Таска', type: 'personal', status: 'active', role: 'owner' };
async function fixture(page: Page) {
  const pairs = [true, false, null].flatMap(importance => [true, false, null].map(urgency => ({ importance, urgency })));
  const tasks = [...pairs, ...Array.from({ length: 4 }, () => ({ importance: true, urgency: true }))].map((pair, index) => {
    const rank = pair.importance === null || pair.urgency === null ? 0 : pair.urgency ? pair.importance ? 1 : 2 : pair.importance ? 3 : 4;
    return { id: `task-${index}`, board_id: board.id, board_name: board.name, title: `Задача ${index} — согласовать условия договора`, creator_user_id: 'user', assignee_user_id: 'user', status: index === 3 ? 'waiting' : 'todo', wait_reason: index === 3 ? 'Ждём клиента' : null, ...pair,
      priority: pair.urgency ? 'urgent' : 'normal', version: '1', priority_key: [String(rank), '1', '', '2026-01-01T00:00:00.000001Z', `task-${index}`], created_at: '2026-01-01T00:00:00.000001Z', overdue: false, wait_check_due: false };
  });
  const writes: Record<string, any>[] = [];
  let fail = false;
  let lostResponse = false;
  await page.addInitScript(() => {
    localStorage.setItem('tasks.globalBoardId', 'board-priority');
    localStorage.setItem('tasks.viewState', JSON.stringify({ view: 'list', grouping: 'priority', filters: { scope: 'all', project: '', assignee: '', status: '', priority: '', deadline: '', unassigned: false, search: '' }, scrollY: 0, kanbanStatus: 'todo' }));
  });
  await page.route('https://telegram.org/js/telegram-web-app.js', route => route.fulfill({ contentType: 'application/javascript', body: "window.Telegram={WebApp:{initData:'priority-fixture',initDataUnsafe:{user:{id:1,first_name:'Яков'}},ready(){},expand(){}}};" }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const id = path.split('/').at(-1);
    const row = tasks.find(task => task.id === id);
    if (row && request.method() === 'PATCH') {
      const body = request.postDataJSON(); writes.push(body);
      if (fail) return route.fulfill({ status: 500, json: { error: 'Проверочная ошибка сохранения' } });
      if (body.expectedVersion !== row.version) return route.fulfill({ status: 409, json: { error: 'version conflict', task: row } });
      Object.assign(row, body, { version: String(Number(row.version) + 1) });
      row.priority = row.urgency ? 'urgent' : 'normal';
      row.priority_key[0] = String(row.importance === null || row.urgency === null ? 0 : row.urgency ? row.importance ? 1 : 2 : row.importance ? 3 : 4);
      if (lostResponse) { lostResponse = false; return route.abort('failed'); }
      return route.fulfill({ json: row });
    }
    if (path.endsWith('/tasks') && request.method() === 'POST') {
      const body = request.postDataJSON(); writes.push(body);
      return route.fulfill({ json: { ...tasks[0], ...body, id: 'created', priority: body.urgency ? 'urgent' : 'normal' } });
    }
    const json = path === '/api/auth/telegram' ? { userId: 'user' }
      : path === '/api/boards' ? { boards: [board] }
      : path.endsWith('/task-filters') ? { filters: { scope: 'all' } }
      : path.endsWith('/projects') ? { projects: [] }
      : path.endsWith('/members') ? { members: [{ id: 'user', first_name: 'Яков' }] }
      : path.endsWith('/recurrences') ? { recurrences: [] }
      : path.endsWith('/publications') ? { schedules: [] }
      : path.endsWith('/collaboration') ? { checklist: [], comments: [], attachments: [], timeline: [] }
      : row ?? { tasks };
    return route.fulfill({ json });
  });
  return { tasks, writes, fail: (value: boolean) => { fail = value; }, lose: () => { lostResponse = true; } };
}
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

for (const width of [320, 390]) test(`priority matrix ${width}: axes, three tasks, more, return and focus`, async ({ page }) => {
  await fixture(page); await page.setViewportSize({ width, height: 844 }); await page.goto('/');
  await page.getByRole('button', { name: 'Матрица', exact: true }).click();
  await expect(page.locator('.priority-quadrant')).toHaveCount(4);
  await expect(page.locator('.quadrant-1 .main-task-row')).toHaveCount(3);
  await expect(page.locator('.unassessed-tasks summary')).toHaveText('Не разобрано · 5');
  await expect(page.locator('.quadrant-2')).toContainText('Блокер');
  await expect(page.locator('.quadrant-1 h2')).not.toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const [left, right] = await page.locator('.quadrant-1, .quadrant-2').evaluateAll(elements => elements.map(element => {
    const { y, height } = element.getBoundingClientRect(); return { y, height };
  }));
  expect(left.y).toBe(right.y); expect(left.height).toBe(right.height);
  await noOverflow(page); await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/app-matrix-${width}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Ещё 2', exact: true }).click();
  const more = page.getByRole('dialog', { name: 'Важное срочное' });
  await expect(more.locator('.main-task-row')).toHaveCount(5);
  await more.locator('.task-summary').first().click();
  await expect(page.getByRole('heading', { name: 'Детали задачи' })).toBeAttached();
  await page.getByRole('button', { name: 'Назад к задачам' }).click();
  await expect(more).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(more).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Матрица', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Ещё 2', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Ещё 2', exact: true })).toBeFocused();
});

for (const width of [320, 390]) test(`priority ${width}: 200% text, category labels and full-list overflow`, async ({ page }) => {
  await fixture(page); await page.setViewportSize({ width, height: 844 }); await page.goto('/');
  await page.getByRole('button', { name: 'Матрица', exact: true }).click();
  await page.evaluate(() => {
    const elements = [...document.querySelectorAll<HTMLElement>('html, body, body *')];
    const sizes = elements.map(element => parseFloat(getComputedStyle(element).fontSize));
    elements.forEach((element, index) => { element.style.fontSize = `${sizes[index] * 2}px`; });
  });
  await expect(page.locator('.quadrant-1 h2')).toBeVisible(); await noOverflow(page);
  expect(await page.getByRole('button', { name: 'Матрица', exact: true }).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await mkdir(evidence, { recursive: true }); await page.screenshot({ path: `${evidence}/app-matrix-${width}-text200.png`, fullPage: true });
  await page.getByRole('button', { name: 'Ещё 2', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Важное срочное' })).toBeVisible(); await noOverflow(page);
  await page.screenshot({ path: `${evidence}/app-more-${width}-text200.png`, fullPage: true });
});

for (const width of [320, 390]) test(`priority sheet ${width}, 200% text`, async ({ page }) => {
  await fixture(page); await page.setViewportSize({ width, height: 844 }); await page.goto('/');
  await page.locator('[data-task-id="task-0"] .task-summary').click();
  await page.getByRole('button', { name: /^Приоритет/ }).click();
  await page.evaluate(() => {
    const elements = [...document.querySelectorAll<HTMLElement>('*')];
    const sizes = elements.map(element => parseFloat(getComputedStyle(element).fontSize));
    elements.forEach((element, index) => { element.style.fontSize = `${sizes[index] * 2}px`; });
  });
  const sheet = page.getByRole('dialog', { name: 'Приоритет', exact: true });
  await expect(sheet.getByRole('radiogroup')).toHaveCount(2);
  expect(await sheet.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await sheet.getByRole('radiogroup', { name: 'Срочная?' }).getByRole('radio', { name: 'Не оценено', exact: true }).click();
  await sheet.getByRole('button', { name: 'Применить', exact: true }).scrollIntoViewIfNeeded();
  await expect(sheet.getByRole('button', { name: 'Применить', exact: true })).toBeInViewport();
  await mkdir(evidence, { recursive: true }); await page.screenshot({ path: `${evidence}/app-priority-${width}-text200.png` });
  await page.keyboard.press('Escape'); await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Приоритет/ })).toBeFocused();
});

test('priority editor: cancel, keyboard, independent minimal save, reset, persistence and lost response', async ({ page }) => {
  const data = await fixture(page); await page.goto('/');
  await page.locator('[data-task-id="task-0"] .task-summary').click();
  const opener = page.getByRole('button', { name: /^Приоритет/ });
  await opener.click();
  const sheet = page.getByRole('dialog', { name: 'Приоритет', exact: true });
  await sheet.getByRole('radiogroup', { name: 'Важная?' }).getByRole('radio', { name: 'Нет', exact: true }).click();
  await page.keyboard.press('Escape'); expect(data.writes).toHaveLength(0); await expect(opener).toBeFocused();
  await opener.click();
  await expect(sheet.getByRole('radiogroup', { name: 'Важная?' }).getByRole('radio', { name: 'Да', exact: true })).toHaveAttribute('aria-checked', 'true');
  await sheet.getByRole('radiogroup', { name: 'Важная?' }).getByRole('radio', { name: 'Да', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(sheet.getByRole('radiogroup', { name: 'Важная?' }).getByRole('radio', { name: 'Нет', exact: true })).toBeFocused();
  await sheet.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect.poll(() => data.writes.length).toBe(1);
  expect(data.writes[0]).toMatchObject({ importance: false, expectedVersion: '1' });
  expect(data.writes[0]).not.toHaveProperty('urgency'); expect(data.writes[0]).not.toHaveProperty('priority');
  await expect(page.locator('.detail-save-state')).toHaveAttribute('data-state', 'saved');
  await opener.click(); await sheet.getByRole('button', { name: 'Сбросить оценку' }).click(); data.lose();
  await sheet.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(page.locator('.detail-save-state')).toHaveAttribute('data-state', 'saved');
  expect(data.writes).toHaveLength(2); expect(data.writes[1]).toMatchObject({ importance: null, urgency: null, expectedVersion: '2' });
  await page.getByRole('button', { name: 'Назад к задачам' }).click();
  await page.locator('.unassessed-tasks summary').click();
  await page.locator('[data-task-id="task-0"] .task-summary').click();
  await expect(opener).toContainText('Важность не оценена'); await expect(opener).toContainText('Срочность не оценена');
});

test('priority editor retains failed input and reconciles independent remote change', async ({ page }) => {
  const data = await fixture(page); await page.goto('/'); await page.locator('[data-task-id="task-0"] .task-summary').click();
  await page.getByRole('button', { name: /^Приоритет/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Приоритет', exact: true });
  await sheet.getByRole('radiogroup', { name: 'Важная?' }).getByRole('radio', { name: 'Нет', exact: true }).click();
  data.fail(true); await sheet.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(page.locator('.detail-save-state')).toHaveAttribute('data-state', 'error');
  await expect(page.getByRole('button', { name: /^Приоритет/ })).toContainText('Неважная');
  data.tasks[0].urgency = false; data.tasks[0].version = '2'; data.fail(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.detail-save-state')).toHaveAttribute('data-state', 'saved');
  expect(data.tasks[0].importance).toBe(false); expect(data.tasks[0].urgency).toBe(false);
});

test('priority filters keep matrix/list counts, search and empty state aligned', async ({ page }) => {
  await fixture(page); await page.goto('/'); await page.getByRole('button', { name: 'Матрица', exact: true }).click();
  await page.getByRole('button', { name: 'Фильтры', exact: true }).click();
  await page.getByLabel('Срочность', { exact: true }).selectOption('true');
  await page.getByLabel('Не разобрано', { exact: true }).check();
  await page.getByRole('button', { name: /Показать 1 задач/ }).click();
  await expect(page.locator('.unassessed-tasks summary')).toHaveText('Не разобрано · 1');
  await expect(page.locator('.priority-quadrant .main-task-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Список', exact: true }).click();
  await expect(page.locator('.unassessed-tasks summary')).toHaveText('Не разобрано · 1');
  await page.getByRole('button', { name: 'Поиск задач', exact: true }).click(); await page.getByRole('searchbox', { name: 'Поиск задач' }).fill('Отсутствующая');
  await expect(page.locator('.unassessed-tasks summary')).toHaveText('Не разобрано · 0');
});
