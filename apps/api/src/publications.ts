import { randomUUID } from 'node:crypto';
import type { Database, TaskStatus } from './db.js';
import { checkSettingsExpected, withBoardLock } from './db.js';
import { escapeHtml, telegramCall, TelegramRejectedError } from './telegram.js';
import { BoardAccessError } from './pair-boards.js';
import { chatAccess } from './chat-boards.js';

export type PublicationKind = 'daily' | 'weekly';
export type PublicationSchedule = {
  kind: PublicationKind;
  enabled: boolean;
  weekdays: number[];
  local_time: string;
  timezone: string;
  included_statuses: string[];
  included_board_ids?: string[];
};
type ReportTask = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: string;
  deadline: string | null;
  deadline_date: string | null;
  deadline_timezone: string | null;
  overdue: boolean;
  wait_check_at: string | null;
  project_name: string | null;
  assignee_name: string | null;
};

export const publicationStatusDisplayName: Record<TaskStatus, string> = { todo: 'Новая', in_progress: 'В работе', waiting: 'Блокер', done: 'Готово' };

const localParts = (date: Date, timezone: string) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
}).formatToParts(date).map((part) => [part.type, part.value]));
const weekday = (name: string) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(name) + 1;
export const validTimezone = (value: string) => { try { new Intl.DateTimeFormat('ru', { timeZone: value }); return true; } catch { return false; } };
const sameBoardSelection = (left: string[], right: string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

export async function schedulesForBoard(db: Database, userId: string, boardId: string) {
  const result = await db.query<PublicationSchedule>(`SELECT s.kind, s.enabled, s.weekdays,
      to_char(s.local_time, 'HH24:MI') AS local_time, s.timezone, s.included_statuses,
      COALESCE(s.included_board_ids, ARRAY[s.board_id]) AS included_board_ids
    FROM boards b JOIN boards root ON root.id = b.chat_root_id
    JOIN publication_schedules s ON s.board_id = CASE WHEN root.chat_multi_enabled THEN root.id ELSE b.id END
    JOIN memberships m ON m.board_id = b.id
    WHERE b.id = $1 AND m.user_id = $2 ORDER BY s.kind`, [boardId, userId]);
  return result.rows;
}

export async function updateSchedule(db: Database, boardId: string, kind: PublicationKind, input: Partial<Omit<PublicationSchedule, 'kind'>>, expected?: Record<string, unknown>, userId?: string, botToken?: string) {
  return withBoardLock(db, boardId, async (client) => {
    if (userId && botToken) await chatAccess(client, userId, boardId, botToken);
    const target = (await client.query(`SELECT CASE WHEN r.chat_multi_enabled THEN r.id ELSE b.id END AS id FROM boards b
      JOIN boards r ON r.id = b.chat_root_id WHERE b.id = $1 AND b.status = 'active'`, [boardId])).rows[0];
    if (!target) return null;
    boardId = target.id;
    const current = await client.query<PublicationSchedule>(`SELECT s.kind, s.enabled, s.weekdays,
        to_char(s.local_time, 'HH24:MI') AS local_time, s.timezone, s.included_statuses,
        COALESCE(s.included_board_ids, ARRAY[s.board_id]) AS included_board_ids
      FROM publication_schedules s JOIN boards b ON b.id = s.board_id
      WHERE s.board_id = $1 AND s.kind = $2 AND b.status = 'active'
        AND ($3::bigint IS NULL OR EXISTS (SELECT 1 FROM memberships WHERE board_id = b.id AND user_id = $3))
      FOR UPDATE OF s, b`, [boardId, kind, userId ?? null]);
    if (!current.rows[0]) return null;
    checkSettingsExpected(current.rows[0], expected);
    const next = { ...current.rows[0], ...input };
    await publicationBoards(client, boardId, next.included_board_ids);
    if (input.included_board_ids && !sameBoardSelection(input.included_board_ids, current.rows[0].included_board_ids!)) {
      await client.query("UPDATE publication_runs SET status = 'cancelled', last_error = 'selection_changed' WHERE board_id = $1 AND kind = $2 AND status = 'pending' AND messages IS NOT NULL", [boardId, kind]);
    }
    const result = await client.query<PublicationSchedule>(`UPDATE publication_schedules SET enabled = $3, weekdays = $4,
        local_time = $5, timezone = $6, included_statuses = $7, included_board_ids = $8, updated_at = now()
      WHERE board_id = $1 AND kind = $2 AND EXISTS (SELECT 1 FROM boards WHERE id = $1 AND status = 'active')
      RETURNING kind, enabled, weekdays,
        to_char(local_time, 'HH24:MI') AS local_time, timezone, included_statuses, included_board_ids`,
      [boardId, kind, next.enabled, next.weekdays, next.local_time, next.timezone, next.included_statuses, next.included_board_ids]);
    return result.rows[0] ?? null;
  });
}

async function reportTasks(db: Pick<Database, 'query'>, boardId: string, kind: PublicationKind, statuses: string[], timezone: string, now: Date) {
  const params: unknown[] = kind === 'weekly' ? [boardId, statuses, now.toISOString(), timezone] : [boardId, statuses, now.toISOString()];
  const filter = kind === 'weekly' ? `((t.archived_at IS NULL AND t.status <> 'done' AND t.status = ANY($2::text[]))
      OR (t.status = 'done' AND t.completed_at >= (date_trunc('week', $3::timestamptz AT TIME ZONE $4) - interval '1 week') AT TIME ZONE $4
      AND t.completed_at < date_trunc('week', $3::timestamptz AT TIME ZONE $4) AT TIME ZONE $4))`
    : `t.archived_at IS NULL AND t.status = ANY($2::text[])`;
  const result = await db.query<ReportTask>(`SELECT t.id, t.title, t.status, t.priority, t.deadline, t.wait_check_at,
      to_char(t.deadline_date, 'YYYY-MM-DD') AS deadline_date, t.deadline_timezone,
      task_deadline_overdue(t.status, t.deadline, t.deadline_date, t.deadline_timezone, $3::timestamptz) AS overdue,
      p.name AS project_name, u.first_name AS assignee_name FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.assignee_user_id
    WHERE t.board_id = $1 AND (${filter})
    ORDER BY u.first_name NULLS LAST, p.name NULLS LAST, t.status, t.priority = 'urgent' DESC, t.deadline NULLS LAST, t.created_at`, params);
  return result.rows;
}

function taskLink(task: Pick<ReportTask, 'id' | 'title'>, botUsername: string, boardId: string) {
  return `<a href="https://t.me/${botUsername}?startapp=task_${boardId}_${task.id}">${escapeHtml(task.title)}</a>`;
}

function taskLine(task: ReportTask, now: Date, botUsername: string, boardId: string) {
  const labels = [publicationStatusDisplayName[task.status], task.priority === 'urgent' ? '🔥' : '', task.overdue ? '🔴' : '', task.deadline_date ? `${task.deadline_date} · весь день (${task.deadline_timezone})` : '', task.wait_check_at && new Date(task.wait_check_at) <= now && task.status === 'waiting' ? 'ПРОВЕРИТЬ' : ''].filter(Boolean).join(' · ');
  return `${taskLink(task, botUsername, boardId)}${labels ? ` — <b>${labels}</b>` : ''}`;
}

const ul = (lines: string[]) => `<ul>${lines.map((line) => `<li>${line}</li>`).join('')}</ul>`;

function ruPlural(n: number, one: string, few: string, many: string) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
}

