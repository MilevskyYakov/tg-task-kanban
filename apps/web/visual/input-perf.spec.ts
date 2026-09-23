import { test, expect, type Page } from '@playwright/test';
import { appendFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Input-to-paint measurement for issue #123: types into the create-title
// textarea and into the task-details title/comment while the board holds a
// long task queue, using sequential keyboard events (not fill) and the
// Event Timing API (input -> next paint) plus long-task blocking time.
// Appends one JSONL line per surface to artifacts/evidence/input-perf.jsonl.

type PerfWindow = Window & { __events: number[]; __block: number };

const evidenceDir = fileURLToPath(new URL('../../../artifacts/evidence/', import.meta.url));
const evidenceFile = `${evidenceDir}/input-perf.jsonl`;
const phase = (process.env.PERF_PHASE ?? 'before').trim();
const lines = process.env.PERF_LINES ? Number(process.env.PERF_LINES) : 40;

const board = { id: 'board-1', name: 'Task Kanban', type: 'personal', status: 'active', role: 'owner' };
const projects = [{ id: 'project-1', board_id: board.id, name: 'Task Kanban' }];
const members = [{ id: 'user-2', first_name: 'Данил', username: 'danil' }, { id: 'user-1', first_name: 'Яков' }];

const DETAIL_TASK = {
  id: 'task-1', board_id: board.id, board_name: board.name, title: 'Подготовить UX-спецификацию',
  description: 'Зафиксировать структуру экранов и состояний перед разработкой.', project_id: 'project-1', project_name: 'Task Kanban',
  assignee_user_id: 'user-1', assignee_name: 'Яков', creator_user_id: 'user-1', status: 'in_progress', priority: 'normal',
  deadline: '2026-08-15T18:00:00Z', overdue: false, wait_check_due: false, checklist_completed: 2, checklist_total: 4
};

const collaboration = {
  checklist: Array.from({ length: 12 }, (_, index) => ({
    id: `check-${index + 1}`, text: `Пункт чек-листа номер ${index + 1}`, position: index, ...(index < 2 ? { completed_at: '2026-08-14T10:00:00Z' } : {})
  })),
  comments: Array.from({ length: 20 }, (_, index) => ({
    id: `comment-${index + 1}`, body: `Комментарий номер ${index + 1} с текстом обсуждения.`, author_name: 'Яков Милевский', created_at: '2026-08-14T12:00:00Z'
  })),
  attachments: [], timeline: []
};

function makeTasks(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...DETAIL_TASK,
    id: `task-${index + 1}`,
    title: `Задача номер ${index + 1} — регулярная рутина по проекту`,
    description: 'Описание регулярной задачи, достаточное для строки в карточке и поиска.',
    deadline: index % 3 === 0 ? '2026-08-15T18:00:00Z' : null,
    checklist_total: 0, checklist_completed: 0
  }));
}

async function mockApp(page: Page, taskCount: number) {
  const tasks = makeTasks(taskCount);
  await page.addInitScript((boardId) => {
    localStorage.setItem('tasks.globalBoardId', boardId);
    localStorage.setItem('tasks.viewState', JSON.stringify({ view: 'list', grouping: 'deadline', filters: { scope: 'all', project: '', assignee: '', status: '', priority: '', deadline: '', unassigned: false, search: '' }, scrollY: 0, kanbanStatus: 'todo' }));
  }, board.id);
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: "window.Telegram={WebApp:{initData:'perf',initDataUnsafe:{user:{id:1,first_name:'Яков'}},ready(){},expand(){}}};"
  }));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const payload = path === '/api/auth/telegram' ? { userId: 'user-1' }
      : path === '/api/boards' ? { boards: [board] }
      : path.endsWith('/collaboration') ? collaboration
      : path.endsWith('/projects') ? { projects }
      : path.endsWith('/members') ? { members }
      : path.endsWith('/publications') ? { schedules: [] }
      : path.endsWith('/recurrences') ? { recurrences: [] }
      : path.endsWith('/task-filters') ? { filters: { scope: 'all' } }
      : { tasks };
    await route.fulfill({ json: payload });
  });
}

const INSTRUMENT = `(function () {
  window.__events = [];
  window.__block = 0;
  new PerformanceObserver(function (list) {
    list.getEntries().forEach(function (entry) {
      if (entry.interactionId) window.__events.push(entry.duration);
    });
  }).observe({ type: 'event', durationThreshold: 16 });
  new PerformanceObserver(function (list) {
    list.getEntries().forEach(function (entry) { window.__block += entry.duration; });
  }).observe({ type: 'longtask' });
})();`;

async function measure(page: Page, surface: string, run: () => Promise<void>) {
  await page.evaluate(INSTRUMENT);
  await run();
  const result = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const events = (window as unknown as PerfWindow).__events;
    const sorted = [...events].sort((left, right) => left - right);
    return {
      events: events.length,
      p50: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null,
      max: sorted.length ? Math.round(sorted[sorted.length - 1]) : null,
      longtaskMs: Math.round((window as unknown as PerfWindow).__block)
    };
  });
  await appendFile(evidenceFile, `${JSON.stringify({ phase, surface, ...result })}\n`);
  console.log(`${phase} ${surface}: events=${result.events} p50=${result.p50}ms max=${result.max}ms longtask=${result.longtaskMs}ms`);
  expect(result.events).toBeGreaterThan(10);
}

async function typeCyrillic(page: Page, lines: number) {
  for (let index = 0; index < lines; index += 1) {
    await page.keyboard.type('йцукен', { delay: 25 });
    await page.keyboard.press('Backspace');
  }
}

test.setTimeout(180_000);

for (const queue of [50, 600]) {
  test(`create title input latency, queue=${queue}`, async ({ page }) => {
    await mkdir(evidenceDir, { recursive: true });
    await mockApp(page, queue);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('button', { name: 'Создать задачу' }).click();
    await expect(page.getByRole('heading', { name: 'Новая задача' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Что нужно сделать?' }).click();
    await measure(page, `create-title queue=${queue}`, () => typeCyrillic(page, lines));
  });

  test(`details title input latency, queue=${queue}`, async ({ page }) => {
    await mkdir(evidenceDir, { recursive: true });
    await mockApp(page, queue);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('button', { name: /Задача номер 1 —/ }).first().click();
    await expect(page.getByRole('heading', { name: 'Детали задачи' })).toBeAttached();
    const title = page.getByRole('textbox', { name: 'Название задачи' });
    await title.click();
    await title.press('End');
    await measure(page, `details-title queue=${queue}`, () => typeCyrillic(page, lines));
  });

  test(`comment input latency, queue=${queue}`, async ({ page }) => {
    await mkdir(evidenceDir, { recursive: true });
    await mockApp(page, queue);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('button', { name: /Задача номер 1 —/ }).first().click();
    await expect(page.getByRole('heading', { name: 'Детали задачи' })).toBeAttached();
    await page.getByRole('textbox', { name: 'Комментарий' }).click();
    await measure(page, `comment queue=${queue}`, () => typeCyrillic(page, lines));
  });
}
