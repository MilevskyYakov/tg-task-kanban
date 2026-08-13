import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, createTask, redeemBoardLink } from '../src/db.js';
import { queueDuePublications, renderPublication, splitTelegram, updateSchedule } from '../src/publications.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');

test('publications honor timezone, deduplicate runs, group tasks and keep deep links valid', async () => {
  const db = createDatabase(url!);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const boardId = randomUUID();
  const user = await db.query<{id: string}>("INSERT INTO users (telegram_id, first_name) VALUES ($1, 'Иван') RETURNING id", [stamp]);
  await db.query("INSERT INTO boards (id, type, name, telegram_chat_id, status) VALUES ($1, 'chat', 'Команда <A>', $2, 'active')", [boardId, -stamp]);
  await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'admin')", [boardId, user.rows[0].id]);
  await db.query(`INSERT INTO publication_schedules (board_id, kind, weekdays, local_time) VALUES
    ($1, 'daily', ARRAY[1]::smallint[], '11:00'), ($1, 'weekly', ARRAY[1]::smallint[], '10:30')`, [boardId]);
  await createTask(db, user.rows[0].id, boardId, { title: 'Сверить <план>', assigneeUserId: user.rows[0].id, priority: 'urgent', deadline: '2026-08-09T00:00:00Z' });
  await updateSchedule(db, boardId, 'daily', { enabled: true, weekdays: [1], local_time: '11:00', timezone: 'Europe/Moscow', included_statuses: ['todo', 'in_progress', 'waiting'] });

  const now = new Date('2026-08-10T08:00:00Z');
  await queueDuePublications(db, now);
  await queueDuePublications(db, now);
  const runs = await db.query('SELECT * FROM publication_runs WHERE board_id = $1', [boardId]);
  assert.equal(runs.rowCount, 1, 'same local publication is queued once');
  await db.query('DELETE FROM publication_runs WHERE board_id = $1', [boardId]);
  await queueDuePublications(db, new Date('2026-08-10T08:07:00Z'));
  assert.equal((await db.query('SELECT 1 FROM publication_runs WHERE board_id = $1', [boardId])).rowCount, 1, 'restart after scheduled minute catches up once');

  const messages = await renderPublication(db, boardId, 'daily', ['todo'], 'test_bot', 'Europe/Moscow', now);
  assert.match(messages.join(''), /Иван/);
  assert.match(messages.join(''), /Команда &lt;A&gt;/);
  assert.match(messages.join(''), /Сверить &lt;план&gt;/);
  assert.match(messages.join(''), /ПРОСРОЧЕНО/);
  assert.ok(messages.every((message) => message.length <= 4096));
  const token = messages.join('').match(/startapp=(pub_[^_]+)_/)?.[1];
  assert.ok(token);
  assert.equal((await redeemBoardLink(db, user.rows[0].id, `${token}_${randomUUID()}`))?.id, boardId);

  assert.deepEqual(splitTelegram(['one', 'two', 'three'], 8), ['one\n\ntwo', 'three']);
  await db.query("UPDATE boards SET status = 'frozen' WHERE id = $1", [boardId]);
  await db.query('DELETE FROM publication_runs WHERE board_id = $1', [boardId]);
  await queueDuePublications(db, now);
  assert.equal((await db.query('SELECT 1 FROM publication_runs WHERE board_id = $1', [boardId])).rowCount, 0);

  await db.query('DELETE FROM boards WHERE id = $1', [boardId]);
  await db.query('DELETE FROM users WHERE id = $1', [user.rows[0].id]);
  await db.end();
});
