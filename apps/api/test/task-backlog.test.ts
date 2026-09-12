import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createDatabase, createProject, createTask, login, taskCollaboration, tasksForAssignee } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');

test('atomic backlog claim, ordinary permissions and per-line retries stay isolated', async () => {
  const db = createDatabase(url);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const config: Config = { botToken: 'test', databaseUrl: url, sessionSecret: 'isolated-test-secret-only', initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 3600,
    host: '127.0.0.1', port: 2240, production: false, webhookSecret: 'isolated-webhook-only', publicUrl: 'https://example.test', botUsername: 'test_bot' };
  const people = await Promise.all(['Owner', 'Member', 'Competitor'].map((first_name, index) => login(db, { id: stamp + index, first_name }, 3600, config.sessionSecret)));
  const [owner, member, competitor] = people;
  const boardId = randomUUID();
  const foreignBoard = (await db.query('SELECT id FROM boards WHERE owner_user_id = $1', [member.userId])).rows[0].id;
  const app = buildApp(config, db);
  try {
    await db.query("INSERT INTO boards (id, type, name, telegram_chat_id, status) VALUES ($1, 'chat', 'Backlog tests', $2, 'active')", [boardId, -stamp]);
    for (const person of people) await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'member')", [boardId, person.userId]);
    const call = (person: typeof owner, method: 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object) => app.inject({ method, url: path, cookies: { session: person.token }, payload });
    const path = (id: string) => `/api/boards/${boardId}/tasks/${id}`;
    const post = (payload: object) => call(owner, 'POST', `/api/boards/${boardId}/tasks`, payload);
    const project = await createProject(db, owner.userId, boardId, 'Batch project');
    const task = await createTask(db, owner.userId, boardId, { title: 'Claim race', projectId: project.id });
    assert.equal((await call(member, 'PATCH', path(task.id), { assigneeUserId: member.userId })).statusCode, 403);
    const race = await Promise.all([member, competitor].map((person) => call(person, 'POST', `${path(task.id)}/claim`)));
    assert.deepEqual(race.map((reply) => reply.statusCode).sort(), [200, 409]);
    const winner = race.find((reply) => reply.statusCode === 200)!.json();
    assert.equal(winner.status, 'todo');
    assert.equal(race.find((reply) => reply.statusCode === 409)!.json().task.assignee_user_id, winner.assignee_user_id);
    assert.equal((await tasksForAssignee(db, winner.assignee_user_id)).some((item) => item.id === task.id), true);
    const history = (await taskCollaboration(db, owner.userId, boardId, task.id))!.timeline;
    assert.equal(history.filter((item) => item.action === 'claimed').length, 1);
    assert.equal(history.find((item) => item.action === 'claimed')!.before_data.assignee_user_id, null);
    assert.equal(history.find((item) => item.action === 'claimed')!.after_data.assignee_user_id, winner.assignee_user_id);
    for (const person of [member, competitor]) assert.equal((await call(person, 'POST', `${path(task.id)}/claim`)).statusCode, 409);
    assert.equal((await call(owner, 'PATCH', path(task.id), { status: 'done' })).statusCode, 403);
    assert.equal((await call(owner, 'PATCH', path(task.id), { assigneeUserId: owner.userId })).statusCode, 200);

    for (const status of ['in_progress', 'waiting', 'done'] as const) {
      const item = await createTask(db, owner.userId, boardId, { title: status, status, ...(status === 'waiting' ? { waitReason: 'External' } : {}) });
      assert.equal((await call(member, 'POST', `${path(item.id)}/claim`)).statusCode, 409);
      assert.equal((await db.query('SELECT status FROM tasks WHERE id = $1', [item.id])).rows[0].status, status);
    }
    const archived = await createTask(db, owner.userId, boardId, { title: 'Archive' });
    await call(owner, 'DELETE', path(archived.id));
    assert.equal((await call(member, 'POST', `${path(archived.id)}/claim`)).statusCode, 409);
    const foreign = await createTask(db, member.userId, foreignBoard, { title: 'Foreign' });
    assert.equal((await call(owner, 'POST', `/api/boards/${foreignBoard}/tasks/${foreign.id}/claim`)).statusCode, 403);
    assert.equal((await call(owner, 'POST', `${path(foreign.id)}/claim`)).statusCode, 404);
    assert.equal((await call(owner, 'POST', `${path('malformed')}/claim`)).statusCode, 400);

    const lines = [0, 1, 2].map(() => ({ title: 'Intentional duplicate', projectId: project.id, requestId: randomUUID() }));
    const first = await post(lines[0]); // The caller can lose this response; replay still resolves the same row.
    const rejected = await post({ ...lines[1], projectId: foreignBoard });
    assert.equal(rejected.statusCode, 404);
    const third = await post(lines[2]);
    const retry = await Promise.all([post(lines[0]), post(lines[1]), post(lines[2]), post(lines[0])]);
    assert.ok(retry.every((reply) => reply.statusCode === 200));
    assert.equal(retry[0].json().id, first.json().id);
    assert.equal(retry[2].json().id, third.json().id);
    assert.equal(new Set(retry.map((reply) => reply.json().id)).size, 3);
    assert.equal((await post({ ...lines[0], title: 'Changed payload' })).statusCode, 409);
    const batch = (await db.query('SELECT * FROM tasks WHERE board_id = $1 AND create_request_id = ANY($2::uuid[])', [boardId, lines.map((line) => line.requestId)])).rows;
    assert.equal(batch.length, 3);
    assert.ok(batch.every((item) => item.project_id === project.id && !item.assignee_user_id && !item.deadline && !item.deadline_date && item.status === 'todo'));

    await db.query("UPDATE boards SET status = 'frozen' WHERE id = $1", [boardId]);
    assert.equal((await call(member, 'POST', `${path(task.id)}/claim`)).statusCode, 403);
    assert.equal((await post(lines[0])).statusCode, 404);
    await db.query("UPDATE boards SET status = 'active' WHERE id = $1", [boardId]);
    await db.query('DELETE FROM memberships WHERE board_id = $1 AND user_id = $2', [boardId, owner.userId]);
    assert.equal((await call(owner, 'POST', `${path(task.id)}/claim`)).statusCode, 403);
    assert.equal((await post(lines[0])).statusCode, 404);
    assert.equal((await call(owner, 'PATCH', path(task.id), { title: 'Revoked creator and assignee' })).statusCode, 403);
    assert.equal((await call(owner, 'DELETE', path(task.id))).statusCode, 403);
  } finally {
    await app.close();
    await db.query('DELETE FROM boards WHERE id = $1 OR owner_user_id = ANY($2)', [boardId, people.map((person) => person.userId)]);
    await db.query('DELETE FROM users WHERE id = ANY($1)', [people.map((person) => person.userId)]);
    await db.end();
  }
});
