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
  const result = await db.query(`INSERT INTO tasks (id, board_id, project_id, creator_user_id, assignee_user_id,
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
  return result.rows[0] ?? null;
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
      wait_check_at = $11, updated_at = now() WHERE id = $1 AND board_id = $2 RETURNING *`,
      [taskId, boardId, projectId, assigneeId, input.title ?? task.title, input.description === undefined ? task.description : input.description,
        status, input.priority ?? task.priority, input.deadline === undefined ? task.deadline : input.deadline,
        waiting ? (input.waitReason === undefined ? task.wait_reason : input.waitReason) : null,
        waiting ? (input.waitCheckAt === undefined ? task.wait_check_at : input.waitCheckAt) : null]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function setTaskArchived(db: Database, userId: string, boardId: string, taskId: string, archived: boolean) {
  const result = await db.query(`UPDATE tasks t SET archived_at = CASE WHEN $4 THEN now() ELSE NULL END, updated_at = now() FROM boards b
    WHERE t.id = $1 AND t.board_id = $2 AND b.id = t.board_id AND b.status = 'active'
      AND (t.creator_user_id = $3 OR t.assignee_user_id = $3)
      AND (($4 AND t.archived_at IS NULL) OR (NOT $4 AND t.archived_at IS NOT NULL)) RETURNING t.id`,
    [taskId, boardId, userId, archived]);
  return result.rowCount === 1;
}
