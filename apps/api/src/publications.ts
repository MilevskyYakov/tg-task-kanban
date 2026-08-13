import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from './db.js';
import { telegramCall } from './telegram.js';

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
  status: string;
  priority: string;
  deadline: string | null;
  wait_check_at: string | null;
  project_name: string | null;
  assignee_name: string | null;
};

const statusNames: Record<string, string> = { todo: 'К выполнению', in_progress: 'В работе', waiting: 'Жду', done: 'Готово' };
const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
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
  const params: unknown[] = kind === 'weekly' ? [boardId, statuses, now.toISOString(), timezone] : [boardId, statuses];
  const filter = kind === 'weekly' ? `((t.archived_at IS NULL AND t.status <> 'done' AND t.status = ANY($2::text[]))
      OR (t.status = 'done' AND t.completed_at >= (date_trunc('week', $3::timestamptz AT TIME ZONE $4) - interval '1 week') AT TIME ZONE $4
      AND t.completed_at < date_trunc('week', $3::timestamptz AT TIME ZONE $4) AT TIME ZONE $4))`
    : `t.archived_at IS NULL AND t.status = ANY($2::text[])`;
  const result = await db.query<ReportTask>(`SELECT t.id, t.title, t.status, t.priority, t.deadline, t.wait_check_at,
      p.name AS project_name, u.first_name AS assignee_name FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.assignee_user_id
    WHERE t.board_id = $1 AND (${filter})
    ORDER BY u.first_name NULLS LAST, p.name NULLS LAST, t.status, t.priority = 'urgent' DESC, t.deadline NULLS LAST, t.created_at`, params);
  return result.rows;
}

async function publicationToken(db: Database, boardId: string) {
  const token = `pub_${randomBytes(16).toString('hex')}`;
  const hash = createHash('sha256').update(token).digest('hex');
  await db.query("INSERT INTO board_links (token_hash, board_id, kind) VALUES ($1, $2, 'publication')", [hash, boardId]);
  return token;
}

function taskLine(task: ReportTask, now: Date, botUsername: string, token: string) {
  const labels = [task.priority === 'urgent' ? '🔥' : '', task.deadline && new Date(task.deadline) < now && task.status !== 'done' ? 'ПРОСРОЧЕНО' : '', task.wait_check_at && new Date(task.wait_check_at) <= now && task.status === 'waiting' ? 'ПРОВЕРИТЬ' : ''].filter(Boolean).join(' · ');
  const start = `${token}_${task.id}`;
  return `• <a href="https://t.me/${botUsername}?startapp=${start}">${escapeHtml(task.title)}</a>${labels ? ` — <b>${labels}</b>` : ''}`;
}

export async function renderPublication(db: Database, boardId: string, kind: PublicationKind, statuses: string[], botUsername: string, timezone: string, now = new Date()) {
  const board = await db.query<{name: string}>("SELECT name FROM boards WHERE id = $1 AND type = 'chat'", [boardId]);
  if (!board.rows[0]) return [];
  const tasks = await reportTasks(db, boardId, kind, statuses, timezone, now);
  const token = await publicationToken(db, boardId);
  const title = kind === 'daily' ? `План дня · ${escapeHtml(board.rows[0].name)}` : `Неделя · ${escapeHtml(board.rows[0].name)}`;
  if (!tasks.length) return [`<b>${title}</b>\n\nАктивных задач нет.`];
  const groups = new Map<string, Map<string, Map<string, ReportTask[]>>>();
  for (const task of tasks) {
    const person = task.assignee_name ?? 'Без ответственного';
    const project = task.project_name ?? 'Без проекта';
    const statusesMap = groups.get(person) ?? new Map(); groups.set(person, statusesMap);
    const taskMap = statusesMap.get(project) ?? new Map(); statusesMap.set(project, taskMap);
    const list = taskMap.get(task.status) ?? []; taskMap.set(task.status, list); list.push(task);
  }
  const sections = [`<b>${title}</b>`];
  if (kind === 'weekly') {
    const count = (predicate: (task: ReportTask) => boolean) => tasks.filter(predicate).length;
    sections.push(`Выполнено: <b>${count((task) => task.status === 'done')}</b> · Просрочено: <b>${count((task) => task.status !== 'done' && !!task.deadline && new Date(task.deadline) < now)}</b> · Жду: <b>${count((task) => task.status === 'waiting')}</b> · Активно: <b>${count((task) => task.status !== 'done')}</b>`);
  }
  for (const [person, projects] of groups) for (const [project, statusesMap] of projects) for (const [status, list] of statusesMap) {
    sections.push(`<b>${escapeHtml(person)}</b> · ${escapeHtml(project)} · ${statusNames[status] ?? status}\n${list.map((task) => taskLine(task, now, botUsername, token)).join('\n')}`);
  }
  return splitTelegram(sections);
}

