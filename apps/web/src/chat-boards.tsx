import { useEffect, useRef, useState } from 'react';
import { api, ApiError, json } from './api';
import { ChoiceRow, Sheet, Skeleton } from './app-shell';
import type { Board, Member, Schedule } from './domain';
import { readStorage, removeStorage, writeStorage } from './environment';

type Chat = {rootId: string; name: string; multiEnabled: boolean; memberVersion: string; canManage: boolean; boards: Board[]; members: Member[];
  conflictingSchedules?: (Schedule & {board_id: string; name: string})[]; scheduleVersion?: string};
type Creation = {name: string; requestId: string; memberVersion?: string; memberIds?: string[]};
export function ChatBoards({ boardId, userId, onOpen, onClose }: {boardId: string; userId: string; onOpen: (board: Board) => Promise<void>; onClose: () => void}) {
  const key = `tasks.chat-create.${userId}.${boardId}`;
  const [chat, setChat] = useState<Chat>();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [attempt, setAttempt] = useState<Creation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [link, setLink] = useState('');
  const [entryLink, setEntryLink] = useState('');
  const [remove, setRemove] = useState<Member>();
  const [access, setAccess] = useState(false);
  const [sources, setSources] = useState({dailySourceId: '', weeklySourceId: ''});
  const lock = useRef(false);
  useEffect(() => {
    const sheet = document.querySelector<HTMLElement>('.chat-board-sheet');
    if (!sheet) return;
    const viewport = window.visualViewport;
    let frame = 0;
    const update = () => {
      if (viewport && Math.abs(viewport.scale - 1) > 0.05) return;
      const height = Math.min(innerHeight, viewport?.height ?? innerHeight), top = viewport?.offsetTop ?? 0;
      sheet.style.maxHeight = `${Math.min(720, height * .84)}px`;
      sheet.parentElement!.style.bottom = `${Math.max(0, innerHeight - height - top)}px`;
      const active = document.activeElement;
      if (!(active instanceof HTMLInputElement) || active.type !== 'text' || !sheet.contains(active)) return;
      const field = active.getBoundingClientRect(), bounds = sheet.getBoundingClientRect();
      const delta = field.top < bounds.top + 12 ? field.top - bounds.top - 12
        : field.bottom > bounds.bottom - 12 ? field.bottom - bounds.bottom + 12 : 0;
      if (Math.abs(delta) > 1) sheet.scrollBy({top: delta, behavior: 'instant'});
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { update(); frame = requestAnimationFrame(update); });
    };
    window.addEventListener('resize', schedule); viewport?.addEventListener('resize', schedule);
    sheet.addEventListener('focusin', schedule); schedule();
    return () => {
      cancelAnimationFrame(frame); window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule); sheet.removeEventListener('focusin', schedule);
    };
  }, []);
  useEffect(() => {
    const raw = readStorage(key);
    if (!raw) return;
    try {
      const saved: Creation = JSON.parse(raw);
      if (typeof saved.name !== 'string' || !/^[0-9a-f-]{36}$/i.test(saved.requestId)) throw new Error();
      setAttempt(saved); setName(saved.name); setCreating(true);
    } catch { setError('Не удалось прочитать незавершённое создание. Проверьте список досок перед новой попыткой.'); }
  }, [key]);
  useEffect(() => {
    let cancelled = false;
    setChat(undefined);
    void api<Chat>(`/api/boards/${boardId}/chat`).then(value => {
      if (!cancelled) { setChat(value); setMemberIds(value.members.map(member => member.id)); setConfirmed(false); if (value.conflictingSchedules) setCreating(false); }
    }).catch(caught => { if (!cancelled) setError(caught instanceof ApiError ? caught.message : 'Не удалось загрузить доски. Проверьте связь.'); });
    return () => { cancelled = true; };
  }, [boardId, reload]);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Нет связи. Повторите действие.'); }
    finally { lock.current = false; setBusy(false); }
  };
  const create = async () => {
    if (!chat) return;
    const payload = attempt ?? {name: name.trim(), requestId: crypto.randomUUID(), ...(!chat.multiEnabled ? {memberVersion: chat.memberVersion, memberIds} : {})};
    if (!writeStorage(key, JSON.stringify(payload))) throw new Error('Не удалось сохранить запрос на устройстве. Создание не отправлено.');
    setAttempt(payload);
    try {
      const board = await api<Board>(`/api/boards/${boardId}/chat/boards`, json('POST', payload));
      await onOpen(board);
      removeStorage(key); setAttempt(undefined);
    } catch (caught) {
      if (caught instanceof ApiError && [400, 409].includes(caught.status)) { removeStorage(key); setAttempt(undefined); setReload(value => value + 1); }
      throw caught instanceof ApiError ? caught : new Error('Нет подтверждения сервера. Повторите тот же запрос, чтобы проверить создание.');
    }
  };
  const close = () => { if (!busy) onClose(); };
  return <Sheet className="task-sheet chat-board-sheet" title={remove ? 'Отозвать доступ' : creating ? 'Добавить доску' : access ? 'Участники чата' : 'Доски чата'} onClose={close}>
    {error && <p role="alert">{error}</p>}
    {!chat ? <>{!error && <Skeleton label="Загрузка досок чата"/>}{error && <button onClick={() => { setError(''); setReload(value => value + 1); }}>Повторить</button>}</> : <>
      <p className="pair-context">{chat.name}</p>
      {remove ? <><p>{remove.first_name} потеряет доступ ко всем доскам этого чата, включая старые задачи. Данные сохранятся.</p><button disabled={busy} onClick={() => void run(async () => {
        await api(`/api/boards/${boardId}/chat/members/${remove.id}`, {method: 'DELETE'}); setRemove(undefined); setReload(value => value + 1);
      })}>Отозвать доступ ко всем доскам</button><button className="secondary" disabled={busy} onClick={() => setRemove(undefined)}>Отмена</button></> : creating ? <form onSubmit={event => { event.preventDefault(); void run(create); }}>
        <fieldset disabled={busy || Boolean(attempt)} className="settings-form">
          <label>Название доски<input autoFocus maxLength={120} value={name} onChange={event => setName(event.target.value)} required/></label>
          <p>Участники общие для всех досок чата. Новая доска не включается в сводку автоматически.</p>
          {!chat.multiEnabled && <section aria-label="Подтверждение состава"><h3>Подтвердите общий состав</h3><p>Отмеченные участники получат доступ ко всем направлениям. Снятие отметки закроет доступ и к прежней доске. Старые приглашения перестанут действовать.</p>
            {chat.members.map(member => <label className="checkbox" key={member.id}><input type="checkbox" disabled={member.id === userId} checked={memberIds.includes(member.id)} onChange={event => setMemberIds(ids => event.target.checked ? [...ids, member.id] : ids.filter(id => id !== member.id))}/>{member.first_name}</label>)}
            <label className="checkbox"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>Подтверждаю состав и замену старых приглашений</label>
          </section>}
        </fieldset>
        {attempt && <p role="status">Запрос сохранён. Повтор проверит ту же доску, не создавая дубль.</p>}
        <button disabled={busy || !chat.canManage || (!attempt && (!name.trim() || (!chat.multiEnabled && !confirmed)))}>{busy ? 'Создаём…' : attempt ? 'Проверить создание' : 'Создать'}</button>
        <button className="secondary" type="button" disabled={busy} onClick={() => setCreating(false)}>К доскам чата</button>
      </form> : access ? <>
        <p>Общий состав Таски. Это не автоматическая копия участников Telegram.</p>
        {chat.members.map(member => <div className="chat-member" key={member.id}><strong>{member.first_name}</strong>{chat.canManage && member.id !== userId && <button className="secondary" disabled={busy} onClick={() => setRemove(member)}>Отозвать доступ {member.first_name}</button>}</div>)}
        {chat.canManage && <><p>{chat.multiEnabled ? 'Приглашение даст доступ ко всем доскам чата и их истории.' : 'Приглашение даст доступ к доске и её истории.'}</p><button disabled={busy} onClick={() => void run(async () => { const result = await api<{url: string}>(`/api/boards/${boardId}/invites`, {method: 'POST'}); setLink(result.url); })}>Создать приглашение</button>
          {link && <label>Ссылка-приглашение<input readOnly value={link} onFocus={event => event.target.select()}/></label>}
          <button className="secondary" disabled={busy} onClick={() => void run(async () => { await api(`/api/boards/${boardId}/invites`, {method: 'DELETE'}); setLink(''); })}>Отозвать все приглашения</button></>}
        <button className="secondary" onClick={() => setAccess(false)}>К доскам чата</button>
      </> : <>
        <div className="choice-list" role="radiogroup" aria-label="Доски этого чата">{chat.boards.map(board => <ChoiceRow key={board.id} label={board.name} detail={board.status === 'active' ? 'Общие участники' : 'Только чтение'} selected={false} onClick={() => void run(() => onOpen(board))}/>)}</div>
        {!chat.boards.length && <p>Доступных досок нет.</p>}
        {chat.canManage && <section className="settings-form" aria-label="Общий вход в чат-доски"><p>Общая ссылка открывает выбор досок этого чата, но не выдаёт доступ. Отправьте её в чат самостоятельно — бот ничего не публикует.</p>
          <button className="secondary" disabled={busy} onClick={() => void run(async () => {
            const result = await api<{url: string}>(`/api/boards/${boardId}/chat/link`, {method: 'POST'}); setEntryLink(result.url);
          })}>Получить общую ссылку</button>
          {entryLink && <label>Общая ссылка чата<input readOnly value={entryLink} onFocus={event => event.target.select()}/></label>}
        </section>}
        {chat.canManage && chat.conflictingSchedules && <section className="settings-form" aria-label="Выбор общего расписания"><p>Есть отдельные расписания. Прежние публикации продолжаются. Перед добавлением доски явно выберите одно расписание для каждого типа.</p>
          {(['daily', 'weekly'] as const).map(kind => <label key={kind}>{kind === 'daily' ? 'План дня' : 'Итоги недели'}<select value={kind === 'daily' ? sources.dailySourceId : sources.weeklySourceId} onChange={event => setSources(value => ({...value, [kind === 'daily' ? 'dailySourceId' : 'weeklySourceId']: event.target.value}))}>
            <option value="">Выберите расписание</option>{chat.conflictingSchedules!.filter(schedule => schedule.kind === kind).map(schedule => <option key={schedule.board_id} value={schedule.board_id}>{schedule.name}: {schedule.enabled ? 'включено' : 'выключено'}, {schedule.local_time}, {schedule.timezone}, дни: {schedule.weekdays.join(', ')}</option>)}
          </select></label>)}<button disabled={busy || !sources.dailySourceId || !sources.weeklySourceId} onClick={() => void run(async () => {
            await api(`/api/boards/${boardId}/chat/schedules/resolve`, json('POST', {...sources, scheduleVersion: chat.scheduleVersion})); setSources({dailySourceId: '', weeklySourceId: ''}); setReload(value => value + 1);
          })}>Подтвердить общие расписания</button></section>}
        {chat.canManage && <button disabled={busy || Boolean(chat.conflictingSchedules)} onClick={() => setCreating(true)}>{attempt ? 'Проверить создание' : 'Добавить доску'}</button>}
        <button className="secondary" disabled={busy} onClick={() => setAccess(true)}>Участники и приглашения</button>
      </>}
    </>}
    <button className="secondary sheet-close" disabled={busy} onClick={close}>Закрыть</button>
  </Sheet>;
}

