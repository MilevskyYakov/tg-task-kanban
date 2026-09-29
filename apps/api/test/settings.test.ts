import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase, createProject, login } from '../src/db.js';
import type { Config } from '../src/config.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');

test('settings compare-and-set preserves independent fields, rejects races and checks access', async (t) => {
  const db = createDatabase(databaseUrl!);
  const config: Config = { botToken: 'test', databaseUrl: databaseUrl!, sessionSecret: 'settings-test-secret', initDataMaxAgeSeconds: 60,
    sessionMaxAgeSeconds: 3600, host: '127.0.0.1', port: 0, production: false, webhookSecret: 'test-webhook', publicUrl: 'https://example.test', botUsername: 'test_bot' };
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const owner = await login(db, { id: stamp, first_name: 'Settings owner' }, 3600, config.sessionSecret);
  const outsider = await login(db, { id: stamp + 1, first_name: 'Settings outsider' }, 3600, config.sessionSecret);
  const boardId = randomUUID();
  const app = buildApp(config, db);
  let admin = true;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    assert.ok(String(input).endsWith('/getChatMember'));
    return Response.json({ ok: true, result: { status: admin ? 'administrator' : 'member' } });
  });
  const call = (method: 'GET' | 'PATCH' | 'PUT', path: string, payload?: object, token = owner.token) => app.inject({ method, url: path, cookies: { session: token }, payload });
  const path = `/api/boards/${boardId}`;
  try {
    await db.query("INSERT INTO boards (id,type,name,telegram_chat_id,status) VALUES ($1,'chat','Base board',$2,'active')", [boardId, -stamp]);
    await db.query("INSERT INTO memberships (board_id,user_id,role) VALUES ($1,$2,'admin')", [boardId, owner.userId]);
    await db.query("INSERT INTO publication_schedules (board_id,kind,enabled,weekdays,local_time,timezone) VALUES ($1,'daily',true,ARRAY[1]::smallint[],'09:00','UTC')", [boardId]);
    const project = await createProject(db, owner.userId, boardId, 'Base project');
    const targets = [[path, 'Base board'], [`${path}/projects/${project.id}`, 'Base project']];
    for (const [target, name] of targets) {
      const results = await Promise.all(['First', 'Second'].map((next) => call('PATCH', target, { name: next, expected: { name } })));
      assert.deepEqual(results.map((response) => response.statusCode).sort(), [200, 409]);
      assert.equal(results.find((response) => response.statusCode === 409)!.json().error, 'settings conflict');
      const current = results.find((response) => response.statusCode === 200)!.json();
      assert.equal((await call('PATCH', target, { name: 'Explicit choice', expected: { name: current.name } })).statusCode, 200);
      for (const payload of [{ name: 123 }, { name: '' }, { name: 'Bad', expected: {} }, { name: 'Bad', expected: { name: 123 } }]) {
        assert.equal((await call('PATCH', target, payload)).statusCode, 400);
      }
      assert.equal((await call('PATCH', target, { name: 'Stolen', expected: { name: 'Explicit choice' } }, outsider.token)).statusCode, 404);
      assert.equal((await call('PATCH', target, { name: 'Unauthenticated' }, '')).statusCode, 401);
    }
    const schedulePath = `${path}/publications/daily`;
    const read = async () => (await call('GET', `${path}/publications`)).json().schedules[0];
    const results = await Promise.all([
      call('PUT', schedulePath, { enabled: false, expected: { enabled: true } }),
      call('PUT', schedulePath, { timezone: 'Europe/Moscow', expected: { timezone: 'UTC' } })
    ]);
    assert.deepEqual(results.map((response) => response.statusCode), [200, 200]);
    assert.equal((await read()).enabled, false);
    assert.equal((await read()).timezone, 'Europe/Moscow');
    assert.equal((await call('PUT', schedulePath, { timezone: 'Asia/Tokyo', expected: { timezone: 'UTC' } })).statusCode, 409);
    for (const payload of [{ enabled: false, expected: {} }, { expected: { enabled: true } }, { timezone: 'Invalid/Zone', expected: { timezone: 'Europe/Moscow' } }, { included_statuses: [], expected: { included_statuses: ['todo'] } }]) {
      assert.equal((await call('PUT', schedulePath, payload)).statusCode, 400);
    }
    // Legacy full PUT/preview still accept an empty status filter. A guarded edit can repair that baseline.
    const legacy = { ...await read(), included_statuses: [] };
    assert.equal((await call('PUT', schedulePath, legacy)).statusCode, 200);
    assert.equal((await call('PUT', schedulePath, { included_statuses: ['todo'], expected: { included_statuses: [] } })).statusCode, 200);
    admin = false;
    assert.equal((await call('PATCH', path, { name: 'Denied' })).statusCode, 403);
    assert.equal((await call('PUT', schedulePath, { enabled: true, expected: { enabled: false } })).statusCode, 403);
    admin = true;
    await call('PATCH', `${path}/projects/${project.id}`, { archived: true });
    assert.equal((await call('PATCH', `${path}/projects/${project.id}`, { name: 'Late rename', expected: { name: 'Explicit choice' } })).statusCode, 404);
    for (const status of ['frozen', 'archived']) {
      await db.query('UPDATE boards SET status=$2 WHERE id=$1', [boardId, status]);
      assert.equal((await call('PATCH', path, { name: 'Late rename' })).statusCode, 404);
      assert.equal((await call('PUT', schedulePath, { enabled: true, expected: { enabled: false } })).statusCode, 403);
    }
    await db.query("UPDATE boards SET status='draft' WHERE id=$1", [boardId]);
    assert.equal((await call('PATCH', path, { name: 'Draft name', expected: { name: 'Explicit choice' } })).statusCode, 200);
    assert.equal((await db.query('SELECT status FROM boards WHERE id=$1', [boardId])).rows[0].status, 'draft', 'rename never activates');
  } finally {
    await app.close();
    await db.query('DELETE FROM boards WHERE id=$1 OR owner_user_id=ANY($2)', [boardId, [owner.userId, outsider.userId]]);
    await db.query('DELETE FROM users WHERE id=ANY($1)', [[owner.userId, outsider.userId]]);
    await db.end();
  }
});
