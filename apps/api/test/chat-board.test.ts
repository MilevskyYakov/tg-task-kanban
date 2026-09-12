import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { createInvite, connectChatBoard, createDatabase, freezeChatBoard, login, redeemBoardLink, revokeInvites } from '../src/db.js';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';

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
  assert.ok(first && second);
  assert.equal(first.id, second.id);
  assert.equal((await db.query('SELECT count(*) FROM telegram_entry_deliveries WHERE board_id = $1', [first.id])).rows[0].count, '1');
  await db.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'member')", [first.id, firstUser.rows[0].id]);

  const invite = await createInvite(db, firstUser.rows[0].id, first.id);
  assert.ok(invite);
  await freezeChatBoard(db, chatId);
  assert.equal(await redeemBoardLink(db, secondUser.rows[0].id, invite!), null, 'frozen board must reject joins');
  const restored = await connectChatBoard(db, chatId, 'Команда');
  assert.ok(restored);
  assert.equal(restored.status, 'draft');
  assert.equal((await redeemBoardLink(db, secondUser.rows[0].id, invite!))?.id, first.id);
  assert.equal(await revokeInvites(db, firstUser.rows[0].id, first.id), 1);
  assert.equal(await redeemBoardLink(db, secondUser.rows[0].id, invite!), null);

  await db.query('DELETE FROM boards WHERE id = $1', [first.id]);
  await db.query('DELETE FROM users WHERE id = ANY($1)', [[firstUser.rows[0].id, secondUser.rows[0].id]]);
  await db.end();
});

