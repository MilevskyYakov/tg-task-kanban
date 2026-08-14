import assert from 'node:assert/strict';
import test from 'node:test';
import { initialNavigation } from '../src/navigation.js';
import {
  activeFilterCount,
  dateInputToIso,
  dateTimeInputsToIso,
  defaultFilters,
  defaultTaskViewState,
  filterTasks,
  groupTasksByDeadline,
  groupTasksByProject,
  optimisticUpdate,
  presentCreatedTask,
  priorityDisplayName,
  resolveStartupContext,
  resolveTaskBoard,
  restoreTaskViewState,
  serializeTaskViewState,
  statusDisplayName,
  validateTaskCreate,
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

test('completed tasks stay hidden until status filter requests them', () => {
  const done = { ...tasks[0], id: 'done', status: 'done' as const };
  assert.deepEqual(filterTasks([...tasks, done], { ...defaultFilters, scope: 'all' }, 'u').map((task) => task.id), ['1', '2']);
  assert.deepEqual(filterTasks([...tasks, done], { ...defaultFilters, scope: 'all', status: 'done' }, 'u').map((task) => task.id), ['done']);
});

test('filter count includes only active conditions, not search', () => {
  assert.equal(activeFilterCount(defaultFilters), 0);
  assert.equal(activeFilterCount({ ...defaultFilters, search: 'релиз' }), 0);
  assert.equal(activeFilterCount({ ...defaultFilters, scope: 'all', priority: 'urgent', unassigned: true }), 3);
});

test('chat board overrides global choice without replacing it', () => {
  const boardIds = ['personal', 'chat'];
  assert.equal(resolveTaskBoard('personal', undefined, boardIds), 'personal');
  assert.equal(resolveTaskBoard('personal', 'chat', boardIds), 'chat');
  assert.equal(resolveTaskBoard('missing', undefined, boardIds), '');
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

test('task create validates required fields and combines native date and time inputs', () => {
  assert.equal(validateTaskCreate('  ', 'board'), 'Введите название задачи');
  assert.equal(validateTaskCreate('Задача', ''), 'Выберите доску');
  assert.equal(validateTaskCreate(' Задача ', 'board'), null);
  assert.equal(dateTimeInputsToIso('2026-08-14', '18:30'), new Date('2026-08-14T18:30:00').toISOString());
  assert.equal(dateTimeInputsToIso('2026-02-30', '18:30'), null);
  assert.equal(dateTimeInputsToIso('2026-08-14', '25:00'), null);
});

test('created task is presented with its selected context before a canonical reload', () => {
  const created = presentCreatedTask({ ...tasks[0], project_name: undefined, assignee_name: undefined, overdue: false }, 'Доска', 'Проект', 'Яков', new Date('2026-08-13T12:00:00Z'));
  assert.deepEqual({ board: created.board_name, project: created.project_name, assignee: created.assignee_name, overdue: created.overdue, checklist: [created.checklist_completed, created.checklist_total] }, {
    board: 'Доска', project: 'Проект', assignee: 'Яков', overdue: true, checklist: [0, 0]
  });
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
