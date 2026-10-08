import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from '../src/app.js';
import { connectChatBoard, createDatabase, createInvite, createTask, freezeChatBoard, login, migrateChatBoard } from '../src/db.js';
import { deliverPendingPublications, queueDuePublications, renderPublication, schedulesForBoard, updateSchedule } from '../src/publications.js';
import type { Config } from '../src/config.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const admin = createDatabase(process.env.TEST_DATABASE_URL);
const databaseName = `directions_${randomBytes(8).toString('hex')}`;
const isolated = new URL(process.env.TEST_DATABASE_URL); isolated.pathname = `/${databaseName}`;
const db = createDatabase(isolated.href);
const config: Config = {botToken: 'test', databaseUrl: isolated.href, sessionSecret: 'isolated-directions', initDataMaxAgeSeconds: 60,
  sessionMaxAgeSeconds: 3600, host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-webhook', publicUrl: 'https://example.test', botUsername: 'test_bot'};
const directory = new URL('../migrations/', import.meta.url);
before(async () => {
  await admin.query(`CREATE DATABASE ${databaseName}`);
  for (const file of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) await db.query(await readFile(new URL(file, directory), 'utf8'));
});
after(async () => { await db.end(); await admin.query(`DROP DATABASE ${databaseName}`); await admin.end(); });

async function fixture() {
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const people = await Promise.all(['Администратор', 'Участник', 'Посторонний'].map((first_name, index) => login(db, {id: stamp + index, first_name}, 3600, config.sessionSecret)));
  const root = (await connectChatBoard(db, -stamp, 'Исходная доска', 1, 1))!;
  await db.query("UPDATE boards SET status = 'active' WHERE id = $1", [root.id]);
  for (const person of people.slice(0, 2)) await db.query("INSERT INTO memberships VALUES ($1, $2, 'member')", [root.id, person.userId]);
  const app = buildApp(config, db);
  const call = (person: typeof people[number], method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) => app.inject({method, url, payload, cookies: {session: person.token}});
  const context = async () => (await call(people[0], 'GET', `/api/boards/${root.id}/chat`)).json();
  const creation = async (name = 'Новое направление') => { const value = await context(); return {name, requestId: randomUUID(), memberVersion: value.memberVersion, memberIds: value.members.map((member: {id: string}) => member.id)}; };
  const cleanup = async () => {
    await app.close(); await db.query('DELETE FROM boards WHERE chat_root_id = $1 OR owner_user_id = ANY($2::bigint[])', [root.id, people.map(person => person.userId)]);
    await db.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [people.map(person => person.userId)]);
  };
  return {root, stamp, people, app, call, context, creation, cleanup};
}

