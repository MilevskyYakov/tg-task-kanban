import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, json } from './api';
import { ActionRow, EnvironmentStatus, Icon, Skeleton } from './app-shell';
import type { Board, Member } from './domain';

const historyNotice = 'Приглашённый увидит все задачи, комментарии и прежнюю историю этой доски.';
const retainedNotice = 'Статусы, сроки, авторство и вся история сохранятся.';

export function PairScreen({ title, context, onBack, children, actions, busy = false, error, notice }: {
  title: string; context?: string; onBack: () => void; children: ReactNode; actions: ReactNode; busy?: boolean; error?: string; notice?: string;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); window.scrollTo(0, 0); }, [title]);
  return <main className="pair-screen"><EnvironmentStatus/>
    <header><button aria-label="Назад" disabled={busy} onClick={onBack}><Icon name="back"/></button><h1 ref={heading} tabIndex={-1}>{title}</h1></header>
    {context && <p className="pair-context">{context}</p>}
    {notice && <p className="pair-notice success" role="status">{notice}</p>}
    <div className="pair-content">{children}</div>
    {error && <p className="pair-notice error" role="alert">{error}</p>}
    <fieldset className="pair-actions" disabled={busy}>{actions}</fieldset>
  </main>;
}

type Invite = { id: string; name: string; owner_name: string; full: boolean; joined: boolean };
export function PairInvite({ token, onJoined, onClose }: {token: string; onJoined: (board: Board) => void; onClose: () => void}) {
  const [invite, setInvite] = useState<Invite>();
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const lock = useRef(false);
  useEffect(() => {
    let cancelled = false;
    setError(''); setUnavailable(false);
    void api<Invite>('/api/board-links/preview', json('POST', { token })).then((value) => { if (!cancelled) setInvite(value); }).catch((caught) => {
      if (!cancelled) { setUnavailable(caught instanceof ApiError && [400, 404].includes(caught.status)); setError(caught instanceof Error ? caught.message : 'Нет связи'); }
    });
    return () => { cancelled = true; };
  }, [token, reload]);
  const full = invite?.full && !invite.joined;
  const join = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { onJoined(await api<Board>('/api/board-links/redeem', json('POST', { token, acceptedHistory: true }))); }
    catch (caught) {
      if (caught instanceof ApiError && caught.status === 409 && invite) setInvite({ ...invite, full: true, joined: false });
      if (caught instanceof ApiError && caught.status === 404) setUnavailable(true);
      setError(caught instanceof Error ? caught.message : 'Нет связи. Повторите вступление.');
    } finally { lock.current = false; setBusy(false); }
  };
  return <PairScreen title="Приглашение" context={!unavailable && !full && invite ? `${invite.owner_name} приглашает вас` : undefined} onBack={onClose} busy={busy} error={error}
    actions={<>{!unavailable && !full && invite && <button onClick={() => void join()}>{busy ? 'Присоединяемся…' : invite.joined ? 'Открыть доску' : 'Присоединиться'}</button>}{error && !unavailable && !invite && <button onClick={() => setReload((value) => value + 1)}>Повторить</button>}<button className="secondary" onClick={onClose}>{unavailable || full ? 'К моим задачам' : 'Не сейчас'}</button></>}>
    {unavailable ? <><h2>Ссылка недоступна</h2><p>Попросите владельца отправить новое приглашение.</p></> : full ? <><h2>Доска уже занята</h2><p>В доске уже два участника. Если вас ожидали, попросите владельца проверить приглашение.</p></> : invite ? <><h2>{invite.name}</h2><div className="pair-fact"><Icon name="assignee"/><span><small>Формат</small>Доска на двоих</span></div><p>После вступления вы сможете вести задачи, обсуждать их и выбирать исполнителя.</p><p className="pair-notice">{historyNotice}</p></> : !error && <Skeleton label="Проверка приглашения"/>}
  </PairScreen>;
}

