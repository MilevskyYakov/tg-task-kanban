import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withBoardLock, type Database } from './db.js';
import { BoardAccessError } from './pair-boards.js';
import { isChatAdmin } from './telegram.js';

async function access(client: Database | pg.PoolClient, userId: string, boardId: string, botToken: string) {
  const board = (await client.query(`SELECT b.*, u.telegram_id AS actor_telegram_id,
      root.chat_members_version, root.status AS chat_status
    FROM boards b JOIN memberships m ON m.board_id = b.id AND m.user_id = $2
    JOIN users u ON u.id = m.user_id LEFT JOIN boards root ON root.id = b.chat_root_id
    WHERE b.id = $1`, [boardId, userId])).rows[0];
  if (!board) throw new BoardAccessError('Доска недоступна', 404);
  if (board.type === 'personal') throw new BoardAccessError('Личная доска постоянная: её нельзя удалить');
  if (board.type === 'pair' && board.owner_user_id !== userId) throw new BoardAccessError('Удалять и восстанавливать доску может только владелец');
  if (board.type === 'chat') {
    try {
      if (!await isChatAdmin(botToken, board.telegram_chat_id, board.actor_telegram_id)) throw new BoardAccessError('Требуются текущие права администратора Telegram');
    } catch (error) {
      if (error instanceof BoardAccessError) throw error;
      throw new BoardAccessError('Не удалось проверить права в Telegram. Повторите позже', 503);
    }
  }
  return board;
}

async function snapshot(client: pg.PoolClient, board: Record<string, any>) {
  const counts = (await client.query(`SELECT
    (SELECT count(*)::int FROM tasks WHERE board_id = $1) AS tasks,
    (SELECT count(*)::int FROM projects WHERE board_id = $1) AS projects,
    (SELECT count(*)::int FROM task_comments WHERE board_id = $1) AS comments,
    (SELECT count(*)::int FROM task_attachments WHERE board_id = $1) AS attachments,
    (SELECT count(*)::int FROM task_checklist_items WHERE board_id = $1) AS checklist,
    (SELECT count(*)::int FROM task_audit_events WHERE board_id = $1) AS history,
    (SELECT count(*)::int FROM recurrence_templates WHERE board_id = $1) AS recurrences,
    (SELECT count(*)::int FROM tasks WHERE board_id = $1 AND blocked_by_task_id IS NOT NULL) AS dependencies,
    (SELECT COALESCE(sum(revision), 0)::text FROM tasks WHERE board_id = $1) AS task_version,
    (SELECT COALESCE(sum(revision), 0)::text FROM recurrence_templates WHERE board_id = $1) AS recurrence_version`, [board.id])).rows[0];
  const schedules = (await client.query(`SELECT s.* FROM publication_schedules s JOIN boards b ON b.id = s.board_id
    WHERE b.chat_root_id = $1 ORDER BY s.board_id, s.kind`, [board.chat_root_id])).rows;
  const confirmation = createHash('sha256').update(JSON.stringify([board, counts, schedules])).digest('hex');
  const {task_version, recurrence_version, ...visibleCounts} = counts;
  return {id: board.id as string, name: board.name as string, type: board.type as string, deleted: Boolean(board.deleted_at),
    version: String(board.lifecycle_version), counts: visibleCounts, confirmation};
}

export async function boardDeletionPreview(db: Database, userId: string, boardId: string, botToken: string) {
  return withBoardLock(db, boardId, async client => snapshot(client, await access(client, userId, boardId, botToken)));
}

export async function deletedBoards(db: Database, userId: string, botToken: string) {
  const candidates = (await db.query(`SELECT b.id, b.name, b.type, b.chat_root_id FROM boards b
    JOIN memberships m ON m.board_id = b.id WHERE m.user_id = $1 AND b.deleted_at IS NOT NULL
    AND (b.type = 'chat' OR b.owner_user_id = $1) ORDER BY b.name, b.id`, [userId])).rows;
  const boards = [];
  for (const board of candidates) {
    try { await access(db, userId, board.id, botToken); boards.push(board); }
    catch (error) { if (!(error instanceof BoardAccessError) || error.status !== 403) throw error; }
  }
  return boards;
}

