import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from '../src/app.js';
import { createDatabase, createTask, login } from '../src/db.js';
import type { Config } from '../src/config.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const rollbackModule = process.env.ROLLBACK_APP_MODULE;
if (!databaseUrl || !rollbackModule) throw new Error('TEST_DATABASE_URL and ROLLBACK_APP_MODULE are required');
const database = new URL(databaseUrl);
if (database.hostname !== '127.0.0.1' || !/^\/tasca_rehearsal_\w+$/.test(database.pathname)) throw new Error('Cutover rehearsal requires a dedicated loopback tasca_rehearsal_* database');
const { buildApp: buildRollbackApp } = await import(pathToFileURL(rollbackModule).href) as { buildApp: typeof buildApp };

// Synthetic records intentionally remain for a subsequent dump/restore comparison.
test('old version -> candidate on two origins -> old version retains new tasks, grants and existing MCP key', async () => {
  const db = createDatabase(databaseUrl!);
  let target = '';
  const proxies: Server[] = [];
  const proxy = async () => {
    const server = createServer((request, response) => {
      const upstream = httpRequest(target + request.url, { method: request.method, headers: request.headers }, (result) => {
        response.writeHead(result.statusCode!, result.headers); result.pipe(response);
      });
      upstream.on('error', () => { response.writeHead(502); response.end(); });
      request.pipe(upstream);
    });
    proxies.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  };
  const oldOrigin = await proxy();
  const newOrigin = await proxy();
  const config: Config = { botToken: 'synthetic-same-bot', databaseUrl: databaseUrl!, sessionSecret: 'synthetic-session-secret', initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 3600,
    host: '127.0.0.1', port: 0, production: true, webhookSecret: 'synthetic-webhook-secret', publicUrl: oldOrigin, botUsername: 'existing_test_bot' };
  const old = buildRollbackApp(config, db);
  const next = buildApp({ ...config, publicUrl: newOrigin, publicUrlAliases: [oldOrigin] }, db);
  const rollback = buildRollbackApp(config, db);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const clients: Client[] = [];
  const initData = (token = config.botToken) => {
    const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: stamp, first_name: 'Synthetic cutover' }) });
    const check = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
    return params.toString();
  };
  const authenticate = async (origin: string) => {
    const response = await fetch(origin + '/api/auth/telegram', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: initData() }), redirect: 'manual' });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/i); assert.match(cookie, /Secure/i); assert.match(cookie, /SameSite=Strict/i); assert.doesNotMatch(cookie, /Domain=/i);
    return { userId: (await response.json() as {userId: string}).userId, cookie: cookie.split(';')[0] };
  };
  const connect = async (origin: string, key: string) => {
    const client = new Client({ name: 'cutover-rehearsal', version: '1.0.0' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + key } } }));
    return client;
  };
  try {
    target = await old.listen({ host: '127.0.0.1', port: 0 });
    const person = await authenticate(oldOrigin);
    const boardId = (await db.query('SELECT id FROM boards WHERE owner_user_id=$1', [person.userId])).rows[0].id;
    const before = await createTask(db, person.userId, boardId, { title: 'Before cutover' });
    const outsider = await login(db, { id: stamp + 1, first_name: 'Synthetic outsider' }, 3600, config.sessionSecret);
    const issued = await fetch(oldOrigin + '/api/mcp-connections', { method: 'POST', headers: { origin: oldOrigin, cookie: person.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), name: 'Existing key', mode: 'write', boardIds: [boardId] }) });
    assert.equal(issued.status, 201);
    const { key } = await issued.json() as {key: string};
    const initial = await connect(oldOrigin, key);
    assert.equal(((await initial.callTool({ name: 'get_task', arguments: { boardId, taskId: before.id } })).structuredContent as {ok: boolean}).ok, true);
    await initial.close();

    target = await next.listen({ host: '127.0.0.1', port: 0 });
    await old.close();
    for (const origin of [oldOrigin, newOrigin]) {
      assert.equal((await authenticate(origin)).userId, person.userId);
      const health = await fetch(origin + '/health', { redirect: 'manual' }); assert.equal(health.status, 200);
      assert.equal(health.headers.get('location'), null);
      const webhook = await fetch(origin + '/api/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': config.webhookSecret }, body: JSON.stringify({ update_id: stamp }) });
      assert.equal(webhook.status, 200);
      const invalid = await fetch(origin + '/api/auth/telegram', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: initData('different-bot') }) });
      assert.equal(invalid.status, 401, 'a different bot identity is NOT silently accepted');
      assert.equal((await fetch(origin + `/api/boards/${boardId}`, { headers: { cookie: `session=${outsider.token}` } })).status, 404);
      const management = await fetch(origin + '/api/mcp-connections', { headers: { cookie: person.cookie, origin } });
      assert.equal(management.status, 200);
      assert.equal(management.headers.get('access-control-allow-origin'), null);
      const wrongOrigin = origin === oldOrigin ? newOrigin : oldOrigin;
      assert.equal((await fetch(origin + '/api/mcp-connections', { method: 'POST', headers: { cookie: person.cookie, origin: wrongOrigin, 'content-type': 'application/json' }, body: '{}' })).status, 403);
      assert.equal((await fetch(origin + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + key, origin: 'https://evil.invalid', 'content-type': 'application/json' }, body: '{}' })).status, 403);
      const client = await connect(origin, key);
      const result = await client.callTool({ name: 'get_task', arguments: { boardId, taskId: before.id } });
      assert.equal((result.structuredContent as {ok: boolean}).ok, true);
      await client.close();
    }
    assert.equal((await next.inject({ method: 'POST', url: '/mcp', headers: { host: 'evil.invalid', authorization: 'Bearer ' + key }, payload: {} })).statusCode, 403);
    const writer = await connect(newOrigin, key);
    const created = await writer.callTool({ name: 'create_task', arguments: { boardId, requestId: randomUUID(), title: 'After cutover' } });
    const after = (created.structuredContent as {ok: boolean; task: {id: string}});
    assert.equal(after.ok, true);
    await writer.close();

    target = await rollback.listen({ host: '127.0.0.1', port: 0 });
    await next.close();
    assert.equal((await authenticate(oldOrigin)).userId, person.userId);
    const reader = await connect(oldOrigin, key);
    for (const id of [before.id, after.task.id]) {
      const result = await reader.callTool({ name: 'get_task', arguments: { boardId, taskId: id } });
      assert.equal((result.structuredContent as {ok: boolean}).ok, true);
    }
    const denied = await fetch(oldOrigin + `/api/boards/${boardId}`, { headers: { cookie: `session=${outsider.token}` } });
    assert.equal(denied.status, 404);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM tasks WHERE board_id=$1', [boardId])).rows[0].count, 2);
  } finally {
    for (const client of clients) await client.close();
    await old.close(); await next.close(); await rollback.close();
    for (const server of proxies) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    await db.end();
  }
});
