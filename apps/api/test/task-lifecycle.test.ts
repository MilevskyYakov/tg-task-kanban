import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createDatabase, createProject, createTask, login, ProjectConflictError, saveTaskFilterState, setTaskArchived, TaskActionError, taskFilterState, tasksForAssignee, tasksForBoard, updateProject, updateTask } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');

test('task lifecycle enforces tenant, role and transition rules', async () => {
  const db = createDatabase(url!);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const users = await Promise.all(['Creator', 'Assignee', 'Member', 'Outsider'].map(async (name, index) =>
    (await db.query<{id: string}>('INSERT INTO users (telegram_id, first_name) VALUES ($1, $2) RETURNING id', [stamp + index, name])).rows[0].id));
  const boardId = randomUUID();
  await db.query("INSERT INTO boards (id, type, name, telegram_chat_id, status) VALUES ($1, 'chat', 'Team', $2, 'active')", [boardId, -stamp]);
  for (const userId of users.slice(0, 3)) await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'member')", [boardId, userId]);

  const project = await createProject(db, users[2], boardId, 'Launch');
  assert.ok(project, 'any member can create project');
  const repeatedProjects = await Promise.all(Array.from({ length: 10 }, () => createProject(db, users[2], boardId, 'launch')));
  assert.deepEqual(new Set(repeatedProjects.map((item) => item?.id)), new Set([project.id]), 'concurrent project creation is idempotent');
  const secondProject = await createProject(db, users[2], boardId, 'Support');
  await assert.rejects(() => updateProject(db, users[2], boardId, secondProject.id, { name: 'LAUNCH' }), ProjectConflictError);
  assert.equal(await createProject(db, users[3], boardId, 'Stolen'), null, 'outsider cannot create project');

  const task = await createTask(db, users[0], boardId, { title: 'Ship', projectId: project.id, assigneeUserId: users[1], priority: 'urgent', deadline: '2000-01-01T00:00:00Z' });
  assert.ok(task);
  assert.ok(await createTask(db, users[2], boardId, { title: 'Instant done for anyone', assigneeUserId: users[1], status: 'done' }), 'any member creates task already done with foreign assignee');
  await db.query("UPDATE tasks SET archived_at = now() WHERE title = 'Instant done for anyone' AND board_id = $1", [boardId]);
  assert.equal(await createTask(db, users[3], boardId, { title: 'Stolen' }), null);
  assert.equal((await tasksForBoard(db, users[2], boardId))[0].overdue, true, 'member reads active board tasks and overdue is computed');
  assert.equal((await tasksForBoard(db, users[3], boardId)).length, 0, 'outsider cannot read tasks');
  assert.equal((await tasksForAssignee(db, users[1]))[0].id, task.id, 'assigned task appears in all-my-tasks');
  assert.deepEqual(await taskFilterState(db, users[1], boardId), {});
  assert.deepEqual(await saveTaskFilterState(db, users[1], boardId, { status: 'todo' }), { status: 'todo' });
  assert.deepEqual(await taskFilterState(db, users[1], boardId), { status: 'todo' }, 'filter state persists per user and board');
  assert.equal(await saveTaskFilterState(db, users[3], boardId, { status: 'done' }), null, 'outsider cannot save filter state');

  assert.equal((await updateTask(db, users[2], boardId, task.id, { title: 'Renamed by member' }))?.title, 'Renamed by member', 'any member edits task fields');
  // Optimistic concurrency: expectedVersion guards against a lost update between reads (issue #129).
  const currentVersion = (await tasksForBoard(db, users[2], boardId)).find((item) => item.id === task.id)!.version!;
  await assert.rejects(
    () => updateTask(db, users[2], boardId, task.id, { title: 'Stale write', expectedVersion: '1' }),
    (error: unknown) => error instanceof Error && (error as {expectedVersion?: string}).expectedVersion === '1' && error.message === 'version conflict',
    'stale expectedVersion is rejected atomically'
  );
  assert.equal((await updateTask(db, users[2], boardId, task.id, { title: 'Concurrent-safe rename', expectedVersion: currentVersion }))?.title, 'Concurrent-safe rename', 'matching expectedVersion applies');
  const auditRename = (await db.query(`SELECT before_data, after_data FROM task_audit_events WHERE task_id = $1 AND action = 'updated' ORDER BY created_at, id LIMIT 1`, [task.id])).rows[0];
  assert.equal(auditRename.before_data.title, 'Ship', 'audit keeps before-state');
  assert.equal(auditRename.after_data.title, 'Renamed by member', 'audit keeps after-state');
  const beforeLatestSave = (await tasksForBoard(db, users[2], boardId)).find((item: { id: string; version?: string }) => item.id === task.id)!;
  const sentA = await updateTask(db, users[2], boardId, task.id, { title: 'Earlier queued title', expectedVersion: beforeLatestSave.version! });
  const sentB = await updateTask(db, users[2], boardId, task.id, { title: 'Latest queued title', expectedVersion: sentA!.version });
  const storedLatest = (await tasksForBoard(db, users[2], boardId)).find((item: { id: string; title: string; version?: string }) => item.id === task.id)!;
  assert.equal(storedLatest.title, 'Latest queued title', 'serialized versioned writes persist latest intent');
  assert.equal(storedLatest.version, sentB!.version, 'each accepted write advances confirmed revision');
  assert.equal((await updateTask(db, users[2], boardId, task.id, { status: 'done' }))?.status, 'done', 'ordinary member closes task');
  assert.equal((await updateTask(db, users[2], boardId, task.id, { status: 'in_progress' }))?.status, 'in_progress', 'ordinary member reopens from done');
  assert.equal(await updateTask(db, users[1], boardId, task.id, { status: 'waiting', waitReason: null }), null, 'waiting requires reason');
  const waiting = await updateTask(db, users[1], boardId, task.id, { status: 'waiting', waitReason: 'Client', waitCheckAt: '2000-01-02T00:00:00Z' });
  assert.equal(waiting.status, 'waiting');
  assert.equal((await tasksForBoard(db, users[0], boardId))[0].wait_check_due, true);
  assert.equal((await updateTask(db, users[1], boardId, task.id, { status: 'done' }))?.status, 'done', 'assignee closes task');
  assert.equal((await updateTask(db, users[1], boardId, task.id, { status: 'in_progress' }))?.status, 'in_progress', 'assignee reopens task');

  const linked = await createTask(db, users[0], boardId, { title: 'Linked', issueUrl: 'https://github.com/MilevskyYakov/tg-task-kanban/issues/115' });
  assert.equal(linked?.issue_url, 'https://github.com/MilevskyYakov/tg-task-kanban/issues/115', 'issue url stored on create');
  assert.equal((await updateTask(db, users[0], boardId, linked.id, { issueUrl: null }))?.issue_url, null, 'issueUrl null clears link');
  assert.equal((await updateTask(db, users[0], boardId, linked.id, { issueUrl: 'https://github.com/o/r/issues/9' }))?.issue_url, 'https://github.com/o/r/issues/9');
  await assert.rejects(() => createTask(db, users[0], boardId, { title: 'Bad', issueUrl: 'https://github.com/o/r/pulls/1' } as never),
    error => String((error as {message?: string}).message).includes('issue_url'), 'DB CHECK rejects non-issue URL');
  await db.query('DELETE FROM tasks WHERE id = $1', [linked.id]);

  const unassigned = await createTask(db, users[0], boardId, { title: 'Unassigned' });
  assert.ok(unassigned);
  assert.equal((await updateTask(db, users[2], boardId, unassigned.id, { status: 'done' }))?.status, 'done', 'ordinary member closes unassigned task');
  assert.equal((await updateTask(db, users[0], boardId, unassigned.id, { status: 'done' }))?.status, 'done', 'creator closes unassigned task');
  await db.query("UPDATE tasks SET archived_at = now() WHERE id = $1", [unassigned.id]);
  await db.query('DELETE FROM memberships WHERE board_id = $1 AND user_id = $2', [boardId, users[1]]);
  assert.equal((await tasksForBoard(db, users[0], boardId))[0].assignee_user_id, null, 'leaving board clears active assignment');
  await assert.rejects(() => setTaskArchived(db, users[2], boardId, task.id, true), TaskActionError);
  await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'member')", [boardId, users[1]]);
  assert.ok(await updateTask(db, users[0], boardId, task.id, { assigneeUserId: users[1] }));
  assert.equal(await setTaskArchived(db, users[0], boardId, task.id, true), true);
  assert.equal((await tasksForBoard(db, users[0], boardId)).length, 0, 'archived task leaves active view');
  assert.equal((await tasksForBoard(db, users[0], boardId, true)).length, 3, 'history remains readable');
  await db.query('DELETE FROM memberships WHERE board_id = $1 AND user_id = $2', [boardId, users[1]]);
  assert.equal((await tasksForBoard(db, users[0], boardId, true))[0].assignee_user_id, null, 'leaving board also preserves archived task without stale assignment');
  assert.equal(await setTaskArchived(db, users[0], boardId, task.id, false), true, 'task can be reopened from archive');
  assert.equal((await tasksForBoard(db, users[0], boardId)).length, 1);
  assert.equal((await updateProject(db, users[2], boardId, project.id, { name: 'Release', archived: true }))?.name, 'Release');
  assert.ok(await updateProject(db, users[2], boardId, project.id, { archived: false }), 'project can be restored');

  await db.query('DELETE FROM boards WHERE id = $1', [boardId]);
  await db.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  await db.end();
});

