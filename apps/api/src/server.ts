import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { startPublicationScheduler } from './publications.js';

const config = loadConfig();
const db = createDatabase(config.databaseUrl);
const app = buildApp(config, db);
const stopScheduler = startPublicationScheduler(db, config.botToken, config.botUsername);
const shutdown = async () => { stopScheduler(); await app.close(); await db.end(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
await app.listen({ host: config.host, port: config.port });
