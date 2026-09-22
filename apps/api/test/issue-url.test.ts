import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalIssueUrl } from '../src/task-input.js';

test('issue url canonicalization accepts both forms and rejects non-issues', () => {
  assert.equal(canonicalIssueUrl('MilevskyYakov/tg-task-kanban#123'), 'https://github.com/MilevskyYakov/tg-task-kanban/issues/123');
  assert.equal(canonicalIssueUrl(' https://github.com/o/r/issues/7 '), 'https://github.com/o/r/issues/7');
  assert.equal(canonicalIssueUrl('o/r#1'), 'https://github.com/o/r/issues/1');
  assert.equal(canonicalIssueUrl(null), null);
  assert.equal(canonicalIssueUrl(undefined), undefined);
  for (const bad of [
    'https://github.com/o/r/pulls/1', 'https://gitlab.com/o/r/issues/1', 'o/r', 'garbage',
    'http://github.com/o/r/issues/1', 'https://github.com/o/r/discussions/4', 'o/r#0', 'o/r#01',
    'https://github.com/o/r/issues/', '/issues/12'
  ]) assert.equal(canonicalIssueUrl(bad), 'invalid issue url', bad);
});
