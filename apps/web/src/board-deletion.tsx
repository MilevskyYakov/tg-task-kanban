import { useEffect, useRef, useState } from 'react';
import { api, ApiError, json } from './api';
import { Sheet, Skeleton } from './app-shell';

type Preview = {id: string; name: string; type: string; deleted: boolean; confirmation: string; counts: Record<string, number>};
type Intent = {action: 'delete' | 'restore'; requestId: string; confirmation: string};
const labels: Record<string, string> = {tasks: 'Задачи', projects: 'Проекты', comments: 'Комментарии', attachments: 'Вложения', checklist: 'Пункты чек-листов', history: 'Записи истории', recurrences: 'Повторы', dependencies: 'Зависимости задач'};

export function BoardDeletionAction({boardId, restore = false, onChanged}: {boardId: string; restore?: boolean; onChanged: (deleted: boolean) => Promise<void>}) {
  const [preview, setPreview] = useState<Preview>();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [intent, setIntent] = useState<Intent>();
  const [result, setResult] = useState<{deleted: boolean}>();
  const lock = useRef(false);
  useEffect(() => {
    let cancelled = false;
    setPreview(undefined); setForbidden(false); setError('');
    void api<Preview>(`/api/boards/${boardId}/deletion`).then(value => { if (!cancelled) setPreview(value); })
      .catch(caught => { if (!cancelled) { setError(caught.message); setForbidden(caught instanceof ApiError && [403, 404].includes(caught.status)); } });
    return () => { cancelled = true; };
  }, [boardId, reload]);
  const change = async () => {
    if (lock.current || !preview) return;
    lock.current = true; setBusy(true); setError('');
    const payload = intent ?? {action: restore ? 'restore' : 'delete', requestId: crypto.randomUUID(), confirmation: preview.confirmation};
    setIntent(payload);
    try {
      const saved = result ?? await api<{deleted: boolean}>(`/api/boards/${boardId}/deletion`, json('POST', payload));
      setResult(saved);
      await onChanged(saved.deleted); setOpen(false);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        if (caught.status === 409) { setIntent(undefined); setPreview(undefined); }
        if ([403, 404].includes(caught.status)) { setForbidden(true); setPreview(undefined); }
      } else setError('Нет подтверждения результата. Повторите проверку: тот же запрос не выполнится дважды.');
    } finally { lock.current = false; setBusy(false); }
  };
  if (!open) return <div className="settings-form">
    {preview && preview.deleted === restore && <button className="secondary" onClick={() => { setOpen(true); setReload(value => value + 1); }}>{restore ? 'Восстановить доску' : 'Удалить доску'}</button>}
    {error && <><p role="status">{error}</p>{!forbidden && <button className="secondary" onClick={() => setReload(value => value + 1)}>Проверить права</button>}</>}
  </div>;
  return <Sheet className="task-sheet" title={restore ? 'Восстановить доску?' : 'Удалить доску?'} onClose={() => { if (!busy) setOpen(false); }}>
    {error && <p role="alert">{error}</p>}
    {!preview ? <>{!error && <Skeleton label="Проверка состава доски"/>}<button className="secondary" disabled={busy} onClick={() => setReload(value => value + 1)}>Проверить заново</button></> : <>
      <h3>{preview.name}</h3>
      <p>{restore ? 'Доска и данные вернутся с прежними ID. Доступ получат текущие участники; ранее отозванное членство не вернётся.' : 'Доска исчезнет у всех участников из рабочих списков, сводок и MCP. Данные сохранятся; доску можно восстановить в разделе «Удалённые доски».'}</p>
      <ul>{Object.entries(labels).map(([key, label]) => <li key={key}>{label}: {preview.counts[key]}</li>)}</ul>
      <p>Повторы останутся на паузе. Включение доски в публикации и MCP-доступ нужно настроить отдельно. Отозванные приглашения не восстановятся.</p>
      {preview.type === 'chat' && <p>Telegram-чат, бот и остальные доски не удаляются. Если это последняя доска, публикации прекратятся. Уже отправленные сообщения останутся в Telegram.</p>}
      {result && <p role="status">{result.deleted ? 'Доска удалена.' : 'Доска восстановлена.'} Обновляем список.</p>}
      <button disabled={busy || preview.deleted !== restore} onClick={() => void change()}>{busy ? 'Проверяем…' : intent ? 'Проверить результат' : restore ? 'Подтвердить восстановление' : 'Подтвердить удаление'}</button>
    </>}
    <button className="secondary" disabled={busy} onClick={() => setOpen(false)}>{intent ? 'Закрыть' : 'Отмена'}</button>
  </Sheet>;
}

export function DeletedBoards({onChanged, onChat, onClose}: {onChanged: (deleted: boolean) => Promise<void>; onChat: (id: string) => void; onClose: () => void}) {
  const [boards, setBoards] = useState<{id: string; name: string; chat_root_id?: string}[]>();
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void api<{boards: NonNullable<typeof boards>}>('/api/boards/deleted').then(value => { if (!cancelled) setBoards(value.boards); })
      .catch(caught => { if (!cancelled) setError(caught.message); });
    return () => { cancelled = true; };
  }, [reload]);
  const current = boards?.find(board => board.id === selected);
  return <section className="settings-screen"><h2>Удалённые доски</h2>
    <p>Здесь только доски, которые вы вправе восстановить. Безвозвратного удаления нет.</p>
    {error && <><p role="alert">{error}</p><button onClick={() => { setError(''); setReload(value => value + 1); }}>Повторить</button></>}
    {!boards && !error && <Skeleton label="Загрузка удалённых досок"/>}
    {boards?.length === 0 && <p>Удалённых досок нет.</p>}
    {!current ? boards?.map(board => <button className="secondary" key={board.id} onClick={() => setSelected(board.id)}>{board.name}</button>) : <>
      <h3>{current.name}</h3>
      <BoardDeletionAction key={current.id} boardId={current.id} restore onChanged={async deleted => { await onChanged(deleted); setSelected(''); setReload(value => value + 1); }}/>
      {current.chat_root_id && <button className="secondary" onClick={() => onChat(current.chat_root_id!)}>Создать доску в этом чате</button>}
      <button className="secondary" onClick={() => setSelected('')}>К списку удалённых</button>
    </>}
    <button className="secondary" onClick={onClose}>Закрыть</button>
  </section>;
}
