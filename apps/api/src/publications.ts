import { randomUUID } from 'node:crypto';
import type { Database, TaskStatus } from './db.js';
import { escapeHtml, telegramCall } from './telegram.js';

export type PublicationKind = 'daily' | 'weekly';
export type PublicationSchedule = {
  kind: PublicationKind;
  enabled: boolean;
  weekdays: number[];
  local_time: string;
  timezone: string;
  included_statuses: string[];
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

export async function schedulesForBoard(db: Database, userId: string, boardId: string) {
  const result = await db.query<PublicationSchedule>(`SELECT s.kind, s.enabled, s.weekdays,
      to_char(s.local_time, 'HH24:MI') AS local_time, s.timezone, s.included_statuses
    FROM publication_schedules s JOIN memberships m ON m.board_id = s.board_id
    WHERE s.board_id = $1 AND m.user_id = $2 ORDER BY s.kind`, [boardId, userId]);
  return result.rows;
}

export async function updateSchedule(db: Database, boardId: string, kind: PublicationKind, input: Omit<PublicationSchedule, 'kind'>) {
  const result = await db.query<PublicationSchedule>(`UPDATE publication_schedules SET enabled = $3, weekdays = $4,
      local_time = $5, timezone = $6, included_statuses = $7, updated_at = now()
    WHERE board_id = $1 AND kind = $2 RETURNING kind, enabled, weekdays,
      to_char(local_time, 'HH24:MI') AS local_time, timezone, included_statuses`,
    [boardId, kind, input.enabled, input.weekdays, input.local_time, input.timezone, input.included_statuses]);
  return result.rows[0] ?? null;
}

async function reportTasks(db: Database, boardId: string, kind: PublicationKind, statuses: string[], timezone: string, now: Date) {
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

export async function renderPublication(db: Database, boardId: string, kind: PublicationKind, statuses: string[], botUsername: string, timezone: string, now = new Date()) {
  const board = await db.query<{name: string}>("SELECT name FROM boards WHERE id = $1 AND type = 'chat'", [boardId]);
  if (!board.rows[0]) return [];
  const tasks = await reportTasks(db, boardId, kind, statuses, timezone, now);
  const title = `${kind === 'daily' ? 'ПЛАН ДНЯ' : 'НЕДЕЛЯ'} · ${escapeHtml(board.rows[0].name)}`;
  const dateLine = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: timezone }).format(now);
  const parts = [`<h1>${title}</h1>`];
  if (!tasks.length) return [`${parts.join('\n')}\n<p>Активных задач нет.</p>\n<footer>Задачник · ${dateLine}</footer>`];
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
    parts.push(`<hr/>`, `<h2>${escapeHtml(person)}</h2>`);
    for (const [project, lines] of projects) parts.push(`<h3>${escapeHtml(project)}</h3>`, listWithTail(lines, 6));
  }
  const backlogRows = await db.query<{id: string; title: string; total: string}>(`SELECT t.id, t.title, count(*) OVER() AS total FROM tasks t
    WHERE t.board_id = $1 AND t.archived_at IS NULL AND t.status = 'todo' AND t.assignee_user_id IS NULL ORDER BY t.created_at LIMIT 50`, [boardId]);
  if (backlogRows.rows.length) {
    const lines = backlogRows.rows.map((task: {id: string; title: string; total: string}) => taskLink(task, botUsername, boardId));
    parts.push(`<h2>Бэклог · ${backlogRows.rows[0].total}</h2>`, '<p>Любую можно взять себе.</p>', listWithTail(lines, 3));
  }
  const html = `${parts.join('\n')}\n<footer>Задачник · ${dateLine}</footer>`;
  if (html.length > 32_768) throw new Error('publication exceeds Telegram rich message limit');
  return [html];
}

