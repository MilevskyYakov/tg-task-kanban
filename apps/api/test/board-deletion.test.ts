import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from '../src/app.js';
import { addChecklistItem, addTaskComment, addTaskFileAttachment, connectChatBoard, createDatabase, createProject, createRecurrence, createTask, freezeChatBoard, login, runRecurrenceScheduler, withBoardLock } from '../src/db.js';
import { createPairBoard, changePairInvite, redeemPairInvite, setPairArchived } from '../src/pair-boards.js';
import { boardDeletionPreview, changeBoardDeletion } from '../src/board-deletion.js';
import { createChatDirection, createChatLaunch, createInvite, redeemBoardLink, migrateChatBoard } from '../src/chat-boards.js';
import { deliverPendingPublications, queueDuePublications, schedulesForBoard, updateSchedule } from '../src/publications.js';
import type { Config } from '../src/config.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const admin = createDatabase(process.env.TEST_DATABASE_URL);
const databaseName = `deletion_${randomBytes(8).toString('hex')}`;
const isolated = new URL(process.env.TEST_DATABASE_URL); isolated.pathname = `/${databaseName}`;
const db = createDatabase(isolated.href);
const config: Config = {botToken: 'test', databaseUrl: isolated.href, sessionSecret: 'deletion-isolated', initDataMaxAgeSeconds: 60,
  sessionMaxAgeSeconds: 3600, host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated', publicUrl: 'https://example.test', botUsername: 'test_bot'};
const directory = new URL('../migrations/', import.meta.url);
before(async () => {
  await admin.query(`CREATE DATABASE ${databaseName}`);
  for (const file of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) await db.query(await readFile(new URL(file, directory), 'utf8'));
  await db.query(await readFile(new URL('018_board_deletion.sql', directory), 'utf8'));
});
after(async () => { await db.end(); await admin.query(`DROP DATABASE ${databaseName}`); await admin.end(); });
async function people() {
  const stamp = randomBytes(6).readUIntBE(0, 6);
  return Promise.all(['Владелец', 'Участник', 'Посторонний'].map((first_name, index) => login(db, {id: stamp + index, first_name}, 3600, config.sessionSecret)));
}
const request = async (userId: string, boardId: string, action: 'delete' | 'restore' = 'delete') => ({action, requestId: randomUUID(), confirmation: (await boardDeletionPreview(db, userId, boardId, 'test')).confirmation});
const change = async (userId: string, boardId: string, action: 'delete' | 'restore' = 'delete') => changeBoardDeletion(db, userId, boardId, 'test', await request(userId, boardId, action));

test('pair deletion: validation, roles, preserved data, stale confirmation, rollback, replay and read/write boundaries', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No Telegram contact for pair deletion'); });
  const [owner, member, outsider] = await people();
  const pairRequest = randomUUID();
  const board = await createPairBoard(db, owner.userId, 'На двоих', pairRequest);
  const invite = (await changePairInvite(db, owner.userId, board.id))!;
  await redeemPairInvite(db, member.userId, invite, true);
  const project = await createProject(db, owner.userId, board.id, 'Сохранить');
  const task = await createTask(db, owner.userId, board.id, {title: 'История', projectId: project.id, assigneeUserId: member.userId});
  await createTask(db, owner.userId, board.id, {title: 'Зависимая', status: 'waiting', blockerTaskId: task.id});
  await addTaskComment(db, owner.userId, board.id, task.id, 'Сохранить комментарий');
  await addChecklistItem(db, owner.userId, board.id, task.id, 'Сохранить пункт');
  const bytes = Buffer.from('isolated file');
  const file = await addTaskFileAttachment(db, owner.userId, board.id, task.id, {data: bytes, fileName: 'file.png', mimeType: 'image/png', fileSize: bytes.length});
  const recurrence = await createRecurrence(db, owner.userId, board.id, {title: 'Повтор', frequency: 'daily', localTime: '00:00', timezone: 'UTC', startAt: '2035-01-01T00:00:00Z'});
  const app = buildApp(config, db);
  const call = (person: typeof owner, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', suffix: string, payload?: object) => app.inject({method, url: `/api/boards/${board.id}${suffix}`, payload, cookies: {session: person.token}});
  try {
    const path = `/api/boards/${board.id}/deletion`;
    assert.equal((await app.inject({method: 'GET', url: path})).statusCode, 401);
    assert.equal((await call(member, 'GET', '/deletion')).statusCode, 403);
    assert.equal((await call(outsider, 'GET', '/deletion')).statusCode, 404);
    assert.equal((await call(owner, 'POST', '/deletion', {})).statusCode, 400);
    const personal = (await app.inject({method: 'GET', url: '/api/boards', cookies: {session: owner.token}})).json().boards.find((value: any) => value.type === 'personal');
    assert.equal((await app.inject({method: 'GET', url: `/api/boards/${personal.id}/deletion`, cookies: {session: owner.token}})).statusCode, 403);
    const stale = await request(owner.userId, board.id);
    await createTask(db, member.userId, board.id, {title: 'Добавлена после подтверждения'});
    assert.equal((await call(owner, 'POST', '/deletion', stale)).statusCode, 409);
    const input = await request(owner.userId, board.id);
    const beforeCounts = (await boardDeletionPreview(db, owner.userId, board.id, 'test')).counts;
    assert.equal((await call(owner, 'POST', '/deletion', {...input, action: ['delete']})).statusCode, 400);
    // Fail at the last write, after pausing/revoking, and require a full rollback.
    await db.query(`CREATE FUNCTION fail_deletion_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated receipt failure'; END $$;
      CREATE TRIGGER fail_deletion_receipt BEFORE INSERT ON board_lifecycle_events FOR EACH ROW EXECUTE FUNCTION fail_deletion_receipt()`);
    assert.equal((await call(owner, 'POST', '/deletion', input)).statusCode, 500);
    assert.equal((await db.query('SELECT deleted_at FROM boards WHERE id=$1', [board.id])).rows[0].deleted_at, null);
    assert.equal((await db.query('SELECT paused_at FROM recurrence_templates WHERE id=$1', [recurrence.id])).rows[0].paused_at, null);
    await db.query('DROP TRIGGER fail_deletion_receipt ON board_lifecycle_events');
    const responses = await Promise.all(Array.from({length: 5}, () => call(owner, 'POST', '/deletion', input)));
    assert.ok(responses.every(response => response.statusCode === 200), responses.map(value => value.body).join('\n'));
    assert.equal((await db.query('SELECT count(*) FROM board_lifecycle_events WHERE board_id=$1', [board.id])).rows[0].count, '1');
    assert.equal((await call(owner, 'GET', '')).statusCode, 404);
    assert.equal((await call(member, 'POST', '/deletion', {...input, action: 'restore', requestId: randomUUID()})).statusCode, 403);
    assert.equal((await call(owner, 'GET', '/tasks')).json().tasks.length, 0);
    assert.equal((await call(owner, 'GET', '/projects')).json().projects.length, 0);
    assert.equal((await call(owner, 'GET', '/members')).json().members.length, 0);
    assert.equal((await call(owner, 'GET', '/recurrences')).json().recurrences.length, 0);
    assert.equal((await call(owner, 'GET', `/tasks/${task.id}/collaboration`)).statusCode, 404);
    assert.equal((await call(owner, 'GET', `/tasks/${task.id}/attachments/${file.id}/file`)).statusCode, 404);
    assert.equal((await call(owner, 'POST', '/tasks', {title: 'Нельзя'})).statusCode, 404);
    assert.equal((await call(owner, 'POST', '/projects', {name: 'Нельзя'})).statusCode, 404);
    assert.equal((await call(owner, 'PATCH', `/tasks/${task.id}`, {title: 'Нельзя'})).statusCode, 403);
    for (const person of [owner, member]) for (const archived of [true, false]) {
      const response = await call(person, archived ? 'DELETE' : 'POST', `/tasks/${task.id}${archived ? '' : '/reopen'}`);
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error, 'Задача недоступна', 'archive/restore must not disclose a deleted task state');
    }
    assert.equal((await call(owner, 'POST', '/archive', {archived: false})).statusCode, 403);
    await assert.rejects(createPairBoard(db, owner.userId, 'На двоих', pairRequest), /удалена/);
    assert.equal(await addTaskFileAttachment(db, owner.userId, board.id, task.id, {data: bytes, fileName: 'blocked.png', mimeType: 'image/png', fileSize: bytes.length}), null);
    assert.equal(await runRecurrenceScheduler(db, new Date('2035-01-01T01:00:00Z')), 0);
    const deleted = await app.inject({method: 'GET', url: '/api/boards/deleted', cookies: {session: owner.token}});
    assert.ok(deleted.json().boards.some((value: any) => value.id === board.id));
    assert.deepEqual((await app.inject({method: 'GET', url: '/api/boards/deleted', cookies: {session: member.token}})).json().boards, []);
    for (const token of [invite, `open_${board.id}`, `task_${board.id}_${task.id}`]) {
      assert.equal((await app.inject({method: 'POST', url: '/api/board-links/redeem', cookies: {session: owner.token}, payload: {token, acceptedHistory: true}})).statusCode, 404);
    }
    await change(owner.userId, board.id, 'restore');
    assert.deepEqual((await boardDeletionPreview(db, owner.userId, board.id, 'test')).counts, beforeCounts, 'all data counts survive delete and restore');
    assert.equal((await call(member, 'GET', '/projects')).json().projects[0].id, project.id);
    const replay = (await call(owner, 'POST', '/deletion', input)).json();
    assert.equal(replay.deleted, false, 'late deletion retry cannot delete a restored board');
    assert.equal((await call(owner, 'POST', '/deletion', {...input, requestId: randomUUID()})).statusCode, 409);
    assert.equal((await call(owner, 'POST', '/deletion', {...input, action: 'restore'})).statusCode, 409);
    assert.equal((await call(member, 'GET', '/tasks')).json().tasks.length, 3);
    assert.equal((await db.query('SELECT file_data FROM task_attachments WHERE id=$1', [file.id])).rows[0].file_data.equals(bytes), true);
    assert.equal((await db.query('SELECT count(*) FROM task_comments WHERE board_id=$1', [board.id])).rows[0].count, '1');
    assert.equal((await db.query('SELECT count(*) FROM tasks WHERE board_id=$1 AND blocked_by_task_id=$2', [board.id, task.id])).rows[0].count, '1');
    assert.ok((await db.query('SELECT paused_at FROM recurrence_templates WHERE id=$1', [recurrence.id])).rows[0].paused_at);
    assert.equal(await redeemPairInvite(db, outsider.userId, invite, true), null, 'old invitations stay revoked');
  } finally { await app.close(); }
});

