import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createDatabase, createRecurrence, createTask, login, runRecurrenceScheduler, taskForBoard, tasksForBoard, updateRecurrence, updateTask, updateTaskAndFuture } from '../src/db.js';
import { compareTaskPriority, defaultFilters, filterTasks, type Task } from '../../web/src/tasks.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const legacyHash = (prefix: string, input: unknown) => createHash('sha256').update(prefix + JSON.stringify(input, (_key, value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest('hex');

test('assessment contract on migrated PostgreSQL, HTTP, MCP and web ordering', async t => {
  const setup = createDatabase(url);
  const schema = `assessment_${randomUUID().replaceAll('-', '')}`;
  await setup.query(`CREATE SCHEMA ${schema}`);
  const databaseUrl = new URL(url);
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const db = createDatabase(databaseUrl.toString());
  const config: Config = { botToken: 'test', databaseUrl: databaseUrl.toString(), sessionSecret: 'isolated-assessment-secret', initDataMaxAgeSeconds: 60,
    sessionMaxAgeSeconds: 3600, host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-assessment-webhook', publicUrl: 'https://example.test', botUsername: 'test_bot' };
  const app = buildApp(config, db);
  const clients: Client[] = [];
  try {
    const migrations = new URL('../migrations/', import.meta.url);
    const migration = await readFile(new URL('016_task_assessment.sql', migrations), 'utf8');
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql') && name !== '016_task_assessment.sql').sort()) await db.query(await readFile(new URL(file, migrations), 'utf8'));
    const stamp = randomBytes(6).readUIntBE(0, 6);
    const owner = await login(db, { id: stamp, first_name: 'Assessment' }, 3600, config.sessionSecret);
    const outsider = await login(db, { id: stamp + 1, first_name: 'Outsider' }, 3600, config.sessionSecret);
    const boardId = (await db.query('SELECT id FROM boards WHERE owner_user_id=$1', [owner.userId])).rows[0].id;
    const path = `/api/boards/${boardId}/tasks`;
    const cookies = { session: owner.token };
    const pairs = ([true, false, null] as const).flatMap(importance => ([true, false, null] as const).map(urgency => ({ importance, urgency })));
    const task = (id: string) => taskForBoard(db, owner.userId, boardId, id);
    const patch = (id: string, payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `${path}/${id}`, cookies, payload });

    await t.test('legacy backfill runs once and preserves history, deadlines and template linkage', async () => {
      for (const priority of ['urgent', 'normal']) {
        const templateId = randomUUID();
        await db.query(`INSERT INTO recurrence_templates (id,board_id,creator_user_id,title,priority,frequency,local_time,timezone,starts_at)
          VALUES ($1,$2,$3,$4,$4,'daily','09:00','UTC','2099-01-01')`, [templateId, boardId, owner.userId, priority]);
        const id = randomUUID();
        await db.query(`INSERT INTO tasks (id,board_id,creator_user_id,title,priority,deadline,recurrence_template_id,occurrence_at)
          VALUES ($1,$2,$3,$4,$4,'2099-01-01',$5,'2099-01-01')`, [id, boardId, owner.userId, priority, templateId]);
        await db.query(`INSERT INTO task_audit_events (id,board_id,task_id,actor_user_id,action,after_data) VALUES ($1,$2,$3,$4,'created',$5)`, [randomUUID(), boardId, id, owner.userId, { priority }]);
      }
      const before = (await db.query('SELECT * FROM task_audit_events ORDER BY id')).rows;
      const legacy = (await db.query('SELECT * FROM tasks ORDER BY id')).rows;
      await db.query(migration);
      for (const previous of legacy) {
        const current = (await task(previous.id))!;
        assert.equal(current.importance, null);
        assert.equal(current.urgency, previous.priority === 'urgent' ? true : null);
        assert.deepEqual(current.deadline, previous.deadline);
        assert.equal(current.recurrence_template_id, previous.recurrence_template_id);
        if (previous.priority === 'urgent') assert.ok(BigInt(current.version) > BigInt(previous.revision));
      }
      assert.deepEqual((await db.query('SELECT * FROM task_audit_events ORDER BY id')).rows, before);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM task_assignment_notifications')).rows[0].n, 0);
      for (const row of (await db.query('SELECT * FROM recurrence_templates')).rows) assert.equal(row.urgency, row.priority === 'urgent' ? true : null);
      await db.query('UPDATE tasks SET urgency=NULL, priority=\'normal\'');
      await db.query('UPDATE recurrence_templates SET urgency=NULL, priority=\'normal\'');
      await db.query(migration);
      assert.ok((await db.query('SELECT urgency FROM tasks UNION ALL SELECT urgency FROM recurrence_templates')).rows.every(row => row.urgency === null));
    });

    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    config.publicUrl = origin;
    const connect = async (mode: 'read' | 'write') => {
      const response = await app.inject({ method: 'POST', url: '/api/mcp-connections', cookies, headers: { host: new URL(origin).host, origin }, payload: { requestId: randomUUID(), name: `Assessment ${mode}`, mode, boardIds: [boardId] } });
      assert.equal(response.statusCode, 201);
      const client = new Client({ name: 'assessment-test', version: '1.0.0' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), { requestInit: { headers: { Authorization: `Bearer ${response.json().key}` } } }));
      return client;
    };
    const writer = await connect('write');
    const reader = await connect('read');
    const call = async (name: string, args: Record<string, unknown>, client = writer) => (await client.callTool({ name, arguments: { boardId, ...args } })).structuredContent as any;
    await t.test('nine values round-trip through HTTP and MCP; false and explicit null remain distinct', async () => {
      for (const pair of pairs) {
        const response = await app.inject({ method: 'POST', url: path, cookies, payload: { title: `Pair ${pair.importance}/${pair.urgency}`, ...pair } });
        assert.equal(response.statusCode, 200, response.body);
        const created = response.json();
        const read = await call('get_task', { taskId: created.id });
        for (const key of ['importance', 'urgency'] as const) assert.equal(read[key], pair[key]);
        assert.equal(created.priority, pair.urgency === true ? 'urgent' : 'normal');
        const viaMcp = await call('create_task', { requestId: randomUUID(), title: 'MCP pair', ...pair });
        assert.equal(viaMcp.ok, true, JSON.stringify(viaMcp));
        const restored = (await task(viaMcp.task.id))!;
        assert.equal(restored.importance, pair.importance); assert.equal(restored.urgency, pair.urgency);
      }
      for (const value of ['false', 0, [], {}]) {
        assert.equal((await app.inject({ method: 'POST', url: path, cookies, payload: { title: 'Invalid', importance: value } })).statusCode, 400);
        assert.equal((await call('create_task', { requestId: randomUUID(), title: 'Invalid', urgency: value })).error.code, 'INVALID_ARGUMENT');
      }
    });

    await t.test('legacy echo, no-version rejection, contradiction, reset and concurrent changes are atomic', async () => {
      const created = await createTask(db, owner.userId, boardId, { title: 'Legacy', importance: true });
      assert.equal((await patch(created.id, { priority: 'normal', title: 'Echo' })).statusCode, 200);
      assert.equal((await task(created.id))!.urgency, null);
      let current = (await task(created.id))!;
      for (const payload of [{ priority: 'urgent' }, { urgency: true }, { importance: false }]) {
        assert.equal((await patch(created.id, { ...payload, title: 'Do not persist' })).statusCode, 409);
        assert.deepEqual(await task(created.id), current);
      }
      assert.equal((await patch(created.id, { expectedVersion: current.version, urgency: true, priority: 'normal' })).statusCode, 400);
      const results = await Promise.all([patch(created.id, { expectedVersion: current.version, urgency: true }), patch(created.id, { expectedVersion: current.version, importance: false })]);
      assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
      current = (await task(created.id))!;
      const changed = await patch(created.id, { expectedVersion: current.version, urgency: true, importance: true });
      current = changed.json();
      assert.equal((await patch(created.id, { priority: 'normal', expectedVersion: current.version })).statusCode, 200);
      current = (await task(created.id))!;
      assert.equal(current.urgency, false); assert.equal(current.importance, true);
      const reset = await patch(created.id, { expectedVersion: current.version, importance: null, urgency: null });
      assert.equal(reset.statusCode, 200);
      assert.equal(BigInt(reset.json().version), BigInt(current.version) + 1n);
      assert.equal(reset.json().importance, null); assert.equal(reset.json().urgency, null);
      assert.equal(reset.json().status, current.status); assert.deepEqual(reset.json().deadline, current.deadline);
      assert.equal((await patch(created.id, { expectedVersion: current.version, importance: false })).statusCode, 409, 'lost response cannot replay old revision');
      const audit = (await db.query("SELECT after_data FROM task_audit_events WHERE task_id=$1 AND action='updated' ORDER BY created_at DESC LIMIT 1", [created.id])).rows[0];
      assert.equal(audit.after_data.importance, null); assert.equal(audit.after_data.urgency, null);
    });

    await t.test('MCP receipts preserve legacy defaults and reject changed intent', async () => {
      const input = { requestId: randomUUID(), title: 'Legacy intent' };
      const first = await call('create_task', input);
      assert.equal(first.ok, true);
      const receipt = (await db.query('SELECT request_hash FROM mcp_write_receipts WHERE request_id=$1', [input.requestId])).rows[0];
      assert.equal(receipt.request_hash, legacyHash('create_task', { ...input, boardId, priority: 'normal', deadline: { kind: 'none' }, status: 'todo' }));
      assert.equal((await call('create_task', { ...input, priority: 'normal' })).replayed, true);
      assert.equal((await call('create_task', { ...input, urgency: null })).error.code, 'REQUEST_CONFLICT');
      const edit = { taskId: first.task.id, requestId: randomUUID(), expectedVersion: first.task.version, changes: { importance: false, urgency: true } };
      assert.equal((await call('update_task', edit)).ok, true);
      assert.equal((await call('update_task', edit)).replayed, true);
      assert.equal((await call('update_task', { ...edit, changes: { importance: true } })).error.code, 'REQUEST_CONFLICT');
      assert.equal((await call('update_task', { ...edit, requestId: randomUUID() })).error.code, 'VERSION_CONFLICT');
    });

    await t.test('SQL/web/MCP sort agree at microseconds, date-only DST and every filter; cursors are lossless', async () => {
      for (const [index, due] of [{ deadlineDate: '2026-03-08', deadlineTimezone: 'America/New_York' }, { deadline: '2026-03-09T04:00:00.000Z' }, {}].entries()) {
        const row = await createTask(db, owner.userId, boardId, { title: `Tie ${index}`, importance: true, urgency: true, ...due });
        await db.query("UPDATE tasks SET created_at='2026-01-01T00:00:00.000001Z' WHERE id=$1", [row.id]);
      }
      const all = await tasksForBoard(db, owner.userId, boardId);
      const dated = all.find(row => row.deadline_date === '2026-03-08')!;
      assert.equal(dated.priority_key[2], '2026-03-09T04:00:00.000000Z');
      assert.equal(dated.priority_key[3], '2026-01-01T00:00:00.000001Z');
      for (const options of [{}, { unassessed: true }, { urgency: 'true', unassessed: true }, { importance: 'false' }, { urgency: 'unassessed' }]) {
        const args = { ...options, sort: 'priority', limit: 2 };
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await call('list_tasks', { ...args, ...(cursor ? { cursor } : {}) });
          assert.equal(page.ok, true, JSON.stringify(page));
          ids.push(...page.items.map((row: any) => row.id));
          cursor = page.nextCursor ?? undefined;
          assert.ok(ids.length <= all.length, 'cursor must advance without duplicates');
        } while (cursor);
        const expected = filterTasks(all as Task[], { ...defaultFilters, scope: 'all', ...options } as any, owner.userId).sort(compareTaskPriority).map(row => row.id);
        assert.deepEqual(ids, expected); assert.equal(new Set(ids).size, ids.length);
      }
      const first = await call('list_tasks', { limit: 2 });
      const legacyCursor = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
      const connectionId = (await db.query("SELECT id FROM mcp_connections WHERE user_id=$1 AND mode='write'", [owner.userId])).rows[0].id;
      assert.deepEqual(Object.keys(legacyCursor).sort(), ['after','createdAt','fingerprint']);
      assert.equal(legacyCursor.fingerprint, legacyHash(connectionId + 'list_tasks', { boardId, archived: false, limit: 2 }));
      const next = await call('list_tasks', { limit: 2, cursor: first.nextCursor });
      assert.equal(next.ok, true); assert.ok(next.items.every((row: any) => !first.items.some((previous: any) => previous.id === row.id)));
      assert.equal((await call('list_tasks', { limit: 2, cursor: first.nextCursor, sort: 'priority' })).error.code, 'INVALID_CURSOR');
      assert.equal((await call('list_tasks', { limit: 2, cursor: first.nextCursor, urgency: 'false' })).error.code, 'INVALID_CURSOR');
    });

    await t.test('template version gates future apply, rollback covers task and audit, scheduler copies assessment', async () => {
      const series = await createRecurrence(db, owner.userId, boardId, { title: 'Series', importance: true, urgency: false, frequency: 'daily', localTime: '09:00', timezone: 'UTC', startAt: '2026-01-01T09:00:00Z' });
      await runRecurrenceScheduler(db, new Date('2026-01-01T09:00:00Z'));
      const instance = (await tasksForBoard(db, owner.userId, boardId)).find(row => row.recurrence_template_id === series.id)!;
      assert.equal(instance.importance, true); assert.equal(instance.urgency, false); assert.equal(instance.recurrence_version, series.version);
      await updateTask(db, owner.userId, boardId, instance.id, { importance: false, expectedVersion: instance.version });
      assert.equal((await db.query('SELECT importance FROM recurrence_templates WHERE id=$1', [series.id])).rows[0].importance, true);
      await assert.rejects(() => updateRecurrence(db, owner.userId, boardId, series.id, { importance: false }), /expectedVersion/);
      const updated = await updateRecurrence(db, owner.userId, boardId, series.id, { importance: null, expectedVersion: series.version });
      const current = (await task(instance.id))!;
      const audits = (await db.query('SELECT * FROM task_audit_events ORDER BY id')).rows;
      await assert.rejects(() => updateTaskAndFuture(db, owner.userId, boardId, instance.id, { title: 'Must roll back', importance: false, urgency: true, expectedVersion: current.version, expectedRecurrenceVersion: series.version }), /version conflict/);
      assert.deepEqual(await task(instance.id), current); assert.deepEqual((await db.query('SELECT * FROM task_audit_events ORDER BY id')).rows, audits);
      await updateTaskAndFuture(db, owner.userId, boardId, instance.id, { importance: false, urgency: true, expectedVersion: current.version, expectedRecurrenceVersion: updated.version });
      await runRecurrenceScheduler(db, new Date('2026-01-02T09:00:00Z'));
      const next = (await tasksForBoard(db, owner.userId, boardId)).find(row => row.recurrence_template_id === series.id && row.id !== instance.id)!;
      assert.equal(next.importance, false); assert.equal(next.urgency, true);
      const listed = await call('list_recurrences', {});
      const template = listed.items.find((row: any) => row.id === series.id);
      assert.equal(template.importance, false); assert.equal(template.urgency, true); assert.ok(template.version);
      assert.equal((await call('update_recurrence', { recurrenceId: series.id, requestId: randomUUID(), urgency: null })).error.code, 'VERSION_CONFLICT');
    });

    await t.test('assessment writes keep board, archive and read-only boundaries', async () => {
      const row = await createTask(db, owner.userId, boardId, { title: 'Protected' });
      assert.equal((await app.inject({ method: 'PATCH', url: `${path}/${row.id}`, cookies: { session: outsider.token }, payload: { importance: true, expectedVersion: row.version } })).statusCode, 403);
      assert.equal((await call('update_task', { taskId: row.id, requestId: randomUUID(), expectedVersion: row.version, changes: { importance: true } }, reader)).error.code, 'READ_ONLY');
      await db.query('UPDATE tasks SET archived_at=now() WHERE id=$1', [row.id]);
      const archivedVersion = (await db.query('SELECT revision::text AS version FROM tasks WHERE id=$1', [row.id])).rows[0].version;
      assert.equal((await patch(row.id, { importance: true, expectedVersion: archivedVersion })).statusCode, 403);
      await db.query("UPDATE boards SET status='frozen' WHERE id=$1", [boardId]);
      assert.equal((await app.inject({ method: 'POST', url: path, cookies, payload: { title: 'Forbidden', urgency: true } })).statusCode, 404);
    });
  } finally {
    for (const client of clients) await client.close();
    await app.close(); await db.end();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.end();
  }
});