test('directions preserve history; creation, shared membership, API and MCP revocation are atomic', async t => {
  const f = await fixture(); const [owner, member, outsider] = f.people;
  let telegramAdmin = true, sends = 0;
  t.mock.method(globalThis, 'fetch', async (input: unknown, options?: RequestInit) => {
    if (!String(input).startsWith('https://api.telegram.org/')) return originalFetch(input as string, options);
    if (!String(input).endsWith('/getChatMember')) { sends++; throw new Error('Unexpected send'); }
    return Response.json({ok: true, result: {status: telegramAdmin && String(JSON.parse(String(options?.body)).user_id) === String(f.stamp) ? 'administrator' : 'member'}});
  });
  const path = `/api/boards/${f.root.id}`;
  const reader = new Client({name: 'directions-test', version: '1'});
  try {
    const task = await createTask(db, owner.userId, f.root.id, {title: 'История остаётся', assigneeUserId: member.userId});
    const legacyInvite = await createInvite(db, owner.userId, f.root.id);
    const direct = 'board_' + randomBytes(24).toString('base64url');
    const common = 'board_' + randomBytes(24).toString('base64url');
    for (const [token, kind] of [[direct, 'launch'], [common, 'chat_launch']]) await db.query('INSERT INTO board_links (token_hash, board_id, kind) VALUES ($1, $2, $3)', [createHash('sha256').update(token).digest('hex'), f.root.id, kind]);
    const schedules = await schedulesForBoard(db, owner.userId, f.root.id);
    assert.equal((await f.call(owner, 'DELETE', `${path}/chat/members/9999999999999999999`)).statusCode, 400);
    assert.equal((await f.call(owner, 'POST', `${path}/chat/boards`, {name: 'Нет подтверждения', requestId: randomUUID()})).statusCode, 409);
    const stale = await f.creation();
    await db.query('DELETE FROM memberships WHERE board_id = $1 AND user_id = $2', [f.root.id, member.userId]);
    await db.query("INSERT INTO memberships VALUES ($1, $2, 'member')", [f.root.id, member.userId]);
    assert.equal((await f.call(owner, 'POST', `${path}/chat/boards`, stale)).statusCode, 409, 'ABA membership change invalidates the confirmation');
    const input = await f.creation();
    assert.equal((await f.call(member, 'POST', `${path}/chat/boards`, input)).statusCode, 403);
    assert.equal((await f.call(outsider, 'POST', `${path}/chat/boards`, input)).statusCode, 404);
    const responses = await Promise.all(Array.from({length: 12}, () => f.call(owner, 'POST', `${path}/chat/boards`, input)));
    assert.ok(responses.every(response => response.statusCode === 200), responses.map(response => response.body).join('\n'));
    const child = responses[0].json(); assert.ok(responses.every(response => response.json().id === child.id));
    assert.equal((await db.query('SELECT count(*) FROM boards WHERE chat_root_id = $1', [f.root.id])).rows[0].count, '2');
    assert.equal((await db.query('SELECT count(*) FROM tasks WHERE board_id = $1', [child.id])).rows[0].count, '0');
    await db.query("UPDATE boards SET name = 'Переименовано после создания' WHERE id = $1", [child.id]);
    assert.equal((await f.call(owner, 'POST', `${path}/chat/boards`, input)).json().id, child.id, 'renaming cannot break a creation receipt');
    assert.equal((await f.call(owner, 'POST', `${path}/chat/boards`, {...input, name: 'Другой запрос'})).statusCode, 409);
    assert.deepEqual(await schedulesForBoard(db, owner.userId, child.id), schedules, 'schedules and their original board selection are preserved');
    assert.equal((await f.call(outsider, 'POST', '/api/board-links/redeem', {token: legacyInvite})).statusCode, 404);
    assert.equal((await f.call(member, 'POST', '/api/board-links/redeem', {token: direct})).json().chatEntry, undefined);
    assert.equal((await f.call(member, 'POST', '/api/board-links/redeem', {token: common})).json().chatEntry, true);
    assert.equal((await f.call(outsider, 'POST', '/api/board-links/redeem', {token: common})).statusCode, 404);
    const third = (await f.call(owner, 'POST', `${path}/chat/boards`, {name: 'Ещё направление', requestId: randomUUID()})).json();
    const inviteResponse = await f.call(owner, 'POST', `/api/boards/${child.id}/invites`);
    const token = new URL(inviteResponse.json().url).searchParams.get('startapp');
    assert.equal((await f.call(outsider, 'POST', '/api/chat-invites/preview', {token})).json().shared, true);
    assert.equal((await f.call(outsider, 'POST', '/api/board-links/redeem', {token})).statusCode, 409);
    assert.equal((await f.call(outsider, 'POST', '/api/board-links/redeem', {token, acceptedAccess: true})).statusCode, 200);
    assert.equal((await db.query('SELECT count(*) FROM memberships m JOIN boards b ON b.id = m.board_id WHERE b.chat_root_id = $1 AND m.user_id = $2', [f.root.id, outsider.userId])).rows[0].count, '3');
    const childTask = await createTask(db, owner.userId, child.id, {title: 'Другая доска'});
    assert.equal((await f.call(member, 'GET', `${path}/tasks/${childTask.id}`)).statusCode, 404, 'task IDs remain board-scoped');
    const origin = await f.app.listen({host: '127.0.0.1', port: 0}); config.publicUrl = origin;
    const connection = await f.app.inject({method: 'POST', url: '/api/mcp-connections', cookies: {session: member.token}, headers: {origin, host: new URL(origin).host}, payload: {name: 'Shared access', mode: 'read', boardIds: [f.root.id, child.id, third.id], requestId: randomUUID()}});
    assert.equal(connection.statusCode, 201, connection.body);
    await reader.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {requestInit: {headers: {Authorization: 'Bearer ' + connection.json().key}}}));
    const tool = async () => (await reader.callTool({name: 'get_task', arguments: {boardId: f.root.id, taskId: task.id}})).structuredContent as any;
    assert.equal((await tool()).ok, true);
    assert.equal((await f.call(owner, 'DELETE', `/api/boards/${child.id}/chat/members/${member.userId}`)).statusCode, 200);
    for (const id of [f.root.id, child.id, third.id]) assert.equal((await f.call(member, 'GET', `/api/boards/${id}`)).statusCode, 404);
    assert.equal((await f.call(member, 'POST', '/api/board-links/redeem', {token: direct})).statusCode, 404);
    assert.equal((await f.call(member, 'POST', '/api/board-links/redeem', {token: `task_${f.root.id}_${task.id}`})).statusCode, 404);
    assert.equal((await tool()).error.code, 'NOT_FOUND');
    assert.equal((await db.query('SELECT count(*) FROM mcp_board_grants WHERE user_id = $1', [member.userId])).rows[0].count, '0');
    assert.equal((await f.call(member, 'POST', '/api/board-links/redeem', {token, acceptedAccess: true})).statusCode, 200);
    assert.equal((await tool()).error.code, 'NOT_FOUND', 'rejoining does not restore MCP grants');
    assert.equal((await db.query('SELECT title FROM tasks WHERE id = $1', [task.id])).rows[0].title, task.title);
    telegramAdmin = false;
    assert.equal((await f.call(owner, 'POST', `${path}/chat/boards`, input)).statusCode, 403, 'idempotent replay must recheck permission');
    telegramAdmin = true;
    await db.query("UPDATE boards SET status = 'archived' WHERE id = $1", [third.id]);
    await freezeChatBoard(db, -f.stamp, 10, 10); await connectChatBoard(db, -f.stamp, 'Stale', 9, 9);
    assert.equal((await db.query('SELECT status FROM boards WHERE id = $1', [child.id])).rows[0].status, 'frozen');
    await connectChatBoard(db, -f.stamp, 'Restore', 11, 11);
    const placeholder = await connectChatBoard(db, -f.stamp - 10, 'Supergroup announced first', 12, 12);
    assert.ok(placeholder);
    await migrateChatBoard(db, -f.stamp, -f.stamp - 10); await migrateChatBoard(db, -f.stamp, -f.stamp - 10);
    assert.equal((await db.query('SELECT 1 FROM boards WHERE id = $1', [placeholder.id])).rowCount, 0, 'empty target is not a duplicate chat');
    assert.equal(await connectChatBoard(db, -f.stamp, 'Old group', 30, 30), null);
    await freezeChatBoard(db, -f.stamp, 31, 31);
    const states = (await db.query('SELECT id, status, telegram_chat_id FROM boards WHERE chat_root_id = $1', [f.root.id])).rows;
    assert.equal(states.length, 3); assert.ok(states.every(board => board.telegram_chat_id === String(-f.stamp - 10)));
    assert.equal(states.find(board => board.id === child.id).status, 'active'); assert.equal(states.find(board => board.id === third.id).status, 'archived');
    assert.equal(sends, 0, 'creating and managing directions never posts to Telegram');
  } finally { await reader.close(); await f.cleanup(); }
});
const originalFetch = globalThis.fetch;

