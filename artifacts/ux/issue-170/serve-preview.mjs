// Run after npm run build. This loopback preview never starts bot workers.
import { randomBytes } from 'node:crypto';
import { buildApp } from '../../../apps/api/dist/app.js';
import { createDatabase } from '../../../apps/api/dist/db.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== '127.0.0.1' || new URL(databaseUrl).pathname !== '/tasca_issue170_local_checks') {
  throw new Error('Preview requires the isolated local tasca_issue170_local_checks database');
}
const db = createDatabase(databaseUrl);
const app = buildApp({
  botToken: 'local-preview-no-telegram-credentials', databaseUrl,
  sessionSecret: randomBytes(32).toString('hex'), webhookSecret: randomBytes(32).toString('hex'),
  initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 3600, production: false,
  host: '127.0.0.1', port: 4182, publicUrl: 'http://127.0.0.1:4182', botUsername: 'kairostask_bot'
}, db);
app.addHook('onRequest', async (request, reply) => {
  const pathname = new URL(request.url, 'http://127.0.0.1:4182').pathname;
  if (!['GET', 'HEAD'].includes(request.method) || (pathname.startsWith('/api') && pathname !== '/api/bot-entry') || pathname.startsWith('/mcp')) {
    return reply.code(403).send({ error: 'Read-only landing preview' });
  }
});
await app.listen({ host: '127.0.0.1', port: 4182 });
console.log('Локальный просмотр лендинга: http://127.0.0.1:4182/');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); await db.end(); process.exit(0); });
