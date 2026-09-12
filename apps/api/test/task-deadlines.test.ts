import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createDatabase, createTask, login, setTaskArchived, taskCollaboration, taskForBoard, tasksForAssignee, updateTask } from '../src/db.js';
import { renderPublication } from '../src/publications.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');

test('initial status, date-only deadlines and safe retries work through API and database', async () => {
  const db = createDatabase(url);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const config: Config = { botToken: 'test', databaseUrl: url, sessionSecret: 'isolated-test-secret-only', initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 60,
    host: '127.0.0.1', port: 2240, production: false, webhookSecret: 'isolated-webhook-only', publicUrl: 'https://example.test', botUsername: 'test_bot' };
  const owner = await login(db, { id: stamp, first_name: 'Test owner' }, 3600, config.sessionSecret);
  const other = await login(db, { id: stamp + 1, first_name: 'Test member' }, 3600, config.sessionSecret);
  const boardId = randomUUID();
  const otherBoardId = (await db.query("SELECT id FROM boards WHERE owner_user_id = $1", [other.userId])).rows[0].id;
  const app = buildApp(config, db);
  try {
    await db.query("INSERT INTO boards (id, type, name, telegram_chat_id, status) VALUES ($1, 'chat', 'Deadline tests', $2, 'active')", [boardId, -stamp]);
    for (const id of [owner.userId, other.userId]) await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'member')", [boardId, id]);
    const post = (payload: object, target = boardId) => app.inject({ method: 'POST', url: `/api/boards/${target}/tasks`, cookies: { session: owner.token }, payload });
    const patch = (id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/boards/${boardId}/tasks/${id}`, cookies: { session: owner.token }, payload });
    const count = async () => Number((await db.query('SELECT count(*) FROM tasks WHERE board_id = $1', [boardId])).rows[0].count);

    const noDateResponse = await post({ title: 'No deadline', deadline: null });
    assert.equal(noDateResponse.statusCode, 200);
    const noDate = noDateResponse.json();
    assert.equal(noDate.deadline, null);
    assert.equal(noDate.deadline_date, null);
    assert.equal((await taskForBoard(db, owner.userId, boardId, noDate.id)).overdue, false);

    for (const status of ['todo', 'in_progress', 'waiting', 'done']) {
      const result = await post({ title: `Initial ${status}`, status, ...(status === 'waiting' ? { waitReason: 'External approval' } : {}) });
      assert.equal(result.statusCode, 200, result.body);
      const task = result.json();
      assert.equal(task.status, status);
      assert.equal(Boolean(task.completed_at), status === 'done');
      const history = await taskCollaboration(db, owner.userId, boardId, task.id);
      assert.equal(history?.timeline[0].action, 'created');
      assert.equal(history?.timeline[0].after_data.status, status);
    }
    assert.equal((await post({ title: 'Own done', status: 'done', assigneeUserId: owner.userId })).statusCode, 200);
    const beforeDenied = await count();
    assert.equal((await post({ title: 'Other done', status: 'done', assigneeUserId: other.userId })).statusCode, 403);
    assert.equal((await post({ title: 'Outsider' }, otherBoardId)).statusCode, 404);
    assert.equal(await count(), beforeDenied);

    const datePayload = { title: 'All day', deadlineDate: '2026-03-08', deadlineTimezone: 'America/New_York', assigneeUserId: owner.userId, requestId: randomUUID() };
    const replies = await Promise.all(Array.from({ length: 5 }, () => post(datePayload)));
    assert.ok(replies.every((reply) => reply.statusCode === 200));
    assert.equal(new Set(replies.map((reply) => reply.json().id)).size, 1);
    const dateTask = replies[0].json();
    assert.equal(dateTask.deadline, null);
    assert.equal(dateTask.deadline_date, datePayload.deadlineDate);
    assert.equal((await post({ ...datePayload, title: 'Different input' })).statusCode, 409);
    assert.equal((await taskCollaboration(db, owner.userId, boardId, dateTask.id))?.timeline.length, 1);
    assert.equal((await tasksForAssignee(db, owner.userId)).find((task) => task.id === dateTask.id)?.deadline_date, datePayload.deadlineDate);
    assert.equal((await patch(dateTask.id, { title: 'Renamed only' })).statusCode, 200);
    assert.equal((await taskForBoard(db, owner.userId, boardId, dateTask.id)).deadline_date, datePayload.deadlineDate);

    for (const [date, zone, boundary] of [
      ['2026-03-08', 'America/New_York', '2026-03-09T04:00:00Z'],
      ['2026-11-01', 'America/New_York', '2026-11-02T05:00:00Z'],
      ['2026-08-14', 'Europe/Moscow', '2026-08-14T21:00:00Z'],
      ['2026-08-14', 'Pacific/Honolulu', '2026-08-15T10:00:00Z'],
      ['2026-08-14', 'Asia/Kathmandu', '2026-08-14T18:15:00Z']
    ]) {
      await updateTask(db, owner.userId, boardId, dateTask.id, { deadline: null, deadlineDate: date, deadlineTimezone: zone });
      for (const offset of [-1, 0]) {
        const now = new Date(Date.parse(boundary) + offset);
        const overdue = await db.query('SELECT task_deadline_overdue(status, deadline, deadline_date, deadline_timezone, $2) AS overdue FROM tasks WHERE id = $1', [dateTask.id, now]);
        assert.equal(overdue.rows[0].overdue, offset === 0, `${zone} ${now.toISOString()}`);
        const text = (await renderPublication(db, boardId, 'daily', ['todo'], 'test_bot', 'UTC', now)).join('\n');
        const line = text.split('\n').find((line) => line.includes(`task_${boardId}_${dateTask.id}`))!;
        assert.equal(line.includes('ПРОСРОЧЕНО'), offset === 0);
        assert.ok(line.includes(`${date} · весь день (${zone})`));
      }
    }
    const exact = '2026-11-01T06:30:47.123Z';
    assert.equal((await patch(dateTask.id, { deadline: exact })).statusCode, 200);
    let stored = await taskForBoard(db, owner.userId, boardId, dateTask.id);
    assert.equal(stored.deadline.toISOString(), exact);
    assert.equal(stored.deadline_date, null);
    await patch(dateTask.id, { title: 'Exact preserved' });
    stored = await taskForBoard(db, owner.userId, boardId, dateTask.id);
    assert.equal(stored.deadline.toISOString(), exact);
    assert.equal((await patch(dateTask.id, { deadline: null })).statusCode, 200);
    assert.equal((await taskForBoard(db, owner.userId, boardId, dateTask.id)).overdue, false);

    const invalid: object[] = [
      { status: '' }, { status: null }, { status: 'bogus' }, { title: 42 }, { deadline: '2026-02-30T00:00:00Z' }, { deadline: '' },
      { deadline: '2026-08-14' }, { deadline: 1 }, { deadlineDate: '2026-02-30', deadlineTimezone: 'UTC' },
      { deadlineDate: '2026-08-14' }, { deadlineTimezone: 'UTC' }, { deadlineDate: '2026-08-14', deadlineTimezone: 'Server/Guess' },
      { deadlineDate: '2026-08-14', deadlineTimezone: 'UTC', deadline: exact }, { waitReason: 1 }, { status: 'waiting' },
      { status: 'waiting', waitReason: '  ' }, { status: 'waiting', waitReason: 'Both', blockerTaskId: noDate.id }, { requestId: 'bad' }
    ];
    const beforeInvalid = await count();
    for (const input of invalid) assert.equal((await post({ title: 'Invalid', ...input })).statusCode, 400, JSON.stringify(input));
    assert.equal(await count(), beforeInvalid);

    const foreign = await createTask(db, other.userId, otherBoardId, { title: 'Foreign blocker' });
    assert.equal((await post({ title: 'Foreign blocked', status: 'waiting', blockerTaskId: foreign.id })).statusCode, 409);
    const blockedReply = await post({ title: 'Blocked at creation', status: 'waiting', blockerTaskId: noDate.id });
    assert.equal(blockedReply.statusCode, 200);
    const blocked = blockedReply.json();
    assert.equal((await taskForBoard(db, owner.userId, boardId, blocked.id)).blocker_title, noDate.title);
    await setTaskArchived(db, owner.userId, boardId, noDate.id, true);
    assert.equal((await post({ title: 'Archived blocker', status: 'waiting', blockerTaskId: noDate.id })).statusCode, 409);
    await setTaskArchived(db, owner.userId, boardId, noDate.id, false);
    await updateTask(db, owner.userId, boardId, noDate.id, { status: 'done' });
    assert.equal((await taskForBoard(db, owner.userId, boardId, blocked.id)).status, 'todo');
    assert.equal((await post({ title: 'Done blocker', status: 'waiting', blockerTaskId: noDate.id })).statusCode, 409);
  } finally {
    await app.close();
    await db.query('DELETE FROM boards WHERE id = $1 OR owner_user_id = ANY($2)', [boardId, [owner.userId, other.userId]]);
    await db.query('DELETE FROM users WHERE id = ANY($1)', [[owner.userId, other.userId]]);
    await db.end();
  }
});
