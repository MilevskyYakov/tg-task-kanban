import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createDatabase, createProject, createRecurrence, createTask, login, runRecurrenceScheduler, tasksForBoard, updateRecurrence } from '../src/db.js';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');

test('scheduler catches up, stays idempotent and template lifecycle preserves tasks', async t => {
  // Pair-board tests also tick the global scheduler; use the same isolation as the next test.
  const setup = createDatabase(url!);
  const schema = `recurrence_${randomUUID().replaceAll('-', '')}`;
  await setup.query(`CREATE SCHEMA ${schema}`);
  const databaseUrl = new URL(url!);
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const db = createDatabase(databaseUrl.toString());
  t.after(async () => { await db.end(); await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.end(); });
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await db.query(await readFile(new URL(file, migrations), 'utf8'));
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const userId = (await db.query<{id: string}>('INSERT INTO users (telegram_id, first_name) VALUES ($1, $2) RETURNING id', [stamp, 'Recurring'])).rows[0].id;
  const boardId = randomUUID();
  await db.query("INSERT INTO boards (id, type, name, owner_user_id, status) VALUES ($1, 'personal', 'Recurring', $2, 'active')", [boardId, userId]);
  await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'owner')", [boardId, userId]);
  const recurrence = await createRecurrence(db, userId, boardId, {
    title: 'Daily', frequency: 'daily', localTime: '09:00', timezone: 'UTC', startAt: '2026-01-01T09:00:00Z'
  });
  assert.ok(recurrence);
  assert.equal(await runRecurrenceScheduler(db, new Date('2026-01-03T09:00:00Z')), 3, 'downtime occurrences are caught up');
  assert.equal(await runRecurrenceScheduler(db, new Date('2026-01-03T09:00:00Z')), 0, 'same tick is idempotent');
  assert.equal((await tasksForBoard(db, userId, boardId)).length, 3, 'each occurrence is independent');
  await updateRecurrence(db, userId, boardId, recurrence.id, { paused: true });
  assert.equal(await runRecurrenceScheduler(db, new Date('2026-01-04T09:00:00Z')), 0, 'pause stops instances');
  await updateRecurrence(db, userId, boardId, recurrence.id, { paused: false });
  await db.query('UPDATE recurrence_templates SET next_occurrence_at = $2 WHERE id = $1', [recurrence.id, '2026-01-04T09:00:00Z']);
  assert.equal(await runRecurrenceScheduler(db, new Date('2026-01-04T09:00:00Z')), 1, 'resume allows next occurrence');
  await updateRecurrence(db, userId, boardId, recurrence.id, { archived: true });
  assert.equal((await tasksForBoard(db, userId, boardId)).length, 4, 'archive keeps instance history');
  await db.query('DELETE FROM boards WHERE id = $1', [boardId]);
  await db.query('DELETE FROM users WHERE id = $1', [userId]);
});