test('release integration: new directions, selected/all MCP, assessment, images and exact entry share one ACL', async t => {
  const f = await fixture(); const [owner, member, outsider] = f.people;
  const clients: Client[] = [];
  const photos: FormData[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown, options?: RequestInit) => {
    if (!String(input).startsWith('https://api.telegram.org/')) return originalFetch(input as string, options);
    if (String(input).endsWith('/getChatMember')) return Response.json({ok: true, result: {status: 'administrator'}});
    assert.ok(String(input).endsWith('/sendPhoto'));
    assert.ok(options?.body instanceof FormData); photos.push(options.body);
    return Response.json({ok: true, result: {message_id: photos.length}});
  });
  try {
    const origin = await f.app.listen({host: '127.0.0.1', port: 0}); config.publicUrl = origin;
    const issue = async (boardSelection: 'selected' | 'all') => {
      const response = await f.app.inject({method: 'POST', url: '/api/mcp-connections', cookies: {session: member.token},
        headers: {origin, host: new URL(origin).host}, payload: {name: boardSelection, mode: 'write', boardSelection,
          boardIds: boardSelection === 'selected' ? [f.root.id] : [], requestId: randomUUID()}});
      assert.equal(response.statusCode, 201, response.body);
      const client = new Client({name: 'release-integration', version: '1'}); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {requestInit: {headers: {Authorization: 'Bearer ' + response.json().key}}}));
      return async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({name, arguments: args})).structuredContent as any;
    };
    const selected = await issue('selected'), all = await issue('all');
    const response = await f.call(owner, 'POST', `/api/boards/${f.root.id}/chat/boards`, await f.creation('Release direction'));
    assert.equal(response.statusCode, 200, response.body); const child = response.json();
    assert.deepEqual((await selected('list_boards')).items.map((board: any) => board.id), [f.root.id]);
    assert.ok((await all('list_boards')).items.some((board: any) => board.id === child.id));
    assert.equal((await selected('list_tasks', {boardId: child.id})).error.code, 'NOT_FOUND');
    const created = await all('create_task', {boardId: child.id, title: 'Assessed image task', importance: true, urgency: false, requestId: randomUUID()});
    assert.equal(created.ok, true, JSON.stringify(created)); const taskId = created.task.id;
    const task = await f.call(member, 'GET', `/api/boards/${child.id}/tasks/${taskId}`);
    assert.equal(task.statusCode, 200); assert.equal(task.json().importance, true); assert.equal(task.json().urgency, false);
    const filters = {scope: 'all', importance: 'true', urgency: 'false', search: 'Assessed'};
    assert.equal((await f.call(member, 'PUT', `/api/boards/${child.id}/task-filters`, {filters})).statusCode, 200);
    assert.deepEqual((await f.call(member, 'GET', `/api/boards/${child.id}/task-filters`)).json().filters, filters);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=', 'base64');
    const form = new FormData(); form.set('file', new Blob([png], {type: 'image/png'}), 'release.png');
    const request = new Request('http://example.test', {method: 'POST', body: form});
    const upload = await f.app.inject({method: 'POST', url: `/api/boards/${child.id}/tasks/${taskId}/attachments/file`, cookies: {session: member.token},
      headers: {'content-type': request.headers.get('content-type')!, 'x-upload-id': randomUUID()}, payload: Buffer.from(await request.arrayBuffer())});
    assert.equal(upload.statusCode, 200, upload.body);
    assert.deepEqual((await db.query('SELECT file_data FROM task_attachments WHERE task_id=$1', [taskId])).rows[0].file_data, png);
    const before = (await db.query('SELECT * FROM memberships WHERE board_id=$1 ORDER BY user_id', [child.id])).rows;
    for (const boardId of [f.root.id, child.id]) {
      const token = `open_${boardId}`;
      assert.equal((await f.call(member, 'POST', '/api/board-links/redeem', {token})).json().id, boardId);
      assert.equal((await f.call(outsider, 'POST', '/api/board-links/redeem', {token, acceptedAccess: true})).statusCode, 404);
    }
    assert.deepEqual((await db.query('SELECT * FROM memberships WHERE board_id=$1 ORDER BY user_id', [child.id])).rows, before);
    const entry = await f.call(member, 'GET', `/api/boards/${child.id}/entry`);
    assert.equal(new URL(entry.json().botUrl).searchParams.get('start'), `entry_${child.id}`);
    const sent = await f.app.inject({method: 'POST', url: '/api/telegram/webhook', headers: {'x-telegram-bot-api-secret-token': config.webhookSecret},
      payload: {update_id: f.stamp, message: {message_id: f.stamp, chat: {id: f.stamp + 1, type: 'private'}, text: `/start entry_${child.id}`}}});
    assert.equal(sent.json().delivery, 'sent'); assert.equal(photos.length, 1);
    const link = JSON.parse(String(photos[0].get('reply_markup'))).inline_keyboard[0][0].url;
    assert.equal(new URL(link).searchParams.get('startapp'), `open_${child.id}`);
    assert.match(String(photos[0].get('caption')), /Release direction/);
    assert.equal((await f.call(owner, 'DELETE', `/api/boards/${child.id}/chat/members/${member.userId}`)).statusCode, 200);
    assert.equal((await f.call(member, 'POST', '/api/board-links/redeem', {token: `open_${child.id}`})).statusCode, 404);
    assert.equal((await f.call(member, 'GET', `/api/boards/${child.id}/tasks/${taskId}`)).statusCode, 403);
    assert.equal((await all('get_task', {boardId: child.id, taskId})).error.code, 'NOT_FOUND');
    const invite = (await f.call(owner, 'POST', `/api/boards/${child.id}/invites`)).json().url;
    assert.equal((await f.call(member, 'POST', '/api/board-links/redeem', {token: new URL(invite).searchParams.get('startapp'), acceptedAccess: true})).statusCode, 200);
    assert.equal((await all('get_task', {boardId: child.id, taskId})).error.code, 'NOT_FOUND', 'all mode must not restore access lost before rejoining');
    assert.equal((await selected('list_tasks', {boardId: f.root.id})).error.code, 'NOT_FOUND');
  } finally {
    for (const client of clients) await client.close();
    const receipt = createHash('sha256').update(`${f.stamp + 1}:${f.stamp}`).digest('hex');
    await db.query('DELETE FROM telegram_entry_deliveries WHERE key LIKE $1', [`%:command:${receipt}`]);
    await f.cleanup();
  }
});