test('archive and restore explain REST/MCP denials without widening permissions or partial effects', async () => {
  const db = createDatabase(url!);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const config: Config = { botToken: 'test', databaseUrl: url!, sessionSecret: 'isolated-archive-secret', initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 3600,
    host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-test', publicUrl: 'http://127.0.0.1', botUsername: 'test_bot' };
  const people = await Promise.all(['creator', 'assignee', 'member', 'admin', 'owner', 'outsider'].map(async (name, i) => ({
    ...await login(db, { id: stamp + i, first_name: name }, 3600, config.sessionSecret), name
  })));
  const boardId = randomUUID();
  const app = buildApp(config, db);
  const clients: Client[] = [];
  try {
    await db.query("INSERT INTO boards (id,type,name,telegram_chat_id,status) VALUES ($1,'chat','Archive matrix',$2,'active')", [boardId, -stamp]);
    for (const person of people.slice(0, 5)) await db.query('INSERT INTO memberships (board_id,user_id,role) VALUES ($1,$2,$3)', [boardId, person.userId, ['owner', 'admin'].includes(person.name) ? person.name : 'member']);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 }); config.publicUrl = origin;
    for (const person of people) {
      const grant = person.name === 'outsider' ? (await db.query('SELECT id FROM boards WHERE owner_user_id=$1', [person.userId])).rows[0].id : boardId;
      const issued = await app.inject({ method: 'POST', url: '/api/mcp-connections', cookies: { session: person.token }, headers: { origin, host: new URL(origin).host },
        payload: { requestId: randomUUID(), name: 'Archive matrix', mode: 'write', boardIds: [grant] } });
      assert.equal(issued.statusCode, 201);
      const client = new Client({ name: 'archive-matrix', version: '1' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + issued.json().key } } }));
    }
    const snapshot = async (taskId: string) => (await db.query(`SELECT row_to_json(t) AS task,
      (SELECT count(*)::int FROM task_audit_events WHERE task_id=t.id) AS events,
      (SELECT count(*)::int FROM mcp_write_receipts WHERE subject_id=t.id) AS receipts,
      (SELECT count(*)::int FROM task_assignment_notifications WHERE task_id=t.id) AS notifications
      FROM tasks t WHERE id=$1`, [taskId])).rows[0];
    for (const transport of ['REST', 'MCP']) for (const archived of [true, false]) {
      const reason = `${archived ? 'Архивировать' : 'Восстановить'} задачу может только её автор или исполнитель`;
      const cases = [
        ...people.map((_, person) => ({ person, assigned: true, status: 'active', sameState: false })),
        ...[0, 1, 3].map(person => ({ person, assigned: false, status: 'active', sameState: false })),
        ...['frozen', 'archived'].map(status => ({ person: 0, assigned: true, status, sameState: false })),
        { person: 0, assigned: true, status: 'active', sameState: true }
      ];
      for (const entry of cases) {
        await db.query("UPDATE boards SET status='active' WHERE id=$1", [boardId]);
        const task = await createTask(db, people[0].userId, boardId, { title: 'Archive matrix', assigneeUserId: entry.assigned ? people[1].userId : null });
        if (archived === entry.sameState) assert.equal(await setTaskArchived(db, people[0].userId, boardId, task.id, true), true);
        await db.query('UPDATE boards SET status=$2 WHERE id=$1', [boardId, entry.status]);
        const before = await snapshot(task.id);
        const permitted = entry.person === 0 || (entry.person === 1 && entry.assigned);
        const allowed = permitted && entry.status === 'active' && !entry.sameState;
        const message = entry.person === 5 ? 'Задача недоступна' : entry.status !== 'active' ? 'Доска доступна только для чтения'
          : !permitted ? reason : archived ? 'Задача уже в архиве' : 'Задача не в архиве';
        const args = { boardId, taskId: task.id, archived, requestId: randomUUID() };
        if (transport === 'REST') {
          const response = await app.inject({ method: archived ? 'DELETE' : 'POST', url: `/api/boards/${boardId}/tasks/${task.id}${archived ? '' : '/reopen'}`, cookies: { session: people[entry.person].token } });
          assert.equal(response.statusCode, allowed ? 200 : 403);
          assert.deepEqual(response.json(), allowed ? { archived } : { error: message });
        } else {
          const response = (await clients[entry.person].callTool({ name: 'archive_task', arguments: args })).structuredContent as any;
          assert.equal(response.ok, allowed);
          if (!allowed) {
            assert.equal(response.error.code, entry.person === 5 ? 'NOT_FOUND' : entry.status !== 'active' ? 'BOARD_READ_ONLY' : 'ACTION_FORBIDDEN');
            if (entry.person !== 5) assert.equal(response.error.message, message);
          } else assert.equal(response.task.archived, archived);
        }
        const after = await snapshot(task.id);
        if (!allowed) assert.deepEqual(after, before, 'denial leaves task, history, receipts and notifications unchanged');
        else {
          assert.equal(Boolean(after.task.archived_at), archived);
          assert.equal(after.task.status, before.task.status);
          assert.equal(after.events, before.events + 1);
          assert.equal(after.notifications, before.notifications);
          assert.equal(after.receipts, before.receipts + Number(transport === 'MCP'));
          if (transport === 'MCP') {
            assert.equal(((await clients[entry.person].callTool({ name: 'archive_task', arguments: args })).structuredContent as any).replayed, true);
            assert.deepEqual(await snapshot(task.id), after);
          }
        }
      }
      // Missing task IDs reveal no author, board state or task data.
      const missing = randomUUID();
      const response = await app.inject({ method: archived ? 'DELETE' : 'POST', url: `/api/boards/${boardId}/tasks/${missing}${archived ? '' : '/reopen'}`, cookies: { session: people[0].token } });
      assert.deepEqual([response.statusCode, response.json()], [403, { error: 'Задача недоступна' }]);
      const mcp = (await clients[0].callTool({ name: 'archive_task', arguments: { boardId, taskId: missing, archived, requestId: randomUUID() } })).structuredContent as any;
      assert.equal(mcp.error.code, 'ACTION_FORBIDDEN'); assert.equal(mcp.error.message, 'Задача недоступна');
    }
  } finally {
    for (const client of clients) await client.close();
    await app.close();
    await db.query('DELETE FROM boards WHERE id=$1 OR owner_user_id=ANY($2)', [boardId, people.map(person => person.userId)]);
    await db.query('DELETE FROM users WHERE id=ANY($1)', [people.map(person => person.userId)]);
    await db.end();
  }
});
