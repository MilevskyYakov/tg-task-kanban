import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { TelegramUser } from './auth.js';

const { Pool } = pg;
export type Database = InstanceType<typeof Pool>;
export const createDatabase = (connectionString: string): Database => new Pool({ connectionString, max: 10 });
const tokenHash = (token: string, secret: string) => createHash('sha256').update(`${secret}:${token}`).digest('hex');
const linkHash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function login(db: Database, telegram: TelegramUser, sessionSeconds: number, secret: string) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{id: string}>(`INSERT INTO users (telegram_id, first_name, username)
      VALUES ($1, $2, $3) ON CONFLICT (telegram_id) DO UPDATE
      SET first_name = EXCLUDED.first_name, username = EXCLUDED.username, updated_at = now() RETURNING id`,
      [telegram.id, telegram.first_name, telegram.username ?? null]);
    const userId = user.rows[0].id;
    const candidateBoardId = randomUUID();
    await client.query(`INSERT INTO boards (id, type, name, owner_user_id)
      VALUES ($1, 'personal', 'Личная доска', $2)
      ON CONFLICT (owner_user_id) WHERE type = 'personal' DO NOTHING`, [candidateBoardId, userId]);
    const board = await client.query<{id: string}>("SELECT id FROM boards WHERE type = 'personal' AND owner_user_id = $1", [userId]);
    const boardId = board.rows[0].id;
    await client.query(`INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'owner')
      ON CONFLICT (board_id, user_id) DO NOTHING`, [boardId, userId]);
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

export async function sessionUser(db: Database, token: string | undefined, secret: string) {
  if (!token) return null;
  const result = await db.query<{id: string; telegram_id: string}>(`SELECT u.id, u.telegram_id FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`, [tokenHash(token, secret)]);
  return result.rows[0] ?? null;
}

export async function boardsForUser(db: Database, userId: string) {
  const result = await db.query(`SELECT b.id, b.type, b.name, b.status, m.role FROM boards b
    JOIN memberships m ON m.board_id = b.id WHERE m.user_id = $1 ORDER BY b.name`, [userId]);
  return result.rows;
}

export async function boardForUser(db: Database, userId: string, boardId: string) {
  const result = await db.query(`SELECT b.id, b.type, b.name, b.status, b.telegram_chat_id, m.role FROM boards b
    JOIN memberships m ON m.board_id = b.id WHERE b.id = $1 AND m.user_id = $2`, [boardId, userId]);
  return result.rows[0] ?? null;
}

export async function renameBoard(db: Database, userId: string, boardId: string, name: string) {
  const result = await db.query(`UPDATE boards b SET name = $3 FROM memberships m
    WHERE b.id = $1 AND m.board_id = b.id AND m.user_id = $2 AND m.role IN ('owner', 'admin') RETURNING b.id, b.type, b.name`,
    [boardId, userId, name]);
  return result.rows[0] ?? null;
}

export async function connectChatBoard(db: Database, chatId: number, name: string) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const board = await client.query<{id: string; status: string}>(`INSERT INTO boards (id, type, name, telegram_chat_id, status)
      VALUES ($1, 'chat', $2, $3, 'draft') ON CONFLICT (telegram_chat_id) WHERE type = 'chat'
      DO UPDATE SET name = CASE WHEN boards.status = 'draft' THEN EXCLUDED.name ELSE boards.name END,
        status = CASE WHEN boards.status = 'frozen' THEN COALESCE(boards.frozen_from_status, 'active') ELSE boards.status END,
        frozen_from_status = NULL RETURNING id, status`,
      [randomUUID(), name, chatId]);
    const boardId = board.rows[0].id;
    await client.query("UPDATE board_links SET revoked_at = now() WHERE board_id = $1 AND kind = 'launch' AND revoked_at IS NULL", [boardId]);
    const token = `board_${randomBytes(24).toString('base64url')}`;
    await client.query("INSERT INTO board_links (token_hash, board_id, kind) VALUES ($1, $2, 'launch')", [linkHash(token), boardId]);
    await client.query('COMMIT');
    return { id: boardId, status: board.rows[0].status, token };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function migrateChatBoard(db: Database, oldChatId: number, newChatId: number) {
  await db.query("UPDATE boards SET telegram_chat_id = $2 WHERE type = 'chat' AND telegram_chat_id = $1", [oldChatId, newChatId]);
}

export async function freezeChatBoard(db: Database, chatId: number) {
  await db.query("UPDATE boards SET frozen_from_status = status, status = 'frozen' WHERE type = 'chat' AND telegram_chat_id = $1 AND status <> 'frozen'", [chatId]);
}

export async function redeemBoardLink(db: Database, userId: string, token: string) {
  const result = await db.query<{id: string}>(`SELECT b.id FROM board_links l JOIN boards b ON b.id = l.board_id
    WHERE l.token_hash = $1 AND l.revoked_at IS NULL AND b.type = 'chat' AND b.status <> 'frozen'`, [linkHash(token)]);
  const link = result.rows[0];
  if (!link) return null;
  await db.query(`INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'member')
    ON CONFLICT (board_id, user_id) DO NOTHING`, [link.id, userId]);
  return boardForUser(db, userId, link.id);
}

export async function activateChatBoard(db: Database, userId: string, boardId: string, name: string) {
  const result = await db.query(`UPDATE boards b SET name = $3, status = 'active' FROM memberships m
    WHERE b.id = $1 AND b.type = 'chat' AND m.board_id = b.id AND m.user_id = $2 RETURNING b.id, b.type, b.name, b.status`,
    [boardId, userId, name]);
  if (result.rowCount) await db.query("UPDATE memberships SET role = 'admin' WHERE board_id = $1 AND user_id = $2", [boardId, userId]);
  return result.rows[0] ?? null;
}

export async function createInvite(db: Database, userId: string, boardId: string) {
  const allowed = await db.query("SELECT 1 FROM boards b JOIN memberships m ON m.board_id = b.id WHERE b.id = $1 AND b.type = 'chat' AND m.user_id = $2", [boardId, userId]);
  if (!allowed.rowCount) return null;
  const token = `invite_${randomBytes(24).toString('base64url')}`;
  await db.query("INSERT INTO board_links (token_hash, board_id, kind) VALUES ($1, $2, 'invite')", [linkHash(token), boardId]);
  return token;
}

export async function revokeInvites(db: Database, userId: string, boardId: string) {
  const result = await db.query(`UPDATE board_links l SET revoked_at = now() FROM boards b, memberships m
    WHERE l.board_id = $1 AND l.kind = 'invite' AND l.revoked_at IS NULL AND b.id = l.board_id
      AND m.board_id = b.id AND m.user_id = $2 RETURNING l.token_hash`, [boardId, userId]);
  return result.rowCount ?? 0;
}