test('existing chat obtains a general link without resending welcome or granting access', async t => {
  const f = await fixture(); const [owner, member, outsider] = f.people;
  t.mock.method(globalThis, 'fetch', async (input: unknown, options?: RequestInit) => {
    assert.ok(String(input).endsWith('/getChatMember'), 'link creation must never send a Telegram message');
    return Response.json({ok: true, result: {status: String(JSON.parse(String(options?.body)).user_id) === String(f.stamp) ? 'administrator' : 'member'}});
  });
  try {
    const key = `bot:${createHash('sha256').update(config.botToken.split(':', 1)[0]).digest('hex')}:board:${f.root.id}`;
    await db.query("INSERT INTO telegram_entry_deliveries (key,board_id,status,message_id,attempts) VALUES ($1,$2,'sent',176,1)", [key, f.root.id]);
    const direct = `board_${randomBytes(24).toString('base64url')}`;
    await db.query("INSERT INTO board_links (token_hash,board_id,kind) VALUES ($1,$2,'launch')", [createHash('sha256').update(direct).digest('hex'), f.root.id]);
    const receipt = (await db.query('SELECT * FROM telegram_entry_deliveries WHERE key=$1', [key])).rows;
    const path = `/api/boards/${f.root.id}/chat/link`;
    const response = await f.call(owner, 'POST', path);
    assert.equal(response.statusCode, 200, response.body);
    const url = new URL(response.json().url), token = url.searchParams.get('startapp');
    assert.equal(url.hostname, 't.me'); assert.equal(url.pathname, '/test_bot');
    assert.equal((await f.call(member, 'POST', '/api/board-links/redeem', {token})).json().chatEntry, true);
    assert.equal((await f.call(outsider, 'POST', '/api/board-links/redeem', {token, acceptedAccess: true})).statusCode, 404);
    assert.equal((await f.call(member, 'POST', path)).statusCode, 403);
    assert.equal((await f.call(outsider, 'POST', path)).statusCode, 404);
    const child = (await f.call(owner, 'POST', `/api/boards/${f.root.id}/chat/boards`, await f.creation())).json();
    const second = await f.call(owner, 'POST', `/api/boards/${child.id}/chat/link`);
    assert.equal(second.statusCode, 200);
    assert.equal((await f.call(member, 'POST', '/api/board-links/redeem', {token})).json().chatEntry, true, 'old common links survive creation and repeated requests');
    const legacy = await f.call(member, 'POST', '/api/board-links/redeem', {token: direct});
    assert.equal(legacy.json().id, f.root.id); assert.equal(legacy.json().chatEntry, undefined);
    await f.call(owner, 'DELETE', `/api/boards/${f.root.id}/chat/members/${member.userId}`);
    assert.equal((await f.call(member, 'POST', '/api/board-links/redeem', {token})).statusCode, 404);
    assert.equal((await f.call(member, 'POST', path)).statusCode, 404);
    await freezeChatBoard(db, -f.stamp, 2, 2);
    assert.equal((await f.call(owner, 'POST', path)).statusCode, 403);
    assert.deepEqual((await db.query('SELECT * FROM telegram_entry_deliveries WHERE key=$1', [key])).rows, receipt);
  } finally { await f.cleanup(); }
});

