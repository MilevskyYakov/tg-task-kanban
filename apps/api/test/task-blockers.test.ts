import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createDatabase, createTask, pendingNotificationForTask, setTaskArchived, taskCollaboration, tasksForBoard, updateTask } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');

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
