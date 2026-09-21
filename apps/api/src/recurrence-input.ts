import type { RecurrenceInput } from './db.js';
import { taskInput } from './task-input.js';
import { validTimezone } from './recurrence.js';

// Shared task+rule validator for REST and MCP (issue #99: do not copy into mcp.ts).
export const recurrenceInput = (body: RecurrenceInput | undefined, partial = false): RecurrenceInput | string => {
  const task = taskInput(body, partial); if (typeof task === 'string') return task;
  if ((body?.status !== undefined && body.status !== 'todo') || body?.deadlineDate != null || body?.deadlineTimezone != null || body?.requestId !== undefined) return 'recurrence does not support initial status or date-only deadline';
  if ((!partial || body?.frequency !== undefined) && !['daily', 'weekdays', 'weekly', 'monthly'].includes(body?.frequency ?? '')) return 'invalid frequency';
  if ((!partial || body?.localTime !== undefined) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(body?.localTime ?? '')) return 'invalid local time';
  if ((!partial || body?.timezone !== undefined) && !validTimezone(body?.timezone ?? '')) return 'invalid timezone';
  if ((!partial || body?.startAt !== undefined) && Number.isNaN(Date.parse(body?.startAt ?? ''))) return 'invalid start date';
  if (body?.endAt && Number.isNaN(Date.parse(body.endAt))) return 'invalid end date';
  if (body?.frequency === 'weekdays' && (!body.weekdays?.length || body.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) return 'weekdays are required';
  if (body?.frequency === 'weekly' && (body.weekdays?.length !== 1 || body.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) return 'one weekday is required';
  if (body?.frequency === 'monthly' && (!Number.isInteger(body.dayOfMonth) || body.dayOfMonth! < 1 || body.dayOfMonth! > 31)) return 'day of month is required';
  return { ...body!, ...task };
};