test('one selected multi-board report; durable parts, rejection retry and unknown-outcome stop', async t => {
  const f = await fixture(); const [owner] = f.people;
  let mode = 'ok'; const sends: any[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown, options?: RequestInit) => {
    if (String(input).endsWith('/getChatMember')) return Response.json({ok: true, result: {status: 'administrator'}});
    assert.ok(String(input).endsWith('/sendRichMessage'));
    const payload = JSON.parse(String(options?.body)); sends.push(payload);
    if (sends.length === 2 && mode === 'reject') return Response.json({ok: false, error_code: 429, description: 'Too Many Requests'}, {status: 429});
    if (sends.length === 2 && mode === 'unknown') throw new Error('Lost receipt');
    return Response.json({ok: true, result: {message_id: sends.length}});
  });
  try {
    // ASCII names have distinct ordering even on macOS libc locales that tie Cyrillic names.
    const child = (await f.call(owner, 'POST', `/api/boards/${f.root.id}/chat/boards`, await f.creation('Middle direction'))).json();
    assert.equal((await f.call(owner, 'PATCH', `/api/boards/${f.root.id}`, {name: 'Zulu direction'})).statusCode, 200);
    const now = new Date('2036-08-11T12:00:00Z');
    await updateSchedule(db, f.root.id, 'daily', {enabled: true, weekdays: [1,2,3,4,5,6,7], local_time: '00:00', timezone: 'Asia/Ho_Chi_Minh', included_statuses: ['todo'], included_board_ids: [f.root.id]});
    await createTask(db, owner.userId, f.root.id, {title: 'Старая задача'});
    await createTask(db, owner.userId, child.id, {title: 'Выбранное направление'});
    assert.doesNotMatch((await renderPublication(db, f.root.id, 'daily', ['todo'], 'bot', 'UTC', now, [f.root.id])).join(''), /Выбранное направление/);
    await assert.rejects(renderPublication(db, f.root.id, 'daily', ['todo'], 'bot', 'UTC', now, [(await db.query('SELECT id FROM boards WHERE owner_user_id = $1', [owner.userId])).rows[0].id]), /только доски этого чата/);
    await updateSchedule(db, child.id, 'daily', {included_board_ids: [child.id, f.root.id]});
    await queueDuePublications(db, now); await queueDuePublications(db, now);
    assert.equal((await db.query('SELECT count(*) FROM publication_runs WHERE board_id = $1', [f.root.id])).rows[0].count, '1');
    await Promise.all([deliverPendingPublications(db, 'test', 'bot', now), deliverPendingPublications(db, 'test', 'bot', now)]);
    assert.equal(sends.length, 1); assert.match(sends[0].rich_message.html, /Старая задача/); assert.match(sends[0].rich_message.html, /Выбранное направление/);
    await db.query('INSERT INTO tasks (id, board_id, title, creator_user_id) SELECT gen_random_uuid(), $1, \'Задача \' || n || repeat(\'я😀&\', 38), $2 FROM generate_series(1,250) n', [child.id, owner.userId]);
    const preview = await renderPublication(db, f.root.id, 'daily', ['todo'], 'bot', 'UTC', now, [child.id]);
    assert.ok(preview.length > 2); assert.ok(preview.every((page, index) => Buffer.byteLength(page) < 32768 && page.startsWith(`<p>Часть ${index + 1} из ${preview.length}</p>`)));
    assert.equal(new Set(preview.join('').match(/startapp=task_[0-9a-f-]+_[0-9a-f-]+/g)).size, 251, 'all tasks survive chunking');
    const resetRun = async (date: string) => {
      await db.query('DELETE FROM publication_runs WHERE board_id = $1', [f.root.id]);
      await db.query('INSERT INTO publication_runs (id, board_id, kind, local_date, report_at) VALUES ($1,$2,\'daily\',$3,$4)', [randomUUID(), f.root.id, date, now]);
      sends.length = 0;
    };
    await resetRun('2036-08-12'); mode = 'reject';
    await deliverPendingPublications(db, 'test', 'bot', now);
    let run = (await db.query('SELECT * FROM publication_runs WHERE board_id = $1', [f.root.id])).rows[0];
    assert.equal(run.status, 'pending'); assert.equal(run.sent_parts, 1); assert.deepEqual(run.message_ids, ['1']);
    const snapshot = run.messages;
    await db.query("UPDATE tasks SET title = 'Changed after snapshot' WHERE board_id = $1", [child.id]);
    assert.equal((await f.call(owner, 'PATCH', `/api/boards/${f.root.id}`, {name: 'Alpha renamed direction'})).statusCode, 200);
    const renamedOrder = (await db.query('SELECT id FROM boards WHERE chat_root_id=$1 ORDER BY name,id', [f.root.id])).rows.map(board => board.id);
    assert.notDeepEqual(renamedOrder, run.board_ids, 'fixture must change name order without changing the selected set');
    mode = 'ok'; await deliverPendingPublications(db, 'test', 'bot', new Date('2036-08-11T12:02:00Z'));
    run = (await db.query('SELECT * FROM publication_runs WHERE board_id = $1', [f.root.id])).rows[0];
    assert.equal(run.status, 'sent'); assert.deepEqual(run.messages, snapshot); assert.equal(run.sent_parts, snapshot.length);
    assert.equal(sends[2].rich_message.html, snapshot[1], 'retry starts at rejected part, not first part');
    assert.equal(sends.filter(send => send.rich_message.html === snapshot[0]).length, 1);
    await resetRun('2036-08-16'); mode = 'reject';
    await deliverPendingPublications(db, 'test', 'bot', now);
    await updateSchedule(db, child.id, 'daily', {included_board_ids: [f.root.id, child.id]});
    assert.equal((await db.query('SELECT status FROM publication_runs WHERE board_id=$1', [f.root.id])).rows[0].status, 'pending', 'reordering the same selection must not cancel a snapshot');
    mode = 'ok'; await deliverPendingPublications(db, 'test', 'bot', new Date('2036-08-11T12:02:00Z'));
    assert.equal((await db.query('SELECT status FROM publication_runs WHERE board_id=$1', [f.root.id])).rows[0].status, 'sent');
    await resetRun('2036-08-17'); mode = 'reject';
    await deliverPendingPublications(db, 'test', 'bot', now);
    await updateSchedule(db, child.id, 'daily', {included_board_ids: [child.id]});
    assert.equal((await db.query('SELECT status FROM publication_runs WHERE board_id=$1', [f.root.id])).rows[0].status, 'cancelled', 'removing a selected board must still cancel the stale snapshot');
    await resetRun('2036-08-13'); mode = 'unknown';
    await deliverPendingPublications(db, 'test', 'bot', now);
    run = (await db.query('SELECT * FROM publication_runs WHERE board_id = $1', [f.root.id])).rows[0];
    assert.equal(run.status, 'uncertain'); assert.equal(run.sent_parts, 1); assert.equal(sends.length, 2);
    assert.equal(await deliverPendingPublications(db, 'test', 'bot', new Date('2036-08-12T12:00:00Z')), false);
    const delivery = await f.call(owner, 'GET', `/api/boards/${child.id}/publications`);
    assert.equal(delivery.json().deliveries[0].sent_parts, 1);
    await resetRun('2036-08-14'); mode = 'ok';
    await db.query("UPDATE publication_runs SET status = 'sending', next_attempt_at = '2030-01-01' WHERE board_id = $1", [f.root.id]);
    await deliverPendingPublications(db, 'test', 'bot', now);
    assert.equal(sends.length, 0); assert.equal((await db.query('SELECT status FROM publication_runs WHERE board_id = $1', [f.root.id])).rows[0].status, 'uncertain');
    await resetRun('2036-08-15'); await updateSchedule(db, child.id, 'daily', {included_board_ids: []});
    await deliverPendingPublications(db, 'test', 'bot', now); assert.equal(sends.length, 0);
    assert.deepEqual(await renderPublication(db, child.id, 'daily', ['todo'], 'bot', 'UTC', now, []), []);
  } finally { await f.cleanup(); }
});

