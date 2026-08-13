import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, createRecurrence, runRecurrenceScheduler, tasksForBoard, updateRecurrence } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');

test('scheduler catches up, stays idempotent and template lifecycle preserves tasks', async () => {
  const db = createDatabase(url!);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const userId = (await db.query<{id: string}>('INSERT INTO users (telegram_id, first_name) VALUES ($1, $2) RETURNING id', [stamp, 'Recurring'])).rows[0].id;
  const boardId = randomUUID();
  await db.query("INSERT INTO boards (id, type, name, owner_user_id, status) VALUES ($1, 'personal', 'Recurring', $2, 'active')", [boardId, userId]);
  await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'owner')", [boardId, userId]);
  const recurrence = await createRecurrence(db, userId, boardId, {
    title: 'Daily', frequency: 'daily', localTime: '09:00', timezone: 'UTC', startAt: '2026-01-01T09:00:00Z'
  });
  assert.ok(recurrence);
  assert.equal(await runRecurrenceScheduler(db, new Date('2026-01-03T09:00:00Z')), 3, 'downtime occurrences are caught up');
  assert.equal(await runRecurrenceScheduler(db, new Date('2026-01-03T09:00:00Z')), 0, 'same tick is idempotent');
  assert.equal((await tasksForBoard(db, userId, boardId)).length, 3, 'each occurrence is independent');
  await updateRecurrence(db, userId, boardId, recurrence.id, { paused: true });
  assert.equal(await runRecurrenceScheduler(db, new Date('2026-01-04T09:00:00Z')), 0, 'pause stops instances');
  await updateRecurrence(db, userId, boardId, recurrence.id, { paused: false });
  await db.query('UPDATE recurrence_templates SET next_occurrence_at = $2 WHERE id = $1', [recurrence.id, '2026-01-04T09:00:00Z']);
  assert.equal(await runRecurrenceScheduler(db, new Date('2026-01-04T09:00:00Z')), 1, 'resume allows next occurrence');
  await updateRecurrence(db, userId, boardId, recurrence.id, { archived: true });
  assert.equal((await tasksForBoard(db, userId, boardId)).length, 4, 'archive keeps instance history');
  await db.query('DELETE FROM boards WHERE id = $1', [boardId]);
  await db.query('DELETE FROM users WHERE id = $1', [userId]);
  await db.end();
});
