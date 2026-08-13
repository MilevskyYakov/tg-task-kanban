import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

declare global { interface Window { Telegram?: { WebApp?: { initData: string; ready(): void; expand(): void } } } }
type Board = { id: string; name: string; type: 'personal' | 'chat'; role: string };

function App() {
  const [state, setState] = useState<'loading' | 'outside' | 'error' | 'ready'>('loading');
  const [boards, setBoards] = useState<Board[]>([]);
  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp?.initData) { setState('outside'); return; }
    webApp.ready(); webApp.expand();
    void fetch('/api/auth/telegram', { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({initData: webApp.initData}) })
      .then((response) => { if (!response.ok) throw new Error(); return fetch('/api/boards'); })
      .then((response) => { if (!response.ok) throw new Error(); return response.json() as Promise<{boards: Board[]}>; })
      .then((data) => { setBoards(data.boards); setState('ready'); })
      .catch(() => setState('error'));
  }, []);
  if (state === 'outside') return <main><section><p className="eyebrow">KAIROS TASKS</p><h1>Задачи живут<br/>в Telegram</h1><p>Откройте приложение через <a href="https://t.me/kairostask_bot">@kairostask_bot</a>.</p></section></main>;
  if (state === 'error') return <main><section><h1>Не удалось войти</h1><p>Закройте приложение и откройте его снова через бота.</p></section></main>;
  if (state === 'loading') return <main><section><p>Загрузка…</p></section></main>;
  return <main><header><p className="eyebrow">KAIROS TASKS</p><h1>Мои доски</h1></header>{boards.map((board) => <article key={board.id}><span>ЛИЧНАЯ</span><h2>{board.name}</h2><p>Только ваши задачи</p></article>)}</main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
