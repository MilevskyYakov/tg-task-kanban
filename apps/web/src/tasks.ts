export type TaskStatus = 'todo' | 'in_progress' | 'waiting' | 'done';
export type TaskPriority = 'normal' | 'urgent';

export type Task = {
  id: string;
  board_id: string;
  board_name?: string;
  board_status?: string;
  title: string;
  description?: string;
  project_id?: string;
  project_name?: string;
  assignee_user_id?: string;
  assignee_name?: string;
  creator_user_id: string;
  recurrence_template_id?: string;
  status: TaskStatus;
  priority: TaskPriority;
  deadline?: string;
  deadline_date?: string;
  deadline_timezone?: string;
  wait_check_at?: string;
  wait_reason?: string;
  issue_url?: string;
  blocked_by_task_id?: string;
  blocker_title?: string;
  archived_at?: string;
  checklist_total?: number;
  checklist_completed?: number;
  overdue: boolean;
  wait_check_due: boolean;
};

export type TaskFilters = {
  scope: 'mine' | 'all';
  project: string;
  assignee: string;
  status: '' | TaskStatus;
  priority: '' | TaskPriority;
  deadline: '' | 'overdue' | 'today' | 'week' | 'none';
  unassigned: boolean;
  search: string;
};

export const defaultFilters: TaskFilters = {
  scope: 'mine', project: '', assignee: '', status: '', priority: '', deadline: '', unassigned: false, search: ''
};

export const isBacklogTask = (task: Pick<Task, 'status' | 'assignee_user_id' | 'archived_at'>): boolean =>
  task.status === 'todo' && !task.assignee_user_id && !task.archived_at;

export const parseTaskList = (text: string): string[] => text.split(/\r\n|\n|\r/).map((line) => line.trim()).filter(Boolean);

export function activeFilterCount(filters: TaskFilters): number {
  return Number(filters.scope === 'mine')
    + Number(Boolean(filters.project))
    + Number(Boolean(filters.assignee))
    + Number(Boolean(filters.status))
    + Number(Boolean(filters.priority))
    + Number(Boolean(filters.deadline))
    + Number(filters.unassigned);
}

export function resolveTaskBoard(globalBoardId: string, overrideBoardId: string | undefined, boardIds: string[]): string {
  const available = new Set(boardIds);
  if (overrideBoardId && available.has(overrideBoardId)) return overrideBoardId;
  return available.has(globalBoardId) ? globalBoardId : '';
}

export const statusDisplayName: Record<TaskStatus, string> = {
  todo: 'Новая', in_progress: 'В работе', waiting: 'Блокер', done: 'Готово'
};
export const priorityDisplayName: Record<TaskPriority, string> = { normal: 'Обычная', urgent: 'Срочная' };

// Status changes are allowed for any member of an active board (issue #105); only a non-active board blocks them.
export const taskStatusRestriction = (task: Pick<Task, 'board_status'>): string | null =>
  task.board_status && task.board_status !== 'active' ? 'Доска доступна только для чтения' : null;

export type StartupContext =
  | { surface: 'tasks' }
  | { surface: 'entry'; path: 'personal' | 'pair' | 'group' | 'help' }
  | { surface: 'board-link'; token: string }
  | { surface: 'task'; boardId: string; taskId: string }
  | { surface: 'invalid-task' };

export function resolveStartupContext(startParam?: string): StartupContext {
  if (!startParam) return { surface: 'tasks' };
  if (startParam === 'personal' || startParam === 'pair' || startParam === 'group' || startParam === 'help') return { surface: 'entry', path: startParam };
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const taskLink = new RegExp(`^task_(${uuid})_(${uuid})$`, 'i').exec(startParam);
  if (startParam.startsWith('task_') && !taskLink) return { surface: 'invalid-task' };
  return taskLink
    ? { surface: 'task', boardId: taskLink[1], taskId: taskLink[2] }
    : { surface: 'board-link', token: startParam };
}

export type TaskViewState = {
  view: 'list' | 'kanban';
  grouping: 'deadline' | 'project';
  filters: TaskFilters;
  scrollY: number;
  kanbanStatus: TaskStatus;
};

export const defaultTaskViewState: TaskViewState = {
  view: 'list', grouping: 'deadline', filters: defaultFilters, scrollY: 0, kanbanStatus: 'todo'
};