function listWithTail(lines: string[], keep: number) {
  if (lines.length <= keep + 2) return ul(lines);
  const rest = lines.length - keep;
  return `${ul(lines.slice(0, keep))}<details><summary>Ещё ${rest} ${ruPlural(rest, 'задача', 'задачи', 'задач')}</summary>${ul(lines.slice(keep))}</details>`;
}

async function renderBoardPublication(db: Pick<Database, 'query'>, boardId: string, kind: PublicationKind, statuses: string[], botUsername: string, timezone: string, now: Date) {
  const board = await db.query<{name: string}>("SELECT name FROM boards WHERE id = $1 AND type = 'chat'", [boardId]);
  if (!board.rows[0]) return [];
  const tasks = await reportTasks(db, boardId, kind, statuses, timezone, now);
  const title = `${kind === 'daily' ? 'ПЛАН ДНЯ' : 'НЕДЕЛЯ'} · ${escapeHtml(board.rows[0].name)}`;
  const dateLine = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: timezone }).format(now);
  const parts = [`<h1>${title}</h1>`];
  if (!tasks.length) return [`${parts.join('\n')}\n<p>Активных задач нет.</p>\n<footer>Таска · ${dateLine}</footer>`];
  const count = (predicate: (task: ReportTask) => boolean) => tasks.filter(predicate).length;
  parts.push(kind === 'daily'
    ? `<p>${dateLine} · Активно: <b>${count((task: ReportTask) => task.status !== 'done')}</b> · Блокеров: <b>${count((task: ReportTask) => task.status === 'waiting')}</b> · Просрочено: <b>${count((task: ReportTask) => task.overdue)}</b></p>`
    : `<p>Выполнено: <b>${count((task: ReportTask) => task.status === 'done')}</b> · Просрочено: <b>${count((task: ReportTask) => task.overdue)}</b> · ${publicationStatusDisplayName.waiting}: <b>${count((task: ReportTask) => task.status === 'waiting')}</b> · Активно: <b>${count((task: ReportTask) => task.status !== 'done')}</b></p>`);
  const attention = tasks.filter((task: ReportTask) => task.overdue || task.status === 'waiting');
  if (attention.length) {
    const overdue = attention.filter((task: ReportTask) => task.overdue);
    const blockers = attention.filter((task: ReportTask) => !task.overdue);
    const attentionHtml = [overdue.length ? `<h3>🔴 Просрочено · ${overdue.length}</h3>` + listWithTail(overdue.map((task: ReportTask) => taskLine(task, now, botUsername, boardId)), 6) : '', blockers.length ? `<h3>🟡 Блокеры · ${blockers.length}</h3>` + listWithTail(blockers.map((task: ReportTask) => taskLine(task, now, botUsername, boardId)), 6) : ''].filter(Boolean).join('\n');
    parts.push(`<blockquote><h2>Требует внимания · ${attention.length}</h2>\n${attentionHtml}\n</blockquote>`);
  }
  const people = new Map<string, Map<string, string[]>>();
  for (const task of tasks) {
    if (task.status === 'todo' && !task.assignee_name) continue;
    const person = task.assignee_name ?? 'Без ответственного';
    const project = task.project_name ?? 'Без проекта';
    const projects = people.get(person) ?? new Map(); people.set(person, projects);
    const lines = projects.get(project) ?? []; projects.set(project, lines); lines.push(taskLine(task, now, botUsername, boardId));
  }
  for (const [person, projects] of people) {
    const personHtml = [];
    for (const [project, lines] of projects) personHtml.push(`<h3>${escapeHtml(project)}</h3>`, listWithTail(lines, 6));
    parts.push(`<h2>${escapeHtml(person)}</h2>`, `<blockquote>\n${personHtml.join('\n')}\n</blockquote>`);
  }
  const backlog = tasks.filter(task => task.status === 'todo' && !task.assignee_name);
  if (backlog.length) {
    const lines = backlog.map(task => taskLink(task, botUsername, boardId));
    parts.push(`<h2>Бэклог · ${backlog.length}</h2>`, '<p>Любую можно взять себе.</p>', listWithTail(lines, 3));
  }
  const html = `${parts.join('\n')}\n<footer>Таска · ${dateLine}</footer>`;
  if (Buffer.byteLength(html, 'utf8') > 30_000) {
    // Split at task boundaries, never inside an HTML entity, link, or Unicode character.
    const header = `<h1>${title}</h1>`;
    const pages: string[] = [];
    let page = header;
    for (const task of tasks) {
      const line = `<p>${escapeHtml(task.assignee_name ?? 'Без ответственного')} · ${escapeHtml(task.project_name ?? 'Без проекта')}<br>${taskLine(task, now, botUsername, boardId)}</p>`;
      if (Buffer.byteLength(page + line, 'utf8') > 30_000) { pages.push(page); page = header; }
      page += line;
    }
    pages.push(page);
    return pages;
  }
  return [html];
}

