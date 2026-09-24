import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from './api';
import { ActionRow, Avatar, ChoiceRow, EnvironmentStatus, Icon, Sheet, TaskGlyph } from './app-shell';
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
  future: boolean;
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
    future: false,
    notifyAssignee: false
  };
}

// Build a minimal patch: only fields that actually changed against `base` (issue #129).
// Unrelated fields of other collaborators survive; sending no diff yields an empty patch.
export function taskPatch(draft: TaskDraft, base: TaskDraft) {
  if (!draft.title.trim()) throw new Error('Название задачи обязательно');
  const deadline = deadlinePatch(draft.due);
  const waitCheckAt = draft.waitCheckAt ? dateInputToIso(draft.waitCheckAt) : null;
  if (draft.waitCheckAt && !waitCheckAt) throw new Error('Укажите корректную дату проверки');
  if (draft.status === 'waiting' && !draft.blockerTaskId && !draft.waitReason.trim()) throw new Error('Укажите задачу-блокер или внешнюю причину');
  const issueUrl = draft.issueUrl.trim() || null;
  if (issueUrl && !/^(https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*)$/.test(issueUrl)) throw new Error('Ссылка на issue: https://github.com/owner/repo/issues/N или owner/repo#N');
  const patch: Record<string, unknown> = {};
  if (draft.title.trim() !== base.title.trim()) patch.title = draft.title.trim();
  if (draft.description !== base.description) patch.description = draft.description.trim() ? draft.description : null;
  if (draft.status !== base.status) patch.status = draft.status;
  if (draft.priority !== base.priority) patch.priority = draft.priority;
  if (draft.projectId !== base.projectId) patch.projectId = draft.projectId || null;
  if (draft.assigneeUserId !== base.assigneeUserId) {
    patch.assigneeUserId = draft.assigneeUserId || null;
    // Notification is chosen once for this assignment, not replayed by later autosaves (issue #129).
    patch.notifyAssignee = draft.notifyAssignee;
  }
  if (draft.due.mode !== base.due.mode || draft.due.date !== base.due.date || draft.due.time !== base.due.time) {
    patch.deadline = deadline.deadline;
    patch.deadlineDate = deadline.deadlineDate;
    patch.deadlineTimezone = deadline.deadlineTimezone;
  }
  if (draft.issueUrl.trim() !== base.issueUrl.trim() && issueUrl !== base.issueUrl.trim()) patch.issueUrl = issueUrl;
  // Blocker group edits as one consistent unit (waiting + reason/blocker + check date).
  if (draft.status === 'waiting' && (draft.blockerTaskId !== base.blockerTaskId || draft.waitReason !== base.waitReason || draft.waitCheckAt !== base.waitCheckAt)) {
    patch.blockerTaskId = draft.blockerTaskId || null;
    patch.waitReason = draft.blockerTaskId ? null : draft.waitReason.trim();
    patch.waitCheckAt = waitCheckAt;
  }
  // Leaving waiting clears the group on the server but only when the status change itself is in flight.
  if (draft.status !== base.status && base.status === 'waiting') {
    patch.blockerTaskId = null;
    patch.waitReason = null;
    patch.waitCheckAt = null;
  }
  return patch;
}

