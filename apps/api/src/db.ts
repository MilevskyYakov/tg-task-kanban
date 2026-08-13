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

export async function boardMembers(db: Database, userId: string, boardId: string) {
  const result = await db.query(`SELECT u.id, u.first_name, u.username FROM memberships viewer
    JOIN memberships member ON member.board_id = viewer.board_id JOIN users u ON u.id = member.user_id
    WHERE viewer.board_id = $1 AND viewer.user_id = $2 ORDER BY u.first_name`, [boardId, userId]);
  return result.rows;
}

export async function taskFilterState(db: Database, userId: string, boardId: string) {
  const result = await db.query<{filters: unknown}>(`SELECT s.filters FROM task_filter_states s
    JOIN memberships m ON m.board_id = s.board_id AND m.user_id = s.user_id
    WHERE s.user_id = $1 AND s.board_id = $2`, [userId, boardId]);
  return result.rows[0]?.filters ?? {};
}

export async function saveTaskFilterState(db: Database, userId: string, boardId: string, filters: unknown) {
  const result = await db.query(`INSERT INTO task_filter_states (user_id, board_id, filters)
    SELECT $1, $2, $3::jsonb FROM memberships WHERE user_id = $1 AND board_id = $2
    ON CONFLICT (user_id, board_id) DO UPDATE SET filters = EXCLUDED.filters, updated_at = now()
    RETURNING filters`, [userId, boardId, JSON.stringify(filters)]);
  return result.rows[0]?.filters ?? null;
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
    await client.query(`INSERT INTO publication_schedules (board_id, kind, weekdays, local_time) VALUES
      ($1, 'daily', ARRAY[1,2,3,4,5]::smallint[], '11:00'), ($1, 'weekly', ARRAY[1]::smallint[], '10:30')
      ON CONFLICT DO NOTHING`, [boardId]);
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
  const linkToken = token.startsWith('pub_') ? token.split('_').slice(0, 2).join('_') : token;
  const result = await db.query<{id: string}>(`SELECT b.id FROM board_links l JOIN boards b ON b.id = l.board_id
    WHERE l.token_hash = $1 AND l.revoked_at IS NULL AND b.type = 'chat' AND b.status <> 'frozen'`, [linkHash(linkToken)]);
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

export type TaskStatus = 'todo' | 'in_progress' | 'waiting' | 'done';
export type TaskPriority = 'normal' | 'urgent';
export type TaskInput = {
  title?: string;
  description?: string | null;
  projectId?: string | null;
  assigneeUserId?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  deadline?: string | null;
  waitReason?: string | null;
  waitCheckAt?: string | null;
  notifyAssignee?: boolean;
};

export async function projectsForBoard(db: Database, userId: string, boardId: string, archived = false) {
  const result = await db.query(`SELECT p.id, p.name, p.archived_at FROM projects p
    JOIN memberships m ON m.board_id = p.board_id
    WHERE p.board_id = $1 AND m.user_id = $2 AND ($3 OR p.archived_at IS NULL)
    ORDER BY p.name`, [boardId, userId, archived]);
  return result.rows;
}

export async function createProject(db: Database, userId: string, boardId: string, name: string) {
  const result = await db.query(`INSERT INTO projects (id, board_id, name, created_by)
    SELECT $3, b.id, $4, $2 FROM boards b JOIN memberships m ON m.board_id = b.id
    WHERE b.id = $1 AND b.status = 'active' AND m.user_id = $2
    RETURNING id, name, archived_at`, [boardId, userId, randomUUID(), name]);
  return result.rows[0] ?? null;
}

export async function updateProject(db: Database, userId: string, boardId: string, projectId: string, input: {name?: string; archived?: boolean}) {
  const result = await db.query(`UPDATE projects p SET name = COALESCE($4, p.name),
      archived_at = CASE WHEN $5::boolean IS NULL THEN p.archived_at WHEN $5 THEN now() ELSE NULL END
    FROM boards b, memberships m WHERE p.id = $1 AND p.board_id = $2 AND b.id = p.board_id
      AND b.status = 'active' AND m.board_id = b.id AND m.user_id = $3
    RETURNING p.id, p.name, p.archived_at`, [projectId, boardId, userId, input.name ?? null, input.archived ?? null]);
  return result.rows[0] ?? null;
}

const taskColumns = `t.id, t.board_id, t.project_id, p.name AS project_name, t.creator_user_id, t.assignee_user_id,
  assignee.first_name AS assignee_name,
  t.title, t.description, t.status, t.priority, t.deadline, t.wait_reason, t.wait_check_at,
  t.archived_at, t.created_at, t.updated_at,
  (t.status <> 'done' AND t.deadline < now()) AS overdue,
  (t.status = 'waiting' AND t.wait_check_at <= now()) AS wait_check_due`;

export async function tasksForBoard(db: Database, userId: string, boardId: string, archived = false) {
  const result = await db.query(`SELECT ${taskColumns} FROM tasks t
    JOIN memberships m ON m.board_id = t.board_id
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN users assignee ON assignee.id = t.assignee_user_id
    WHERE t.board_id = $1 AND m.user_id = $2 AND ($3 OR t.archived_at IS NULL)
    ORDER BY t.priority = 'urgent' DESC, t.created_at DESC`, [boardId, userId, archived]);
  return result.rows;
}

export async function tasksForAssignee(db: Database, userId: string) {
  const result = await db.query(`SELECT ${taskColumns}, b.name AS board_name FROM tasks t
    JOIN boards b ON b.id = t.board_id JOIN memberships m ON m.board_id = b.id AND m.user_id = $1
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN users assignee ON assignee.id = t.assignee_user_id
    WHERE t.assignee_user_id = $1 AND t.archived_at IS NULL AND b.status = 'active'
    ORDER BY t.priority = 'urgent' DESC, t.deadline NULLS LAST, t.created_at DESC`, [userId]);
  return result.rows;
}

export async function createTask(db: Database, userId: string, boardId: string, input: TaskInput) {
  if (input.status && input.status !== 'todo') return null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`INSERT INTO tasks (id, board_id, project_id, creator_user_id, assignee_user_id,
      title, description, status, priority, deadline, wait_reason, wait_check_at)
    SELECT $3, b.id, $4, $2, $5, $6, $7, $8, $9, $10, $11, $12
    FROM boards b JOIN memberships creator ON creator.board_id = b.id
    LEFT JOIN projects p ON p.id = $4 AND p.board_id = b.id AND p.archived_at IS NULL
    LEFT JOIN memberships assignee ON assignee.board_id = b.id AND assignee.user_id = $5
    WHERE b.id = $1 AND b.status = 'active' AND creator.user_id = $2
      AND ($4::uuid IS NULL OR p.id IS NOT NULL) AND ($5::bigint IS NULL OR assignee.user_id IS NOT NULL)
    RETURNING *`, [boardId, userId, randomUUID(), input.projectId ?? null, input.assigneeUserId ?? null,
      input.title!, input.description ?? null, input.status ?? 'todo', input.priority ?? 'normal',
      input.deadline ?? null, input.waitReason ?? null, input.waitCheckAt ?? null]);
    const task = result.rows[0];
    if (!task) { await client.query('ROLLBACK'); return null; }
    await client.query(`INSERT INTO task_audit_events (id, board_id, task_id, actor_user_id, action, after_data)
      VALUES ($1, $2, $3, $4, 'created', $5)`, [randomUUID(), boardId, task.id, userId, task]);
    if (input.notifyAssignee && task.assignee_user_id) await client.query(`INSERT INTO task_assignment_notifications
      (id, task_id, assignee_user_id) VALUES ($1, $2, $3)`, [randomUUID(), task.id, task.assignee_user_id]);
    await client.query('COMMIT');
    return task;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function updateTask(db: Database, userId: string, boardId: string, taskId: string, input: TaskInput) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<any>(`SELECT t.* FROM tasks t JOIN boards b ON b.id = t.board_id
      WHERE t.id = $1 AND t.board_id = $2 AND t.archived_at IS NULL AND b.status = 'active' FOR UPDATE`, [taskId, boardId]);
    const task = current.rows[0];
    if (!task || (task.creator_user_id !== userId && task.assignee_user_id !== userId)) { await client.query('ROLLBACK'); return null; }
    const status = input.status ?? task.status;
    if (status === 'done' && task.status !== 'done' && task.assignee_user_id !== userId) { await client.query('ROLLBACK'); return null; }
    if (task.status === 'done' && status !== 'done' && task.creator_user_id !== userId) { await client.query('ROLLBACK'); return null; }
    if (status === 'waiting' && !(input.waitReason === undefined ? task.wait_reason : input.waitReason)?.trim()) { await client.query('ROLLBACK'); return null; }
    const projectId = input.projectId === undefined ? task.project_id : input.projectId;
    const assigneeId = input.assigneeUserId === undefined ? task.assignee_user_id : input.assigneeUserId;
    if (projectId && !(await client.query('SELECT 1 FROM projects WHERE id = $1 AND board_id = $2 AND archived_at IS NULL', [projectId, boardId])).rowCount) { await client.query('ROLLBACK'); return null; }
    if (assigneeId && !(await client.query('SELECT 1 FROM memberships WHERE board_id = $1 AND user_id = $2', [boardId, assigneeId])).rowCount) { await client.query('ROLLBACK'); return null; }
    const waiting = status === 'waiting';
    const result = await client.query(`UPDATE tasks SET project_id = $3, assignee_user_id = $4, title = $5,
      description = $6, status = $7, priority = $8, deadline = $9, wait_reason = $10,
      wait_check_at = $11, completed_at = CASE WHEN $7 = 'done' AND status <> 'done' THEN now() WHEN $7 <> 'done' THEN NULL ELSE completed_at END,
      updated_at = now() WHERE id = $1 AND board_id = $2 RETURNING *`,
      [taskId, boardId, projectId, assigneeId, input.title ?? task.title, input.description === undefined ? task.description : input.description,
        status, input.priority ?? task.priority, input.deadline === undefined ? task.deadline : input.deadline,
        waiting ? (input.waitReason === undefined ? task.wait_reason : input.waitReason) : null,
        waiting ? (input.waitCheckAt === undefined ? task.wait_check_at : input.waitCheckAt) : null]);
    await client.query(`INSERT INTO task_audit_events (id, board_id, task_id, actor_user_id, action, before_data, after_data)
      VALUES ($1, $2, $3, $4, 'updated', $5, $6)`, [randomUUID(), boardId, taskId, userId, task, result.rows[0]]);
    if (input.notifyAssignee && input.assigneeUserId && input.assigneeUserId !== task.assignee_user_id) {
      await client.query(`INSERT INTO task_assignment_notifications (id, task_id, assignee_user_id)
        VALUES ($1, $2, $3)`, [randomUUID(), taskId, input.assigneeUserId]);
    }
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function setTaskArchived(db: Database, userId: string, boardId: string, taskId: string, archived: boolean) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM tasks WHERE id = $1 AND board_id = $2 FOR UPDATE', [taskId, boardId]);
    const result = await client.query(`UPDATE tasks t SET archived_at = CASE WHEN $4 THEN now() ELSE NULL END, updated_at = now() FROM boards b
    WHERE t.id = $1 AND t.board_id = $2 AND b.id = t.board_id AND b.status = 'active'
      AND (t.creator_user_id = $3 OR t.assignee_user_id = $3)
      AND (($4 AND t.archived_at IS NULL) OR (NOT $4 AND t.archived_at IS NOT NULL)) RETURNING t.id`,
    [taskId, boardId, userId, archived]);
    if (result.rowCount) await client.query(`INSERT INTO task_audit_events (id, board_id, task_id, actor_user_id, action, before_data)
      VALUES ($1, $2, $3, $4, $5, $6)`, [randomUUID(), boardId, taskId, userId, archived ? 'archived' : 'reopened', current.rows[0]]);
    await client.query('COMMIT');
    return result.rowCount === 1;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function canReadTask(db: Database, userId: string, boardId: string, taskId: string, activeOnly = false) {
  const result = await db.query(`SELECT t.creator_user_id, t.assignee_user_id FROM tasks t
    JOIN boards b ON b.id = t.board_id JOIN memberships m ON m.board_id = t.board_id
    WHERE t.id = $1 AND t.board_id = $2 AND m.user_id = $3 AND ($4::boolean = false OR (t.archived_at IS NULL AND b.status = 'active'))`,
    [taskId, boardId, userId, activeOnly]);
  return result.rows[0] ?? null;
}

export async function taskCollaboration(db: Database, userId: string, boardId: string, taskId: string) {
  if (!await canReadTask(db, userId, boardId, taskId)) return null;
  const [comments, checklist, attachments, timeline] = await Promise.all([
    db.query(`SELECT c.id, c.body, c.created_at, u.id AS author_user_id, u.first_name AS author_name
      FROM task_comments c JOIN users u ON u.id = c.author_user_id WHERE c.task_id = $1 AND c.board_id = $2 ORDER BY c.created_at, c.id`, [taskId, boardId]),
    db.query(`SELECT id, text, position, completed_at, completed_by FROM task_checklist_items
      WHERE task_id = $1 AND board_id = $2 ORDER BY position`, [taskId, boardId]),
    db.query(`SELECT id, kind, url, telegram_file_id, file_name, mime_type, file_size, created_at
      FROM task_attachments WHERE task_id = $1 AND board_id = $2 ORDER BY created_at, id`, [taskId, boardId]),
    db.query(`SELECT e.id, e.action, e.before_data, e.after_data, e.created_at, u.first_name AS actor_name
      FROM task_audit_events e JOIN users u ON u.id = e.actor_user_id WHERE e.task_id = $1 AND e.board_id = $2 ORDER BY e.created_at, e.id`, [taskId, boardId])
  ]);
  return { comments: comments.rows, checklist: checklist.rows, attachments: attachments.rows, timeline: timeline.rows };
}

export async function addTaskComment(db: Database, userId: string, boardId: string, taskId: string, body: string) {
  if (!await canReadTask(db, userId, boardId, taskId, true)) return null;
  const result = await db.query(`INSERT INTO task_comments (id, board_id, task_id, author_user_id, body)
    VALUES ($1, $2, $3, $4, $5) RETURNING id, body, created_at`, [randomUUID(), boardId, taskId, userId, body]);
  return result.rows[0];
}

export async function addChecklistItem(db: Database, userId: string, boardId: string, taskId: string, text: string) {
  const task = await canReadTask(db, userId, boardId, taskId, true);
  if (!task || (task.creator_user_id !== userId && task.assignee_user_id !== userId)) return null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const position = (await client.query<{position: number}>(`SELECT COALESCE(MAX(position), -1) + 1 AS position
      FROM task_checklist_items WHERE task_id = $1`, [taskId])).rows[0].position;
    const result = await client.query(`INSERT INTO task_checklist_items (id, board_id, task_id, created_by, text, position)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [randomUUID(), boardId, taskId, userId, text, position]);
    await client.query(`INSERT INTO task_audit_events (id, board_id, task_id, actor_user_id, action, after_data)
      VALUES ($1, $2, $3, $4, 'checklist_added', $5)`, [randomUUID(), boardId, taskId, userId, result.rows[0]]);
    await client.query('COMMIT'); return result.rows[0];
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function updateChecklistItem(db: Database, userId: string, boardId: string, taskId: string, itemId: string, input: {text?: string; completed?: boolean; position?: number}) {
  const task = await canReadTask(db, userId, boardId, taskId, true);
  if (!task || (task.creator_user_id !== userId && task.assignee_user_id !== userId)) return null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM task_checklist_items WHERE id = $1 AND task_id = $2 AND board_id = $3 FOR UPDATE', [itemId, taskId, boardId]);
    const item = current.rows[0];
    if (!item) { await client.query('ROLLBACK'); return null; }
    let position = item.position;
    if (input.position !== undefined && input.position !== position) {
      const count = Number((await client.query<{count: string}>('SELECT count(*) FROM task_checklist_items WHERE task_id = $1', [taskId])).rows[0].count);
      position = Math.min(input.position, count - 1);
      await client.query(`UPDATE task_checklist_items SET position = position + $4::integer WHERE task_id = $1 AND id <> $2
        AND position BETWEEN LEAST($3::integer, $5::integer) AND GREATEST($3::integer, $5::integer)`, [taskId, itemId, position, position < item.position ? 1 : -1, item.position]);
    }
    const result = await client.query(`UPDATE task_checklist_items SET text = COALESCE($5, text), position = $6,
        completed_at = CASE WHEN $7::boolean IS NULL THEN completed_at WHEN $7 THEN now() ELSE NULL END,
        completed_by = CASE WHEN $7::boolean IS NULL THEN completed_by WHEN $7 THEN $4 ELSE NULL END, updated_at = now()
      WHERE id = $1 AND task_id = $2 AND board_id = $3 RETURNING *`, [itemId, taskId, boardId, userId, input.text ?? null, position, input.completed ?? null]);
    await client.query(`INSERT INTO task_audit_events (id, board_id, task_id, actor_user_id, action, before_data, after_data)
      VALUES ($1, $2, $3, $4, 'checklist_updated', $5, $6)`, [randomUUID(), boardId, taskId, userId, item, result.rows[0]]);
    await client.query('COMMIT'); return result.rows[0];
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function deleteChecklistItem(db: Database, userId: string, boardId: string, taskId: string, itemId: string) {
  const task = await canReadTask(db, userId, boardId, taskId, true);
  if (!task || (task.creator_user_id !== userId && task.assignee_user_id !== userId)) return false;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('DELETE FROM task_checklist_items WHERE id = $1 AND task_id = $2 AND board_id = $3 RETURNING *', [itemId, taskId, boardId]);
    if (!result.rows[0]) { await client.query('ROLLBACK'); return false; }
    await client.query('UPDATE task_checklist_items SET position = position - 1 WHERE task_id = $1 AND position > $2', [taskId, result.rows[0].position]);
    await client.query(`INSERT INTO task_audit_events (id, board_id, task_id, actor_user_id, action, before_data)
      VALUES ($1, $2, $3, $4, 'checklist_deleted', $5)`, [randomUUID(), boardId, taskId, userId, result.rows[0]]);
    await client.query('COMMIT'); return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export type AttachmentInput = { kind: 'url' | 'telegram'; url?: string; telegramFileId?: string; telegramFileUniqueId?: string; fileName?: string; mimeType?: string; fileSize?: number };
export async function addTaskAttachment(db: Database, userId: string, boardId: string, taskId: string, input: AttachmentInput) {
  if (!await canReadTask(db, userId, boardId, taskId, true)) return null;
  const result = await db.query(`INSERT INTO task_attachments (id, board_id, task_id, added_by, kind, url,
      telegram_file_id, telegram_file_unique_id, file_name, mime_type, file_size)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, kind, url, telegram_file_id, file_name, mime_type, file_size, created_at`,
    [randomUUID(), boardId, taskId, userId, input.kind, input.url ?? null, input.telegramFileId ?? null,
      input.telegramFileUniqueId ?? null, input.fileName ?? null, input.mimeType ?? null, input.fileSize ?? null]);
  return result.rows[0];
}

export async function incompleteChecklistCount(db: Database, userId: string, boardId: string, taskId: string) {
  if (!await canReadTask(db, userId, boardId, taskId, true)) return null;
  const result = await db.query<{count: string}>('SELECT count(*) FROM task_checklist_items WHERE task_id = $1 AND board_id = $2 AND completed_at IS NULL', [taskId, boardId]);
  return Number(result.rows[0].count);
}

export async function claimAssignmentNotification(db: Database, notificationId: string) {
  const result = await db.query(`UPDATE task_assignment_notifications n SET status = 'sending' FROM tasks t, users u
    WHERE n.id = $1 AND n.status = 'pending' AND t.id = n.task_id AND u.id = n.assignee_user_id
    RETURNING n.id, t.title, u.telegram_id`, [notificationId]);
  return result.rows[0] ?? null;
}

export async function finishAssignmentNotification(db: Database, notificationId: string, error?: string) {
  await db.query(`UPDATE task_assignment_notifications SET status = $2, error = $3, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE NULL END
    WHERE id = $1 AND status = 'sending'`, [notificationId, error ? 'failed' : 'sent', error?.slice(0, 500) ?? null]);
}

export async function pendingNotificationForTask(db: Database, taskId: string) {
  const result = await db.query<{id: string}>('SELECT id FROM task_assignment_notifications WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1', [taskId]);
  return result.rows[0]?.id ?? null;
}