test('explicit future apply is atomic, versioned, isolated and preserves occurrence history', async () => {
  // Other test files run global scheduler ticks concurrently; isolate this rollback fixture.
  const setup = createDatabase(url!);
  const schema = `future_${randomUUID().replaceAll('-', '')}`;
  await setup.query(`CREATE SCHEMA ${schema}`);
  const databaseUrl = new URL(url!);
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const db = createDatabase(databaseUrl.toString());
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) await db.query(await readFile(new URL(file, migrations), 'utf8'));
  const config: Config = { botToken: 'test', databaseUrl: databaseUrl.toString(), sessionSecret: 'isolated-recurrence-secret', initDataMaxAgeSeconds: 60,
    sessionMaxAgeSeconds: 3600, host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-recurrence-webhook',
    publicUrl: 'https://example.test', botUsername: 'test_bot' };
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const users = await Promise.all(['Owner', 'Member', 'Outsider'].map((first_name, index) => login(db, { id: stamp + index, first_name }, 3600, config.sessionSecret)));
  const boardId = (await db.query('SELECT id FROM boards WHERE owner_user_id=$1', [users[0].userId])).rows[0].id;
  const app = buildApp(config, db);
  const trigger = `future_failure_${randomUUID().replaceAll('-', '')}`;
  try {
    await db.query("INSERT INTO memberships (board_id,user_id,role) VALUES ($1,$2,'member')", [boardId, users[1].userId]);
    const recurrence = await createRecurrence(db, users[0].userId, boardId, {
      title: 'Original series', description: 'Original description', frequency: 'daily', localTime: '09:00', timezone: 'UTC', startAt: '2026-01-01T09:00:00Z'
    });
    await runRecurrenceScheduler(db, new Date('2026-01-02T09:00:00Z'));
    const instances = (await tasksForBoard(db, users[0].userId, boardId)).sort((a, b) => new Date(a.occurrence_at).getTime() - new Date(b.occurrence_at).getTime());
    const [past, task] = instances;
    assert.equal(instances.length, 2);
    const path = `/api/boards/${boardId}/tasks/${task.id}`;
    const readTask = async (id = task.id) => (await db.query('SELECT *, revision::text AS version FROM tasks WHERE id=$1', [id])).rows[0];
    const readTemplate = async () => (await db.query('SELECT * FROM recurrence_templates WHERE id=$1', [recurrence.id])).rows[0];
    const snapshot = async () => ({ task: await readTask(), template: await readTemplate(),
      audit: (await db.query('SELECT * FROM task_audit_events WHERE board_id=$1 ORDER BY id', [boardId])).rows,
      notifications: (await db.query('SELECT * FROM task_assignment_notifications WHERE task_id=$1 ORDER BY id', [task.id])).rows });
    const apply = (payload: Record<string, unknown>, user = users[0], target = path) => app.inject({ method: 'PATCH', url: `${target}?scope=future`, cookies: { session: user.token }, payload });
    const initial = await snapshot();
    const pastInitial = await readTask(past.id);
    const denied = await apply({ title: 'Not authorized', expectedVersion: initial.task.version }, users[1]);
    assert.equal(denied.statusCode, 403, 'template permission failure is not partial success');
    assert.deepEqual(await snapshot(), initial, 'template denial rolls back instance, revision, audit and notifications');
    assert.equal((await apply({ title: 'Outsider' }, users[2])).statusCode, 403);
    const otherBoardId = (await db.query('SELECT id FROM boards WHERE owner_user_id=$1', [users[2].userId])).rows[0].id;
    assert.equal((await apply({ title: 'Cross board' }, users[0], `/api/boards/${otherBoardId}/tasks/${task.id}`)).statusCode, 403);

    // Failure injection runs inside real PostgreSQL, not a mock HTTP success/failure.
    await db.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${recurrence.id}'::uuid THEN
        IF NEW.title = 'Injected null' THEN RETURN NULL; END IF;
        IF NEW.title = 'Injected exception' THEN RAISE EXCEPTION 'synthetic template failure'; END IF;
      END IF;
      RETURN NEW;
    END $$`);
    await db.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON recurrence_templates FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    for (const title of ['Injected null', 'Injected exception']) {
      const response = await apply({ title, assigneeUserId: users[1].userId, notifyAssignee: true, expectedVersion: initial.task.version });
      assert.equal(response.statusCode, title === 'Injected null' ? 403 : 500);
      assert.deepEqual(await snapshot(), initial, 'second write failure rolls back all effects');
    }
    await db.query(`DROP TRIGGER ${trigger} ON recurrence_templates`);
    await db.query(`DROP FUNCTION ${trigger}()`);
    const project = await createProject(db, users[0].userId, boardId, 'Future project');
    const patch = { title: 'Applied series', description: 'Applied description', projectId: project.id, assigneeUserId: users[1].userId,
      priority: 'urgent', status: 'waiting', waitReason: 'Instance only', deadline: '2026-02-01T09:00:00Z', expectedVersion: initial.task.version,
      // TaskInput must not smuggle template lifecycle or schedule fields into the series update.
      paused: true, archived: true, frequency: 'monthly', localTime: '18:00' };
    const applied = await apply(patch);
    assert.equal(applied.statusCode, 200, applied.body);
    const current = await readTask();
    const template = await readTemplate();
    for (const row of [current, template]) {
      assert.equal(row.title, patch.title);
      assert.equal(row.description, patch.description);
      assert.equal(row.project_id, project.id);
      assert.equal(row.assignee_user_id, users[1].userId);
      assert.equal(row.priority, 'urgent');
    }
    for (const key of ['frequency', 'local_time', 'timezone', 'starts_at', 'ends_at', 'next_occurrence_at', 'paused_at', 'archived_at']) {
      assert.deepEqual(template[key], initial.template[key], `content apply preserves ${key}`);
    }
    assert.deepEqual(await readTask(past.id), pastInitial, 'past occurrence is untouched');
    const beforeReplay = await snapshot();
    assert.equal((await apply(patch)).statusCode, 409, 'lost response retry cannot reapply stale version');
    assert.deepEqual(await snapshot(), beforeReplay, 'replay has no duplicated effects');
    assert.equal((await apply({ ...patch, expectedVersion: current.version })).statusCode, 200, 'explicit retry with current version is safe');
    assert.equal((await snapshot()).notifications.length, 0, 'applying an already saved assignment does not notify');
    await runRecurrenceScheduler(db, new Date('2026-01-03T09:00:00Z'));
    const future = (await tasksForBoard(db, users[0].userId, boardId)).find((item) => item.id !== task.id && item.id !== past.id)!;
    assert.ok(future, 'next scheduled occurrence still runs at original due time');
    assert.equal(future.title, patch.title);
    assert.equal(future.description, patch.description);
    assert.equal(future.project_id, project.id);
    assert.equal(future.assignee_user_id, users[1].userId);
    assert.equal(future.priority, 'urgent');
    assert.equal(future.status, 'todo');
    assert.equal(future.deadline, null);
    assert.equal(future.blocked_by_task_id, null);
    assert.equal(future.wait_reason, null);
    const instanceOnly = await app.inject({ method: 'PATCH', url: path, cookies: { session: users[0].token }, payload: { title: 'Instance only edit', expectedVersion: (await readTask()).version } });
    assert.equal(instanceOnly.statusCode, 200);
    assert.equal((await readTemplate()).title, patch.title);

    // Without delivery: exercise notification outbox idempotency via the real DB function.
    const { updateTaskAndFuture } = await import('../src/db.js');
    const notificationInput = { assigneeUserId: users[0].userId, notifyAssignee: true, expectedVersion: (await readTask()).version };
    await updateTaskAndFuture(db, users[0].userId, boardId, task.id, notificationInput);
    assert.equal((await snapshot()).notifications.length, 1);
    await assert.rejects(() => updateTaskAndFuture(db, users[0].userId, boardId, task.id, notificationInput), /version conflict/);
    await updateTaskAndFuture(db, users[0].userId, boardId, task.id, { ...notificationInput, expectedVersion: (await readTask()).version });
    assert.equal((await snapshot()).notifications.length, 1, 'safe retry does not duplicate assignment notification');
    const plain = await createTask(db, users[0].userId, boardId, { title: 'No template' });
    assert.equal((await apply({ title: 'Must not change' }, users[0], `/api/boards/${boardId}/tasks/${plain.id}`)).statusCode, 403);
    assert.equal((await readTask(plain.id)).title, 'No template');
    for (const status of ['frozen', 'archived']) {
      await db.query('UPDATE boards SET status=$2 WHERE id=$1', [boardId, status]);
      const before = await snapshot();
      assert.equal((await apply({ title: 'Forbidden' })).statusCode, 403);
      assert.deepEqual(await snapshot(), before);
    }
    await db.query("UPDATE boards SET status='active' WHERE id=$1", [boardId]);
    await db.query('UPDATE tasks SET archived_at=now() WHERE id=$1', [task.id]);
    const archived = await snapshot();
    assert.equal((await apply({ title: 'Archived instance' })).statusCode, 403);
    assert.deepEqual(await snapshot(), archived);
  } finally {
    await app.close();
    await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON recurrence_templates`);
    await db.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
    for (const user of users) {
      await db.query('DELETE FROM boards WHERE owner_user_id=$1', [user.userId]);
      await db.query('DELETE FROM users WHERE id=$1', [user.userId]);
    }
    await db.end();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    await setup.end();
  }
});