test('conflicting schedules keep legacy mode until explicit, versioned choice', async t => {
  const f = await fixture(); const [owner] = f.people;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ok: true, result: {status: 'administrator'}}));
  try {
    const child = randomUUID();
    await db.query("INSERT INTO boards (id,type,name,telegram_chat_id,status,chat_root_id) VALUES ($1,'chat','Legacy direction',$2,'active',$3)", [child, -f.stamp, f.root.id]);
    await db.query("INSERT INTO publication_schedules (board_id,kind,enabled,weekdays,local_time,timezone) VALUES ($1,'daily',true,ARRAY[2,4]::smallint[],'08:17','Asia/Tokyo'),($1,'weekly',true,ARRAY[5]::smallint[],'21:43','America/New_York')", [child]);
    const before = (await db.query('SELECT * FROM publication_schedules WHERE board_id IN ($1,$2) ORDER BY board_id,kind', [child, f.root.id])).rows;
    const abandoned = randomUUID();
    await db.query("INSERT INTO publication_runs (id,board_id,kind,local_date,status,attempts,next_attempt_at) VALUES ($1,$2,'daily','2030-01-01','sending',1,'2030-01-01')", [abandoned, child]);
    const refused = await f.call(owner, 'POST', `/api/boards/${f.root.id}/chat/boards`, await f.creation());
    assert.equal(refused.statusCode, 409); assert.deepEqual((await db.query('SELECT * FROM publication_schedules WHERE board_id IN ($1,$2) ORDER BY board_id,kind', [child, f.root.id])).rows, before);
    const context = await f.context(); assert.equal(context.conflictingSchedules.length, 4);
    const input = {dailySourceId: f.root.id, weeklySourceId: child, scheduleVersion: context.scheduleVersion};
    await db.query("UPDATE publication_schedules SET local_time = '21:44', updated_at = now() WHERE board_id = $1 AND kind = 'weekly'", [child]);
    assert.equal((await f.call(owner, 'POST', `/api/boards/${f.root.id}/chat/schedules/resolve`, input)).statusCode, 409);
    input.scheduleVersion = (await f.context()).scheduleVersion;
    const resolved = await f.call(owner, 'POST', `/api/boards/${f.root.id}/chat/schedules/resolve`, input);
    assert.equal(resolved.statusCode, 200, resolved.body);
    const current = await schedulesForBoard(db, owner.userId, f.root.id);
    assert.equal(current.find(value => value.kind === 'weekly')!.local_time, '21:44');
    assert.equal(current.find(value => value.kind === 'weekly')!.timezone, 'America/New_York');
    assert.equal(current.find(value => value.kind === 'daily')!.local_time, '11:00');
    assert.equal((await db.query('SELECT count(*) FROM publication_schedules WHERE board_id = $1', [child])).rows[0].count, '0');
    assert.equal((await db.query('SELECT status FROM publication_runs WHERE id=$1', [abandoned])).rows[0].status, 'uncertain');
    assert.ok((await f.call(owner, 'GET', `/api/boards/${f.root.id}/publications`)).json().deliveries.some((run: {id: string}) => run.id === abandoned));
    const orphan = randomUUID();
    await db.query("INSERT INTO publication_runs (id,board_id,kind,local_date,status,next_attempt_at) VALUES ($1,$2,'daily','2030-01-02','pending','2030-01-02')", [orphan, child]);
    assert.equal(await deliverPendingPublications(db, 'test', 'bot', new Date('2036-01-01')), true);
    assert.equal((await db.query('SELECT status FROM publication_runs WHERE id=$1', [orphan])).rows[0].status, 'cancelled');
    assert.equal(await deliverPendingPublications(db, 'test', 'bot', new Date('2036-01-01')), false, 'removed schedules must not leave a busy retry loop');
    assert.equal((await f.call(owner, 'POST', `/api/boards/${f.root.id}/chat/boards`, await f.creation())).statusCode, 200);
  } finally { await f.cleanup(); }
});