const taskStatuses: TaskStatus[] = ['todo', 'in_progress', 'waiting', 'done'];
const taskPriorities: TaskPriority[] = ['normal', 'urgent'];
const deadlineFilters: TaskFilters['deadline'][] = ['', 'overdue', 'today', 'week', 'none'];

function isTaskFilters(value: unknown): value is TaskFilters {
  if (!value || typeof value !== 'object') return false;
  const filters = value as Record<string, unknown>;
  return (filters.scope === 'mine' || filters.scope === 'all')
    && typeof filters.project === 'string'
    && typeof filters.assignee === 'string'
    && (filters.status === '' || taskStatuses.includes(filters.status as TaskStatus))
    && (filters.priority === '' || taskPriorities.includes(filters.priority as TaskPriority))
    && deadlineFilters.includes(filters.deadline as TaskFilters['deadline'])
    && typeof filters.unassigned === 'boolean'
    && typeof filters.search === 'string';
}

export const serializeTaskViewState = (state: TaskViewState): string => JSON.stringify(state);

export function restoreTaskViewState(value: string | null): TaskViewState {
  try {
    const state = JSON.parse(value ?? '') as Partial<TaskViewState>;
    if ((state.view !== 'list' && state.view !== 'kanban')
      || (state.grouping !== 'deadline' && state.grouping !== 'project')
      || !isTaskFilters(state.filters)
      || typeof state.scrollY !== 'number' || !Number.isFinite(state.scrollY) || state.scrollY < 0
      || !taskStatuses.includes(state.kanbanStatus as TaskStatus)) return defaultTaskViewState;
    return state as TaskViewState;
  } catch {
    return defaultTaskViewState;
  }
}

export function resolveKanbanSwipe(status: TaskStatus, startX: number, startY: number, endX: number, endY: number): TaskStatus {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  if (Math.abs(deltaX) < 48 || Math.abs(deltaX) <= Math.abs(deltaY)) return status;
  const index = taskStatuses.indexOf(status) + (deltaX < 0 ? 1 : -1);
  return taskStatuses[Math.max(0, Math.min(taskStatuses.length - 1, index))];
}

export type DeadlineGroup = 'overdue' | 'today' | 'upcoming' | 'none';

function localDateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).reduce<Record<string, string>>((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function groupTasksByDeadline(tasks: Task[], now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Record<DeadlineGroup, Task[]> {
  const groups: Record<DeadlineGroup, Task[]> = { overdue: [], today: [], upcoming: [], none: [] };
  const today = localDateKey(now, timeZone);
  for (const task of tasks) {
    if (!task.deadline && !task.deadline_date) { groups.none.push(task); continue; }
    const date = task.deadline_date ?? localDateKey(new Date(task.deadline!), timeZone);
    const taskToday = task.deadline_date ? localDateKey(now, task.deadline_timezone!) : today;
    groups[date < taskToday ? 'overdue' : date === taskToday ? 'today' : 'upcoming'].push(task);
  }
  return groups;
}

export function groupTasksByProject(tasks: Task[]): { id?: string; name: string; tasks: Task[] }[] {
  const groups = new Map<string, { id?: string; name: string; tasks: Task[] }>();
  for (const task of tasks) {
    const key = task.project_id ?? '';
    const group = groups.get(key) ?? { id: task.project_id, name: task.project_name ?? 'Без проекта', tasks: [] };
    group.tasks.push(task); groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => left.id === undefined ? 1 : right.id === undefined ? -1 : left.name.localeCompare(right.name, 'ru-RU'));
}

export function filterTasks(tasks: Task[], filters: TaskFilters, userId: string, now = new Date()): Task[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const nextWeek = new Date(today); nextWeek.setDate(today.getDate() + 7);
  const search = filters.search.trim().toLocaleLowerCase('ru-RU');

  return tasks.filter((task) => {
    const deadline = task.deadline ? new Date(task.deadline) : null;
    const zone = task.deadline_timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const dateToday = localDateKey(now, zone);
    const dateWeek = new Date(`${dateToday}T00:00:00Z`); dateWeek.setUTCDate(dateWeek.getUTCDate() + 7);
    return (filters.scope === 'all' || task.assignee_user_id === userId)
      && (!filters.project || task.project_id === filters.project)
      && (!filters.assignee || task.assignee_user_id === filters.assignee)
      && (filters.status ? task.status === filters.status : task.status !== 'done')
      && (!filters.priority || task.priority === filters.priority)
      && (!filters.unassigned || !task.assignee_user_id)
      && (!search || task.title.toLocaleLowerCase('ru-RU').includes(search) || task.description?.toLocaleLowerCase('ru-RU').includes(search))
      && (!filters.deadline
        || (filters.deadline === 'none' && !deadline && !task.deadline_date)
        || (filters.deadline === 'overdue' && task.overdue)
        || (filters.deadline === 'today' && (task.deadline_date ? task.deadline_date === dateToday : deadline !== null && deadline >= today && deadline < tomorrow))
        || (filters.deadline === 'week' && (task.deadline_date ? task.deadline_date >= dateToday && task.deadline_date < dateWeek.toISOString().slice(0, 10) : deadline !== null && deadline >= today && deadline < nextWeek)));
  });
}

export async function optimisticUpdate<T>(current: T, next: T, render: (value: T) => void, save: () => Promise<void>): Promise<void> {
  render(next);
  try { await save(); }
  catch (error) { render(current); throw error; }
}

export function validateTaskCreate(title: string, boardId: string): string | null {
  if (!title.trim()) return 'Введите название задачи';
  if (title.trim().length > 200) return 'Название длиннее 200 символов';
  if (!boardId) return 'Выберите доску';
  return null;
}

export function presentCreatedTask(task: Task, boardName?: string, projectName?: string, assigneeName?: string, now = new Date()): Task {
  return {
    ...task, board_name: boardName, project_name: projectName, assignee_name: assigneeName,
    checklist_total: 0, checklist_completed: 0,
    overdue: isTaskOverdue(task, now), wait_check_due: Boolean(task.status === 'waiting' && task.wait_check_at && new Date(task.wait_check_at) <= now)
  };
}

export function dateInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value ? date.toISOString() : null;
}

export function dateTimeInputsToIso(date: string, time: string): string | null {
  if (!dateInputToIso(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const value = new Date(`${date}T${time}:00`);
  return Number.isNaN(value.valueOf()) || localDateKey(value, Intl.DateTimeFormat().resolvedOptions().timeZone) !== date
    || `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}` !== time ? null : value.toISOString();
}

export type DeadlineDraft = { mode: 'none' | 'date' | 'datetime'; date: string; time: string; timezone: string; originalTimestamp?: string };
export const deadlineModeName = { none: 'Без срока', date: 'Только дата', datetime: 'Дата и время' };

export function deadlineDraft(task?: Pick<Task, 'deadline' | 'deadline_date' | 'deadline_timezone'>): DeadlineDraft {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = task?.deadline ? new Date(task.deadline) : null;
  return {
    mode: task?.deadline_date ? 'date' : date ? 'datetime' : 'none',
    date: task?.deadline_date ?? (date ? localDateKey(date, timezone) : ''),
    time: date ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : '',
    timezone: task?.deadline_timezone ?? timezone, originalTimestamp: task?.deadline
  };
}

export function deadlinePatch(draft: DeadlineDraft) {
  if (draft.mode !== 'none' && !dateInputToIso(draft.date)) throw new Error('Укажите корректный срок');
  let deadline: string | null = null;
  if (draft.mode === 'datetime') {
    const original = deadlineDraft({ deadline: draft.originalTimestamp });
    deadline = draft.originalTimestamp && original.date === draft.date && original.time === draft.time
      ? draft.originalTimestamp : dateTimeInputsToIso(draft.date, draft.time);
    if (!deadline) throw new Error('Укажите корректные дату и время');
  }
  return { deadline, deadlineDate: draft.mode === 'date' ? draft.date : null, deadlineTimezone: draft.mode === 'date' ? draft.timezone : null };
}

export function isTaskOverdue(task: Pick<Task, 'status' | 'deadline' | 'deadline_date' | 'deadline_timezone'>, now = new Date()): boolean {
  return task.status !== 'done' && (task.deadline_date
    ? localDateKey(now, task.deadline_timezone!) > task.deadline_date : Boolean(task.deadline && new Date(task.deadline) < now));
}

export function formatTaskDeadline(task: Pick<Task, 'deadline' | 'deadline_date' | 'deadline_timezone'>): string {
  if (task.deadline_date) return `${new Date(`${task.deadline_date}T00:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' })} · весь день`;
  return task.deadline ? new Date(task.deadline).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Без срока';
}