test('bot entry: one photo, stable launch, admin-only setup and safe delivery outcomes', async (t) => {
  const db = createDatabase(url!);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const config: Config = { botToken: 'test', databaseUrl: url!, sessionSecret: 'isolated-entry-test', initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 3600,
    host: '127.0.0.1', port: 2240, production: false, webhookSecret: 'isolated-webhook', publicUrl: 'https://example.test', botUsername: 'test_bot' };
  const people = await Promise.all(['Admin', 'Member', 'Outsider'].map((first_name, index) => login(db, { id: stamp + index, first_name }, 3600, config.sessionSecret)));
  const [admin, member, outsider] = people;
  const app = buildApp(config, db);
  let outcome: 'sent' | 'rejected' | 'unknown' = 'sent';
  const photos: FormData[] = [];
  const messages: any[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const method = String(input).split('/').pop();
    if (method === 'getChatMember') return Response.json({ ok: true, result: { status: String(JSON.parse(String(options?.body)).user_id) === String(stamp) ? 'administrator' : 'member' } });
    assert.ok(method === 'sendPhoto' || method === 'sendMessage', 'no editing, pinning or bulk migration methods');
    if (method === 'sendPhoto') { assert.ok(options?.body instanceof FormData); photos.push(options.body); }
    else messages.push(JSON.parse(String(options?.body)));
    if (outcome === 'rejected') return Response.json({ ok: false, error_code: 429, description: 'Too Many Requests' }, { status: 429 });
    if (outcome === 'unknown') throw new Error('Simulated lost Telegram response');
    return Response.json({ ok: true, result: { message_id: photos.length + messages.length } });
  });
  const chatId = -stamp;
  const headers = { 'x-telegram-bot-api-secret-token': config.webhookSecret };
  const webhook = (payload: object) => app.inject({ method: 'POST', url: '/api/telegram/webhook', headers, payload });
  const joined = (offset = 0, update = 0, oldStatus = 'left', newStatus = 'member') => ({ update_id: stamp + update, my_chat_member: {
    date: 1_700_000_000 + update,
    chat: { id: chatId - offset, type: 'supergroup', title: 'Студия <A> & B' },
    old_chat_member: { status: oldStatus, user: { is_bot: true } }, new_chat_member: { status: newStatus, user: { is_bot: true } }
  } });
  const call = (person: typeof admin, method: 'GET' | 'POST', path: string, payload?: object) => app.inject({ method, url: path, cookies: { session: person.token }, payload });
  const launch = (photo: FormData) => new URL(JSON.parse(String(photo.get('reply_markup'))).inline_keyboard[0][0].url).searchParams.get('startapp')!;
  const delivery = async (id: string) => (await db.query('SELECT status, message_id, attempts, error_code FROM telegram_entry_deliveries WHERE board_id = $1', [id])).rows[0];
  const boardForChat = async (offset: number) => (await db.query('SELECT id, status, name FROM boards WHERE telegram_chat_id = $1', [chatId - offset])).rows[0];
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/telegram/webhook', payload: joined() })).statusCode, 401);
    assert.equal((await webhook({ update_id: 'bad' })).statusCode, 400);
    assert.equal((await webhook({ update_id: stamp, my_chat_member: {} })).statusCode, 400);
    await Promise.all([webhook(joined()), webhook(joined())]);
    assert.equal((await webhook(joined())).json().delivery, 'sent');
    assert.equal(photos.length, 1);
    const photo = photos[0];
    assert.equal(photo.get('caption'), '<b>Задачи команды · Студия &lt;A&gt; &amp; B</b>\n\nДобавляйте задачи, берите их в работу и отслеживайте выполнение.');
    assert.equal(photo.get('parse_mode'), 'HTML');
    const asset = photo.get('photo') as File;
    assert.equal(asset.name, 'group-welcome.png');
    assert.equal(asset.type, 'image/png');
    assert.equal(createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('hex'), '60913eb886a11733ed4a0765043b148f462d82e6eeb11f1d0611e96a150494c0');
    const keyboard = JSON.parse(String(photo.get('reply_markup'))).inline_keyboard;
    assert.equal(keyboard.length, 1); assert.equal(keyboard[0].length, 1); assert.equal(keyboard[0][0].text, 'Открыть задачи');
    assert.equal(messages.length, 0, 'image, caption and button in one message');
    const token = launch(photo);
    const first = (await call(admin, 'POST', '/api/board-links/redeem', { token })).json();
    const path = `/api/boards/${first.id}`;
    assert.equal(first.status, 'draft');
    assert.equal((await call(outsider, 'GET', `${path}/setup`)).statusCode, 404);
    assert.equal((await call(member, 'POST', '/api/board-links/redeem', { token })).statusCode, 200);
    assert.equal((await call(member, 'GET', `${path}/setup`)).json().canActivate, false);
    assert.equal((await call(admin, 'GET', `${path}/setup`)).json().canActivate, true);
    assert.equal((await call(member, 'POST', `${path}/activate`, { name: 'Forbidden' })).statusCode, 403);
    assert.equal((await call(admin, 'POST', `${path}/activate`, { name: {} })).statusCode, 400);
    assert.equal((await call(admin, 'POST', `${path}/activate`, { name: 'Команда' })).json().status, 'active');
    assert.equal((await call(admin, 'POST', `${path}/activate`, { name: 'Retry must not rename' })).json().name, 'Команда');
    assert.equal((await call(member, 'POST', '/api/board-links/redeem', { token })).json().id, first.id);
    assert.equal((await call(member, 'POST', `${path}/tasks`, { title: 'First task' })).statusCode, 200);
    assert.equal((await delivery(first.id)).status, 'sent');
    await webhook(joined(0, 1, 'member', 'left'));
    await webhook(joined());
    assert.equal((await boardForChat(0)).status, 'frozen', 'old add cannot unfreeze the board');
    assert.equal((await call(admin, 'POST', `${path}/activate`, { name: 'No restore' })).statusCode, 409);
    assert.equal((await call(member, 'POST', '/api/board-links/redeem', { token })).json().status, 'frozen');
    assert.equal((await call(outsider, 'POST', '/api/board-links/redeem', { token })).statusCode, 404);
    await webhook(joined(0, 2));
    await webhook(joined(0, 1, 'member', 'left'));
    assert.equal((await boardForChat(0)).status, 'active');
    assert.equal((await call(member, 'POST', '/api/board-links/redeem', { token })).json().id, first.id);
    assert.equal(photos.length, 1, 'restore preserves original pin and launch link');
    const laterRemoval = joined(0, 20, 'member', 'left');
    await webhook(laterRemoval);
    const afterIdle = joined(0, 21);
    afterIdle.update_id = 1; // Telegram may choose a random update ID after a week without updates.
    await webhook(afterIdle);
    assert.equal((await boardForChat(0)).status, 'active', 'event date takes precedence over a reset update ID');

    outcome = 'rejected';
    assert.equal((await webhook(joined(1, 3))).statusCode, 503);
    const rejected = await boardForChat(1);
    assert.equal((await delivery(rejected.id)).status, 'failed');
    assert.equal((await delivery(rejected.id)).message_id, null);
    await call(admin, 'POST', '/api/board-links/redeem', { token: launch(photos[1]) });
    await call(admin, 'POST', `/api/boards/${rejected.id}/activate`, { name: 'Already active' });
    outcome = 'sent';
    assert.equal((await webhook(joined(1, 3))).json().delivery, 'sent');
    assert.equal((await delivery(rejected.id)).attempts, 2);
    assert.equal((await boardForChat(1)).status, 'active', 'delivery retry preserves successful activation');
    assert.equal((await boardForChat(1)).name, 'Already active');
    assert.equal(photos.length, 3);
    await webhook(joined(1, 3));
    assert.equal(photos.length, 3);

    outcome = 'unknown';
    assert.equal((await webhook(joined(2, 4))).json().delivery, 'uncertain');
    assert.equal((await webhook(joined(2, 4))).json().ok, false);
    const uncertain = await boardForChat(2);
    assert.equal((await delivery(uncertain.id)).error_code, 'result_unknown');
    const uncertainToken = launch(photos[3]);
    outcome = 'sent';
    await webhook(joined(2, 4));
    assert.equal(photos.length, 4, 'unknown outcome never resends');
    assert.equal((await call(admin, 'POST', '/api/board-links/redeem', { token: uncertainToken })).json().id, uncertain.id);

    const interrupted = await connectChatBoard(db, chatId - 3, 'Interrupted', stamp + 5);
    assert.ok(interrupted);
    await db.query("UPDATE telegram_entry_deliveries SET status = 'sending', updated_at = now() - interval '3 minutes' WHERE board_id = $1", [interrupted.id]);
    assert.equal((await webhook(joined(3, 5))).json().delivery, 'uncertain');
    assert.equal(photos.length, 4);

    const legacy = await connectChatBoard(db, chatId - 4, 'Legacy');
    assert.ok(legacy);
    await db.query('DELETE FROM telegram_entry_deliveries WHERE board_id = $1', [legacy.id]);
    assert.equal((await webhook(joined(4, 6))).json().delivery, 'skipped');
    assert.equal(photos.length, 4, 'no welcome migration for existing boards');

    const command = (update: number, text: string, type = 'private') => ({ update_id: stamp + update, message: { message_id: stamp + update, chat: { id: stamp, type }, text } });
    const invalidCommand = command(10, '/start');
    invalidCommand.message.message_id = 0;
    assert.equal((await webhook(invalidCommand)).statusCode, 400);
    await Promise.all([webhook(command(10, '/start')), webhook(command(10, '/start'))]);
    await webhook(command(10, '/start'));
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /Личные и общие задачи/);
    assert.deepEqual(messages[0].reply_markup.inline_keyboard.map((row: any[]) => row[0].text), ['Личные задачи', 'Доска на двоих', 'Доска для группы', 'Как начать']);
    assert.deepEqual(messages[0].reply_markup.inline_keyboard.map((row: any[]) => new URL(row[0].url).searchParams.get('startapp')), ['personal', 'pair', 'group', 'help']);
    await webhook(command(11, '/help@test_bot'));
    assert.match(messages[1].text, /настройках приложения/);
    await webhook(command(12, '/help@other_bot'));
    await webhook(command(13, '/start', 'supergroup'));
    await webhook(command(14, '/refresh_board'));
    assert.equal(messages.length, 2);
    const reusedUpdate = command(15, '/start');
    reusedUpdate.update_id = stamp + 10;
    assert.equal((await webhook(reusedUpdate)).json().delivery, 'sent');
    await webhook(reusedUpdate);
    assert.equal(messages.length, 3, 'a new message with a reused update ID is delivered exactly once');
    assert.equal((await app.inject('/api/bot-entry')).json().groupUrl, 'https://t.me/test_bot?startgroup=tasks');
  } finally {
    await app.close();
    await db.query('DELETE FROM boards WHERE telegram_chat_id = ANY($1) OR owner_user_id = ANY($2)', [Array.from({ length: 5 }, (_, index) => chatId - index), people.map((person) => person.userId)]);
    await db.query('DELETE FROM telegram_entry_deliveries WHERE key = ANY($1)', [[10, 11, 12, 13, 14, 15].map((index) => `command:${createHash('sha256').update(`${stamp}:${stamp + index}`).digest('hex')}`)]);
    await db.query('DELETE FROM users WHERE id = ANY($1)', [people.map((person) => person.userId)]);
    await db.end();
  }
});
