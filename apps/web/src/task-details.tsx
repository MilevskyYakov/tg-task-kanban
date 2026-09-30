import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from './api';
import { ActionRow, Avatar, ChoiceRow, EnvironmentStatus, Icon, Sheet } from './app-shell';
import { issueUrlShort, type Collaboration, type Member, type Project } from './domain';
import { dateInputToIso, deadlineDraft, deadlinePatch, priorityDisplayName, statusDisplayName, type DeadlineDraft, type Task, type TaskPriority, type TaskStatus } from './tasks';
import { DeadlineField } from './deadline-field';
import { Autosave, reconnectRetry, type SaveState } from './autosave';

const statuses = Object.keys(statusDisplayName) as TaskStatus[];
type DetailChoice = 'status' | 'project' | 'assignee' | 'priority' | 'blocker';

function githubIssueHref(value: string) {
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(value);
  if (short) return `https://github.com/${short[1]}/${short[2]}/issues/${short[3]}`;
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/.test(value) ? value : undefined;
}

export type TaskDraft = {
  title: string;
  description: string;
  status: TaskStatus;
  projectId: string;
  assigneeUserId: string;
  due: DeadlineDraft;
  priority: TaskPriority;
  blockerTaskId: string;
  issueUrl: string;
  waitReason: string;
  waitCheckAt: string;
  notifyAssignee: boolean;
};

export function taskDraft(task: Task): TaskDraft {
  return {
    title: task.title,
    description: task.description ?? '',
    status: task.status,
    projectId: task.project_id ?? '',
    assigneeUserId: task.assignee_user_id ?? '',
    due: deadlineDraft(task),
    priority: task.priority,
    blockerTaskId: task.blocked_by_task_id ?? '',
    issueUrl: task.issue_url ?? '',
    waitReason: task.wait_reason ?? '',
    // Keep the stored date so editing a waiting task does not silently clear it (issue #129).
    waitCheckAt: task.wait_check_at ? task.wait_check_at.slice(0, 10) : '',
    notifyAssignee: false
  };
}

// Build a minimal patch: only fields that actually changed against `base` (issue #129).
// Unrelated fields of other collaborators survive; sending no diff yields an empty patch.
export function taskPatch(draft: TaskDraft, base: TaskDraft) {
  const errors: Partial<Record<keyof TaskDraft, string>> = {};
  const patch: Record<string, unknown> = {};
  if (!draft.title.trim()) errors.title = 'Название задачи обязательно';
  else if (draft.title.trim().length > 200) errors.title = 'Название длиннее 200 символов';
  else if (draft.title.trim() !== base.title.trim()) patch.title = draft.title.trim();
  const issueUrl = draft.issueUrl.trim() || null;
  const issueHref = issueUrl ? githubIssueHref(issueUrl) : undefined;
  if (issueUrl && (!issueHref || issueHref.length > 500)) errors.issueUrl = 'Ссылка на issue: https://github.com/owner/repo/issues/N или owner/repo#N';
  else if (!sameDraftField(draft, base, 'issueUrl')) patch.issueUrl = issueUrl;
  if (draft.description !== base.description) patch.description = draft.description.trim() ? draft.description : null;
  if (draft.priority !== base.priority) patch.priority = draft.priority;
  if (draft.projectId !== base.projectId) patch.projectId = draft.projectId || null;
  if (draft.assigneeUserId !== base.assigneeUserId) {
    patch.assigneeUserId = draft.assigneeUserId || null;
    // Notification is chosen once for this assignment, not replayed by later autosaves (issue #129).
    patch.notifyAssignee = draft.notifyAssignee;
  }
  const deadlineChanged = draft.due.mode !== base.due.mode
    || (draft.due.mode === 'date' && (draft.due.date !== base.due.date || draft.due.timezone !== base.due.timezone))
    || (draft.due.mode === 'datetime' && (draft.due.date !== base.due.date || draft.due.time !== base.due.time));
  if (deadlineChanged) {
    try { Object.assign(patch, deadlinePatch(draft.due)); }
    catch (caught) { errors.due = (caught as Error).message; }
  }
  if (draft.status === 'waiting') {
    const waitCheckAt = draft.waitCheckAt ? dateInputToIso(draft.waitCheckAt) : null;
    if (!draft.blockerTaskId && !draft.waitReason.trim()) errors.waitReason = 'Укажите задачу-блокер или внешнюю причину';
    else if (!draft.blockerTaskId && draft.waitReason.length > 1000) errors.waitReason = 'Причина длиннее 1000 символов';
    if (draft.waitCheckAt && !waitCheckAt) errors.waitCheckAt = 'Укажите корректную дату проверки';
    if (!errors.waitReason && !errors.waitCheckAt) {
      if (draft.status !== base.status) patch.status = draft.status;
      if (draft.status !== base.status || draft.blockerTaskId !== base.blockerTaskId || draft.waitReason !== base.waitReason) {
        patch.blockerTaskId = draft.blockerTaskId || null;
        patch.waitReason = draft.blockerTaskId ? null : draft.waitReason.trim();
      }
      // Do not round a stored timestamp to midnight when only the reason changes.
      if (draft.status !== base.status || draft.waitCheckAt !== base.waitCheckAt) patch.waitCheckAt = waitCheckAt;
    }
  } else if (draft.status !== base.status) {
    patch.status = draft.status;
  }
  // Leaving waiting clears the group on the server but only when the status change itself is in flight.
  if (draft.status !== base.status && base.status === 'waiting') {
    patch.blockerTaskId = null;
    patch.waitReason = null;
    patch.waitCheckAt = null;
  }
  return { patch, errors };
}

