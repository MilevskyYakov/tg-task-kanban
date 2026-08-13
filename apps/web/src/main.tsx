import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

declare global { interface Window { Telegram?: { WebApp?: { initData: string; initDataUnsafe?: { start_param?: string }; ready(): void; expand(): void } } } }
type Board = { id: string; name: string; type: 'personal' | 'chat'; status: 'draft' | 'active' | 'frozen'; role: string };
type Project = { id: string; name: string; archived_at?: string };
type Member = { id: string; first_name: string; username?: string };
type Task = { id: string; board_id: string; board_name?: string; title: string; description?: string; project_id?: string; assignee_user_id?: string; creator_user_id: string; status: 'todo' | 'in_progress' | 'waiting' | 'done'; priority: 'normal' | 'urgent'; deadline?: string; wait_reason?: string; archived_at?: string; overdue: boolean; wait_check_due: boolean };
type Collaboration = { comments: {id: string; body: string; author_name: string; created_at: string}[]; checklist: {id: string; text: string; position: number; completed_at?: string}[]; attachments: {id: string; kind: 'url' | 'telegram'; url?: string; file_name?: string; created_at: string}[]; timeline: {id: string; action: string; actor_name: string; created_at: string}[] };
type View = 'boards' | 'tasks' | string;

class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) throw new ApiError((await response.json() as {error?: string}).error ?? 'request failed', response.status);
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
  const [project, setProject] = useState('');
  const [description, setDescription] = useState('');
  const [deadline, setDeadline] = useState('');
  const [priority, setPriority] = useState<Task['priority']>('normal');
  const [notifyAssignee, setNotifyAssignee] = useState(false);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [collaboration, setCollaboration] = useState<Collaboration | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const loadBoards = async () => { const data = await api<{boards: Board[]}>('/api/boards'); setBoards(data.boards); return data.boards; };
  const loadBoard = async (id: string, archive = showArchive) => {
    const [taskData, projectData, memberData] = await Promise.all([
      api<{tasks: Task[]}>(`/api/boards/${id}/tasks${archive ? '?archived=true' : ''}`), api<{projects: Project[]}>(`/api/boards/${id}/projects${archive ? '?archived=true' : ''}`), api<{members: Member[]}>(`/api/boards/${id}/members`)
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
    try {
      const created = await api<{notificationWarning?: string}>(`/api/boards/${board.id}/tasks`, json('POST', {
        title: title.trim(), description: description.trim() || null, projectId: project || null,
        assigneeUserId: assignee || null, deadline: deadline ? new Date(deadline).toISOString() : null, priority, notifyAssignee
      }));
      await loadBoard(board.id); setMessage(created.notificationWarning ?? 'Задача создана');
      setTitle(''); setDescription(''); setProject(''); setAssignee(''); setDeadline(''); setPriority('normal'); setNotifyAssignee(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Ошибка'); }
  };
  const move = async (task: Task, status: Task['status']) => {
    const waitReason = status === 'waiting' ? window.prompt('Почему ждём?')?.trim() : undefined;
    if (status === 'waiting' && !waitReason) return;
    const check = status === 'waiting' ? window.prompt('Дата следующей проверки, YYYY-MM-DD (необязательно)')?.trim() : undefined;
    await action(() => api(`/api/boards/${task.board_id}/tasks/${task.id}`, json('PATCH', { status, waitReason, waitCheckAt: check ? new Date(`${check}T00:00:00`).toISOString() : null })), statusName[status]);
  };
  const complete = async (task: Task) => {
    try { await api(`/api/boards/${task.board_id}/tasks/${task.id}`, json('PATCH', {status: 'done'})); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409 || !window.confirm('В чек-листе остались незавершённые пункты. Всё равно закрыть задачу?')) throw error;
      await api(`/api/boards/${task.board_id}/tasks/${task.id}`, json('PATCH', {status: 'done', confirmIncompleteChecklist: true}));
    }
    if (board) await loadBoard(board.id); setMessage('Готово');
  };
  const openCollaboration = async (task: Task) => {
    try { setOpenTask(task); setCollaboration(await api(`/api/boards/${task.board_id}/tasks/${task.id}/collaboration`)); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Ошибка'); }
  };
  const collaborationAction = async (path: string, options: RequestInit) => {
    if (!openTask) return;
    await action(() => api(path, options), 'Сохранено', false);
    setCollaboration(await api(`/api/boards/${openTask.board_id}/tasks/${openTask.id}/collaboration`));
  };
  const editTask = async (task: Task) => {
    const nextTitle = window.prompt('Название', task.title)?.trim(); if (!nextTitle) return;
    const nextDescription = window.prompt('Описание', task.description ?? '')?.trim(); if (nextDescription === undefined) return;
    const nextDeadline = window.prompt('Дедлайн, YYYY-MM-DD (пусто — убрать)', task.deadline?.slice(0, 10) ?? '')?.trim(); if (nextDeadline === undefined) return;
    const nextPriority = window.confirm('Срочная задача?') ? 'urgent' : 'normal';
    const nextProject = window.prompt(`ID проекта (пусто — без проекта)\n${projects.map((item) => `${item.id}: ${item.name}`).join('\n')}`, task.project_id ?? '')?.trim(); if (nextProject === undefined) return;
    const nextAssignee = window.prompt(`ID исполнителя (пусто — без ответственного)\n${members.map((item) => `${item.id}: ${item.first_name}`).join('\n')}`, task.assignee_user_id ?? '')?.trim(); if (nextAssignee === undefined) return;
    const notifyAssignee = Boolean(nextAssignee && nextAssignee !== task.assignee_user_id && window.confirm('Уведомить нового исполнителя?'));
    await action(() => api(`/api/boards/${task.board_id}/tasks/${task.id}`, json('PATCH', { title: nextTitle, description: nextDescription || null, deadline: nextDeadline ? new Date(`${nextDeadline}T00:00:00`).toISOString() : null, priority: nextPriority, projectId: nextProject || null, assigneeUserId: nextAssignee || null, notifyAssignee })), 'Задача обновлена');
  };
  const addProject = async () => {
    if (!board) return;
    const name = window.prompt('Название проекта')?.trim();
    if (name) await action(() => api(`/api/boards/${board.id}/projects`, json('POST', {name})), 'Проект создан');
  };
  const editProject = async (item: Project) => {
    if (!board) return;
    const name = window.prompt('Название проекта', item.name)?.trim(); if (!name) return;
    await action(() => api(`/api/boards/${board.id}/projects/${item.id}`, json('PATCH', {name})), 'Проект переименован');
  };
  const taskList = <div className="task-list">{tasks.map((task) => <article className={`task ${task.priority === 'urgent' ? 'urgent' : ''}`} key={task.id}>
    <div onClick={() => { if (!board && task.board_id) setView(task.board_id); }}><span>{task.board_name ?? statusName[task.status]}</span><strong>{task.title}</strong>{task.description && <small>{task.description}</small>}{task.deadline && <small>До {new Date(task.deadline).toLocaleDateString('ru-RU')}</small>}{task.overdue && <small>Дедлайн прошёл</small>}{task.wait_check_due && <small>Пора проверить ожидание</small>}{task.wait_reason && <small>Ждём: {task.wait_reason}</small>}</div>
    {board && <div className="actions"><button onClick={() => openCollaboration(task)}>Обсуждение</button>{task.archived_at ? <button onClick={() => action(() => api(`/api/boards/${task.board_id}/tasks/${task.id}/reopen`, {method: 'POST'}), 'Задача восстановлена')}>Восстановить</button> : <><button onClick={() => editTask(task)}>Изменить</button>{task.status === 'todo' && <button onClick={() => move(task, 'in_progress')}>Начать</button>}{task.status !== 'waiting' && task.status !== 'done' && <button onClick={() => move(task, 'waiting')}>Жду</button>}{task.status !== 'done' && <button onClick={() => action(() => complete(task), 'Готово')}>Готово</button>}{task.status === 'done' && <button onClick={() => move(task, 'in_progress')}>Вернуть</button>}<button onClick={() => action(() => api(`/api/boards/${task.board_id}/tasks/${task.id}`, {method: 'DELETE'}), 'Задача архивирована')}>В архив</button></>}</div>}
  </article>)}</div>;

  if (openTask && collaboration) return <main><button className="back" onClick={() => { setOpenTask(null); setCollaboration(null); }}>← К доске</button><header><p className="eyebrow">КАРТОЧКА ЗАДАЧИ</p><h1>{openTask.title}</h1></header><section className="collaboration"><h2>Чек-лист</h2>{collaboration.checklist.map((item) => <label key={item.id}><input type="checkbox" checked={Boolean(item.completed_at)} onChange={() => collaborationAction(`/api/boards/${openTask.board_id}/tasks/${openTask.id}/checklist/${item.id}`, json('PATCH', {completed: !item.completed_at}))}/>{item.text}</label>)}<button onClick={() => { const text = window.prompt('Новый пункт')?.trim(); if (text) void collaborationAction(`/api/boards/${openTask.board_id}/tasks/${openTask.id}/checklist`, json('POST', {text})); }}>Добавить пункт</button><h2>Комментарии</h2>{collaboration.comments.map((item) => <p key={item.id}><strong>{item.author_name}</strong> · {new Date(item.created_at).toLocaleString('ru-RU')}<br/>{item.body}</p>)}<button onClick={() => { const body = window.prompt('Комментарий')?.trim(); if (body) void collaborationAction(`/api/boards/${openTask.board_id}/tasks/${openTask.id}/comments`, json('POST', {body})); }}>Комментировать</button><h2>Вложения</h2>{collaboration.attachments.map((item) => <p key={item.id}>{item.url ? <a href={item.url}>{item.url}</a> : item.file_name ?? 'Telegram-файл'}</p>)}<button onClick={() => { const url = window.prompt('Ссылка')?.trim(); if (url) void collaborationAction(`/api/boards/${openTask.board_id}/tasks/${openTask.id}/attachments`, json('POST', {kind: 'url', url})); }}>Добавить ссылку</button><h2>История</h2>{collaboration.timeline.map((item) => <p key={item.id}>{item.actor_name} · {item.action} · {new Date(item.created_at).toLocaleString('ru-RU')}</p>)}</section></main>;

  if (state === 'outside') return <main><section><p className="eyebrow">KAIROS TASKS</p><h1>Задачи живут<br/>в Telegram</h1><p>Откройте приложение через <a href="https://t.me/kairostask_bot">@kairostask_bot</a>.</p></section></main>;
  if (state === 'error') return <main><section><h1>Не удалось войти</h1><p>{message || 'Закройте приложение и откройте его снова через бота.'}</p></section></main>;
  if (state === 'loading') return <main><section><p>Загрузка…</p></section></main>;
  if (view === 'tasks') return <main><button className="back" onClick={() => setView('boards')}>← Доски</button><header><p className="eyebrow">ВСЕ МОИ ЗАДАЧИ</p><h1>Моя работа</h1></header>{taskList}{!tasks.length && <p>Назначенных задач пока нет.</p>}</main>;
  if (board) return <main><button className="back" onClick={() => setView('boards')}>← Доски</button><header><p className="eyebrow">{board.type === 'chat' ? 'ЧАТ-ДОСКА' : 'ЛИЧНАЯ ДОСКА'}</p><h1>{board.name}</h1></header>{board.status === 'frozen' ? <p className="notice">Бот больше не в чате. Данные сохранены, действия заморожены.</p> : board.status === 'draft' ? <section><p>Завершите настройку, чтобы команда начала работу.</p><button onClick={activate}>Активировать</button></section> : <><form className="create-task" onSubmit={(event) => { event.preventDefault(); void create(); }}><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Название задачи" maxLength={200} required/><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Описание"/><select value={project} onChange={(event) => setProject(event.target.value)}><option value="">Без проекта</option>{projects.filter((item) => !item.archived_at).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select value={assignee} onChange={(event) => setAssignee(event.target.value)}><option value="">Без ответственного</option>{members.map((member) => <option key={member.id} value={member.id}>{member.first_name}</option>)}</select><input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)}/><select value={priority} onChange={(event) => setPriority(event.target.value as Task['priority'])}><option value="normal">Обычный</option><option value="urgent">Срочный</option></select><label><input type="checkbox" checked={notifyAssignee} disabled={!assignee} onChange={(event) => setNotifyAssignee(event.target.checked)}/> Уведомить исполнителя</label><button>Создать</button></form><div className="project-row"><div>{projects.map((item) => <span key={item.id}><button className="link" onClick={() => item.archived_at ? action(() => api(`/api/boards/${board.id}/projects/${item.id}`, json('PATCH', {archived: false})), 'Проект восстановлен') : editProject(item)}>{item.name}{item.archived_at ? ' · восстановить' : ''}</button>{!item.archived_at && <button className="link" onClick={() => action(() => api(`/api/boards/${board.id}/projects/${item.id}`, json('PATCH', {archived: true})), 'Проект архивирован')}>×</button>}</span>)}</div><button className="secondary" onClick={addProject}>+ Проект</button></div><button className="secondary" onClick={() => { const next = !showArchive; setShowArchive(next); void loadBoard(board.id, next); }}>{showArchive ? 'Только активные' : 'Показать архив'}</button>{taskList}{!tasks.length && <p>Задач пока нет.</p>}</>}{board.type === 'chat' && board.status !== 'frozen' && <button className="secondary" onClick={() => action(async () => { const result = await api<{url: string}>(`/api/boards/${board.id}/invites`, {method: 'POST'}); await navigator.clipboard.writeText(result.url); }, 'Ссылка скопирована', false)}>Скопировать приглашение</button>}{message && <p>{message}</p>}</main>;
  return <main><header><p className="eyebrow">KAIROS TASKS</p><h1>Мои доски</h1><button className="tasks" onClick={() => { setMessage(''); setView('tasks'); }}>Все мои задачи</button></header><div className="board-list">{boards.map((item) => <button className="board" key={item.id} onClick={() => { setMessage(''); setView(item.id); }}><span>{item.type === 'chat' ? 'ЧАТ' : 'ЛИЧНАЯ'}{item.status === 'frozen' ? ' · ЗАМОРОЖЕНА' : ''}</span><strong>{item.name}</strong><small>{item.type === 'chat' ? 'Командное пространство' : 'Только ваши задачи'}</small></button>)}</div></main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
