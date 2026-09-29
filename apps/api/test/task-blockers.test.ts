import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createDatabase, createTask, login, pendingNotificationForTask, setTaskArchived, taskCollaboration, taskForBoard, tasksForBoard, updateTask } from '../src/db.js';
import { taskInput } from '../src/task-input.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');

test('partial blocker validation defers the effective group but keeps boundary validation', () => {
  for (const input of [{ waitReason: 'New reason' }, { waitCheckAt: null }, { status: 'waiting' as const }]) {
    assert.deepEqual(taskInput(input, true, { deferBlockerValidation: true }), input);
  }
  for (const input of [{ status: 'todo' as const, waitReason: 'Wrong status' }, { waitCheckAt: '2030-02-30T00:00:00Z' },
    { blockerTaskId: 'not-a-uuid' }, { waitReason: 'x'.repeat(1001) }]) assert.equal(typeof taskInput(input, true, { deferBlockerValidation: true }), 'string');
  assert.equal(typeof taskInput({ title: 'Missing reason', status: 'waiting' }), 'string');
  assert.equal(typeof taskInput({ status: 'waiting' }, true), 'string', 'MCP keeps full blocker validation');
});

test('REST partial blocker edits validate locked state and preserve untouched values', async () => {
  const db = createDatabase(url!);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const config: Config = { botToken: 'test', databaseUrl: url!, sessionSecret: 'isolated-partial-blocker-secret', initDataMaxAgeSeconds: 60,
    sessionMaxAgeSeconds: 3600, host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-partial-blocker-webhook', publicUrl: 'https://example.test', botUsername: 'test_bot' };
  const owner = await login(db, { id: stamp, first_name: 'Partial owner' }, 3600, config.sessionSecret);
  const other = await login(db, { id: stamp + 1, first_name: 'Partial outsider' }, 3600, config.sessionSecret);
  const boardId = (await db.query('SELECT id FROM boards WHERE owner_user_id=$1', [owner.userId])).rows[0].id;
  const otherBoardId = (await db.query('SELECT id FROM boards WHERE owner_user_id=$1', [other.userId])).rows[0].id;
  const app = buildApp(config, db);
  try {
    const exact = '2030-01-01T12:34:56.789Z';
    const target = await createTask(db, owner.userId, boardId, { title: 'Partial target', status: 'waiting', waitReason: 'Vendor', waitCheckAt: exact,
      deadlineDate: '2030-02-01', deadlineTimezone: 'Asia/Kathmandu', issueUrl: 'https://github.com/o/r/issues/9' });
    const blocker = await createTask(db, owner.userId, boardId, { title: 'Blocker one' });
    const nextBlocker = await createTask(db, owner.userId, boardId, { title: 'Blocker two' });
    const foreign = await createTask(db, other.userId, otherBoardId, { title: 'Foreign blocker' });
    const patch = (payload: object, id = target.id, person = owner) => app.inject({ method: 'PATCH', url: `/api/boards/${boardId}/tasks/${id}`, cookies: { session: person.token }, payload });
    const read = () => taskForBoard(db, owner.userId, boardId, target.id);
    for (const payload of [{ title: 'Renamed' }, { waitReason: 'New vendor' }, { status: 'waiting' }]) {
      assert.equal((await patch(payload)).statusCode, 200);
      const stored = await read();
      assert.equal(stored.wait_check_at.toISOString(), exact);
      assert.equal(stored.deadline_date, '2030-02-01');
      assert.equal(stored.deadline_timezone, 'Asia/Kathmandu');
      assert.equal(stored.issue_url, 'https://github.com/o/r/issues/9');
    }
    assert.equal((await read()).wait_reason, 'New vendor');
    const before = await read();
    for (const payload of [{ blockerTaskId: blocker.id }, { waitReason: '' }, { waitCheckAt: 'bad' }]) {
      assert.notEqual((await patch(payload)).statusCode, 200, JSON.stringify(payload));
      assert.equal((await read()).version, before.version, 'invalid group writes nothing');
    }
    assert.equal((await patch({ blockerTaskId: blocker.id, waitReason: null })).statusCode, 200);
    assert.equal((await patch({ blockerTaskId: nextBlocker.id })).statusCode, 200);
    assert.equal((await read()).blocked_by_task_id, nextBlocker.id);
    assert.equal((await read()).wait_check_at.toISOString(), exact);
    for (const id of [target.id, foreign.id]) assert.equal((await patch({ blockerTaskId: id })).statusCode, 409);
    assert.equal((await patch({ status: 'waiting', blockerTaskId: target.id }, nextBlocker.id)).statusCode, 409, 'cycle rejected');
    await setTaskArchived(db, owner.userId, boardId, blocker.id, true);
    assert.equal((await patch({ blockerTaskId: blocker.id })).statusCode, 409);
    await setTaskArchived(db, owner.userId, boardId, blocker.id, false);
    await updateTask(db, owner.userId, boardId, blocker.id, { status: 'done' });
    assert.equal((await patch({ blockerTaskId: blocker.id })).statusCode, 409);
    assert.equal((await patch({ blockerTaskId: null, waitReason: 'External again' })).statusCode, 200);
    assert.equal((await patch({ waitCheckAt: '2030-03-01T10:11:12.123Z' })).statusCode, 200);
    assert.equal((await read()).wait_check_at.toISOString(), '2030-03-01T10:11:12.123Z');
    assert.equal((await patch({ waitCheckAt: null })).statusCode, 200);
    assert.equal((await read()).wait_check_at, null);
    assert.equal((await patch({ status: 'in_progress' })).statusCode, 200);
    assert.equal((await read()).wait_reason, null);
    assert.equal((await read()).blocked_by_task_id, null);
    for (const payload of [{ waitReason: 'No waiting status' }, { waitCheckAt: exact }, { status: 'waiting' }]) assert.notEqual((await patch(payload)).statusCode, 200);
    assert.equal((await patch({ status: 'waiting', waitReason: 'Valid entry', expectedVersion: before.version })).statusCode, 409);
    assert.equal((await patch({ status: 'waiting', waitReason: 'Valid entry' })).statusCode, 200);
    assert.equal((await patch({ waitReason: 'Outsider' }, target.id, other)).statusCode, 403);
    for (const status of ['frozen', 'archived']) {
      await db.query('UPDATE boards SET status=$2 WHERE id=$1', [boardId, status]);
      assert.equal((await patch({ waitReason: 'Read-only' })).statusCode, 403);
    }
    await db.query("UPDATE boards SET status='active' WHERE id=$1", [boardId]);
    await setTaskArchived(db, owner.userId, boardId, target.id, true);
    assert.equal((await patch({ waitReason: 'Archived task' })).statusCode, 403);
  } finally {
    await app.close();
    await db.query('DELETE FROM boards WHERE owner_user_id=ANY($1)', [[owner.userId, other.userId]]);
    await db.query('DELETE FROM users WHERE id=ANY($1)', [[owner.userId, other.userId]]);
    await db.end();
  }
});

test('structured task blockers stay board-scoped and unblock atomically', async () => {
  const db = createDatabase(url!);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const users = await Promise.all(['Blocker', 'Dependent'].map(async (name, index) =>
    (await db.query<{id: string}>('INSERT INTO users (telegram_id, first_name) VALUES ($1, $2) RETURNING id', [stamp + index, name])).rows[0].id));
  const boardId = randomUUID();
  const otherBoardId = randomUUID();
  await db.query("INSERT INTO boards (id, type, name, telegram_chat_id, status) VALUES ($1, 'chat', 'Team', $2, 'active'), ($3, 'chat', 'Other', $4, 'active')", [boardId, -stamp, otherBoardId, -stamp - 1]);
  for (const userId of users) await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'member')", [boardId, userId]);
  await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'owner')", [otherBoardId, users[0]]);

  const blocker = await createTask(db, users[0], boardId, { title: 'Approve', assigneeUserId: users[0] });
  const dependent = await createTask(db, users[1], boardId, { title: 'Ship', assigneeUserId: users[1] });
  const external = await createTask(db, users[1], boardId, { title: 'Vendor', assigneeUserId: users[1] });
  const otherBoardTask = await createTask(db, users[0], otherBoardId, { title: 'Other board' });
  assert.ok(blocker && dependent && external && otherBoardTask);

  const token = randomBytes(24).toString('base64url');
  const sessionSecret = 'test-session-secret-with-at-least-32-characters';
  const hash = createHash('sha256').update(`${sessionSecret}:${token}`).digest('hex');
  await db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [hash, users[1]]);
  const config: Config = { botToken: 'test', databaseUrl: url!, sessionSecret, initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 60,
    host: '127.0.0.1', port: 2240, production: false, webhookSecret: 'test-webhook-secret-with-at-least-32-characters', publicUrl: 'https://example.test', botUsername: 'test_bot' };
  const app = buildApp(config, db);
  const selfReference = await app.inject({ method: 'PATCH', url: `/api/boards/${boardId}/tasks/${dependent.id}`,
    headers: { cookie: `session=${token}` }, payload: { status: 'waiting', blockerTaskId: dependent.id } });
  assert.equal(selfReference.statusCode, 409);
  assert.match(selfReference.json().error, /itself/);
  await app.close();

  await assert.rejects(updateTask(db, users[1], boardId, dependent.id, { status: 'waiting', blockerTaskId: otherBoardTask.id }), /same board/);
  assert.equal((await updateTask(db, users[1], boardId, dependent.id, { status: 'waiting', blockerTaskId: blocker.id, waitCheckAt: '2030-01-01T00:00:00Z' }))?.blocked_by_task_id, blocker.id);
  await assert.rejects(updateTask(db, users[0], boardId, blocker.id, { status: 'waiting', blockerTaskId: dependent.id }), /cycle/);

  assert.equal(await setTaskArchived(db, users[0], boardId, blocker.id, true), true);
  assert.equal((await tasksForBoard(db, users[1], boardId)).find((task) => task.id === dependent.id)?.blocked_by_task_id, blocker.id, 'archive preserves dependency');
  assert.equal((await updateTask(db, users[1], boardId, dependent.id, { title: 'Ship safely' }))?.status, 'waiting', 'archived blocker does not freeze dependent edits');
  assert.equal(await setTaskArchived(db, users[0], boardId, blocker.id, false), true);

  assert.equal((await updateTask(db, users[1], boardId, external.id, { status: 'waiting', waitReason: 'Vendor response' }))?.wait_reason, 'Vendor response');
  const completed = await updateTask(db, users[0], boardId, blocker.id, { status: 'done' });
  assert.deepEqual(completed?.unblockedTaskIds, [dependent.id]);
  const tasks = await tasksForBoard(db, users[1], boardId);
  assert.equal(tasks.find((task) => task.id === dependent.id)?.status, 'todo');
  assert.equal(tasks.find((task) => task.id === external.id)?.status, 'waiting', 'external blocker remains until manual removal');
  assert.equal((await taskCollaboration(db, users[1], boardId, dependent.id))?.timeline.at(-1)?.action, 'unblocked');

  const notificationId = await pendingNotificationForTask(db, dependent.id, 'unblocked');
  assert.ok(notificationId);
  await updateTask(db, users[0], boardId, blocker.id, { status: 'done' });
  assert.equal((await db.query("SELECT count(*) FROM task_assignment_notifications WHERE task_id = $1 AND kind = 'unblocked'", [dependent.id])).rows[0].count, '1');
  assert.equal((await updateTask(db, users[1], boardId, external.id, { status: 'todo' }))?.status, 'todo', 'external blocker is removed manually');

  await db.query('DELETE FROM boards WHERE id = ANY($1)', [[boardId, otherBoardId]]);
  await db.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  await db.end();
});