type View = 'create' | 'invite' | 'access' | 'replace' | 'revoke' | 'leave' | 'archive' | 'link-revoke' | 'link-revoked' | 'removed' | 'left';
export function PairBoard({ initialBoard, onChanged, onOpen, onClose }: {
  initialBoard?: Board; onChanged: (board?: Board) => void; onOpen: (board: Board) => void; onClose: () => void;
}) {
  const [board, setBoard] = useState(initialBoard);
  const [view, setView] = useState<View>(initialBoard ? 'access' : 'create');
  const [name, setName] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [revokeTarget, setRevokeTarget] = useState<Member>();
  const [loaded, setLoaded] = useState(false);
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [checkArchive, setCheckArchive] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const lock = useRef(false);
  const owner = board?.role === 'owner';
  const archived = board?.status === 'archived';
  const member = members.find((item) => item.role !== 'owner');
  const changeView = (next: View) => { if (next === 'revoke') setRevokeTarget(member); setView(next); setError(''); setNotice(''); };
  useEffect(() => {
    if (!board || view === 'left') return;
    let cancelled = false;
    setLoaded(false);
    void api<{members: Member[]}>(`/api/boards/${board.id}/members`).then((value) => { if (!cancelled) { setMembers(value.members); setLoaded(true); } }).catch(() => { if (!cancelled) setError('Не удалось загрузить участников. Повторите проверку.'); });
    return () => { cancelled = true; };
  }, [board?.id, view, reload]);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Нет связи. Повторите действие.'); }
    finally { lock.current = false; setBusy(false); }
  };
  const invite = async () => {
    if (!board) return;
    const result = await api<{url: string}>(`/api/boards/${board.id}/invites`, { method: 'POST' });
    setLink(result.url); setView('invite');
  };
  const archive = async (value: boolean) => {
    if (!board) return;
    try {
      const updated = await api<Board>(`/api/boards/${board.id}/archive`, json('POST', { archived: value }));
      setBoard(updated); onChanged(updated); setCheckArchive(false); setView('access');
    } catch (caught) {
      if (value) setCheckArchive(true);
      throw caught;
    }
  };
  const confirm = async () => {
    if (!board) return;
    if (view === 'archive') return archive(true);
    if (view === 'link-revoke') { await api(`/api/boards/${board.id}/invites`, { method: 'DELETE' }); setLink(''); setView('link-revoked'); return; }
    try {
      const result = await api<{removed: boolean}>(`/api/boards/${board.id}/${view === 'leave' ? 'leave' : 'participant'}`, view === 'leave' ? { method: 'POST' } : json('DELETE', { participantId: revokeTarget?.id }));
      if (view === 'revoke' && !result.removed) { changeView('access'); setReload((value) => value + 1); return; }
    } catch (caught) {
      if (view !== 'leave' || !(caught instanceof ApiError) || ![403, 404].includes(caught.status)) throw caught;
      try { await api(`/api/boards/${board.id}`); }
      catch (check) { if (check instanceof ApiError && check.status === 404) { onChanged(); setView('left'); return; } throw check; }
      throw caught;
    }
    setMembers((items) => items.filter((item) => item.role === 'owner')); setLink(''); onChanged(view === 'leave' ? undefined : board); setView(view === 'leave' ? 'left' : 'removed');
  };
  const back = () => {
    if (['revoke', 'leave', 'archive', 'replace'].includes(view)) changeView('access');
    else if (view === 'link-revoke') changeView('invite');
    else onClose();
  };
  const titles: Record<View, string> = { create: 'Доска на двоих', invite: 'Приглашение', access: archived ? 'Доска в архиве' : 'Доступ', replace: 'Новый участник', revoke: 'Отозвать доступ', leave: 'Выйти из доски', archive: 'Архив доски', 'link-revoke': 'Отозвать ссылку', 'link-revoked': 'Приглашение', removed: 'Доступ', left: 'Доступ закрыт' };
  let content: ReactNode;
  let actions: ReactNode;
  if (!board) {
    content = <><h2>Вместе,<br/>без группового чата.</h2><label className="pair-name">Название доски<input autoFocus value={name} maxLength={120} disabled={busy} onChange={(event) => setName(event.target.value)} placeholder="Например, запуск сайта"/></label><div className="pair-fact"><Icon name="assignee"/><span>Без Telegram-группы<small>Приглашение по ссылке</small></span></div><p>Задачи, проекты и обсуждения — вместе. Ваша личная доска останется приватной.</p></>;
    actions = <><button disabled={!name.trim()} onClick={() => void run(async () => { const created = await api<Board>('/api/boards/pair', json('POST', { name: name.trim(), requestId: requestId.current })); setBoard(created); onChanged(created); setView('invite'); })}>{busy ? 'Создаём…' : error ? 'Повторить создание' : 'Создать доску'}</button><button className="secondary" onClick={onClose}>Назад</button></>;
  } else if (view === 'left') {
    content = <><h2>Вы вышли<br/>из доски.</h2><p className="pair-notice success">Доступ к доске закрыт.</p><p>Задачи и история остались у владельца. Для возвращения нужно новое приглашение.</p></>;
    actions = <button onClick={onClose}>К моим задачам</button>;
  } else if (['revoke', 'leave', 'archive', 'link-revoke'].includes(view)) {
    content = view === 'archive' ? <><h2>{checkArchive ? 'Проверим состояние доски.' : 'Приостановить общую работу?'}</h2><p>Вы и второй участник сможете читать задачи, комментарии и историю. Изменения будут недоступны.</p><p className="pair-notice">Восстановить доску сможете только вы.</p><p>Ничего не удаляется. Участники и история сохраняются; отозванные не вернутся.</p></> : view === 'link-revoke' ? <><h2>Эта ссылка<br/>перестанет работать.</h2><p>Человек, который ещё не вступил, не сможет присоединиться по ней.</p><p>Доступ уже вступившего участника не изменится.</p></> : <><h2>{view === 'leave' ? 'Доска останется у владельца.' : `${revokeTarget?.first_name ?? 'Участник'} потеряет доступ к доске.`}</h2><p>{view === 'leave' ? 'Вы больше не сможете читать и изменять задачи этой доски.' : 'Участник больше не сможет читать и изменять задачи этой доски.'}</p><div className="pair-notice neutral"><strong>Задачи останутся без исполнителя.</strong><p>{retainedNotice}</p></div></>;
    actions = <>{checkArchive ? <button onClick={() => void run(async () => { const current = await api<Board>(`/api/boards/${board.id}`); setBoard(current); onChanged(current); setCheckArchive(false); setView('access'); })}>Проверить состояние</button> : <button className={view === 'archive' ? '' : 'danger'} onClick={() => void run(confirm)}>{busy ? 'Сохраняем…' : titles[view] === 'Архив доски' ? 'Архивировать доску' : titles[view]}</button>}<button className="secondary" onClick={back}>Отмена</button></>;
  } else if (archived) {
    content = <><p className="pair-notice success">Работа приостановлена. Доступ только для чтения.</p><h2>Всё сохранено.</h2><p>Задачи, комментарии и история доступны вам обоим.</p><div className="pair-fact"><Icon name="board"/><span><small>Доступ</small>Только чтение</span></div><div className="pair-fact"><Icon name="calendar"/><span><small>Восстановление</small>{owner ? 'Доступно вам — владельцу' : 'Только владелец'}</span></div></>;
    actions = <><button className="secondary" onClick={() => onOpen(board)}>Просмотреть задачи</button>{owner && <button onClick={() => void run(() => archive(false))}>{busy ? 'Восстанавливаем…' : error ? 'Повторить восстановление' : 'Восстановить доску'}</button>}<button className="secondary" onClick={onClose}>К моим задачам</button></>;
  } else if (view === 'invite' || view === 'replace' || view === 'link-revoked') {
    content = <><h2>{view === 'replace' ? <>Новый человек.<br/>Та же доска.</> : view === 'link-revoked' ? <>Приглашение<br/>больше не действует.</> : <>Пригласите<br/>второго участника.</>}</h2><p>{view === 'link-revoked' ? 'Старая ссылка не даст доступ к доске. Вы можете создать и отправить новую.' : 'Доска создана. Групповой чат не нужен.'}</p><p className="pair-notice">{historyNotice}</p>{view === 'replace' && <p>Прежние задачи и комментарии не будут скрыты от нового участника. Для работы без этой истории создайте отдельную доску на двоих.</p>}<ActionRow label="Участники" value="Вы · второе место свободно" onClick={() => changeView('access')}/>{link && <button className="pair-text-danger" onClick={() => changeView('link-revoke')}>Отозвать ссылку</button>}</>;
    actions = <>{link ? <><button className="secondary" onClick={() => void run(async () => { await navigator.clipboard.writeText(link); setNotice('Ссылка скопирована. Отправьте её нужному человеку.'); })}>Скопировать ссылку</button><button onClick={() => { const url = `https://t.me/share/url?url=${encodeURIComponent(link)}`; if (window.Telegram?.WebApp?.openTelegramLink) window.Telegram.WebApp.openTelegramLink(url); else window.open(url, '_blank', 'noopener,noreferrer'); }}>Отправить приглашение</button></> : <button onClick={() => void run(invite)}>{busy ? 'Создаём…' : view === 'link-revoked' ? 'Создать новое приглашение' : 'Создать приглашение'}</button>}<button className="secondary" onClick={() => onOpen(board)}>К задачам</button></>;
  } else {
    content = <><h2>{view === 'removed' ? <>Задачи остались<br/>на своих местах.</> : members.length >= 2 ? 'Два участника' : 'Второе место свободно'}</h2>{view === 'removed' && <p className="pair-notice success">Доступ участника отозван. {retainedNotice}</p>}{!loaded ? <Skeleton label="Загрузка участников"/> : members.map((item) => <div className="pair-fact" key={item.id}><Icon name="assignee"/><span><small>{item.role === 'owner' ? 'Владелец' : 'Участник'}</small>{item.first_name}</span></div>)}{owner ? member && <><button className="secondary" disabled={!loaded} onClick={() => changeView('revoke')}>Отозвать доступ {member.first_name}</button><p>Вы сможете пригласить другого человека. Задачи и история останутся на этой доске.</p></> : <p>Приглашениями и архивом управляет владелец.</p>}</>;
    actions = <>{!loaded && error && <button onClick={() => setReload((value) => value + 1)}>Повторить проверку</button>}{owner && !member && <><button disabled={!loaded} onClick={() => changeView('replace')}>Пригласить другого</button><button className="secondary" disabled={!loaded} onClick={() => changeView('link-revoke')}>Отозвать ссылку</button></>}<button className="secondary" onClick={() => changeView(owner ? 'archive' : 'leave')}>{owner ? 'Архивировать доску' : 'Выйти из доски'}</button><button className="secondary" onClick={() => onOpen(board)}>К задачам</button></>;
  }
  return <PairScreen title={titles[view]} context={board ? `${board.name} · ${owner ? 'Вы — владелец' : 'Доска на двоих'}` : 'Новая общая доска · максимум два участника'} onBack={back} actions={actions} busy={busy} error={error} notice={notice}>{content}</PairScreen>;
}
