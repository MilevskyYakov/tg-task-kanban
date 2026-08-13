import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './db.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = createDatabase(url);
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
for (const file of (await fs.readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
  await db.query(await fs.readFile(path.join(directory, file), 'utf8'));
  console.log(`applied ${file}`);
}
await db.end();
