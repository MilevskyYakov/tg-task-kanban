import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveChoiceIndex, resolveFocusIndex } from '../src/app-shell.js';
import { resolveThemeScheme } from '../src/environment.js';
import { countLabel, initialNavigation, isSettingsNavigation, settingsSections } from '../src/navigation.js';
import { taskDraft, taskPatch } from '../src/task-details.js';
import {
  activeFilterCount,
  dateInputToIso,
  dateTimeInputsToIso,
  deadlineDraft,
  deadlinePatch,
  formatTaskDeadline,
  isTaskOverdue,
  isBacklogTask,
  parseTaskList,
  defaultFilters,
  defaultTaskViewState,
  filterTasks,
  groupTasksByDeadline,
  groupTasksByProject,
  optimisticUpdate,
  presentCreatedTask,
  priorityDisplayName,
  resolveKanbanSwipe,
  resolveStartupContext,
  resolveTaskBoard,
  restoreTaskViewState,
  serializeTaskViewState,
  statusDisplayName,
  taskStatusRestriction,
  validateTaskCreate,
  type Task
} from '../src/tasks.js';

test('backlog eligibility excludes assigned, archived and all other statuses; list keeps intentional duplicates', () => {
  for (const status of ['todo', 'in_progress', 'waiting', 'done'] as const) {
    assert.equal(isBacklogTask({ status }), status === 'todo');
    assert.equal(isBacklogTask({ status, assignee_user_id: '1' }), false);
    assert.equal(isBacklogTask({ status, archived_at: '2026-09-12' }), false);
  }
  assert.deepEqual(parseTaskList(' One \r\n\nOne\r Two \n  '), ['One', 'One', 'Two']);
  assert.equal(validateTaskCreate('x'.repeat(200), 'board'), null);
  assert.equal(validateTaskCreate('x'.repeat(201), 'board'), 'Название длиннее 200 символов');
});

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
  assert.equal(activeFilterCount(defaultFilters), 1);
  assert.equal(activeFilterCount({ ...defaultFilters, search: 'релиз' }), 1);
  assert.equal(activeFilterCount({ ...defaultFilters, scope: 'all', priority: 'urgent', unassigned: true }), 2);
});

test('chat board overrides global choice without replacing it', () => {
  const boardIds = ['personal', 'chat'];
  assert.equal(resolveTaskBoard('personal', undefined, boardIds), 'personal');
  assert.equal(resolveTaskBoard('personal', 'chat', boardIds), 'chat');
  assert.equal(resolveTaskBoard('missing', undefined, boardIds), '');
});

test('optimistic update rolls UI back when API rejects change', async () => {
  const renders: string[] = [];
  await assert.rejects(optimisticUpdate('todo', 'done', (value) => renders.push(value), async () => { throw new Error('Завершить задачу может только назначенный исполнитель'); }),
    /Завершить задачу может только назначенный исполнитель/);
  assert.deepEqual(renders, ['done', 'todo']);
});

test('status restriction is read-only board only; any member may change statuses', () => {
  const assigned = { ...tasks[0], creator_user_id: 'creator', assignee_user_id: 'assignee' };
  assert.equal(taskStatusRestriction(assigned), null);
  assert.equal(taskStatusRestriction({ ...tasks[1], creator_user_id: 'creator' }), null);
  assert.equal(taskStatusRestriction({ ...assigned, board_status: 'archived' }), 'Доска доступна только для чтения');
  assert.equal(taskStatusRestriction({ ...assigned, board_status: 'frozen' }), 'Доска доступна только для чтения');
  assert.equal(taskStatusRestriction({ ...assigned, board_status: 'active' }), null);
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
  const boardId = '123e4567-e89b-12d3-a456-426614174000';
  const taskId = '123e4567-e89b-42d3-a456-426614174001';
  assert.deepEqual(resolveStartupContext(), { surface: 'tasks' });
  for (const path of ['personal', 'pair', 'group', 'help']) assert.deepEqual(resolveStartupContext(path), { surface: 'entry', path });
  assert.deepEqual(resolveStartupContext('pair_invite'), { surface: 'board-link', token: 'pair_invite' });
  assert.deepEqual(resolveStartupContext('invite-token'), { surface: 'board-link', token: 'invite-token' });
  assert.deepEqual(resolveStartupContext(`task_${boardId}_${taskId}`), { surface: 'task', boardId, taskId });
  assert.deepEqual(resolveStartupContext('task_missing_task-id'), { surface: 'invalid-task' });
  assert.deepEqual(resolveStartupContext('task_'), { surface: 'invalid-task' });
});

test('app navigation starts on tasks', () => {
  assert.deepEqual(initialNavigation(), { screen: 'tasks' });
});

test('visual foundation stays light regardless of Telegram or system theme', () => {
  assert.equal(resolveThemeScheme(), 'light');
});

test('choice sheet focus wraps only at keyboard boundaries', () => {
  assert.equal(resolveFocusIndex(2, 3, false), 0);
  assert.equal(resolveFocusIndex(0, 3, true), 2);
  assert.equal(resolveFocusIndex(1, 3, false), null);
  assert.equal(resolveFocusIndex(0, 0, false), null);
});

