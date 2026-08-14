import assert from 'node:assert/strict';
import test from 'node:test';
import { initialNavigation } from '../src/navigation.js';
import {
  dateInputToIso,
  defaultFilters,
  defaultTaskViewState,
  filterTasks,
  groupTasksByDeadline,
  groupTasksByProject,
  optimisticUpdate,
  priorityDisplayName,
  resolveStartupContext,
  restoreTaskViewState,
  serializeTaskViewState,
  statusDisplayName,
  type Task
} from '../src/tasks.js';

const tasks: Task[] = [
  { id: '1', board_id: 'b', title: 'Срочный релиз', description: 'Проверить API', project_id: 'p', assignee_user_id: 'u', creator_user_id: 'u', status: 'in_progress', priority: 'urgent', deadline: '2026-08-12T10:00:00Z', overdue: true, wait_check_due: false },
  { id: '2', board_id: 'b', title: 'Документы', creator_user_id: 'u', status: 'todo', priority: 'normal', overdue: false, wait_check_due: false }
];

test('combined task filters and search use one shared task set', () => {
  assert.deepEqual(filterTasks(tasks, defaultFilters, 'u').map((task) => task.id), ['1']);
  assert.deepEqual(filterTasks(tasks, { ...defaultFilters, scope: 'all', project: 'p', priority: 'urgent', status: 'in_progress', deadline: 'overdue', search: 'api' }, 'u', new Date('2026-08-13T12:00:00Z')).map((task) => task.id), ['1']);
  assert.deepEqual(filterTasks(tasks, { ...defaultFilters, scope: 'all', unassigned: true }, 'u').map((task) => task.id), ['2']);
  assert.deepEqual(filterTasks(tasks, { ...defaultFilters, scope: 'all', search: 'нет совпадений' }, 'u'), []);
});

test('optimistic update rolls UI back when API rejects change', async () => {
  const renders: string[] = [];
  await assert.rejects(optimisticUpdate('todo', 'done', (value) => renders.push(value), async () => { throw new Error('forbidden'); }));
  assert.deepEqual(renders, ['done', 'todo']);
});

test('date input rejects malformed and impossible calendar dates', () => {
  assert.equal(dateInputToIso('2026-02-28'), '2026-02-28T00:00:00.000Z');
  assert.equal(dateInputToIso('2026-02-30'), null);
  assert.equal(dateInputToIso('30.02.2026'), null);
});

test('startup context defaults to tasks and distinguishes board and task links', () => {
  assert.deepEqual(resolveStartupContext(), { surface: 'tasks' });
  assert.deepEqual(resolveStartupContext('invite-token'), { surface: 'board-link', token: 'invite-token' });
  assert.deepEqual(resolveStartupContext('task_board-id_task-id'), { surface: 'task', boardId: 'board-id', taskId: 'task-id' });
});

test('app navigation starts on tasks', () => {
  assert.deepEqual(initialNavigation(), { screen: 'tasks' });
});

test('deadline groups use the requested timezone for the Today boundary', () => {
  const grouped = groupTasksByDeadline([
    { ...tasks[0], id: 'overdue', deadline: '2026-08-14T20:00:00Z' },
    { ...tasks[0], id: 'today', deadline: '2026-08-14T22:00:00Z' },
    { ...tasks[0], id: 'upcoming', deadline: '2026-08-15T21:30:00Z' },
    { ...tasks[1], id: 'none' }
  ], new Date('2026-08-14T21:30:00Z'), 'Europe/Moscow');

  assert.deepEqual(Object.fromEntries(Object.entries(grouped).map(([key, value]) => [key, value.map((task) => task.id)])), {
    overdue: ['overdue'], today: ['today'], upcoming: ['upcoming'], none: ['none']
  });
});

test('project groups are alphabetical with unassigned tasks last', () => {
  const grouped = groupTasksByProject([
    { ...tasks[0], id: 'b', project_id: 'b', project_name: 'Бета' },
    { ...tasks[0], id: 'a', project_id: 'a', project_name: 'Альфа' },
    { ...tasks[1], id: 'none' }
  ]);
  assert.deepEqual(grouped.map((group) => [group.name, group.tasks.map((task) => task.id)]), [
    ['Альфа', ['a']], ['Бета', ['b']], ['Без проекта', ['none']]
  ]);
});

test('task view state round-trips and malformed state falls back safely', () => {
  const state = { ...defaultTaskViewState, view: 'kanban' as const, grouping: 'project' as const, scrollY: 240, kanbanStatus: 'waiting' as const, filters: { ...defaultFilters, scope: 'all' as const, search: 'релиз' } };
  assert.deepEqual(restoreTaskViewState(serializeTaskViewState(state)), state);
  assert.deepEqual(restoreTaskViewState('{broken'), defaultTaskViewState);
});

test('display mappings capture agreed product language', () => {
  assert.deepEqual(statusDisplayName, { todo: 'Новая', in_progress: 'В работе', waiting: 'Блокер', done: 'Готово' });
  assert.deepEqual(priorityDisplayName, { normal: 'Обычная', urgent: 'Срочная' });
});
