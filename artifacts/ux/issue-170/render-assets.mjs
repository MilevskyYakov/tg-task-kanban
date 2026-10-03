// Capture the real Mini App with synthetic data; no production API or Telegram access.
// Start local Vite on 4181, then run node artifacts/ux/issue-170/render-assets.mjs.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../../../apps/web/public/brand/', import.meta.url));
const board = { id: 'demo', name: 'Общие дела', type: 'chat', status: 'active', role: 'owner' };
const tasks = [
  { id: '1', title: 'Обсудить план проекта', project_name: 'Проект', assignee_name: 'Анна Иванова', priority: 'urgent', deadline: '2026-10-04T09:00:00Z' },
  { id: '2', title: 'Купить билеты', project_name: 'Поездка', assignee_name: 'Михаил Петров', deadline: '2026-10-04T12:00:00Z' },
  { id: '3', title: 'Выбрать цвет стен', project_name: 'Ремонт', assignee_name: 'Анна Иванова', deadline: '2026-10-05T09:00:00Z' },
  { id: '4', title: 'Собрать идеи', project_name: 'Проект', assignee_name: 'Михаил Петров' },
  { id: '5', title: 'Записаться на тренировку', project_name: 'Личное', assignee_name: 'Анна Иванова' }
].map((task) => ({ board_id: board.id, board_name: board.name, project_id: task.project_name, assignee_user_id: 'demo-user', creator_user_id: 'demo-user', status: 'todo', priority: 'normal', overdue: false, wait_check_due: false, ...task }));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 440, height: 862 }, deviceScaleFactor: 2, locale: 'ru-RU', timezoneId: 'UTC', reducedMotion: 'reduce' });
  await page.clock.setFixedTime(new Date('2026-10-03T09:41:00Z'));
  await page.addInitScript(() => {
    localStorage.setItem('tasks.viewState', JSON.stringify({ view: 'list', grouping: 'deadline', filters: { scope: 'mine', project: '', assignee: '', status: '', priority: '', deadline: '', unassigned: false, search: '' }, scrollY: 0, kanbanStatus: 'todo' }));
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.href === 'https://telegram.org/js/telegram-web-app.js') return route.fulfill({ contentType: 'application/javascript', body: "window.Telegram={WebApp:{initData:'landing-demo',initDataUnsafe:{user:{id:1,first_name:'Анна',last_name:'Иванова'}},ready(){},expand(){}}};" });
    if (url.origin !== 'http://127.0.0.1:4181') return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname;
    const json = path === '/api/auth/telegram' ? { userId: 'demo-user' }
      : path === '/api/boards' ? { boards: [board] }
      : path.endsWith('/task-filters') ? { filters: {} }
      : path.endsWith('/projects') ? { projects: [] }
      : path.endsWith('/members') ? { members: [] }
      : { tasks };
    return route.fulfill({ json });
  });
  await page.goto('http://127.0.0.1:4181/');
  await page.locator('.main-task-row').last().waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator('.main-task-row').count(), tasks.length);
  assert.doesNotMatch(await page.locator('body').innerText(), /Primex|kAIros|VPN|Task Kanban/i);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}landing-screen.png` });
  const cards = [ ['1', 'project'], ['2', 'shared'], ['5', 'personal'] ];
  const assets = [];
  for (const [id, name] of cards) {
    const task = tasks.find((task) => task.id === id);
    const card = page.locator('.main-task-row').filter({ hasText: task.title });
    // Hide only fixed navigation while capturing a complete task element, never crop text.
    await card.screenshot({ path: `${output}landing-card-${name}.png`, style: '.bottom-navigation { visibility: hidden !important; }' });
    assets.push({ file: `landing-card-${name}.png`, title: task.title, project: task.project_name, bounds: await card.boundingBox() });
  }
  await writeFile(new URL('./asset-capture.json', import.meta.url), JSON.stringify({ viewport: { width: 440, height: 862 }, deviceScaleFactor: 2, fixedTime: '2026-10-03T09:41:00Z', tasks, cards: assets }, null, 2) + '\n');
  console.log('Captured real app screen and three complete neutral task cards.');
} finally {
  await browser.close();
}
