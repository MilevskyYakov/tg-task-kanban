import { useEffect, useRef, useState } from 'react';
import { api, ApiError, json } from './api';
import { Icon, Skeleton } from './app-shell';
import type { Board } from './domain';
import { PairScreen } from './pair-board';

export type EntryPath = 'personal' | 'pair' | 'group' | 'help';
const guides = {
  personal: { title: 'Личные задачи', heading: 'Всё своё — в одном месте.', steps: [
    ['Добавьте задачу', 'Нажмите «+». Исполнитель и срок необязательны.'],
    ['Разберите бэклог', 'Задачи без исполнителя ждут в бэклоге. Нажмите «Взять себе», когда готовы заняться задачей.'],
    ['Следите за выполнением', 'Меняйте статус в задаче или канбане. Личная доска доступна только вам.']
  ] },
  pair: { title: 'Как начать', heading: 'Работайте вдвоём. Группа не нужна.', steps: [
    ['Создайте доску', 'Назовите её так, чтобы обоим было понятно, над чем вы работаете.'],
    ['Пригласите человека', 'Отправьте ссылку. После принятия он увидит задачи и историю доски.'],
    ['Добавьте первые задачи', 'Создайте одну или вставьте список. Возьмите задачу себе и начните работу.']
  ] },
  group: { title: 'Доска для группы', heading: 'Общие задачи в вашей группе.', steps: [
    ['Добавьте бота', 'Выберите нужную группу в Telegram.'],
    ['Откройте задачи', 'В сообщении бота нажмите кнопку. Первый запуск завершит администратор.'],
    ['Закрепите сообщение', 'Оно останется постоянным входом в задачи вашей команды.']
  ] }
};

export function EntryGuide({ path, onPath, onPersonal, onPair, onClose }: {
  path: EntryPath; onPath: (path: EntryPath) => void; onPersonal: () => void; onPair: () => void; onClose: () => void;
}) {
  const [groupUrl, setGroupUrl] = useState('');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (path !== 'group') return;
    let cancelled = false;
    setError('');
    void api<{groupUrl: string}>('/api/bot-entry').then((data) => { if (!cancelled) setGroupUrl(data.groupUrl); }).catch(() => { if (!cancelled) setError('Не удалось подготовить переход в Telegram.'); });
    return () => { cancelled = true; };
  }, [path, reload]);
  if (path === 'help') return <PairScreen title="Как начать" onBack={onClose} actions={<button className="secondary" onClick={onClose}>К задачам</button>}>
    <h2>Личные и общие задачи в Telegram</h2><p>Добавляйте задачи, выбирайте исполнителя и следите за сроками.</p><p>Как будете работать?</p>
    <div className="entry-choices"><button className="secondary" onClick={() => onPath('personal')}>Личные задачи</button><button className="secondary" onClick={() => onPath('pair')}>Доска на двоих</button><button className="secondary" onClick={() => onPath('group')}>Доска для группы</button></div>
  </PairScreen>;
  const guide = guides[path];
  return <PairScreen title={guide.title} onBack={() => onPath('help')} error={error} actions={<>
    {path === 'personal' ? <button onClick={onPersonal}>Открыть личные задачи</button> : path === 'pair' ? <button onClick={onPair}>Создать доску</button> : error ? <button onClick={() => setReload((value) => value + 1)}>Повторить</button> : <button disabled={!groupUrl} onClick={() => { if (window.Telegram?.WebApp?.openTelegramLink) window.Telegram.WebApp.openTelegramLink(groupUrl); else window.location.assign(groupUrl); }}>Добавить бота в группу</button>}
    <button className="secondary" onClick={onClose}>К задачам</button>
  </>}>
    <h2>{guide.heading}</h2><ol className="entry-steps">{guide.steps.map(([title, detail]) => <li key={title}><strong>{title}</strong><p>{detail}</p></li>)}</ol>
    <p>{path === 'group' ? 'Без команд и повторной настройки при каждом входе.' : path === 'pair' ? 'Все возможности задач сохраняются. Публикаций в групповой чат здесь нет.' : 'Помощь доступна в настройках и через /help в боте.'}</p>
  </PairScreen>;
}

export function GroupSetup({ board, onReady, onClose }: { board: Board; onReady: (board: Board) => void; onClose: () => void }) {
  const [name, setName] = useState(board.name);
  const [canActivate, setCanActivate] = useState<boolean>();
  const [status, setStatus] = useState(board.status);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checkOnly, setCheckOnly] = useState(false);
  const [reload, setReload] = useState(0);
  const lock = useRef(false);
  const onReadyRef = useRef(onReady); onReadyRef.current = onReady;
  useEffect(() => {
    let cancelled = false;
    setError('');
    void api<{board: Board; canActivate: boolean}>(`/api/boards/${board.id}/setup`).then((value) => {
      if (cancelled) return;
      if (value.board.status === 'active') onReadyRef.current(value.board);
      else { setStatus(value.board.status); setCanActivate(value.canActivate); setCheckOnly(false); }
    }).catch(() => { if (!cancelled) setError('Не удалось проверить состояние доски. Повторите проверку.'); });
    return () => { cancelled = true; };
  }, [board.id, reload]);
  const activate = async () => {
    if (lock.current || !name.trim()) return;
    lock.current = true; setBusy(true); setError('');
    try { onReady(await api<Board>(`/api/boards/${board.id}/activate`, json('POST', { name: name.trim() }))); }
    catch (caught) {
      setCheckOnly(true);
      if (caught instanceof ApiError && caught.status === 403) setCanActivate(false);
      setError('Не удалось подтвердить запуск. Проверим состояние доски.');
    } finally { lock.current = false; setBusy(false); }
  };
  const frozen = status === 'frozen';
  const waiting = canActivate === false && !frozen;
  return <PairScreen title={board.name} context={canActivate && !frozen ? 'Первый запуск · администратор группы' : undefined} busy={busy} error={error} onBack={onClose} actions={<>
    {canActivate && !frozen && !checkOnly && !error ? <button disabled={!name.trim()} onClick={() => void activate()}>{busy ? 'Запускаем…' : 'Начать работу'}</button> : <button onClick={() => setReload((value) => value + 1)}>{waiting ? 'Проверить готовность' : 'Проверить состояние'}</button>}
    <button className="secondary" onClick={() => { if (window.Telegram?.WebApp?.close) window.Telegram.WebApp.close(); else onClose(); }}>Вернуться в группу</button>
  </>}>
    {frozen ? <><h2>Доска временно заморожена.</h2><p>Бот больше не в группе. Задачи и история сохранены. Администратор может вернуть бота; прежняя кнопка снова откроет доску.</p></> : waiting ? <><h2>Ожидаем администратора.</h2><p>Доску осталось один раз запустить администратору этой группы.</p><p>Затем вы сможете пользоваться той же кнопкой «Открыть задачи».</p></> : canActivate ? <><h2>Начните работу вместе с командой.</h2><label className="pair-name">Название доски<input value={name} maxLength={120} disabled={busy || checkOnly} onChange={(event) => setName(event.target.value)}/></label><div className="pair-fact"><Icon name="board"/><span><small>Вход команды</small>По кнопке в сообщении бота</span></div><p>После запуска команда сможет пользоваться кнопкой «Открыть задачи» в сообщении бота. Закрепите это сообщение в группе.</p></> : !error && <Skeleton label="Проверка доски"/>}
  </PairScreen>;
}
