import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

declare global { interface Window { Telegram?: { WebApp?: { initData: string; initDataUnsafe?: { start_param?: string }; ready(): void; expand(): void } } } }
type Board = { id: string; name: string; type: 'personal' | 'chat'; status: 'draft' | 'active' | 'frozen'; role: string };
type Project = { id: string; name: string };
type Member = { id: string; first_name: string; username?: string };
type Task = { id: string; board_id: string; board_name?: string; title: string; description?: string; project_id?: string; assignee_user_id?: string; creator_user_id: string; status: 'todo' | 'in_progress' | 'waiting' | 'done'; priority: 'normal' | 'urgent'; deadline?: string; wait_reason?: string; overdue: boolean; wait_check_due: boolean };
type View = 'boards' | 'tasks' | string;

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error((await response.json() as {error?: string}).error ?? 'request failed');
  return response.json() as Promise<T>;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: {'content-type': 'application/json'}, body: JSON.stringify(body) });
const statusName = { todo: 'К выполнению', in_progress: 'В работе', waiting: 'Жду', done: 'Готово' };

function App() {
  const [state, setState] = useState<'loading' | 'outside' | 'error' | 'ready'>('loading');
  const [boards, setBoards] = useState<Board[]>([]);
  const [view, setView] = useState<View>('boards');
  const [message, setMessage] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const loadBoards = async () => { const data = await api<{boards: Board[]}>('/api/boards'); setBoards(data.boards); return data.boards; };
  const loadBoard = async (id: string) => {
    const [taskData, projectData, memberData] = await Promise.all([
      api<{tasks: Task[]}>(`/api/boards/${id}/tasks`), api<{projects: Project[]}>(`/api/boards/${id}/projects`), api<{members: Member[]}>(`/api/boards/${id}/members`)
    ]);
    setTasks(taskData.tasks); setProjects(projectData.projects); setMembers(memberData.members);
  };

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp?.initData) { setState('outside'); return; }
    webApp.ready(); webApp.expand();
    void api('/api/auth/telegram', json('POST', {initData: webApp.initData}))
      .then(async () => {
        const token = webApp.initDataUnsafe?.start_param;
        if (token) { const board = await api<Board>('/api/board-links/redeem', json('POST', {token})); setView(board.id); }
        await loadBoards(); setState('ready');
      })
      .catch((error: Error) => { setMessage(error.message); setState('error'); });
  }, []);
  useEffect(() => {
    if (state !== 'ready') return;
    if (view === 'tasks') void api<{tasks: Task[]}>('/api/tasks/mine').then((data) => setTasks(data.tasks)).catch((error: Error) => setMessage(error.message));
    else if (view !== 'boards') void loadBoard(view).catch((error: Error) => setMessage(error.message));
  }, [state, view]);

  const board = boards.find((item) => item.id === view);
  const action = async (run: () => Promise<unknown>, success: string, reload = true) => {
    try { await run(); if (reload && board) await loadBoard(board.id); setMessage(success); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Ошибка'); }
  };
  const activate = async () => {
    if (!board) return;
    const name = window.prompt('Название доски', board.name)?.trim();
    if (name) await action(() => api(`/api/boards/${board.id}/activate`, json('POST', {name})), 'Доска активирована', false).then(loadBoards);
  };
  const create = async () => {
    if (!board || !title.trim()) return;
    await action(() => api(`/api/boards/${board.id}/tasks`, json('POST', { title: title.trim(), assigneeUserId: assignee || null })), 'Задача создана');
    setTitle(''); setAssignee('');
  };
  const move = async (task: Task, status: Task['status']) => {
    const waitReason = status === 'waiting' ? window.prompt('Почему ждём?')?.trim() : undefined;
    if (status === 'waiting' && !waitReason) return;
    await action(() => api(`/api/boards/${task.board_id}/tasks/${task.id}`, json('PATCH', { status, waitReason })), statusName[status]);
  };
  const addProject = async () => {
    if (!board) return;
    const name = window.prompt('Название проекта')?.trim();
    if (name) await action(() => api(`/api/boards/${board.id}/projects`, json('POST', {name})), 'Проект создан');
  };
  const taskList = <div className="task-list">{tasks.map((task) => <article className={`task ${task.priority === 'urgent' ? 'urgent' : ''}`} key={task.id}>
    <div><span>{task.board_name ?? statusName[task.status]}</span><strong>{task.title}</strong>{task.overdue && <small>Дедлайн прошёл</small>}{task.wait_check_due && <small>Пора проверить ожидание</small>}{task.wait_reason && <small>Ждём: {task.wait_reason}</small>}</div>
    {board && <div className="actions">{task.status === 'todo' && <button onClick={() => move(task, 'in_progress')}>Начать</button>}{task.status !== 'waiting' && task.status !== 'done' && <button onClick={() => move(task, 'waiting')}>Жду</button>}{task.status !== 'done' && <button onClick={() => move(task, 'done')}>Готово</button>}{task.status === 'done' && <button onClick={() => move(task, 'in_progress')}>Вернуть</button>}</div>}
  </article>)}</div>;

  if (state === 'outside') return <main><section><p className="eyebrow">KAIROS TASKS</p><h1>Задачи живут<br/>в Telegram</h1><p>Откройте приложение через <a href="https://t.me/kairostask_bot">@kairostask_bot</a>.</p></section></main>;
  if (state === 'error') return <main><section><h1>Не удалось войти</h1><p>{message || 'Закройте приложение и откройте его снова через бота.'}</p></section></main>;
  if (state === 'loading') return <main><section><p>Загрузка…</p></section></main>;
  if (view === 'tasks') return <main><button className="back" onClick={() => setView('boards')}>← Доски</button><header><p className="eyebrow">ВСЕ МОИ ЗАДАЧИ</p><h1>Моя работа</h1></header>{taskList}{!tasks.length && <p>Назначенных задач пока нет.</p>}</main>;
  if (board) return <main><button className="back" onClick={() => setView('boards')}>← Доски</button><header><p className="eyebrow">{board.type === 'chat' ? 'ЧАТ-ДОСКА' : 'ЛИЧНАЯ ДОСКА'}</p><h1>{board.name}</h1></header>{board.status === 'frozen' ? <p className="notice">Бот больше не в чате. Данные сохранены, действия заморожены.</p> : board.status === 'draft' ? <section><p>Завершите настройку, чтобы команда начала работу.</p><button onClick={activate}>Активировать</button></section> : <><form className="create-task" onSubmit={(event) => { event.preventDefault(); void create(); }}><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Название задачи" maxLength={200} required/><select value={assignee} onChange={(event) => setAssignee(event.target.value)}><option value="">Без ответственного</option>{members.map((member) => <option key={member.id} value={member.id}>{member.first_name}</option>)}</select><button>Создать</button></form><div className="project-row"><span>Проекты: {projects.map((project) => project.name).join(', ') || 'нет'}</span><button className="secondary" onClick={addProject}>+ Проект</button></div>{taskList}{!tasks.length && <p>Задач пока нет.</p>}</>}{board.type === 'chat' && board.status !== 'frozen' && <button className="secondary" onClick={() => action(async () => { const result = await api<{url: string}>(`/api/boards/${board.id}/invites`, {method: 'POST'}); await navigator.clipboard.writeText(result.url); }, 'Ссылка скопирована', false)}>Скопировать приглашение</button>}{message && <p>{message}</p>}</main>;
  return <main><header><p className="eyebrow">KAIROS TASKS</p><h1>Мои доски</h1><button className="tasks" onClick={() => { setMessage(''); setView('tasks'); }}>Все мои задачи</button></header><div className="board-list">{boards.map((item) => <button className="board" key={item.id} onClick={() => { setMessage(''); setView(item.id); }}><span>{item.type === 'chat' ? 'ЧАТ' : 'ЛИЧНАЯ'}{item.status === 'frozen' ? ' · ЗАМОРОЖЕНА' : ''}</span><strong>{item.name}</strong><small>{item.type === 'chat' ? 'Командное пространство' : 'Только ваши задачи'}</small></button>)}</div></main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