export function ChatInvite({token, onJoined, onClose}: {token: string; onJoined: (board: Board) => Promise<void>; onClose: () => void}) {
  const [invite, setInvite] = useState<{name: string; shared: boolean}>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const lock = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void api<{name: string; shared: boolean}>('/api/chat-invites/preview', json('POST', {token})).then(value => { if (!cancelled) setInvite(value); }).catch(caught => { if (!cancelled) setError(caught.message); });
    return () => { cancelled = true; };
  }, [token, reload]);
  const join = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await onJoined(await api<Board>('/api/board-links/redeem', json('POST', {token, acceptedAccess: true}))); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Нет связи'); }
    finally { lock.current = false; setBusy(false); }
  };
  return <Sheet title="Приглашение в чат-доски" className="task-sheet chat-board-sheet" onClose={() => { if (!busy) onClose(); }}>
    {invite ? <><h3>{invite.name}</h3><p>{invite.shared ? 'Доступ ко всем доскам чата, включая будущие направления и всю историю.' : 'Доступ к задачам и истории этой доски.'}</p><button disabled={busy} onClick={() => void join()}>{busy ? 'Присоединяемся…' : 'Принять приглашение'}</button></> : !error && <Skeleton label="Проверка приглашения"/>}
    {error && <><p role="alert">{error}</p><button className="secondary" onClick={() => { setError(''); setReload(value => value + 1); }}>Проверить приглашение</button></>}
    <button className="secondary" disabled={busy} onClick={onClose}>Не сейчас</button>
  </Sheet>;
}