export async function queueDuePublications(db: Database, now = new Date()) {
  const schedules = await db.query<PublicationSchedule & {board_id: string}>(`SELECT board_id, kind, enabled, weekdays,
    to_char(local_time, 'HH24:MI') AS local_time, timezone, included_statuses FROM publication_schedules s
    JOIN boards b ON b.id = s.board_id WHERE s.enabled AND b.status = 'active' AND b.telegram_chat_id IS NOT NULL`);
  for (const schedule of schedules.rows) {
    const local = localParts(now, schedule.timezone);
    if (!schedule.weekdays.includes(weekday(local.weekday)) || `${local.hour}:${local.minute}` < schedule.local_time) continue;
    await db.query(`INSERT INTO publication_runs (id, board_id, kind, local_date) VALUES ($1, $2, $3, $4)
      ON CONFLICT (board_id, kind, local_date) DO NOTHING`, [randomUUID(), schedule.board_id, schedule.kind, `${local.year}-${local.month}-${local.day}`]);
  }
}

export async function deliverPendingPublications(db: Database, botToken: string, botUsername: string, now = new Date()) {
  await db.query("UPDATE publication_runs SET status = 'pending' WHERE status = 'sending' AND next_attempt_at <= $1", [now.toISOString()]);
  const run = await db.query<{id: string; board_id: string; kind: PublicationKind; included_statuses: string[]; timezone: string; telegram_chat_id: string; sent_parts: number}>(`UPDATE publication_runs r SET status = 'sending', attempts = attempts + 1, next_attempt_at = $1::timestamptz + interval '5 minutes'
    FROM publication_schedules s, boards b WHERE r.id = (SELECT pr.id FROM publication_runs pr JOIN boards eligible ON eligible.id = pr.board_id
      WHERE pr.status = 'pending' AND pr.next_attempt_at <= $1 AND eligible.status = 'active' AND eligible.telegram_chat_id IS NOT NULL
      ORDER BY pr.next_attempt_at FOR UPDATE OF pr SKIP LOCKED LIMIT 1)
      AND s.board_id = r.board_id AND s.kind = r.kind AND b.id = r.board_id AND b.status = 'active' AND b.telegram_chat_id IS NOT NULL
    RETURNING r.id, r.board_id, r.kind, s.included_statuses, s.timezone, b.telegram_chat_id, r.sent_parts`, [now.toISOString()]);
  if (!run.rows[0]) return false;
  try {
    const messages = await renderPublication(db, run.rows[0].board_id, run.rows[0].kind, run.rows[0].included_statuses, botUsername, run.rows[0].timezone, now);
    for (let part = run.rows[0].sent_parts; part < messages.length; part++) {
      const payload = part === 0
        ? { chat_id: run.rows[0].telegram_chat_id, rich_message: { html: messages[part] }, disable_web_page_preview: true }
        : { chat_id: run.rows[0].telegram_chat_id, text: messages[part], parse_mode: 'HTML', disable_web_page_preview: true };
      await telegramCall(botToken, part === 0 ? 'sendRichMessage' : 'sendMessage', payload);
      await db.query('UPDATE publication_runs SET sent_parts = $2 WHERE id = $1', [run.rows[0].id, part + 1]);
    }
    await db.query("UPDATE publication_runs SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1", [run.rows[0].id]);
  } catch (error) {
    await db.query(`UPDATE publication_runs SET status = 'pending', next_attempt_at = now() + (LEAST(attempts, 6) * interval '1 minute'), last_error = $2 WHERE id = $1`, [run.rows[0].id, error instanceof Error ? error.message.slice(0, 500) : 'unknown']);
  }
  return true;
}

export function startPublicationScheduler(db: Database, botToken: string, botUsername: string, onError: (error: unknown) => void) {
  const tick = async () => { await queueDuePublications(db); while (await deliverPendingPublications(db, botToken, botUsername)) {} };
  const run = () => void tick().catch(onError);
  const timer = setInterval(run, 30_000); timer.unref(); run();
  return () => clearInterval(timer);
}
