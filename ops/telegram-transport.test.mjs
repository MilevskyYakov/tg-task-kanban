import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createTelegramDispatcher } from './telegram-transport.mjs';

let posts = 0, tunnels = 0, loseReply = false;
const sockets = new Set();
const upstream = createServer(async (request, response) => {
  posts++;
  let body = '';
  for await (const chunk of request) body += chunk;
  assert.equal(body, 'only-once');
  if (loseReply) request.socket.destroy();
  else response.end('received');
});
const proxy = createServer();
for (const server of [upstream, proxy]) {
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
}
proxy.on('connect', (request, socket, head) => {
  tunnels++;
  assert.equal(request.url, 'example.test:80');
  if (tunnels === 1) return; // Simulate stalled CONNECT, before any application bytes.
  const target = connect(upstream.address().port, '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) target.write(head);
    socket.pipe(target);
    target.pipe(socket);
  });
  socket.on('close', () => target.destroy());
  target.on('error', () => socket.destroy());
});
const dispatcher = createTelegramDispatcher(`http://127.0.0.1:${proxy.address().port}`);
const send = () => fetch('http://example.test/', {
  method: 'POST', body: 'only-once', dispatcher, signal: AbortSignal.timeout(6000)
});
try {
  assert.equal(await (await send()).text(), 'received');
  assert.equal(tunnels, 2, 'Only failed CONNECT should retry');
  assert.equal(posts, 1);
  loseReply = true;
  await assert.rejects(send);
  assert.equal(posts, 2, 'An ambiguous POST must never be retried');
  console.log('CONNECT retry before transmission; no retry after ambiguous POST: PASS');
} finally {
  await dispatcher.destroy();
  for (const socket of sockets) socket.destroy();
  await Promise.all([upstream, proxy].map(server => new Promise(resolve => server.close(resolve))));
}