export async function publicationBoards(db: Pick<Database, 'query'>, boardId: string, selection?: string[]) {
  const root = (await db.query('SELECT chat_root_id FROM boards WHERE id = $1 AND type = \'chat\'', [boardId])).rows[0];
  if (!root) return [];
  const ids = selection ?? [boardId];
  const boards = (await db.query<{id: string; status: string}>('SELECT id, status FROM boards WHERE chat_root_id = $1 AND id = ANY($2::uuid[]) ORDER BY name, id', [root.chat_root_id, ids])).rows;
  if (boards.length !== new Set(ids).size) throw new BoardAccessError('Сводка может включать только доски этого чата', 400);
  return boards;
}
export async function renderPublication(db: Pick<Database, 'query'>, boardId: string, kind: PublicationKind, statuses: string[], botUsername: string, timezone: string, now = new Date(), selection?: string[]) {
  const boards = await publicationBoards(db, boardId, selection);
  const pages: string[] = [];
  for (const board of boards.filter(board => board.status === 'active')) {
    for (const html of await renderBoardPublication(db, board.id, kind, statuses, botUsername, timezone, now)) {
      const last = pages.length - 1;
      if (last >= 0 && Buffer.byteLength(pages[last] + html, 'utf8') < 30_000) pages[last] += `\n${html}`;
      else pages.push(html);
    }
  }
  return pages.length > 1 ? pages.map((page, index) => `<p>Часть ${index + 1} из ${pages.length}</p>\n${page}`) : pages;
}

