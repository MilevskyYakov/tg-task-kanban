import { expect, test, type Page } from '@playwright/test';

// Regression check for issue #123: sequential keyboard typing into the create
// title, details title, checklist item and comment must land every character
// (no swallowed or batched input) and keep cursor position and focus.

const board = { id: 'board-1', name: 'Task Kanban', type: 'personal', status: 'active', role: 'owner' };
const projects = [{ id: 'project-1', board_id: board.id, name: 'Task Kanban' }];
const members = [{ id: 'user-2', first_name: 'Данил' }, { id: 'user-1', first_name: 'Яков' }];

const DETAIL_TASK = {
  id: 'task-1', board_id: board.id, board_name: board.name, title: 'Подготовить UX-спецификацию',
  description: 'Зафиксировать структуру экранов и состояний.', project_id: 'project-1', project_name: 'Task Kanban',
  assignee_user_id: 'user-1', assignee_name: 'Яков', creator_user_id: 'user-1', status: 'in_progress', priority: 'normal',
  deadline: '2026-08-15T18:00:00Z', overdue: false, wait_check_due: false, checklist_total: 1, checklist_completed: 0
};

const collaboration = {
  checklist: [{ id: 'check-1', text: 'Существующий пункт', position: 0 }] as { id: string; text: string; position: number }[],
  comments: [] as { id: string; body: string; author_name: string; created_at: string }[],
  attachments: [] as unknown[],
  timeline: [] as unknown[]
};

async function mockApp(page: Page) {
  const tasks = Array.from({ length: 60 }, (_, index) => ({
    ...DETAIL_TASK, id: `task-${index + 1}`, title: `Задача номер ${index + 1} — регулярная рутина`
  }));
  await page.addInitScript((boardId) => {
    localStorage.setItem('tasks.globalBoardId', boardId);
    localStorage.setItem('tasks.viewState', JSON.stringify({ view: 'list', grouping: 'deadline', filters: { scope: 'all', project: '', assignee: '', status: '', priority: '', deadline: '', unassigned: false, search: '' }, scrollY: 0, kanbanStatus: 'todo' }));
  }, board.id);
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: "window.Telegram={WebApp:{initData:'regression',initDataUnsafe:{user:{id:1,first_name:'Яков'}},ready(){},expand(){}}};"
  }));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST' && path.endsWith('/tasks')) {
      const input = route.request().postDataJSON();
      await route.fulfill({ json: { ...DETAIL_TASK, id: 'created-1', title: input.title, description: input.description ?? null, checklist_total: 0, checklist_completed: 0 } });
      return;
    }
    if (route.request().method() === 'PATCH' && path.includes('/tasks/')) {
      const input = route.request().postDataJSON();
      await route.fulfill({ json: { ...DETAIL_TASK, title: input.title } });
      return;
    }
    if (route.request().method() === 'POST' && path.endsWith('/checklist')) {
      const input = route.request().postDataJSON();
      collaboration.checklist = [...collaboration.checklist, { id: `check-${collaboration.checklist.length + 1}`, text: input.text, position: collaboration.checklist.length }];
      await route.fulfill({ json: collaboration });
      return;
    }
    if (route.request().method() === 'POST' && path.endsWith('/comments')) {
      const input = route.request().postDataJSON();
      collaboration.comments = [...collaboration.comments, { id: `comment-${collaboration.comments.length + 1}`, body: input.body, author_name: 'Яков', created_at: new Date().toISOString() }];
      await route.fulfill({ json: collaboration });
      return;
    }
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

test('create title typing lands every character with large queue', async ({ page }) => {
  await mockApp(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать задачу' }).click();
  const title = page.getByRole('textbox', { name: 'Что нужно сделать?' });
  await title.click();
  const phrase = 'Проверка набора 123 с кириллицей и emoji 🚀';
  await page.keyboard.type(phrase, { delay: 10 });
  await expect(title).toHaveValue(phrase);
  // Home/End move within a soft-wrapped visual line, not the whole field;
  // set the caret deterministically before typing at an edge.
  await title.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(0, 0));
  await page.keyboard.type('Срочно: ', { delay: 10 });
  await expect(title).toHaveValue(`Срочно: ${phrase}`);
});

test('details title, checklist and comment typing survive with large queue', async ({ page }) => {
  await mockApp(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /Задача номер 1 —/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Детали задачи' })).toBeAttached();
  const title = page.getByRole('textbox', { name: 'Название задачи' });
  await title.click();
  await title.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange((element as HTMLTextAreaElement).value.length, (element as HTMLTextAreaElement).value.length));
  await page.keyboard.type(' плюс правка в конце', { delay: 10 });
  await expect(title).toHaveValue('Задача номер 1 — регулярная рутина плюс правка в конце');
  const checklist = page.getByRole('textbox', { name: 'Новый пункт чек-листа' });
  await checklist.click();
  await page.keyboard.type('Новый пункт после правки', { delay: 10 });
  await expect(checklist).toHaveValue('Новый пункт после правки');
  const comment = page.getByRole('textbox', { name: 'Комментарий' });
  await comment.click();
  await page.keyboard.type('Комментарий после правки названия', { delay: 10 });
  await expect(comment).toHaveValue('Комментарий после правки названия');
});
