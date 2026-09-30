import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createDatabase, createProject, createRecurrence, createTask, login, taskForBoard, updateProject, updateRecurrence, updateTask, updateTaskAndFuture } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const rule = { frequency: 'daily' as const, localTime: '09:00', timezone: 'UTC', startAt: '2099-01-01T09:00:00Z' };

for (const transport of ['DB', 'REST', 'MCP'] as const) for (const kind of ['task', 'recurrence'] as const) {
  test(`archived project preserves ${kind} management through ${transport}`, async () => {
    const db = createDatabase(url);
    const config: Config = { botToken: 'test', databaseUrl: url, sessionSecret: 'isolated-project-archive-secret', initDataMaxAgeSeconds: 60,
      sessionMaxAgeSeconds: 3600, host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-project-archive-webhook',
      publicUrl: 'https://example.test', botUsername: 'test_bot' };
    const stamp = randomBytes(6).readUIntBE(0, 6);
    const [owner, member, outsider] = await Promise.all(['Owner', 'Member', 'Outsider'].map((first_name, i) => login(db, { id: stamp + i, first_name }, 3600, config.sessionSecret)));
    const boardId = (await db.query('SELECT id FROM boards WHERE owner_user_id=$1', [owner.userId])).rows[0].id;
    const foreignBoardId = (await db.query('SELECT id FROM boards WHERE owner_user_id=$1', [outsider.userId])).rows[0].id;
    const app = buildApp(config, db);
    const clients: Client[] = [];
    try {
      await db.query("INSERT INTO memberships (board_id,user_id,role) VALUES ($1,$2,'member')", [boardId, member.userId]);
      const project = await createProject(db, owner.userId, boardId, 'Historical project');
      const active = await createProject(db, owner.userId, boardId, 'Active project');
      const foreign = await createProject(db, outsider.userId, foreignBoardId, 'Foreign project');
      const recurrence = await createRecurrence(db, owner.userId, boardId, { ...rule, title: 'Original series', projectId: project.id });
      const task = await createTask(db, owner.userId, boardId, { title: 'Original task', projectId: project.id });
      await db.query('UPDATE tasks SET recurrence_template_id=$2, occurrence_at=$3 WHERE id=$1', [task.id, recurrence.id, rule.startAt]);
      const target = kind === 'task' ? task : recurrence;
      const table = kind === 'task' ? 'tasks' : 'recurrence_templates';
      const path = `/api/boards/${boardId}/${kind === 'task' ? 'tasks' : 'recurrences'}/${target.id}`;
      const read = async () => (await db.query(`SELECT * FROM ${table} WHERE id=$1`, [target.id])).rows[0];
      const version = async () => String((await read()).revision);
      const snapshot = async () => ({ row: await read(),
        audit: (await db.query('SELECT * FROM task_audit_events WHERE board_id=$1 ORDER BY id', [boardId])).rows,
        notifications: (await db.query('SELECT * FROM task_assignment_notifications WHERE task_id=$1 ORDER BY id', [task.id])).rows,
        receipts: (await db.query('SELECT * FROM mcp_write_receipts WHERE board_id=$1 ORDER BY request_id', [boardId])).rows });
      const writers = new Map<string, Client>();
      let reader: Client | undefined;
      if (transport === 'MCP') {
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        config.publicUrl = origin;
        const connect = async (person: typeof owner, mode: 'write' | 'read') => {
          const response = await app.inject({ method: 'POST', url: '/api/mcp-connections', cookies: { session: person.token },
            headers: { host: new URL(origin).host, origin }, payload: { requestId: randomUUID(), name: 'Archive regression', mode,
              boardIds: [person === outsider ? foreignBoardId : boardId] } });
          assert.equal(response.statusCode, 201);
          const client = new Client({ name: 'project-archive-test', version: '1.0.0' });
          clients.push(client);
          await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), { requestInit: { headers: { Authorization: `Bearer ${response.json().key}` } } }));
          return client;
        };
        for (const person of [owner, member, outsider]) writers.set(person.userId, await connect(person, 'write'));
        reader = await connect(owner, 'read');
      }
      const call = async (client: Client, name: string, args: Record<string, unknown>) =>
        (await client.callTool({ name, arguments: args })).structuredContent as any;
      const change = async (input: Record<string, any>, expected: 'ok' | 'denied' | 'version' = 'ok', person = owner, destination = boardId) => {
        const before = await snapshot();
        if (transport === 'DB') {
          const action = () => kind === 'task' ? updateTask(db, person.userId, destination, target.id, input) : updateRecurrence(db, person.userId, destination, target.id, input);
          if (expected === 'version') await assert.rejects(action, /version conflict/);
          else assert.equal(Boolean(await action()), expected === 'ok');
        } else if (transport === 'REST') {
          const response = await app.inject({ method: 'PATCH', url: path.replace(boardId, destination), cookies: { session: person.token }, payload: input });
          assert.equal(response.statusCode, expected === 'ok' ? 200 : expected === 'version' ? 409 : 403, response.body);
        } else {
          const { expectedVersion, ...changes } = input;
          const args = { boardId: destination, requestId: randomUUID(),
            ...(kind === 'task' ? { taskId: target.id, expectedVersion: expectedVersion ?? await version(), changes } : { recurrenceId: target.id, ...changes }) };
          const result = await call(writers.get(person.userId)!, `update_${kind}`, args);
          if (expected === 'ok') {
            assert.equal(result.ok, true, JSON.stringify(result));
            const saved = await snapshot();
            assert.equal((await call(writers.get(person.userId)!, `update_${kind}`, args)).replayed, true);
            assert.deepEqual(await snapshot(), saved, 'receipt replay does not duplicate effects');
          }
          else assert.equal(result.error.code, expected === 'version' ? 'VERSION_CONFLICT'
            : person === outsider || destination !== boardId || kind === 'recurrence' ? 'NOT_FOUND' : 'ACTION_FORBIDDEN');
        }
        if (expected !== 'ok') assert.deepEqual(await snapshot(), before, 'denied operation has no persisted effects');
      };
      await updateProject(db, owner.userId, boardId, project.id, { archived: true });
      assert.ok((await db.query('SELECT archived_at FROM projects WHERE id=$1', [project.id])).rows[0].archived_at);
      await change(kind === 'task' ? { title: 'Edited after archive' } : { paused: true });
      assert.equal(kind === 'task' ? (await read()).title : Boolean((await read()).paused_at), kind === 'task' ? 'Edited after archive' : true);
      for (const projectId of [project.id, project.id.toUpperCase()]) {
        await change({ title: 'Historical link kept', projectId, description: 'Independent edit', priority: 'urgent' });
        const row = await read();
        assert.equal(row.project_id, project.id, 'same UUID is historical, including uppercase input');
        assert.equal(row.description, 'Independent edit');
        assert.equal(row.priority, 'urgent');
      }
      assert.equal((await taskForBoard(db, owner.userId, boardId, task.id))!.project_name, project.name);
      if (transport === 'REST') {
        const projects = await app.inject({ method: 'GET', url: `/api/boards/${boardId}/projects?archived=true`, cookies: { session: owner.token } });
        assert.equal(projects.json().projects.find((item: any) => item.id === project.id).name, project.name);
      } else if (transport === 'MCP') {
        const projects = await call(writers.get(owner.userId)!, 'list_projects', { boardId, archived: true });
        assert.equal(projects.items.find((item: any) => item.id === project.id).name, project.name);
        const stored = await call(writers.get(owner.userId)!, kind === 'task' ? 'get_task' : 'list_recurrences', { boardId, ...(kind === 'task' ? { taskId: target.id } : {}) });
        assert.equal((kind === 'task' ? stored : stored.items.find((item: any) => item.id === target.id)).projectId, project.id);
      }
      if (kind === 'task') {
        const oldVersion = await version();
        await change({ status: 'done', expectedVersion: oldVersion });
        assert.equal((await read()).status, 'done');
        await change({ title: 'Stale edit', expectedVersion: oldVersion }, 'version');
        await change({ status: 'in_progress' }, 'ok', member);
        assert.equal((await read()).status, 'in_progress');
        // The explicit series path resends projectId even when it has not changed.
        if (transport === 'DB') assert.ok(await updateTaskAndFuture(db, owner.userId, boardId, task.id, { title: 'Applied to series', projectId: project.id }));
        if (transport === 'REST') assert.equal((await app.inject({ method: 'PATCH', url: `${path}?scope=future`, cookies: { session: owner.token }, payload: { title: 'Applied to series', projectId: project.id } })).statusCode, 200);
        if (transport !== 'MCP') assert.equal((await db.query('SELECT title FROM recurrence_templates WHERE id=$1', [recurrence.id])).rows[0].title, 'Applied to series');
      } else {
        await change({ archived: true });
        assert.ok((await read()).archived_at);
        assert.equal((await read()).next_occurrence_at, null);
        await change({ archived: false, paused: false, localTime: '10:00' });
        assert.equal((await read()).paused_at, null);
        assert.equal((await read()).archived_at, null);
        assert.ok((await read()).next_occurrence_at);
        await change({ paused: true }, 'denied', member);
        await change({ assigneeUserId: member.userId });
        await change({ paused: true }, 'ok', member);
      }
      await change({ title: 'Outsider edit' }, 'denied', outsider);
      await change({ title: 'Wrong board' }, 'denied', owner, foreignBoardId);
      await change({ projectId: foreign.id }, 'denied');
      await change({ assigneeUserId: outsider.userId }, 'denied');
      if (transport === 'MCP') {
        const before = await snapshot();
        const result = await call(reader!, `update_${kind}`, { boardId, requestId: randomUUID(),
          ...(kind === 'task' ? { taskId: target.id, expectedVersion: await version(), changes: { title: 'Read-only edit' } } : { recurrenceId: target.id, paused: true }) });
        assert.equal(result.error.code, 'READ_ONLY');
        assert.deepEqual(await snapshot(), before);
      }
      for (const status of ['draft', 'frozen', 'archived']) {
        await db.query('UPDATE boards SET status=$2 WHERE id=$1', [boardId, status]);
        if (transport === 'MCP') {
          const before = await snapshot();
          const result = await call(writers.get(owner.userId)!, `update_${kind}`, { boardId, requestId: randomUUID(),
            ...(kind === 'task' ? { taskId: target.id, expectedVersion: await version(), changes: { title: 'Read-only board' } } : { recurrenceId: target.id, paused: true }) });
          assert.equal(result.error.code, 'BOARD_READ_ONLY');
          assert.deepEqual(await snapshot(), before);
        } else await change({ title: 'Read-only board' }, 'denied');
      }
      await db.query("UPDATE boards SET status='active' WHERE id=$1", [boardId]);
      // New assignments remain forbidden, both from another project and from no project.
      for (const projectId of [active.id, null]) {
        await change({ projectId });
        assert.equal((await read()).project_id, projectId);
        await change({ projectId: project.id }, 'denied');
      }
      for (const projectId of [project.id, foreign.id]) {
        const input = { title: 'Forbidden create', projectId, ...(kind === 'recurrence' ? rule : {}) };
        const count = (await db.query(`SELECT count(*) FROM ${table} WHERE board_id=$1`, [boardId])).rows[0].count;
        if (transport === 'DB') assert.equal(kind === 'task' ? await createTask(db, owner.userId, boardId, input) : await createRecurrence(db, owner.userId, boardId, { ...rule, ...input }), null);
        else if (transport === 'REST') assert.equal((await app.inject({ method: 'POST', url: `/api/boards/${boardId}/${kind === 'task' ? 'tasks' : 'recurrences'}`, cookies: { session: owner.token }, payload: input })).statusCode, 404);
        else assert.equal((await call(writers.get(owner.userId)!, `create_${kind}`, { boardId, requestId: randomUUID(), ...input })).error.code, kind === 'task' ? 'ACTION_FORBIDDEN' : 'NOT_FOUND');
        assert.equal((await db.query(`SELECT count(*) FROM ${table} WHERE board_id=$1`, [boardId])).rows[0].count, count);
      }
      if (kind === 'task') {
        await db.query('UPDATE tasks SET archived_at=now() WHERE id=$1', [target.id]);
        if (transport === 'MCP') {
          const before = await snapshot();
          assert.equal((await call(writers.get(owner.userId)!, 'update_task', { boardId, taskId: target.id, expectedVersion: await version(), requestId: randomUUID(), changes: { title: 'Archived task' } })).error.code, 'NOT_FOUND');
          assert.deepEqual(await snapshot(), before);
        } else await change({ title: 'Archived task' }, 'denied');
      }
    } finally {
      for (const client of clients) await client.close();
      await app.close();
      for (const person of [owner, member, outsider]) {
        await db.query('DELETE FROM boards WHERE owner_user_id=$1', [person.userId]);
        await db.query('DELETE FROM users WHERE id=$1', [person.userId]);
      }
      await db.end();
    }
  });
}