type Props = {
  task: Task;
  userId: string;
  readOnly?: boolean;
  collaboration: Collaboration;
  projects: Project[];
  members: Member[];
  candidateTasks: Task[];
  boardName: string;
  onBack: () => void;
  onClaim?: () => void;
  onSave: (patch: Record<string, unknown>, future: boolean, confirmIncompleteChecklist?: boolean, expectedVersion?: string) => Promise<Task>;
  onConfirmed: (task: Task) => void;
  onArchive: () => Promise<void>;
  onChecklistAdd: (text: string) => Promise<void>;
  onChecklistUpdate: (itemId: string, patch: { text?: string; completed?: boolean }) => Promise<void>;
  onChecklistDelete: (itemId: string) => Promise<void>;
  onComment: (body: string) => Promise<void>;
  onUrlAttachment: (url: string) => Promise<void>;
  onFileAttachment: (file: File) => Promise<void>;
};

const saveStateLabels: Record<SaveState, string> = {
  idle: '', pending: 'Ожидает отправки', saving: 'Сохраняется…', saved: 'Сохранено', error: 'Не сохранено. Проверьте связь и подождите или повторите выход.'
};

const draftGroups: (keyof TaskDraft)[][] = [
  ['title'], ['description'], ['projectId'], ['assigneeUserId'], ['due'], ['priority'], ['issueUrl'],
  ['status', 'blockerTaskId', 'waitReason', 'waitCheckAt']
];
const sameDraftField = (left: TaskDraft, right: TaskDraft, key: keyof TaskDraft) => {
  // Leaving waiting clears these on the server; dormant draft values are not a conflict.
  if (['blockerTaskId', 'waitReason', 'waitCheckAt'].includes(key) && left.status !== 'waiting' && right.status !== 'waiting') return true;
  if (key === 'due') {
    try { return JSON.stringify(deadlinePatch(left.due)) === JSON.stringify(deadlinePatch(right.due)); }
    catch { return JSON.stringify(left.due) === JSON.stringify(right.due); }
  }
  if (key === 'title') return left.title.trim() === right.title.trim();
  if (key === 'issueUrl') return (githubIssueHref(left.issueUrl.trim()) ?? left.issueUrl.trim()) === (githubIssueHref(right.issueUrl.trim()) ?? right.issueUrl.trim());
  return left[key] === right[key];
};

// Three-way merge: a server-only change is never turned into a local PATCH.
// Status/blocker and deadline stay indivisible, including incomplete local input.
export function mergeTaskDraft(base: TaskDraft, local: TaskDraft, server: TaskDraft) {
  const draft = { ...server, notifyAssignee: local.notifyAssignee };
  const conflicts: (keyof TaskDraft)[] = [];
  for (const group of draftGroups) {
    if (group.every((key) => sameDraftField(local, base, key))) continue;
    if (group.every((key) => sameDraftField(local, server, key))) continue;
    for (const key of group) Object.assign(draft, { [key]: local[key] });
    if (group.some((key) => !sameDraftField(server, base, key))) conflicts.push(...group);
  }
  return { draft, conflicts };
}

export const taskDraftStorageKey = (userId: string, boardId: string, taskId: string) =>
  `tasks.draft.v1.${JSON.stringify([userId, boardId, taskId])}`;

const isStoredTaskDraft = (value: unknown): value is TaskDraft => {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<TaskDraft>;
  return typeof draft.title === 'string' && typeof draft.description === 'string'
    && statuses.includes(draft.status as TaskStatus)
    && typeof draft.projectId === 'string' && typeof draft.assigneeUserId === 'string'
    && Boolean(draft.due && typeof draft.due === 'object'
      && ['none', 'date', 'datetime'].includes(draft.due.mode)
      && typeof draft.due.date === 'string' && typeof draft.due.time === 'string'
      && typeof draft.due.timezone === 'string'
      && (draft.due.originalTimestamp === undefined || draft.due.originalTimestamp === null || typeof draft.due.originalTimestamp === 'string'))
    && Object.keys(priorityDisplayName).includes(draft.priority ?? '')
    && typeof draft.blockerTaskId === 'string' && typeof draft.issueUrl === 'string'
    && typeof draft.waitReason === 'string' && typeof draft.waitCheckAt === 'string';
};

const readTaskDraft = (key: string, base: TaskDraft, serverVersion: string | undefined, enabled: boolean) => {
  const initial = { draft: base, base, serverVersion, restored: false, warning: false, unversioned: false };
  if (!enabled) return initial;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return initial;
    const stored: unknown = JSON.parse(raw);
    if (!stored || typeof stored !== 'object' || (stored as { version?: unknown }).version !== 1
      || !isStoredTaskDraft((stored as { draft?: unknown }).draft)) throw new Error('Invalid saved draft');
    const saved = stored as { draft: TaskDraft; base?: unknown; serverVersion?: unknown };
    const versioned = isStoredTaskDraft(saved.base) && typeof saved.serverVersion === 'string' && /^[1-9]\d*$/.test(saved.serverVersion);
    return { ...initial, draft: { ...saved.draft, notifyAssignee: false },
      base: versioned ? saved.base as TaskDraft : base, serverVersion: versioned ? saved.serverVersion as string : serverVersion,
      restored: true, unversioned: !versioned };
  } catch {
    try { localStorage.removeItem(key); } catch { /* Keep the visible warning if storage is unavailable. */ }
    return { ...initial, warning: true };
  }
};

const writeTaskDraft = (key: string, draft: TaskDraft, base: TaskDraft, serverVersion: string | undefined) => {
  try {
    localStorage.setItem(key, JSON.stringify({ version: 1, draft: { ...draft, notifyAssignee: false }, base, serverVersion }));
    return true;
  } catch { return false; }
};

