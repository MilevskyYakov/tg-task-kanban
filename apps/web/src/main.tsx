import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { dateInputToIso, defaultFilters, filterTasks, optimisticUpdate, type Task, type TaskFilters, type TaskStatus } from './tasks';

declare global { interface Window { Telegram?: { WebApp?: { initData: string; initDataUnsafe?: { start_param?: string }; ready(): void; expand(): void } } } }
type Board = { id: string; name: string; type: 'personal' | 'chat'; status: 'draft' | 'active' | 'frozen'; role: string };
type Project = { id: string; name: string; archived_at?: string };
type Member = { id: string; first_name: string; username?: string };
type Recurrence = { id: string; title: string; frequency: 'daily' | 'weekdays' | 'weekly' | 'monthly'; local_time: string; timezone: string; next_occurrence_at?: string; paused_at?: string; archived_at?: string };
type View = 'boards' | 'tasks' | string;
type TaskView = 'list' | 'kanban';

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error((await response.json() as {error?: string}).error ?? 'request failed');
  return response.json() as Promise<T>;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: {'content-type': 'application/json'}, body: JSON.stringify(body) });
const statusName = { todo: 'К выполнению', in_progress: 'В работе', waiting: 'Жду', done: 'Готово' };
const statuses = Object.keys(statusName) as TaskStatus[];