test('chat root, last board, current Telegram rights, MCP all/selected and sibling publications remain isolated', async t => {
  const [owner, member, outsider] = await people();
  const telegramId = (await db.query('SELECT telegram_id FROM users WHERE id=$1', [owner.userId])).rows[0].telegram_id;
  let adminEnabled = true, telegramOffline = false;
  const messages: any[] = [];
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: unknown, options?: RequestInit) => {
    if (!String(input).startsWith('https://api.telegram.org/')) return nativeFetch(input as string, options);
    if (String(input).endsWith('/getChatMember')) {
      if (telegramOffline) throw new Error('isolated Telegram outage');
      return Response.json({ok: true, result: {status: adminEnabled && String(JSON.parse(String(options?.body)).user_id) === telegramId ? 'administrator' : 'member'}});
    }
    assert.ok(String(input).endsWith('/sendRichMessage'), 'no other Telegram side effects');
    messages.push(JSON.parse(String(options?.body)));
    return Response.json({ok: true, result: {message_id: messages.length}});
  });
  const chatId = -Number(telegramId);
  const root = (await connectChatBoard(db, chatId, 'Root', 1, 1))!;
  await db.query("UPDATE boards SET status='active' WHERE id=$1", [root.id]);
  for (const person of [owner, member]) await db.query("INSERT INTO memberships VALUES ($1,$2,'member')", [root.id, person.userId]);
  const version = (await db.query('SELECT chat_members_version FROM boards WHERE id=$1', [root.id])).rows[0].chat_members_version;
  const childInput = {name: 'Sibling', requestId: randomUUID(), memberVersion: version, memberIds: [owner.userId, member.userId]};
  const child = await createChatDirection(db, owner.userId, root.id, 'test', childInput);
  const rootTask = await createTask(db, owner.userId, root.id, {title: 'Hidden root task'});
  const childTask = await createTask(db, owner.userId, child.id, {title: 'Visible sibling task'});
  const common = await createChatLaunch(db, owner.userId, root.id, 'test');
  const sharedInvite = (await createInvite(db, owner.userId, root.id, 'test'))!;
  const app = buildApp(config, db);
  const clients: Client[] = [];
  try {
    const origin = await app.listen({host: '127.0.0.1', port: 0}); config.publicUrl = origin;
    const issue = async (boardSelection: 'all' | 'selected') => {
      const issued = await app.inject({method: 'POST', url: '/api/mcp-connections', cookies: {session: member.token}, headers: {origin, host: new URL(origin).host},
        payload: {name: boardSelection, boardSelection, boardIds: boardSelection === 'all' ? [] : [root.id, child.id], mode: 'write', requestId: randomUUID()}});
      assert.equal(issued.statusCode, 201, issued.body);
      const client = new Client({name: 'deletion', version: '1'}); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {requestInit: {headers: {Authorization: 'Bearer ' + issued.json().key}}}));
      return async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({name, arguments: args})).structuredContent as any;
    };
    const selected = await issue('selected'), all = await issue('all');
    const mcpCreate = {boardId: root.id, title: 'MCP receipt', requestId: randomUUID()};
    assert.equal((await all('create_task', mcpCreate)).ok, true);
    await updateSchedule(db, root.id, 'daily', {enabled: true, weekdays: [1,2,3,4,5,6,7], local_time: '00:00', timezone: 'UTC', included_board_ids: [root.id, child.id]});
    const input = await request(owner.userId, root.id);
    await assert.rejects(changeBoardDeletion(db, member.userId, root.id, 'test', input), /администратора/);
    await assert.rejects(changeBoardDeletion(db, outsider.userId, root.id, 'test', input), /недоступна/);
    adminEnabled = false;
    await assert.rejects(changeBoardDeletion(db, owner.userId, root.id, 'test', input), /администратора/);
    adminEnabled = true; telegramOffline = true;
    await assert.rejects(changeBoardDeletion(db, owner.userId, root.id, 'test', input), /проверить права/);
    telegramOffline = false;
    const members = (await db.query('SELECT * FROM memberships WHERE board_id=$1 ORDER BY user_id', [child.id])).rows;
    await queueDuePublications(db, new Date('2036-01-01T12:00:00Z'));
    await changeBoardDeletion(db, owner.userId, root.id, 'test', input);
    assert.deepEqual((await db.query('SELECT * FROM memberships WHERE board_id=$1 ORDER BY user_id', [child.id])).rows, members);
    assert.equal((await db.query('SELECT title FROM tasks WHERE id=$1', [childTask.id])).rows[0].title, 'Visible sibling task');
    for (const tool of [selected, all]) {
      assert.equal((await tool('get_task', {boardId: root.id, taskId: rootTask.id})).error.code, 'NOT_FOUND');
      assert.equal((await tool('get_task', {boardId: child.id, taskId: childTask.id})).ok, true);
      assert.ok(!(await tool('list_boards')).items.some((value: any) => value.id === root.id));
    }
    assert.equal((await all('create_task', mcpCreate)).error.code, 'NOT_FOUND', 'old receipts cannot bypass deletion');
    const issuedWhileDeleted = await issue('all');
    const schedules = await schedulesForBoard(db, member.userId, child.id);
    assert.deepEqual(schedules.find(value => value.kind === 'daily')!.included_board_ids, [child.id]);
    assert.equal(schedules.find(value => value.kind === 'daily')!.enabled, true);
    await queueDuePublications(db, new Date('2036-01-02T12:00:00Z'));
    while (await deliverPendingPublications(db, 'test', 'bot', new Date('2036-01-02T12:00:00Z'))) {}
    assert.equal(messages.length, 1); assert.match(messages[0].rich_message.html, /Visible sibling task/); assert.doesNotMatch(messages[0].rich_message.html, /Hidden root task/);
    const commonEntry = await app.inject({method: 'POST', url: '/api/board-links/redeem', cookies: {session: member.token}, payload: {token: common}});
    assert.equal(commonEntry.json().chatEntry, true);
    assert.equal((await db.query('SELECT revoked_at FROM board_links WHERE token_hash=$1', [createHash('sha256').update(sharedInvite).digest('hex')])).rows[0].revoked_at, null);
    assert.equal((await app.inject({method: 'POST', url: '/api/board-links/redeem', cookies: {session: member.token}, payload: {token: `open_${root.id}`}})).statusCode, 404);
    await change(owner.userId, child.id);
    await assert.rejects(createChatDirection(db, owner.userId, root.id, 'test', childInput), /удалена/);
    const empty = await app.inject({method: 'GET', url: `/api/boards/${root.id}/chat`, cookies: {session: owner.token}});
    assert.deepEqual(empty.json().boards, []); assert.equal(empty.json().canManage, true);
    assert.ok((await db.query('SELECT revoked_at FROM board_links WHERE token_hash=$1', [createHash('sha256').update(sharedInvite).digest('hex')])).rows[0].revoked_at);
    await freezeChatBoard(db, chatId, 2, 2); await connectChatBoard(db, chatId, 'Returned', 3, 3);
    assert.equal((await db.query('SELECT count(*) FROM boards WHERE chat_root_id=$1 AND deleted_at IS NULL', [root.id])).rows[0].count, '0');
    const next = await createChatDirection(db, owner.userId, root.id, 'test', {name: 'New, not reassigned', requestId: randomUUID()});
    assert.notEqual(next.id, root.id); assert.notEqual(next.id, child.id);
    await change(owner.userId, root.id, 'restore');
    assert.equal(await redeemBoardLink(db, outsider.userId, sharedInvite, true, 'test'), null);
    assert.equal((await all('get_task', {boardId: root.id, taskId: rootTask.id})).error.code, 'NOT_FOUND');
    assert.equal((await selected('get_task', {boardId: root.id, taskId: rootTask.id})).error.code, 'NOT_FOUND');
    assert.equal((await issuedWhileDeleted('get_task', {boardId: root.id, taskId: rootTask.id})).error.code, 'NOT_FOUND');
    const restoredSchedules = await schedulesForBoard(db, owner.userId, root.id);
    assert.ok(restoredSchedules.every(value => !value.enabled && value.included_board_ids?.length === 0));
  } finally { for (const client of clients) await client.close(); await app.close(); }
});

