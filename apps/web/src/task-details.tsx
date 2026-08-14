import { useState, type FormEvent } from 'react';
import { ApiError } from './api';
import { EnvironmentStatus, TaskGlyph } from './app-shell';
import type { Collaboration, Member, Project } from './domain';
import { dateInputToIso, priorityDisplayName, statusDisplayName, type Task, type TaskPriority, type TaskStatus } from './tasks';

const statuses = Object.keys(statusDisplayName) as TaskStatus[];

export type TaskDraft = {
  title: string;
  description: string;
  status: TaskStatus;
  projectId: string;
  assigneeUserId: string;
  deadline: string;
  priority: TaskPriority;
  blockerTaskId: string;
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
    deadline: task.deadline?.slice(0, 10) ?? '',
    priority: task.priority,
    blockerTaskId: task.blocked_by_task_id ?? '',
    waitReason: task.wait_reason ?? '',
    waitCheckAt: '',
    future: false,
    notifyAssignee: false
  };
}

export function taskPatch(draft: TaskDraft) {
  if (!draft.title.trim()) throw new Error('Название задачи обязательно');
  const deadline = draft.deadline ? dateInputToIso(draft.deadline) : null;
  if (draft.deadline && !deadline) throw new Error('Укажите корректный срок');
  const waitCheckAt = draft.waitCheckAt ? dateInputToIso(draft.waitCheckAt) : null;
  if (draft.waitCheckAt && !waitCheckAt) throw new Error('Укажите корректную дату проверки');
  if (draft.status === 'waiting' && !draft.blockerTaskId && !draft.waitReason.trim()) throw new Error('Укажите задачу-блокер или внешнюю причину');
  return {
    title: draft.title.trim(),
    description: draft.description.trim() || null,
    status: draft.status,
    projectId: draft.projectId || null,
    assigneeUserId: draft.assigneeUserId || null,
    deadline,
    priority: draft.priority,
    blockerTaskId: draft.status === 'waiting' ? draft.blockerTaskId || null : null,
    waitReason: draft.status === 'waiting' && !draft.blockerTaskId ? draft.waitReason.trim() : null,
    waitCheckAt: draft.status === 'waiting' ? waitCheckAt : null,
    notifyAssignee: draft.notifyAssignee
  };
}

type Props = {
  task: Task;
  collaboration: Collaboration;
  projects: Project[];
  members: Member[];
  candidateTasks: Task[];
  boardName: string;
  onBack: () => void;
  onSave: (patch: ReturnType<typeof taskPatch>, future: boolean, confirmIncompleteChecklist?: boolean) => Promise<void>;
  onArchive: () => Promise<void>;
  onChecklistAdd: (text: string) => Promise<void>;
  onChecklistUpdate: (itemId: string, patch: { text?: string; completed?: boolean }) => Promise<void>;
  onChecklistDelete: (itemId: string) => Promise<void>;
  onComment: (body: string) => Promise<void>;
  onUrlAttachment: (url: string) => Promise<void>;
};