type Props = {
  task: Task;
  readOnly?: boolean;
  collaboration: Collaboration;
  projects: Project[];
  members: Member[];
  candidateTasks: Task[];
  boardName: string;
  onBack: () => void;
  onClaim?: () => void;
  onSave: (patch: Record<string, unknown>, future: boolean, confirmIncompleteChecklist?: boolean) => Promise<Task>;
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

// An incomplete field (empty title, half-typed link) stays a local draft: the invalid
// diff is simply not scheduled and the last saved value is untouched (issue #129).
const safePatch = (draft: TaskDraft, base: TaskDraft): Record<string, unknown> => {
  try { return taskPatch(draft, base); }
  catch { return {}; }
};

export function TaskDetails({ task, collaboration, projects, members, candidateTasks, boardName, onBack, onClaim, onSave, onArchive, onChecklistAdd, onChecklistUpdate, onChecklistDelete, onComment, onUrlAttachment, onFileAttachment, readOnly = false }: Props) {
  const [draft, setDraft] = useState(() => taskDraft(task));
  const baseDraft = useMemo(() => taskDraft(task), [task]);
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
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [conflict, setConflict] = useState<{ serverTask: Task; localPatch: Record<string, unknown> }>();
  const [storageWarning, setStorageWarning] = useState(false);
  const descriptionEditor = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const baseRef = useRef(baseDraft);
  baseRef.current = baseDraft;
  const savable = !readOnly;
  const sendPatch = useRef<(patch: Record<string, unknown>) => Promise<void>>(async () => { throw new Error('not ready'); });
  sendPatch.current = async (patch) => {
    await onSave(patch, draftRef.current.future, false);
  };
  const handleSaveError = (caught: unknown, patch: Record<string, unknown>) => {
    if (caught instanceof ApiError && caught.status === 409) {
      const data = caught.data as { task?: Task };
      if (data?.task) setConflict({ serverTask: data.task, localPatch: patch });
      setError('Задачу изменил кто-то другой. Выберите, какую версию сохранить.');
    } else setError(caught instanceof Error ? caught.message : 'Ошибка сохранения');
  };
  const autosave = useMemo(() => new Autosave<Record<string, unknown>>({
    key: `task.${task.id}`,
    send: async (patch) => {
      try { await sendPatch.current(patch); }
      catch (caught) { handleSaveError(caught, patch); throw caught; }
    },
    onState: setSaveState
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [task.id]);
  useEffect(() => () => autosave.stop(), [autosave]);
  useEffect(() => reconnectRetry(() => { if (savable) void autosave.flush().catch(() => undefined); }), [autosave, savable]);
  const dirty = useMemo(() => Object.keys(safePatch(draft, baseDraft)).length > 0, [draft, baseDraft]);
  const scheduleSave = (nextDraft: TaskDraft) => {
    if (!savable) return;
    const patch = safePatch(nextDraft, baseDraft);
    if (Object.keys(patch).length) autosave.schedule(patch);
  };
  const flushNow = async () => {
    if (!savable) return;
    const patch = safePatch(draftRef.current, baseRef.current);
    if (Object.keys(patch).length) autosave.schedule(patch, 0);
    await autosave.flush();
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
  const leave = () => { void flushNow().finally(onBack); };
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
    <header className="task-details-bar"><button className="detail-icon" aria-label="Назад к задачам" onClick={leave}><Icon name="back"/></button><span><i/> {boardName}</span><div className="detail-menu-wrap"><button className="detail-icon" aria-label="Другие действия" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><Icon name="more"/></button>{menuOpen && <div className="detail-menu">{task.recurrence_template_id && <p>Повторяющаяся задача</p>}{savable && <label className="checkbox"><input type="checkbox" checked={draft.future} onChange={(event) => set('future', event.target.checked)}/> Изменить этот и будущие повторы</label>}<button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen((value) => !value)}>История <Icon name="chevron"/></button>{historyOpen && <div className="detail-history">{collaboration.timeline.map((item) => <p key={item.id}>{item.actor_name} · {item.action}<small>{new Date(item.created_at).toLocaleString('ru-RU')}</small></p>)}</div>}<div className="detail-danger-zone"><button type="button" className="danger" disabled={busy || readOnly} onClick={() => { void flushNow(); void run(onArchive); }}>Архивировать задачу</button></div></div>}</div></header>

    {readOnly && <p className="notice">Доска доступна только для чтения.</p>}
    {savable && <p className="detail-save-state" role="status" data-state={saveState}>{saveStateLabels[saveState]}</p>}
    {storageWarning && <p className="detail-error" role="alert">Локальное хранилище недоступно: при закрытии приложения несохранённые правки будут потеряны.</p>}
    <form onSubmit={(event) => event.preventDefault()}>
      <fieldset className="readonly-fields" disabled={readOnly}>
        <div className="detail-title"><textarea aria-label="Название задачи" maxLength={200} value={draft.title} onChange={(event) => set('title', event.target.value)} onBlur={() => void flushNow()}/><TaskGlyph/></div>
        <div className="detail-status"><button type="button" className="detail-status-action" onClick={() => setChoice('status')}><span className="status-dot"/>{statusDisplayName[draft.status]}<Icon name="chevron"/></button>{collaboration.checklist.length > 0 && <span className="detail-progress"><i><i style={{ width: `${completed / collaboration.checklist.length * 100}%` }}/></i>{completed} из {collaboration.checklist.length} шагов</span>}</div>
        <div className="detail-property-grid">
          <ActionRow label="Проект" value={projects.find((item) => item.id === draft.projectId)?.name ?? 'Без проекта'} onClick={() => setChoice('project')}/>
          <ActionRow label="Исполнитель" value={members.find((item) => item.id === draft.assigneeUserId)?.first_name ?? 'Без ответственного'} onClick={() => setChoice('assignee')}/>
          <DeadlineField value={draft.due} onChange={(value) => set('due', value)} showIcon={false}/>
          <ActionRow label="Приоритет" value={priorityDisplayName[draft.priority]} onClick={() => setChoice('priority')}/>
        </div>
        <div className="detail-github">
          {issueUrlEditing ? <>
            <label><span>Ссылка на GitHub issue</span><input maxLength={500} inputMode="url" placeholder="owner/repo#123 или https://github.com/owner/repo/issues/123" value={draft.issueUrl} onChange={(event) => set('issueUrl', event.target.value)}/></label>
            <button type="button" className="detail-github-action" onClick={() => { setIssueUrlEditing(false); void flushNow(); }}>Готово</button>
            {issueUrl && <button type="button" className="detail-github-action" onClick={() => { setIssueUrlEditing(false); set('issueUrl', ''); void flushNow(); }}>Удалить</button>}
          </> : issueUrl ? <>
            <span className="detail-github-label">GitHub issue</span>
            {issueHref ? <a className="detail-github-link" href={issueHref} target="_blank" rel="noopener noreferrer">{issueUrlShort(issueUrl)}<span>Открыть<Icon name="external"/></span></a> : <span className="detail-github-value">{issueUrlShort(issueUrl)}</span>}
            {!readOnly && <button type="button" className="detail-github-action" onClick={() => setIssueUrlEditing(true)}>Изменить</button>}
          </> : !readOnly && <button type="button" className="detail-github-action" onClick={() => setIssueUrlEditing(true)}>Добавить GitHub issue</button>}
        </div>
        {draft.status === 'waiting' && <div className="blocker-fields"><ActionRow label="Задача-блокер" value={candidateTasks.find((item) => item.id === draft.blockerTaskId)?.title ?? 'Внешняя причина'} onClick={() => setChoice('blocker')}/>{!draft.blockerTaskId && <label>Внешняя причина<input maxLength={1000} value={draft.waitReason} onChange={(event) => set('waitReason', event.target.value)}/></label>}<label>Дата проверки<input type="date" value={draft.waitCheckAt} onChange={(event) => set('waitCheckAt', event.target.value)}/></label></div>}
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
    {!readOnly && <div className="comment-composer"><input aria-label="Комментарий" maxLength={4000} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Написать комментарий…"/><button className="attach" aria-label="Добавить ссылку" onClick={() => setShowAttachment((value) => !value)}><Icon name="attach"/></button><label className="attach attach-image" aria-label="Прикрепить изображение"><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void run(() => onFileAttachment(file), () => { event.target.value = ''; }); }}/><Icon name="image"/></label><button disabled={busy || !comment.trim()} aria-label="Отправить комментарий" onClick={() => void run(() => onComment(comment.trim()), () => setComment(''))}><Icon name="send"/></button></div>}
    {!readOnly && choiceSheet}
    {conflict && <Sheet className="task-sheet detail-conflict-sheet" title="Конфликт изменений" onClose={() => setConflict(undefined)}>
      <p>Задачу изменил кто-то другой, пока вы редактировали поле «{conflict.localPatch && Object.keys(conflict.localPatch).length ? 'текущие поля' : 'задачу'}». Выберите версию:</p>
      <div className="choice-list" role="radiogroup">
        <ChoiceRow label="Моя правка поверх серверной" selected={false} onClick={() => { setConflict(undefined); void sendResolution(conflict.localPatch, conflict.serverTask); }}/>
        <ChoiceRow label="Оставить серверную версию" selected={false} onClick={() => { setConflict(undefined); setDraft(taskDraft(conflict.serverTask)); baseRef.current = taskDraft(conflict.serverTask); setSaveState('saved'); }}/>
      </div>
      <button className="sheet-close secondary" onClick={() => setConflict(undefined)}>Решить позже</button>
    </Sheet>}
    {lightbox && <div className="lightbox" role="dialog" aria-modal="true" aria-label={lightbox.name ?? 'Просмотр изображения'} onClick={(event) => { if (event.target === event.currentTarget) setLightbox(undefined); }}><button type="button" className="lightbox-close" aria-label="Закрыть просмотр" onClick={() => setLightbox(undefined)}><Icon name="close"/></button><img src={`/api/boards/${task.board_id}/tasks/${task.id}/attachments/${lightbox.id}/file`} alt={lightbox.name ?? 'Изображение'}/></div>}
  </main>;

  async function sendResolution(localPatch: Record<string, unknown>, serverTask: Task) {
    setSaveState('saving');
    try {
      const saved = await onSave(localPatch, draftRef.current.future, false);
      const nextBase = taskDraft(saved);
      setDraft(nextBase);
      baseRef.current = nextBase;
      setSaveState('saved');
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        const data = caught.data as { task?: Task };
        if (data?.task) setConflict({ serverTask: data.task, localPatch });
        setError('Конфликт не решён: задачу изменили снова.');
      } else setError(caught instanceof Error ? caught.message : 'Ошибка сохранения');
      setSaveState('error');
    }
  }
}