export async function queueDuePublications(db: Database, now = new Date()) {
  const schedules = await db.query<PublicationSchedule & {board_id: string}>(`SELECT board_id, kind, enabled, weekdays,
    to_char(local_time, 'HH24:MI') AS local_time, timezone, included_statuses FROM publication_schedules s
    JOIN boards b ON b.id = s.board_id JOIN boards root ON root.id = b.chat_root_id
    WHERE s.enabled AND b.status = 'active' AND b.telegram_chat_id IS NOT NULL
      AND (NOT root.chat_multi_enabled OR b.id = root.id) AND cardinality(COALESCE(s.included_board_ids, ARRAY[s.board_id])) > 0`);
  for (const schedule of schedules.rows) {
    const local = localParts(now, schedule.timezone);
    if (!schedule.weekdays.includes(weekday(local.weekday)) || `${local.hour}:${local.minute}` < schedule.local_time) continue;
    await db.query(`INSERT INTO publication_runs (id, board_id, kind, local_date, report_at) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (board_id, kind, local_date) DO NOTHING`, [randomUUID(), schedule.board_id, schedule.kind, `${local.year}-${local.month}-${local.day}`, now.toISOString()]);
  }
}

export async function deliverPendingPublications(db: Database, botToken: string, botUsername: string, now = new Date()) {
  const candidate = (await db.query(`SELECT r.id, b.chat_root_id FROM publication_runs r JOIN boards b ON b.id = r.board_id
    WHERE r.status IN ('pending', 'sending') AND r.next_attempt_at <= $1 AND b.status = 'active' ORDER BY r.next_attempt_at, r.id LIMIT 1`, [now.toISOString()])).rows[0];
  if (!candidate) return false;
  const client = await db.connect();
  let locked = false;
  try {
    // Session lock permits durable per-part receipts without holding a transaction over HTTP.
    locked = (await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [candidate.chat_root_id])).rows[0].locked;
    if (!locked) return false;
    const run = (await client.query(`SELECT r.*, b.telegram_chat_id, root.chat_multi_enabled, root.id AS root_id,
      s.enabled, s.included_statuses, s.timezone, COALESCE(s.included_board_ids, ARRAY[s.board_id]) AS included_board_ids
      FROM publication_runs r JOIN boards b ON b.id = r.board_id JOIN boards root ON root.id = b.chat_root_id
      JOIN publication_schedules s ON s.board_id = r.board_id AND s.kind = r.kind
      WHERE r.id = $1 AND r.status IN ('pending', 'sending') AND r.next_attempt_at <= $2 AND b.status = 'active'`, [candidate.id, now.toISOString()])).rows[0];
    if (!run) {
      await client.query(`UPDATE publication_runs r SET status = CASE WHEN status = 'sending' THEN 'uncertain' ELSE 'cancelled' END,
        last_error = 'schedule_removed' WHERE id = $1 AND status IN ('pending', 'sending')
        AND NOT EXISTS (SELECT 1 FROM publication_schedules s WHERE s.board_id = r.board_id AND s.kind = r.kind)`, [candidate.id]);
      return true;
    }
    if (run.status === 'sending') {
      await client.query("UPDATE publication_runs SET status = 'uncertain', last_error = 'interrupted_delivery' WHERE id = $1", [run.id]);
      return true;
    }
    const activeBoards = (await publicationBoards(client, run.board_id, run.included_board_ids)).filter(board => board.status === 'active').map(board => board.id);
    if (!run.enabled || !activeBoards.length || (run.chat_multi_enabled && run.board_id !== run.root_id)
      || (run.messages && (!run.board_ids || !sameBoardSelection(run.board_ids, activeBoards)))) {
      await client.query("UPDATE publication_runs SET status = 'cancelled', last_error = 'selection_empty_or_replaced' WHERE id = $1", [run.id]);
      return true;
    }
    const messages: string[] = run.messages ?? await renderPublication(client, run.board_id, run.kind, run.included_statuses, botUsername, run.timezone, run.report_at ?? now, run.included_board_ids);
    await client.query(`UPDATE publication_runs SET status = 'sending', attempts = attempts + 1, messages = $2::jsonb, board_ids = $4,
      next_attempt_at = $3::timestamptz + interval '5 minutes' WHERE id = $1`, [run.id, JSON.stringify(messages), now.toISOString(), activeBoards]);
    let attempted = false;
    try {
      for (let part = run.sent_parts; part < messages.length; part++) {
        attempted = true;
        const receipt = await telegramCall<{message_id: number}>(botToken, 'sendRichMessage', { chat_id: run.telegram_chat_id, rich_message: { html: messages[part] }, disable_web_page_preview: true });
        if (!Number.isSafeInteger(receipt.message_id)) throw new Error('Message receipt missing');
        await client.query('UPDATE publication_runs SET sent_parts = $2, message_ids = array_append(message_ids, $3) WHERE id = $1', [run.id, part + 1, receipt.message_id]);
        attempted = false;
      }
      await client.query("UPDATE publication_runs SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1", [run.id]);
    } catch (error) {
      const retry = !attempted || error instanceof TelegramRejectedError;
      await client.query(`UPDATE publication_runs SET status = $2, next_attempt_at = $3::timestamptz + interval '1 minute', last_error = $4 WHERE id = $1`,
        [run.id, retry ? 'pending' : 'uncertain', now.toISOString(), error instanceof TelegramRejectedError ? `telegram_${error.code}` : 'delivery_result_unknown']);
    }
  } finally {
    try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [candidate.chat_root_id]); }
    finally { client.release(); }
  }
  return true;
}

export function startPublicationScheduler(db: Database, botToken: string, botUsername: string, onError: (error: unknown) => void) {
  const tick = async () => { await queueDuePublications(db); while (await deliverPendingPublications(db, botToken, botUsername)) {} };
  const run = () => void tick().catch(onError);
  const timer = setInterval(run, 30_000); timer.unref(); run();
  return () => clearInterval(timer);
}
