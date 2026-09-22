import { useRef, useState } from 'react';
import { api, ApiError } from './api';
import { Icon } from './app-shell';
import { formatTaskDeadline, isBacklogTask, statusDisplayName, type Task } from './tasks';

export type ClaimResult = { claimed: boolean; message: string; task?: Task | null };

export async function runClaim(claim: () => Promise<Task>, refresh: (status: number) => Promise<Task | null>, userId: string): Promise<ClaimResult> {
  try {
    const saved = await claim();
    return { claimed: true, message: 'Задача теперь ваша. Статус не изменён.', task: saved };
  } catch (error) {
    if (error instanceof ApiError && [403, 404, 409].includes(error.status)) {
      try {
        const latest = await refresh(error.status);
        return { claimed: false, task: latest, message: latest?.assignee_user_id === userId ? 'Задача уже ваша. Данные обновлены.' : latest?.assignee_name ? `Задача уже назначена: ${latest.assignee_name}. Данные обновлены.` : 'Задача больше недоступна для взятия. Данные обновлены.' };
      } catch (refreshError) {
        if (refreshError instanceof ApiError && [403, 404].includes(refreshError.status)) return { claimed: false, task: null, message: 'Задача больше недоступна для взятия. Данные обновлены.' };
        return { claimed: false, message: 'Не удалось обновить задачу. Повторите проверку.' };
      }
    }
    return { claimed: false, message: 'Нет подтверждения сервера. Повторите запрос: чужое назначение не будет перезаписано.' };
  }
}

export function ClaimTask({ task, userId, boardName, onBack, onMine, onChanged }: { task: Task; userId: string; boardName: string; onBack: () => void; onMine: () => void; onChanged: (task: Task | null) => void }) {
  const [current, setCurrent] = useState<Task | null>(task);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const mine = current?.assignee_user_id === userId;
  const claim = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage('');
    try {
      const result = await runClaim(() => api<Task>(`/api/boards/${task.board_id}/tasks/${task.id}/claim`, { method: 'POST' }), (status) => status === 409 ? api<Task>(`/api/boards/${task.board_id}/tasks/${task.id}`) : Promise.resolve(null), userId);
      setMessage(result.message);
      if (result.task !== undefined) { setCurrent(result.task); onChanged(result.task); }
    } finally { lock.current = false; setBusy(false); }
  };
  return <section className="claim-screen create-screen">
    <header><button className="icon-button" aria-label="К бэклогу" disabled={busy} onClick={onBack}><Icon name="back"/></button><h1>Задача</h1></header>
    <p className="bulk-context">{boardName} · {task.project_name ?? 'Без проекта'}</p>
    <h2>{current?.title ?? task.title}</h2>
    {current && <><p className="claim-status">{current.status === 'todo' ? 'К выполнению' : statusDisplayName[current.status]}</p><div className="claim-fields"><div className="claim-field"><Icon name="assignee"/><div><small>Исполнитель</small><strong>{mine ? 'Вы' : current.assignee_name ?? 'Не назначен'}</strong></div></div><div className="claim-field"><Icon name="calendar"/><div><small>Срок</small><strong>{formatTaskDeadline(current)}</strong></div></div></div><div className="claim-content"><h3>Содержание</h3><p>{current.description || 'Без описания'}</p></div></>}
    {message && <p className={mine ? 'context-note' : 'detail-error'} role="status">{message}</p>}
    <div className="create-action">{mine ? <button onClick={onMine}>Открыть мои задачи</button> : <button disabled={busy || !current || !isBacklogTask(current)} onClick={() => void claim()}>{busy ? 'Назначаем…' : current && isBacklogTask(current) ? 'Взять себе' : 'Уже недоступна'}</button>}<button className="secondary" disabled={busy} onClick={onBack}>К бэклогу</button></div>
  </section>;
}
