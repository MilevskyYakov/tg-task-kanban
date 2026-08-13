import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

declare global { interface Window { Telegram?: { WebApp?: { initData: string; initDataUnsafe?: { start_param?: string }; ready(): void; expand(): void } } } }
type Board = { id: string; name: string; type: 'personal' | 'chat'; status: 'draft' | 'active' | 'frozen'; role: string };
type View = 'boards' | 'tasks' | string;

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error((await response.json() as {error?: string}).error ?? 'request failed');
  return response.json() as Promise<T>;
}

function App() {
  const [state, setState] = useState<'loading' | 'outside' | 'error' | 'ready'>('loading');
  const [boards, setBoards] = useState<Board[]>([]);
  const [view, setView] = useState<View>('boards');
  const [message, setMessage] = useState('');
  const loadBoards = async () => { const data = await api<{boards: Board[]}>('/api/boards'); setBoards(data.boards); return data.boards; };

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp?.initData) { setState('outside'); return; }
    webApp.ready(); webApp.expand();
    void api('/api/auth/telegram', { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({initData: webApp.initData}) })
      .then(async () => {
        const token = webApp.initDataUnsafe?.start_param;
        if (token) {
          const board = await api<Board>('/api/board-links/redeem', { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({token}) });
          setView(board.id);
        }
        await loadBoards(); setState('ready');
      })
      .catch((error: Error) => { setMessage(error.message); setState('error'); });
  }, []);

  const board = boards.find((item) => item.id === view);
  const activate = async () => {
    if (!board) return;
    const name = window.prompt('Название доски', board.name)?.trim();
    if (!name) return;
    try { await api(`/api/boards/${board.id}/activate`, { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({name}) }); await loadBoards(); setMessage('Доска активирована'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Ошибка'); }
  };
  const invite = async () => {
    if (!board) return;
    try { const result = await api<{url: string}>(`/api/boards/${board.id}/invites`, { method: 'POST' }); await navigator.clipboard.writeText(result.url); setMessage('Ссылка скопирована'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Ошибка'); }
  };
  const revoke = async () => {
    if (!board) return;
    try { const result = await api<{revoked: number}>(`/api/boards/${board.id}/invites`, { method: 'DELETE' }); setMessage(`Отозвано ссылок: ${result.revoked}`); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Ошибка'); }
  };

  if (state === 'outside') return <main><section><p className="eyebrow">KAIROS TASKS</p><h1>Задачи живут<br/>в Telegram</h1><p>Откройте приложение через <a href="https://t.me/kairostask_bot">@kairostask_bot</a>.</p></section></main>;
  if (state === 'error') return <main><section><h1>Не удалось войти</h1><p>{message || 'Закройте приложение и откройте его снова через бота.'}</p></section></main>;
  if (state === 'loading') return <main><section><p>Загрузка…</p></section></main>;
  if (view === 'tasks') return <main><button className="back" onClick={() => setView('boards')}>← Доски</button><section><p className="eyebrow">ВСЕ МОИ ЗАДАЧИ</p><h1>Пока пусто</h1><p>Задачи появятся здесь после запуска рабочего цикла.</p></section></main>;
  if (board) return <main><button className="back" onClick={() => setView('boards')}>← Доски</button><section><p className="eyebrow">{board.type === 'chat' ? 'ЧАТ-ДОСКА' : 'ЛИЧНАЯ ДОСКА'}</p><h1>{board.name}</h1>{board.status === 'frozen' ? <p className="notice">Бот больше не в чате. Данные сохранены, действия заморожены.</p> : board.status === 'draft' ? <><p>Завершите настройку, чтобы команда начала работу.</p><button onClick={activate}>Активировать</button></> : <p>Рабочее пространство готово. Задачи появятся в следующем этапе.</p>}{board.type === 'chat' && board.status !== 'frozen' && <><button className="secondary" onClick={invite}>Скопировать приглашение</button><button className="secondary" onClick={revoke}>Отозвать приглашения</button></>}{message && <p>{message}</p>}</section></main>;
  return <main><header><p className="eyebrow">KAIROS TASKS</p><h1>Мои доски</h1><button className="tasks" onClick={() => setView('tasks')}>Все мои задачи</button></header><div className="board-list">{boards.map((item) => <button className="board" key={item.id} onClick={() => { setMessage(''); setView(item.id); }}><span>{item.type === 'chat' ? 'ЧАТ' : 'ЛИЧНАЯ'}{item.status === 'frozen' ? ' · ЗАМОРОЖЕНА' : ''}</span><strong>{item.name}</strong><small>{item.type === 'chat' ? 'Командное пространство' : 'Только ваши задачи'}</small></button>)}</div></main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
