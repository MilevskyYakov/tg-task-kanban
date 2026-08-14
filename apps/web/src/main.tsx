import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { api, ApiError, json } from './api';
import { AppShell, Avatar, Badge, CreateScreen, FieldRow, SectionHeader, SettingsScreen, Sheet, TasksScreen } from './app-shell';
import type { Board, Collaboration, Member, Project, Recurrence, Schedule } from './domain';
import { initialNavigation, type NavigationState } from './navigation';
import { activeFilterCount, dateInputToIso, defaultFilters, filterTasks, groupTasksByDeadline, groupTasksByProject, optimisticUpdate, resolveTaskBoard, restoreTaskViewState, serializeTaskViewState, statusDisplayName, type DeadlineGroup, type Task, type TaskFilters, type TaskStatus } from './tasks';

declare global { interface Window { Telegram?: { WebApp?: { initData: string; initDataUnsafe?: { start_param?: string }; ready(): void; expand(): void } } } }
type TaskView = 'list' | 'kanban';
const statuses = Object.keys(statusDisplayName) as TaskStatus[];
const storedTaskView = restoreTaskViewState(localStorage.getItem('tasks.viewState'));

function App() {
  const [state, setState] = useState<'loading' | 'outside' | 'error' | 'ready'>('loading');
  const [boards, setBoards] = useState<Board[]>([]);
  const [navigation, setNavigation] = useState<NavigationState>(initialNavigation);
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
  const [openTask, setOpenTask] = useState<Task>();
  const [collaboration, setCollaboration] = useState<Collaboration>();
  const [showArchive, setShowArchive] = useState(false);
  const [userId, setUserId] = useState('');
  const [taskView, setTaskView] = useState<TaskView>('list');
  const [grouping, setGrouping] = useState(storedTaskView.grouping);
  const [taskLoadState, setTaskLoadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [taskReload, setTaskReload] = useState(0);
  const [filters, setFilters] = useState<TaskFilters>(defaultFilters);
  const [filtersLoadedFor, setFiltersLoadedFor] = useState('');
  const [globalBoardId, setGlobalBoardId] = useState(() => localStorage.getItem('tasks.globalBoardId') ?? '');
  const [boardOverrideId, setBoardOverrideId] = useState<string>();
  const [recentBoardIds, setRecentBoardIds] = useState<string[]>(() => {
    try { const value = JSON.parse(localStorage.getItem('tasks.recentBoardIds') ?? '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, 3) : []; }
    catch { return []; }
  });
  const [boardSearch, setBoardSearch] = useState('');
  const [showBoardSheet, setShowBoardSheet] = useState(false);
  const [showFilterSheet, setShowFilterSheet] = useState(false);
  const [draggedTask, setDraggedTask] = useState<string>();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [recurrences, setRecurrences] = useState<Recurrence[]>([]);
  const [preview, setPreview] = useState('');
  const boardLoadVersion = useRef(0);
  const taskScroll = useRef(storedTaskView.scrollY);
  const touchDrag = useRef<{task?: Task; x: number; y: number; active: boolean; timer?: ReturnType<typeof setTimeout>}>({ x: 0, y: 0, active: false });
  const selectedTaskBoardId = resolveTaskBoard(globalBoardId, boardOverrideId, boards.map((item) => item.id));
  const board = navigation.screen === 'board'
    ? boards.find((item) => item.id === navigation.boardId)
    : navigation.screen === 'tasks' ? boards.find((item) => item.id === selectedTaskBoardId) : undefined;
  const activeBoardId = useRef<string | undefined>(undefined);
  activeBoardId.current = board?.id;
  const navigate = (next: NavigationState) => { setOpenTask(undefined); setCollaboration(undefined); setMessage(''); setNavigation(next); };
  const loadBoards = async () => { const data = await api<{boards: Board[]}>('/api/boards'); setBoards(data.boards); return data.boards; };
  const loadBoard = async (id: string, archive = showArchive) => {
    const version = ++boardLoadVersion.current;
    const [taskData, projectData, memberData, publicationData, recurrenceData] = await Promise.all([
      api<{tasks: Task[]}>(`/api/boards/${id}/tasks${archive ? '?archived=true' : ''}`), api<{projects: Project[]}>(`/api/boards/${id}/projects${archive ? '?archived=true' : ''}`), api<{members: Member[]}>(`/api/boards/${id}/members`), api<{schedules: Schedule[]}>(`/api/boards/${id}/publications`).catch(() => ({ schedules: [] })), api<{recurrences: Recurrence[]}>(`/api/boards/${id}/recurrences`)
    ]);
    if (version !== boardLoadVersion.current || activeBoardId.current !== id) return false;
    setTasks(taskData.tasks); setProjects(projectData.projects); setMembers(memberData.members); setSchedules(publicationData.schedules); setRecurrences(recurrenceData.recurrences);
    return true;
  };

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp?.initData) { setState('outside'); return; }
    webApp.ready(); webApp.expand();
    void api('/api/auth/telegram', json('POST', {initData: webApp.initData}))
      .then(async (auth) => {
        setUserId((auth as {userId: string}).userId);
        const token = webApp.initDataUnsafe?.start_param;
        if (token) { const board = await api<Board>('/api/board-links/redeem', json('POST', {token})); setBoardOverrideId(board.id); }
        await loadBoards(); setState('ready');
      })
      .catch((error: Error) => { setMessage(error.message); setState('error'); });
  }, []);
  useEffect(() => {
    if (state !== 'ready') return;
    if (navigation.screen === 'tasks') {
      setTaskLoadState('loading');
      if (selectedTaskBoardId) void loadBoard(selectedTaskBoardId).then((loaded) => { if (loaded) setTaskLoadState('ready'); }).catch((error: Error) => { setMessage(error.message); setTaskLoadState('error'); });
      else { ++boardLoadVersion.current; void api<{tasks: Task[]}>('/api/tasks/mine').then((data) => { if (!activeBoardId.current) { setTasks(data.tasks); setProjects([]); setMembers([]); setTaskLoadState('ready'); } }).catch((error: Error) => { setMessage(error.message); setTaskLoadState('error'); }); }
    }
    else if (navigation.screen === 'board') void loadBoard(navigation.boardId).catch((error: Error) => setMessage(error.message));
  }, [state, navigation, selectedTaskBoardId, taskReload]);

  useEffect(() => {
    if (navigation.screen !== 'tasks') return;
    requestAnimationFrame(() => window.scrollTo({ top: taskScroll.current }));
  }, [navigation.screen]);
  useEffect(() => {
    if (navigation.screen !== 'tasks') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      taskScroll.current = window.scrollY;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => localStorage.setItem('tasks.viewState', serializeTaskViewState({ ...storedTaskView, view: 'list', grouping, filters, scrollY: taskScroll.current })), 100);
    };
    window.addEventListener('scroll', save, { passive: true });
    save();
    return () => { window.removeEventListener('scroll', save); if (timer) clearTimeout(timer); taskScroll.current = window.scrollY; localStorage.setItem('tasks.viewState', serializeTaskViewState({ ...storedTaskView, view: 'list', grouping, filters, scrollY: taskScroll.current })); };
  }, [navigation.screen, grouping, filters]);

  useEffect(() => {
    if (!userId || !board) return;
    let cancelled = false;
    setFiltersLoadedFor('');
    void api<{filters: Partial<TaskFilters>}>(`/api/boards/${board.id}/task-filters`)
      .then((data) => { if (!cancelled) { setFilters({ ...defaultFilters, ...data.filters }); setFiltersLoadedFor(board.id); } })
      .catch((error: Error) => { if (!cancelled) setMessage(error.message); });
    return () => { cancelled = true; };
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
    try {
      const task = await api<Task & {notificationWarning?: string}>(`/api/boards/${board.id}/tasks`, json('POST', {
        title: title.trim(), description: description.trim() || null, projectId: project || null,
        assigneeUserId: assignee || null, deadline: deadline ? new Date(deadline).toISOString() : null, priority, notifyAssignee
      }));
      await loadBoard(board.id); setMessage(task.notificationWarning ?? 'Задача создана');
      setTitle(''); setDescription(''); setProject(''); setAssignee(''); setDeadline(''); setPriority('normal'); setNotifyAssignee(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Ошибка'); }
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
      const update = async (confirmIncompleteChecklist = false) => { await api(`/api/boards/${task.board_id}/tasks/${task.id}`, json('PATCH', { status, waitReason, waitCheckAt, confirmIncompleteChecklist })); };
      await optimisticUpdate(previous, previous.map((item) => item.id === task.id ? { ...item, status } : item), setTasks, async () => {
        try { await update(); }
        catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409 || !window.confirm('В чек-листе остались незавершённые пункты. Всё равно закрыть задачу?')) throw error;
          await update(true);
        }
      });
      if (board) await loadBoard(board.id);
      setMessage(statusDisplayName[status]);
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
    const notifyAssignee = Boolean(nextAssignee && nextAssignee !== task.assignee_user_id && window.confirm('Уведомить нового исполнителя?'));
    await action(() => api(`/api/boards/${task.board_id}/tasks/${task.id}${scope}`, json('PATCH', { title: nextTitle, description: nextDescription || null, deadline: nextDeadline ? new Date(`${nextDeadline}T00:00:00`).toISOString() : null, priority: nextPriority, projectId: nextProject || null, assigneeUserId: nextAssignee || null, notifyAssignee })), 'Задача обновлена');
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
  const chooseTaskBoard = (boardId: string) => {
    setBoardOverrideId(undefined);
    setGlobalBoardId(boardId);
    setFilters(defaultFilters);
    setFiltersLoadedFor('');
    setShowBoardSheet(false);
    setBoardSearch('');
    if (boardId) {
      localStorage.setItem('tasks.globalBoardId', boardId);
      setRecentBoardIds((current) => {
        const next = [boardId, ...current.filter((id) => id !== boardId)].slice(0, 3);
        localStorage.setItem('tasks.recentBoardIds', JSON.stringify(next));
        return next;
      });
    } else localStorage.removeItem('tasks.globalBoardId');
  };
  const filteredTasks = !showArchive ? filterTasks(tasks, filters, userId) : tasks;
  const filterCount = activeFilterCount(filters);
  const recentBoards = recentBoardIds.map((id) => boards.find((item) => item.id === id)).filter((item): item is Board => Boolean(item));
  const matchingBoards = boards.filter((item) => item.name.toLocaleLowerCase('ru-RU').includes(boardSearch.trim().toLocaleLowerCase('ru-RU')));
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
    <div onClick={() => { if (!board && task.board_id) setNavigation({ screen: 'board', boardId: task.board_id }); }}>
      <span>{task.board_name ?? statusDisplayName[task.status]}</span><strong>{task.title}</strong>
      {task.description && <small>{task.description}</small>}
      <div className="meta">{task.project_name && <small>{task.project_name}</small>}<small>{task.assignee_name ?? 'Без ответственного'}</small>{task.deadline && <small>До {new Date(task.deadline).toLocaleDateString('ru-RU')}</small>}</div>
      {task.overdue && <small className="flag">Дедлайн прошёл</small>}{task.wait_check_due && <small className="flag">Пора проверить ожидание</small>}{task.wait_reason && <small>Ждём: {task.wait_reason}</small>}
    </div>
    {board && <div className="actions"><button onClick={() => openCollaboration(task)}>Обсуждение</button>{task.archived_at ? <button onClick={() => action(() => api(`/api/boards/${task.board_id}/tasks/${task.id}/reopen`, {method: 'POST'}), 'Задача восстановлена')}>Восстановить</button> : <>
      <label className="status-control">Статус<select aria-label={`Статус задачи ${task.title}`} value={task.status} onChange={(event) => void move(task, event.target.value as TaskStatus)}>{statuses.map((status) => <option key={status} value={status}>{statusDisplayName[status]}</option>)}</select></label>
      <button onClick={() => editTask(task)}>Изменить</button><button onClick={() => action(() => api(`/api/boards/${task.board_id}/tasks/${task.id}`, {method: 'DELETE'}), 'Задача архивирована')}>В архив</button>
    </>}</div>}
  </article>;
  const taskList = <div className="task-list">{filteredTasks.map(taskCard)}</div>;
  const initials = (name?: string) => name?.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toLocaleUpperCase('ru-RU') || '—';
  const mainTaskRow = (task: Task) => <article className="main-task-row" key={task.id}>
    <input className="task-completion" type="checkbox" checked={task.status === 'done'} disabled={task.status === 'done'} aria-label={`Завершить задачу ${task.title}`} onChange={() => void move(task, 'done')}/>
    <div className="task-summary">
      <strong>{task.title}</strong>
      <div className="task-meta">
        <span>{task.project_name ?? task.board_name ?? 'Без проекта'}</span>
        {task.deadline && <span className={task.overdue ? 'deadline-overdue' : ''}>{task.overdue ? 'Дедлайн прошёл' : new Date(task.deadline).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</span>}
        {task.priority === 'urgent' && <Badge tone="urgent">Срочно</Badge>}
        {task.status === 'waiting' && <Badge tone="blocker">Блокер</Badge>}
        {Boolean(task.checklist_total) && <span>{task.checklist_completed}/{task.checklist_total}</span>}
      </div>
      {task.status === 'waiting' && task.wait_reason && <small className="blocker-reason">{task.wait_reason}</small>}
    </div>
    {task.assignee_name && <Avatar initials={initials(task.assignee_name)} label={`Исполнитель: ${task.assignee_name}`}/>}
  </article>;
  const deadlineGroups = groupTasksByDeadline(filteredTasks);
  const deadlineSections: { id: DeadlineGroup; label: string; icon: string }[] = [
    { id: 'overdue', label: 'Просрочено', icon: '!' }, { id: 'today', label: 'Сегодня', icon: '☼' },
    { id: 'upcoming', label: 'Ближайшие', icon: '◷' }, { id: 'none', label: 'Без срока', icon: '—' }
  ];
  const groupedTaskList = <div className="grouped-task-list">{grouping === 'deadline'
    ? deadlineSections.map((section) => deadlineGroups[section.id].length > 0 && <section className="task-section" key={section.id}><SectionHeader count={deadlineGroups[section.id].length} tone={section.id}><span className="section-title"><span aria-hidden="true">{section.icon}</span>{section.label}</span></SectionHeader>{deadlineGroups[section.id].map(mainTaskRow)}</section>)
    : groupTasksByProject(filteredTasks).map((group) => <section className="task-section project-section" key={group.id ?? 'none'}><SectionHeader count={group.tasks.length} tone="upcoming">{group.name}</SectionHeader>{group.tasks.map(mainTaskRow)}</section>)
  }</div>;
  const kanban = <div className="kanban" aria-label="Канбан">{statuses.map((status) => <section className="kanban-column" data-status={status} key={status}
    onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const task = tasks.find((item) => item.id === event.dataTransfer.getData('text/plain')); if (task) void move(task, status); }}>
    <h2>{statusDisplayName[status]} <small>{filteredTasks.filter((task) => task.status === status).length}</small></h2>
    <div className="kanban-tasks">{filteredTasks.filter((task) => task.status === status).map(taskCard)}</div>
  </section>)}</div>;
  const taskControls = board && !showArchive && <><div className="segmented"><button className={filters.scope === 'mine' ? 'active' : ''} onClick={() => setFilter('scope', 'mine')}>Мои</button><button className={filters.scope === 'all' ? 'active' : ''} onClick={() => setFilter('scope', 'all')}>Все</button></div>
    <div className="segmented"><button className={taskView === 'list' ? 'active' : ''} onClick={() => setTaskView('list')}>Список</button><button className={taskView === 'kanban' ? 'active' : ''} onClick={() => setTaskView('kanban')}>Канбан</button></div>
    <input className="search" type="search" value={filters.search} onChange={(event) => setFilter('search', event.target.value)} placeholder="Поиск по названию и описанию"/>
    <details className="filters"><summary>Фильтры</summary><div className="filter-grid">
      <select aria-label="Проект" value={filters.project} onChange={(event) => setFilter('project', event.target.value)}><option value="">Все проекты</option>{projects.filter((item) => !item.archived_at).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select aria-label="Исполнитель" value={filters.assignee} onChange={(event) => setFilter('assignee', event.target.value)}><option value="">Все исполнители</option>{members.map((member) => <option key={member.id} value={member.id}>{member.first_name}</option>)}</select>
      <select aria-label="Статус" value={filters.status} onChange={(event) => setFilter('status', event.target.value as TaskFilters['status'])}><option value="">Все статусы</option>{statuses.map((status) => <option key={status} value={status}>{statusDisplayName[status]}</option>)}</select>
      <select aria-label="Приоритет" value={filters.priority} onChange={(event) => setFilter('priority', event.target.value as TaskFilters['priority'])}><option value="">Любой приоритет</option><option value="normal">Обычный</option><option value="urgent">Срочный</option></select>
      <select aria-label="Дедлайн" value={filters.deadline} onChange={(event) => setFilter('deadline', event.target.value as TaskFilters['deadline'])}><option value="">Любой дедлайн</option><option value="overdue">Просрочено</option><option value="today">Сегодня</option><option value="week">7 дней</option><option value="none">Без дедлайна</option></select>
      <label className="checkbox"><input type="checkbox" checked={filters.unassigned} onChange={(event) => setFilter('unassigned', event.target.checked)}/> Без ответственного</label>
      <button className="secondary" onClick={() => setFilters(defaultFilters)}>Сбросить</button>
    </div></details></>;
  const taskToolbar = <>
    <div className="list-controls">
      <div className="grouping-tabs" role="tablist" aria-label="Группировка задач"><button role="tab" aria-selected={grouping === 'deadline'} className={grouping === 'deadline' ? 'active' : ''} onClick={() => setGrouping('deadline')}>По срокам</button><button role="tab" aria-selected={grouping === 'project'} className={grouping === 'project' ? 'active' : ''} onClick={() => setGrouping('project')}>По проектам</button></div>
      <div className="view-switch" aria-label="Вид задач"><button className="active" aria-label="Список" aria-pressed="true"><svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h3v3H5zM11 6h8M5 11h3v3H5zM11 11h8M5 16h3v3H5zM11 16h8"/></svg></button><button aria-label="Канбан" title="Канбан будет реализован отдельно" disabled><svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h4v14H5zM10 5h4v14h-4zM15 5h4v14h-4z"/></svg></button></div>
    </div>
    <div className="task-toolbar">
      <input className="search" type="search" value={filters.search} onChange={(event) => setFilter('search', event.target.value)} placeholder="Поиск задач" aria-label="Поиск задач"/>
      <button className="filter-trigger" onClick={() => setShowFilterSheet(true)}><svg className="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M7 14v6"/></svg><span className="filter-label">Фильтры</span>{filterCount > 0 && <span className="filter-count">{filterCount}</span>}</button>
    </div>
    {filterCount > 0 && <div className="filter-chips" aria-label="Активные фильтры">
      {filters.scope === 'all' && <button onClick={() => setFilter('scope', 'mine')}>Все задачи ×</button>}
      {filters.project && <button onClick={() => setFilter('project', '')}>{projects.find((item) => item.id === filters.project)?.name ?? 'Проект'} ×</button>}
      {filters.assignee && <button onClick={() => setFilter('assignee', '')}>{members.find((item) => item.id === filters.assignee)?.first_name ?? 'Исполнитель'} ×</button>}
      {filters.status && <button onClick={() => setFilter('status', '')}>{statusDisplayName[filters.status]} ×</button>}
      {filters.priority && <button onClick={() => setFilter('priority', '')}>{filters.priority === 'urgent' ? 'Срочные' : 'Обычные'} ×</button>}
      {filters.deadline && <button onClick={() => setFilter('deadline', '')}>Срок ×</button>}
      {filters.unassigned && <button onClick={() => setFilter('unassigned', false)}>Без ответственного ×</button>}
      <button className="reset-chip" onClick={() => setFilters(defaultFilters)}>Сбросить</button>
    </div>}
  </>;
  const boardSheet = showBoardSheet && <Sheet title="Доски" onClose={() => setShowBoardSheet(false)}>
    <input className="sheet-search" type="search" value={boardSearch} onChange={(event) => setBoardSearch(event.target.value)} placeholder="Найти доску" aria-label="Найти доску"/>
    {!boardSearch && recentBoards.length > 0 && <><h3 className="sheet-label">Недавние</h3><div className="sheet-options">{recentBoards.map((item) => <button key={`recent-${item.id}`} className={item.id === selectedTaskBoardId ? 'selected' : ''} onClick={() => chooseTaskBoard(item.id)}><span>{item.name}</span><small>{item.type === 'chat' ? 'Чат-доска' : 'Личная доска'}</small></button>)}</div></>}
    <h3 className="sheet-label">Все доски</h3>
    <div className="sheet-options">
      {!boardSearch && <button className={!selectedTaskBoardId ? 'selected' : ''} onClick={() => chooseTaskBoard('')}><span>Все доски</span><small>Назначенные вам задачи</small></button>}
      {matchingBoards.map((item) => <button key={item.id} className={item.id === selectedTaskBoardId ? 'selected' : ''} onClick={() => chooseTaskBoard(item.id)}><span>{item.name}</span><small>{item.type === 'chat' ? 'Чат-доска' : 'Личная доска'}</small></button>)}
    </div>
    <button className="manage-boards secondary" onClick={() => { setShowBoardSheet(false); navigate({ screen: 'settings' }); }}>Управление досками</button>
  </Sheet>;
  const filterSheet = showFilterSheet && <Sheet title="Фильтры" onClose={() => setShowFilterSheet(false)}>
    <div className="filter-sheet">
      {board && <FieldRow label="Задачи"><select value={filters.scope} onChange={(event) => setFilter('scope', event.target.value as TaskFilters['scope'])}><option value="mine">Мои</option><option value="all">Все</option></select></FieldRow>}
      {board && <FieldRow label="Проект"><select value={filters.project} onChange={(event) => setFilter('project', event.target.value)}><option value="">Все проекты</option>{projects.filter((item) => !item.archived_at).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></FieldRow>}
      {board && <FieldRow label="Исполнитель"><select value={filters.assignee} onChange={(event) => setFilter('assignee', event.target.value)}><option value="">Все исполнители</option>{members.map((member) => <option key={member.id} value={member.id}>{member.first_name}</option>)}</select></FieldRow>}
      <FieldRow label="Статус"><select value={filters.status} onChange={(event) => setFilter('status', event.target.value as TaskFilters['status'])}><option value="">Без завершённых</option>{statuses.map((status) => <option key={status} value={status}>{statusDisplayName[status]}</option>)}</select></FieldRow>
      <FieldRow label="Приоритет"><select value={filters.priority} onChange={(event) => setFilter('priority', event.target.value as TaskFilters['priority'])}><option value="">Любой</option><option value="normal">Обычный</option><option value="urgent">Срочный</option></select></FieldRow>
      <FieldRow label="Дедлайн"><select value={filters.deadline} onChange={(event) => setFilter('deadline', event.target.value as TaskFilters['deadline'])}><option value="">Любой</option><option value="overdue">Просрочено</option><option value="today">Сегодня</option><option value="week">7 дней</option><option value="none">Без дедлайна</option></select></FieldRow>
      <label className="checkbox"><input type="checkbox" checked={filters.unassigned} onChange={(event) => setFilter('unassigned', event.target.checked)}/> Без ответственного</label>
      <div className="sheet-actions"><button className="secondary" onClick={() => setFilters(defaultFilters)}>Сбросить</button><button onClick={() => setShowFilterSheet(false)}>Показать задачи</button></div>
    </div>
  </Sheet>;

  if (openTask && collaboration) return <AppShell message={message} navigation={navigation} navigate={navigate}><button className="back" onClick={() => { setOpenTask(undefined); setCollaboration(undefined); }}>← К доске</button><header><p className="eyebrow">КАРТОЧКА ЗАДАЧИ</p><h1>{openTask.title}</h1></header><section className="collaboration"><h2>Чек-лист</h2>{collaboration.checklist.map((item) => <label key={item.id}><input type="checkbox" checked={Boolean(item.completed_at)} onChange={() => collaborationAction(`/api/boards/${openTask.board_id}/tasks/${openTask.id}/checklist/${item.id}`, json('PATCH', {completed: !item.completed_at}))}/>{item.text}</label>)}<button onClick={() => { const text = window.prompt('Новый пункт')?.trim(); if (text) void collaborationAction(`/api/boards/${openTask.board_id}/tasks/${openTask.id}/checklist`, json('POST', {text})); }}>Добавить пункт</button><h2>Комментарии</h2>{collaboration.comments.map((item) => <p key={item.id}><strong>{item.author_name}</strong> · {new Date(item.created_at).toLocaleString('ru-RU')}<br/>{item.body}</p>)}<button onClick={() => { const body = window.prompt('Комментарий')?.trim(); if (body) void collaborationAction(`/api/boards/${openTask.board_id}/tasks/${openTask.id}/comments`, json('POST', {body})); }}>Комментировать</button><h2>Вложения</h2>{collaboration.attachments.map((item) => <p key={item.id}>{item.url ? <a href={item.url}>{item.url}</a> : item.file_name ?? 'Telegram-файл'}</p>)}<button onClick={() => { const url = window.prompt('Ссылка')?.trim(); if (url) void collaborationAction(`/api/boards/${openTask.board_id}/tasks/${openTask.id}/attachments`, json('POST', {kind: 'url', url})); }}>Добавить ссылку</button><h2>История</h2>{collaboration.timeline.map((item) => <p key={item.id}>{item.actor_name} · {item.action} · {new Date(item.created_at).toLocaleString('ru-RU')}</p>)}</section></AppShell>;
  const saveSchedule = async (schedule: Schedule, previewOnly = false) => {
    if (!board) return;
    const result = await api<Schedule | {messages: string[]}>(`/api/boards/${board.id}/publications/${schedule.kind}${previewOnly ? '/preview' : ''}`, json(previewOnly ? 'POST' : 'PUT', schedule));
    if ('messages' in result) setPreview(result.messages.join('\n\n———\n\n')); else setSchedules((items) => items.map((item) => item.kind === result.kind ? result : item));
  };
  const publicationSettings = board?.type === 'chat' && schedules.length ? <details className="publications"><summary>Публикации в чат</summary>{schedules.map((schedule) => <fieldset key={schedule.kind}><legend>{schedule.kind === 'daily' ? 'План дня' : 'Недельная сводка'}</legend><label><input type="checkbox" checked={schedule.enabled} onChange={(event) => setSchedules((items) => items.map((item) => item.kind === schedule.kind ? {...item, enabled: event.target.checked} : item))}/> Включена</label><label>Дни (1–7)<input value={schedule.weekdays.join(',')} onChange={(event) => setSchedules((items) => items.map((item) => item.kind === schedule.kind ? {...item, weekdays: event.target.value.split(',').map(Number).filter(Boolean)} : item))}/></label><label>Время<input type="time" value={schedule.local_time} onChange={(event) => setSchedules((items) => items.map((item) => item.kind === schedule.kind ? {...item, local_time: event.target.value} : item))}/></label><label>Часовой пояс<input value={schedule.timezone} onChange={(event) => setSchedules((items) => items.map((item) => item.kind === schedule.kind ? {...item, timezone: event.target.value} : item))}/></label><div className="status-options">{Object.entries(statusDisplayName).map(([status, name]) => <label key={status}><input type="checkbox" checked={schedule.included_statuses.includes(status as TaskStatus)} onChange={(event) => setSchedules((items) => items.map((item) => item.kind === schedule.kind ? {...item, included_statuses: event.target.checked ? [...item.included_statuses, status as TaskStatus] : item.included_statuses.filter((value) => value !== status)} : item))}/>{name}</label>)}</div><div className="actions"><button onClick={() => void action(() => saveSchedule(schedule), 'Расписание сохранено', false)}>Сохранить</button><button className="secondary" onClick={() => void action(() => saveSchedule(schedule, true), 'Предпросмотр готов', false)}>Предпросмотр</button></div></fieldset>)}{preview && <pre>{preview}</pre>}</details> : null;

  if (state === 'outside') return <main><section><p className="eyebrow">KAIROS TASKS</p><h1>Задачи живут<br/>в Telegram</h1><p>Откройте приложение через <a href="https://t.me/kairostask_bot">@kairostask_bot</a>.</p></section></main>;
  if (state === 'error') return <main><section><h1>Не удалось войти</h1><p>{message || 'Закройте приложение и откройте его снова через бота.'}</p></section></main>;
  if (state === 'loading') return <main><section><p>Загрузка…</p></section></main>;
  if (navigation.screen === 'tasks') return <AppShell message={message} navigation={navigation} navigate={navigate}><TasksScreen boardName={board?.name ?? 'Все доски'} onSelectBoard={() => setShowBoardSheet(true)}>{taskToolbar}{taskLoadState === 'loading' ? <p className="task-state">Загрузка задач…</p> : taskLoadState === 'error' ? <div className="task-state"><p>Не удалось загрузить задачи.</p><button onClick={() => setTaskReload((value) => value + 1)}>Повторить</button></div> : groupedTaskList}{taskLoadState === 'ready' && !filteredTasks.length && <p className="task-state">{tasks.length ? 'Задач по этим условиям нет.' : 'Назначенных задач пока нет.'}</p>}{boardOverrideId && <p className="context-note">Доска открыта из Telegram-чата и не заменяет ваш обычный выбор.</p>}{boardSheet}{filterSheet}</TasksScreen></AppShell>;
  if (board) return <AppShell message={message} navigation={navigation} navigate={navigate}><button className="back" onClick={() => navigate({ screen: 'tasks' })}>← Задачи</button><header><p className="eyebrow">{board.type === 'chat' ? 'ЧАТ-ДОСКА' : 'ЛИЧНАЯ ДОСКА'}</p><h1>{board.name}</h1></header>{publicationSettings}{board.status === 'frozen' ? <p className="notice">Бот больше не в чате. Данные сохранены, действия заморожены.</p> : board.status === 'draft' ? <section><p>Завершите настройку, чтобы команда начала работу.</p><button onClick={activate}>Активировать</button></section> : <><form className="create-task" onSubmit={(event) => { event.preventDefault(); void create(); }}><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Название задачи" maxLength={200} required/><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Описание"/><select value={project} onChange={(event) => setProject(event.target.value)}><option value="">Без проекта</option>{projects.filter((item) => !item.archived_at).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select value={assignee} onChange={(event) => setAssignee(event.target.value)}><option value="">Без ответственного</option>{members.map((member) => <option key={member.id} value={member.id}>{member.first_name}</option>)}</select><input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)}/><select value={priority} onChange={(event) => setPriority(event.target.value as Task['priority'])}><option value="normal">Обычный</option><option value="urgent">Срочный</option></select><label className="checkbox"><input type="checkbox" checked={notifyAssignee} disabled={!assignee} onChange={(event) => setNotifyAssignee(event.target.checked)}/> Уведомить исполнителя</label><button>Создать</button></form><section className="recurrences"><div className="project-row"><strong>Повторы</strong><button className="secondary" onClick={addRecurrence}>Добавить повтор</button></div>{recurrences.map((item) => <article className="recurrence" key={item.id}><span>{item.frequency} · {item.local_time} · {item.timezone}</span><strong>{item.title}</strong>{item.next_occurrence_at && <small>Следующий: {new Date(item.next_occurrence_at).toLocaleString('ru-RU')}</small>}<div className="actions">{!item.archived_at && <button onClick={() => action(() => api(`/api/boards/${board.id}/recurrences/${item.id}`, json('PATCH', {paused: !item.paused_at})), item.paused_at ? 'Повтор продолжен' : 'Повтор на паузе')}>{item.paused_at ? 'Продолжить' : 'Пауза'}</button>}<button onClick={() => action(() => api(`/api/boards/${board.id}/recurrences/${item.id}`, json('PATCH', {archived: true})), 'Повтор архивирован')}>В архив</button></div></article>)}</section><div className="project-row"><div>{projects.map((item) => <span key={item.id}><button className="link" onClick={() => item.archived_at ? action(() => api(`/api/boards/${board.id}/projects/${item.id}`, json('PATCH', {archived: false})), 'Проект восстановлен') : editProject(item)}>{item.name}{item.archived_at ? ' · восстановить' : ''}</button>{!item.archived_at && <button className="link" onClick={() => action(() => api(`/api/boards/${board.id}/projects/${item.id}`, json('PATCH', {archived: true})), 'Проект архивирован')}>×</button>}</span>)}</div><button className="secondary" onClick={addProject}>+ Проект</button></div><button className="secondary" onClick={() => { const next = !showArchive; setShowArchive(next); void loadBoard(board.id, next); }}>{showArchive ? 'Только активные' : 'Показать архив'}</button>{taskControls}{taskView === 'kanban' && !showArchive ? kanban : taskList}{!filteredTasks.length && <p>{filters.search ? 'Ничего не найдено.' : 'Задач в этом срезе пока нет.'}</p>}</>}{board.type === 'chat' && board.status !== 'frozen' && <button className="secondary" onClick={() => action(async () => { const result = await api<{url: string}>(`/api/boards/${board.id}/invites`, {method: 'POST'}); await navigator.clipboard.writeText(result.url); }, 'Ссылка скопирована', false)}>Скопировать приглашение</button>}</AppShell>;
  const boardList = <div className="board-list">{boards.map((item) => <button className="board" key={item.id} onClick={() => { setMessage(''); setNavigation({ screen: 'board', boardId: item.id }); }}><span>{item.type === 'chat' ? 'ЧАТ' : 'ЛИЧНАЯ'}{item.status === 'frozen' ? ' · ЗАМОРОЖЕНА' : ''}</span><strong>{item.name}</strong><small>{item.type === 'chat' ? 'Командное пространство' : 'Только ваши задачи'}</small></button>)}</div>;
  return <AppShell message={message} navigation={navigation} navigate={navigate}>{navigation.screen === 'create' ? <CreateScreen>{boardList}</CreateScreen> : <SettingsScreen>{boardList}</SettingsScreen>}</AppShell>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
