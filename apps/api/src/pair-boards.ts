import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withBoardLock, type Database } from './db.js';

export class BoardAccessError extends Error {
  constructor(message: string, public status = 403) { super(message); }
}
const linkHash = (token: string) => createHash('sha256').update(token).digest('hex');

async function pairAccess(client: pg.PoolClient, userId: string, boardId: string, ownerOnly = true) {
  const result = await client.query(`SELECT b.*, m.role FROM boards b JOIN memberships m ON m.board_id = b.id
    WHERE b.id = $1 AND b.type = 'pair' AND m.user_id = $2 FOR UPDATE OF b`, [boardId, userId]);
  const board = result.rows[0];
  if (!board || (ownerOnly && board.owner_user_id !== userId)) throw new BoardAccessError('Нет доступа к управлению доской');
  return board;
}

export async function createPairBoard(db: Database, userId: string, name: string, requestId: string) {
  return withBoardLock(db, `${userId}:${requestId}`, async (client) => {
    const result = await client.query(`INSERT INTO boards (id, type, name, owner_user_id, status, create_request_id)
      VALUES ($1, 'pair', $2, $3, 'active', $4)
      ON CONFLICT (owner_user_id, create_request_id) WHERE type = 'pair' DO UPDATE SET name = boards.name
      RETURNING id, type, name, status, 'owner' AS role`, [randomUUID(), name, userId, requestId]);
    const board = result.rows[0];
    await client.query(`INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'owner')
      ON CONFLICT DO NOTHING`, [board.id, userId]);
    return board;
  });
}

export async function previewPairInvite(db: Database, userId: string, token: string) {
  const result = await db.query(`SELECT b.id, b.name, u.first_name AS owner_name,
      EXISTS (SELECT 1 FROM memberships WHERE board_id = b.id AND user_id = $2) AS joined,
      (SELECT count(*) FROM memberships WHERE board_id = b.id) >= 2 AS full
    FROM board_links l JOIN boards b ON b.id = l.board_id JOIN users u ON u.id = b.owner_user_id
    WHERE l.token_hash = $1 AND l.kind = 'invite' AND l.revoked_at IS NULL AND b.type = 'pair' AND b.status = 'active'`, [linkHash(token), userId]);
  return result.rows[0] ?? null;
}

export async function redeemPairInvite(db: Database, userId: string, token: string, acceptedHistory: boolean) {
  const link = (await db.query<{board_id: string}>('SELECT board_id FROM board_links WHERE token_hash = $1', [linkHash(token)])).rows[0];
  if (!link) return null;
  return withBoardLock(db, link.board_id, async (client) => {
    const valid = await client.query(`SELECT b.id FROM boards b JOIN board_links l ON l.board_id = b.id
      WHERE b.id = $1 AND b.type = 'pair' AND b.status = 'active' AND l.kind = 'invite'
        AND l.token_hash = $2 AND l.revoked_at IS NULL FOR UPDATE OF b`, [link.board_id, linkHash(token)]);
    if (!valid.rowCount) return null;
    const member = await client.query('SELECT 1 FROM memberships WHERE board_id = $1 AND user_id = $2', [link.board_id, userId]);
    if (!member.rowCount) {
      if (!acceptedHistory) throw new BoardAccessError('Подтвердите доступ ко всей прежней истории доски', 400);
      const count = await client.query<{count: string}>('SELECT count(*) FROM memberships WHERE board_id = $1', [link.board_id]);
      if (Number(count.rows[0].count) >= 2) throw new BoardAccessError('В доске уже два участника', 409);
      await client.query("INSERT INTO memberships (board_id, user_id, role) VALUES ($1, $2, 'member')", [link.board_id, userId]);
    }
    return (await client.query(`SELECT b.id, b.type, b.name, b.status, m.role FROM boards b
      JOIN memberships m ON m.board_id = b.id WHERE b.id = $1 AND m.user_id = $2`, [link.board_id, userId])).rows[0];
  });
}

export async function changePairInvite(db: Database, userId: string, boardId: string, revoke = false) {
  return withBoardLock(db, boardId, async (client) => {
    const board = await pairAccess(client, userId, boardId);
    if (board.status !== 'active') throw new BoardAccessError('Доска в архиве: доступ только для чтения');
    if (!revoke) {
      const count = await client.query<{count: string}>('SELECT count(*) FROM memberships WHERE board_id = $1', [boardId]);
      if (Number(count.rows[0].count) >= 2) throw new BoardAccessError('В доске уже два участника', 409);
    }
    await client.query("UPDATE board_links SET revoked_at = now() WHERE board_id = $1 AND kind = 'invite' AND revoked_at IS NULL", [boardId]);
    if (revoke) return null;
    const token = `pair_${randomBytes(24).toString('base64url')}`;
    await client.query("INSERT INTO board_links (token_hash, board_id, kind) VALUES ($1, $2, 'invite')", [linkHash(token), boardId]);
    return token;
  });
}

export async function removePairMember(db: Database, userId: string, boardId: string, participantId: string) {
  return withBoardLock(db, boardId, async (client) => {
    const leave = participantId === userId;
    const board = await pairAccess(client, userId, boardId, !leave);
    if (leave && board.owner_user_id === userId) throw new BoardAccessError('Владелец может архивировать доску, но не выйти');
    if (board.status !== 'active') throw new BoardAccessError('Доска в архиве: доступ только для чтения');
    const member = await client.query<{user_id: string}>('SELECT user_id FROM memberships WHERE board_id = $1 AND user_id <> $2', [boardId, board.owner_user_id]);
    const removedId = member.rows[0]?.user_id;
    if (!removedId || removedId !== participantId) return { removed: false };
    const tasks = await client.query('SELECT * FROM tasks WHERE board_id = $1 AND assignee_user_id = $2 FOR UPDATE', [boardId, removedId]);
    await client.query('UPDATE tasks SET assignee_user_id = NULL WHERE board_id = $1 AND assignee_user_id = $2', [boardId, removedId]);
    for (const task of tasks.rows) await client.query(`INSERT INTO task_audit_events (id, board_id, task_id, actor_user_id, action, before_data, after_data)
      VALUES ($1, $2, $3, $4, 'member_left', $5, $6)`, [randomUUID(), boardId, task.id, userId, task, { ...task, assignee_user_id: null }]);
    await client.query('UPDATE recurrence_templates SET assignee_user_id = NULL WHERE board_id = $1 AND assignee_user_id = $2', [boardId, removedId]);
    await client.query(`UPDATE task_assignment_notifications n SET status = 'failed', error = 'Доступ отозван'
      FROM tasks t WHERE t.id = n.task_id AND t.board_id = $1 AND n.assignee_user_id = $2 AND n.status = 'pending'`, [boardId, removedId]);
    await client.query("UPDATE board_links SET revoked_at = now() WHERE board_id = $1 AND kind = 'invite' AND revoked_at IS NULL", [boardId]);
    await client.query('DELETE FROM memberships WHERE board_id = $1 AND user_id = $2', [boardId, removedId]);
    return { removed: true };
  });
}

export async function setPairArchived(db: Database, userId: string, boardId: string, archived: boolean) {
  return withBoardLock(db, boardId, async (client) => {
    await pairAccess(client, userId, boardId);
    return (await client.query(`UPDATE boards SET status = $2 WHERE id = $1
      RETURNING id, type, name, status, 'owner' AS role`, [boardId, archived ? 'archived' : 'active'])).rows[0];
  });
}
