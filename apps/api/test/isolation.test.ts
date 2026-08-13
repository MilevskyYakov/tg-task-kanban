import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { boardForUser, createDatabase, renameBoard } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;
test('tenant-scoped reads and writes reject another board', { skip: !url }, async () => {
  const db = createDatabase(url!);
  const a = await db.query<{id: string}>("INSERT INTO users (telegram_id, first_name) VALUES ($1, 'A') RETURNING id", [Date.now()]);
  const b = await db.query<{id: string}>("INSERT INTO users (telegram_id, first_name) VALUES ($1, 'B') RETURNING id", [Date.now() + 1]);
  const board = randomUUID();
  await db.query("INSERT INTO boards (id, type, name, owner_user_id) VALUES ($1, 'personal', 'A', $2)", [board, a.rows[0].id]);
  await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'owner')", [board, a.rows[0].id]);
  assert.equal(await boardForUser(db, b.rows[0].id, board), null);
  assert.equal(await renameBoard(db, b.rows[0].id, board, 'stolen'), null);
  assert.equal((await boardForUser(db, a.rows[0].id, board))?.name, 'A');
  await db.query('DELETE FROM boards WHERE id = $1', [board]);
  await db.query('DELETE FROM users WHERE id = ANY($1)', [[a.rows[0].id, b.rows[0].id]]);
  await db.end();
});
