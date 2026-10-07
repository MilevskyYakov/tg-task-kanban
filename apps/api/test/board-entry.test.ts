import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { connectChatBoard, createDatabase, createInvite, createTask, login, redeemBoardLink } from '../src/db.js';
import { changePairInvite, createPairBoard, redeemPairInvite, removePairMember, setPairArchived } from '../src/pair-boards.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');

test('board entry: exact destination, photo, read-only launch, lost access and bounded delivery', async (t) => {
  const db = createDatabase(url);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const config: Config = { botToken: '180:synthetic-token', databaseUrl: url, sessionSecret: 'entry-isolated', initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 3600,
    host: '127.0.0.1', port: 0, production: false, webhookSecret: 'entry-isolated-webhook', publicUrl: 'https://example.test', botUsername: 'test_bot' };
  const people = await Promise.all(['Owner', 'Member', 'Outsider'].map((first_name, index) => login(db, { id: stamp + index, first_name }, 3600, config.sessionSecret)));
  const [owner, member, outsider] = people;
  const boards = await Promise.all(['Other board', 'Private <board> & history'].map((name) => createPairBoard(db, owner.userId, name, randomUUID())));
  const board = boards[1];
  const invite = await changePairInvite(db, owner.userId, board.id);
  await redeemPairInvite(db, member.userId, invite!, true);
  const task = await createTask(db, owner.userId, board.id, { title: 'Secret task' });
  const app = buildApp(config, db);
  const photos: FormData[] = [];
  const messages: {chat_id: number; text: string}[] = [];
  let outcome: 'sent' | 'rejected' | 'lost' = 'sent';
  t.mock.method(globalThis, 'fetch', async (input: unknown, options?: RequestInit) => {
    const method = String(input).split('/').pop();
    assert.ok(method === 'sendPhoto' || method === 'sendMessage', 'new entry never consults Telegram group membership');
    if (method === 'sendPhoto') { assert.ok(options?.body instanceof FormData); photos.push(options.body); }
    else messages.push(JSON.parse(String(options?.body)));
    if (outcome === 'lost') throw new Error('Synthetic response lost');
    if (outcome === 'rejected') return Response.json({ ok: false, error_code: 429 }, { status: 429 });
    return Response.json({ ok: true, result: { message_id: photos.length + messages.length } });
  });
  const call = (person: typeof owner, method: 'GET' | 'POST', path: string, payload?: object) => app.inject({ method, url: path, cookies: { session: person.token }, payload });
  const command = (messageId: number, chatId = stamp, payload = `entry_${board.id}`, type = 'private') => app.inject({ method: 'POST', url: '/api/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': config.webhookSecret }, payload: {
    update_id: messageId, message: { message_id: messageId, chat: { id: chatId, type }, text: `/start@test_bot ${payload}` }
  } });
  const receiptKey = (messageId: number) => `bot:${createHash('sha256').update('180').digest('hex')}:command:${createHash('sha256').update(`${stamp}:${messageId}`).digest('hex')}`;
  const memberships = async () => (await db.query('SELECT * FROM memberships WHERE board_id = ANY($1) ORDER BY board_id, user_id', [boards.map((item) => item.id)])).rows;
  try {
    const before = await memberships();
    const entry = await call(owner, 'GET', `/api/boards/${board.id}/entry`);
    assert.equal(entry.statusCode, 200);
    assert.equal(entry.headers['cache-control'], 'no-store');
    const payload = new URL(entry.json().botUrl).searchParams.get('start')!;
    assert.equal(payload, `entry_${board.id}`);
    assert.ok(payload.length <= 64);
    assert.equal(photos.length, 0, 'preparing a bot link does not send a message');
    assert.equal((await app.inject(`/api/boards/${board.id}/entry`)).statusCode, 401);
    assert.equal((await call(outsider, 'GET', `/api/boards/${board.id}/entry`)).statusCode, 404);
    assert.equal((await call(owner, 'GET', '/api/boards/invalid/entry')).statusCode, 400);
    const personal = (await db.query("SELECT id FROM boards WHERE owner_user_id = $1 AND type = 'personal'", [owner.userId])).rows[0].id;
    assert.equal((await call(owner, 'GET', `/api/boards/${personal}/entry`)).statusCode, 404);

    await Promise.all([command(1, stamp, payload), command(1, stamp, payload)]);
    assert.equal((await command(1)).json().delivery, 'sent');
    assert.equal(photos.length, 1);
    assert.equal(photos[0].get('chat_id'), String(stamp));
    const photo = photos[0].get('photo') as File;
    assert.equal(photo.type, 'image/png');
    const photoBytes = Buffer.from(await photo.arrayBuffer());
    assert.deepEqual(photoBytes, await readFile(new URL('../../../artifacts/ux/assets/board-entry.png', import.meta.url)));
    assert.equal(createHash('sha256').update(photoBytes).digest('hex'), '9573701a89ee844e02f6167d06254b662bdede5de06926b0cba3193213fc8d16', 'forwardable entry uses the approved v2 cover');
    const button = JSON.parse(String(photos[0].get('reply_markup'))).inline_keyboard[0][0];
    const launch = new URL(button.url).searchParams.get('startapp')!;
    assert.equal(launch, `open_${board.id}`);
    assert.ok(String(photos[0].get('caption')).includes(button.url), 'full URL survives independently of keyboard markup');
    assert.match(String(photos[0].get('caption')), /Private &lt;board&gt; &amp; history/);
    assert.equal((await call(member, 'POST', '/api/board-links/redeem', { token: launch })).json().id, board.id);
    assert.equal((await call(member, 'POST', '/api/board-links/redeem', { token: launch })).json().id, board.id);
    for (const token of [launch, `open_${boards[0].id}`, `open_${randomUUID()}`, 'open_not-a-uuid', `open_${board.id}_suffix`]) {
      const reply = await call(outsider, 'POST', '/api/board-links/redeem', { token });
      assert.equal(reply.statusCode, 404);
      assert.doesNotMatch(reply.body, /Private|Secret task|history/);
    }
    assert.equal((await call(outsider, 'GET', `/api/boards/${board.id}/tasks/${task.id}`)).statusCode, 403);
    assert.deepEqual((await call(outsider, 'GET', `/api/boards/${board.id}/tasks`)).json().tasks, []);
    assert.deepEqual(await memberships(), before, 'launch does not create memberships');
    // Observe the shared launch resolver itself: all statements must be read-only.
    const statements: string[] = [];
    const observed = { query: (sql: string, params: unknown[]) => { statements.push(sql); return db.query(sql, params); }, connect: () => { throw new Error('launch must not start a write transaction'); } } as unknown as typeof db;
    assert.equal((await redeemBoardLink(observed, member.userId, launch))?.id, board.id);
    assert.equal(await redeemBoardLink(observed, outsider.userId, launch), null);
    assert.ok(statements.length > 0 && statements.every((sql) => /^SELECT\b/.test(sql)));

    await command(2, stamp + 1);
    assert.equal(photos.length, 2, 'a member can request a message, not only the owner');
    await command(3, stamp + 2);
    await command(4, stamp + 3);
    await command(5, stamp, 'entry_invalid');
    await command(6, stamp, `entry_${personal}`);
    assert.equal(photos.length, 2, 'foreign, unknown and malformed requests reveal no photo or board title');
    assert.ok(messages.every((message) => !/Private|history|Secret task/.test(message.text)));
    await command(7, stamp, payload, 'group');
    assert.equal(photos.length, 2, 'only explicit private commands can send entries');

    outcome = 'lost';
    assert.equal((await command(8)).json().delivery, 'uncertain');
    const count = photos.length;
    outcome = 'sent';
    assert.equal((await command(8)).json().delivery, 'uncertain');
    assert.equal(photos.length, count, 'an uncertain response never automatically resends');
    outcome = 'rejected';
    assert.equal((await command(9)).statusCode, 503);
    outcome = 'sent';
    assert.equal((await command(9)).json().delivery, 'sent');
    await db.query("INSERT INTO telegram_entry_deliveries (key, status, updated_at) VALUES ($1, 'sending', now() - interval '3 minutes')", [receiptKey(10)]);
    const sentBeforeCrash = photos.length;
    assert.equal((await command(10)).json().delivery, 'uncertain');
    assert.equal(photos.length, sentBeforeCrash);

    await changePairInvite(db, owner.userId, board.id, true);
    assert.equal((await call(member, 'POST', '/api/board-links/redeem', { token: invite })).statusCode, 404);
    assert.equal((await call(member, 'POST', '/api/board-links/redeem', { token: launch })).statusCode, 200, 'revoking invitations does not revoke existing membership');
    await setPairArchived(db, owner.userId, board.id, true);
    assert.equal((await call(member, 'POST', '/api/board-links/redeem', { token: launch })).json().status, 'archived');
    assert.equal((await call(member, 'GET', `/api/boards/${board.id}/entry`)).statusCode, 200);
    assert.equal((await call(member, 'GET', `/api/boards/${board.id}/tasks/${task.id}`)).statusCode, 200);
    assert.equal((await call(member, 'POST', `/api/boards/${board.id}/tasks`, { title: 'No archived write' })).statusCode, 404);
    await setPairArchived(db, owner.userId, board.id, false);
    await removePairMember(db, owner.userId, board.id, member.userId);
    assert.equal((await call(member, 'POST', '/api/board-links/redeem', { token: launch })).statusCode, 404);
    const countBeforeRemoved = photos.length;
    await command(11, stamp + 1);
    assert.equal(photos.length, countBeforeRemoved);
    await db.query('DELETE FROM boards WHERE id = $1', [board.id]);
    assert.equal((await call(owner, 'POST', '/api/board-links/redeem', { token: launch })).statusCode, 404);
  } finally {
    await app.close();
    await db.query('DELETE FROM boards WHERE owner_user_id = ANY($1)', [people.map((person) => person.userId)]);
    await db.query('DELETE FROM users WHERE id = ANY($1)', [people.map((person) => person.userId)]);
    for (let messageId = 1; messageId <= 11; messageId++) for (let offset = 0; offset <= 3; offset++) {
      const hash = createHash('sha256').update(`${stamp + offset}:${messageId}`).digest('hex');
      await db.query('DELETE FROM telegram_entry_deliveries WHERE key LIKE $1', [`%:command:${hash}`]);
    }
    await db.end();
  }
});

