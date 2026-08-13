import assert from 'node:assert/strict';
import test from 'node:test';
import { nextOccurrence } from '../src/recurrence.js';

test('recurrence rules use local calendar and survive DST', () => {
  const base = { localTime: '09:00', timezone: 'Europe/Berlin', startAt: '2026-01-01T00:00:00Z' } as const;
  assert.equal(nextOccurrence({ ...base, frequency: 'daily' }, new Date('2026-03-28T09:00:00Z'))?.toISOString(), '2026-03-29T07:00:00.000Z');
  assert.equal(nextOccurrence({ ...base, frequency: 'weekdays', weekdays: [1, 3] }, new Date('2026-03-29T10:00:00Z'))?.toISOString(), '2026-03-30T07:00:00.000Z');
  assert.equal(nextOccurrence({ ...base, frequency: 'weekly', weekdays: [0] }, new Date('2026-10-24T10:00:00Z'))?.toISOString(), '2026-10-25T08:00:00.000Z');
  assert.equal(nextOccurrence({ ...base, frequency: 'monthly', dayOfMonth: 31 }, new Date('2026-04-01T00:00:00Z'))?.toISOString(), '2026-05-31T07:00:00.000Z');
});

test('nonexistent DST local time is skipped deterministically', () => {
  const next = nextOccurrence({ frequency: 'daily', localTime: '02:30', timezone: 'Europe/Berlin', startAt: '2026-03-28T00:00:00Z' }, new Date('2026-03-28T02:00:00Z'));
  assert.equal(next?.toISOString(), '2026-03-30T00:30:00.000Z');
});