export function splitTelegram(sections: string[], limit = 4096) {
  const chunks: string[] = [];
  let chunk = '';
  for (const [sectionIndex, section] of sections.entries()) {
    const lines = section.split('\n');
    for (const line of lines) {
      if (line.length > limit) throw new Error('publication line exceeds Telegram limit');
      const next = chunk ? `${chunk}\n${line}` : line;
      if (next.length > limit) { chunks.push(chunk); chunk = line; } else chunk = next;
    }
    if (chunk && sectionIndex < sections.length - 1 && chunk.length + 1 < limit) chunk += '\n';
  }
  if (chunk.trim()) chunks.push(chunk.trimEnd());
  return chunks;
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
  await db.query("UPDATE publication_runs SET status = 'pending', next_attempt_at = $1 WHERE status = 'sending' AND next_attempt_at < $1::timestamptz - interval '5 minutes'", [now.toISOString()]);
  const run = await db.query<{id: string; board_id: string; kind: PublicationKind; included_statuses: string[]; timezone: string; telegram_chat_id: string}>(`UPDATE publication_runs r SET status = 'sending', attempts = attempts + 1
    FROM publication_schedules s, boards b WHERE r.id = (SELECT pr.id FROM publication_runs pr JOIN boards eligible ON eligible.id = pr.board_id
      WHERE pr.status = 'pending' AND pr.next_attempt_at <= $1 AND eligible.status = 'active' AND eligible.telegram_chat_id IS NOT NULL
      ORDER BY pr.next_attempt_at FOR UPDATE OF pr SKIP LOCKED LIMIT 1)
      AND s.board_id = r.board_id AND s.kind = r.kind AND b.id = r.board_id AND b.status = 'active' AND b.telegram_chat_id IS NOT NULL
    RETURNING r.id, r.board_id, r.kind, s.included_statuses, s.timezone, b.telegram_chat_id`, [now.toISOString()]);
  if (!run.rows[0]) return false;
  try {
    for (const text of await renderPublication(db, run.rows[0].board_id, run.rows[0].kind, run.rows[0].included_statuses, botUsername, run.rows[0].timezone, now)) {
      await telegramCall(botToken, 'sendMessage', { chat_id: run.rows[0].telegram_chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true });
    }
    await db.query("UPDATE publication_runs SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1", [run.rows[0].id]);
  } catch (error) {
    await db.query(`UPDATE publication_runs SET status = 'pending', next_attempt_at = now() + (LEAST(attempts, 6) * interval '1 minute'), last_error = $2 WHERE id = $1`, [run.rows[0].id, error instanceof Error ? error.message.slice(0, 500) : 'unknown']);
  }
  return true;
}

export function startPublicationScheduler(db: Database, botToken: string, botUsername: string) {
  const tick = async () => { await queueDuePublications(db); while (await deliverPendingPublications(db, botToken, botUsername)) {} };
  const timer = setInterval(() => void tick(), 30_000); timer.unref(); void tick();
  return () => clearInterval(timer);
}
