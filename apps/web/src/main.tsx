import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import './style.css';
import { api, ApiError, json } from './api';
import { ActionRow, AppShell, Avatar, Badge, ChoiceAction, ChoiceRow, CreateScreen, Disclosure, EnvironmentStatus, FieldRow, Icon, SectionHeader, SettingsScreen, Sheet, Skeleton, TaskGlyph, TasksScreen, type IconName } from './app-shell';
import type { Board, Collaboration, Member, Project, Recurrence, Schedule } from './domain';
import { countLabel, initialNavigation, settingsSections, type NavigationState } from './navigation';
import { TaskDetails } from './task-details';
import { DeadlineField } from './deadline-field';
import { deadlineDraft, deadlinePatch, formatTaskDeadline, isTaskOverdue } from './tasks';
import { activeFilterCount, dateInputToIso, defaultFilters, filterTasks, groupTasksByDeadline, groupTasksByProject, optimisticUpdate, presentCreatedTask, resolveKanbanSwipe, resolveStartupContext, resolveTaskBoard, restoreTaskViewState, serializeTaskViewState, statusDisplayName, taskStatusRestriction, validateTaskCreate, type DeadlineGroup, type Task, type TaskFilters, type TaskStatus } from './tasks';
import { FoundationFixture } from './visual-fixture';
import { readStorage, removeStorage, writeStorage } from './environment';
import { isBacklogTask } from './tasks';
import { BulkCreate, type BulkDraft } from './bulk-create';
import { ClaimTask, runClaim } from './claim-task';
import { PairBoard, PairInvite } from './pair-board';
import { boardTypeName } from './domain';
import { EntryGuide, GroupSetup, type EntryPath } from './bot-entry';
import { McpConnections } from './mcp-connections';

