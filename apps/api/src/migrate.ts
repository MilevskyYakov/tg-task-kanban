import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './db.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = createDatabase(url);
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const client = await db.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtextextended('schema-migrations', 0))");
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const file of (await fs.readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
    if ((await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file])).rowCount) continue;
    await client.query(await fs.readFile(path.join(directory, file), 'utf8'));
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    console.log(`applied ${file}`);
  }
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  try { await client.query("SELECT pg_advisory_unlock(hashtextextended('schema-migrations', 0))"); }
  finally { client.release(); await db.end(); }
}
