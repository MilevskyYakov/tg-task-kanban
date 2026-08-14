import assert from 'node:assert/strict';
import test from 'node:test';
import type { Database } from '../src/db.js';
import { publicationStatusDisplayName, renderPublication, startPublicationScheduler } from '../src/publications.js';

test('publication statuses use agreed product language', () => {
  assert.deepEqual(publicationStatusDisplayName, { todo: 'Новая', in_progress: 'В работе', waiting: 'Блокер', done: 'Готово' });
});

test('historical waiting rows render as blocker in publication summaries', async () => {
  const db = { query: async (sql: string) => sql.includes('SELECT name FROM boards')
    ? { rows: [{ name: 'Команда' }] }
    : { rows: [{ id: 'task', title: 'Ответ клиента', status: 'waiting', priority: 'normal', deadline: null, wait_check_at: null, project_name: null, assignee_name: null }] }
  } as unknown as Database;

  const publication = (await renderPublication(db, 'board', 'weekly', ['waiting'], 'bot', 'Europe/Moscow', new Date('2026-08-10T08:00:00Z'))).join('\n');
  assert.match(publication, /Блокер/);
  assert.doesNotMatch(publication, /Жду/);
});

test('publication scheduler reports tick failures', async () => {
  const error = new Error('database unavailable');
  const db = { query: async () => { throw error; } } as unknown as Database;
  await new Promise<void>((resolve) => {
    const stop = startPublicationScheduler(db, 'token', 'bot', (caught) => {
      assert.equal(caught, error);
      stop();
      resolve();
    });
  });
});