test('empty archived pair, deleted draft chat and frozen restoration preserve their lifecycle', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ok: true, result: {status: 'administrator'}}));
  const [owner, member] = await people();
  const pair = await createPairBoard(db, owner.userId, 'Empty archived', randomUUID());
  await setPairArchived(db, owner.userId, pair.id, true);
  assert.equal((await boardDeletionPreview(db, owner.userId, pair.id, 'test')).counts.tasks, 0);
  await change(owner.userId, pair.id); await change(owner.userId, pair.id, 'restore');
  assert.equal((await db.query('SELECT status FROM boards WHERE id=$1', [pair.id])).rows[0].status, 'archived');
  const chatId = -randomBytes(6).readUIntBE(0, 6);
  const root = (await connectChatBoard(db, chatId, 'Empty draft'))!;
  await db.query("INSERT INTO memberships VALUES ($1,$2,'member')", [root.id, owner.userId]);
  await change(owner.userId, root.id);
  const version = (await db.query('SELECT chat_members_version FROM boards WHERE id=$1', [root.id])).rows[0].chat_members_version;
  const child = await createChatDirection(db, owner.userId, root.id, 'test', {name: 'Explicit creation', requestId: randomUUID(), memberIds: [owner.userId], memberVersion: version});
  assert.notEqual(child.id, root.id);
  assert.ok((await db.query('SELECT deleted_at FROM boards WHERE id=$1', [root.id])).rows[0].deleted_at);
  await freezeChatBoard(db, chatId);
  await change(owner.userId, root.id, 'restore');
  assert.equal((await db.query('SELECT status FROM boards WHERE id=$1', [root.id])).rows[0].status, 'frozen');
  await assert.rejects(boardDeletionPreview(db, member.userId, root.id, 'test'), /недоступна/, 'even a Telegram admin needs board access');
  const targetChatId = chatId - 1;
  const target = (await connectChatBoard(db, targetChatId, 'Deleted target'))!;
  await db.query("INSERT INTO memberships VALUES ($1,$2,'member')", [target.id, owner.userId]);
  await change(owner.userId, target.id);
  await db.query('DELETE FROM memberships WHERE board_id=$1', [target.id]);
  await assert.rejects(migrateChatBoard(db, chatId, targetChatId), /проверка миграции/);
  assert.ok((await db.query('SELECT deleted_at FROM boards WHERE id=$1', [target.id])).rows[0].deleted_at, 'migration cannot repurpose a deleted draft ID');
});

