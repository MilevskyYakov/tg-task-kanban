import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { addChecklistItem, addTaskAttachment, addTaskComment, addTaskFileAttachment, claimAssignmentNotification, createDatabase, createTask, finishAssignmentNotification, incompleteChecklistCount, pendingNotificationForTask, taskAttachmentFile, taskCollaboration, tasksForAssignee, tasksForBoard, updateChecklistItem, updateTask } from '../src/db.js';

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

  const sessionSecret = 'test-session-secret-with-at-least-32-characters';
  const tokens = users.map(() => randomBytes(24).toString('base64url'));
  await Promise.all(tokens.map((token, index) => db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [createHash('sha256').update(`${sessionSecret}:${token}`).digest('hex'), users[index]])));
  const config: Config = { botToken: 'test', databaseUrl: url!, sessionSecret, initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 60,
    host: '127.0.0.1', port: 2240, production: false, webhookSecret: 'test-webhook-secret-with-at-least-32-characters', publicUrl: 'https://example.test', botUsername: 'test_bot' };
  const app = buildApp(config, db);
  const allowed = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/tasks/${task.id}`, headers: { cookie: `session=${tokens[2]}` } });
  const missing = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/tasks/${randomUUID()}`, headers: { cookie: `session=${tokens[2]}` } });
  const forbidden = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/tasks/${task.id}`, headers: { cookie: `session=${tokens[3]}` } });
  const creatorView = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/tasks/${task.id}`, headers: { cookie: `session=${tokens[0]}` } });
  const memberClose = await app.inject({ method: 'PATCH', url: `/api/boards/${boardId}/tasks/${task.id}`, headers: { cookie: `session=${tokens[2]}` }, payload: { status: 'done' } });
  const creatorReopen = await app.inject({ method: 'PATCH', url: `/api/boards/${boardId}/tasks/${task.id}`, headers: { cookie: `session=${tokens[0]}` }, payload: { status: 'in_progress' } });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().title, 'Ship');
  assert.equal(creatorView.statusCode, 200, 'creator reads the task');
  assert.deepEqual([missing.statusCode, missing.json()], [404, { error: 'task not found' }]);
  assert.deepEqual([forbidden.statusCode, forbidden.json()], [403, { error: 'task access forbidden' }], 'outsider receives no task data');
  assert.deepEqual([memberClose.statusCode, memberClose.json().status], [200, 'done'], 'board member who is neither creator nor assignee closes the task');
  assert.deepEqual([creatorReopen.statusCode, creatorReopen.json().status], [200, 'in_progress'], 'creator reopens the task');

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

  const png = Buffer.concat([Buffer.from('89504e47', 'hex'), randomBytes(32)]);
  const boundary = '----testboundary';
  const multipart = (name: string, filename: string, contentType: string, data: Buffer) => Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${name}"; filename="${filename}"\r\ncontent-type: ${contentType}\r\n\r\n`),
    data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const upload = async (options: { token?: string; data?: Buffer; filename?: string; mimeType?: string }) =>
    app.inject({ method: 'POST', url: `/api/boards/${boardId}/tasks/${task.id}/attachments/file`,
      headers: { cookie: `session=${options.token ?? tokens[2]}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart('file', options.filename ?? 'shot.png', options.mimeType ?? 'image/png', options.data ?? png) });
  const tooBig = await upload({ data: Buffer.alloc(16 * 1024 * 1024, 1), filename: 'big.png' });
  assert.equal(tooBig.statusCode, 413, 'file larger than 15 MB is rejected');
  assert.match(tooBig.json().error, /15 МБ/);
  const notImage = await upload({ data: Buffer.from('hello'), filename: 'note.txt', mimeType: 'text/plain' });
  assert.equal(notImage.statusCode, 415, 'non-image is rejected');
  const noFile = await app.inject({ method: 'POST', url: `/api/boards/${boardId}/tasks/${task.id}/attachments/file`,
    headers: { cookie: `session=${tokens[2]}`, 'content-type': 'application/json' }, payload: {} });
  assert.equal(noFile.statusCode, 400, 'missing multipart payload is rejected');
  const savedFile = await upload({});
  assert.equal(savedFile.statusCode, 200);
  assert.equal(savedFile.json().kind, 'file');
  assert.equal(Number(savedFile.json().file_size), png.length);
  const attachmentId = savedFile.json().id;
  assert.equal(await taskAttachmentFile(db, users[3], boardId, task.id, attachmentId), null, 'other board member cannot read file');
  const reader = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/tasks/${task.id}/attachments/${attachmentId}/file`, headers: { cookie: `session=${tokens[0]}` } });
  assert.equal(reader.statusCode, 200);
  assert.equal(reader.headers['content-type'], 'image/png');
  assert.deepEqual(reader.rawPayload, png);
  const stolen = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/tasks/${task.id}/attachments/${attachmentId}/file`, headers: { cookie: `session=${tokens[3]}` } });
  assert.equal(stolen.statusCode, 404, 'outsider receives no file and no existence hint');
  assert.ok(await addTaskFileAttachment(db, users[1], boardId, task.id, { data: png, fileName: 'again.png', mimeType: 'image/png', fileSize: png.length }), 'persistence via db helper');
  await updateTask(db, users[1], boardId, task.id, { status: 'done' });
  const collaboration = await taskCollaboration(db, users[0], boardId, task.id);
  assert.deepEqual(collaboration!.timeline.map((event: {action: string}) => event.action), ['created', 'updated', 'updated', 'checklist_added', 'checklist_added', 'checklist_updated', 'checklist_updated', 'checklist_updated', 'updated']);
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
  await app.close();
  await db.end();
});
