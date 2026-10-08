import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { addChecklistItem, addTaskAttachment, addTaskComment, addTaskFileAttachment, claimAssignmentNotification, createDatabase, createTask, deleteChecklistItem, finishAssignmentNotification, incompleteChecklistCount, login, pendingNotificationForTask, taskAttachmentFile, taskCollaboration, tasksForAssignee, tasksForBoard, updateChecklistItem, updateTask } from '../src/db.js';

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
  const upload = async (options: { token?: string; data?: Buffer; filename?: string; mimeType?: string; requestId?: string }) =>
    app.inject({ method: 'POST', url: `/api/boards/${boardId}/tasks/${task.id}/attachments/file`,
      headers: { cookie: `session=${options.token ?? tokens[2]}`, 'content-type': `multipart/form-data; boundary=${boundary}`, ...(options.requestId !== undefined ? { 'x-upload-id': options.requestId } : {}) },
      payload: multipart('file', options.filename ?? 'shot.png', options.mimeType ?? 'image/png', options.data ?? png) });
  const tooBig = await upload({ data: Buffer.alloc(16 * 1024 * 1024, 1), filename: 'big.png' });
  assert.equal(tooBig.statusCode, 413, 'file larger than 15 MB is rejected');
  assert.match(tooBig.json().error, /15 МБ/);
  const notImage = await upload({ data: Buffer.from('hello'), filename: 'note.txt', mimeType: 'text/plain' });
  assert.equal(notImage.statusCode, 415, 'non-image is rejected');
  const noFile = await app.inject({ method: 'POST', url: `/api/boards/${boardId}/tasks/${task.id}/attachments/file`,
    headers: { cookie: `session=${tokens[2]}`, 'content-type': 'application/json' }, payload: {} });
  assert.equal(noFile.statusCode, 400, 'missing multipart payload is rejected');
  for (const requestId of ['', 'not-a-uuid', `${randomUUID()} `]) assert.equal((await upload({ requestId })).statusCode, 400, 'invalid upload id rejected without normalization');
  const requestId = randomUUID();
  const [savedFile, concurrentFile] = await Promise.all([upload({ requestId }), upload({ requestId })]);
  assert.equal(savedFile.statusCode, 200);
  assert.equal(concurrentFile.statusCode, 200);
  assert.deepEqual(concurrentFile.json(), savedFile.json(), 'concurrent initial uploads create only one attachment');
  assert.equal(savedFile.json().kind, 'file');
  assert.equal(Number(savedFile.json().file_size), png.length);
  const attachmentId = savedFile.json().id;
  assert.equal(attachmentId, requestId, 'client upload ID is the persistent receipt');
  const replays = await Promise.all([upload({ requestId }), upload({ requestId })]);
  for (const replay of replays) {
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json(), savedFile.json(), 'concurrent retries return the original receipt');
  }
  for (const change of [{ data: Buffer.from('different bytes') }, { filename: 'different.png' }, { mimeType: 'image/jpeg' }, { token: tokens[0] }]) {
    assert.equal((await upload({ requestId, ...change })).statusCode, 409, 'same id cannot replace bytes, metadata or actor');
  }
  const secondTask = await createTask(db, users[0], boardId, { title: 'Other upload target' });
  assert.ok(secondTask);
  const crossTask = await app.inject({ method: 'POST', url: `/api/boards/${boardId}/tasks/${secondTask.id}/attachments/file`,
    headers: { cookie: `session=${tokens[2]}`, 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-upload-id': requestId },
    payload: multipart('file', 'shot.png', 'image/png', png) });
  assert.equal(crossTask.statusCode, 409, 'same key cannot attach the receipt to another task');
  assert.equal((await upload({ requestId, token: tokens[3] })).statusCode, 404, 'replay does not bypass membership');
  const persisted = await db.query('SELECT board_id, task_id, file_data FROM task_attachments WHERE id=$1', [attachmentId]);
  assert.equal(persisted.rows[0].board_id, boardId);
  assert.equal(persisted.rows[0].task_id, task.id);
  assert.deepEqual(persisted.rows[0].file_data, png);
  assert.ok((await taskCollaboration(db, users[0], boardId, task.id))!.attachments.some((item: {id: string}) => item.id === attachmentId));
  assert.equal((await upload({ token: tokens[3] })).statusCode, 404, 'known task ID does not allow outsider upload');
  const wrongBoard = await app.inject({ method: 'POST', url: `/api/boards/${otherBoardId}/tasks/${task.id}/attachments/file`,
    headers: { cookie: `session=${tokens[3]}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: multipart('file', 'wrong-board.png', 'image/png', png) });
  assert.equal(wrongBoard.statusCode, 404, 'membership in another board cannot relocate the upload');
  for (const status of ['frozen', 'archived']) {
    await db.query('UPDATE boards SET status=$2 WHERE id=$1', [boardId, status]);
    assert.equal((await upload({})).statusCode, 404, `${status} board rejects upload`);
    assert.equal((await upload({ requestId })).statusCode, 404, `${status} board rejects replay too`);
    assert.deepEqual((await taskAttachmentFile(db, users[0], boardId, task.id, attachmentId)).file_data, png, 'existing read access is preserved');
  }
  await db.query("UPDATE boards SET status='active' WHERE id=$1", [boardId]);
  await db.query('UPDATE tasks SET archived_at=now() WHERE id=$1', [task.id]);
  assert.equal((await upload({})).statusCode, 404, 'archived task rejects upload');
  assert.equal((await upload({ requestId })).statusCode, 404, 'archived task rejects replay');
  await db.query('UPDATE tasks SET archived_at=NULL WHERE id=$1', [task.id]);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM task_attachments WHERE task_id=$1 AND kind='file'", [task.id])).rows[0].count, 1, 'rejected attempts do not create files');
  assert.equal(await taskAttachmentFile(db, users[3], boardId, task.id, attachmentId), null, 'other board member cannot read file');
  const reader = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/tasks/${task.id}/attachments/${attachmentId}/file`, headers: { cookie: `session=${tokens[0]}` } });
  assert.equal(reader.statusCode, 200);
  assert.equal(reader.headers['content-type'], 'image/png');
  assert.deepEqual(reader.rawPayload, png);
  const stolen = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/tasks/${task.id}/attachments/${attachmentId}/file`, headers: { cookie: `session=${tokens[3]}` } });
  assert.equal(stolen.statusCode, 404, 'outsider receives no file and no existence hint');
  await db.query('DELETE FROM memberships WHERE board_id=$1 AND user_id=$2', [boardId, users[2]]);
  assert.equal((await upload({})).statusCode, 404, 'lost membership prevents upload');
  assert.equal((await upload({ requestId })).statusCode, 404, 'lost membership prevents replay');
  const revokedRead = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/tasks/${task.id}/attachments/${attachmentId}/file`, headers: { cookie: `session=${tokens[2]}` } });
  assert.equal(revokedRead.statusCode, 404, 'lost membership prevents file read');
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