type TaskView = 'list' | 'kanban';
type FilterChoice = 'project' | 'assignee' | 'status' | 'priority' | 'deadline';
type CreateChoice = 'board' | 'project' | 'assignee' | 'priority' | 'status';
const statuses = Object.keys(statusDisplayName) as TaskStatus[];
window.Telegram?.WebApp?.ready();
window.Telegram?.WebApp?.expand();
const storedTaskView = restoreTaskViewState(readStorage('tasks.viewState'));
function App() {
  const [state, setState] = useState<'loading' | 'outside' | 'error' | 'ready'>('loading');
  const [boards, setBoards] = useState<Board[]>([]);
  const [pairFlow, setPairFlow] = useState<{board?: Board}>();
  const [pairInvite, setPairInvite] = useState('');
  const [entryPath, setEntryPath] = useState<EntryPath>();
  const [boardLinkError, setBoardLinkError] = useState<'invalid' | 'network'>();
  const [startupRetry, setStartupRetry] = useState(0);
  const [accessLost, setAccessLost] = useState(false);
  const [navigation, setNavigation] = useState<NavigationState>(initialNavigation);
  const [message, setMessage] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const [project, setProject] = useState('');
  const [description, setDescription] = useState('');
  const [due, setDue] = useState(() => deadlineDraft());
  const [createStatus, setCreateStatus] = useState<TaskStatus>('todo');
  const [statusChoice, setStatusChoice] = useState<TaskStatus>('todo');
  const [createWaitReason, setCreateWaitReason] = useState('');
  const [createBlockerId, setCreateBlockerId] = useState('');
  const [createWaitCheck, setCreateWaitCheck] = useState('');
  const [createTasks, setCreateTasks] = useState<Task[]>([]);
  const [createBlockerOpen, setCreateBlockerOpen] = useState(false);
  const [blockerKind, setBlockerKind] = useState<'external' | 'task'>('external');
  const [blockerSearch, setBlockerSearch] = useState('');
  const [priority, setPriority] = useState<Task['priority']>('normal');
  const [notifyAssignee, setNotifyAssignee] = useState(false);
  const [openTask, setOpenTask] = useState<Task>();
  const [collaboration, setCollaboration] = useState<Collaboration>();
  const [detailProjects, setDetailProjects] = useState<Project[]>([]);
  const [detailMembers, setDetailMembers] = useState<Member[]>([]);
  const [detailTasks, setDetailTasks] = useState<Task[]>([]);
  const [taskLinkError, setTaskLinkError] = useState<403 | 404>();
  const [showArchive, setShowArchive] = useState(false);
  const [userId, setUserId] = useState('');
  const [taskView, setTaskView] = useState<TaskView>(storedTaskView.view);
  const [grouping, setGrouping] = useState(storedTaskView.grouping);
  const [kanbanStatus, setKanbanStatus] = useState(storedTaskView.kanbanStatus);
  const [taskLoadState, setTaskLoadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [taskReload, setTaskReload] = useState(0);
  const [filters, setFilters] = useState<TaskFilters>(defaultFilters);
  const [filtersLoadedFor, setFiltersLoadedFor] = useState('');
  const [globalBoardId, setGlobalBoardId] = useState(() => readStorage('tasks.globalBoardId') ?? '');
  const [boardOverrideId, setBoardOverrideId] = useState<string>();
  const [recentBoardIds, setRecentBoardIds] = useState<string[]>(() => {
    try { const value = JSON.parse(readStorage('tasks.recentBoardIds') ?? '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, 3) : []; }
    catch { return []; }
  });
  const [boardSearch, setBoardSearch] = useState('');
  const [showBoardSheet, setShowBoardSheet] = useState(false);
  const [showFilterSheet, setShowFilterSheet] = useState(false);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [filterChoice, setFilterChoice] = useState<FilterChoice>();
  const [kanbanStatusTask, setKanbanStatusTask] = useState<Task>();
  const [draggedTask, setDraggedTask] = useState<string>();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [recurrences, setRecurrences] = useState<Recurrence[]>([]);
  const [preview, setPreview] = useState('');
  const [profileName, setProfileName] = useState('Пользователь Telegram');
  const [profileUsername, setProfileUsername] = useState('');
  const [recurrenceFrequency, setRecurrenceFrequency] = useState<Recurrence['frequency']>('daily');
  const [recurrenceProjectId, setRecurrenceProjectId] = useState('');
  const [recurrenceAssigneeId, setRecurrenceAssigneeId] = useState('');
  const [recurrencePriority, setRecurrencePriority] = useState<Task['priority']>('normal');
  const [settingsCounts, setSettingsCounts] = useState<{ projects: number; automations: number }>();
  const [createBoardId, setCreateBoardId] = useState('');
  const [createOrigin, setCreateOrigin] = useState<NavigationState>(initialNavigation);
  const [createPending, setCreatePending] = useState(false);
  const [backlog, setBacklog] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkDraft, setBulkDraft] = useState<BulkDraft>();
  const [claimingTask, setClaimingTask] = useState<Task>();
  const [claimingRow, setClaimingRow] = useState<string>();
  const backlogClaimLock = useRef(false);
  // Debounce timers for settings autosave (issue #129); declared before any early return
  // so the hook order stays stable across screens.
  const scheduleTimer = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [createUncertain, setCreateUncertain] = useState(false);
  const [createReset, setCreateReset] = useState(0);
  const [projectCreatePending, setProjectCreatePending] = useState(false);
  const [createChoice, setCreateChoice] = useState<CreateChoice>();
  const boardLoadVersion = useRef(0);
  const projectCreateLock = useRef(false);
  const createLock = useRef(false);
  const createRequest = useRef<{ payload: string; id: string } | undefined>(undefined);
  // Track where the task list was scrolled so «Назад к задачам» restores it (issue #122).
  const listScrollY = useRef(storedTaskView.scrollY);
  // Track open generations so a late response cannot overwrite a newer open or a closed card (issue #122).
  const taskScrollSequence = useRef(0);
  const taskScroll = useRef(storedTaskView.scrollY);
  // True while the DOM shows the details card instead of the task list; card scrolling and the
  // scroll clamp after the DOM swap must not overwrite the list snapshot (issue #122).
  const listSnapshotActive = useRef(true);
  listSnapshotActive.current = navigation.screen !== 'tasks' || openTask !== undefined;
  const swipeStart = useRef<{x: number; y: number} | null>(null);
  const selectedTaskBoardId = resolveTaskBoard(globalBoardId, boardOverrideId, boards.map((item) => item.id));
  const board = navigation.screen === 'board'
    ? boards.find((item) => item.id === navigation.boardId)
    : navigation.screen === 'tasks' ? boards.find((item) => item.id === selectedTaskBoardId)
      : (navigation.screen === 'settings-workspace' || navigation.screen === 'settings-automation') && navigation.boardId
        ? boards.find((item) => item.id === navigation.boardId) : undefined;
  const activeBoardId = useRef<string | undefined>(undefined);
  activeBoardId.current = board?.id;
  const navigate = (next: NavigationState) => {
    if (createLock.current || createUncertain) return;
    if (next.screen === 'create' && navigation.screen !== 'create') {
      setCreateOrigin(navigation.screen === 'board' ? navigation : { screen: 'tasks' });
      setCreateBoardId(board?.status === 'active' ? board.id : '');
      setProject(board ? filters.project : '');
    }
    setOpenTask(undefined); setCollaboration(undefined); setDetailProjects([]); setDetailMembers([]); setDetailTasks([]); setMessage(''); setNavigation(next);
  };
  const loadBoards = async () => { const data = await api<{boards: Board[]}>('/api/boards'); setBoards(data.boards); return data.boards; };
  const loadBoard = async (id: string, archive = showArchive) => {
    const version = ++boardLoadVersion.current;
    const [taskData, projectData, memberData, publicationData, recurrenceData] = await Promise.all([
      api<{tasks: Task[]}>(`/api/boards/${id}/tasks${archive ? '?archived=true' : ''}`), api<{projects: Project[]}>(`/api/boards/${id}/projects${archive ? '?archived=true' : ''}`), api<{members: Member[]}>(`/api/boards/${id}/members`), boards.find((item) => item.id === id)?.type === 'chat' ? api<{schedules: Schedule[]}>(`/api/boards/${id}/publications`).catch(() => ({ schedules: [] })) : Promise.resolve({ schedules: [] }), api<{recurrences: Recurrence[]}>(`/api/boards/${id}/recurrences`)
    ]);
    if (version !== boardLoadVersion.current || activeBoardId.current !== id) return false;
    setTasks(taskData.tasks); setProjects(projectData.projects); setMembers(memberData.members); setSchedules(publicationData.schedules); setRecurrences(recurrenceData.recurrences);
    return true;
  };
  const loadTaskDetails = async (task: Task) => {
    const openedAt = ++taskScrollSequence.current;
    const [nextCollaboration, nextProjects, nextMembers, nextTasks] = await Promise.all([
      api<Collaboration>(`/api/boards/${task.board_id}/tasks/${task.id}/collaboration`),
      api<{projects: Project[]}>(`/api/boards/${task.board_id}/projects`),
      api<{members: Member[]}>(`/api/boards/${task.board_id}/members`),
      api<{tasks: Task[]}>(`/api/boards/${task.board_id}/tasks`)
    ]);
    if (openedAt !== taskScrollSequence.current) return;
    // Deep link: no source list to restore, so the list snapshot stays untouched (issue #122).
    listScrollY.current = 0;
    taskScroll.current = 0;
    setOpenTask(task); setCollaboration(nextCollaboration); setDetailProjects(nextProjects.projects); setDetailMembers(nextMembers.members); setDetailTasks(nextTasks.tasks); setMessage('');
  };

  useEffect(() => {
    if (createReset) document.querySelector<HTMLTextAreaElement>('.create-title textarea')?.focus();
  }, [createReset]);

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp?.initData) { setState('outside'); return; }
    setState('loading'); setBoardLinkError(undefined);
    void api('/api/auth/telegram', json('POST', {initData: webApp.initData}))
      .then(async (auth) => {
        setUserId((auth as {userId: string}).userId);
        const telegramUser = webApp.initDataUnsafe?.user;
        if (telegramUser) {
          setProfileName([telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' '));
          setProfileUsername(telegramUser.username ? `@${telegramUser.username}` : '');
        }
        const startup = resolveStartupContext(webApp.initDataUnsafe?.start_param);
        if (startup.surface === 'entry') setEntryPath(startup.path);
        if (startup.surface === 'board-link') {
          if (startup.token.startsWith('pair_')) setPairInvite(startup.token);
          else {
            try { const board = await api<Board>('/api/board-links/redeem', json('POST', {token: startup.token})); setBoardOverrideId(board.id); }
            catch (error) { setBoardLinkError(error instanceof ApiError && [400, 403, 404].includes(error.status) ? 'invalid' : 'network'); }
          }
        }
        await loadBoards();
        if (startup.surface === 'invalid-task') setTaskLinkError(404);
        if (startup.surface === 'task') {
          setBoardOverrideId(startup.boardId);
          try {
            const task = await api<Task>(`/api/boards/${startup.boardId}/tasks/${startup.taskId}`);
            await loadTaskDetails(task);
          } catch (error) {
            if (error instanceof ApiError && (error.status === 403 || error.status === 404)) setTaskLinkError(error.status);
            else throw error;
          }
        }
        setState('ready');
      })
      .catch((error: Error) => { setMessage(error.message); setState('error'); });
  }, [startupRetry]);
  useEffect(() => {
    if (state !== 'ready' || pairFlow) return;
    const currentId = openTask?.board_id ?? (navigation.screen === 'create' ? createBoardId : board?.id);
    if (!currentId || boards.find((item) => item.id === currentId)?.type !== 'pair') return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const current = await api<Board>(`/api/boards/${currentId}`);
        if (cancelled) return;
        setBoards((items) => items.map((item) => item.id === current.id ? current : item));
        setTasks((items) => items.map((item) => item.board_id === current.id ? { ...item, board_status: current.status } : item));
        setOpenTask((item) => item?.board_id === current.id ? { ...item, board_status: current.status } : item);
      } catch (error) {
        if (!cancelled && error instanceof ApiError && [403, 404].includes(error.status)) {
          ++boardLoadVersion.current;
          setBoards((items) => items.filter((item) => item.id !== currentId)); setTasks([]); setProjects([]); setMembers([]);
          setOpenTask(undefined); setCollaboration(undefined); setDetailProjects([]); setDetailMembers([]); setDetailTasks([]);
          setBulkOpen(false); setBulkDraft(undefined); setClaimingTask(undefined); setCreateTasks([]); setAccessLost(true);
        }
      }
    };
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = setInterval(visible, 5000);
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible); };
  }, [state, board?.id, openTask?.board_id, navigation.screen, createBoardId, pairFlow]);
  useEffect(() => {
    if (state !== 'ready') return;

    if (navigation.screen === 'tasks') {
      setTaskLoadState('loading');
      if (selectedTaskBoardId) void loadBoard(selectedTaskBoardId).then((loaded) => { if (loaded) setTaskLoadState('ready'); }).catch((error: Error) => { setMessage(error.message); setTaskLoadState('error'); });
      else { ++boardLoadVersion.current; void api<{tasks: Task[]}>('/api/tasks/mine').then((data) => { if (!activeBoardId.current) { setTasks(data.tasks); setProjects([]); setMembers([]); setTaskLoadState('ready'); } }).catch((error: Error) => { setMessage(error.message); setTaskLoadState('error'); }); }
    }
    else if (navigation.screen === 'board') void loadBoard(navigation.boardId).catch((error: Error) => setMessage(error.message));
    else if ((navigation.screen === 'settings-workspace' || navigation.screen === 'settings-automation') && navigation.boardId) void loadBoard(navigation.boardId).catch((error: Error) => setMessage(error.message));
  }, [state, navigation, selectedTaskBoardId, taskReload]);
  useEffect(() => {
    if (navigation.screen !== 'create') return;
    setProjects([]); setMembers([]); setCreateTasks([]);
    if (!createBoardId) return;
    let cancelled = false;
    void Promise.all([
      api<{projects: Project[]}>(`/api/boards/${createBoardId}/projects`),
      api<{members: Member[]}>(`/api/boards/${createBoardId}/members`),
      api<{tasks: Task[]}>(`/api/boards/${createBoardId}/tasks`)
    ]).then(([projectData, memberData, taskData]) => {
      if (!cancelled) { setProjects(projectData.projects); setMembers(memberData.members); setCreateTasks(taskData.tasks); }
    }).catch((error: Error) => { if (!cancelled) setMessage(error.message); });
    return () => { cancelled = true; };
  }, [navigation.screen, createBoardId]);
  useEffect(() => {
    if (navigation.screen !== 'settings' || !boards.length) return;
    let cancelled = false;
    void Promise.all(boards.map(async (item: Board) => {
      const [projectData, recurrenceData] = await Promise.all([
        api<{projects: Project[]}>(`/api/boards/${item.id}/projects`),
        api<{recurrences: Recurrence[]}>(`/api/boards/${item.id}/recurrences`)
      ]);
      return {
        projects: projectData.projects.filter((project: Project) => !project.archived_at).length,
        automations: recurrenceData.recurrences.filter((recurrence: Recurrence) => !recurrence.archived_at && !recurrence.paused_at).length
      };
    })).then((counts) => {
      if (!cancelled) setSettingsCounts(counts.reduce((total: { projects: number; automations: number }, count: { projects: number; automations: number }) => ({ projects: total.projects + count.projects, automations: total.automations + count.automations }), { projects: 0, automations: 0 }));
    }).catch(() => { if (!cancelled) setSettingsCounts(undefined); });
    return () => { cancelled = true; };
  }, [navigation.screen, boards]);

  useEffect(() => {
    if (navigation.screen !== 'tasks') return;
    requestAnimationFrame(() => window.scrollTo({ top: taskScroll.current }));
  }, [navigation.screen]);
  useEffect(() => {
    if (navigation.screen !== 'tasks') return;
    // Synchronous ref: flips before any scroll event from the DOM swap can fire (issue #122).
    const paused = () => listSnapshotActive.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      if (paused()) return;
      listScrollY.current = window.scrollY;
      taskScroll.current = listScrollY.current;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => writeStorage('tasks.viewState', serializeTaskViewState({ view: taskView, grouping, filters, scrollY: listScrollY.current, kanbanStatus })), 100);
    };
    window.addEventListener('scroll', save, { passive: true });
    return () => {
      window.removeEventListener('scroll', save);
      if (timer) clearTimeout(timer);
      // Cleanup runs after the details card replaced the list; never read the card scroll here (issue #122).
      writeStorage('tasks.viewState', serializeTaskViewState({ view: taskView, grouping, filters, scrollY: listScrollY.current, kanbanStatus }));
    };
  }, [navigation.screen, taskView, grouping, filters, kanbanStatus, openTask]);

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
    try { await run(); if (reload && board) await loadBoard(board.id); setMessage(success); return true; }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Ошибка'); return false; }
  };
  const saveBoardName = async (rawName: string) => {
    if (!board) return;
    const name = rawName.trim();
    if (!name || name === board.name || name.length > 120) return;
    const path = board.status === 'draft' ? `/api/boards/${board.id}/activate` : `/api/boards/${board.id}`;
    const method = board.status === 'draft' ? 'POST' : 'PATCH';
    const ok = await action(() => api(path, json(method, {name})), board.status === 'draft' ? 'Доска активирована' : '', false);
    if (ok) {
      setBoards((items) => items.map((item) => item.id === board.id ? { ...item, name } : item));
      await loadBoards();
    }
  };
  const activate = () => { if (board) navigate({ screen: 'settings-workspace', boardId: board.id }); };
  const create = async (another = false) => {
    if (createLock.current) return;
    const validationError = validateTaskCreate(title, createBoardId);
    if (validationError) { setMessage(validationError); return; }
    if (createStatus === 'waiting' && !createBlockerId && !createWaitReason.trim()) { setMessage('Укажите задачу-блокер или внешнюю причину'); return; }
    createLock.current = true;
    setCreatePending(true);
    try {
      const waitCheckAt = createStatus === 'waiting' && createWaitCheck ? dateInputToIso(createWaitCheck) : null;
      if (createStatus === 'waiting' && createWaitCheck && !waitCheckAt) throw new Error('Проверьте дату проверки');
      const payload = {
        title: title.trim(), description: description.trim() || null, projectId: project || null,
        assigneeUserId: assignee || null, ...deadlinePatch(due), priority, notifyAssignee, status: createStatus,
        blockerTaskId: createStatus === 'waiting' ? createBlockerId || null : null,
        waitReason: createStatus === 'waiting' && !createBlockerId ? createWaitReason.trim() : null, waitCheckAt
      };
      const serialized = JSON.stringify([createBoardId, payload]);
      if (createRequest.current?.payload !== serialized) createRequest.current = { payload: serialized, id: crypto.randomUUID() };
      const task = await api<Task & {notificationWarning?: string}>(`/api/boards/${createBoardId}/tasks`, json('POST', { ...payload, requestId: createRequest.current.id }));
      const presentedTask = presentCreatedTask(task, boards.find((item) => item.id === createBoardId)?.name, projects.find((item) => item.id === project)?.name, members.find((item) => item.id === assignee)?.first_name);
      presentedTask.blocker_title = createTasks.find((item) => item.id === task.blocked_by_task_id)?.title;
      setTasks((current: Task[]) => current.some((item: Task) => item.id === task.id) ? current : [presentedTask, ...current]);
      setTitle(''); setDescription(''); if (!another) setProject(''); setAssignee(''); setDue(deadlineDraft()); setPriority('normal'); setNotifyAssignee(false);
      setCreateStatus('todo'); setCreateWaitReason(''); setCreateBlockerId(''); setCreateWaitCheck(''); createRequest.current = undefined;
      setBlockerKind('external'); setBlockerSearch(''); setCreateBlockerOpen(false); setStatusChoice('todo'); setCreateReset((value) => value + 1); setCreateUncertain(false);
      setCreateTasks((current) => [presentedTask, ...current]);
      createLock.current = false;
      if (!another) {
        setBoardOverrideId(createBoardId); setShowArchive(false); setBacklog(isBacklogTask(task));
        setNavigation({ screen: 'tasks' });
      }
      setMessage(task.notificationWarning ?? (another ? 'Задача создана. Можно добавить следующую.' : 'Задача создана'));
    } catch (error) {
      const uncertain = Boolean(createRequest.current) && !(error instanceof ApiError && [400, 401, 403, 404].includes(error.status));
      setCreateUncertain(uncertain);
      setMessage(`${error instanceof Error ? error.message : 'Ошибка'}${uncertain ? '. Повторите отправку, чтобы проверить результат. До подтверждения ввод сохранён и заблокирован.' : ''}`);
    }
    finally { createLock.current = false; setCreatePending(false); }
  };
  const move = async (task: Task, status: TaskStatus) => {
    if (task.status === status) return;
    const candidateTasks = tasks.filter((item) => item.board_id === task.board_id && item.id !== task.id && item.status !== 'done' && !item.archived_at);
    const blockerAnswer = status === 'waiting'
      ? window.prompt(`Номер задачи-блокера (пусто — внешняя причина)\n${candidateTasks.map((item, index) => `${index + 1}. ${item.title}`).join('\n')}`, '')
      : undefined;
    if (status === 'waiting' && blockerAnswer === null) return;
    const blockerTaskId = blockerAnswer?.trim() ? candidateTasks[Number(blockerAnswer) - 1]?.id : null;
    if (blockerAnswer?.trim() && !blockerTaskId) { setMessage('Выберите номер задачи из списка'); return; }
    const waitReason = status === 'waiting' && !blockerTaskId ? window.prompt('Внешняя причина блокировки')?.trim() : undefined;
    if (status === 'waiting' && !blockerTaskId && !waitReason) return;
    const check = status === 'waiting' ? window.prompt('Дата следующей проверки, YYYY-MM-DD (необязательно)')?.trim() : undefined;
    const waitCheckAt = check ? dateInputToIso(check) : null;
    if (check && !waitCheckAt) { setMessage('Дата проверки: YYYY-MM-DD'); return; }
    const previous = tasks;
    try {
      const update = async (confirmIncompleteChecklist = false) => { await api(`/api/boards/${task.board_id}/tasks/${task.id}`, json('PATCH', { status, blockerTaskId, waitReason, waitCheckAt, confirmIncompleteChecklist })); };
      await optimisticUpdate(previous, previous.map((item) => item.id === task.id ? { ...item, status } : item), setTasks, async () => {
        try { await update(); }
        catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409 || error.message !== 'incomplete checklist confirmation required'
            || !window.confirm('В чек-листе остались незавершённые пункты. Всё равно закрыть задачу?')) throw error;
          await update(true);
        }
      });
      if (board) await loadBoard(board.id);
      setMessage(statusDisplayName[status]);
    } catch (error) {
      setMessage(`Статус не изменён: ${error instanceof Error ? error.message : 'Ошибка'}`);
    }
  };
  // Single close path: restores the list snapshot captured at open time (issue #122).
  const closeTaskDetails = () => {
    const restoreTo = listScrollY.current;
    // Commit the list synchronously so the document is tall again before the browser can
    // clamp the scroll position of the short page (issue #122).
    flushSync(() => { setOpenTask(undefined); setCollaboration(undefined); });
    let attempts = 0;
    const restore = () => {
      window.scrollTo({ top: restoreTo });
      if (Math.abs(window.scrollY - restoreTo) <= 1 || ++attempts > 30) return;
      requestAnimationFrame(restore);
    };
    restore();
  };
  const openCollaboration = async (task: Task) => {
    // Capture the list position before the DOM switches to the loading/details screen (issue #122).
    listScrollY.current = window.scrollY;
    const openedAt = ++taskScrollSequence.current;
    setOpenTask(task); setCollaboration(undefined); setMessage('');
    try {
      const [nextCollaboration, nextProjects, nextMembers, nextTasks] = await Promise.all([
        api<Collaboration>(`/api/boards/${task.board_id}/tasks/${task.id}/collaboration`),
        api<{projects: Project[]}>(`/api/boards/${task.board_id}/projects`),
        api<{members: Member[]}>(`/api/boards/${task.board_id}/members`),
        api<{tasks: Task[]}>(`/api/boards/${task.board_id}/tasks`)
      ]);
      // The user may have closed the card or opened another one while this request was in flight.
      if (openedAt !== taskScrollSequence.current) return;
      taskScroll.current = listScrollY.current;
      setCollaboration(nextCollaboration); setDetailProjects(nextProjects.projects); setDetailMembers(nextMembers.members); setDetailTasks(nextTasks.tasks);
    }
    catch (error) {
      if (openedAt !== taskScrollSequence.current) return;
      closeTaskDetails();
      setMessage(error instanceof Error ? error.message : 'Ошибка');
    }
  };
  const claimFromBacklog = async (task: Task) => {
    if (backlogClaimLock.current || board?.status !== 'active') return;
    backlogClaimLock.current = true;
    setClaimingRow(task.id); setMessage('');
    try {
      const result = await runClaim(() => api<Task>(`/api/boards/${task.board_id}/tasks/${task.id}/claim`, { method: 'POST' }), (status) => status === 409 ? api<Task>(`/api/boards/${task.board_id}/tasks/${task.id}`) : Promise.resolve(null), userId);
      setMessage(result.message);
      if (result.claimed) { const saved = result.task; if (saved) setTasks((current) => current.map((item) => item.id === saved.id ? saved : item)); }
      else if (board) await loadBoard(board.id);
    } finally { backlogClaimLock.current = false; setClaimingRow(undefined); }
  };
  const collaborationAction = async (path: string, options: RequestInit) => {
    if (!openTask) return;
    await api(path, options);
    setCollaboration(await api(`/api/boards/${openTask.board_id}/tasks/${openTask.id}/collaboration`));
    setMessage('Сохранено');
  };
  const addProject = async (event: React.FormEvent<HTMLFormElement> | React.MouseEvent<HTMLButtonElement>) => {
    if (!board) return;
    if (!(event.currentTarget instanceof HTMLFormElement)) { navigate({ screen: 'settings-workspace', boardId: board.id }); return; }
    event.preventDefault();
    if (projectCreateLock.current) return;
    const form = event.currentTarget;
    const name = String(new FormData(form).get('name') ?? '').trim();
    if (!name) return;
    projectCreateLock.current = true;
    setProjectCreatePending(true);
    try {
      if (await action(() => api(`/api/boards/${board.id}/projects`, json('POST', {name})), 'Проект создан')) form.reset();
    } finally {
      projectCreateLock.current = false;
      setProjectCreatePending(false);
    }
  };
  const editProject = async (item: Project) => {
    if (!board) { return; }
    const name = window.prompt('Название проекта', item.name)?.trim();
    if (!name || name === item.name) return;
    const ok = await action(() => api(`/api/boards/${board.id}/projects/${item.id}`, json('PATCH', {name})), '', false);
    if (ok) setProjects((current) => current.map((project) => project.id === item.id ? { ...project, name } : project));
  };
  const addRecurrence = async (event: React.FormEvent<HTMLFormElement> | React.MouseEvent<HTMLButtonElement>) => {
    if (!board) return;
    if (!(event.currentTarget instanceof HTMLFormElement)) { navigate({ screen: 'settings-automation', boardId: board.id }); return; }
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const weekdays = String(data.get('weekdays') ?? '').split(',').map(Number).filter((day) => Number.isInteger(day));
    const startDate = String(data.get('startDate'));
    const endDate = String(data.get('endDate'));
    if (!await action(() => api(`/api/boards/${board.id}/recurrences`, json('POST', {
      title: String(data.get('title')), frequency: recurrenceFrequency, localTime: String(data.get('localTime')),
      timezone: String(data.get('timezone')), weekdays: recurrenceFrequency === 'weekdays' || recurrenceFrequency === 'weekly' ? weekdays : undefined,
      dayOfMonth: recurrenceFrequency === 'monthly' ? Number(data.get('dayOfMonth')) : undefined,
      startAt: new Date(`${startDate}T00:00:00`).toISOString(), endAt: endDate ? new Date(`${endDate}T23:59:59`).toISOString() : null,
      projectId: data.get('projectId') || null, assigneeUserId: data.get('assigneeUserId') || null, priority: data.get('priority')
    })), 'Повтор создан')) return;
    form.reset(); setRecurrenceFrequency('daily'); setRecurrenceProjectId(''); setRecurrenceAssigneeId(''); setRecurrencePriority('normal');
  };
  const chooseTaskBoard = (boardId: string) => {
    setBacklog(false);
    setBoardOverrideId(undefined);
    setGlobalBoardId(boardId);
    setFilters(defaultFilters);
    setFiltersLoadedFor('');
    setShowBoardSheet(false);
    setBoardSearch('');
    if (boardId) {
      writeStorage('tasks.globalBoardId', boardId);
      setRecentBoardIds((current) => {
        const next = [boardId, ...current.filter((id) => id !== boardId)].slice(0, 3);
        writeStorage('tasks.recentBoardIds', JSON.stringify(next));
        return next;
      });
    } else removeStorage('tasks.globalBoardId');
  };
  const backlogTasks = tasks.filter((task) => task.board_id === board?.id && isBacklogTask(task) && (!filters.project || task.project_id === filters.project));
  const filteredTasks = !showArchive ? filterTasks(tasks, filters, userId) : tasks;
  const filterCount = activeFilterCount(taskView === 'kanban' ? { ...filters, status: '' } : filters);
  const recentBoards = recentBoardIds.map((id) => boards.find((item) => item.id === id)).filter((item): item is Board => Boolean(item));
  const matchingBoards = boards.filter((item) => item.name.toLocaleLowerCase('ru-RU').includes(boardSearch.trim().toLocaleLowerCase('ru-RU')));
  const setFilter = <K extends keyof TaskFilters>(key: K, value: TaskFilters[K]) => setFilters((current) => ({ ...current, [key]: value }));
  const taskCard = (task: Task) => <article
    className={`task ${task.priority === 'urgent' ? 'urgent' : ''} ${task.overdue ? 'overdue' : ''} ${task.wait_check_due ? 'wait-due' : ''} ${!task.assignee_user_id ? 'unassigned' : ''} ${draggedTask === task.id ? 'dragging' : ''}`}
    key={task.id} draggable={Boolean(board && !task.archived_at && !taskStatusRestriction(task))}
    onDragStart={(event) => { setDraggedTask(task.id); event.dataTransfer.setData('text/plain', task.id); }} onDragEnd={() => setDraggedTask(undefined)}>
    <div onClick={() => { if (!board && task.board_id) setNavigation({ screen: 'board', boardId: task.board_id }); }}>
      <span>{task.board_name ?? statusDisplayName[task.status]}</span><strong>{task.title}</strong>
      {task.description && <small>{task.description}</small>}
      <div className="meta">{task.project_name && <small>{task.project_name}</small>}<small>{task.assignee_name ?? 'Без ответственного'}</small>{(task.deadline || task.deadline_date) && <small>{formatTaskDeadline(task)}</small>}</div>
      {task.overdue && <small className="flag">Дедлайн прошёл</small>}{task.wait_check_due && <small className="flag">Пора проверить ожидание</small>}{task.blocker_title ? <small>Блокирует: {task.blocker_title}</small> : task.wait_reason && <small>Внешний блокер: {task.wait_reason}</small>}
    </div>
    {board && <div className="actions"><button onClick={() => openCollaboration(task)}>Открыть</button>{task.archived_at ? <button onClick={() => action(() => api(`/api/boards/${task.board_id}/tasks/${task.id}/reopen`, {method: 'POST'}), 'Задача восстановлена')}>Восстановить</button> : <>
      <label className="status-control">Статус<select aria-label={`Статус задачи ${task.title}`} value={task.status} onChange={(event) => void move(task, event.target.value as TaskStatus)}>{statuses.map((status) => <option key={status} value={status}>{statusDisplayName[status]}</option>)}</select></label>
      <button onClick={() => action(() => api(`/api/boards/${task.board_id}/tasks/${task.id}`, {method: 'DELETE'}), 'Задача архивирована')}>В архив</button>
    </>}</div>}
  </article>;
  const taskList = <div className="task-list">{filteredTasks.map(taskCard)}</div>;
  const initials = (name?: string) => name?.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toLocaleUpperCase('ru-RU') || '—';
  const mainTaskRow = (task: Task) => <article className="main-task-row" key={task.id}>
    <input className="task-completion" type="checkbox" checked={task.status === 'done'} disabled={task.status === 'done' || Boolean(taskStatusRestriction(task))} title={taskStatusRestriction(task) ?? undefined} aria-label={`Завершить задачу ${task.title}`} onChange={() => void move(task, 'done')}/>
    <button className="task-summary" onClick={() => void openCollaboration(task)}>
      <strong>{task.title}</strong>
      <div className="task-meta">
        <span>{task.project_name ?? task.board_name ?? 'Без проекта'}</span>
        {(task.deadline || task.deadline_date) && <span className={task.overdue ? 'deadline-overdue' : ''}>{formatTaskDeadline(task)}{task.overdue ? ' · Дедлайн прошёл' : ''}</span>}
        {task.priority === 'urgent' && <Badge tone="urgent">Срочно</Badge>}
        {task.status === 'waiting' && !task.wait_reason && <Badge tone="blocker">Блокер</Badge>}
        {Boolean(task.checklist_total) && <span>{task.checklist_completed}/{task.checklist_total}</span>}
      </div>
      {task.status === 'waiting' && task.wait_reason && <small className="blocker-reason">{task.wait_reason}</small>}
    </button>
    {task.assignee_name && <Avatar initials={initials(task.assignee_name)} label={`Исполнитель: ${task.assignee_name}`}/>}
  </article>;
  const deadlineGroups = groupTasksByDeadline(filteredTasks);
  const deadlineSections: { id: DeadlineGroup; label: string; icon: IconName }[] = [
    { id: 'overdue', label: 'Просрочено', icon: 'alert' }, { id: 'today', label: 'Сегодня', icon: 'sun' },
    { id: 'upcoming', label: 'Ближайшие', icon: 'clock' }, { id: 'none', label: 'Без срока', icon: 'noDeadline' }
  ];
  const groupedTaskList = <div className="grouped-task-list">{grouping === 'deadline'
    ? deadlineSections.map((section) => deadlineGroups[section.id].length > 0 && <section className="task-section" key={section.id}><SectionHeader count={deadlineGroups[section.id].length} tone={section.id}><span className="section-title"><span aria-hidden="true"><Icon name={section.icon}/></span>{section.label}</span></SectionHeader>{deadlineGroups[section.id].map(mainTaskRow)}</section>)
    : groupTasksByProject(filteredTasks).map((group) => <section className="task-section project-section" key={group.id ?? 'none'}><SectionHeader count={group.tasks.length} tone="upcoming">{group.name}</SectionHeader>{group.tasks.map(mainTaskRow)}</section>)
  }</div>;
  const kanbanTasks = filterTasks(tasks, { ...filters, status: kanbanStatus }, userId);
  const kanbanTaskRow = (task: Task) => <article className={`kanban-task-row status-${task.status}`} key={task.id}>
    <button className="task-summary" onClick={() => void openCollaboration(task)}><strong>{task.title}</strong><div className="task-meta"><span>{task.project_name ?? task.board_name ?? 'Без проекта'}</span>{(task.deadline || task.deadline_date) && <span className={task.overdue ? 'deadline-overdue' : ''}>{formatTaskDeadline(task)}{task.overdue ? ' · Дедлайн прошёл' : ''}</span>}{task.priority === 'urgent' && <Badge tone="urgent">Срочно</Badge>}</div></button>
    {task.assignee_name && <Avatar initials={initials(task.assignee_name)} label={`Исполнитель: ${task.assignee_name}`}/>}
    <button className="kanban-status-action" onClick={() => setKanbanStatusTask(task)}><span>Статус</span><strong>{statusDisplayName[task.status]}</strong><Icon name="chevron"/></button>
  </article>;
  const mainKanban = <div className="mobile-kanban">
    <div className="status-tabs" aria-label="Статусы задач">{statuses.map((status) => <button aria-pressed={kanbanStatus === status} className={kanbanStatus === status ? 'active' : ''} key={status} onClick={() => setKanbanStatus(status)}>{statusDisplayName[status]} <small>{filterTasks(tasks, { ...filters, status }, userId).length}</small></button>)}</div>
    <section className="active-kanban-column" aria-label={statusDisplayName[kanbanStatus]}
      onPointerDown={(event) => { if (event.pointerType === 'touch') swipeStart.current = { x: event.clientX, y: event.clientY }; }}
      onPointerUp={(event) => { if (!swipeStart.current) return; setKanbanStatus(resolveKanbanSwipe(kanbanStatus, swipeStart.current.x, swipeStart.current.y, event.clientX, event.clientY)); swipeStart.current = null; }}
      onPointerCancel={() => { swipeStart.current = null; }}>
      <header className="kanban-column-header"><span className="kanban-column-glyph" aria-hidden="true"><Icon name="tasks"/></span><div><h2>{statusDisplayName[kanbanStatus]} <small>{kanbanTasks.length}</small></h2><p>{window.innerWidth <= 350 ? 'Одна активная колонка' : 'Свайпните для смены статуса'}</p></div></header>
      <div className="kanban-tasks">{kanbanTasks.map(kanbanTaskRow)}</div>
      {!kanbanTasks.length && <p className="task-state">Задач в этом статусе нет.</p>}
      <p className="kanban-position"><span>{String(statuses.indexOf(kanbanStatus) + 1).padStart(2, '0')} / {String(statuses.length).padStart(2, '0')}</span><i><i style={{ width: `${100 / statuses.length}%` }}/></i></p>
    </section>
  </div>;
  const kanbanStatusSheet = kanbanStatusTask && <Sheet className="task-sheet kanban-status-sheet" title="Статус" onClose={() => setKanbanStatusTask(undefined)}><div className="choice-list" role="radiogroup">{statuses.map((status) => <ChoiceRow key={status} label={statusDisplayName[status]} selected={kanbanStatusTask.status === status} onClick={() => { const task = kanbanStatusTask; setKanbanStatusTask(undefined); void move(task, status); }}/>)}</div><button className="sheet-close secondary" onClick={() => setKanbanStatusTask(undefined)}>Закрыть</button></Sheet>;
  const kanban = <div className="kanban" aria-label="Канбан">{statuses.map((status) => <section className="kanban-column" data-status={status} key={status}
    onDragOver={(event) => { const task = tasks.find((item) => item.id === draggedTask); if (task && !taskStatusRestriction(task)) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); const task = tasks.find((item) => item.id === event.dataTransfer.getData('text/plain')); if (task) void move(task, status); }}>
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
  const viewControls = <div className="list-controls">
      {taskView === 'list' ? <div className="grouping-tabs" aria-label="Группировка задач"><button aria-pressed={grouping === 'deadline'} className={grouping === 'deadline' ? 'active' : ''} onClick={() => setGrouping('deadline')}>По срокам</button><button aria-pressed={grouping === 'project'} className={grouping === 'project' ? 'active' : ''} onClick={() => setGrouping('project')}>По проектам</button></div> : <strong className="kanban-grouping">По статусу</strong>}
      <div className="view-switch" aria-label="Вид задач"><button className={taskView === 'list' ? 'active' : ''} aria-label="Список" aria-pressed={taskView === 'list'} onClick={() => setTaskView('list')}><svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h3v3H5zM11 6h8M5 11h3v3H5zM11 11h8M5 16h3v3H5zM11 16h8"/></svg></button><button className={taskView === 'kanban' ? 'active' : ''} aria-label="Канбан" aria-pressed={taskView === 'kanban'} onClick={() => setTaskView('kanban')}><svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h4v14H5zM10 5h4v14h-4zM15 5h4v14h-4z"/></svg></button></div>
    </div>;
  const searchControls = <div className="task-toolbar">
      <input className="search" type="search" value={filters.search} onChange={(event) => setFilter('search', event.target.value)} placeholder="Поиск задач" aria-label="Поиск задач"/>
      <button className="filter-trigger" aria-label="Фильтры" onClick={() => { setShowAdvancedFilters(false); setFilterChoice(undefined); setShowFilterSheet(true); }}><svg className="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M7 14v6"/></svg><span className="filter-label">Фильтры</span>{filterCount > 0 && <span className="filter-count">{filterCount}</span>}</button>
    </div>;
  const scopeTabs = board && !showArchive && <div className="scope-tabs" aria-label="Очередь задач">
    <button aria-pressed={!backlog && filters.scope === 'mine'} onClick={() => { setBacklog(false); setFilters({ ...defaultFilters, scope: 'mine', project: filters.project }); }}>Мои</button>
    <button aria-pressed={!backlog && filters.scope === 'all'} onClick={() => { setBacklog(false); setFilters({ ...defaultFilters, scope: 'all', project: filters.project }); }}>Все</button>
    <button aria-pressed={backlog} onClick={() => { setBacklog(true); setShowArchive(false); }}>Бэклог {taskLoadState === 'ready' ? backlogTasks.length : ''}</button>
  </div>;
  const backlogContent = <>
    <ActionRow label="Проект" value={projects.find((item) => item.id === filters.project)?.name ?? 'Все проекты'} icon={<Icon name="project"/>} onClick={() => setFilterChoice('project')}/>
    <button className="secondary backlog-paste" disabled={board?.status !== 'active'} onClick={() => { if (!bulkDraft || (bulkDraft.started && bulkDraft.rows?.every((row) => row.task))) setBulkDraft({ boardId: board!.id, boardName: board!.name, projects, project: filters.project, text: '', started: false }); setBulkOpen(true); }}>{bulkDraft && (bulkDraft.text || bulkDraft.rows?.some((row) => !row.task)) ? 'Продолжить список' : 'Вставить список'}</button>
    <h2 className="backlog-heading">На разбор</h2><p className="bulk-context">Без исполнителя · К выполнению</p>
    {taskLoadState === 'loading' ? <Skeleton label="Загрузка общей очереди"/> : taskLoadState === 'error' ? <div className="task-state" role="alert"><p>Нет связи. Очередь не обновилась.</p><button onClick={() => setTaskReload((value) => value + 1)}>Повторить</button></div> : <>
      {!backlogTasks.length && <div className="task-state"><h3>Всё разобрано</h3><p>Здесь появятся новые задачи без исполнителя. Добавьте одну или вставьте готовый список.</p></div>}
      {backlogTasks.map((task) => <article className="backlog-row" key={task.id}><button className="task-summary" onClick={() => void openCollaboration(task)}><strong>{task.title}</strong><div className="task-meta"><span>{task.project_name ?? task.board_name ?? 'Без проекта'}</span>{(task.deadline || task.deadline_date) && <span className={task.overdue ? 'deadline-overdue' : ''}>{formatTaskDeadline(task)}{task.overdue ? ' · Дедлайн прошёл' : ''}</span>}{task.priority === 'urgent' && <Badge tone="urgent">Срочно</Badge>}</div></button><button className="secondary" disabled={board?.status !== 'active' || claimingRow === task.id} onClick={() => void claimFromBacklog(task)}>{claimingRow === task.id ? 'Назначаем…' : 'Взять себе'}</button></article>)}
    </>}
    <p className="bulk-context">Другие статусы — во вкладке «Все».</p>
  </>;
  const taskToolbar = <>{scopeTabs}{!backlog && (taskView === 'kanban' ? <>{searchControls}{viewControls}</> : <>{viewControls}{searchControls}</>)}</>;
  const boardSheet = showBoardSheet && <Sheet className="task-sheet board-sheet" title="Выберите доску" onClose={() => setShowBoardSheet(false)}>
    {boards.length > 5 && <input className="sheet-search" type="search" value={boardSearch} onChange={(event) => setBoardSearch(event.target.value)} placeholder="Найти доску" aria-label="Найти доску"/>}
    {!boardSearch && recentBoards.length > 0 && <><h3 className="sheet-label">Недавние</h3><div className="sheet-options">{recentBoards.map((item) => <button key={`recent-${item.id}`} className={item.id === selectedTaskBoardId ? 'selected' : ''} onClick={() => chooseTaskBoard(item.id)}><span>{item.name}</span><small>{boardTypeName(item)}</small></button>)}</div></>}
    <div className="choice-list" role="radiogroup" aria-label="Доски">
      {!boardSearch && <ChoiceRow label="Все доски" detail="Назначенные вам задачи" selected={!selectedTaskBoardId} onClick={() => chooseTaskBoard('')}/>}
      {matchingBoards.map((item) => <ChoiceRow key={item.id} label={item.name} detail={`${boardTypeName(item)}${item.status === 'archived' ? ' · в архиве' : ''}`} selected={item.id === selectedTaskBoardId} onClick={() => chooseTaskBoard(item.id)}/>)}
    </div>
    <button className="secondary" onClick={() => { setShowBoardSheet(false); setPairFlow({}); }}>Создать доску на двоих</button>
    <button className="sheet-close secondary" onClick={() => setShowBoardSheet(false)}>Закрыть</button>
  </Sheet>;
  const filterSheet = showFilterSheet && !showAdvancedFilters && !filterChoice && <Sheet className="task-sheet filter-choice-sheet" title="Фильтры" onClose={() => setShowFilterSheet(false)}>
    <div className="quick-filters">
      <ChoiceRow kind="check" label="Только мои" selected={filters.scope === 'mine'} onClick={() => setFilter('scope', filters.scope === 'mine' ? 'all' : 'mine')}/>
      <ChoiceRow kind="check" label="Срочные" selected={filters.priority === 'urgent'} onClick={() => setFilter('priority', filters.priority === 'urgent' ? '' : 'urgent')}/>
      {taskView === 'list' && <ChoiceRow kind="check" label="С блокером" selected={filters.status === 'waiting'} onClick={() => setFilter('status', filters.status === 'waiting' ? '' : 'waiting')}/>}
    </div>
    <div className="filter-links"><button onClick={() => setShowAdvancedFilters(true)}>Другие фильтры</button><button onClick={() => setFilters(defaultFilters)}>Сбросить</button></div>
    <button className="filter-apply" onClick={() => setShowFilterSheet(false)}>Показать {filteredTasks.length} задач</button>
  </Sheet>;
  const advancedFilterSheet = showFilterSheet && showAdvancedFilters && !filterChoice && <Sheet className="task-sheet advanced-filter-sheet" title="Другие фильтры" onClose={() => setShowAdvancedFilters(false)}>
    <div>
      {board && <ActionRow label="Проект" value={projects.find((item) => item.id === filters.project)?.name ?? 'Все проекты'} onClick={() => setFilterChoice('project')}/>}
      {board && <ActionRow label="Исполнитель" value={members.find((item) => item.id === filters.assignee)?.first_name ?? 'Все исполнители'} onClick={() => setFilterChoice('assignee')}/>}
      {taskView === 'list' && <ActionRow label="Статус" value={filters.status ? statusDisplayName[filters.status] : 'Без завершённых'} onClick={() => setFilterChoice('status')}/>}
      <ActionRow label="Приоритет" value={filters.priority === 'urgent' ? 'Срочный' : filters.priority === 'normal' ? 'Обычный' : 'Любой'} onClick={() => setFilterChoice('priority')}/>
      <ActionRow label="Дедлайн" value={{ overdue: 'Просрочено', today: 'Сегодня', week: '7 дней', none: 'Без дедлайна', '': 'Любой' }[filters.deadline]} onClick={() => setFilterChoice('deadline')}/>
      <ChoiceRow kind="check" label="Без ответственного" selected={filters.unassigned} onClick={() => setFilters((current) => ({ ...current, scope: 'all', assignee: '', unassigned: !current.unassigned }))}/>
    </div>
    <button className="filter-apply" onClick={() => { setShowAdvancedFilters(false); setShowFilterSheet(false); }}>Показать {filteredTasks.length} задач</button>
  </Sheet>;
  const filterChoiceDefinitions = {
    project: { title: 'Проект', current: filters.project, options: [{ value: '', label: 'Все проекты' }, ...projects.filter((item) => !item.archived_at).map((item) => ({ value: item.id, label: item.name }))] },
    assignee: { title: 'Исполнитель', current: filters.assignee, options: [{ value: '', label: 'Все исполнители' }, ...members.map((member) => ({ value: member.id, label: member.first_name }))] },
    status: { title: 'Статус', current: filters.status, options: [{ value: '', label: 'Без завершённых' }, ...statuses.map((status) => ({ value: status, label: statusDisplayName[status] }))] },
    priority: { title: 'Приоритет', current: filters.priority, options: [{ value: '', label: 'Любой' }, { value: 'normal', label: 'Обычный' }, { value: 'urgent', label: 'Срочный' }] },
    deadline: { title: 'Дедлайн', current: filters.deadline, options: [{ value: '', label: 'Любой' }, { value: 'overdue', label: 'Просрочено' }, { value: 'today', label: 'Сегодня' }, { value: 'week', label: '7 дней' }, { value: 'none', label: 'Без дедлайна' }] }
  } satisfies Record<FilterChoice, { title: string; current: string; options: { value: string; label: string }[] }>;
  const filterChoiceSheet = filterChoice && (() => {
    const choice = filterChoiceDefinitions[filterChoice];
    const choose = (value: string) => {
      if (filterChoice === 'project' || filterChoice === 'assignee') setFilter(filterChoice, value);
      else if (filterChoice === 'status') setFilter('status', value as TaskFilters['status']);
      else if (filterChoice === 'priority') setFilter('priority', value as TaskFilters['priority']);
      else setFilter('deadline', value as TaskFilters['deadline']);
      setFilterChoice(undefined);
    };
    return <Sheet className="task-sheet" title={choice.title} onClose={() => setFilterChoice(undefined)}><div className="choice-list" role="radiogroup">{choice.options.map((option) => <ChoiceRow key={option.value} label={option.label} selected={choice.current === option.value} onClick={() => choose(option.value)}/>)}</div><button className="sheet-close secondary" onClick={() => setFilterChoice(undefined)}>Закрыть</button></Sheet>;
  })();
  const createChoiceDefinitions = {
    board: { title: 'Доска', current: createBoardId, options: [{ value: '', label: 'Выберите доску' }, ...boards.filter((item) => item.status === 'active').map((item) => ({ value: item.id, label: item.name }))] },
    project: { title: 'Проект', current: project, options: [{ value: '', label: 'Без проекта' }, ...projects.filter((item) => !item.archived_at).map((item) => ({ value: item.id, label: item.name }))] },
    assignee: { title: 'Исполнитель', current: assignee, options: [{ value: '', label: 'Без ответственного' }, ...members.map((member) => ({ value: member.id, label: member.first_name }))] },
    priority: { title: 'Приоритет', current: priority, options: [{ value: 'normal', label: 'Обычный' }, { value: 'urgent', label: 'Срочный' }] },
    status: { title: 'Статус задачи', current: createStatus, options: statuses.map((value) => ({ value, label: value === 'todo' ? 'К выполнению' : statusDisplayName[value] })) }
  } satisfies Record<CreateChoice, { title: string; current: string; options: { value: string; label: string }[] }>;
  const createChoiceSheet = createChoice && (() => {
    const choice = createChoiceDefinitions[createChoice];
    const choose = (value: string) => {
      if (createChoice === 'board') { setMessage(''); setCreateBoardId(value); setProject(''); setAssignee(''); setNotifyAssignee(false); setCreateBlockerId(''); }
      else if (createChoice === 'project') setProject(value);
      else if (createChoice === 'assignee') { setAssignee(value); if (!value) setNotifyAssignee(false); }
      else if (createChoice === 'status') { setCreateStatus(value as TaskStatus); if (value === 'waiting') setCreateBlockerOpen(true); }
      else setPriority(value as Task['priority']);
      setCreateChoice(undefined);
    };
    return <Sheet className="task-sheet create-choice-sheet" title={choice.title} onClose={() => setCreateChoice(undefined)}><div className="choice-list" role="radiogroup">{choice.options.map((option) => <ChoiceRow key={option.value} label={option.label} selected={(createChoice === 'status' ? statusChoice : choice.current) === option.value} onClick={() => createChoice === 'status' ? setStatusChoice(option.value as TaskStatus) : choose(option.value)}/>)}</div>{createChoice === 'status' && <><p>Для «Блокера» понадобится причина.</p><button type="button" className="filter-apply" onClick={() => choose(statusChoice)}>Применить</button></>}<button type="button" className="sheet-close secondary" onClick={() => setCreateChoice(undefined)}>Закрыть</button></Sheet>;
  })();

  const pairChanged = (updated?: Board) => {
    if (updated) setBoards((items) => [...items.filter((item) => item.id !== updated.id), updated]);
    else if (pairFlow?.board) setBoards((items) => items.filter((item) => item.id !== pairFlow.board!.id));
    setTasks([]); setOpenTask(undefined); setCollaboration(undefined); setTaskReload((value) => value + 1);
  };
  const openPair = (updated: Board) => {
    pairChanged(updated); setPairFlow(undefined); setPairInvite(''); setBoardOverrideId(updated.id); setNavigation({ screen: 'tasks' }); setFilters({ ...defaultFilters, scope: 'all' });
  };
  if (accessLost) return <main><EnvironmentStatus/><h1>Доступ закрыт</h1><p>Вы больше не участвуете в этой доске. Задачи и история остались у владельца.</p><button onClick={() => { setAccessLost(false); setBoardOverrideId(undefined); setNavigation({ screen: 'tasks' }); }}>К моим задачам</button></main>;
  if (state === 'ready' && boardLinkError) return <main><EnvironmentStatus/><section role="alert"><h1>{boardLinkError === 'invalid' ? 'Доска недоступна' : 'Не удалось открыть доску'}</h1><p>{boardLinkError === 'invalid' ? 'Ссылка недействительна или доступ закрыт. Попросите администратора проверить вход в группу.' : 'Нет связи. Повторите вход по этой ссылке.'}</p>{boardLinkError === 'network' && <button onClick={() => setStartupRetry((value) => value + 1)}>Повторить</button>}<button className="secondary" onClick={() => { setBoardLinkError(undefined); setBoardOverrideId(undefined); }}>К моим задачам</button></section></main>;
  if (state === 'ready' && entryPath) return <EntryGuide path={entryPath} onPath={setEntryPath} onClose={() => { setEntryPath(undefined); navigate({ screen: 'tasks' }); }}
    onPersonal={() => { const personal = boards.find((item) => item.type === 'personal'); if (personal) chooseTaskBoard(personal.id); setEntryPath(undefined); navigate({ screen: 'tasks' }); }}
    onPair={() => { setEntryPath(undefined); setPairFlow({}); }}/ >;
  if (state === 'ready' && board?.type === 'chat' && board.status !== 'active' && !openTask && !taskLinkError && !pairInvite && !pairFlow) return <GroupSetup key={board.id} board={board}
    onReady={(updated) => { setBoards((items) => items.map((item) => item.id === updated.id ? { ...item, ...updated } : item)); setBoardOverrideId(updated.id); setNavigation({ screen: 'tasks' }); setTaskReload((value) => value + 1); }}
    onClose={() => { setBoardOverrideId(undefined); navigate(globalBoardId === board.id ? { screen: 'settings-workspace' } : { screen: 'tasks' }); }}/ >;
  if (state === 'ready' && pairInvite) return <PairInvite token={pairInvite} onJoined={openPair} onClose={() => setPairInvite('')}/>;
  if (state === 'ready' && pairFlow) return <PairBoard initialBoard={pairFlow.board} onChanged={pairChanged} onOpen={openPair} onClose={() => { setPairFlow(undefined); setTaskReload((value) => value + 1); }}/ >;
  if (bulkOpen && bulkDraft) return <AppShell message="" navigation={navigation} navigate={navigate} hideNavigation><BulkCreate draft={bulkDraft} onDraft={setBulkDraft}
    onClose={() => { setBulkOpen(false); setBoardOverrideId(bulkDraft.boardId); setBacklog(true); setTaskReload((value) => value + 1); }}
    onCreated={(created, projectId) => { if (activeBoardId.current !== bulkDraft.boardId) return; setTasks((current) => { const ids = new Set(created.map((item) => item.id)); return [...created.map((item) => presentCreatedTask(item, bulkDraft.boardName, bulkDraft.projects.find((project) => project.id === projectId)?.name)), ...current.filter((item) => !ids.has(item.id))]; }); }}/></AppShell>;
  if (claimingTask) return <AppShell message="" navigation={navigation} navigate={navigate} hideNavigation><ClaimTask key={claimingTask.id} task={claimingTask} userId={userId} boardName={boards.find((item) => item.id === claimingTask.board_id)?.name ?? ''}
    onBack={() => { setBoardOverrideId(claimingTask.board_id); setNavigation({ screen: 'tasks' }); setClaimingTask(undefined); setOpenTask(undefined); setCollaboration(undefined); setBacklog(true); }}
    onMine={() => { setBoardOverrideId(claimingTask.board_id); setNavigation({ screen: 'tasks' }); setClaimingTask(undefined); setOpenTask(undefined); setCollaboration(undefined); setBacklog(false); setTaskView('list'); setFilters({ ...defaultFilters, scope: 'mine' }); setTaskReload((value) => value + 1); }}
    onChanged={(changed) => setTasks((current) => changed ? current.map((item) => item.id === changed.id ? changed : item) : current.filter((item) => item.id !== claimingTask.id))}/></AppShell>;
  if (openTask && !collaboration) return <main className="task-details"><EnvironmentStatus/><button className="back" onClick={() => closeTaskDetails()}>← Задачи</button><Skeleton label="Загрузка задачи"/></main>;
  if (openTask && collaboration) return <TaskDetails
    task={openTask} collaboration={collaboration} projects={detailProjects} members={detailMembers}
    readOnly={boards.find((item) => item.id === openTask.board_id)?.status !== 'active'}
    onClaim={boards.find((item) => item.id === openTask.board_id)?.status === 'active' && isBacklogTask(openTask) ? () => setClaimingTask(openTask) : undefined}
    candidateTasks={detailTasks.filter((item) => item.id !== openTask.id && item.status !== 'done' && !item.archived_at)}
    boardName={boards.find((item) => item.id === openTask.board_id)?.name ?? openTask.board_name ?? 'Задача'}
    onBack={() => closeTaskDetails()}
    onSave={async (patch, future, confirmIncompleteChecklist = false) => {
      const query = future ? '?scope=future' : '';
      const saved = await api<Task & { notificationWarning?: string; seriesUpdateFailed?: boolean }>(`/api/boards/${openTask.board_id}/tasks/${openTask.id}${query}`, json('PATCH', { ...patch, expectedVersion: openTask.version, confirmIncompleteChecklist }));
      // Server-confirmed object becomes the new baseline: no stale local merge, no full
      // board reload per keystroke batch (issue #129).
      const confirmed: Task = { ...saved, checklist_total: openTask.checklist_total, checklist_completed: openTask.checklist_completed };
      setTasks((current) => current.map((item) => item.id === confirmed.id ? confirmed : item));
      setOpenTask(confirmed);
      if (saved.seriesUpdateFailed) setMessage('Задачу сохранили, но серию изменить не удалось. Примените к серии ещё раз.');
      else if (saved.notificationWarning) setMessage(saved.notificationWarning);
      return confirmed;
    }}
    onArchive={async () => { await api(`/api/boards/${openTask.board_id}/tasks/${openTask.id}`, { method: 'DELETE' }); if (board) await loadBoard(board.id); else setTasks((current) => current.filter((item) => item.id !== openTask.id)); setOpenTask(undefined); setCollaboration(undefined); setMessage('Задача архивирована'); }}
    onChecklistAdd={(text) => collaborationAction(`/api/boards/${openTask.board_id}/tasks/${openTask.id}/checklist`, json('POST', { text }))}
    onChecklistUpdate={(itemId, patch) => collaborationAction(`/api/boards/${openTask.board_id}/tasks/${openTask.id}/checklist/${itemId}`, json('PATCH', patch))}
    onChecklistDelete={(itemId) => collaborationAction(`/api/boards/${openTask.board_id}/tasks/${openTask.id}/checklist/${itemId}`, { method: 'DELETE' })}
    onComment={(body) => collaborationAction(`/api/boards/${openTask.board_id}/tasks/${openTask.id}/comments`, json('POST', { body }))}
    onUrlAttachment={(url) => collaborationAction(`/api/boards/${openTask.board_id}/tasks/${openTask.id}/attachments`, json('POST', { kind: 'url', url }))}
    onFileAttachment={(file) => { const data = new FormData(); data.append('file', file); return collaborationAction(`/api/boards/${openTask.board_id}/tasks/${openTask.id}/attachments/file`, { method: 'POST', body: data }); }}
  />;
  const saveSchedule = async (schedule: Schedule, previewOnly = false) => {
    if (!board) return;
    const result = await api<Schedule | {messages: string[]}>(`/api/boards/${board.id}/publications/${schedule.kind}${previewOnly ? '/preview' : ''}`, json(previewOnly ? 'POST' : 'PUT', schedule));
    if ('messages' in result) setPreview(result.messages.join('\n\n———\n\n')); else setSchedules((items) => items.map((item) => item.kind === result.kind ? result : item));
  };
  // Autosave for existing editing surfaces (issue #129): debounced PUT/PATCH, immediate on
  // blur; validation errors stay in the field and the server value is not lost.
  const autoSaveSchedule = (kind: string, next: Schedule) => {
    const valid = next.enabled && Array.isArray(next.weekdays) && next.weekdays.length && next.weekdays.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)
      && /^([01]\d|2[0-3]):[0-5]\d$/.test(next.local_time) && next.timezone && next.included_statuses.length > 0;
    if (scheduleTimer.current[kind]) clearTimeout(scheduleTimer.current[kind]);
    if (!valid) return;
    scheduleTimer.current[kind] = setTimeout(() => { void saveSchedule(next).catch((error: Error) => setMessage(error.message)); }, 700);
  };
  const autoSaveProject = (item: Project, name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === item.name || trimmed.length > 120) return;
    if (scheduleTimer.current[item.id]) clearTimeout(scheduleTimer.current[item.id]);
    scheduleTimer.current[item.id] = setTimeout(() => {
      void action(() => api(`/api/boards/${board!.id}/projects/${item.id}`, json('PATCH', {name: trimmed})), '', false)
        .then((ok) => { if (ok) setProjects((current) => current.map((project) => project.id === item.id ? { ...project, name: trimmed } : project)); });
    }, 700);
  };
  const publicationSettings = board?.type === 'chat' && schedules.length ? <Disclosure label="Публикации в чат"><div className="publications">{schedules.map((schedule) => <fieldset key={schedule.kind}><legend>{schedule.kind === 'daily' ? 'План дня' : 'Недельная сводка'}</legend><label><input type="checkbox" checked={schedule.enabled} onChange={(event) => { const next = {...schedule, enabled: event.target.checked}; setSchedules((items) => items.map((item) => item.kind === schedule.kind ? next : item)); autoSaveSchedule(schedule.kind, next); }}/> Включена</label><label>Дни (1–7)<input value={schedule.weekdays.join(',')} onChange={(event) => { const weekdays = event.target.value.split(',').map(Number).filter(Boolean); const next = {...schedule, weekdays}; setSchedules((items) => items.map((item) => item.kind === schedule.kind ? {...item, weekdays} : item)); if (!weekdays.length || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) return; autoSaveSchedule(schedule.kind, next); }}/></label><label>Время<input type="time" value={schedule.local_time} onChange={(event) => { const next = {...schedule, local_time: event.target.value}; setSchedules((items) => items.map((item) => item.kind === schedule.kind ? next : item)); autoSaveSchedule(schedule.kind, next); }}/></label><label>Часовой пояс<input value={schedule.timezone} onChange={(event) => { const next = {...schedule, timezone: event.target.value}; setSchedules((items) => items.map((item) => item.kind === schedule.kind ? next : item)); autoSaveSchedule(schedule.kind, next); }}/></label><div className="status-options">{Object.entries(statusDisplayName).map(([status, name]) => <label key={status}><input type="checkbox" checked={schedule.included_statuses.includes(status as TaskStatus)} onChange={(event) => { const included_statuses = event.target.checked ? [...schedule.included_statuses, status as TaskStatus] : schedule.included_statuses.filter((value) => value !== status); const next = {...schedule, included_statuses}; setSchedules((items) => items.map((item) => item.kind === schedule.kind ? next : item)); if (!included_statuses.length) return; autoSaveSchedule(schedule.kind, next); }}/> {name}</label>)}</div><div className="actions"><button className="secondary" onClick={() => void action(() => saveSchedule(schedule, true), 'Предпросмотр готов', false)}>Предпросмотр</button></div></fieldset>)}{preview && <pre>{preview}</pre>}</div></Disclosure> : null;

  const frequencyOptions = [{ value: 'daily', label: 'Ежедневно' }, { value: 'weekdays', label: 'По будням' }, { value: 'weekly', label: 'Еженедельно' }, { value: 'monthly', label: 'Ежемесячно' }];
  const projectOptions = [{ value: '', label: 'Без проекта' }, ...projects.filter((item) => !item.archived_at).map((item) => ({ value: item.id, label: item.name }))];
  const assigneeOptions = [{ value: '', label: 'Без ответственного' }, ...members.map((member) => ({ value: member.id, label: member.first_name }))];
  const priorityOptions = [{ value: 'normal', label: 'Обычный' }, { value: 'urgent', label: 'Срочный' }];
  const boardOptions = [{ value: '', label: 'Все доски' }, ...boards.map((item) => ({ value: item.id, label: item.name }))];

  const settingsBoardList = (screen: 'settings-workspace' | 'settings-automation') => <div className="settings-list">{boards.map((item) => <button className="settings-list-row" key={item.id} onClick={() => navigate({ screen, boardId: item.id })}><span><strong>{item.name}</strong><small>{boardTypeName(item)}{item.status === 'frozen' ? ' · заморожена' : item.status === 'archived' ? ' · в архиве' : ''}</small></span><Icon name="chevron"/></button>)}{screen === 'settings-workspace' && <button className="secondary" onClick={() => setPairFlow({})}>Создать доску на двоих</button>}</div>;
  const settingsRoot = <SettingsScreen subtitle="Управление пространством и приложением">
    <p className="settings-label">Разделы</p>
    <div className="settings-root">{settingsSections.map((section) => <button className="settings-card" data-tone={section.id} key={section.id} onClick={() => navigate({ screen: `settings-${section.id}` } as NavigationState)}>
      <span className="settings-card-icon" aria-hidden="true">{section.id === 'account' ? initials(profileName) : <Icon name={section.id}/>}</span>
      <span className="settings-card-copy"><strong>{section.title}</strong><small>{section.description}</small><span>{section.id === 'workspace' ? `${countLabel(boards.length, 'доска', 'доски', 'досок')}${settingsCounts ? ` · ${countLabel(settingsCounts.projects, 'проект', 'проекта', 'проектов')}` : ''}` : section.id === 'automation' ? settingsCounts ? `${countLabel(settingsCounts.automations, 'активный сценарий', 'активных сценария', 'активных сценариев')}` : 'Сценарии по доскам' : profileName}</span></span>
      <Icon name="chevron"/>
    </button>)}</div>
    <div className="settings-footer">Версия 0.1 · <button className="link" onClick={() => setEntryPath('help')}>Помощь</button></div>
  </SettingsScreen>;
  const workspaceSettings = <SettingsScreen title={board?.name ?? 'Рабочее пространство'} subtitle={board ? 'Доска, проекты и участники' : 'Доски, проекты и участники'}>
    <button className="back settings-back" onClick={() => navigate({ screen: 'settings' })}><Icon name="back"/>Настройки</button>
    {board?.type === 'pair' && <ActionRow label="Доступ" value={board.status === 'archived' ? 'Доска в архиве' : 'Доска на двоих'} onClick={() => setPairFlow({ board })}/>}
    {!board ? settingsBoardList('settings-workspace') : <fieldset className="settings-groups readonly-fields" disabled={board.status === 'archived' || board.status === 'frozen'}>
      <section className="settings-group"><h2>Доска</h2>{(board.status === 'draft' || board.role === 'owner' || board.role === 'admin') ? <div className="settings-form inline-form"><label>Название<input name="name" defaultValue={board.name} maxLength={120} required onBlur={(event) => void saveBoardName(event.target.value)}/></label></div> : <p>{board.name}</p>}<small>{board.type === 'chat' ? 'Права администратора Telegram проверяются при изменении чат-доски.' : board.type === 'pair' ? 'Приглашениями и архивом управляет владелец.' : 'Личное рабочее пространство.'}</small></section>
      <section className="settings-group"><h2>Проекты</h2>{projects.filter((item) => !item.archived_at).map((item) => <div className="settings-form inline-form" key={item.id}><input aria-label={`Название проекта ${item.name}`} name="name" defaultValue={item.name} maxLength={120} required onBlur={(event) => autoSaveProject(item, event.target.value)}/><button className="secondary" type="button" onClick={() => void action(() => api(`/api/boards/${board.id}/projects/${item.id}`, json('PATCH', {archived: true})), 'Проект архивирован')}>В архив</button></div>)}<form className="settings-form inline-form" onSubmit={(event) => void addProject(event)}><input aria-label="Название нового проекта" name="name" placeholder="Новый проект" maxLength={120} required/><button disabled={projectCreatePending}>{projectCreatePending ? 'Добавляем…' : 'Добавить'}</button></form></section>
      <section className="settings-group"><h2>Участники</h2><div className="member-list">{members.map((member) => <div key={member.id}><Avatar initials={initials(member.first_name)} label={member.first_name}/><span><strong>{member.first_name}</strong><small>{member.username ? `@${member.username}` : 'Telegram'}</small></span></div>)}</div></section>
    </fieldset>}
  </SettingsScreen>;
  const automationSettings = <SettingsScreen title={board?.name ?? 'Автоматизация'} subtitle={board ? 'Повторения, публикации и уведомления' : 'Выберите доску для настройки'}>
    <button className="back settings-back" onClick={() => navigate({ screen: 'settings' })}><Icon name="back"/>Настройки</button>
    {!board ? settingsBoardList('settings-automation') : <fieldset className="settings-groups readonly-fields" disabled={board.status !== 'active'}>
      <section className="settings-group"><h2>Повторения</h2><form className="settings-form" onSubmit={(event) => void addRecurrence(event)}>
        <label>Название задачи<input name="title" maxLength={200} required/></label><ChoiceAction label="Период" value={recurrenceFrequency} options={frequencyOptions} onChange={(value) => setRecurrenceFrequency(value as Recurrence['frequency'])}/>
        {(recurrenceFrequency === 'weekdays' || recurrenceFrequency === 'weekly') && <label>Дни недели (0–6)<input name="weekdays" defaultValue={recurrenceFrequency === 'weekdays' ? '1,2,3,4,5' : String(new Date().getDay())} pattern="[0-6](,[0-6])*" required/></label>}{recurrenceFrequency === 'monthly' && <label>День месяца<input name="dayOfMonth" type="number" min="1" max="31" defaultValue={new Date().getDate()} required/></label>}
        <label>Время<input name="localTime" type="time" defaultValue="09:00" required/></label><label>Часовой пояс<input name="timezone" defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone} required/></label><label>Дата начала<input name="startDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required/></label><label>Дата окончания<input name="endDate" type="date"/></label>
        <ChoiceAction label="Проект" name="projectId" value={recurrenceProjectId} options={projectOptions} onChange={setRecurrenceProjectId}/><ChoiceAction label="Исполнитель" name="assigneeUserId" value={recurrenceAssigneeId} options={assigneeOptions} onChange={setRecurrenceAssigneeId}/><ChoiceAction label="Приоритет" name="priority" value={recurrencePriority} options={priorityOptions} onChange={(value) => setRecurrencePriority(value as Task['priority'])}/><button>Добавить повтор</button>
      </form>{recurrences.filter((item) => !item.archived_at).map((item) => <div className="automation-row" key={item.id}><span><strong>{item.title}</strong><small>{item.frequency} · {item.local_time}</small></span><button className="secondary" onClick={() => void action(() => api(`/api/boards/${board.id}/recurrences/${item.id}`, json('PATCH', {paused: !item.paused_at})), item.paused_at ? 'Повтор включён' : 'Повтор приостановлен')}>{item.paused_at ? 'Включить' : 'Пауза'}</button></div>)}</section>
      {publicationSettings}<section className="settings-group"><h2>Уведомления</h2><p>Уведомление исполнителю выбирается при назначении задачи. Новых глобальных типов уведомлений пока нет.</p></section>
    </fieldset>}
  </SettingsScreen>;
  const accountSettings = <SettingsScreen title="Аккаунт" subtitle="Профиль и личные параметры"><button className="back settings-back" onClick={() => navigate({ screen: 'settings' })}><Icon name="back"/>Настройки</button><div className="settings-groups"><section className="settings-group account-profile"><Avatar initials={initials(profileName)} label={profileName}/><span><strong>{profileName}</strong>{profileUsername && <small>{profileUsername}</small>}</span></section><section className="settings-group"><h2>Личные параметры</h2><div className="settings-form"><ChoiceAction label="Группировка задач" value={grouping} options={[{ value: 'deadline', label: 'По срокам' }, { value: 'project', label: 'По проектам' }]} onChange={(value) => setGrouping(value as typeof grouping)}/><ChoiceAction label="Обычная доска" value={globalBoardId} options={boardOptions} onChange={chooseTaskBoard}/></div></section><ActionRow label="Подключения" value="Доступ к задачам из AI-клиентов" onClick={()=>navigate({screen:'settings-connections'})}/></div></SettingsScreen>;

  if (state === 'outside') return <main><EnvironmentStatus/><section><p className="eyebrow">KAIROS TASKS</p><h1>Задачи живут<br/>в Telegram</h1><p>Откройте приложение через <a href="https://t.me/kairostask_bot">@kairostask_bot</a>.</p></section></main>;
  if (state === 'error') return <main><EnvironmentStatus/><section role="alert"><h1>Не удалось войти</h1><p>{message || 'Закройте приложение и откройте его снова через бота.'}</p></section></main>;
  if (state === 'loading') return <main><EnvironmentStatus/><Skeleton label="Загрузка приложения"/></main>;
  if (taskLinkError) return <main><EnvironmentStatus/><section role="alert"><p className="eyebrow">ОШИБКА {taskLinkError}</p><h1>{taskLinkError === 403 ? 'Нет доступа к задаче' : 'Задача не найдена'}</h1><p>{taskLinkError === 403 ? 'У вас нет доступа к доске этой задачи.' : 'Ссылка повреждена или задача больше недоступна.'}</p><button onClick={() => { setTaskLinkError(undefined); setBoardOverrideId(undefined); }}>К задачам</button></section></main>;
  if (navigation.screen === 'settings') return <AppShell message={message} navigation={navigation} navigate={navigate}>{settingsRoot}</AppShell>;
  if (navigation.screen === 'settings-workspace') return <AppShell message={message} navigation={navigation} navigate={navigate}>{workspaceSettings}</AppShell>;
  if (navigation.screen === 'settings-automation') return <AppShell message={message} navigation={navigation} navigate={navigate}>{automationSettings}</AppShell>;
  if (navigation.screen === 'settings-account') return <AppShell message={message} navigation={navigation} navigate={navigate}>{accountSettings}</AppShell>;
  if (navigation.screen === 'settings-connections') return <McpConnections navigate={navigate}/>;
  if (navigation.screen === 'tasks') return <AppShell message={message} navigation={navigation} navigate={navigate}><TasksScreen boardName={board?.name ?? 'Все доски'} onSelectBoard={() => setShowBoardSheet(true)}>
    {board?.type === 'pair' && <><ActionRow label="Доступ" value={board.status === 'archived' ? 'Доска в архиве' : 'Доска на двоих'} onClick={() => setPairFlow({ board })}/>{board.status === 'archived' && <p className="notice">Доска в архиве. Задачи и история доступны только для чтения.</p>}</>}
    {taskToolbar}{backlog && board ? backlogContent : <>{taskLoadState === 'loading' ? <Skeleton label="Загрузка задач"/> : taskLoadState === 'error' ? <div className="task-state" role="alert"><p>Не удалось загрузить задачи.</p><button onClick={() => setTaskReload((value) => value + 1)}>Повторить</button></div> : taskView === 'kanban' ? mainKanban : groupedTaskList}{taskLoadState === 'ready' && taskView === 'list' && !filteredTasks.length && (board?.status === 'active' && !tasks.length ? <section className="task-state"><h2>Начните с первой задачи.</h2><p>Добавьте задачу или вставьте список. Исполнителя можно выбрать позже.</p><button onClick={() => navigate({ screen: 'create' })}>Добавить задачу</button><button className="secondary" onClick={() => { setBulkDraft({ boardId: board.id, boardName: board.name, projects, project: '', text: '', started: false }); setBulkOpen(true); }}>Вставить список</button></section> : <p className="task-state">{tasks.length ? 'Задач по этим условиям нет.' : 'Назначенных задач пока нет.'}</p>)}</>}{boardOverrideId && <p className="context-note">Открыта доска по ссылке; ваш обычный выбор не изменён.</p>}{boardSheet}{filterSheet}{advancedFilterSheet}{filterChoiceSheet}{kanbanStatusSheet}</TasksScreen></AppShell>;
  if (navigation.screen === 'create') return <AppShell message={message} navigation={navigation} navigate={navigate} hideNavigation><CreateScreen boardName={boards.find((item) => item.id === createBoardId)?.name ?? 'Все доски'} onClose={() => navigate(createOrigin)} onSelectBoard={() => { if (!createLock.current && !createUncertain) setCreateChoice('board'); }}>
    <form onSubmit={(event) => { event.preventDefault(); void create(); }}><fieldset className="create-screen-form" disabled={createPending || createUncertain}>
      <label className="create-title"><span>Что нужно сделать?</span><TaskGlyph/><textarea autoFocus value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} rows={2} required placeholder="Название задачи"/></label>
      <div className="create-fields">
        <ActionRow label="Проект" value={projects.find((item) => item.id === project)?.name ?? 'Без проекта'} icon={<Icon name="project"/>} disabled={!createBoardId} onClick={() => setCreateChoice('project')}/>
        <ActionRow label="Исполнитель" value={members.find((item) => item.id === assignee)?.first_name ?? 'Без ответственного'} icon={<Icon name="assignee"/>} disabled={!createBoardId} onClick={() => setCreateChoice('assignee')}/>
        <DeadlineField value={due} onChange={setDue} disabled={createPending}/>
        <ActionRow label="Статус" value={createStatus === 'todo' ? 'К выполнению' : statusDisplayName[createStatus]} icon={<Icon name="tasks"/>} disabled={createPending} onClick={() => { setStatusChoice(createStatus); setCreateChoice('status'); }}/>
        {createStatus === 'waiting' && <ActionRow label="Причина блокера" value={createTasks.find((item) => item.id === createBlockerId)?.title ?? (createWaitReason || 'Укажите причину')} onClick={() => setCreateBlockerOpen(true)}/>}
        <ActionRow label="Доска" value={boards.find((item) => item.id === createBoardId)?.name ?? 'Выберите доску'} icon={<Icon name="board"/>} onClick={() => setCreateChoice('board')}/>
      </div>
      <Disclosure key={createReset} label="Дополнительно" icon={<Icon name="sliders"/>}><div className="create-additional-fields"><label>Описание<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3}/></label><ActionRow label="Приоритет" value={priority === 'urgent' ? 'Срочный' : 'Обычный'} onClick={() => setCreateChoice('priority')}/><label className="checkbox"><input type="checkbox" checked={notifyAssignee} disabled={!assignee} onChange={(event) => setNotifyAssignee(event.target.checked)}/> Уведомить исполнителя</label></div></Disclosure>
      <p className="create-additional-hint">Описание, приоритет и уведомление исполнителя</p>
    </fieldset><div className="create-action"><button disabled={createPending || !title.trim() || !createBoardId}>{createPending ? 'Создаём…' : 'Создать задачу'}</button><button type="button" className="secondary" disabled={createPending || !title.trim() || !createBoardId} onClick={() => void create(true)}>Создать и добавить ещё</button></div></form>
    {createChoiceSheet}
    {createBlockerOpen && <Sheet className="task-sheet create-blocker-sheet" title="Причина блокера" onClose={() => setCreateBlockerOpen(false)}>
      <p>{title}</p><div className="choice-list" role="radiogroup" aria-label="Тип блокера">
        <ChoiceRow label="Внешняя причина" selected={blockerKind === 'external'} onClick={() => { setBlockerKind('external'); setCreateBlockerId(''); }}/>
        <ChoiceRow label="Другая задача" selected={blockerKind === 'task'} onClick={() => { setBlockerKind('task'); setCreateWaitReason(''); }}/>
      </div>
      {blockerKind === 'external' ? <label>Что мешает начать?<textarea aria-label="Внешняя причина" value={createWaitReason} maxLength={1000} onChange={(event) => setCreateWaitReason(event.target.value)}/></label> : <>
        <input type="search" aria-label="Найти задачу-блокер" placeholder="Найти задачу" value={blockerSearch} onChange={(event) => setBlockerSearch(event.target.value)}/>
        <div className="choice-list" role="radiogroup" aria-label="Задача-блокер">{createTasks.filter((item) => item.status !== 'done' && !item.archived_at && item.title.toLocaleLowerCase('ru').includes(blockerSearch.toLocaleLowerCase('ru'))).map((item) => <ChoiceRow key={item.id} label={item.title} selected={createBlockerId === item.id} onClick={() => setCreateBlockerId(item.id)}/>)}</div>
        {!createTasks.some((item) => item.status !== 'done' && !item.archived_at) && <p>Доступных задач-блокеров нет. Укажите внешнюю причину.</p>}
      </>}
      <label>Дата проверки<input type="date" value={createWaitCheck} onChange={(event) => setCreateWaitCheck(event.target.value)}/></label>
      <small>Причина будет видна участникам доски.</small>
      <button type="button" className="filter-apply" disabled={!createBlockerId && !createWaitReason.trim()} onClick={() => setCreateBlockerOpen(false)}>Подтвердить блокер</button>
      <button type="button" className="sheet-close secondary" onClick={() => setCreateBlockerOpen(false)}>Назад</button>
    </Sheet>}
  </CreateScreen></AppShell>;
  if (board) return <AppShell message={message} navigation={navigation} navigate={navigate}><button className="back" onClick={() => navigate({ screen: 'tasks' })}>← Задачи</button><header><p className="eyebrow">{board.type === 'chat' ? 'ЧАТ-ДОСКА' : 'ЛИЧНАЯ ДОСКА'}</p><h1>{board.name}</h1></header>{publicationSettings}{board.status === 'frozen' ? <p className="notice">Бот больше не в чате. Данные сохранены, действия заморожены.</p> : board.status === 'draft' ? <section><p>Завершите настройку, чтобы команда начала работу.</p><button onClick={activate}>Активировать</button></section> : <><section className="recurrences"><div className="project-row"><strong>Повторы</strong><button className="secondary" onClick={addRecurrence}>Добавить повтор</button></div>{recurrences.map((item) => <article className="recurrence" key={item.id}><span>{item.frequency} · {item.local_time} · {item.timezone}</span><strong>{item.title}</strong>{item.next_occurrence_at && <small>Следующий: {new Date(item.next_occurrence_at).toLocaleString('ru-RU')}</small>}<div className="actions">{!item.archived_at && <button onClick={() => action(() => api(`/api/boards/${board.id}/recurrences/${item.id}`, json('PATCH', {paused: !item.paused_at})), item.paused_at ? 'Повтор продолжен' : 'Повтор на паузе')}>{item.paused_at ? 'Продолжить' : 'Пауза'}</button>}<button onClick={() => action(() => api(`/api/boards/${board.id}/recurrences/${item.id}`, json('PATCH', {archived: true})), 'Повтор архивирован')}>В архив</button></div></article>)}</section><div className="project-row"><div>{projects.map((item) => <span key={item.id}><button className="link" onClick={() => item.archived_at ? action(() => api(`/api/boards/${board.id}/projects/${item.id}`, json('PATCH', {archived: false})), 'Проект восстановлен') : editProject(item)}>{item.name}{item.archived_at ? ' · восстановить' : ''}</button>{!item.archived_at && <button className="link" onClick={() => action(() => api(`/api/boards/${board.id}/projects/${item.id}`, json('PATCH', {archived: true})), 'Проект архивирован')}>×</button>}</span>)}</div><button className="secondary" onClick={addProject}>+ Проект</button></div><button className="secondary" onClick={() => { const next = !showArchive; setShowArchive(next); void loadBoard(board.id, next); }}>{showArchive ? 'Только активные' : 'Показать архив'}</button>{taskControls}{taskView === 'kanban' && !showArchive ? kanban : taskList}{!filteredTasks.length && <p>{filters.search ? 'Ничего не найдено.' : 'Задач в этом срезе пока нет.'}</p>}</>}{board.type === 'chat' && board.status !== 'frozen' && <button className="secondary" onClick={() => action(async () => { const result = await api<{url: string}>(`/api/boards/${board.id}/invites`, {method: 'POST'}); await navigator.clipboard.writeText(result.url); }, 'Ссылка скопирована', false)}>Скопировать приглашение</button>}</AppShell>;
  const boardList = <div className="board-list">{boards.map((item) => <button className="board" key={item.id} onClick={() => { setMessage(''); setNavigation({ screen: 'board', boardId: item.id }); }}><span>{item.type === 'chat' ? 'ЧАТ' : 'ЛИЧНАЯ'}{item.status === 'frozen' ? ' · ЗАМОРОЖЕНА' : ''}</span><strong>{item.name}</strong><small>{item.type === 'chat' ? 'Командное пространство' : 'Только ваши задачи'}</small></button>)}</div>;
  return <AppShell message={message} navigation={navigation} navigate={navigate}><SettingsScreen>{boardList}</SettingsScreen></AppShell>;
}
const fixture = new URLSearchParams(location.search).get('fixture');
createRoot(document.getElementById('root')!).render(<React.StrictMode>{fixture === 'foundation' ? <FoundationFixture/> : <App/>}</React.StrictMode>);
