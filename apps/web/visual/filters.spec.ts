import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defaultFilters, type TaskFilters } from '../src/tasks';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/issue-181/', import.meta.url));
const baseBoard = { id: 'board-181', name: 'Рабочая доска', type: 'chat', status: 'active', role: 'owner' };
const baseTask = { board_id: baseBoard.id, board_name: baseBoard.name, creator_user_id: 'user', assignee_user_id: 'user', assignee_name: 'Яков', status: 'todo', priority: 'normal', importance: null, urgency: null, project_id: 'p1', project_name: 'Проект один', deadline_timezone: 'UTC', overdue: false, wait_check_due: false };
const initialTasks = [
  { ...baseTask, id: 'mine', title: 'Моя важная', importance: true, urgency: true, deadline_date: '2026-10-08', deadline_kind: 'date', priority: 'urgent' },
  { ...baseTask, id: 'unassessed', title: 'Моя без оценки', importance: false },
  { ...baseTask, id: 'other', title: 'Чужая задача', assignee_user_id: 'other', assignee_name: 'Другой участник', importance: false, urgency: false, project_id: 'p2', deadline_date: '2000-01-01', deadline_kind: 'date', overdue: true },
  { ...baseTask, id: 'unassigned', title: 'Без исполнителя', assignee_user_id: null, assignee_name: null, importance: true, urgency: false, status: 'waiting', wait_reason: 'Ожидание' },
  { ...baseTask, id: 'done', title: 'Готовая задача', status: 'done', importance: true, urgency: true },
  { ...baseTask, id: 'second', title: 'Другая доска', board_id: 'board-182', project_id: 'p3' }
];

async function fixture(page: Page, options: { long?: boolean; readonly?: boolean; filters?: Partial<TaskFilters>; manyTasks?: boolean } = {}) {
  const longName = 'Очень длинное название направления и проекта без сокращения смысла';
  const boards = [baseBoard, { ...baseBoard, id: 'board-182', name: 'Вторая доска' }].map(board => ({ ...board, ...(options.readonly ? { status: 'archived', role: 'member', type: 'pair' } : {}), ...(options.long ? { name: longName } : {}) }));
  const state = {
    tasks: options.manyTasks ? [...initialTasks, ...Array.from({ length: 30 }, (_, index) => ({ ...baseTask, id: `extra-${index}`, title: `Моя дополнительная ${index}`, importance: true, urgency: true }))] : [...initialTasks],
    filters: new Map<string, Partial<TaskFilters>>([[baseBoard.id, options.filters ?? {}], ['board-182', { project: 'p1', assignee: 'other', scope: 'all' }]]),
    failure: '', delay: '', release: () => {}, writes: [] as string[]
  };
  await page.clock.setFixedTime(new Date('2026-10-08T12:00:00Z'));
  await page.addInitScript(({ boardId, filters }) => {
    if (!sessionStorage.getItem('filters-fixture')) {
      sessionStorage.setItem('filters-fixture', 'yes');
      localStorage.setItem('tasks.globalBoardId', boardId);
      localStorage.setItem('tasks.viewState', JSON.stringify({ view: 'list', grouping: 'deadline', filters, scrollY: 0, kanbanStatus: 'todo' }));
    }
  }, { boardId: baseBoard.id, filters: defaultFilters });
  await page.route('https://telegram.org/js/telegram-web-app.js', route => route.fulfill({ contentType: 'application/javascript', body: `window.Telegram={WebApp:{initData:'filters-181',initDataUnsafe:{user:{id:1,first_name:'Яков'}},ready(){},expand(){},BackButton:{isVisible:false,show(){this.isVisible=true},hide(){this.isVisible=false},onClick(f){this.listener=f},offClick(f){if(this.listener===f)this.listener=null}}}};` }));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const boardId = path.split('/')[3];
    const get = route.request().method() === 'GET';
    if (state.delay && path.endsWith(state.delay) && get) await new Promise<void>(resolve => { state.release = resolve; });
    if (state.failure && path.endsWith(state.failure) && get) { await route.fulfill({ status: 503, json: { error: 'Справочник временно недоступен' } }); return; }
    let payload: unknown;
    if (path.endsWith('/task-filters')) {
      if (!get) state.filters.set(boardId, route.request().postDataJSON().filters);
      payload = { filters: state.filters.get(boardId) ?? {} };
    } else if (path.endsWith('/tasks') && route.request().method() === 'POST') {
      const input = route.request().postDataJSON();
      const task = { ...baseTask, id: 'created', project_id: null, ...input };
      state.tasks.push(task); state.writes.push(path); payload = { task };
    } else if (path.endsWith('/projects')) {
      const projects = boardId === baseBoard.id ? [{ id: 'p1', name: options.long ? longName : 'Проект один' }, { id: 'p2', name: 'Проект два' }] : [{ id: 'p3', name: 'Другой проект' }];
      payload = { projects: options.long ? [...projects, ...Array.from({ length: 80 }, (_, index) => ({ id: `project-${index}`, name: `${longName} ${index}` }))] : projects };
    } else if (path.endsWith('/members')) {
      const members = [{ id: 'user', first_name: 'Яков' }, ...(boardId === baseBoard.id ? [{ id: 'other', first_name: options.long ? longName : 'Другой участник' }] : [])];
      payload = { members: options.long ? [...members, ...Array.from({ length: 80 }, (_, index) => ({ id: `member-${index}`, first_name: `${longName} ${index}` }))] : members };
    } else payload = path === '/api/auth/telegram' ? { userId: 'user' }
      : path === '/api/boards' ? { boards }
      : /^\/api\/boards\/[^/]+$/.test(path) ? boards.find(board => board.id === boardId)
      : path.endsWith('/publications') ? { schedules: [] }
      : path.endsWith('/recurrences') ? { recurrences: [] }
      : path.endsWith('/collaboration') ? { checklist: [], comments: [], attachments: [], timeline: [] }
      : { tasks: state.tasks.filter(task => path === '/api/tasks/mine' ? task.assignee_user_id === 'user' : task.board_id === boardId) };
    await route.fulfill({ json: payload });
  });
  await mkdir(evidence, { recursive: true });
  return state;
}

