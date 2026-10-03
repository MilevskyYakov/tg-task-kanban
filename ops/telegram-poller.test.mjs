import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { deliverBatch, forwardUpdate } from './telegram-poller.mjs';

assert.equal(await deliverBatch([], () => assert.fail('Empty batch delivered')), undefined);
for (const invalid of [null, {}, [{ update_id: -1 }], [{ update_id: 1.5 }],
  [{ update_id: Number.MAX_SAFE_INTEGER }], [{ update_id: 2 }, { update_id: 1 }],
  [{ update_id: 1 }, { update_id: 1 }]]) {
  await assert.rejects(() => deliverBatch(invalid, () => assert.fail('Invalid batch delivered')));
}
let offset = 10;
const attempted = [];
await assert.rejects(async () => {
  offset = await deliverBatch([{ update_id: 10 }, { update_id: 12 }], async (update) => {
    attempted.push(update.update_id);
    if (update.update_id === 12) throw new Error('Transport interrupted');
  });
});
assert.equal(offset, 10, 'Failed delivery must not acknowledge later updates');
assert.deepEqual(attempted, [10, 12]);
const replayed = [];
offset = await deliverBatch([{ update_id: 10 }, { update_id: 12 }], async (update) => replayed.push(update.update_id));
assert.equal(offset, 13);
assert.deepEqual(replayed, [10, 12], 'An unconfirmed batch must replay through app deduplication');

let status = 503;
let responseBody = { ok: false, delivery: 'failed' };
let requests = 0;
const secret = 'local-test-only-secret-not-a-credential';
const server = createServer(async (request, response) => {
  requests++;
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['x-telegram-bot-api-secret-token'], secret);
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { update_id: 10 });
  response.writeHead(status, { 'content-type': 'application/json', location: '/must-not-follow' });
  response.end(JSON.stringify(responseBody));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const target = `http://127.0.0.1:${server.address().port}/api/telegram/webhook`;
try {
  const send = () => forwardUpdate({ update_id: 10 }, target, secret, AbortSignal.timeout(1000));
  await assert.rejects(send, { status: 503 });
  status = 200;
  for (const delivery of ['sent', 'uncertain', 'failed', 'skipped']) {
    responseBody = { ok: delivery === 'sent', delivery };
    assert.deepEqual(await send(), responseBody, 'Preserve HTTP-200 no-resend contract');
  }
  responseBody = {};
  await assert.rejects(send, /receipt missing/);
  status = 302;
  const before = requests;
  await assert.rejects(send);
  assert.equal(requests, before + 1, 'Redirect must not receive the webhook secret');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => forwardUpdate({ update_id: 10 }, target, secret, controller.signal));
  assert.equal(requests, before + 1, 'Cancelled work must remain unacknowledged');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
console.log('Polling acknowledgement, replay, HTTP receipt, auth, redirect and abort checks: PASS');