function App() {
  const [state, setState] = useState<'loading' | 'outside' | 'error' | 'ready'>('loading');
  const [boards, setBoards] = useState<Board[]>([]);
  const [view, setView] = useState<View>('boards');
  const [message, setMessage] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [recurrences, setRecurrences] = useState<Recurrence[]>([]);
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const [project, setProject] = useState('');
  const [description, setDescription] = useState('');
  const [deadline, setDeadline] = useState('');
  const [priority, setPriority] = useState<Task['priority']>('normal');
  const [showArchive, setShowArchive] = useState(false);
  const [userId, setUserId] = useState('');
  const [taskView, setTaskView] = useState<TaskView>('list');
  const [filters, setFilters] = useState<TaskFilters>(defaultFilters);
  const [filtersLoadedFor, setFiltersLoadedFor] = useState('');
  const [draggedTask, setDraggedTask] = useState<string>();
  const touchDrag = useRef<{task?: Task; x: number; y: number; active: boolean; timer?: ReturnType<typeof setTimeout>}>({ x: 0, y: 0, active: false });
  const board = boards.find((item) => item.id === view);
  const loadBoards = async () => { const data = await api<{boards: Board[]}>('/api/boards'); setBoards(data.boards); return data.boards; };
  const loadBoard = async (id: string, archive = showArchive) => {
    const [taskData, projectData, memberData, recurrenceData] = await Promise.all([
      api<{tasks: Task[]}>(`/api/boards/${id}/tasks${archive ? '?archived=true' : ''}`), api<{projects: Project[]}>(`/api/boards/${id}/projects${archive ? '?archived=true' : ''}`), api<{members: Member[]}>(`/api/boards/${id}/members`), api<{recurrences: Recurrence[]}>(`/api/boards/${id}/recurrences`)
    ]);
    setTasks(taskData.tasks); setProjects(projectData.projects); setMembers(memberData.members); setRecurrences(recurrenceData.recurrences);
  };

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp?.initData) { setState('outside'); return; }
    webApp.ready(); webApp.expand();
    void api('/api/auth/telegram', json('POST', {initData: webApp.initData}))
      .then(async (auth) => {
        setUserId((auth as {userId: string}).userId);
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

  useEffect(() => {
    if (!userId || !board) return;
    setFiltersLoadedFor('');
    void api<{filters: Partial<TaskFilters>}>(`/api/boards/${board.id}/task-filters`)
      .then((data) => { setFilters({ ...defaultFilters, ...data.filters }); setFiltersLoadedFor(board.id); })
      .catch((error: Error) => setMessage(error.message));
  }, [userId, board?.id]);
  useEffect(() => {
    if (!userId || !board || filtersLoadedFor !== board.id) return;
    const timer = setTimeout(() => { void api(`/api/boards/${board.id}/task-filters`, json('PUT', { filters })).catch((error: Error) => setMessage(error.message)); }, 250);
    return () => clearTimeout(timer);
  }, [filters, filtersLoadedFor, userId, board?.id]);

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
    await action(() => api(`/api/boards/${board.id}/tasks`, json('POST', {
      title: title.trim(), description: description.trim() || null, projectId: project || null,
      assigneeUserId: assignee || null, deadline: deadline ? new Date(deadline).toISOString() : null, priority
    })), 'Задача создана');
    setTitle(''); setDescription(''); setProject(''); setAssignee(''); setDeadline(''); setPriority('normal');
  };
  const move = async (task: Task, status: TaskStatus) => {
    if (task.status === status) return;
    const waitReason = status === 'waiting' ? window.prompt('Почему ждём?')?.trim() : undefined;
    if (status === 'waiting' && !waitReason) return;
    const check = status === 'waiting' ? window.prompt('Дата следующей проверки, YYYY-MM-DD (необязательно)')?.trim() : undefined;
    const waitCheckAt = check ? dateInputToIso(check) : null;
    if (check && !waitCheckAt) { setMessage('Дата проверки: YYYY-MM-DD'); return; }
    const previous = tasks;
    try {
      await optimisticUpdate(previous, previous.map((item) => item.id === task.id ? { ...item, status } : item), setTasks,
        () => api(`/api/boards/${task.board_id}/tasks/${task.id}`, json('PATCH', { status, waitReason, waitCheckAt })));
      if (board) await loadBoard(board.id);
      setMessage(statusName[status]);
    } catch (error) {
      setMessage(`Статус не изменён: ${error instanceof Error ? error.message : 'Ошибка'}`);
    }
  };
  const editTask = async (task: Task) => {
    const nextTitle = window.prompt('Название', task.title)?.trim(); if (!nextTitle) return;
    const nextDescription = window.prompt('Описание', task.description ?? '')?.trim(); if (nextDescription === undefined) return;
    const nextDeadline = window.prompt('Дедлайн, YYYY-MM-DD (пусто — убрать)', task.deadline?.slice(0, 10) ?? '')?.trim(); if (nextDeadline === undefined) return;
    const nextPriority = window.confirm('Срочная задача?') ? 'urgent' : 'normal';
    const nextProject = window.prompt(`ID проекта (пусто — без проекта)\n${projects.map((item) => `${item.id}: ${item.name}`).join('\n')}`, task.project_id ?? '')?.trim(); if (nextProject === undefined) return;
    const nextAssignee = window.prompt(`ID исполнителя (пусто — без ответственного)\n${members.map((item) => `${item.id}: ${item.first_name}`).join('\n')}`, task.assignee_user_id ?? '')?.trim(); if (nextAssignee === undefined) return;
    const scope = task.recurrence_template_id && window.confirm('Изменить этот и все будущие повторы?') ? '?scope=future' : '';
    await action(() => api(`/api/boards/${task.board_id}/tasks/${task.id}${scope}`, json('PATCH', { title: nextTitle, description: nextDescription || null, deadline: nextDeadline ? new Date(`${nextDeadline}T00:00:00`).toISOString() : null, priority: nextPriority, projectId: nextProject || null, assigneeUserId: nextAssignee || null })), 'Задача обновлена');
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
  const addRecurrence = async () => {
    if (!board) return;
    const taskTitle = window.prompt('Название повторяющейся задачи')?.trim(); if (!taskTitle) return;
    const frequency = window.prompt('Правило: daily, weekdays, weekly или monthly', 'daily')?.trim() as Recurrence['frequency']; if (!frequency) return;
    const localTime = window.prompt('Время, HH:MM', '09:00')?.trim(); if (!localTime) return;
    const timezone = window.prompt('Часовой пояс', Intl.DateTimeFormat().resolvedOptions().timeZone)?.trim(); if (!timezone) return;
    const weekdayText = frequency === 'weekdays' || frequency === 'weekly' ? window.prompt('Дни недели: 0=вс, 1=пн … 6=сб, через запятую', frequency === 'weekdays' ? '1,2,3,4,5' : String(new Date().getDay()))?.trim() : undefined; if ((frequency === 'weekdays' || frequency === 'weekly') && !weekdayText) return;
    const weekdays = weekdayText?.split(',').map(Number);
    const dayText = frequency === 'monthly' ? window.prompt('День месяца', String(new Date().getDate()))?.trim() : undefined; if (frequency === 'monthly' && !dayText) return;
    const startDate = window.prompt('Дата начала, YYYY-MM-DD', new Date().toISOString().slice(0, 10))?.trim(); if (!startDate) return;
    const endDate = window.prompt('Дата окончания, YYYY-MM-DD (пусто — без окончания)', '')?.trim(); if (endDate === undefined) return;
    await action(() => api(`/api/boards/${board.id}/recurrences`, json('POST', { title: taskTitle, frequency, localTime, timezone, weekdays, dayOfMonth: dayText ? Number(dayText) : undefined, startAt: new Date(`${startDate}T00:00:00`).toISOString(), endAt: endDate ? new Date(`${endDate}T23:59:59`).toISOString() : null, projectId: project || null, assigneeUserId: assignee || null, priority })), 'Повтор создан');
  };
  const filteredTasks = board && !showArchive ? filterTasks(tasks, filters, userId) : tasks;
  const setFilter = <K extends keyof TaskFilters>(key: K, value: TaskFilters[K]) => setFilters((current) => ({ ...current, [key]: value }));
  const finishTouchDrag = (event: React.PointerEvent) => {
    const drag = touchDrag.current;
    if (drag.timer) clearTimeout(drag.timer);
    if (drag.active && drag.task) {
      const column = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-status]');
      const status = column?.dataset.status as TaskStatus | undefined;
      if (status) void move(drag.task, status);
    }
    touchDrag.current = { x: 0, y: 0, active: false };
    setDraggedTask(undefined);
  };
  const taskCard = (task: Task) => <article
    className={`task ${task.priority === 'urgent' ? 'urgent' : ''} ${task.overdue ? 'overdue' : ''} ${task.wait_check_due ? 'wait-due' : ''} ${!task.assignee_user_id ? 'unassigned' : ''} ${draggedTask === task.id ? 'dragging' : ''}`}
    key={task.id} draggable={Boolean(board && !task.archived_at)}
    onDragStart={(event) => { setDraggedTask(task.id); event.dataTransfer.setData('text/plain', task.id); }} onDragEnd={() => setDraggedTask(undefined)}
    onPointerDown={(event) => {
      if (event.pointerType !== 'touch' || !board || task.archived_at || (event.target as Element).closest('button,select,input,label')) return;
      const drag = { task, x: event.clientX, y: event.clientY, active: false, timer: undefined as ReturnType<typeof setTimeout> | undefined };
      const target = event.currentTarget;
      drag.timer = setTimeout(() => { drag.active = true; target.setPointerCapture(event.pointerId); setDraggedTask(task.id); navigator.vibrate?.(20); }, 350);
      touchDrag.current = drag;
    }}
    onPointerMove={(event) => {
      const drag = touchDrag.current;
      if (drag.task?.id !== task.id) return;
      if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 8 && drag.timer) { clearTimeout(drag.timer); drag.timer = undefined; }
      if (drag.active) event.preventDefault();
    }} onPointerUp={finishTouchDrag} onPointerCancel={finishTouchDrag}>
    <div onClick={() => { if (!board && task.board_id) setView(task.board_id); }}>
      <span>{task.board_name ?? statusName[task.status]}</span><strong>{task.title}</strong>
      {task.description && <small>{task.description}</small>}
      <div className="meta">{task.project_name && <small>{task.project_name}</small>}<small>{task.assignee_name ?? 'Без ответственного'}</small>{task.deadline && <small>До {new Date(task.deadline).toLocaleDateString('ru-RU')}</small>}</div>
      {task.overdue && <small className="flag">Дедлайн прошёл</small>}{task.wait_check_due && <small className="flag">Пора проверить ожидание</small>}{task.wait_reason && <small>Ждём: {task.wait_reason}</small>}
    </div>
    {board && <div className="actions">{task.archived_at ? <button onClick={() => action(() => api(`/api/boards/${task.board_id}/tasks/${task.id}/reopen`, {method: 'POST'}), 'Задача восстановлена')}>Восстановить</button> : <>
      <label className="status-control">Статус<select aria-label={`Статус задачи ${task.title}`} value={task.status} onChange={(event) => void move(task, event.target.value as TaskStatus)}>{statuses.map((status) => <option key={status} value={status}>{statusName[status]}</option>)}</select></label>
      <button onClick={() => editTask(task)}>Изменить</button><button onClick={() => action(() => api(`/api/boards/${task.board_id}/tasks/${task.id}`, {method: 'DELETE'}), 'Задача архивирована')}>В архив</button>
    </>}</div>}
  </article>;
  const taskList = <div className="task-list">{filteredTasks.map(taskCard)}</div>;
  const kanban = <div className="kanban" aria-label="Канбан">{statuses.map((status) => <section className="kanban-column" data-status={status} key={status}
    onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const task = tasks.find((item) => item.id === event.dataTransfer.getData('text/plain')); if (task) void move(task, status); }}>
    <h2>{statusName[status]} <small>{filteredTasks.filter((task) => task.status === status).length}</small></h2>
    <div className="kanban-tasks">{filteredTasks.filter((task) => task.status === status).map(taskCard)}</div>
  </section>)}</div>;
  const taskControls = board && !showArchive && <><div className="segmented"><button className={filters.scope === 'mine' ? 'active' : ''} onClick={() => setFilter('scope', 'mine')}>Мои</button><button className={filters.scope === 'all' ? 'active' : ''} onClick={() => setFilter('scope', 'all')}>Все</button></div>
    <div className="segmented"><button className={taskView === 'list' ? 'active' : ''} onClick={() => setTaskView('list')}>Список</button><button className={taskView === 'kanban' ? 'active' : ''} onClick={() => setTaskView('kanban')}>Канбан</button></div>
    <input className="search" type="search" value={filters.search} onChange={(event) => setFilter('search', event.target.value)} placeholder="Поиск по названию и описанию"/>
    <details className="filters"><summary>Фильтры</summary><div className="filter-grid">
      <select aria-label="Проект" value={filters.project} onChange={(event) => setFilter('project', event.target.value)}><option value="">Все проекты</option>{projects.filter((item) => !item.archived_at).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select aria-label="Исполнитель" value={filters.assignee} onChange={(event) => setFilter('assignee', event.target.value)}><option value="">Все исполнители</option>{members.map((member) => <option key={member.id} value={member.id}>{member.first_name}</option>)}</select>
      <select aria-label="Статус" value={filters.status} onChange={(event) => setFilter('status', event.target.value as TaskFilters['status'])}><option value="">Все статусы</option>{statuses.map((status) => <option key={status} value={status}>{statusName[status]}</option>)}</select>
      <select aria-label="Приоритет" value={filters.priority} onChange={(event) => setFilter('priority', event.target.value as TaskFilters['priority'])}><option value="">Любой приоритет</option><option value="normal">Обычный</option><option value="urgent">Срочный</option></select>
      <select aria-label="Дедлайн" value={filters.deadline} onChange={(event) => setFilter('deadline', event.target.value as TaskFilters['deadline'])}><option value="">Любой дедлайн</option><option value="overdue">Просрочено</option><option value="today">Сегодня</option><option value="week">7 дней</option><option value="none">Без дедлайна</option></select>
      <label className="checkbox"><input type="checkbox" checked={filters.unassigned} onChange={(event) => setFilter('unassigned', event.target.checked)}/> Без ответственного</label>
      <button className="secondary" onClick={() => setFilters(defaultFilters)}>Сбросить</button>
    </div></details></>;

  if (state === 'outside') return <main><section><p className="eyebrow">KAIROS TASKS</p><h1>Задачи живут<br/>в Telegram</h1><p>Откройте приложение через <a href="https://t.me/kairostask_bot">@kairostask_bot</a>.</p></section></main>;
  if (state === 'error') return <main><section><h1>Не удалось войти</h1><p>{message || 'Закройте приложение и откройте его снова через бота.'}</p></section></main>;
  if (state === 'loading') return <main><section><p>Загрузка…</p></section></main>;
  if (view === 'tasks') return <main><button className="back" onClick={() => setView('boards')}>← Доски</button><header><p className="eyebrow">ВСЕ МОИ ЗАДАЧИ</p><h1>Моя работа</h1></header>{taskList}{!tasks.length && <p>Назначенных задач пока нет.</p>}</main>;
  if (board) return <main><button className="back" onClick={() => setView('boards')}>← Доски</button><header><p className="eyebrow">{board.type === 'chat' ? 'ЧАТ-ДОСКА' : 'ЛИЧНАЯ ДОСКА'}</p><h1>{board.name}</h1></header>{board.status === 'frozen' ? <p className="notice">Бот больше не в чате. Данные сохранены, действия заморожены.</p> : board.status === 'draft' ? <section><p>Завершите настройку, чтобы команда начала работу.</p><button onClick={activate}>Активировать</button></section> : <><form className="create-task" onSubmit={(event) => { event.preventDefault(); void create(); }}><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Название задачи" maxLength={200} required/><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Описание"/><select value={project} onChange={(event) => setProject(event.target.value)}><option value="">Без проекта</option>{projects.filter((item) => !item.archived_at).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select value={assignee} onChange={(event) => setAssignee(event.target.value)}><option value="">Без ответственного</option>{members.map((member) => <option key={member.id} value={member.id}>{member.first_name}</option>)}</select><input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)}/><select value={priority} onChange={(event) => setPriority(event.target.value as Task['priority'])}><option value="normal">Обычный</option><option value="urgent">Срочный</option></select><button>Создать</button></form><section className="recurrences"><div className="project-row"><strong>Повторы</strong><button className="secondary" onClick={addRecurrence}>Добавить повтор</button></div>{recurrences.map((item) => <article className="recurrence" key={item.id}><span>{item.frequency} · {item.local_time} · {item.timezone}</span><strong>{item.title}</strong>{item.next_occurrence_at && <small>Следующий: {new Date(item.next_occurrence_at).toLocaleString('ru-RU')}</small>}<div className="actions">{!item.archived_at && <button onClick={() => action(() => api(`/api/boards/${board.id}/recurrences/${item.id}`, json('PATCH', {paused: !item.paused_at})), item.paused_at ? 'Повтор продолжен' : 'Повтор на паузе')}>{item.paused_at ? 'Продолжить' : 'Пауза'}</button>}<button onClick={() => action(() => api(`/api/boards/${board.id}/recurrences/${item.id}`, json('PATCH', {archived: true})), 'Повтор архивирован')}>В архив</button></div></article>)}</section><div className="project-row"><div>{projects.map((item) => <span key={item.id}><button className="link" onClick={() => item.archived_at ? action(() => api(`/api/boards/${board.id}/projects/${item.id}`, json('PATCH', {archived: false})), 'Проект восстановлен') : editProject(item)}>{item.name}{item.archived_at ? ' · восстановить' : ''}</button>{!item.archived_at && <button className="link" onClick={() => action(() => api(`/api/boards/${board.id}/projects/${item.id}`, json('PATCH', {archived: true})), 'Проект архивирован')}>×</button>}</span>)}</div><button className="secondary" onClick={addProject}>+ Проект</button></div><button className="secondary" onClick={() => { const next = !showArchive; setShowArchive(next); void loadBoard(board.id, next); }}>{showArchive ? 'Только активные' : 'Показать архив'}</button>{taskControls}{taskView === 'kanban' && !showArchive ? kanban : taskList}{!filteredTasks.length && <p>{filters.search ? 'Ничего не найдено.' : 'Задач в этом срезе пока нет.'}</p>}</>}{board.type === 'chat' && board.status !== 'frozen' && <button className="secondary" onClick={() => action(async () => { const result = await api<{url: string}>(`/api/boards/${board.id}/invites`, {method: 'POST'}); await navigator.clipboard.writeText(result.url); }, 'Ссылка скопирована', false)}>Скопировать приглашение</button>}{message && <p role="status">{message}</p>}</main>;
  return <main><header><p className="eyebrow">KAIROS TASKS</p><h1>Мои доски</h1><button className="tasks" onClick={() => { setMessage(''); setView('tasks'); }}>Все мои задачи</button></header><div className="board-list">{boards.map((item) => <button className="board" key={item.id} onClick={() => { setMessage(''); setView(item.id); }}><span>{item.type === 'chat' ? 'ЧАТ' : 'ЛИЧНАЯ'}{item.status === 'frozen' ? ' · ЗАМОРОЖЕНА' : ''}</span><strong>{item.name}</strong><small>{item.type === 'chat' ? 'Командное пространство' : 'Только ваши задачи'}</small></button>)}</div></main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
