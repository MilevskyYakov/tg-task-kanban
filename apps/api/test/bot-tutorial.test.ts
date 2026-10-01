import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import type { Config } from '../src/config.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');

test('private bot tutorial: all paths, navigation, replay, invalid input and delivery failures', async (t) => {
  const db = createDatabase(url);
  const stamp = randomBytes(6).readUIntBE(0, 6);
  const config: Config = { botToken: '300000000:synthetic-tutorial-token', databaseUrl: url, sessionSecret: 'tutorial-test', initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 3600,
    host: '127.0.0.1', port: 0, production: false, webhookSecret: 'tutorial-webhook', publicUrl: 'https://example.test', botUsername: 'tasca_test_bot' };
  const app = buildApp(config, db);
  const calls: {method: string; body: any}[] = [];
  const keys: string[] = [];
  const identity = createHash('sha256').update('300000000').digest('hex');
  let sequence = 0;
  let outcome = 'sent';
  let failAnswer = false;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const method = String(input).split('/').pop()!;
    assert.ok(['sendMessage', 'editMessageText', 'answerCallbackQuery'].includes(method), 'tutorial must not modify boards, profiles or group messages');
    const body = JSON.parse(String(options?.body));
    calls.push({ method, body });
    if (method === 'answerCallbackQuery') {
      if (failAnswer) throw new Error('Synthetic callback answer timeout');
      return Response.json({ ok: true, result: true });
    }
    if (outcome === 'unknown') throw new Error('Synthetic lost edit response');
    if (outcome === 'badReceipt') return Response.json({ ok: true, result: true });
    if (outcome === 'unchanged') return Response.json({ ok: false, error_code: 400, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' }, { status: 400 });
    if (outcome === 'deleted' || outcome === 'rejected') return Response.json({ ok: false, error_code: outcome === 'deleted' ? 400 : 429, description: 'Synthetic rejection' }, { status: outcome === 'deleted' ? 400 : 429 });
    return Response.json({ ok: true, result: { message_id: body.message_id ?? stamp } });
  });
  const webhook = (payload: object, secret = config.webhookSecret) => app.inject({ method: 'POST', url: '/api/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': secret }, payload });
  const command = async (text: string) => {
    const id = stamp + ++sequence;
    keys.push(`bot:${identity}:command:${createHash('sha256').update(`${stamp}:${id}`).digest('hex')}`);
    return webhook({ update_id: id, message: { message_id: id, chat: { id: stamp, type: 'private' }, text } });
  };
  const callback = (data: unknown) => {
    const id = `${stamp}-${++sequence}`;
    keys.push(`bot:${identity}:tutorial:${createHash('sha256').update(id).digest('hex')}`);
    return { update_id: stamp + sequence, callback_query: { id, from: { id: stamp }, data,
      message: { message_id: stamp, date: 1_700_000_000, from: { id: 300000000, is_bot: true }, chat: { id: stamp, type: 'private' }, reply_markup: { inline_keyboard: [[{ callback_data: 'learn:v1:intro' }]] } } } };
  };
  const edits = () => calls.filter(call => call.method === 'editMessageText');
  const lastEdit = () => edits().at(-1)!.body;
  const buttons = (body: any) => body.reply_markup.inline_keyboard.flat() as {text: string; callback_data?: string; url?: string}[];
  const go = async (data: string) => {
    const result = await webhook(callback(data));
    assert.equal(result.statusCode, 200); assert.equal(result.json().delivery, 'sent');
    return lastEdit();
  };
  try {
    assert.equal((await command('/start')).statusCode, 200);
    const start = calls.find(call => call.method === 'sendMessage')!.body;
    assert.ok(buttons(start).some(button => button.callback_data === 'learn:v1:intro'));
    assert.ok(buttons(start).some(button => button.url?.endsWith('?startapp=personal')), 'direct product entry remains available');
    await command('/help');
    assert.ok(buttons(calls.filter(call => call.method === 'sendMessage').at(-1)!.body).some(button => button.callback_data === 'learn:v1:intro'));
    assert.match((await go('learn:v1:intro')).text, /Шаг 1 из 5/);
    assert.match(lastEdit().text, /переписк/);
    assert.equal(buttons(lastEdit()).find(button => button.text === 'Далее')?.callback_data, 'learn:v1:choose');
    const choice = await go('learn:v1:choose');
    assert.match(choice.text, /Шаг 2 из 5/);
    for (const path of ['personal', 'pair', 'group']) {
      assert.ok(buttons(choice).some(button => button.callback_data === `learn:v1:${path}:0`));
      for (const step of [0, 1, 2]) {
        const body = await go(`learn:v1:${path}:${step}`);
        assert.match(body.text, new RegExp(`Шаг ${step + 3} из 5`));
        assert.equal(body.chat_id, stamp); assert.equal(body.message_id, stamp); assert.equal(body.parse_mode, 'HTML');
        const back = buttons(body).find(button => button.text === 'Назад')!;
        assert.equal(back.callback_data, step === 0 ? 'learn:v1:choose' : `learn:v1:${path}:${step - 1}`);
        assert.ok(buttons(body).some(button => button.text === 'Пропустить' || button.text === 'К выбору доски'));
        if (step < 2) assert.equal(buttons(body).find(button => button.text === 'Далее')?.callback_data, `learn:v1:${path}:${step + 1}`);
        else {
          const destination = buttons(body).find(button => button.url)!.url!;
          assert.equal(destination, `https://t.me/tasca_test_bot?${path === 'group' ? 'startgroup=tasks' : `startapp=${path}`}`);
          assert.ok(buttons(body).some(button => button.text === 'Пройти ещё раз'));
        }
        await go(back.callback_data!);
      }
    }
    const skipped = await go('learn:v1:skip');
    assert.deepEqual(buttons(skipped).filter(button => button.url).map(button => new URL(button.url!).searchParams.get('startapp')), ['personal', 'pair', 'group', 'help']);
    await go('learn:v1:intro');
    const repeated = callback('learn:v1:choose');
    const before = edits().length;
    await Promise.all([webhook(repeated), webhook(repeated)]);
    assert.equal(edits().length, before + 1);
    await go('learn:v1:personal:0');
    const after = edits().length;
    assert.equal((await webhook(repeated)).json().delivery, 'sent');
    assert.equal(edits().length, after, 'late duplicate must not move the guide backwards');
    outcome = 'unchanged';
    assert.equal((await webhook(callback('learn:v1:personal:0'))).json().delivery, 'sent', 'same screen is a successful no-op');
    outcome = 'unknown';
    const unknown = callback('learn:v1:personal:1');
    assert.equal((await webhook(unknown)).json().delivery, 'uncertain');
    const unknownCount = edits().length;
    outcome = 'sent';
    assert.equal((await webhook(unknown)).json().delivery, 'uncertain');
    assert.equal(edits().length, unknownCount, 'unknown edit result must not be retried automatically');
    for (const failure of ['deleted', 'rejected', 'badReceipt']) {
      outcome = failure;
      const failedCallback = callback('learn:v1:personal:1');
      const result = await webhook(failedCallback);
      assert.equal(result.statusCode, 200, 'a failed button must not start a webhook retry loop');
      assert.equal(result.json().delivery, failure === 'badReceipt' ? 'uncertain' : 'failed');
      assert.match(calls.at(-1)!.body.text, /\/help/);
      outcome = 'sent';
      await go('learn:v1:pair:0');
      const count = edits().length;
      await webhook(failedCallback);
      assert.equal(edits().length, count, 'a late retry of a failed button must not undo newer navigation');
    }
    outcome = 'sent'; failAnswer = true;
    const answerLost = callback('learn:v1:pair:0');
    assert.equal((await webhook(answerLost)).json().delivery, 'sent');
    const editedCount = edits().length;
    await webhook(answerLost);
    assert.equal(edits().length, editedCount, 'answer failure does not duplicate the completed edit');
    failAnswer = false;
    for (const data of ['learn:v1:personal:9', 'learn:v2:intro', 'learn:v1:__proto__:0', 'learn:v1:personal:01', 'learn:v1:intro\n', '<b>user text</b>', {}, null]) {
      const result = await webhook(callback(data));
      assert.equal(result.statusCode, 200); assert.equal(result.json().delivery, 'skipped');
    }
    for (const variant of ['foreign', 'group', 'otherBot', 'inaccessible', 'noMessage', 'badMessageId', 'badDate', 'unrelatedMessage', 'badKeyboard']) {
      const payload: any = callback('learn:v1:intro');
      if (variant === 'foreign') payload.callback_query.from.id++;
      if (variant === 'group') payload.callback_query.message.chat.type = 'supergroup';
      if (variant === 'otherBot') payload.callback_query.message.from.id++;
      if (variant === 'inaccessible') payload.callback_query.message.date = 0;
      if (variant === 'noMessage') delete payload.callback_query.message;
      if (variant === 'badMessageId') payload.callback_query.message.message_id = -1;
      if (variant === 'badDate') payload.callback_query.message.date = 'yesterday';
      if (variant === 'unrelatedMessage') delete payload.callback_query.message.reply_markup;
      if (variant === 'badKeyboard') payload.callback_query.message.reply_markup.inline_keyboard = [null, {}];
      assert.equal((await webhook(payload)).json().delivery, 'skipped');
    }
    assert.equal(edits().length, editedCount);
    const restarted = buildApp({ ...config, botToken: '300000000:rotated-synthetic-token' }, db);
    try {
      assert.equal((await restarted.inject({ method: 'POST', url: '/api/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': config.webhookSecret }, payload: answerLost })).json().delivery, 'sent');
      assert.equal(edits().length, editedCount, 'deduplication survives app restart and token rotation');
    } finally { await restarted.close(); }
    assert.equal((await webhook(callback('learn:v1:intro'), 'wrong-secret')).statusCode, 401);
    assert.equal((await webhook({ update_id: stamp, callback_query: { id: {}, from: { id: stamp } } })).statusCode, 400);
    assert.equal((await webhook({ update_id: stamp, callback_query: { id: 'valid', from: {} } })).statusCode, 400);
    assert.equal(calls.filter(call => call.method === 'sendMessage').length, 2, 'callbacks only edit the requested private message');
    for (const {method, body} of calls) {
      if (method === 'answerCallbackQuery') { assert.equal(body.cache_time, 0); continue; }
      assert.ok(body.text.length < 4096);
      for (const button of buttons(body)) if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
    }
    assert.equal((await db.query('SELECT count(*) FROM users WHERE telegram_id = $1', [stamp])).rows[0].count, '0', 'learning does not create an account or tasks');
  } finally {
    await app.close();
    await db.query('DELETE FROM telegram_entry_deliveries WHERE key = ANY($1)', [keys]);
    await db.end();
  }
});
