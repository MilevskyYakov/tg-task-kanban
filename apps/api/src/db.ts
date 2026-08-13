import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { TelegramUser } from './auth.js';

const { Pool } = pg;
export type Database = InstanceType<typeof Pool>;
export const createDatabase = (connectionString: string): Database => new Pool({ connectionString, max: 10 });
const tokenHash = (token: string, secret: string) => createHash('sha256').update(`${secret}:${token}`).digest('hex');

export async function login(db: Database, telegram: TelegramUser, sessionSeconds: number, secret: string) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{id: string}>(`INSERT INTO users (telegram_id, first_name, username)
      VALUES ($1, $2, $3) ON CONFLICT (telegram_id) DO UPDATE
      SET first_name = EXCLUDED.first_name, username = EXCLUDED.username, updated_at = now() RETURNING id`,
      [telegram.id, telegram.first_name, telegram.username ?? null]);
    const userId = user.rows[0].id;
    const existing = await client.query<{id: string}>("SELECT id FROM boards WHERE type = 'personal' AND owner_user_id = $1", [userId]);
    let boardId = existing.rows[0]?.id;
    if (!boardId) {
      boardId = randomUUID();
      await client.query("INSERT INTO boards (id, type, name, owner_user_id) VALUES ($1, 'personal', 'Личная доска', $2)", [boardId, userId]);
      await client.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'owner')", [boardId, userId]);
    }
    const token = randomBytes(32).toString('base64url');
    await client.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3 * interval '1 second'))", [tokenHash(token, secret), userId, sessionSeconds]);
    await client.query('COMMIT');
    return { token, userId };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function sessionUserId(db: Database, token: string | undefined, secret: string): Promise<string | null> {
  if (!token) return null;
  const result = await db.query<{user_id: string}>(`SELECT user_id FROM sessions
    WHERE token_hash = $1 AND expires_at > now()`, [tokenHash(token, secret)]);
  return result.rows[0]?.user_id ?? null;
}

export async function boardsForUser(db: Database, userId: string) {
  const result = await db.query(`SELECT b.id, b.type, b.name, m.role FROM boards b
    JOIN memberships m ON m.board_id = b.id WHERE m.user_id = $1 ORDER BY b.name`, [userId]);
  return result.rows;
}

export async function boardForUser(db: Database, userId: string, boardId: string) {
  const result = await db.query(`SELECT b.id, b.type, b.name, m.role FROM boards b
    JOIN memberships m ON m.board_id = b.id WHERE b.id = $1 AND m.user_id = $2`, [boardId, userId]);
  return result.rows[0] ?? null;
}

export async function renameBoard(db: Database, userId: string, boardId: string, name: string) {
  const result = await db.query(`UPDATE boards b SET name = $3 FROM memberships m
    WHERE b.id = $1 AND m.board_id = b.id AND m.user_id = $2 AND m.role IN ('owner', 'admin') RETURNING b.id, b.type, b.name`,
    [boardId, userId, name]);
  return result.rows[0] ?? null;
}