test('legacy group launch checks membership, fails closed and preserves explicit invitations', async (t) => {
  const db = createDatabase(url);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const config: Config = { botToken: '180:synthetic-token', databaseUrl: url, sessionSecret: 'legacy-isolated', initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 3600,
    host: '127.0.0.1', port: 0, production: false, webhookSecret: 'legacy-isolated-webhook', publicUrl: 'https://example.test', botUsername: 'test_bot' };
  const owner = await login(db, { id: stamp, first_name: 'Owner' }, 3600, config.sessionSecret);
  const guest = await login(db, { id: stamp + 1, first_name: 'Guest' }, 3600, config.sessionSecret);
  const board = (await connectChatBoard(db, -stamp, 'Private group'))!;
  await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'admin')", [board.id, owner.userId]);
  const token = `board_${randomBytes(24).toString('base64url')}`;
  await db.query("INSERT INTO board_links (token_hash, board_id, kind) VALUES ($1, $2, 'launch')", [createHash('sha256').update(token).digest('hex'), board.id]);
  let member: {status: string; is_member?: boolean} = { status: 'left' };
  let failure = false;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: unknown, options?: RequestInit) => {
    assert.ok(String(input).endsWith('/getChatMember'));
    assert.deepEqual(JSON.parse(String(options?.body)), { chat_id: String(-stamp), user_id: String(stamp + 1) });
    calls++;
    if (failure) throw new Error('Synthetic membership lookup unavailable');
    return Response.json({ ok: true, result: member });
  });
  const app = buildApp(config, db);
  const redeem = (link = token, person = guest) => app.inject({ method: 'POST', url: '/api/board-links/redeem', cookies: { session: person.token }, payload: { token: link } });
  try {
    assert.equal((await redeem(token, owner)).statusCode, 200);
    assert.equal(calls, 0, 'already admitted users retain their old entry without Telegram availability');
    for (const status of ['left', 'kicked', 'restricted', 'unknown']) {
      member = { status };
      assert.equal((await redeem()).statusCode, 404);
      assert.equal((await db.query('SELECT count(*) FROM memberships WHERE board_id = $1 AND user_id = $2', [board.id, guest.userId])).rows[0].count, '0');
    }
    failure = true;
    assert.equal((await redeem()).statusCode, 500);
    assert.equal((await db.query('SELECT count(*) FROM memberships WHERE board_id = $1 AND user_id = $2', [board.id, guest.userId])).rows[0].count, '0');
    assert.equal(await redeemBoardLink(db, guest.userId, token), null, 'other callers cannot implicitly bypass verification');
    failure = false;
    for (const status of ['creator', 'administrator', 'member', 'restricted']) {
      member = { status, is_member: true };
      assert.equal((await redeem()).json().id, board.id);
      await db.query('DELETE FROM memberships WHERE board_id = $1 AND user_id = $2', [board.id, guest.userId]);
    }
    // The new launch must not reuse group auto-enrolment, even for a real group member.
    const before = calls;
    assert.equal((await redeem(`open_${board.id}`)).statusCode, 404);
    assert.equal(calls, before);
    const invite = await createInvite(db, owner.userId, board.id);
    failure = true;
    assert.equal((await redeem(invite!)).statusCode, 200, 'explicit invitation remains separate from Telegram group verification');
    assert.equal(calls, before);
    await db.query("UPDATE boards SET status = 'frozen' WHERE id = $1", [board.id]);
    assert.equal((await redeem(`open_${board.id}`)).json().status, 'frozen');
    assert.equal((await app.inject({ url: `/api/boards/${board.id}/entry`, cookies: { session: guest.token } })).statusCode, 404);
    await db.query('DELETE FROM memberships WHERE board_id = $1 AND user_id = $2', [board.id, guest.userId]);
    assert.equal((await redeem()).statusCode, 404);
    assert.equal(calls, before, 'frozen boards do not admit new users or run membership lookups');
  } finally {
    await app.close();
    await db.query('DELETE FROM boards WHERE id = $1 OR owner_user_id = ANY($2)', [board.id, [owner.userId, guest.userId]]);
    await db.query('DELETE FROM users WHERE id = ANY($1)', [[owner.userId, guest.userId]]);
    await db.end();
  }
});
