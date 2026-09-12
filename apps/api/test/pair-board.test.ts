import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { claimAssignmentNotification, createDatabase, createTask, login, pendingNotificationForTask, runRecurrenceScheduler } from '../src/db.js';
import { deliverPendingPublications, queueDuePublications, renderPublication } from '../src/publications.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');

test('pair board: consent, capacity, access, preserved history, archive and ordinary task surfaces', async (t) => {
  const db = createDatabase(url);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const config: Config = { botToken: 'test', databaseUrl: url, sessionSecret: 'isolated-pair-test-only', initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 3600,
    host: '127.0.0.1', port: 2240, production: false, webhookSecret: 'isolated-webhook-only', publicUrl: 'https://example.test', botUsername: 'test_bot' };
  const people = await Promise.all(['Owner', 'Guest', 'Competitor'].map((first_name, index) => login(db, { id: stamp + index, first_name }, 3600, config.sessionSecret)));
  const [owner, guest, competitor] = people;
  const app = buildApp(config, db);
  const telegramCalls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    assert.ok(String(input).endsWith('/sendMessage'), 'pair boards must never check Telegram chat admins');
    assert.ok(Number(JSON.parse(String(options?.body)).chat_id) > 0, 'only personal notifications, never a group');
    telegramCalls.push('sendMessage');
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  });
  const call = (person: typeof owner, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', path: string, payload?: object) => app.inject({ method, url: path, cookies: { session: person.token }, payload });
  const personal = (await db.query("SELECT id FROM boards WHERE owner_user_id = $1 AND type = 'personal'", [guest.userId])).rows[0].id;
  let boardId = '';
  try {
    const creation = { name: 'Pair test', requestId: randomUUID() };
    const created = await Promise.all([call(owner, 'POST', '/api/boards/pair', creation), call(owner, 'POST', '/api/boards/pair', creation)]);
    assert.ok(created.every((reply) => reply.statusCode === 200));
    boardId = created[0].json().id;
    assert.equal(created[1].json().id, boardId);
    assert.equal(created[0].json().type, 'pair');
    const path = `/api/boards/${boardId}`;
    assert.equal((await db.query('SELECT telegram_chat_id FROM boards WHERE id = $1', [boardId])).rows[0].telegram_chat_id, null);
    assert.equal((await call(owner, 'POST', '/api/boards/pair', { ...creation, name: {} })).statusCode, 400);
    assert.equal((await call(owner, 'POST', '/api/boards/pair', { ...creation, requestId: 'bad' })).statusCode, 400);
    assert.equal((await call(owner, 'POST', '/api/boards/bad/archive', { archived: true })).statusCode, 400);
    assert.equal((await call(owner, 'POST', `${path}/archive`, { archived: 'true' })).statusCode, 400);
    const invite = async () => {
      const response = await call(owner, 'POST', `${path}/invites`);
      assert.equal(response.statusCode, 200);
      return new URL(response.json().url).searchParams.get('startapp')!;
    };
    const accept = (person: typeof owner, token: string) => call(person, 'POST', '/api/board-links/redeem', { token, acceptedHistory: true });
    const old = await invite();
    const token = await invite();
    assert.match(token, /^pair_[A-Za-z0-9_-]{32}$/);
    assert.equal((await accept(guest, old)).statusCode, 404);
    const preview = await call(guest, 'POST', '/api/board-links/preview', { token });
    assert.deepEqual(Object.keys(preview.json()).sort(), ['full', 'id', 'joined', 'name', 'owner_name']);
    assert.equal(preview.json().joined, false);
    assert.equal((await call(guest, 'GET', path)).statusCode, 404);
    assert.equal((await call(guest, 'POST', '/api/board-links/redeem', { token })).statusCode, 400);
    const race = await Promise.all([accept(guest, token), accept(competitor, token)]);
    assert.deepEqual(race.map((reply) => reply.statusCode).sort(), [200, 409]);
    const member = race[0].statusCode === 200 ? guest : competitor;
    const outsider = member === guest ? competitor : guest;
    assert.equal((await accept(member, token)).statusCode, 200);
    assert.equal((await call(member, 'GET', `${path}/members`)).json().members.length, 2);
    assert.equal((await call(member, 'POST', `${path}/invites`)).statusCode, 403);
    assert.equal((await call(member, 'DELETE', `${path}/invites`)).statusCode, 403);
    assert.equal((await call(member, 'DELETE', `${path}/participant`, { participantId: owner.userId })).statusCode, 403);
    assert.equal((await call(member, 'POST', `${path}/archive`, { archived: true })).statusCode, 403);
    assert.equal((await call(member, 'PATCH', path, { name: 'Forbidden' })).statusCode, 404);
    assert.equal((await call(owner, 'POST', `${path}/leave`)).statusCode, 403);
    assert.equal((await call(owner, 'POST', `${path}/activate`, { name: 'No chat' })).statusCode, 404);
    assert.equal((await call(owner, 'POST', `${path}/invites`)).statusCode, 409);
    assert.equal((await call(owner, 'DELETE', `${path}/invites`)).statusCode, 200);
    assert.equal((await accept(member, token)).statusCode, 404);
    assert.equal((await call(member, 'GET', path)).statusCode, 200, 'link revocation does not revoke existing access');

    const project = (await call(member, 'POST', `${path}/projects`, { name: 'Shared project' })).json();
    const createTaskResponse = await call(owner, 'POST', `${path}/tasks`, { title: 'Notify member', assigneeUserId: member.userId, notifyAssignee: true, projectId: project.id });
    assert.equal(createTaskResponse.statusCode, 200);
    assert.equal(telegramCalls.length, 1);
    const taskId = createTaskResponse.json().id;
    const taskPath = `${path}/tasks/${taskId}`;
    assert.equal((await call(owner, 'PATCH', taskPath, { status: 'done' })).statusCode, 403);
    assert.equal((await call(member, 'POST', `${taskPath}/comments`, { body: 'History stays' })).statusCode, 200);
    const item = (await call(member, 'POST', `${taskPath}/checklist`, { text: 'Shared item' })).json();
    assert.equal((await call(member, 'PATCH', `${taskPath}/checklist/${item.id}`, { completed: true })).statusCode, 200);
    assert.equal((await call(member, 'POST', `${taskPath}/attachments`, { kind: 'url', url: 'https://example.test' })).statusCode, 200);
    assert.equal((await call(member, 'PATCH', taskPath, { status: 'done' })).statusCode, 200);
    const backlog = (await call(member, 'POST', `${path}/tasks`, { title: 'Backlog', requestId: randomUUID() })).json();
    assert.equal((await call(owner, 'POST', `${path}/tasks/${backlog.id}/claim`)).statusCode, 200);
    for (const status of ['todo', 'in_progress', 'waiting', 'done'] as const) {
      const task = await createTask(db, member.userId, boardId, { title: status, status, assigneeUserId: member.userId, deadlineDate: '2027-03-10', deadlineTimezone: 'Europe/Moscow', ...(status === 'waiting' ? { waitReason: 'External' } : {}) });
      if (status === 'done') assert.equal((await call(member, 'DELETE', `${path}/tasks/${task.id}`)).statusCode, 200);
    }
    const rule = { title: 'Daily shared', frequency: 'daily', localTime: '09:00', timezone: 'UTC', startAt: '2027-01-01T00:00:00Z', endAt: '2027-01-02T23:59:59Z', assigneeUserId: member.userId };
    const recurrence = (await call(member, 'POST', `${path}/recurrences`, rule)).json();
    assert.ok(recurrence.id);
    await runRecurrenceScheduler(db, new Date('2027-01-01T10:00:00Z'));
    const beforeArchive = (await db.query('SELECT count(*) FROM tasks WHERE board_id = $1', [boardId])).rows[0].count;
    for (const endpoint of ['/publications', '/publications/daily', '/publications/daily/preview']) {
      const method = endpoint.endsWith('preview') ? 'POST' : endpoint.endsWith('daily') ? 'PUT' : 'GET';
      assert.equal((await call(owner, method, `${path}${endpoint}`, method === 'GET' ? undefined : {})).statusCode, 404);
    }
    assert.deepEqual(await renderPublication(db, boardId, 'daily', ['todo'], 'test_bot', 'UTC'), []);
    // Even stray scheduler records cannot publish a pair board.
    await db.query("INSERT INTO publication_schedules (board_id, kind, enabled, weekdays, local_time) VALUES ($1, 'daily', true, ARRAY[1,2,3,4,5,6,7]::smallint[], '00:00')", [boardId]);
    await queueDuePublications(db, new Date('2027-01-02T12:00:00Z'));
    assert.equal((await db.query('SELECT count(*) FROM publication_runs WHERE board_id = $1', [boardId])).rows[0].count, '0');
    await db.query("INSERT INTO publication_runs (id, board_id, kind, local_date) VALUES ($1, $2, 'daily', '2027-01-02')", [randomUUID(), boardId]);
    // Other suites can own active chat records; isolate delivery selection to this future clock boundary.
    await deliverPendingPublications(db, 'test', 'test_bot', new Date('2000-01-01T00:00:00Z'));
    assert.equal(telegramCalls.length, 1);

    assert.equal((await call(owner, 'POST', `${path}/archive`, { archived: true })).json().status, 'archived');
    await runRecurrenceScheduler(db, new Date('2027-01-02T10:00:00Z'));
    assert.equal((await db.query('SELECT count(*) FROM tasks WHERE board_id = $1', [boardId])).rows[0].count, beforeArchive);
    for (const person of [owner, member]) {
      assert.equal((await call(person, 'GET', taskPath)).statusCode, 200);
      assert.equal((await call(person, 'GET', `${taskPath}/collaboration`)).json().comments.length, 1);
      assert.equal((await call(person, 'GET', taskPath)).json().board_status, 'archived');
      for (const [method, endpoint, payload] of [
        ['POST', '/tasks', { title: 'No archived write' }], ['POST', '/projects', { name: 'No project' }],
        ['PATCH', `/projects/${project.id}`, { name: 'No rename' }], ['POST', '/recurrences', rule],
        ['PATCH', `/recurrences/${recurrence.id}`, { paused: true }], ['POST', `/tasks/${taskId}/comments`, { body: 'No comment' }],
        ['POST', `/tasks/${taskId}/attachments`, { kind: 'url', url: 'https://example.test' }],
        ['PATCH', `/tasks/${taskId}/checklist/${item.id}`, { completed: false }], ['DELETE', `/tasks/${taskId}/checklist/${item.id}`, undefined],
        ['POST', `/tasks/${taskId}/checklist`, { text: 'No item' }], ['PATCH', `/tasks/${taskId}`, { title: 'No edit' }],
        ['DELETE', `/tasks/${taskId}`, undefined], ['POST', `/tasks/${taskId}/reopen`, undefined], ['POST', `/tasks/${backlog.id}/claim`, undefined]
      ] as const) assert.ok([403, 404].includes((await call(person, method, `${path}${endpoint}`, payload)).statusCode), endpoint);
    }
    assert.equal((await call(member, 'POST', `${path}/archive`, { archived: false })).statusCode, 403);
    assert.equal((await call(owner, 'POST', `${path}/invites`)).statusCode, 403);
    assert.equal((await call(owner, 'PATCH', path, { name: 'No archived rename' })).statusCode, 404);
    assert.equal((await call(owner, 'POST', `${path}/archive`, { archived: false })).statusCode, 200);

    const pending = await createTask(db, owner.userId, boardId, { title: 'Queued notification', assigneeUserId: member.userId, notifyAssignee: true });
    const notificationId = await pendingNotificationForTask(db, pending.id);
    const beforeRemoval = (await db.query('SELECT * FROM tasks WHERE board_id = $1 ORDER BY id', [boardId])).rows;
    assert.equal((await call(owner, 'DELETE', `${path}/participant`, { participantId: member.userId })).statusCode, 200);
    const afterRemoval = (await db.query('SELECT * FROM tasks WHERE board_id = $1 ORDER BY id', [boardId])).rows;
    assert.deepEqual(afterRemoval, beforeRemoval.map((task) => task.assignee_user_id === member.userId ? { ...task, assignee_user_id: null, revision: String(BigInt(task.revision) + 1n) } : task));
    assert.equal(await claimAssignmentNotification(db, notificationId!), null);
    assert.equal((await call(member, 'GET', path)).statusCode, 404);
    assert.equal((await call(member, 'GET', taskPath)).statusCode, 403);
    assert.equal((await call(member, 'GET', `${taskPath}/collaboration`)).statusCode, 404);
    for (const endpoint of ['/tasks', '/members', '/projects', '/recurrences']) {
      const response = await call(member, 'GET', `${path}${endpoint}`);
      assert.deepEqual(Object.values(response.json())[0], []);
    }
    assert.equal((await call(member, 'PATCH', `${path}/recurrences/${recurrence.id}`, { paused: true })).statusCode, 403, 'former template creator cannot write');
    assert.equal((await call(member, 'POST', `${taskPath}/comments`, { body: 'No access' })).statusCode, 404);
    assert.equal((await call(member, 'PATCH', taskPath, { title: 'No access' })).statusCode, 403);
    const replacement = await invite();
    assert.equal((await accept(outsider, replacement)).statusCode, 200);
    assert.equal((await call(owner, 'DELETE', `${path}/participant`, { participantId: member.userId })).json().removed, false, 'retry must not revoke the replacement participant');
    assert.equal((await call(outsider, 'GET', `${taskPath}/collaboration`)).json().comments.length, 1);
    assert.equal((await call(outsider, 'GET', `${path}/tasks?archived=true`)).json().tasks.length, afterRemoval.length);
    await runRecurrenceScheduler(db, new Date('2027-01-02T10:00:00Z'));
    assert.equal((await db.query('SELECT assignee_user_id FROM tasks WHERE recurrence_template_id = $1 ORDER BY occurrence_at DESC LIMIT 1', [recurrence.id])).rows[0].assignee_user_id, null);
    assert.equal((await call(owner, 'POST', `${path}/archive`, { archived: true })).statusCode, 200);
    assert.equal((await call(member, 'GET', path)).statusCode, 404, 'archive never restores revoked access');
    assert.equal((await call(owner, 'POST', `${path}/archive`, { archived: false })).statusCode, 200);
    assert.equal((await call(outsider, 'POST', `${path}/leave`)).statusCode, 200);
    assert.equal((await accept(outsider, replacement)).statusCode, 404);
    assert.equal((await call(owner, 'GET', `${path}/members`)).json().members.length, 1);
    assert.equal((await call(owner, 'POST', `/api/boards/${personal}/archive`, { archived: true })).statusCode, 403);
    assert.equal((await call(owner, 'POST', `${path}/tasks`, { title: 'Foreign assignee', assigneeUserId: outsider.userId })).statusCode, 404);
    assert.equal((await call(owner, 'GET', `/api/boards/${personal}/tasks/${taskId}`)).statusCode, 403);
    assert.equal((await call(guest, 'GET', `/api/boards/${personal}/tasks/${taskId}`)).statusCode, 404);
    assert.equal((await db.query("SELECT type FROM boards WHERE id = $1", [personal])).rows[0].type, 'personal');
  } finally {
    await app.close();
    await db.query('DELETE FROM boards WHERE owner_user_id = ANY($1)', [people.map((person) => person.userId)]);
    await db.query('DELETE FROM users WHERE id = ANY($1)', [people.map((person) => person.userId)]);
    await db.end();
  }
});
