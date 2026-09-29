import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, createTask, login, redeemBoardLink, updateTask } from '../src/db.js';
import { deliverPendingPublications, queueDuePublications, renderPublication, updateSchedule } from '../src/publications.js';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');

test('publication PUT/GET persists toggles, enforces access and stops new scheduler runs only', async (t) => {
  const db = createDatabase(url!);
  const config: Config = { botToken: 'test', databaseUrl: url!, sessionSecret: 'isolated-publications-secret', initDataMaxAgeSeconds: 60,
    sessionMaxAgeSeconds: 3600, host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-publications-webhook',
    publicUrl: 'https://example.test', botUsername: 'test_bot' };
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const people = await Promise.all(['Admin', 'Member', 'Outsider'].map((first_name, index) => login(db, { id: stamp + index, first_name }, 3600, config.sessionSecret)));
  const [admin, member, outsider] = people;
  const boardId = randomUUID();
  const otherBoardId = randomUUID();
  const app = buildApp(config, db);
  let adminAllowed = true;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    assert.ok(String(input).endsWith('/getChatMember'), 'no live delivery');
    return Response.json({ ok: true, result: { status: adminAllowed && String(JSON.parse(String(options?.body)).user_id) === String(stamp) ? 'administrator' : 'member' } });
  });
  const call = (person: typeof admin | undefined, method: 'GET' | 'PUT' | 'POST', path: string, payload?: object) => app.inject({ method, url: path, cookies: person ? { session: person.token } : {}, payload });
  const path = `/api/boards/${boardId}/publications`;
  const input = { enabled: true, weekdays: [1], local_time: '09:00', timezone: 'UTC', included_statuses: ['todo'] };
  const readback = async () => (await call(admin, 'GET', path)).json().schedules;
  try {
    for (const id of [boardId, otherBoardId]) {
      await db.query("INSERT INTO boards (id,type,name,telegram_chat_id,status) VALUES ($1,'chat','Publication test',$2,'active')", [id, id === boardId ? -stamp : -stamp - 1]);
      await db.query("INSERT INTO publication_schedules (board_id,kind,enabled,weekdays,local_time,timezone) VALUES ($1,'daily',true,ARRAY[1]::smallint[],'09:00','UTC'),($1,'weekly',true,ARRAY[1]::smallint[],'09:00','UTC')", [id]);
    }
    for (const person of [admin, member]) await db.query("INSERT INTO memberships (board_id,user_id,role) VALUES ($1,$2,$3)", [boardId, person.userId, person === admin ? 'admin' : 'member']);
    await queueDuePublications(db, new Date('2026-08-10T09:00:00Z'));
    const before = (await db.query('SELECT id,status,sent_parts FROM publication_runs WHERE board_id=$1 ORDER BY kind', [boardId])).rows;
    assert.equal(before.length, 2);
    for (const kind of ['daily', 'weekly']) {
      const response = await call(admin, 'PUT', `${path}/${kind}`, { ...input, enabled: false });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().enabled, false);
    }
    assert.ok((await readback()).every((schedule: { enabled: boolean }) => !schedule.enabled));
    await queueDuePublications(db, new Date('2026-08-17T09:00:00Z'));
    assert.deepEqual((await db.query('SELECT id,status,sent_parts FROM publication_runs WHERE board_id=$1 ORDER BY kind', [boardId])).rows, before, 'disabled schedules add no runs and leave existing runs untouched');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM publication_runs WHERE board_id=$1', [otherBoardId])).rows[0].count, 4, 'other board schedules remain enabled');
    for (const kind of ['daily', 'weekly']) assert.equal((await call(admin, 'PUT', `${path}/${kind}`, input)).statusCode, 200);
    await queueDuePublications(db, new Date('2026-08-17T09:00:00Z'));
    await queueDuePublications(db, new Date('2026-08-17T09:00:00Z'));
    assert.equal((await db.query('SELECT count(*)::int AS count FROM publication_runs WHERE board_id=$1', [boardId])).rows[0].count, 4, 'reenabled schedules resume, without duplicate runs');
    for (const invalid of [{ enabled: 'false' }, { weekdays: [] }, { weekdays: [0] }, { local_time: '24:00' }, { timezone: 'Invalid/Zone' }, { included_statuses: ['invalid'] }]) {
      assert.equal((await call(admin, 'PUT', `${path}/daily`, { ...input, enabled: false, ...invalid })).statusCode, 400);
    }
    assert.equal((await call(undefined, 'PUT', `${path}/daily`, input)).statusCode, 401);
    assert.equal((await call(member, 'PUT', `${path}/daily`, input)).statusCode, 403);
    assert.equal((await call(outsider, 'PUT', `${path}/daily`, input)).statusCode, 404);
    assert.equal((await call(outsider, 'GET', path)).statusCode, 404);
    assert.equal((await call(admin, 'PUT', `/api/boards/${otherBoardId}/publications/daily`, input)).statusCode, 404);
    assert.equal((await call(admin, 'POST', `${path}/daily/preview`, { ...input, enabled: false })).statusCode, 200);
    adminAllowed = false;
    assert.equal((await call(admin, 'PUT', `${path}/daily`, { ...input, enabled: false })).statusCode, 403, 'current Telegram rights required');
    adminAllowed = true;
    for (const status of ['frozen', 'archived', 'draft']) {
      await db.query('UPDATE boards SET status=$2 WHERE id=$1', [boardId, status]);
      assert.equal((await call(admin, 'PUT', `${path}/daily`, { ...input, enabled: false })).statusCode, 403, `${status} board is read-only`);
      assert.equal(await updateSchedule(db, boardId, 'daily', { ...input, enabled: false }), null, 'DB write also checks board state');
    }
    assert.ok((await readback()).every((schedule: { enabled: boolean }) => schedule.enabled), 'rejected writes do not change schedules');
  } finally {
    await app.close();
    await db.query('DELETE FROM boards WHERE id=ANY($1) OR owner_user_id=ANY($2)', [[boardId, otherBoardId], people.map((person) => person.userId)]);
    await db.query('DELETE FROM users WHERE id=ANY($1)', [people.map((person) => person.userId)]);
    await db.end();
  }
});

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
  assert.match(messages.join(''), /🔴/);
  assert.match(messages.join(''), /Блокер/);
  assert.doesNotMatch(messages.join(''), /Жду/);
  assert.equal((await db.query('SELECT status FROM tasks WHERE id = $1', [task.id])).rows[0].status, 'waiting');
  assert.ok(messages.every((message) => message.length <= 32_768));
  const taskLink = messages.join('').match(/startapp=(task_[^"]+)/)?.[1];
  assert.ok(taskLink);
  assert.equal((await redeemBoardLink(db, user.rows[0].id, taskLink))?.id, boardId);
  assert.equal(await redeemBoardLink(db, outsider.rows[0].id, taskLink), null, 'forwarded report does not grant board access');
  assert.equal((await db.query('SELECT count(*) FROM board_links WHERE board_id = $1', [boardId])).rows[0].count, linksBefore.rows[0].count, 'render creates no invitation tokens');
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
  let failFirst = true;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {text?: string; rich_message?: {html?: string}};
    sent.push(body.text ?? body.rich_message?.html ?? '');
    if (failFirst && sent.length === 1) return new Response(JSON.stringify({ ok: false, description: 'temporary' }), { status: 500 });
    return new Response(JSON.stringify({ ok: true, result: true }));
  }) as typeof fetch;
  try {
    await deliverPendingPublications(db, 'token', 'test_bot', now);
    const failed = await db.query<{status: string; sent_parts: number; next_attempt_at: Date; last_error: string}>('SELECT status, sent_parts, next_attempt_at, last_error FROM publication_runs WHERE board_id = $1', [boardId]);
    assert.equal(failed.rows[0].status, 'pending');
    assert.equal(failed.rows[0].sent_parts, 0, `sent_parts=${failed.rows[0].sent_parts}; error=${failed.rows[0].last_error}`);
    assert.ok(failed.rows[0].next_attempt_at > now, 'claim sets future lease/retry time');
    failFirst = false;
    await db.query('UPDATE publication_runs SET next_attempt_at = $2 WHERE board_id = $1', [boardId, new Date(now.getTime() + 61_000).toISOString()]);
    await deliverPendingPublications(db, 'token', 'test_bot', new Date(now.getTime() + 61_000));
    assert.equal(sent.length, 2, 'retry resends the single rich message once');
    assert.match(sent[0], /<h1>ПЛАН ДНЯ/);
    assert.equal((await db.query('SELECT status FROM publication_runs WHERE board_id = $1', [boardId])).rows[0].status, 'sent');
  } finally { globalThis.fetch = originalFetch; }

  await db.query('DELETE FROM boards WHERE id = $1', [boardId]);
  await db.query('DELETE FROM users WHERE id = $1', [user.rows[0].id]);
  await db.end();
});
