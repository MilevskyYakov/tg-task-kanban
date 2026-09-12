import { useRef, useState } from 'react';
import { api, ApiError, json } from './api';
import { ActionRow, ChoiceRow, Icon, Sheet, TaskGlyph } from './app-shell';
import type { Project } from './domain';
import { parseTaskList, validateTaskCreate, type Task } from './tasks';
import { countLabel } from './navigation';

type Row = { title: string; requestId: string; task?: Task; error?: string };
export type BulkDraft = { boardId: string; boardName: string; projects: Project[]; text: string; project: string; rows?: Row[]; started: boolean };

type Props = { draft: BulkDraft; onDraft: (draft: BulkDraft) => void; onClose: () => void; onCreated: (tasks: Task[], projectId: string) => void };

export function BulkCreate({ draft, onDraft, onClose, onCreated }: Props) {
  const { boardId, boardName, projects, text, project, rows, started } = draft;
  const setText = (text: string) => onDraft({ ...draft, text });
  const setProject = (project: string) => onDraft({ ...draft, project });
  const setRows = (rows: Row[] | undefined) => onDraft({ ...draft, rows });
  const [choice, setChoice] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const titles = parseTaskList(text);
  const saved = rows?.filter((row) => row.task).length ?? 0;
  const remaining = (rows?.length ?? 0) - saved;
  const complete = Boolean(started && rows?.length && !remaining);
  const invalid = rows?.some((row) => validateTaskCreate(row.title, boardId));
  const submit = async () => {
    if (lock.current || !rows?.length || invalid) return;
    lock.current = true; setBusy(true); onDraft({ ...draft, started: true });
    // Keep each line's ID and payload unchanged until its server result is known.
    // Reuse the existing idempotent single-task API; no bulk endpoint is needed.
    const next = [...rows];
    try {
      for (let index = 0; index < next.length; index++) {
        if (next[index].task) continue;
        const row = next[index];
        try {
          const task = await api<Task>(`/api/boards/${boardId}/tasks`, json('POST', {
            title: row.title, requestId: row.requestId, projectId: project || null,
            assigneeUserId: null, deadline: null, deadlineDate: null, deadlineTimezone: null,
            status: 'todo', priority: 'normal', description: null, notifyAssignee: false,
            blockerTaskId: null, waitReason: null, waitCheckAt: null
          }));
          next[index] = { ...row, task, error: undefined };
        } catch (error) {
          next[index] = { ...row, error: error instanceof ApiError
            ? [401, 403, 404].includes(error.status) ? 'Доска или проект недоступны. Проверьте доступ перед повтором.' : error.message
            : 'Ответ не получен. Проверим при повторе.' };
        }
        onDraft({ ...draft, started: true, rows: [...next] });
      }
      onCreated(next.flatMap((row) => row.task ? [row.task] : []), project);
    } finally { lock.current = false; setBusy(false); }
  };
  const close = () => {
    if (lock.current) return;
    onClose();
  };
  return <section className="bulk-create create-screen">
    <header><button className="icon-button" aria-label="К бэклогу" disabled={busy} onClick={close}><Icon name="back"/></button><h1>{complete ? 'Задачи добавлены' : started ? 'Результат' : rows ? 'Проверить список' : 'Вставить список'}</h1></header>
    <p className="bulk-context">{boardName} · {projects.find((item) => item.id === project)?.name ?? 'Без проекта'}</p>
    {!rows ? <>
      <label className="bulk-input"><strong>Одна строка — одна задача</strong><small>Вставьте список или напишите его здесь.</small><textarea autoFocus aria-label="Список задач" value={text} onChange={(event) => setText(event.target.value)} rows={9}/></label>
      <p>{titles.length} непустых строк · без исполнителя и срока</p>
      <ActionRow label="Проект" value={projects.find((item) => item.id === project)?.name ?? 'Без проекта'} icon={<Icon name="project"/>} onClick={() => setChoice(true)}/>
      <div className="create-action"><button disabled={!titles.length} onClick={() => setRows(titles.map((title) => ({ title, requestId: crypto.randomUUID() })))}>Проверить список</button></div>
    </> : <>
      {complete && <TaskGlyph/>}
      <h2>{complete ? `${countLabel(saved, 'задача', 'задачи', 'задач')} в бэклоге` : started ? `Сохранено ${saved} из ${rows.length}` : <>{rows.length === 1 ? 'Будет создана' : 'Будут созданы'}<br/>{countLabel(rows.length, 'задача', 'задачи', 'задач')}</>}</h2>
      {invalid && <p className="detail-error" role="alert">Исправьте строки: название должно содержать от 1 до 200 символов. Пока ни одна задача не создана.</p>}
      {started && !complete && <p role="status">Текст сохранён. Повтор проверит неподтверждённые строки без дублей. Сохранённые задачи не отправляются повторно.</p>}
      <ol className="bulk-rows">{rows.map((row) => <li key={row.requestId} className={row.error || validateTaskCreate(row.title, boardId) ? 'bulk-error' : ''}><strong>{row.title}</strong><small>{row.task ? 'Сохранено' : row.error ?? validateTaskCreate(row.title, boardId) ?? 'Без исполнителя · Без срока'}</small></li>)}</ol>
      {!started && <p>Все задачи попадут в бэклог со статусом «К выполнению».</p>}
      <div className="create-action">
        {complete ? <><button onClick={onClose}>Открыть бэклог</button><button className="secondary" onClick={() => onDraft({ ...draft, text: '', rows: undefined, started: false })}>Добавить ещё</button></> : <><button disabled={busy || invalid} onClick={() => void submit()}>{busy ? 'Сохраняем…' : started ? `Повторить: ${remaining}` : `Создать ${countLabel(rows.length, 'задачу', 'задачи', 'задач')}`}</button>{!started ? <button className="secondary" onClick={() => setRows(undefined)}>Изменить текст</button> : <button className="secondary" disabled={busy} onClick={close}>К бэклогу</button>}</>}
      </div>
    </>}
    {choice && <Sheet title="Проект" className="task-sheet" onClose={() => setChoice(false)}><div className="choice-list" role="radiogroup">{[{ id: '', name: 'Без проекта' }, ...projects.filter((item) => !item.archived_at)].map((item) => <ChoiceRow key={item.id} label={item.name} selected={project === item.id} onClick={() => { setProject(item.id); setChoice(false); }}/>)}</div></Sheet>}
  </section>;
}
