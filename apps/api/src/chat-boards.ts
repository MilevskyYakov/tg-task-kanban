import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { boardForUser, boardsForUser, boardMembers, lockBoard, withBoardLock, type Database } from './db.js';
import { BoardAccessError } from './pair-boards.js';
import { isChatAdmin } from './telegram.js';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const fail = (message: string, status = 409): never => { throw new BoardAccessError(message, status); };

// ponytail: lifecycle events share one lock; shard by canonical chat if event throughput warrants it.
async function lifecycle<T>(db: Database, run: (client: pg.PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('chat-lifecycle', 0))");
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function rootForChat(client: pg.PoolClient, chatId: number) {
  return (await client.query(`SELECT b.* FROM boards b WHERE b.id = COALESCE(
    (SELECT root_id FROM chat_aliases WHERE telegram_chat_id = $1),
    (SELECT id FROM boards WHERE type = 'chat' AND chat_root_id = id AND telegram_chat_id = $1))`, [chatId])).rows[0];
}
export async function connectChatBoard(db: Database, chatId: number, name: string, updateId?: number, eventDate = 0) {
  return lifecycle(db, async (client) => {
    let root = await rootForChat(client, chatId);
    if (!root) {
      const id = randomUUID();
      root = (await client.query(`INSERT INTO boards (id, type, name, telegram_chat_id, status, telegram_member_update_id, telegram_member_date)
        VALUES ($1, 'chat', $2, $3, 'draft', $4, $5) RETURNING *`, [id, name, chatId, updateId ?? null, eventDate])).rows[0];
      await client.query('INSERT INTO chat_aliases VALUES ($1, $2)', [chatId, id]);
    } else {
      await lockBoard(client, root.id);
      // An event from the old group must never revive boards after supergroup migration.
      if (String(root.telegram_chat_id) !== String(chatId)) return null;
      const updated = await client.query(`UPDATE boards SET name = CASE WHEN status = 'draft' AND id = chat_root_id THEN $2 ELSE name END,
        status = CASE WHEN status = 'frozen' THEN COALESCE(frozen_from_status, 'active') ELSE status END,
        frozen_from_status = CASE WHEN status = 'frozen' THEN NULL ELSE frozen_from_status END,
        telegram_member_update_id = COALESCE($3, telegram_member_update_id), telegram_member_date = $4
        WHERE chat_root_id = $1 AND status <> 'archived'
          AND ($3::bigint IS NULL OR telegram_member_update_id IS NULL OR (COALESCE(telegram_member_date, 0), telegram_member_update_id) < ($4, $3)) RETURNING id, status`,
        [root.id, name, updateId ?? null, eventDate]);
      if (!updated.rowCount) return null;
      root = updated.rows.find(row => row.id === root.id) ?? root;
    }
    await client.query(`INSERT INTO publication_schedules (board_id, kind, weekdays, local_time, included_board_ids) VALUES
      ($1, 'daily', ARRAY[1,2,3,4,5]::smallint[], '11:00', ARRAY[$1::uuid]), ($1, 'weekly', ARRAY[1]::smallint[], '10:30', ARRAY[$1::uuid]) ON CONFLICT DO NOTHING`, [root.id]);
    return { id: root.id as string, status: root.status as string };
  });
}
export async function freezeChatBoard(db: Database, chatId: number, updateId?: number, eventDate = 0) {
  return lifecycle(db, async client => {
    const root = await rootForChat(client, chatId);
    if (!root || String(root.telegram_chat_id) !== String(chatId)) return;
    await lockBoard(client, root.id);
    await client.query(`UPDATE boards SET frozen_from_status = CASE WHEN status = 'frozen' THEN frozen_from_status ELSE status END,
      status = 'frozen', telegram_member_update_id = COALESCE($2, telegram_member_update_id), telegram_member_date = $3
      WHERE chat_root_id = $1 AND status <> 'archived'
        AND ($2::bigint IS NULL OR telegram_member_update_id IS NULL OR (COALESCE(telegram_member_date, 0), telegram_member_update_id) < ($3, $2))`, [root.id, updateId ?? null, eventDate]);
  });
}
export async function migrateChatBoard(db: Database, oldChatId: number, newChatId: number) {
  return lifecycle(db, async client => {
    const root = await rootForChat(client, oldChatId);
    if (!root) return;
    await lockBoard(client, root.id);
    const target = await rootForChat(client, newChatId);
    if (target && target.id !== root.id) {
      await lockBoard(client, target.id);
      // Telegram can announce the new supergroup before delivering its migration message.
      // Only an unused onboarding placeholder may be folded into the existing chat.
      const used = (await client.query(`SELECT 1 WHERE
        EXISTS (SELECT 1 FROM boards WHERE chat_root_id = $1 AND (id <> $1 OR status <> 'draft')) OR
        EXISTS (SELECT 1 FROM memberships WHERE board_id = $1) OR EXISTS (SELECT 1 FROM tasks WHERE board_id = $1) OR
        EXISTS (SELECT 1 FROM projects WHERE board_id = $1) OR EXISTS (SELECT 1 FROM recurrence_templates WHERE board_id = $1) OR
        EXISTS (SELECT 1 FROM publication_schedules WHERE board_id = $1 AND enabled) OR EXISTS (SELECT 1 FROM publication_runs WHERE board_id = $1)`, [target.id])).rowCount;
      if (used) fail('Чаты уже имеют разные доски. Нужна проверка миграции.');
      await client.query('UPDATE chat_aliases SET root_id = $2 WHERE root_id = $1', [target.id, root.id]);
      await client.query('UPDATE board_links SET board_id = $2 WHERE board_id = $1', [target.id, root.id]);
      await client.query('UPDATE telegram_entry_deliveries SET board_id = $2 WHERE board_id = $1', [target.id, root.id]);
      await client.query('DELETE FROM boards WHERE id = $1', [target.id]);
    }
    if (String(root.telegram_chat_id) === String(newChatId)) return;
    if (String(root.telegram_chat_id) !== String(oldChatId)) return;
    await client.query('INSERT INTO chat_aliases VALUES ($1, $3), ($2, $3) ON CONFLICT DO NOTHING', [oldChatId, newChatId, root.id]);
    await client.query('UPDATE boards SET telegram_chat_id = $2 WHERE chat_root_id = $1', [root.id, newChatId]);
  });
}

export async function chatAccess(client: pg.PoolClient, userId: string, boardId: string, botToken?: string) {
  const root = (await client.query(`SELECT r.*, u.telegram_id AS actor_telegram_id FROM boards b JOIN boards r ON r.id = b.chat_root_id
    JOIN memberships m ON m.board_id = b.id AND m.user_id = $2 JOIN users u ON u.id = m.user_id WHERE b.id = $1`, [boardId, userId])).rows[0];
  if (!root) fail('Доска недоступна', 404);
  if (botToken !== undefined) {
    if (root.status !== 'active') fail('Доски чата доступны только для чтения', 403);
    if (!await isChatAdmin(botToken, root.telegram_chat_id, root.actor_telegram_id)) fail('Требуются права администратора Telegram', 403);
  }
  return root;
}
export async function chatContext(db: Database, userId: string, boardId: string, botToken: string) {
  return withBoardLock(db, boardId, async client => {
    const root = await chatAccess(client, userId, boardId);
    const canManage = root.status === 'active' && await isChatAdmin(botToken, root.telegram_chat_id, root.actor_telegram_id);
    const boards = (await boardsForUser(client, userId)).filter(board => board.chat_root_id === root.id);
    const schedules = await legacySchedules(client, root.id);
    return { rootId: root.id, name: root.name, multiEnabled: root.chat_multi_enabled, memberVersion: root.chat_members_version,
      canManage, boards, members: await boardMembers(client, userId, root.id),
      ...(schedules.some(schedule => schedule.board_id !== root.id) ? { conflictingSchedules: schedules, scheduleVersion: hash(JSON.stringify(schedules)) } : {}) };
  });
}
export async function createChatDirection(db: Database, userId: string, boardId: string, botToken: string,
  input: {name: string; requestId: string; memberVersion?: string; memberIds?: string[]}) {
  return withBoardLock(db, boardId, async client => {
    const root = await chatAccess(client, userId, boardId, botToken);
    const requestHash = hash(JSON.stringify({name: input.name, memberVersion: input.memberVersion ?? null, memberIds: input.memberIds ? [...input.memberIds].sort() : null}));
    const existing = (await client.query('SELECT id, chat_create_hash FROM boards WHERE chat_root_id = $1 AND created_by_user_id = $2 AND create_request_id = $3', [root.id, userId, input.requestId])).rows[0];
    if (existing) {
      if (existing.chat_create_hash !== requestHash) fail('Этот запрос уже использован с другими данными');
      return { id: existing.id };
    }
    const independent = await client.query(`SELECT 1 FROM publication_schedules s JOIN boards b ON b.id = s.board_id WHERE b.chat_root_id = $1 AND b.id <> $1`, [root.id]);
    if (independent.rowCount) fail('Сначала согласуйте отдельные расписания досок. Прежние публикации продолжаются.');
    if (!root.chat_multi_enabled) {
      if (!input.memberIds?.includes(userId) || input.memberVersion !== root.chat_members_version) fail('Подтвердите актуальный состав участников перед созданием второй доски');
      const members = (await client.query<{user_id: string}>('SELECT user_id FROM memberships WHERE board_id = $1 ORDER BY user_id', [root.id])).rows.map(row => row.user_id);
      if (input.memberIds!.some(id => !members.includes(id))) fail('Состав изменился. Откройте подтверждение заново');
      await client.query('DELETE FROM memberships WHERE board_id IN (SELECT id FROM boards WHERE chat_root_id = $1) AND NOT (user_id = ANY($2::bigint[]))', [root.id, input.memberIds]);
      await client.query("UPDATE board_links SET revoked_at = now() WHERE board_id IN (SELECT id FROM boards WHERE chat_root_id = $1) AND kind = 'invite' AND revoked_at IS NULL", [root.id]);
      await client.query('UPDATE boards SET chat_multi_enabled = true WHERE id = $1', [root.id]);
      await client.query(`INSERT INTO memberships (board_id, user_id, role) SELECT b.id, m.user_id, m.role
        FROM boards b CROSS JOIN memberships m WHERE b.chat_root_id = $1 AND b.id <> $1 AND m.board_id = $1 ON CONFLICT DO NOTHING`, [root.id]);
    }
    await client.query("UPDATE memberships SET role = 'admin' WHERE board_id = $1 AND user_id = $2 AND role <> 'admin'", [root.id, userId]);
    const id = randomUUID();
    await client.query(`INSERT INTO boards (id, type, name, telegram_chat_id, status, chat_root_id, created_by_user_id, create_request_id, telegram_member_update_id, telegram_member_date, chat_create_hash)
      VALUES ($1, 'chat', $2, $3, 'active', $4, $5, $6, $7, $8, $9)`, [id, input.name, root.telegram_chat_id, root.id, userId, input.requestId, root.telegram_member_update_id, root.telegram_member_date, requestHash]);
    await client.query('INSERT INTO memberships SELECT $1, user_id, role FROM memberships WHERE board_id = $2', [id, root.id]);
    return { id };
  });
}
export async function removeChatMember(db: Database, userId: string, boardId: string, memberId: string, botToken: string) {
  return withBoardLock(db, boardId, async client => {
    const root = await chatAccess(client, userId, boardId, botToken);
    if (memberId === userId) fail('Нельзя удалить себя из управления чатом', 400);
    await client.query('DELETE FROM memberships WHERE board_id = $1 AND user_id = $2', [root.id, memberId]);
    return { removed: true };
  });
}
export async function previewChatInvite(db: Database, token: string) {
  return (await db.query(`SELECT b.name, l.kind = 'chat_invite' AS shared FROM board_links l JOIN boards b ON b.id = l.board_id
    WHERE l.token_hash = $1 AND l.kind IN ('invite', 'chat_invite') AND l.revoked_at IS NULL AND b.status IN ('active', 'draft')`, [hash(token)])).rows[0] ?? null;
}
export async function redeemBoardLink(db: Database, userId: string, token: string, acceptedAccess = false, botToken?: string) {
  const boardLaunch = /^open_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(token);
  if (boardLaunch) {
    // An address, not an invitation. Current membership is the only authority.
    const board = await boardForUser(db, userId, boardLaunch[1]);
    return board && ['chat', 'pair'].includes(board.type) ? board : null;
  }
  const taskLaunch = token.match(/^task_([0-9a-f-]{36})_([0-9a-f-]{36})$/i);
  if (taskLaunch) {
    const task = await db.query(`SELECT 1 FROM tasks WHERE board_id = $1 AND id = $2`, [taskLaunch[1], taskLaunch[2]]);
    return task.rowCount ? boardForUser(db, userId, taskLaunch[1]) : null;
  }
  const found = (await db.query('SELECT board_id FROM board_links WHERE token_hash = $1 AND revoked_at IS NULL', [hash(token)])).rows[0];
  if (!found) return null;
  return withBoardLock(db, found.board_id, async client => {
    const link = (await client.query(`SELECT b.*, l.kind FROM board_links l JOIN boards b ON b.id = l.board_id
      WHERE l.token_hash = $1 AND l.revoked_at IS NULL AND b.type = 'chat' FOR UPDATE OF l`, [hash(token)])).rows[0];
    if (!link) return null;
    const current = (await client.query('SELECT 1 FROM memberships WHERE board_id = $1 AND user_id = $2', [link.id, userId])).rowCount;
    if (!current && !['active', 'draft'].includes(link.status)) return null;
    if (!current) {
      let role = 'member';
      if (link.kind === 'chat_invite') { if (!acceptedAccess) fail('Подтвердите доступ ко всем доскам чата', 409); }
      else if (link.kind !== 'invite') {
        // Bootstrap only the Telegram administrator of an unconfigured group.
        const person = (await client.query('SELECT telegram_id FROM users WHERE id = $1', [userId])).rows[0];
        if (!botToken || link.status !== 'draft' || !person || !await isChatAdmin(botToken, link.telegram_chat_id, person.telegram_id)) return null;
        role = 'admin';
      }
      await client.query('INSERT INTO memberships VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [link.id, userId, role]);
    }
    const board = (await client.query(`SELECT b.id, b.type, b.name, b.status, b.chat_root_id, m.role FROM boards b JOIN memberships m ON m.board_id = b.id WHERE b.id = $1 AND m.user_id = $2`, [link.id, userId])).rows[0];
    return board ? { ...board, ...(link.kind === 'chat_launch' ? { chatEntry: true } : {}) } : null;
  });
}
export async function activateChatBoard(db: Database, userId: string, boardId: string, name: string) {
  return withBoardLock(db, boardId, async client => {
    const result = await client.query(`UPDATE boards b SET name = CASE WHEN status = 'draft' THEN $3 ELSE name END, status = 'active'
      FROM memberships m WHERE b.id = $1 AND b.type = 'chat' AND b.status IN ('draft', 'active')
      AND m.board_id = b.id AND m.user_id = $2 RETURNING b.id, b.type, b.name, b.status`, [boardId, userId, name]);
    if (result.rowCount) await client.query("UPDATE memberships SET role = 'admin' WHERE board_id = $1 AND user_id = $2", [boardId, userId]);
    return result.rows[0] ?? null;
  });
}
export async function createChatLaunch(db: Database, userId: string, boardId: string, botToken: string) {
  return withBoardLock(db, boardId, async client => {
    const root = await chatAccess(client, userId, boardId, botToken);
    const token = `board_${randomBytes(24).toString('base64url')}`;
    await client.query("INSERT INTO board_links (token_hash, board_id, kind) VALUES ($1, $2, 'chat_launch')", [hash(token), root.id]);
    return token;
  });
}
export async function createInvite(db: Database, userId: string, boardId: string, botToken?: string) {
  return withBoardLock(db, boardId, async client => {
    const root = await chatAccess(client, userId, boardId, botToken);
    if (!['active', 'draft'].includes(root.status)) return null;
    const token = `invite_${randomBytes(24).toString('base64url')}`;
    await client.query('INSERT INTO board_links (token_hash, board_id, kind) VALUES ($1, $2, $3)', [hash(token), root.id, root.chat_multi_enabled ? 'chat_invite' : 'invite']);
    return token;
  });
}
export async function revokeInvites(db: Database, userId: string, boardId: string, botToken?: string) {
  return withBoardLock(db, boardId, async client => {
    const root = await chatAccess(client, userId, boardId, botToken);
    return (await client.query("UPDATE board_links SET revoked_at = now() WHERE board_id = $1 AND kind IN ('invite', 'chat_invite') AND revoked_at IS NULL", [root.id])).rowCount ?? 0;
  });
}

async function legacySchedules(client: pg.PoolClient, rootId: string) {
  return (await client.query(`SELECT s.board_id, b.name, s.kind, s.enabled, s.weekdays, to_char(s.local_time, 'HH24:MI') AS local_time,
    s.timezone, s.included_statuses, s.included_board_ids, s.updated_at FROM publication_schedules s JOIN boards b ON b.id = s.board_id
    WHERE b.chat_root_id = $1 ORDER BY s.kind, s.board_id`, [rootId])).rows;
}
export async function resolveChatSchedules(db: Database, userId: string, boardId: string, botToken: string,
  input: {dailySourceId: string; weeklySourceId: string; scheduleVersion: string}) {
  return withBoardLock(db, boardId, async client => {
    const root = await chatAccess(client, userId, boardId, botToken);
    const schedules = await legacySchedules(client, root.id);
    if (hash(JSON.stringify(schedules)) !== input.scheduleVersion) fail('Расписания изменились. Проверьте выбор заново');
    for (const kind of ['daily', 'weekly'] as const) {
      const sourceId = kind === 'daily' ? input.dailySourceId : input.weeklySourceId;
      const source = schedules.find(schedule => schedule.board_id === sourceId && schedule.kind === kind);
      if (!source) fail('Выберите существующее расписание этого чата', 400);
      await client.query(`UPDATE publication_schedules SET enabled = $3, weekdays = $4, local_time = $5, timezone = $6,
        included_statuses = $7, included_board_ids = $8, updated_at = now() WHERE board_id = $1 AND kind = $2`,
        [root.id, kind, source.enabled, source.weekdays, source.local_time, source.timezone, source.included_statuses, source.included_board_ids ?? [sourceId]]);
      // A legacy delivery for this date must not be followed by another consolidated report.
      await client.query(`INSERT INTO publication_runs (id, board_id, kind, local_date, status, last_error)
        SELECT gen_random_uuid(), $1::uuid, kind, local_date, 'cancelled', 'legacy_schedule_consolidated' FROM (
          SELECT DISTINCT kind, local_date FROM publication_runs WHERE board_id IN (SELECT id FROM boards WHERE chat_root_id = $1)
          AND kind = $2 AND (attempts > 0 OR status IN ('sent', 'sending', 'uncertain'))) delivered
        ON CONFLICT (board_id, kind, local_date) DO UPDATE SET status = 'cancelled', last_error = 'legacy_schedule_consolidated'
          WHERE publication_runs.status = 'pending'`, [root.id, kind]);
    }
    await client.query("UPDATE publication_runs SET status = CASE WHEN status = 'sending' THEN 'uncertain' ELSE 'cancelled' END, last_error = 'legacy_schedule_consolidated' WHERE board_id IN (SELECT id FROM boards WHERE chat_root_id = $1 AND id <> $1) AND status IN ('pending', 'sending')", [root.id]);
    await client.query('DELETE FROM publication_schedules WHERE board_id IN (SELECT id FROM boards WHERE chat_root_id = $1 AND id <> $1)', [root.id]);
    return { resolved: true };
  });
}
