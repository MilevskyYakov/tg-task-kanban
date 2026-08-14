import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { addChecklistItem, addTaskAttachment, addTaskComment, claimAssignmentNotification, createDatabase, createTask, finishAssignmentNotification, incompleteChecklistCount, pendingNotificationForTask, taskCollaboration, tasksForAssignee, tasksForBoard, updateChecklistItem, updateTask } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');

test('task collaboration enforces access, immutable audit and notification idempotency', async () => {
  const db = createDatabase(url!);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const users = await Promise.all(['Creator', 'Assignee', 'Member', 'Outsider'].map(async (name, index) =>
    (await db.query<{id: string}>('INSERT INTO users (telegram_id, first_name) VALUES ($1, $2) RETURNING id', [stamp + index, name])).rows[0].id));
  const boardId = randomUUID();
  const otherBoardId = randomUUID();
  await db.query("INSERT INTO boards (id, type, name, telegram_chat_id, status) VALUES ($1, 'chat', 'Team', $2, 'active'), ($3, 'chat', 'Other', $4, 'active')", [boardId, -stamp, otherBoardId, -stamp - 1]);
  for (const userId of users.slice(0, 3)) await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'member')", [boardId, userId]);
  await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'member')", [otherBoardId, users[3]]);

  const task = await createTask(db, users[0], boardId, { title: 'Ship', assigneeUserId: users[1], notifyAssignee: true });
  assert.ok(task);
  assert.ok(await addTaskComment(db, users[2], boardId, task.id, 'Ready to review'));
  assert.equal((await taskCollaboration(db, users[2], boardId, task.id))!.comments[0].body, 'Ready to review');
  assert.equal(await addTaskComment(db, users[3], boardId, task.id, 'Stolen'), null);

  const item = await addChecklistItem(db, users[0], boardId, task.id, 'Run smoke');
  assert.ok(item);
  const secondItem = await addChecklistItem(db, users[1], boardId, task.id, 'Deploy');
  assert.ok(await updateChecklistItem(db, users[1], boardId, task.id, secondItem.id, { position: 0 }));
  assert.deepEqual((await taskCollaboration(db, users[1], boardId, task.id))!.checklist.map((entry: {text: string}) => entry.text), ['Deploy', 'Run smoke']);
  assert.equal(await addChecklistItem(db, users[2], boardId, task.id, 'Hijack'), null);
  assert.equal(await incompleteChecklistCount(db, users[1], boardId, task.id), 2);
  assert.ok(await updateChecklistItem(db, users[1], boardId, task.id, item.id, { completed: true }));
  assert.ok(await updateChecklistItem(db, users[1], boardId, task.id, secondItem.id, { completed: true }));
  assert.equal(await incompleteChecklistCount(db, users[1], boardId, task.id), 0);
  const boardTask = (await tasksForBoard(db, users[0], boardId))[0];
  const assignedTask = (await tasksForAssignee(db, users[1]))[0];
  assert.deepEqual({ completed: boardTask.checklist_completed, total: boardTask.checklist_total }, { completed: 2, total: 2 });
  assert.deepEqual({ completed: assignedTask.checklist_completed, total: assignedTask.checklist_total }, { completed: 2, total: 2 });

  assert.ok(await addTaskAttachment(db, users[2], boardId, task.id, { kind: 'telegram', telegramFileId: 'private-file-id', telegramFileUniqueId: 'stable-id', fileName: 'brief.pdf' }));
  assert.equal(await taskCollaboration(db, users[3], boardId, task.id), null, 'other board cannot read Telegram file id');
  await updateTask(db, users[1], boardId, task.id, { status: 'done' });
  const collaboration = await taskCollaboration(db, users[0], boardId, task.id);
  assert.deepEqual(collaboration!.timeline.map((event: {action: string}) => event.action), ['created', 'checklist_added', 'checklist_added', 'checklist_updated', 'checklist_updated', 'checklist_updated', 'updated']);
  await assert.rejects(db.query('UPDATE task_audit_events SET action = $1 WHERE task_id = $2', ['forged', task.id]), /append-only/);

  const notificationId = await pendingNotificationForTask(db, task.id);
  assert.ok(notificationId);
  assert.ok(await claimAssignmentNotification(db, notificationId));
  assert.equal(await claimAssignmentNotification(db, notificationId), null, 'delivery cannot be claimed twice');
  await finishAssignmentNotification(db, notificationId, 'network failed');
  const status = await db.query('SELECT status, error FROM task_assignment_notifications WHERE id = $1', [notificationId]);
  assert.deepEqual(status.rows[0], { status: 'failed', error: 'network failed' });

  await db.query('DELETE FROM boards WHERE id = ANY($1)', [[boardId, otherBoardId]]);
  await db.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  await db.end();
});
