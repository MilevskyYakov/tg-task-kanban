import assert from 'node:assert/strict';
import test from 'node:test';
import { dateInputToIso, defaultFilters, filterTasks, optimisticUpdate, type Task } from '../src/tasks.js';

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