test('radio choices support arrow, Home, and End navigation', () => {
  assert.equal(resolveChoiceIndex(1, 3, 'ArrowDown'), 2);
  assert.equal(resolveChoiceIndex(2, 3, 'ArrowRight'), 0);
  assert.equal(resolveChoiceIndex(0, 3, 'ArrowUp'), 2);
  assert.equal(resolveChoiceIndex(1, 3, 'Home'), 0);
  assert.equal(resolveChoiceIndex(1, 3, 'End'), 2);
  assert.equal(resolveChoiceIndex(1, 3, 'Enter'), null);
});

test('settings root exposes only agreed sections and keeps child navigation active', () => {
  assert.deepEqual(settingsSections.map(({ title }) => title), ['Рабочее пространство', 'Автоматизация', 'Аккаунт']);
  assert.equal(isSettingsNavigation({ screen: 'settings-workspace' }), true);
  assert.equal(isSettingsNavigation({ screen: 'tasks' }), false);
});

test('settings counters use Russian singular, few, and many forms', () => {
  assert.equal(countLabel(1, 'проект', 'проекта', 'проектов'), '1 проект');
  assert.equal(countLabel(3, 'проект', 'проекта', 'проектов'), '3 проекта');
  assert.equal(countLabel(11, 'проект', 'проекта', 'проектов'), '11 проектов');
  assert.equal(countLabel(24, 'проект', 'проекта', 'проектов'), '24 проекта');
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

test('kanban swipe changes one column only for horizontal gestures', () => {
  assert.equal(resolveKanbanSwipe('in_progress', 120, 200, 40, 210), 'waiting');
  assert.equal(resolveKanbanSwipe('in_progress', 40, 200, 120, 190), 'todo');
  assert.equal(resolveKanbanSwipe('in_progress', 120, 120, 90, 240), 'in_progress', 'vertical scroll keeps current column');
  assert.equal(resolveKanbanSwipe('todo', 120, 200, 40, 205), 'in_progress');
  assert.equal(resolveKanbanSwipe('done', 40, 200, 120, 205), 'waiting');
});

test('display mappings capture agreed product language', () => {
  assert.deepEqual(statusDisplayName, { todo: 'Новая', in_progress: 'В работе', waiting: 'Блокер', done: 'Готово' });
  assert.deepEqual(priorityDisplayName, { normal: 'Обычная', urgent: 'Срочная' });
});

test('task details patch validates blockers and preserves editable fields', () => {
  const draft = { ...taskDraft(tasks[0]), title: '  Обновлённая задача  ', description: '  Детали  ', due: { mode: 'date' as const, date: '2026-08-20', time: '', timezone: 'Europe/Moscow' }, status: 'waiting' as const, waitReason: '  Ждём клиента  ' };
  assert.deepEqual(taskPatch(draft), {
    title: 'Обновлённая задача', description: 'Детали', status: 'waiting', projectId: 'p', assigneeUserId: 'u',
    deadline: null, deadlineDate: '2026-08-20', deadlineTimezone: 'Europe/Moscow', priority: 'urgent', blockerTaskId: null, waitReason: 'Ждём клиента', waitCheckAt: null, notifyAssignee: false
  });
  assert.throws(() => taskPatch({ ...draft, waitReason: '' }), /задачу-блокер или внешнюю причину/);
  assert.throws(() => taskPatch({ ...draft, due: { ...draft.due, date: '2026-02-30' } }), /корректный срок/);
});

test('deadline modes round-trip without changing old timestamps, DST folds or date-only zones', () => {
  const originalTZ = process.env.TZ;
  try {
    for (const zone of ['UTC', 'Europe/Moscow', 'America/New_York', 'Pacific/Honolulu']) {
      process.env.TZ = zone;
      for (const deadline of ['2026-08-14T00:00:00.000Z', '2026-08-14T18:30:47.123Z', '2026-11-01T06:30:00.000Z']) {
        assert.equal(taskPatch(taskDraft({ ...tasks[0], deadline })).deadline, deadline);
      }
      const dateTask = { ...tasks[0], deadline: undefined, deadline_date: '2026-03-08', deadline_timezone: 'America/New_York' };
      assert.deepEqual(deadlinePatch(deadlineDraft(dateTask)), { deadline: null, deadlineDate: '2026-03-08', deadlineTimezone: 'America/New_York' });
      assert.equal(isTaskOverdue(dateTask, new Date('2026-03-09T03:59:59.999Z')), false);
      assert.equal(isTaskOverdue(dateTask, new Date('2026-03-09T04:00:00.000Z')), true);
      assert.equal(groupTasksByDeadline([dateTask], new Date('2026-03-09T03:59:59Z'), zone).today.length, 1);
      assert.equal(filterTasks([dateTask], { ...defaultFilters, deadline: 'today' }, 'u', new Date('2026-03-09T03:59:59Z')).length, 1);
      assert.equal(filterTasks([dateTask], { ...defaultFilters, deadline: 'none' }, 'u').length, 0);
      assert.match(formatTaskDeadline(dateTask), /8 мар.*весь день/);
    }
    process.env.TZ = 'America/New_York';
    assert.equal(dateTimeInputsToIso('2026-03-08', '02:30'), null, 'nonexistent local time is not silently shifted');
    assert.equal(dateTimeInputsToIso('2026-08-14', ''), null, 'exact deadline requires time');
    assert.deepEqual(deadlinePatch(deadlineDraft()), { deadline: null, deadlineDate: null, deadlineTimezone: null });
  } finally { if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ; }
});