export function TaskDetails({ task, collaboration, projects, members, candidateTasks, boardName, onBack, onSave, onArchive, onChecklistAdd, onChecklistUpdate, onChecklistDelete, onComment, onUrlAttachment }: Props) {
  const [draft, setDraft] = useState(() => taskDraft(task));
  const [checklistText, setChecklistText] = useState('');
  const [comment, setComment] = useState('');
  const [attachmentUrl, setAttachmentUrl] = useState('');
  const [showAttachment, setShowAttachment] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const run = async (action: () => Promise<void>, clear?: () => void) => {
    setBusy(true); setError('');
    try { await action(); clear?.(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Ошибка'); }
    finally { setBusy(false); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    await run(async () => {
      const patch = taskPatch(draft);
      try { await onSave(patch, draft.future); }
      catch (caught) {
        if (!(caught instanceof ApiError) || caught.status !== 409 || caught.message !== 'incomplete checklist confirmation required'
          || !window.confirm('В чек-листе остались незавершённые пункты. Всё равно закрыть задачу?')) throw caught;
        await onSave(patch, draft.future, true);
      }
    });
  };
  const completed = collaboration.checklist.filter((item) => item.completed_at).length;

  return <main className="task-details">
    <EnvironmentStatus/>
    <h1 className="visually-hidden">Детали задачи</h1>
    <header className="task-details-bar"><button className="detail-icon" aria-label="Назад к задачам" onClick={onBack}>‹</button><span><i/> {boardName}</span><details><summary aria-label="Другие действия">•••</summary><div className="detail-menu">{task.recurrence_template_id && <p>Повторяющаяся задача</p>}<button className="danger" disabled={busy} onClick={() => void run(onArchive)}>Архивировать</button><details><summary>История</summary>{collaboration.timeline.map((item) => <p key={item.id}>{item.actor_name} · {item.action}<small>{new Date(item.created_at).toLocaleString('ru-RU')}</small></p>)}</details></div></details></header>

    <form onSubmit={save}>
      <div className="detail-title"><textarea aria-label="Название задачи" maxLength={200} value={draft.title} onChange={(event) => set('title', event.target.value)}/><TaskGlyph/></div>
      <div className="detail-status"><select aria-label="Статус" value={draft.status} onChange={(event) => set('status', event.target.value as TaskStatus)}>{statuses.map((status) => <option key={status} value={status}>{statusDisplayName[status]}</option>)}</select>{collaboration.checklist.length > 0 && <span>{completed} из {collaboration.checklist.length} шагов</span>}</div>

      <section className="detail-section" data-tone="main"><h2>Главное</h2><div className="detail-fields">
        <label><span>ПРОЕКТ</span><select value={draft.projectId} onChange={(event) => set('projectId', event.target.value)}><option value="">Без проекта</option>{projects.filter((item) => !item.archived_at).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span>ИСПОЛНИТЕЛЬ</span><select value={draft.assigneeUserId} onChange={(event) => set('assigneeUserId', event.target.value)}><option value="">Без ответственного</option>{members.map((item) => <option key={item.id} value={item.id}>{item.first_name}</option>)}</select></label>
        <label><span>СРОК</span><input type="date" value={draft.deadline} onChange={(event) => set('deadline', event.target.value)}/></label>
        <label><span>ПРИОРИТЕТ</span><select value={draft.priority} onChange={(event) => set('priority', event.target.value as TaskPriority)}>{Object.entries(priorityDisplayName).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
      </div>
      {draft.status === 'waiting' && <div className="blocker-fields"><label>Задача-блокер<select value={draft.blockerTaskId} onChange={(event) => set('blockerTaskId', event.target.value)}><option value="">Внешняя причина</option>{candidateTasks.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>{!draft.blockerTaskId && <label>Внешняя причина<input maxLength={1000} value={draft.waitReason} onChange={(event) => set('waitReason', event.target.value)}/></label>}<label>Дата проверки<input type="date" value={draft.waitCheckAt} onChange={(event) => set('waitCheckAt', event.target.value)}/></label></div>}
      {task.recurrence_template_id && <label className="checkbox"><input type="checkbox" checked={draft.future} onChange={(event) => set('future', event.target.checked)}/> Изменить этот и будущие повторы</label>}
      {draft.assigneeUserId && draft.assigneeUserId !== task.assignee_user_id && <label className="checkbox"><input type="checkbox" checked={draft.notifyAssignee} onChange={(event) => set('notifyAssignee', event.target.checked)}/> Уведомить нового исполнителя</label>}
      </section>

      <section className="detail-section" data-tone="content"><h2>Содержание</h2><textarea className="detail-description" aria-label="Описание" placeholder="Добавить описание" value={draft.description} onChange={(event) => set('description', event.target.value)}/>
        <div className="detail-checklist">{collaboration.checklist.map((item) => <div key={item.id}><input type="checkbox" checked={Boolean(item.completed_at)} aria-label={`Завершить ${item.text}`} onChange={() => void run(() => onChecklistUpdate(item.id, { completed: !item.completed_at }))}/><input defaultValue={item.text} aria-label="Текст пункта" onBlur={(event) => { const text = event.target.value.trim(); if (text && text !== item.text) void run(() => onChecklistUpdate(item.id, { text })); else event.target.value = item.text; }}/><button type="button" className="detail-remove" aria-label={`Удалить ${item.text}`} onClick={() => void run(() => onChecklistDelete(item.id))}>×</button></div>)}</div>
        <div className="detail-add"><input aria-label="Новый пункт чек-листа" maxLength={500} value={checklistText} onChange={(event) => setChecklistText(event.target.value)} placeholder="Новый пункт"/><button type="button" disabled={busy || !checklistText.trim()} onClick={() => void run(() => onChecklistAdd(checklistText.trim()), () => setChecklistText(''))}>Добавить</button></div>
      </section>

      <button className="detail-save" disabled={busy}>Сохранить изменения</button>
    </form>

    <section className="detail-section detail-discussion" data-tone="discussion"><h2>Обсуждение</h2>{collaboration.comments.map((item) => <article key={item.id}><strong>{item.author_name}</strong><small>{new Date(item.created_at).toLocaleString('ru-RU')}</small><p>{item.body}</p></article>)}{collaboration.attachments.map((item) => <p className="detail-attachment" key={item.id}>{item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.url}</a> : item.file_name ?? 'Файл из Telegram'}</p>)}
      {showAttachment && <div className="detail-add"><input aria-label="Ссылка" type="url" value={attachmentUrl} onChange={(event) => setAttachmentUrl(event.target.value)} placeholder="https://…"/><button disabled={busy || !attachmentUrl.trim()} onClick={() => void run(() => onUrlAttachment(attachmentUrl.trim()), () => { setAttachmentUrl(''); setShowAttachment(false); })}>Добавить</button></div>}
    </section>
    {error && <p className="detail-error" role="alert">{error}</p>}
    <div className="comment-composer"><input aria-label="Комментарий" maxLength={4000} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Написать комментарий…"/><button className="attach" aria-label="Добавить ссылку" onClick={() => setShowAttachment((value) => !value)}>⌕</button><button disabled={busy || !comment.trim()} aria-label="Отправить комментарий" onClick={() => void run(() => onComment(comment.trim()), () => setComment(''))}>↑</button></div>
  </main>;
}