test('checklist mutations invalidate completion approval without weakening REST permissions or version guards', async () => {
  const db = createDatabase(url!);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const sessionSecret = 'isolated-checklist-session-secret';
  const owner = await login(db, { id: stamp, first_name: 'Checklist owner' }, 3600, sessionSecret);
  const outsider = await login(db, { id: stamp + 1, first_name: 'Other board' }, 3600, sessionSecret);
  const boardId = (await db.query('SELECT id FROM boards WHERE owner_user_id=$1', [owner.userId])).rows[0].id;
  const config: Config = { botToken: 'test', databaseUrl: url!, sessionSecret, initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 3600,
    host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-checklist-webhook', publicUrl: 'https://example.test', botUsername: 'test_bot' };
  const app = buildApp(config, db);
  try {
    const task = await createTask(db, owner.userId, boardId, { title: 'Approval target' });
    assert.ok(task);
    const path = `/api/boards/${boardId}/tasks/${task.id}`;
    const read = async () => (await db.query('SELECT status, title, revision::text AS version FROM tasks WHERE id=$1', [task.id])).rows[0];
    const patch = (payload: Record<string, unknown>, token = owner.token) => app.inject({ method: 'PATCH', url: path, cookies: { session: token }, payload });
    const firstVersion = (await read()).version;
    const item = await addChecklistItem(db, owner.userId, boardId, task.id, 'Review');
    let version = (await read()).version;
    assert.notEqual(version, firstVersion);
    const refusal = await patch({ status: 'done', title: 'Not written', expectedVersion: version });
    assert.equal(refusal.statusCode, 409);
    assert.equal(refusal.json().incompleteChecklist, 1);
    assert.deepEqual(await read(), { status: 'todo', title: 'Approval target', version });
    for (const mutate of [
      () => updateChecklistItem(db, owner.userId, boardId, task.id, item.id, { text: 'Updated review' }),
      () => updateChecklistItem(db, owner.userId, boardId, task.id, item.id, { completed: true }),
      () => updateChecklistItem(db, owner.userId, boardId, task.id, item.id, { completed: false }),
      () => deleteChecklistItem(db, owner.userId, boardId, task.id, item.id)
    ]) {
      await mutate();
      const stale = await patch({ status: 'done', confirmIncompleteChecklist: true, expectedVersion: version });
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().error, 'version conflict');
      assert.equal((await read()).status, 'todo');
      assert.notEqual((await read()).version, version);
      version = (await read()).version;
    }
    assert.equal((await patch({ status: 'done', expectedVersion: version })).statusCode, 200, 'empty checklist needs no confirmation');
    await addChecklistItem(db, owner.userId, boardId, task.id, 'Still incomplete');
    version = (await read()).version;
    assert.equal((await patch({ title: 'Done text edit', expectedVersion: version })).statusCode, 200, 'text edit does not confirm done again');
    await updateTask(db, owner.userId, boardId, task.id, { status: 'todo' });
    version = (await read()).version;
    assert.equal((await patch({ status: 'done', confirmIncompleteChecklist: true, expectedVersion: version }, outsider.token)).statusCode, 403);
    assert.equal(await addChecklistItem(db, outsider.userId, boardId, task.id, 'Forbidden'), null);
    assert.equal((await read()).version, version, 'denied mutation does not alter revision');
    for (const status of ['frozen', 'archived']) {
      await db.query('UPDATE boards SET status=$2 WHERE id=$1', [boardId, status]);
      assert.equal((await patch({ status: 'done', confirmIncompleteChecklist: true, expectedVersion: version })).statusCode, 403);
      assert.equal(await addChecklistItem(db, owner.userId, boardId, task.id, 'Forbidden'), null);
    }
    await db.query("UPDATE boards SET status='active' WHERE id=$1", [boardId]);
    await db.query('UPDATE tasks SET archived_at=now() WHERE id=$1', [task.id]);
    assert.equal((await patch({ status: 'done', confirmIncompleteChecklist: true })).statusCode, 403);
    await db.query('UPDATE tasks SET archived_at=NULL WHERE id=$1', [task.id]);
    version = (await read()).version;
    const racing = await Promise.all([patch({ status: 'done', confirmIncompleteChecklist: true, expectedVersion: version }), patch({ title: 'Racing edit', expectedVersion: version })]);
    assert.deepEqual(racing.map((response) => response.statusCode).sort(), [200, 409]);
    version = (await read()).version;
    assert.equal((await patch({ status: 'done', confirmIncompleteChecklist: true, expectedVersion: version })).statusCode, 200);
    assert.equal(await incompleteChecklistCount(db, owner.userId, boardId, task.id), 1, 'confirmation never ticks items');
  } finally {
    await app.close();
    for (const user of [owner, outsider]) {
      await db.query('DELETE FROM boards WHERE owner_user_id=$1', [user.userId]);
      await db.query('DELETE FROM users WHERE id=$1', [user.userId]);
    }
    await db.end();
  }
});