test('board lock serializes deletion against tasks, images, recurrence scheduler and publication delivery', async t => {
  const [owner] = await people();
  const pair = await createPairBoard(db, owner.userId, 'Race', randomUUID());
  const task = await createTask(db, owner.userId, pair.id, {title: 'Race task'});
  await createRecurrence(db, owner.userId, pair.id, {title: 'Race recurrence', frequency: 'daily', localTime: '00:00', timezone: 'UTC', startAt: '2037-01-01T00:00:00Z'});
  const input = await request(owner.userId, pair.id);
  let release!: () => void, acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holding = withBoardLock(db, pair.id, async () => { acquired(); await gate; });
  await ready;
  const deleting = changeBoardDeletion(db, owner.userId, pair.id, 'test', input);
  // Poll the actual PostgreSQL waiter, not a timing assumption about the request.
  for (let i = 0; i < 100; i++) {
    if ((await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%' AND pid<>pg_backend_pid()")).rowCount) break;
    if (i === 99) assert.fail('deletion did not reach advisory lock');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const writing = createTask(db, owner.userId, pair.id, {title: 'Too late'});
  const uploading = addTaskFileAttachment(db, owner.userId, pair.id, task.id, {data: Buffer.from('x'), fileName: 'race.png', mimeType: 'image/png', fileSize: 1});
  const template = createRecurrence(db, owner.userId, pair.id, {title: 'Late template', frequency: 'daily', localTime: '00:00', timezone: 'UTC', startAt: '2037-01-01T00:00:00Z'});
  const recurring = runRecurrenceScheduler(db, new Date('2037-01-01T01:00:00Z'));
  release(); await holding; assert.equal((await deleting).deleted, true);
  assert.equal(await writing, null); assert.equal(await uploading, null); assert.equal(await template, null); assert.equal(await recurring, 0);

  const stamp = randomBytes(6).readUIntBE(0, 6);
  const root = (await connectChatBoard(db, -stamp, 'Publication race'))!;
  await db.query("UPDATE boards SET status='active' WHERE id=$1", [root.id]);
  await db.query("INSERT INTO memberships VALUES ($1,$2,'admin')", [root.id, owner.userId]);
  await createTask(db, owner.userId, root.id, {title: 'Publication data'});
  await updateSchedule(db, root.id, 'daily', {enabled: true, weekdays: [1,2,3,4,5,6,7], local_time: '00:00', timezone: 'UTC'});
  let sent!: () => void, finish!: () => void;
  const sending = new Promise<void>(resolve => { sent = resolve; });
  const deliveryGate = new Promise<void>(resolve => { finish = resolve; });
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    if (String(url).endsWith('/getChatMember')) return Response.json({ok: true, result: {status: 'administrator'}});
    assert.ok(String(url).endsWith('/sendRichMessage')); sent(); await deliveryGate;
    return Response.json({ok: true, result: {message_id: 1}});
  });
  const deletion = await request(owner.userId, root.id);
  await queueDuePublications(db, new Date('2038-01-01T12:00:00Z'));
  const delivering = deliverPendingPublications(db, 'test', 'bot', new Date('2038-01-01T12:00:00Z'));
  await sending;
  let deleted = false;
  const deletingChat = changeBoardDeletion(db, owner.userId, root.id, 'test', deletion).then(value => { deleted = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(deleted, false, 'deletion waits for an already-started delivery');
  finish(); await delivering; assert.equal((await deletingChat).deleted, true);
  await queueDuePublications(db, new Date('2038-01-02T12:00:00Z'));
  assert.equal(await deliverPendingPublications(db, 'test', 'bot', new Date('2038-01-02T12:00:00Z')), false);
});
