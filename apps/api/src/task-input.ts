import type { TaskInput } from './db.js';
import { validTimezone } from './recurrence.js';

export const issueUrlPattern = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)$/;
// Accepts full https://github.com/owner/repo/issues/N or owner/repo#N; canonicalizes to the full URL. null clears.
export const canonicalIssueUrl = (value: string | null | undefined): string | null | undefined | 'invalid issue url' => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return 'invalid issue url';
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(value.trim()) ?? issueUrlPattern.exec(value.trim());
  if (!match) return 'invalid issue url';
  const url = `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}`;
  return url.length > 500 ? 'invalid issue url' : url;
};

export const taskInput = (body: TaskInput | undefined, partial = false): TaskInput | string => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid task';
  for (const key of ['title', 'description', 'waitReason', 'deadline', 'deadlineDate', 'deadlineTimezone', 'waitCheckAt', 'projectId', 'assigneeUserId', 'blockerTaskId'] as const) {
    if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') return `invalid ${key}`;
  }
  if (body.issueUrl !== undefined) {
    const issueUrl = canonicalIssueUrl(body.issueUrl);
    if (issueUrl === 'invalid issue url') return issueUrl;
    body.issueUrl = issueUrl;
  }
  const title = body?.title?.trim();
  if ((!partial || body?.title !== undefined) && (!title || title.length > 200)) return 'title must contain 1-200 characters';
  if (body.status !== undefined && !['todo', 'in_progress', 'waiting', 'done'].includes(body.status)) return 'invalid status';
  if (body.priority !== undefined && !['normal', 'urgent'].includes(body.priority)) return 'invalid priority';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (body.requestId !== undefined && (partial || typeof body.requestId !== 'string' || !uuid.test(body.requestId))) return 'invalid request id';
  if (body.projectId != null && !uuid.test(body.projectId)) return 'invalid project id';
  if (body.assigneeUserId != null && !/^[1-9]\d{0,18}$/.test(body.assigneeUserId)) return 'invalid assignee id';
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0, 4)) > 0
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (body.deadlineDate != null && !validDate(body.deadlineDate)) return 'invalid deadline date';
  if (body.deadlineDate != null && (body.deadline != null || typeof body.deadlineTimezone !== 'string'
    || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(body.deadlineTimezone) || !validTimezone(body.deadlineTimezone))) return 'date-only deadline requires timezone and no timestamp';
  if (body.deadlineTimezone != null && body.deadlineDate == null) return 'deadline timezone requires date';
  if ((body.deadlineDate === null) !== (body.deadlineTimezone === null) && (body.deadlineDate === null || body.deadlineTimezone === null)) return 'clear deadline date and timezone together';
  if (body?.blockerTaskId !== undefined && body.blockerTaskId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.blockerTaskId)) return 'invalid blocker task id';
  if (body?.status === 'waiting' && Number(Boolean(body.blockerTaskId)) + Number(Boolean(body.waitReason?.trim())) !== 1) return 'choose one blocker task or external reason';
  if ((body?.waitReason || body?.waitCheckAt || body?.blockerTaskId) && body.status !== 'waiting') return 'blocker fields require waiting status';
  for (const value of [body.deadline, body.waitCheckAt]) if (value != null && (!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.test(value)
    || !validDate(value.slice(0, 10)) || Number.isNaN(Date.parse(value)))) return 'invalid date';
  if (body.waitReason != null && body.waitReason.length > 1000) return 'wait reason too long';
  if (body?.notifyAssignee !== undefined && typeof body.notifyAssignee !== 'boolean') return 'notifyAssignee must be boolean';
  if (body.confirmIncompleteChecklist !== undefined && typeof body.confirmIncompleteChecklist !== 'boolean') return 'invalid checklist confirmation';
  return { ...body!, ...(title ? { title } : {}) };
};
