import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase, runRecurrenceScheduler } from './db.js';
import { startPublicationScheduler } from './publications.js';

const config = loadConfig();
const db = createDatabase(config.databaseUrl);
const app = buildApp(config, db);
const tick = async () => { try { await runRecurrenceScheduler(db); } catch (error) { app.log.error({ error }, 'recurrence scheduler failed'); } };
const recurrenceScheduler = setInterval(() => void tick(), 60_000);
const stopPublicationScheduler = startPublicationScheduler(db, config.botToken, config.botUsername,
  (error) => app.log.error({ error }, 'publication scheduler failed'));
const shutdown = async () => { clearInterval(recurrenceScheduler); stopPublicationScheduler(); await app.close(); await db.end(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
await app.listen({ host: config.host, port: config.port });
await tick();
