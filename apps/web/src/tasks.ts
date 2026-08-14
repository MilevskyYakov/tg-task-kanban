export type TaskStatus = 'todo' | 'in_progress' | 'waiting' | 'done';
export type TaskPriority = 'normal' | 'urgent';

export type Task = {
  id: string;
  board_id: string;
  board_name?: string;
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
  wait_reason?: string;
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

export function activeFilterCount(filters: TaskFilters): number {
  return Number(filters.scope !== defaultFilters.scope)
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

export type StartupContext =
  | { surface: 'tasks' }
  | { surface: 'board-link'; token: string }
  | { surface: 'task'; boardId: string; taskId: string };

export function resolveStartupContext(startParam?: string): StartupContext {
  if (!startParam) return { surface: 'tasks' };
  const taskLink = /^task_([^_]+)_([^_]+)$/.exec(startParam);
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
    if (!task.deadline) { groups.none.push(task); continue; }
    const deadline = new Date(task.deadline);
    const date = localDateKey(deadline, timeZone);
    groups[date < today ? 'overdue' : date === today ? 'today' : 'upcoming'].push(task);
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
    return (filters.scope === 'all' || task.assignee_user_id === userId)
      && (!filters.project || task.project_id === filters.project)
      && (!filters.assignee || task.assignee_user_id === filters.assignee)
      && (filters.status ? task.status === filters.status : task.status !== 'done')
      && (!filters.priority || task.priority === filters.priority)
      && (!filters.unassigned || !task.assignee_user_id)
      && (!search || task.title.toLocaleLowerCase('ru-RU').includes(search) || task.description?.toLocaleLowerCase('ru-RU').includes(search))
      && (!filters.deadline
        || (filters.deadline === 'none' && !deadline)
        || (filters.deadline === 'overdue' && task.overdue)
        || (filters.deadline === 'today' && deadline !== null && deadline >= today && deadline < tomorrow)
        || (filters.deadline === 'week' && deadline !== null && deadline >= today && deadline < nextWeek));
  });
}

export async function optimisticUpdate<T>(current: T, next: T, render: (value: T) => void, save: () => Promise<void>): Promise<void> {
  render(next);
  try { await save(); }
  catch (error) { render(current); throw error; }
}

export function dateInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value ? date.toISOString() : null;
}
