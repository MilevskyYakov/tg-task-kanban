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
  archived_at?: string;
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
      && (!filters.status || task.status === filters.status)
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
