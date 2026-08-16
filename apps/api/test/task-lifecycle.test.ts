import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, createProject, createTask, ProjectConflictError, saveTaskFilterState, setTaskArchived, taskFilterState, tasksForAssignee, tasksForBoard, updateProject, updateTask } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');

test('task lifecycle enforces tenant, role and transition rules', async () => {
  const db = createDatabase(url!);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const users = await Promise.all(['Creator', 'Assignee', 'Member', 'Outsider'].map(async (name, index) =>
    (await db.query<{id: string}>('INSERT INTO users (telegram_id, first_name) VALUES ($1, $2) RETURNING id', [stamp + index, name])).rows[0].id));
  const boardId = randomUUID();
  await db.query("INSERT INTO boards (id, type, name, telegram_chat_id, status) VALUES ($1, 'chat', 'Team', $2, 'active')", [boardId, -stamp]);
  for (const userId of users.slice(0, 3)) await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'member')", [boardId, userId]);

  const project = await createProject(db, users[2], boardId, 'Launch');
  assert.ok(project, 'any member can create project');
  const repeatedProjects = await Promise.all(Array.from({ length: 10 }, () => createProject(db, users[2], boardId, 'launch')));
  assert.deepEqual(new Set(repeatedProjects.map((item) => item?.id)), new Set([project.id]), 'concurrent project creation is idempotent');
  const secondProject = await createProject(db, users[2], boardId, 'Support');
  await assert.rejects(() => updateProject(db, users[2], boardId, secondProject.id, { name: 'LAUNCH' }), ProjectConflictError);
  assert.equal(await createProject(db, users[3], boardId, 'Stolen'), null, 'outsider cannot create project');

  const task = await createTask(db, users[0], boardId, { title: 'Ship', projectId: project.id, assigneeUserId: users[1], priority: 'urgent', deadline: '2000-01-01T00:00:00Z' });
  assert.ok(task);
  assert.equal(await createTask(db, users[0], boardId, { title: 'Bypass', assigneeUserId: users[1], status: 'done' }), null, 'create cannot bypass close permission');
  assert.equal(await createTask(db, users[3], boardId, { title: 'Stolen' }), null);
  assert.equal((await tasksForBoard(db, users[2], boardId))[0].overdue, true, 'member reads active board tasks and overdue is computed');
  assert.equal((await tasksForBoard(db, users[3], boardId)).length, 0, 'outsider cannot read tasks');
  assert.equal((await tasksForAssignee(db, users[1]))[0].id, task.id, 'assigned task appears in all-my-tasks');
  assert.deepEqual(await taskFilterState(db, users[1], boardId), {});
  assert.deepEqual(await saveTaskFilterState(db, users[1], boardId, { status: 'todo' }), { status: 'todo' });
  assert.deepEqual(await taskFilterState(db, users[1], boardId), { status: 'todo' }, 'filter state persists per user and board');
  assert.equal(await saveTaskFilterState(db, users[3], boardId, { status: 'done' }), null, 'outsider cannot save filter state');

  assert.equal(await updateTask(db, users[2], boardId, task.id, { title: 'Hijack' }), null, 'ordinary member cannot edit');
  assert.equal(await updateTask(db, users[0], boardId, task.id, { status: 'done' }), null, 'creator cannot close assigned task');
  assert.equal(await updateTask(db, users[1], boardId, task.id, { status: 'waiting', waitReason: null }), null, 'waiting requires reason');
  const waiting = await updateTask(db, users[1], boardId, task.id, { status: 'waiting', waitReason: 'Client', waitCheckAt: '2000-01-02T00:00:00Z' });
  assert.equal(waiting.status, 'waiting');
  assert.equal((await tasksForBoard(db, users[0], boardId))[0].wait_check_due, true);
  assert.equal((await updateTask(db, users[1], boardId, task.id, { status: 'done' }))?.status, 'done', 'assignee closes task');
  assert.equal(await updateTask(db, users[1], boardId, task.id, { status: 'in_progress' }), null, 'assignee cannot reopen');
  assert.equal((await updateTask(db, users[0], boardId, task.id, { status: 'in_progress' }))?.status, 'in_progress', 'creator reopens');

  await db.query('DELETE FROM memberships WHERE board_id = $1 AND user_id = $2', [boardId, users[1]]);
  assert.equal((await tasksForBoard(db, users[0], boardId))[0].assignee_user_id, null, 'leaving board clears active assignment');
  assert.equal(await setTaskArchived(db, users[2], boardId, task.id, true), false);
  await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'member')", [boardId, users[1]]);
  assert.ok(await updateTask(db, users[0], boardId, task.id, { assigneeUserId: users[1] }));
  assert.equal(await setTaskArchived(db, users[0], boardId, task.id, true), true);
  assert.equal((await tasksForBoard(db, users[0], boardId)).length, 0, 'archived task leaves active view');
  assert.equal((await tasksForBoard(db, users[0], boardId, true)).length, 1, 'history remains readable');
  await db.query('DELETE FROM memberships WHERE board_id = $1 AND user_id = $2', [boardId, users[1]]);
  assert.equal((await tasksForBoard(db, users[0], boardId, true))[0].assignee_user_id, null, 'leaving board also preserves archived task without stale assignment');
  assert.equal(await setTaskArchived(db, users[0], boardId, task.id, false), true, 'task can be reopened from archive');
  assert.equal((await tasksForBoard(db, users[0], boardId)).length, 1);
  assert.equal((await updateProject(db, users[2], boardId, project.id, { name: 'Release', archived: true }))?.name, 'Release');
  assert.ok(await updateProject(db, users[2], boardId, project.id, { archived: false }), 'project can be restored');

  await db.query('DELETE FROM boards WHERE id = $1', [boardId]);
  await db.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  await db.end();
});