export async function changeBoardDeletion(db: Database, userId: string, boardId: string, botToken: string,
  input: {action: 'delete' | 'restore'; requestId: string; confirmation: string}) {
  return withBoardLock(db, boardId, async client => {
    const board = await access(client, userId, boardId, botToken);
    // Take the row lock before revoking grants: concurrent MCP reads/connection
    // edits finish before deletion, and cannot grant access after it commits.
    await client.query('SELECT id FROM boards WHERE id = $1 FOR UPDATE', [boardId]);
    const receipt = (await client.query('SELECT * FROM board_lifecycle_events WHERE board_id = $1 AND request_id = $2', [boardId, input.requestId])).rows[0];
    if (receipt) {
      if (receipt.actor_user_id !== userId || receipt.action !== input.action || receipt.confirmation !== input.confirmation)
        throw new BoardAccessError('Этот запрос уже использован с другими данными', 409);
      return {id: boardId, deleted: Boolean(board.deleted_at), version: String(board.lifecycle_version), replayed: true};
    }
    const current = await snapshot(client, board);
    if (current.confirmation !== input.confirmation || current.deleted !== (input.action === 'restore'))
      throw new BoardAccessError('Доска изменилась. Проверьте состав данных и подтвердите заново', 409);
    if (input.action === 'delete') {
      await client.query('UPDATE recurrence_templates SET paused_at = COALESCE(paused_at, now()), next_occurrence_at = NULL WHERE board_id = $1 AND archived_at IS NULL', [boardId]);
      // Never delete shared memberships: that would revoke access to sibling boards.
      await client.query('DELETE FROM mcp_board_grants WHERE board_id = $1', [boardId]);
      await client.query(`INSERT INTO mcp_membership_losses (board_id, user_id)
        SELECT board_id, user_id FROM memberships WHERE board_id = $1 ON CONFLICT DO NOTHING`, [boardId]);
      await client.query("UPDATE board_links SET revoked_at = now() WHERE board_id = $1 AND kind NOT IN ('chat_launch', 'chat_invite') AND revoked_at IS NULL", [boardId]);
      await client.query(`UPDATE board_links SET revoked_at = now() WHERE board_id = $2 AND kind = 'chat_invite' AND revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM boards WHERE chat_root_id = $2 AND id <> $1 AND deleted_at IS NULL)`, [boardId, board.chat_root_id]);
      await client.query(`UPDATE task_assignment_notifications n SET status = 'failed', error = 'Доска удалена'
        FROM tasks t WHERE t.id = n.task_id AND t.board_id = $1 AND n.status = 'pending'`, [boardId]);
      await client.query(`UPDATE publication_runs r SET status = CASE WHEN r.status = 'sending' THEN 'uncertain' ELSE 'cancelled' END, last_error = 'board_deleted'
        FROM publication_schedules s WHERE s.board_id = r.board_id AND s.kind = r.kind AND r.status IN ('pending', 'sending')
        AND ($1 = ANY(COALESCE(r.board_ids, s.included_board_ids, ARRAY[s.board_id]))
          OR (r.board_id = $1 AND NOT EXISTS (SELECT 1 FROM boards WHERE chat_root_id = $1 AND id <> $1 AND deleted_at IS NULL)))`, [boardId]);
      await client.query(`UPDATE publication_schedules SET included_board_ids = array_remove(COALESCE(included_board_ids, ARRAY[board_id]), $1::uuid),
        enabled = enabled AND cardinality(array_remove(COALESCE(included_board_ids, ARRAY[board_id]), $1::uuid)) > 0, updated_at = now()
        WHERE $1 = ANY(COALESCE(included_board_ids, ARRAY[board_id]))`, [boardId]);
      await client.query(`UPDATE publication_schedules SET enabled = false WHERE board_id = $1
        AND (NOT EXISTS (SELECT 1 FROM boards WHERE id = $1 AND chat_root_id = id AND chat_multi_enabled)
          OR NOT EXISTS (SELECT 1 FROM boards WHERE chat_root_id = $1 AND id <> $1 AND deleted_at IS NULL))`, [boardId]);
    } else {
      // Members added while the board was deleted must not silently acquire it
      // through an existing automatic MCP connection when it is restored.
      await client.query(`INSERT INTO mcp_membership_losses (board_id, user_id)
        SELECT board_id, user_id FROM memberships WHERE board_id = $1 ON CONFLICT DO NOTHING`, [boardId]);
    }
    const updated = (await client.query(`UPDATE boards SET deleted_at = CASE WHEN $2 THEN now() ELSE NULL END,
      lifecycle_version = lifecycle_version + 1 WHERE id = $1 RETURNING lifecycle_version::text AS version`, [boardId, input.action === 'delete'])).rows[0];
    await client.query(`INSERT INTO board_lifecycle_events (board_id, request_id, actor_user_id, action, confirmation, version)
      VALUES ($1, $2, $3, $4, $5, $6)`, [boardId, input.requestId, userId, input.action, input.confirmation, updated.version]);
    return {id: boardId, deleted: input.action === 'delete', version: updated.version, replayed: false};
  });
}
