import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { createInvite, connectChatBoard, createDatabase, freezeChatBoard, redeemBoardLink, revokeInvites } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');

test('chat board is idempotent, frozen safely and joined only by valid links', async () => {
  const db = createDatabase(url!);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const chatId = -stamp;
  const firstUser = await db.query<{id: string}>("INSERT INTO users (telegram_id, first_name) VALUES ($1, 'A') RETURNING id", [stamp]);
  const secondUser = await db.query<{id: string}>("INSERT INTO users (telegram_id, first_name) VALUES ($1, 'B') RETURNING id", [stamp + 1]);
  const first = await connectChatBoard(db, chatId, 'Команда');
  const second = await connectChatBoard(db, chatId, 'Команда');
  assert.equal(first.id, second.id);
  assert.notEqual(first.token, second.token);
  assert.equal(await redeemBoardLink(db, firstUser.rows[0].id, first.token!), null, 'rotated launch token must be revoked');
  assert.equal((await redeemBoardLink(db, firstUser.rows[0].id, second.token!))?.id, first.id);

  const invite = await createInvite(db, firstUser.rows[0].id, first.id);
  assert.ok(invite);
  await freezeChatBoard(db, chatId);
  assert.equal(await redeemBoardLink(db, secondUser.rows[0].id, invite!), null, 'frozen board must reject joins');
  const restored = await connectChatBoard(db, chatId, 'Команда');
  assert.equal(restored.status, 'draft');
  assert.equal((await redeemBoardLink(db, secondUser.rows[0].id, invite!))?.id, first.id);
  assert.equal(await revokeInvites(db, firstUser.rows[0].id, first.id), 1);
  assert.equal(await redeemBoardLink(db, secondUser.rows[0].id, invite!), null);

  await db.query('DELETE FROM boards WHERE id = $1', [first.id]);
  await db.query('DELETE FROM users WHERE id = ANY($1)', [[firstUser.rows[0].id, secondUser.rows[0].id]]);
  await db.end();
});