const panel = (page: Page) => page.getByRole('dialog', { name: 'Фильтры', exact: true });
const select = (page: Page, name: string) => panel(page).getByRole('combobox', { name, exact: true });
async function open(page: Page) {
  await page.getByRole('button', { name: 'Фильтры', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: /^Показать/ })).toBeEnabled();
}
async function count(page: Page, expected: number) { await expect(panel(page).getByRole('button', { name: `Показать ${expected} задач`, exact: true })).toBeEnabled(); }
async function shot(page: Page, name: string) { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: `${evidence}/${name}.png` }); }

for (const width of [320, 390]) test(`unified filters ${width}: all categories, real selections, independent and full reset`, async ({ page }) => {
  const state = await fixture(page); await page.setViewportSize({ width, height: width === 320 ? 740 : 844 }); await page.goto('/'); await open(page);
  for (const name of ['Доска', 'Проект', 'Исполнитель', 'Статус', 'Срок', 'Важность', 'Срочность']) await expect(select(page, name)).toHaveCount(1);
  await expect(panel(page).locator('details')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Другие фильтры|Ещё/ })).toHaveCount(0);
  await count(page, 2); await shot(page, `${width}-default`);
  await select(page, 'Исполнитель').selectOption('other'); await count(page, 1);
  await select(page, 'Исполнитель').selectOption('unassigned'); await count(page, 1);
  await select(page, 'Исполнитель').selectOption('mine'); await count(page, 2);
  await panel(page).getByRole('button', { name: 'Сбросить: Исполнитель', exact: true }).click(); await count(page, 4);
  await select(page, 'Проект').selectOption('p2'); await count(page, 1);
  await panel(page).getByRole('button', { name: 'Сбросить: Проект', exact: true }).click();
  await select(page, 'Статус').selectOption('waiting'); await count(page, 1);
  await panel(page).getByRole('button', { name: 'Сбросить: Статус', exact: true }).click();
  for (const [value, expected] of [['today', 1], ['week', 1], ['overdue', 1], ['none', 2]] as const) { await select(page, 'Срок').selectOption(value); await count(page, expected); }
  await panel(page).getByRole('button', { name: 'Сбросить: Срок', exact: true }).click();
  await select(page, 'Важность').selectOption('true'); await count(page, 2);
  await select(page, 'Срочность').selectOption('true'); await count(page, 1);
  await panel(page).getByRole('checkbox', { name: 'Не разобрано', exact: true }).check(); await count(page, 0);
  await expect(panel(page).getByText('Нет подходящих задач.', { exact: false })).toBeVisible(); await shot(page, `${width}-empty`);
  await panel(page).getByRole('checkbox', { name: 'Не разобрано', exact: true }).uncheck();
  await panel(page).getByRole('button', { name: 'Сбросить: Важность', exact: true }).click();
  await select(page, 'Срочность').selectOption('unassessed'); await count(page, 1);
  await panel(page).getByRole('button', { name: 'Сбросить: Срочность', exact: true }).click();
  await select(page, 'Важность').selectOption('false'); await count(page, 2);
  await select(page, 'Срочность').selectOption('false'); await count(page, 1);
  await panel(page).getByRole('searchbox').fill('нет такой задачи'); await count(page, 0);
  await panel(page).getByRole('button', { name: 'Очистить поиск', exact: true }).click(); await count(page, 1);
  await panel(page).getByRole('button', { name: 'По проектам', exact: true }).click();
  await select(page, 'Исполнитель').selectOption('mine'); await panel(page).getByRole('searchbox').fill('Моя');
  await panel(page).getByRole('button', { name: 'Сбросить', exact: true }).click(); await count(page, 4);
  await expect(select(page, 'Доска')).toHaveValue(baseBoard.id); await expect(select(page, 'Исполнитель')).toHaveValue('');
  await expect(panel(page).getByRole('button', { name: 'По проектам', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel(page).getByRole('searchbox')).toHaveValue('');
  await expect.poll(() => state.filters.get(baseBoard.id)).toEqual({ ...defaultFilters, scope: 'all' });
  await panel(page).getByRole('button', { name: /^Показать/ }).click();
  await expect(page.locator('.main-task-row')).toHaveCount(4);
  await page.reload(); await open(page); await count(page, 4);
  await expect(panel(page).getByRole('button', { name: 'По проектам', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('board transitions, all boards, kanban and matrix explain effective restrictions', async ({ page }) => {
  await fixture(page); await page.goto('/'); await open(page);
  await select(page, 'Проект').selectOption('p1'); await select(page, 'Исполнитель').selectOption('other');
  await select(page, 'Доска').selectOption('board-182'); await count(page, 1);
  await expect(select(page, 'Проект')).toHaveValue(''); await expect(select(page, 'Исполнитель')).toHaveValue('');
  await select(page, 'Доска').selectOption(''); await count(page, 3);
  await expect(select(page, 'Проект')).toBeDisabled(); await expect(select(page, 'Исполнитель')).toHaveValue('mine');
  await expect(panel(page).getByText(/Все доски — ваши задачи/)).toBeVisible(); await shot(page, 'all-boards');
  await panel(page).getByRole('button', { name: 'Сбросить', exact: true }).click(); await count(page, 3);
  await select(page, 'Статус').selectOption('waiting'); await panel(page).getByRole('button', { name: /^Показать/ }).click();
  await page.getByRole('button', { name: 'Канбан', exact: true }).click(); await open(page); await count(page, 4);
  await expect(select(page, 'Статус')).toBeDisabled(); await expect(panel(page).getByText(/Сохранённый фильтр «Блокер»/)).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'По срокам', exact: true })).toBeDisabled(); await shot(page, 'kanban');
  await panel(page).getByRole('button', { name: /^Показать/ }).click(); await expect(page.locator('.kanban-task-row')).toHaveCount(4);
  await page.getByRole('button', { name: 'Матрица', exact: true }).click(); await open(page); await count(page, 0);
  await expect(select(page, 'Статус')).toHaveValue('waiting'); await expect(panel(page).getByText(/в матрице используются категории оценки/)).toBeVisible();
});

for (const width of [320, 390]) test(`filters ${width}: long choices, 200% text, focus, Back and viewport keyboard`, async ({ page }) => {
  await fixture(page, { long: true }); await page.setViewportSize({ width, height: 844 }); await page.goto('/'); await open(page);
  await select(page, 'Проект').selectOption('p1'); await select(page, 'Исполнитель').selectOption('other');
  await expect(select(page, 'Проект').locator('option')).toHaveCount(83);
  await expect(select(page, 'Исполнитель').locator('option')).toHaveCount(85);
  await shot(page, `${width}-long`);
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  expect(await panel(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const control of await panel(page).locator('button, input, select').all()) {
    const box = (await control.boundingBox())!; expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await shot(page, `${width}-text-200`);
  await panel(page).getByRole('button', { name: 'По проектам', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: /^Показать/ })).toBeInViewport(); await shot(page, `${width}-text-200-bottom`);
  await panel(page).getByRole('button', { name: /^Показать/ }).focus(); await page.keyboard.press('Tab');
  await expect(panel(page).getByRole('button', { name: 'Сбросить', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(panel(page).getByRole('button', { name: /^Показать/ })).toBeFocused();
  await select(page, 'Срок').focus(); await expect(select(page, 'Срок')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(select(page, 'Важность')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Фильтры', exact: true })).toBeFocused();
  await open(page); await expect(select(page, 'Исполнитель')).toHaveValue('other');
  await page.evaluate(() => (window.Telegram!.WebApp!.BackButton as unknown as { listener: () => void }).listener());
  await expect(panel(page)).toHaveCount(0); await expect(page.getByRole('button', { name: 'Фильтры', exact: true })).toBeFocused();
  await page.addStyleTag({ content: 'html { font-size: 100%; }' }); await open(page);
  await panel(page).getByRole('searchbox').fill('запрос');
  await page.evaluate(() => { Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 420 }); window.visualViewport!.dispatchEvent(new Event('resize')); });
  await expect(page.locator('html')).toHaveAttribute('data-task-keyboard', '');
  await expect.poll(async () => { const box = (await panel(page).getByRole('button', { name: /^Показать/ }).boundingBox())!; return box.y + box.height; }).toBeLessThanOrEqual(421);
  await expect.poll(async () => {
    const input = (await panel(page).getByRole('searchbox').boundingBox())!;
    const body = (await panel(page).locator('.filter-body').boundingBox())!;
    return input.y >= body.y && input.y + input.height <= body.y + body.height;
  }).toBe(true);
  await shot(page, `${width}-keyboard-simulated`);
  await page.keyboard.press('Escape'); await open(page); await expect(panel(page).getByRole('searchbox')).toHaveValue('запрос');
});

test('loading, offline directory error and retry keep selection and do not show stale count', async ({ page }) => {
  const state = await fixture(page); state.delay = '/projects'; await page.goto('/');
  await page.getByRole('button', { name: 'Фильтры', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: 'Загружаем…', exact: true })).toBeDisabled();
  await expect(select(page, 'Проект')).toBeDisabled(); await shot(page, 'loading');
  state.failure = '/projects'; state.delay = ''; state.release();
  await expect(panel(page).getByRole('alert')).toContainText('Не удалось');
  await expect(panel(page).getByRole('button', { name: 'Число задач недоступно', exact: true })).toBeDisabled();
  await panel(page).getByRole('searchbox').fill('Моя'); await shot(page, 'error');
  state.failure = ''; await panel(page).getByRole('button', { name: 'Повторить', exact: true }).click(); await count(page, 2);
  await expect(panel(page).getByRole('searchbox')).toHaveValue('Моя');
  await select(page, 'Проект').selectOption('p1');
  await page.context().setOffline(true);
  await select(page, 'Важность').selectOption('true'); await count(page, 1);
  await panel(page).getByRole('button', { name: /^Показать/ }).click(); await open(page);
  await expect(select(page, 'Важность')).toHaveValue('true'); await expect(select(page, 'Проект')).toHaveValue('p1');
  await page.context().setOffline(false);
});

test('delayed saved filters cannot overwrite edits made in the open panel', async ({ page }) => {
  const state = await fixture(page, { filters: { search: 'Старый запрос' } }); state.delay = '/task-filters'; await page.goto('/');
  await page.getByRole('button', { name: 'Фильтры', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: 'Загружаем…', exact: true })).toBeDisabled();
  await panel(page).getByRole('searchbox').fill('Моя'); await expect(panel(page).getByRole('searchbox')).toBeFocused();
  state.delay = ''; state.release(); await count(page, 2);
  await expect(panel(page).getByRole('searchbox')).toHaveValue('Моя');
  await expect.poll(() => state.filters.get(baseBoard.id)?.search).toBe('Моя');
});

test('retry of saved-filter loading and reselecting the same board preserve local changes', async ({ page }) => {
  const state = await fixture(page, { filters: { search: 'Старый запрос' } }); state.failure = '/task-filters'; await page.goto('/');
  await page.getByRole('button', { name: 'Фильтры', exact: true }).click(); await expect(panel(page).getByRole('alert')).toBeVisible();
  await panel(page).getByRole('searchbox').fill('Моя'); state.failure = '';
  await panel(page).getByRole('button', { name: 'Повторить', exact: true }).click(); await count(page, 2);
  await expect(panel(page).getByRole('searchbox')).toHaveValue('Моя');
  await panel(page).getByRole('button', { name: /^Показать/ }).click();
  await page.getByRole('button', { name: baseBoard.name, exact: true }).click();
  await page.getByRole('dialog').getByRole('radio', { name: /Рабочая доска/ }).click();
  await open(page); await count(page, 2); await expect(panel(page).getByRole('searchbox')).toHaveValue('Моя');
});

test('read-only board can be filtered without task mutations; legacy restriction is visible and removable', async ({ page }) => {
  const state = await fixture(page, { readonly: true, filters: { priority: 'normal' } }); await page.goto('/'); await open(page);
  await expect(panel(page).getByText(/^Без отметки «Срочная»/)).toBeVisible(); await count(page, 1);
  await panel(page).getByRole('button', { name: 'Снять сохранённый приоритет', exact: true }).click(); await count(page, 2);
  await select(page, 'Важность').selectOption('true'); await count(page, 1); await shot(page, 'read-only');
  expect(state.writes).toEqual([]);
});

test('new filter choices survive details, create, view and scroll return without revealing a filtered-out task', async ({ page }) => {
  const state = await fixture(page, { manyTasks: true }); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/'); await open(page);
  await select(page, 'Важность').selectOption('true'); await select(page, 'Срочность').selectOption('true'); await select(page, 'Проект').selectOption('p1');
  await panel(page).getByRole('searchbox').fill('Моя'); await panel(page).getByRole('button', { name: 'По проектам', exact: true }).click();
  await panel(page).getByRole('button', { name: /^Показать/ }).click();
  await page.evaluate(() => scrollTo(0, 1100));
  const row = page.locator('.main-task-row').nth(8); await row.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => scrollY);
  await row.locator('.task-summary').click(); await expect(page.getByRole('heading', { name: 'Детали задачи', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Назад к задачам', exact: true }).click();
  await expect.poll(() => page.evaluate(y => Math.abs(scrollY - y), scroll)).toBeLessThanOrEqual(60);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tasks.viewState')!));
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await page.getByRole('textbox', { name: 'Что нужно сделать?', exact: true }).fill('Новая вне фильтра');
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(page.getByRole('heading', { name: 'Задачи', exact: true })).toBeVisible();
  await expect(page.locator('.main-task-row').filter({ hasText: 'Новая вне фильтра' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('tasks.viewState')!).filters)).toEqual(stored.filters);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('tasks.viewState')!).grouping)).toBe(stored.grouping);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('tasks.viewState')!).view)).toBe(stored.view);
  await expect.poll(() => page.evaluate(y => Math.abs(scrollY - y), scroll)).toBeLessThanOrEqual(60);
  await open(page); await expect(select(page, 'Важность')).toHaveValue('true'); await expect(panel(page).getByRole('searchbox')).toHaveValue('Моя');
});