const clearTaskDraft = (key: string) => {
  try { localStorage.removeItem(key); return true; }
  catch { return false; }
};

export function TaskDetails({ task, userId, collaboration, projects, members, candidateTasks, boardName, onBack, onClaim, onSave, onConfirmed, onArchive, onChecklistAdd, onChecklistUpdate, onChecklistDelete, onComment, onUrlAttachment, onFileAttachment, readOnly = false }: Props) {
  const initialBase = taskDraft(task);
  const localDraftKey = taskDraftStorageKey(userId, task.board_id, task.id);
  const [initialDraft] = useState(() => readTaskDraft(localDraftKey, initialBase, task.version, !readOnly));
  const [draft, setDraft] = useState(initialDraft.draft);
  const baseRef = useRef(initialDraft.base);
  const versionRef = useRef(initialDraft.serverVersion);
  const unversionedRef = useRef(initialDraft.unversioned);
  const [descriptionEditing, setDescriptionEditing] = useState(false);
  const [descriptionFeedback, setDescriptionFeedback] = useState<{ text: string; success: boolean }>();
  const [issueUrlEditing, setIssueUrlEditing] = useState(false);
  const [checklistText, setChecklistText] = useState('');
  const [comment, setComment] = useState('');
  const [attachmentUrl, setAttachmentUrl] = useState('');
  const [showAttachment, setShowAttachment] = useState(false);
  const [lightbox, setLightbox] = useState<{ id: string; name?: string }>();
  const [choice, setChoice] = useState<DetailChoice>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [seriesConfirmation, setSeriesConfirmation] = useState<{ draft: TaskDraft; version: string }>();
  const [seriesWorking, setSeriesWorking] = useState(false);
  const seriesInFlight = useRef(false);
  const [seriesResult, setSeriesResult] = useState<{ text: string; error: boolean }>();
  const [saveState, setSaveState] = useState<SaveState>(initialDraft.restored ? 'pending' : 'idle');
  const [conflict, setConflict] = useState<{ serverTask: Task; fields: (keyof TaskDraft)[] }>();
  const conflictRef = useRef<typeof conflict>(undefined);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [checklistConfirmation, setChecklistConfirmation] = useState<{ count: number; version?: string }>();
  const checklistConfirmationRef = useRef<typeof checklistConfirmation>(undefined);
  const confirmedChecklistVersion = useRef<string | undefined>(undefined);
  const [storageWarning, setStorageWarning] = useState(initialDraft.warning);
  const retryOnReconnect = useRef(true);
  const descriptionEditor = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savable = !readOnly;
  const confirmed = useRef(onConfirmed);
  confirmed.current = onConfirmed;
  const persistDraft = () => setStorageWarning(!writeTaskDraft(localDraftKey, draftRef.current, baseRef.current, unversionedRef.current ? undefined : versionRef.current));
  const preparePatch = (next: TaskDraft, keepDraft = false) => {
    const { patch, errors } = taskPatch(next, baseRef.current);
    // Before acknowledgement, even a revert to the base must survive an in-flight write.
    if (!keepDraft && !Object.keys(errors).length && !Object.keys(patch).length) setStorageWarning(!clearTaskDraft(localDraftKey));
    else persistDraft();
    return patch;
  };
  const replaceDraft = (next: TaskDraft) => { draftRef.current = next; setDraft(next); };
  const acceptServer = (server: Task, next: TaskDraft) => {
    baseRef.current = taskDraft(server);
    versionRef.current = server.version;
    unversionedRef.current = false;
    replaceDraft(next);
    confirmed.current(server);
  };
  const showConflict = (serverTask: Task, fields = mergeTaskDraft(baseRef.current, draftRef.current, taskDraft(serverTask)).conflicts) => {
    conflictRef.current = { serverTask, fields };
    setConflict(conflictRef.current);
    setConflictOpen(true);
    autosave.setPaused(true);
    persistDraft();
    setError('Задачу изменил кто-то другой. Выберите, какую версию сохранить.');
  };
  const sendPatch = useRef<(patch: Record<string, unknown>) => Promise<Task>>(async () => { throw new Error('not ready'); });
  sendPatch.current = async (patch) => {
    // Approval belongs to one attempt against the version shown, never a retry/rebase.
    const confirmChecklist = patch.status === 'done' && versionRef.current !== undefined && confirmedChecklistVersion.current === versionRef.current;
    confirmedChecklistVersion.current = undefined;
    try {
      const saved = await onSave(patch, false, confirmChecklist, versionRef.current);
      retryOnReconnect.current = true;
      return saved;
    } catch (caught) {
      retryOnReconnect.current = !(caught instanceof ApiError && caught.status >= 400 && caught.status < 500);
      throw caught;
    }
  };

  let autosave: Autosave<Record<string, unknown>>;
  autosave = useMemo(() => new Autosave<Record<string, unknown>>({
    key: JSON.stringify([userId, task.board_id, task.id]),
    send: async (patch) => {
      const sentDraft = { ...draftRef.current };
      const { errors } = taskPatch(sentDraft, baseRef.current);
      // A successful partial PATCH acknowledges only valid groups, not invalid input.
      for (const group of draftGroups) if (group.some((key) => errors[key])) {
        for (const key of group) Object.assign(sentDraft, { [key]: baseRef.current[key] });
      }
      try {
        const saved = await sendPatch.current(patch);
        acceptServer(saved, mergeTaskDraft(sentDraft, draftRef.current, taskDraft(saved)).draft);
        setError('');
        autosave.schedule(preparePatch(draftRef.current), 0);
      } catch (caught) {
        if (caught instanceof ApiError && caught.incompleteChecklist !== undefined && patch.status === 'done') {
          setError('');
          if (draftRef.current.status === 'done') {
            checklistConfirmationRef.current = { count: caught.incompleteChecklist, version: versionRef.current };
            setChecklistConfirmation(checklistConfirmationRef.current);
            autosave.setPaused(true);
          }
          autosave.schedule(preparePatch(draftRef.current), 0);
          return;
        }
        setError(caught instanceof Error ? caught.message : 'Ошибка сохранения');
        if (caught instanceof ApiError && caught.status === 409 && caught.data.error === 'version conflict') {
          const server = caught.data.task as Task | undefined;
          if (server?.id === task.id && server.board_id === task.board_id && server.version) {
            const merged = mergeTaskDraft(baseRef.current, draftRef.current, taskDraft(server));
            if (!merged.conflicts.length) {
              acceptServer(server, merged.draft);
              autosave.schedule(preparePatch(merged.draft), 0);
              setError('');
              return;
            }
            showConflict(server, merged.conflicts);
          }
        }
        if (caught instanceof TypeError || (caught instanceof ApiError && caught.status >= 500)) {
          try {
            const current = await api<Task>(`/api/boards/${task.board_id}/tasks/${task.id}`);
            const merged = mergeTaskDraft(baseRef.current, draftRef.current, taskDraft(current));
            if (merged.conflicts.length) {
              showConflict(current, merged.conflicts);
              throw caught;
            }
            acceptServer(current, merged.draft);
            const latest = preparePatch(draftRef.current);
            if (!Object.keys(latest).length) {
              autosave.schedule({}, null);
              setError('');
              return;
            }
            autosave.schedule(latest, null);
          } catch (refreshError) {
            if (refreshError instanceof ApiError && refreshError.status >= 400 && refreshError.status < 500) retryOnReconnect.current = false;
            /* Keep the original save error and queued draft. */
          }
        }
        throw caught;
      }
    },
    onState: setSaveState
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [userId, task.board_id, task.id]);
  useEffect(() => () => autosave.stop(), [autosave]);
  useEffect(() => reconnectRetry(() => { if (savable && retryOnReconnect.current) void autosave.flush().catch(() => undefined); }), [autosave, savable]);
  useEffect(() => {
    if (!initialDraft.restored || !savable) return;
    const merged = mergeTaskDraft(initialDraft.base, initialDraft.draft, initialBase);
    if (merged.conflicts.length || initialDraft.unversioned) {
      const fields = initialDraft.unversioned ? draftGroups.flat().filter((key) => !sameDraftField(initialDraft.draft, initialBase, key)) : merged.conflicts;
      if (fields.length) { showConflict(task, fields); setSaveState('pending'); return; }
    }
    acceptServer(task, merged.draft);
    const patch = preparePatch(draftRef.current);
    if (!Object.keys(patch).length) {
      setSaveState('saved');
      return;
    }
    autosave.schedule(patch);
  }, [autosave, initialDraft, localDraftKey, savable]);
  const scheduleSave = (nextDraft: TaskDraft) => {
    if (!savable) return;
    retryOnReconnect.current = !conflictRef.current && !checklistConfirmationRef.current;
    if (conflictRef.current && !unversionedRef.current) {
      conflictRef.current = { ...conflictRef.current, fields: mergeTaskDraft(baseRef.current, nextDraft, taskDraft(conflictRef.current.serverTask)).conflicts };
      setConflict(conflictRef.current);
    }
    autosave.schedule(preparePatch(nextDraft, true));
  };
  const flushNow = async () => {
    if (!savable || conflictRef.current || checklistConfirmationRef.current) return;
    autosave.schedule(preparePatch(draftRef.current, true), 0);
    await autosave.flush();
  };
  const openSeriesConfirmation = async () => {
    if (!savable || !task.recurrence_template_id || seriesInFlight.current || seriesConfirmation) return;
    seriesInFlight.current = true;
    setSeriesWorking(true);
    setSeriesResult(undefined);
    try {
      await flushNow();
      const { patch, errors } = taskPatch(draftRef.current, baseRef.current);
      if (Object.keys(patch).length || Object.keys(errors).length || conflictRef.current || checklistConfirmationRef.current || !versionRef.current) {
        setSeriesResult({ text: 'Сначала сохраните правки задачи и разрешите ошибки или конфликт.', error: true });
        return;
      }
      autosave.setPaused(true);
      setSeriesConfirmation({ draft: baseRef.current, version: versionRef.current });
    } finally { seriesInFlight.current = false; setSeriesWorking(false); }
  };
  const closeSeriesConfirmation = () => {
    if (seriesInFlight.current) return;
    setSeriesConfirmation(undefined);
    autosave.setPaused(Boolean(conflictRef.current || checklistConfirmationRef.current));
  };
  const applyToFuture = async () => {
    if (!savable || !seriesConfirmation || seriesInFlight.current) return;
    seriesInFlight.current = true;
    setSeriesWorking(true);
    const sent = seriesConfirmation.draft;
    try {
      const saved = await onSave({ title: sent.title, description: sent.description || null, projectId: sent.projectId || null,
        assigneeUserId: sent.assigneeUserId || null, priority: sent.priority }, true, false, seriesConfirmation.version);
      acceptServer(saved, mergeTaskDraft(sent, draftRef.current, taskDraft(saved)).draft);
      setSeriesResult({ text: 'Применено к будущим повторам', error: false });
    } catch (caught) {
      // A task reread can recover its revision, but never proves that the template was saved.
      setSeriesResult({ text: `Применение к будущим повторам не подтверждено. ${caught instanceof Error ? caught.message : 'Ошибка'}. Проверьте значения и повторите действие.`, error: true });
      try {
        const current = caught instanceof ApiError && caught.status === 409 ? caught.data.task as Task | undefined
          : await api<Task>(`/api/boards/${task.board_id}/tasks/${task.id}`);
        if (current?.id === task.id && current.board_id === task.board_id && current.version) {
          const merged = mergeTaskDraft(baseRef.current, draftRef.current, taskDraft(current));
          if (merged.conflicts.length) showConflict(current, merged.conflicts);
          else acceptServer(current, merged.draft);
        }
      } catch { /* Keep the explicit unknown result. No automatic series replay. */ }
    } finally {
      seriesInFlight.current = false;
      setSeriesWorking(false);
      setSeriesConfirmation(undefined);
      autosave.schedule(preparePatch(draftRef.current), null);
      autosave.setPaused(Boolean(conflictRef.current || checklistConfirmationRef.current));
    }
  };
  useLayoutEffect(() => {
    const editor = descriptionEditor.current;
    if (!editor) return;
    editor.style.height = 'auto';
    editor.style.height = `${editor.scrollHeight}px`;
  }, [descriptionEditing, draft.description]);
  useLayoutEffect(() => {
    if (!descriptionEditing) return;
    const editor = descriptionEditor.current;
    if (!editor) return;
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }, [descriptionEditing]);
  const set = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => {
    setSeriesResult((result) => result?.error ? result : undefined);
    const next = { ...draftRef.current, [key]: value };
    // Update the ref synchronously: a flush triggered right after (blur, «Готово»,
    // «Удалить») must read the new value, not the pre-render snapshot (issue #129).
    draftRef.current = next;
    setDraft(next);
    scheduleSave(next);
  };
  const run = async (action: () => Promise<void>, clear?: () => void) => {
    if (readOnly) return;
    setBusy(true); setError('');
    try { await action(); clear?.(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Ошибка'); }
    finally { setBusy(false); }
  };
  // Leaving the card must not lose the last edit: flush, then close (issue #129).
  const leave = () => { void flushNow().finally(() => { if (!checklistConfirmationRef.current) onBack(); }); };
  const copyDescription = async () => {
    if (!draft.description.trim()) return;
    setDescriptionFeedback(undefined);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(draft.description);
      setDescriptionFeedback({ text: 'Описание скопировано', success: true });
    } catch {
      setDescriptionFeedback({ text: 'Не удалось скопировать. Выделите текст и скопируйте вручную.', success: false });
    }
  };
  const completed = collaboration.checklist.filter((item) => item.completed_at).length;
  const choiceDefinitions = {
    status: { title: 'Статус', current: draft.status, options: statuses.map((value) => ({ value, label: statusDisplayName[value] })) },
    project: { title: 'Проект', current: draft.projectId, options: [{ value: '', label: 'Без проекта' }, ...projects.filter((item) => !item.archived_at).map((item) => ({ value: item.id, label: item.name }))] },
    assignee: { title: 'Исполнитель', current: draft.assigneeUserId, options: [{ value: '', label: 'Без ответственного' }, ...members.map((item) => ({ value: item.id, label: item.first_name }))] },
    priority: { title: 'Приоритет', current: draft.priority, options: Object.entries(priorityDisplayName).map(([value, label]) => ({ value, label })) },
    blocker: { title: 'Задача-блокер', current: draft.blockerTaskId, options: [{ value: '', label: 'Внешняя причина' }, ...candidateTasks.map((item) => ({ value: item.id, label: item.title }))] }
  } satisfies Record<DetailChoice, { title: string; current: string; options: { value: string; label: string; restriction?: string | null }[] }>;
  const issueUrl = draft.issueUrl.trim();
  const issueHref = githubIssueHref(issueUrl);
  const fieldErrors = taskPatch(draft, baseRef.current).errors;
  const displayedSaveState = checklistConfirmation || (saveState === 'saved' && (Object.keys(fieldErrors).length || conflict)) ? 'pending' : saveState;
  const conflictLabels: Partial<Record<keyof TaskDraft, string>> = {
    title: 'Название', description: 'Описание', status: 'Статус', projectId: 'Проект', assigneeUserId: 'Исполнитель',
    due: 'Срок', priority: 'Приоритет', blockerTaskId: 'Задача-блокер', issueUrl: 'GitHub issue', waitReason: 'Внешняя причина', waitCheckAt: 'Дата проверки'
  };
  const conflictValue = (value: TaskDraft, key: keyof TaskDraft) => {
    if (key === 'status') return statusDisplayName[value.status];
    if (key === 'priority') return priorityDisplayName[value.priority];
    if (key === 'projectId') return projects.find((item) => item.id === value.projectId)?.name ?? (value.projectId || 'Без проекта');
    if (key === 'assigneeUserId') return members.find((item) => item.id === value.assigneeUserId)?.first_name ?? (value.assigneeUserId || 'Без ответственного');
    if (key === 'blockerTaskId') return candidateTasks.find((item) => item.id === value.blockerTaskId)?.title ?? (value.blockerTaskId || 'Не задана');
    if (key === 'due') return value.due.mode === 'none' ? 'Без срока' : `${value.due.date} ${value.due.mode === 'datetime' ? value.due.time : 'весь день'} (${value.due.timezone})`;
    return String(value[key] || 'Не задано');
  };
  const choiceSheet = choice && (() => {
    const definition = choiceDefinitions[choice];
    const choose = (value: string) => {
      if (choice === 'status') set('status', value as TaskStatus);
      else if (choice === 'priority') set('priority', value as TaskPriority);
      else if (choice === 'project') set('projectId', value);
      else if (choice === 'assignee') set('assigneeUserId', value);
      else set('blockerTaskId', value);
      setChoice(undefined);
    };
    return <Sheet className="task-sheet detail-choice-sheet" title={definition.title} onClose={() => setChoice(undefined)}><div className="choice-list" role="radiogroup">{definition.options.map((option) => <ChoiceRow key={option.value} label={option.label} selected={definition.current === option.value} onClick={() => choose(option.value)}/>)}</div><button className="sheet-close secondary" type="button" onClick={() => setChoice(undefined)}>Закрыть</button></Sheet>;
  })();

  return <main className={`task-details${descriptionEditing ? ' detail-description-editing' : ''}`}>
    <EnvironmentStatus/>
    <h1 className="visually-hidden">Детали задачи</h1>
    <header className="task-details-bar"><button className="detail-icon" aria-label="Назад к задачам" onClick={leave}><Icon name="back"/></button><span><i/> {boardName}</span><div className="detail-menu-wrap"><button className="detail-icon" aria-label="Другие действия" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><Icon name="more"/></button>{menuOpen && <div className="detail-menu">{task.recurrence_template_id && <p>Повторяющаяся задача</p>}{savable && task.recurrence_template_id && <button type="button" disabled={busy} aria-disabled={seriesWorking} onClick={() => void openSeriesConfirmation()}>Применить к будущим повторам</button>}<button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen((value) => !value)}>История <Icon name="chevron"/></button>{historyOpen && <div className="detail-history">{collaboration.timeline.map((item) => <p key={item.id}>{item.actor_name} · {item.action}<small>{new Date(item.created_at).toLocaleString('ru-RU')}</small></p>)}</div>}<div className="detail-danger-zone"><button type="button" className="danger" disabled={busy || readOnly} onClick={() => { void flushNow(); void run(onArchive); }}>Архивировать задачу</button></div></div>}</div></header>

    {readOnly && <p className="notice">Доска доступна только для чтения.</p>}
    {savable && <p className="detail-save-state" role="status" data-state={displayedSaveState}>{saveStateLabels[displayedSaveState]}</p>}
    {seriesResult && <p className={`detail-series-result ${seriesResult.error ? 'detail-error' : 'notice'}`} role={seriesResult.error ? 'alert' : 'status'}>{seriesResult.text}</p>}
    {storageWarning && <p className="detail-error" role="alert">Локальная копия недоступна или повреждена: несохранённые правки могут потеряться при закрытии приложения.</p>}
    <form onSubmit={(event) => event.preventDefault()}>
      <fieldset className="readonly-fields detail-surface" disabled={readOnly}>
        <div className="detail-heading"><div className="detail-title"><textarea aria-label="Название задачи" aria-invalid={Boolean(fieldErrors.title)} aria-describedby={fieldErrors.title ? 'detail-title-error' : undefined} maxLength={200} value={draft.title} onChange={(event) => set('title', event.target.value)} onBlur={() => void flushNow()}/>{fieldErrors.title && <p id="detail-title-error" className="detail-error" role="alert">{fieldErrors.title}</p>}</div>
        <div className="detail-status"><button type="button" className="detail-status-action" onClick={() => setChoice('status')}><span className="status-dot"/>{statusDisplayName[draft.status]}<Icon name="chevron"/></button>{collaboration.checklist.length > 0 && <span className="detail-progress"><span>{completed} из {collaboration.checklist.length} шагов</span><i aria-hidden="true"><i style={{ width: `${completed / collaboration.checklist.length * 100}%` }}/></i></span>}</div>
        </div><div className="detail-property-grid">
          <ActionRow label="Проект" value={projects.find((item) => item.id === draft.projectId)?.name ?? 'Без проекта'} onClick={() => setChoice('project')}/>
          <ActionRow label="Исполнитель" value={members.find((item) => item.id === draft.assigneeUserId)?.first_name ?? 'Без ответственного'} onClick={() => setChoice('assignee')}/>
          <DeadlineField value={draft.due} onChange={(value) => set('due', value)} showIcon={false}/>
          <ActionRow label="Приоритет" value={priorityDisplayName[draft.priority]} onClick={() => setChoice('priority')}/>
        </div>
        {fieldErrors.due && <p className="detail-error" role="alert">{fieldErrors.due}</p>}
        <div className="detail-github">
          {issueUrlEditing ? <>
            <label><span>Ссылка на GitHub issue</span><input aria-invalid={Boolean(fieldErrors.issueUrl)} aria-describedby={fieldErrors.issueUrl ? 'detail-issue-error' : undefined} maxLength={500} inputMode="url" placeholder="owner/repo#123 или https://github.com/owner/repo/issues/123" value={draft.issueUrl} onChange={(event) => set('issueUrl', event.target.value)}/></label>
            <button type="button" className="detail-github-action" onClick={() => { setIssueUrlEditing(false); void flushNow(); }}>Готово</button>
            {issueUrl && <button type="button" className="detail-github-action" onClick={() => { setIssueUrlEditing(false); set('issueUrl', ''); void flushNow(); }}>Удалить</button>}
          </> : issueUrl ? <>
            <span className="detail-github-label">GitHub issue</span>
            {issueHref ? <a className="detail-github-link" href={issueHref} target="_blank" rel="noopener noreferrer">{issueUrlShort(issueUrl)}<span>Открыть<Icon name="external"/></span></a> : <span className="detail-github-value">{issueUrlShort(issueUrl)}</span>}
            {!readOnly && <button type="button" className="detail-github-action" onClick={() => setIssueUrlEditing(true)}>Изменить</button>}
          </> : !readOnly && <button type="button" className="detail-github-action" onClick={() => setIssueUrlEditing(true)}>Добавить GitHub issue</button>}
          {fieldErrors.issueUrl && <p id="detail-issue-error" className="detail-error" role="alert">{fieldErrors.issueUrl}</p>}
        </div>
        {draft.status === 'waiting' && <div className="blocker-fields">
          <ActionRow label="Задача-блокер" value={candidateTasks.find((item) => item.id === draft.blockerTaskId)?.title ?? 'Внешняя причина'} onClick={() => setChoice('blocker')}/>
          {!draft.blockerTaskId && <label>Внешняя причина<input aria-invalid={Boolean(fieldErrors.waitReason)} aria-describedby={fieldErrors.waitReason ? 'detail-reason-error' : undefined} maxLength={1000} value={draft.waitReason} onChange={(event) => set('waitReason', event.target.value)}/></label>}
          {fieldErrors.waitReason && <p id="detail-reason-error" className="detail-error" role="alert">{fieldErrors.waitReason}</p>}
          <label>Дата проверки<input type="date" aria-invalid={Boolean(fieldErrors.waitCheckAt)} aria-describedby={fieldErrors.waitCheckAt ? 'detail-check-error' : undefined} value={draft.waitCheckAt} onChange={(event) => set('waitCheckAt', event.target.value)}/></label>
          {fieldErrors.waitCheckAt && <p id="detail-check-error" className="detail-error" role="alert">{fieldErrors.waitCheckAt}</p>}
        </div>}
        {draft.assigneeUserId && draft.assigneeUserId !== task.assignee_user_id && <label className="checkbox"><input type="checkbox" checked={draft.notifyAssignee} onChange={(event) => set('notifyAssignee', event.target.checked)}/> Уведомить нового исполнителя</label>}
      </fieldset>

      <section className="detail-section detail-description-section" data-tone="content">
        <div className="detail-description-header"><h2>Описание</h2><div className="detail-description-actions">
          <button type="button" disabled={!draft.description.trim()} onClick={() => void copyDescription()}><Icon name="copy"/>Скопировать</button>
          {!readOnly && <button type="button" onClick={() => { setDescriptionFeedback(undefined); setDescriptionEditing((value) => !value); if (descriptionEditing) void flushNow(); }}><Icon name="edit"/>{descriptionEditing ? 'Готово' : draft.description.trim() ? 'Изменить' : 'Добавить описание'}</button>}
        </div></div>
        {descriptionFeedback && <p className={`detail-copy-feedback${descriptionFeedback.success ? ' success' : ''}`} role={descriptionFeedback.success ? 'status' : 'alert'}>{descriptionFeedback.text}</p>}
        {descriptionEditing && !readOnly
          ? <textarea ref={descriptionEditor} className="detail-description-editor" aria-label="Описание" placeholder="Добавить описание" value={draft.description} onChange={(event) => { set('description', event.target.value); setDescriptionFeedback(undefined); }}/>
          : draft.description.trim() ? <p className="detail-description-read">{draft.description}</p> : <p className="detail-description-empty">Описание не добавлено</p>}
      </section>

      <section className="detail-section detail-checklist-section" data-tone="content">
        <div className="detail-checklist-heading"><h2>Чек-лист</h2>{collaboration.checklist.length > 0 && <span>{completed}/{collaboration.checklist.length}</span>}</div>
        <fieldset className="readonly-fields detail-checklist-fields" disabled={readOnly}>
          <div className="detail-checklist">{collaboration.checklist.map((item) => <div key={item.id}><label className="detail-check-toggle"><input type="checkbox" checked={Boolean(item.completed_at)} aria-label={`Завершить ${item.text}`} onChange={() => void run(() => onChecklistUpdate(item.id, { completed: !item.completed_at }))}/></label><input defaultValue={item.text} aria-label="Текст пункта" onBlur={(event) => { const text = event.target.value.trim(); if (text && text !== item.text) void run(() => onChecklistUpdate(item.id, { text })); else event.target.value = item.text; }}/><button type="button" className="detail-remove" aria-label={`Удалить ${item.text}`} onClick={() => void run(() => onChecklistDelete(item.id))}>×</button></div>)}</div>
          <div className="detail-add"><input aria-label="Новый пункт чек-листа" maxLength={500} value={checklistText} onChange={(event) => setChecklistText(event.target.value)} placeholder="Новый пункт"/><button type="button" disabled={busy || !checklistText.trim()} onClick={() => void run(() => onChecklistAdd(checklistText.trim()), () => setChecklistText(''))}>Добавить</button></div>
        </fieldset>
      </section>
      {onClaim && <button className="detail-save" type="button" disabled={busy || readOnly} onClick={onClaim}>Взять себе</button>}
    </form>

    <section className="detail-section detail-discussion" data-tone="discussion"><h2>Обсуждение</h2>{collaboration.comments.map((item) => <article key={item.id}><Avatar initials={item.author_name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toLocaleUpperCase('ru-RU')} label={item.author_name}/><div><small>{item.author_name} · {new Date(item.created_at).toLocaleString('ru-RU')}</small><p>{item.body}</p></div></article>)}{collaboration.attachments.map((item) => item.kind === 'file' ? <button type="button" className="detail-attachment detail-attachment-image" key={item.id} onClick={() => setLightbox({ id: item.id, name: item.file_name })}><img src={`/api/boards/${task.board_id}/tasks/${task.id}/attachments/${item.id}/file`} alt={item.file_name ?? 'Изображение'} loading="lazy"/></button> : <p className="detail-attachment" key={item.id}>{item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.url}</a> : item.file_name ?? 'Файл из Telegram'}</p>)}
      {showAttachment && !readOnly && <div className="detail-add"><input aria-label="Ссылка" type="url" value={attachmentUrl} onChange={(event) => setAttachmentUrl(event.target.value)} placeholder="https://…"/><button disabled={busy || !attachmentUrl.trim()} onClick={() => void run(() => onUrlAttachment(attachmentUrl.trim()), () => { setAttachmentUrl(''); setShowAttachment(false); })}>Добавить</button></div>}
    </section>
    {error && <p className="detail-error" role="alert">{error}</p>}
    {conflict && !conflictOpen && !readOnly && <button type="button" onClick={() => setConflictOpen(true)}>Разрешить конфликт</button>}
    {!readOnly && <div className="comment-composer"><input aria-label="Комментарий" maxLength={4000} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Написать комментарий…"/><button className="attach" aria-label="Добавить ссылку" onClick={() => setShowAttachment((value) => !value)}><Icon name="attach"/></button><label className="attach attach-image" aria-label="Прикрепить изображение"><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void run(() => onFileAttachment(file), () => { event.target.value = ''; }); }}/><Icon name="image"/></label><button disabled={busy || !comment.trim()} aria-label="Отправить комментарий" onClick={() => void run(() => onComment(comment.trim()), () => setComment(''))}><Icon name="send"/></button></div>}
    {!readOnly && choiceSheet}
    {seriesConfirmation && !readOnly && <Sheet className="task-sheet" title="Будущие повторы" onClose={closeSeriesConfirmation}>
      <p tabIndex={0}>В шаблон будут перенесены эти значения. Статус, блокер, срок и уже созданные задачи не изменятся.</p>
      {(['title', 'description', 'projectId', 'assigneeUserId', 'priority'] as const).map((key) => <section className="detail-conflict-values" key={key}>
        <h3>{conflictLabels[key]}</h3><dl><dd>{conflictValue(seriesConfirmation.draft, key)}</dd></dl>
      </section>)}
      {seriesWorking && <p role="status">Применяется…</p>}
      <div className="choice-list">
        <button type="button" className="secondary" disabled={seriesWorking} onClick={closeSeriesConfirmation}>Отмена</button>
        <button type="button" disabled={seriesWorking} onClick={() => void applyToFuture()}>Применить</button>
      </div>
    </Sheet>}
    {checklistConfirmation && !readOnly && <Sheet className="task-sheet" title="Завершить задачу?" onClose={() => resolveChecklist(false)}>
      <p>Незавершённых пунктов: {checklistConfirmation.count}. Завершить задачу, не отмечая эти пункты выполненными?</p>
      <div className="choice-list">
        <button type="button" className="secondary" onClick={() => resolveChecklist(false)}>Отмена</button>
        <button type="button" onClick={() => resolveChecklist(true)}>Завершить</button>
      </div>
    </Sheet>}
    {conflict && conflictOpen && !readOnly && <Sheet className="task-sheet detail-conflict-sheet" title="Конфликт изменений" onClose={() => setConflictOpen(false)}>
      <p>Выберите значения конфликтующих полей. Независимые правки сохранятся.</p>
      {conflict.fields.filter((key) => !sameDraftField(draft, taskDraft(conflict.serverTask), key)).map((key) => <section className="detail-conflict-values" key={key} aria-label={conflictLabels[key]}>
        <h3>{conflictLabels[key]}</h3><dl><dt>Моя правка</dt><dd>{conflictValue(draft, key)}</dd><dt>На сервере</dt><dd>{conflictValue(taskDraft(conflict.serverTask), key)}</dd></dl>
      </section>)}
      <div className="choice-list">
        <button type="button" onClick={() => resolveConflict(true)}>Моя правка поверх серверной</button>
        <button type="button" className="secondary" onClick={() => resolveConflict(false)}>Оставить серверную версию</button>
      </div>
      <button className="sheet-close secondary" onClick={() => setConflictOpen(false)}>Решить позже</button>
    </Sheet>}
    {lightbox && <div className="lightbox" role="dialog" aria-modal="true" aria-label={lightbox.name ?? 'Просмотр изображения'} onClick={(event) => { if (event.target === event.currentTarget) setLightbox(undefined); }}><button type="button" className="lightbox-close" aria-label="Закрыть просмотр" onClick={() => setLightbox(undefined)}><Icon name="close"/></button><img src={`/api/boards/${task.board_id}/tasks/${task.id}/attachments/${lightbox.id}/file`} alt={lightbox.name ?? 'Изображение'}/></div>}
  </main>;

  function resolveChecklist(complete: boolean) {
    const pending = checklistConfirmationRef.current;
    if (!pending || !savable) return;
    if (complete) confirmedChecklistVersion.current = pending.version;
    else {
      // Decline only the completion group; keep independent and invalid local edits.
      const { status, blockerTaskId, waitReason, waitCheckAt } = baseRef.current;
      replaceDraft({ ...draftRef.current, status, blockerTaskId, waitReason, waitCheckAt });
    }
    checklistConfirmationRef.current = undefined;
    setChecklistConfirmation(undefined);
    setError('');
    autosave.schedule(preparePatch(draftRef.current), null);
    autosave.setPaused(false);
    void autosave.flush();
  }

  function resolveConflict(keepLocal: boolean) {
    const pending = conflictRef.current;
    if (!pending || !savable) return;
    const server = taskDraft(pending.serverTask);
    const next = mergeTaskDraft(baseRef.current, draftRef.current, server).draft;
    if (!keepLocal) for (const key of pending.fields) Object.assign(next, { [key]: server[key] });
    acceptServer(pending.serverTask, next);
    conflictRef.current = undefined;
    setConflict(undefined);
    setConflictOpen(false);
    setError('');
    retryOnReconnect.current = true;
    const patch = preparePatch(next);
    autosave.schedule(patch, null);
    autosave.setPaused(false);
    if (!Object.keys(patch).length) {
      setSaveState('saved');
    } else {
      persistDraft();
      setSaveState('pending');
      void autosave.flush();
    }
  }
}
