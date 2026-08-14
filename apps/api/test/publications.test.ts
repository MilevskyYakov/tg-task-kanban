import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, createTask, redeemBoardLink, updateTask } from '../src/db.js';
import { deliverPendingPublications, queueDuePublications, renderPublication, splitTelegram, updateSchedule } from '../src/publications.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');

test('publications honor timezone, deduplicate runs, group tasks and keep deep links valid', async () => {
  const db = createDatabase(url!);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const boardId = randomUUID();
  const user = await db.query<{id: string}>("INSERT INTO users (telegram_id, first_name) VALUES ($1, 'Иван') RETURNING id", [stamp]);
  const outsider = await db.query<{id: string}>("INSERT INTO users (telegram_id, first_name) VALUES ($1, 'Чужой') RETURNING id", [stamp + 1]);
  await db.query("INSERT INTO boards (id, type, name, telegram_chat_id, status) VALUES ($1, 'chat', 'Команда <A>', $2, 'active')", [boardId, -stamp]);
  await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'admin')", [boardId, user.rows[0].id]);
  await db.query(`INSERT INTO publication_schedules (board_id, kind, weekdays, local_time) VALUES
    ($1, 'daily', ARRAY[1]::smallint[], '11:00'), ($1, 'weekly', ARRAY[1]::smallint[], '10:30')`, [boardId]);
  const task = await createTask(db, user.rows[0].id, boardId, { title: 'Сверить <план>', assigneeUserId: user.rows[0].id, priority: 'urgent', deadline: '2026-08-09T00:00:00Z' });
  await updateTask(db, user.rows[0].id, boardId, task.id, { status: 'waiting', waitReason: 'Ответ клиента' });
  await updateSchedule(db, boardId, 'daily', { enabled: true, weekdays: [1], local_time: '11:00', timezone: 'Europe/Moscow', included_statuses: ['todo', 'in_progress', 'waiting'] });

  const now = new Date('2026-08-10T08:00:00Z');
  await queueDuePublications(db, now);
  await queueDuePublications(db, now);
  const runs = await db.query('SELECT * FROM publication_runs WHERE board_id = $1', [boardId]);
  assert.equal(runs.rowCount, 1, 'same local publication is queued once');
  await db.query('DELETE FROM publication_runs WHERE board_id = $1', [boardId]);
  await queueDuePublications(db, new Date('2026-08-10T08:07:00Z'));
  assert.equal((await db.query('SELECT 1 FROM publication_runs WHERE board_id = $1', [boardId])).rowCount, 1, 'restart after scheduled minute catches up once');

  const linksBefore = await db.query('SELECT count(*) FROM board_links WHERE board_id = $1', [boardId]);
  const messages = await renderPublication(db, boardId, 'daily', ['waiting'], 'test_bot', 'Europe/Moscow', now);
  assert.match(messages.join(''), /Иван/);
  assert.match(messages.join(''), /Команда &lt;A&gt;/);
  assert.match(messages.join(''), /Сверить &lt;план&gt;/);
  assert.match(messages.join(''), /ПРОСРОЧЕНО/);
  assert.match(messages.join(''), /Блокер/);
  assert.doesNotMatch(messages.join(''), /Жду/);
  assert.equal((await db.query('SELECT status FROM tasks WHERE id = $1', [task.id])).rows[0].status, 'waiting');
  assert.ok(messages.every((message) => message.length <= 4096));
  const taskLink = messages.join('').match(/startapp=(task_[^"]+)/)?.[1];
  assert.ok(taskLink);
  assert.equal((await redeemBoardLink(db, user.rows[0].id, taskLink))?.id, boardId);
  assert.equal(await redeemBoardLink(db, outsider.rows[0].id, taskLink), null, 'forwarded report does not grant board access');
  assert.equal((await db.query('SELECT count(*) FROM board_links WHERE board_id = $1', [boardId])).rows[0].count, linksBefore.rows[0].count, 'render creates no invitation tokens');

  assert.deepEqual(splitTelegram(['one', 'two', 'three'], 8), ['one\n\ntwo', 'three']);
  await db.query("UPDATE boards SET status = 'frozen' WHERE id = $1", [boardId]);
  await db.query('DELETE FROM publication_runs WHERE board_id = $1', [boardId]);
  await queueDuePublications(db, now);
  assert.equal((await db.query('SELECT 1 FROM publication_runs WHERE board_id = $1', [boardId])).rowCount, 0);

  await db.query('DELETE FROM boards WHERE id = $1', [boardId]);
  await db.query('DELETE FROM users WHERE id = ANY($1)', [[user.rows[0].id, outsider.rows[0].id]]);
  await db.end();
});

test('delivery resumes after last sent part and keeps an active lease', async () => {
  const db = createDatabase(url!);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const boardId = randomUUID();
  const user = await db.query<{id: string}>("INSERT INTO users (telegram_id, first_name) VALUES ($1, 'Иван') RETURNING id", [stamp]);
  await db.query("INSERT INTO boards (id, type, name, telegram_chat_id, status) VALUES ($1, 'chat', 'Команда', $2, 'active')", [boardId, -stamp]);
  await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'admin')", [boardId, user.rows[0].id]);
  await db.query("INSERT INTO publication_schedules (board_id, kind, enabled, weekdays, local_time) VALUES ($1, 'daily', true, ARRAY[1]::smallint[], '11:00')", [boardId]);
  for (let index = 0; index < 30; index++) await createTask(db, user.rows[0].id, boardId, { title: `${index} ${'длинная задача '.repeat(12)}` });
  const now = new Date('2026-08-10T08:00:00Z');
  await queueDuePublications(db, now);
  await db.query('UPDATE publication_runs SET next_attempt_at = $2 WHERE board_id = $1', [boardId, now.toISOString()]);

  const sent: string[] = [];
  const originalFetch = globalThis.fetch;
  let failSecond = true;
  globalThis.fetch = (async (_url, init) => {
    const text = (JSON.parse(String(init?.body)) as {text: string}).text;
    sent.push(text);
    if (failSecond && sent.length === 2) return new Response(JSON.stringify({ ok: false, description: 'temporary' }), { status: 500 });
    return new Response(JSON.stringify({ ok: true, result: true }));
  }) as typeof fetch;
  try {
    await deliverPendingPublications(db, 'token', 'test_bot', now);
    const failed = await db.query<{status: string; sent_parts: number; next_attempt_at: Date; last_error: string}>('SELECT status, sent_parts, next_attempt_at, last_error FROM publication_runs WHERE board_id = $1', [boardId]);
    assert.equal(failed.rows[0].status, 'pending');
    if (failed.rows[0].sent_parts !== 1) assert.fail(`sent_parts=${failed.rows[0].sent_parts}; sent=${sent.length}; error=${failed.rows[0].last_error}`);
    assert.ok(failed.rows[0].next_attempt_at > now, 'claim sets future lease/retry time');
    failSecond = false;
    await db.query('UPDATE publication_runs SET next_attempt_at = $2 WHERE board_id = $1', [boardId, new Date(now.getTime() + 61_000).toISOString()]);
    await deliverPendingPublications(db, 'token', 'test_bot', new Date(now.getTime() + 61_000));
    assert.equal(sent.filter((text) => text === sent[0]).length, 1, 'retry does not resend completed part');
    assert.equal((await db.query('SELECT status FROM publication_runs WHERE board_id = $1', [boardId])).rows[0].status, 'sent');
  } finally { globalThis.fetch = originalFetch; }

  await db.query('DELETE FROM boards WHERE id = $1', [boardId]);
  await db.query('DELETE FROM users WHERE id = $1', [user.rows[0].id]);
  await db.end();
});
