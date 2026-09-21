import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateInitData } from './auth.js';
import { activateChatBoard, addChecklistItem, addTaskAttachment, addTaskComment, boardForUser, boardMembers, boardsForUser, claimAssignmentNotification, connectChatBoard, createInvite, createProject, createRecurrence, createTask, deleteChecklistItem, finishAssignmentNotification, freezeChatBoard, incompleteChecklistCount, login, migrateChatBoard, pendingNotificationForTask, ProjectConflictError, projectsForBoard, recurrencesForBoard, redeemBoardLink, renameBoard, revokeInvites, saveTaskFilterState, sessionUser, sessionUserId, setTaskArchived, taskCollaboration, TaskActionError, TaskConflictError, taskFilterState, taskForBoard, tasksForAssignee, tasksForBoard, updateChecklistItem, updateProject, updateRecurrence, updateTask, updateTaskAndFuture, type AttachmentInput, type Database, type RecurrenceInput, type TaskInput } from './db.js';
import type { Config } from './config.js';
import { isChatAdmin, telegramCall } from './telegram.js';
import { renderPublication, schedulesForBoard, updateSchedule, validTimezone as validPublicationTimezone, type PublicationKind, type PublicationSchedule } from './publications.js';
import { validTimezone } from './recurrence.js';
import { claimTask } from './db.js';
import { BoardAccessError, changePairInvite, createPairBoard, previewPairInvite, redeemPairInvite, removePairMember, setPairArchived } from './pair-boards.js';
import { sendBotEntry, sendGroupWelcome } from './bot-entry.js';
import { taskInput } from './task-input.js';
import { recurrenceInput } from './recurrence-input.js';
import { ChecklistConfirmationError } from './db.js';
import { registerMcp } from './mcp.js';

type ChatMemberUpdate = {
  date: number;
  chat: { id: number; title?: string; type: string };
  old_chat_member: { status: string; user: { is_bot: boolean } };
  new_chat_member: { status: string; user: { is_bot: boolean } };
};
type TelegramUpdate = { update_id: number; my_chat_member?: ChatMemberUpdate; message?: { message_id: number; chat: { id: number; type: string }; text?: string; migrate_to_chat_id?: number; migrate_from_chat_id?: number } };
type TaskPatchInput = TaskInput & { confirmIncompleteChecklist?: boolean };
const present = (status: string) => status === 'member' || status === 'administrator';

export function buildApp(config: Config, db: Database) {
  const app = Fastify({ logger: { serializers: { req: (request) => ({ method: request.method, url: request.url?.split('?')[0].replace(/^\/mcp.*$/, '/mcp').replace(/^(\/api\/mcp-connections)\/.*$/, '$1/:id') }) }, redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers.x-telegram-bot-api-secret-token', 'body.initData'] } });
  app.register(cookie);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof BoardAccessError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof ChecklistConfirmationError) return reply.code(409).send({ error: error.message, incompleteChecklist: error.count });
    if (request.url.startsWith('/mcp') || request.url.startsWith('/api/mcp-connections')) {
      request.log.error({ code: (error as {code?: string}).code }, 'MCP request failed');
      return reply.code((error as {statusCode?: number}).statusCode ?? 500).send({ error: 'Не удалось выполнить действие' });
    }
    request.log.error(error);
    return reply.code((error as {statusCode?: number}).statusCode ?? 500).send({ error: 'Не удалось выполнить действие' });
  });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  app.addHook('preHandler', async (request, reply) => {
    const params = request.params as {id?: string};
    if (request.url.startsWith('/api/boards/') && params.id && !uuid.test(params.id)) return reply.code(400).send({ error: 'invalid board id' });
  });
  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  app.register(fastifyStatic, { root: publicDir });
  app.get('/health', async () => { await db.query('SELECT 1'); return { status: 'ok' }; });

  app.post<{Body: {initData?: string}}>('/api/auth/telegram', async (request, reply) => {
    try {
      const telegram = validateInitData(request.body?.initData ?? '', config.botToken, config.initDataMaxAgeSeconds);
      const session = await login(db, telegram, config.sessionMaxAgeSeconds, config.sessionSecret);
      reply.setCookie('session', session.token, { path: '/', httpOnly: true, secure: config.production, sameSite: 'strict', maxAge: config.sessionMaxAgeSeconds });
      return { ok: true, userId: session.userId };
    } catch (error) {
      request.log.warn({ reason: error instanceof Error ? error.message : 'unknown' }, 'Telegram authentication rejected');
      return reply.code(401).send({ error: 'invalid Telegram launch' });
    }
  });

  async function userId(request: {cookies: Record<string, string | undefined>}, reply: {code: (n: number) => {send: (v: unknown) => unknown}}) {
    const id = await sessionUserId(db, request.cookies.session, config.sessionSecret);
    if (!id) return reply.code(401).send({ error: 'authentication required' });
    return id;
  }
  app.get('/api/boards', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    return { boards: await boardsForUser(db, id) };
  });
  app.get<{Params: {id: string}}>('/api/boards/:id', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const board = await boardForUser(db, id, request.params.id);
    return board ?? reply.code(404).send({ error: 'board not found' });
  });
  app.post<{Body: {name?: unknown; requestId?: unknown}}>('/api/boards/pair', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    const requestId = request.body?.requestId;
    if (!name || name.length > 120 || typeof requestId !== 'string' || !uuid.test(requestId)) return reply.code(400).send({ error: 'Укажите название доски от 1 до 120 символов и корректный идентификатор запроса' });
    return createPairBoard(db, id, name, requestId);
  });
  app.post<{Body: {token?: unknown}}>('/api/board-links/preview', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const token = request.body?.token;
    if (typeof token !== 'string' || !/^pair_[A-Za-z0-9_-]{32}$/.test(token)) return reply.code(400).send({ error: 'Приглашение больше не действует' });
    return await previewPairInvite(db, id, token) ?? reply.code(404).send({ error: 'Приглашение больше не действует' });
  });
  app.post<{Params: {id: string}, Body: {archived?: unknown}}>('/api/boards/:id/archive', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    if (typeof request.body?.archived !== 'boolean') return reply.code(400).send({ error: 'archived must be boolean' });
    return setPairArchived(db, id, request.params.id, request.body.archived);
  });
  app.delete<{Params: {id: string}, Body: {participantId?: unknown}}>('/api/boards/:id/participant', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const participantId = request.body?.participantId;
    if (typeof participantId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(participantId) || participantId === id) return reply.code(400).send({ error: 'invalid participant id' });
    return removePairMember(db, id, request.params.id, participantId);
  });
  app.post<{Params: {id: string}}>('/api/boards/:id/leave', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    return removePairMember(db, id, request.params.id, id);
  });
  app.post<{Body: {token?: string; acceptedHistory?: boolean}}>('/api/board-links/redeem', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const token = request.body?.token;
    if (typeof token !== 'string' || !token || token.length > 128) return reply.code(400).send({ error: 'invalid board link' });
    if (token.startsWith('pair_') && !/^pair_[A-Za-z0-9_-]{32}$/.test(token)) return reply.code(400).send({ error: 'invalid board link' });
    const board = token.startsWith('pair_') ? await redeemPairInvite(db, id, token, request.body.acceptedHistory === true) : await redeemBoardLink(db, id, token);
    return board ?? reply.code(404).send({ error: 'board link is invalid or revoked' });
  });
  app.post<{Params: {id: string}, Body: {name?: string}}>('/api/boards/:id/activate', async (request, reply) => {
    const user = await sessionUser(db, request.cookies.session, config.sessionSecret);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    const board = await boardForUser(db, user.id, request.params.id);
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    if (!board || board.type !== 'chat') return reply.code(404).send({ error: 'board not found' });
    if (!name || name.length > 120) return reply.code(400).send({ error: 'name must contain 1-120 characters' });
    if (!await isChatAdmin(config.botToken, board.telegram_chat_id, user.telegram_id)) return reply.code(403).send({ error: 'Telegram chat admin required' });
    return await activateChatBoard(db, user.id, request.params.id, name) ?? reply.code(409).send({ error: 'Доска заморожена. Верните бота в группу.' });
  });
  app.get<{Params: {id: string}}>('/api/boards/:id/setup', async (request, reply) => {
    const user = await sessionUser(db, request.cookies.session, config.sessionSecret);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    const board = await boardForUser(db, user.id, request.params.id);
    if (!board || board.type !== 'chat') return reply.code(404).send({ error: 'board not found' });
    const canActivate = board.status === 'draft' && await isChatAdmin(config.botToken, board.telegram_chat_id, user.telegram_id);
    return { board, canActivate };
  });
  app.get('/api/bot-entry', async () => ({ groupUrl: `https://t.me/${config.botUsername}?startgroup=tasks` }));
  app.post<{Params: {id: string}}>('/api/boards/:id/invites', async (request, reply) => {
    const user = await sessionUser(db, request.cookies.session, config.sessionSecret);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    const board = await boardForUser(db, user.id, request.params.id);
    if (!board || !['chat', 'pair'].includes(board.type)) return reply.code(404).send({ error: 'board not found' });
    if (board.type === 'chat' && !await isChatAdmin(config.botToken, board.telegram_chat_id, user.telegram_id)) return reply.code(403).send({ error: 'Telegram chat admin required' });
    const token = board.type === 'pair' ? await changePairInvite(db, user.id, board.id) : await createInvite(db, user.id, board.id);
    return token ? { url: `https://t.me/${config.botUsername}?startapp=${encodeURIComponent(token)}` } : reply.code(404).send({ error: 'board not found' });
  });
  app.delete<{Params: {id: string}}>('/api/boards/:id/invites', async (request, reply) => {
    const user = await sessionUser(db, request.cookies.session, config.sessionSecret);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    const board = await boardForUser(db, user.id, request.params.id);
    if (board?.type === 'pair') { await changePairInvite(db, user.id, board.id, true); return { revoked: true }; }
    if (!board || board.type !== 'chat') return reply.code(404).send({ error: 'board not found' });
    if (!await isChatAdmin(config.botToken, board.telegram_chat_id, user.telegram_id)) return reply.code(403).send({ error: 'Telegram chat admin required' });
    return { revoked: await revokeInvites(db, user.id, request.params.id) };
  });
  app.patch<{Params: {id: string}, Body: {name?: string}}>('/api/boards/:id', async (request, reply) => {
    const user = await sessionUser(db, request.cookies.session, config.sessionSecret);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    const name = request.body?.name?.trim();
    if (!name || name.length > 120) return reply.code(400).send({ error: 'name must contain 1-120 characters' });
    const board = await boardForUser(db, user.id, request.params.id);
    if (board?.type === 'chat' && !await isChatAdmin(config.botToken, board.telegram_chat_id, user.telegram_id)) return reply.code(403).send({ error: 'Telegram chat admin required' });
    const renamed = await renameBoard(db, user.id, request.params.id, name);
    return renamed ?? reply.code(404).send({ error: 'board not found' });
  });

  const scheduleInput = (body: Omit<PublicationSchedule, 'kind'> | undefined) => {
    if (!body || typeof body.enabled !== 'boolean') return 'enabled must be boolean';
    if (!Array.isArray(body.weekdays) || !body.weekdays.length || body.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) return 'invalid weekdays';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.local_time)) return 'invalid local time';
    if (!validPublicationTimezone(body.timezone)) return 'invalid timezone';
    if (!Array.isArray(body.included_statuses) || body.included_statuses.some((status) => !['todo', 'in_progress', 'waiting', 'done'].includes(status))) return 'invalid statuses';
    return body;
  };
  app.get<{Params: {id: string}}>('/api/boards/:id/publications', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const board = await boardForUser(db, id, request.params.id);
    return board?.type === 'chat' ? { schedules: await schedulesForBoard(db, id, request.params.id) } : reply.code(404).send({ error: 'chat board not found' });
  });
  app.put<{Params: {id: string; kind: PublicationKind}, Body: Omit<PublicationSchedule, 'kind'>}>('/api/boards/:id/publications/:kind', async (request, reply) => {
    const user = await sessionUser(db, request.cookies.session, config.sessionSecret);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    const board = await boardForUser(db, user.id, request.params.id);
    if (!board || board.type !== 'chat' || !['daily', 'weekly'].includes(request.params.kind)) return reply.code(404).send({ error: 'publication not found' });
    if (!await isChatAdmin(config.botToken, board.telegram_chat_id, user.telegram_id)) return reply.code(403).send({ error: 'Telegram chat admin required' });
    const input = scheduleInput(request.body); if (typeof input === 'string') return reply.code(400).send({ error: input });
    return updateSchedule(db, board.id, request.params.kind, input);
  });
  app.post<{Params: {id: string; kind: PublicationKind}, Body: Omit<PublicationSchedule, 'kind'>}>('/api/boards/:id/publications/:kind/preview', async (request, reply) => {
    const user = await sessionUser(db, request.cookies.session, config.sessionSecret);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    const board = await boardForUser(db, user.id, request.params.id);
    if (!board || board.type !== 'chat' || !['daily', 'weekly'].includes(request.params.kind)) return reply.code(404).send({ error: 'publication not found' });
    if (!await isChatAdmin(config.botToken, board.telegram_chat_id, user.telegram_id)) return reply.code(403).send({ error: 'Telegram chat admin required' });
    const input = scheduleInput(request.body); if (typeof input === 'string') return reply.code(400).send({ error: input });
    return { messages: await renderPublication(db, board.id, request.params.kind, input.included_statuses, config.botUsername, input.timezone) };
  });

  app.get('/api/tasks/mine', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    return { tasks: await tasksForAssignee(db, id) };
  });
  app.get<{Params: {id: string}}>('/api/boards/:id/members', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    return { members: await boardMembers(db, id, request.params.id) };
  });
  app.get<{Params: {id: string}}>('/api/boards/:id/task-filters', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    return { filters: await taskFilterState(db, id, request.params.id) };
  });
  app.put<{Params: {id: string}, Body: {filters?: unknown}}>('/api/boards/:id/task-filters', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const filters = request.body?.filters;
    if (!filters || typeof filters !== 'object' || Array.isArray(filters) || JSON.stringify(filters).length > 2000) return reply.code(400).send({ error: 'invalid filters' });
    const saved = await saveTaskFilterState(db, id, request.params.id, filters);
    return saved ? { filters: saved } : reply.code(404).send({ error: 'board not found' });
  });
  app.get<{Params: {id: string}, Querystring: {archived?: string}}>('/api/boards/:id/projects', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    return { projects: await projectsForBoard(db, id, request.params.id, request.query.archived === 'true') };
  });
  app.post<{Params: {id: string}, Body: {name?: string}}>('/api/boards/:id/projects', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const name = request.body?.name?.trim();
    if (!name || name.length > 120) return reply.code(400).send({ error: 'name must contain 1-120 characters' });
    const project = await createProject(db, id, request.params.id, name);
    return project ?? reply.code(404).send({ error: 'board not found' });
  });
  app.patch<{Params: {id: string; projectId: string}, Body: {name?: string; archived?: boolean}}>('/api/boards/:id/projects/:projectId', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const name = request.body?.name?.trim();
    if (request.body?.name !== undefined && (!name || name.length > 120)) return reply.code(400).send({ error: 'name must contain 1-120 characters' });
    if (request.body?.archived !== undefined && typeof request.body.archived !== 'boolean') return reply.code(400).send({ error: 'archived must be boolean' });
    if (name === undefined && request.body?.archived === undefined) return reply.code(400).send({ error: 'project change is required' });
    let project;
    try { project = await updateProject(db, id, request.params.id, request.params.projectId, { name, archived: request.body.archived }); }
    catch (error) {
      if (error instanceof ProjectConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
    return project ?? reply.code(404).send({ error: 'project not found' });
  });
  app.get<{Params: {id: string}, Querystring: {archived?: string}}>('/api/boards/:id/tasks', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    return { tasks: await tasksForBoard(db, id, request.params.id, request.query.archived === 'true') };
  });
  app.get<{Params: {id: string; taskId: string}}>('/api/boards/:id/tasks/:taskId', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    if (!await boardForUser(db, id, request.params.id)) return reply.code(403).send({ error: 'task access forbidden' });
    return await taskForBoard(db, id, request.params.id, request.params.taskId) ?? reply.code(404).send({ error: 'task not found' });
  });

  const sendTaskNotification = async (taskId: string, kind = 'assignment') => {
    const notificationId = await pendingNotificationForTask(db, taskId, kind);
    if (!notificationId) return null;
    const notification = await claimAssignmentNotification(db, notificationId);
    if (!notification) return null;
    try {
      const text = notification.kind === 'unblocked' ? `Задача разблокирована: ${notification.title}` : `Вам назначена задача: ${notification.title}`;
      await telegramCall(config.botToken, 'sendMessage', { chat_id: notification.telegram_id, text });
      await finishAssignmentNotification(db, notificationId); return null;
    } catch (error) {
      await finishAssignmentNotification(db, notificationId, error instanceof Error ? error.message : 'Telegram delivery failed');
      return 'Задача сохранена, но уведомление не доставлено';
    }
  };
  app.post<{Params: {id: string}, Body: TaskInput}>('/api/boards/:id/tasks', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const input = taskInput(request.body); if (typeof input === 'string') return reply.code(400).send({ error: input });
    let task;
    try { task = await createTask(db, id, request.params.id, input); }
    catch (error) {
      if (error instanceof TaskActionError) return reply.code(403).send({ error: error.message });
      if (error instanceof TaskConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
    if (!task) return reply.code(404).send({ error: 'board, project or assignee not found' });
    return { ...task, notificationWarning: input.notifyAssignee ? await sendTaskNotification(task.id) : null };
  });
  app.post<{Params: {id: string; taskId: string}}>('/api/boards/:id/tasks/:taskId/claim', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(request.params.id) || !uuid.test(request.params.taskId)) return reply.code(400).send({ error: 'invalid task reference' });
    try {
      const result = await claimTask(db, id, request.params.id, request.params.taskId);
      if (!result) return reply.code(404).send({ error: 'Задача не найдена' });
      const task = await taskForBoard(db, id, request.params.id, request.params.taskId);
      if (result.claimed && !task) return reply.code(403).send({ error: 'Задача больше недоступна' });
      return result.claimed ? task : reply.code(409).send({ error: 'Задача уже назначена или больше не входит в бэклог', task });
    } catch (error) {
      if (error instanceof TaskActionError) return reply.code(403).send({ error: error.message });
      throw error;
    }
  });
  app.patch<{Params: {id: string; taskId: string}, Querystring: {scope?: string}, Body: TaskPatchInput}>('/api/boards/:id/tasks/:taskId', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const input = taskInput(request.body, true); if (typeof input === 'string') return reply.code(400).send({ error: input });

    let task;
    try {
      task = request.query.scope === 'future'
        ? await updateTaskAndFuture(db, id, request.params.id, request.params.taskId, input)
        : await updateTask(db, id, request.params.id, request.params.taskId, input);
    } catch (error) {
      if (error instanceof ChecklistConfirmationError) return reply.code(409).send({ error: error.message, incompleteChecklist: error.count });
      if (error instanceof TaskConflictError) return reply.code(409).send({ error: error.message });
      if (error instanceof TaskActionError) return reply.code(403).send({ error: error.message });
      throw error;
    }
    if (!task) return reply.code(403).send({ error: 'task action is not allowed' });
    const warnings = await Promise.all([
      ...(input.notifyAssignee ? [sendTaskNotification(task.id)] : []),
      ...task.unblockedTaskIds.map((taskId: string) => sendTaskNotification(taskId, 'unblocked'))
    ]);
    return { ...task, notificationWarning: warnings.find(Boolean) ?? null };
  });
  app.delete<{Params: {id: string; taskId: string}}>('/api/boards/:id/tasks/:taskId', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    return await setTaskArchived(db, id, request.params.id, request.params.taskId, true)
      ? { archived: true } : reply.code(403).send({ error: 'task action is not allowed' });
  });
  app.post<{Params: {id: string; taskId: string}}>('/api/boards/:id/tasks/:taskId/reopen', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    return await setTaskArchived(db, id, request.params.id, request.params.taskId, false)
      ? { archived: false } : reply.code(403).send({ error: 'task action is not allowed' });
  });

  app.get<{Params: {id: string; taskId: string}}>('/api/boards/:id/tasks/:taskId/collaboration', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    return await taskCollaboration(db, id, request.params.id, request.params.taskId) ?? reply.code(404).send({ error: 'task not found' });
  });
  app.post<{Params: {id: string; taskId: string}, Body: {body?: string}}>('/api/boards/:id/tasks/:taskId/comments', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const body = request.body?.body?.trim();
    if (!body || body.length > 4000) return reply.code(400).send({ error: 'comment must contain 1-4000 characters' });
    return await addTaskComment(db, id, request.params.id, request.params.taskId, body) ?? reply.code(404).send({ error: 'task not found' });
  });
  app.post<{Params: {id: string; taskId: string}, Body: {text?: string}}>('/api/boards/:id/tasks/:taskId/checklist', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const text = request.body?.text?.trim();
    if (!text || text.length > 500) return reply.code(400).send({ error: 'checklist text must contain 1-500 characters' });
    return await addChecklistItem(db, id, request.params.id, request.params.taskId, text) ?? reply.code(403).send({ error: 'checklist action is not allowed' });
  });
  app.patch<{Params: {id: string; taskId: string; itemId: string}, Body: {text?: string; completed?: boolean; position?: number}}>('/api/boards/:id/tasks/:taskId/checklist/:itemId', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const text = request.body?.text?.trim();
    if (request.body?.text !== undefined && (!text || text.length > 500)) return reply.code(400).send({ error: 'checklist text must contain 1-500 characters' });
    if (request.body?.completed !== undefined && typeof request.body.completed !== 'boolean') return reply.code(400).send({ error: 'completed must be boolean' });
    if (request.body?.position !== undefined && (!Number.isInteger(request.body.position) || request.body.position < 0)) return reply.code(400).send({ error: 'position must be a non-negative integer' });
    return await updateChecklistItem(db, id, request.params.id, request.params.taskId, request.params.itemId, { ...request.body, text }) ?? reply.code(403).send({ error: 'checklist action is not allowed' });
  });
  app.delete<{Params: {id: string; taskId: string; itemId: string}}>('/api/boards/:id/tasks/:taskId/checklist/:itemId', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    return await deleteChecklistItem(db, id, request.params.id, request.params.taskId, request.params.itemId) ? { deleted: true } : reply.code(403).send({ error: 'checklist action is not allowed' });
  });
  app.post<{Params: {id: string; taskId: string}, Body: AttachmentInput}>('/api/boards/:id/tasks/:taskId/attachments', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const input = request.body;
    if (input?.kind === 'url') {
      try { const url = new URL(input.url ?? ''); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); input.url = url.toString(); }
      catch { return reply.code(400).send({ error: 'valid HTTP(S) URL is required' }); }
    } else if (input?.kind === 'telegram') {
      if (!input.telegramFileId || !input.telegramFileUniqueId || input.telegramFileId.length > 1024 || input.telegramFileUniqueId.length > 256) return reply.code(400).send({ error: 'Telegram file metadata is required' });
    } else return reply.code(400).send({ error: 'attachment kind must be url or telegram' });
    return await addTaskAttachment(db, id, request.params.id, request.params.taskId, input) ?? reply.code(404).send({ error: 'task not found' });
  });

  app.get<{Params: {id: string}}>('/api/boards/:id/recurrences', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    return { recurrences: await recurrencesForBoard(db, id, request.params.id) };
  });
  app.post<{Params: {id: string}, Body: RecurrenceInput}>('/api/boards/:id/recurrences', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const input = recurrenceInput(request.body); if (typeof input === 'string') return reply.code(400).send({ error: input });
    const recurrence = await createRecurrence(db, id, request.params.id, input);
    return recurrence ?? reply.code(404).send({ error: 'board, project or assignee not found' });
  });
  app.patch<{Params: {id: string; recurrenceId: string}, Body: Partial<RecurrenceInput> & {paused?: boolean; archived?: boolean}}>('/api/boards/:id/recurrences/:recurrenceId', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const input = recurrenceInput(request.body as RecurrenceInput, true); if (typeof input === 'string') return reply.code(400).send({ error: input });
    const recurrence = await updateRecurrence(db, id, request.params.id, request.params.recurrenceId, { ...input, paused: request.body.paused, archived: request.body.archived });
    return recurrence ?? reply.code(403).send({ error: 'recurrence action is not allowed' });
  });

  app.post<{Body: TelegramUpdate}>('/api/telegram/webhook', async (request, reply) => {
    if (request.headers['x-telegram-bot-api-secret-token'] !== config.webhookSecret) return reply.code(401).send({ error: 'invalid webhook secret' });
    const update = request.body;
    if (!update || !Number.isSafeInteger(update.update_id)) return reply.code(400).send({ error: 'invalid update' });
    const deliveryResult = (delivery: string) => {
      if (delivery === 'failed' || delivery === 'sending') {
        request.log.warn({ delivery }, 'Bot entry delivery requires retry');
        return reply.code(503).send({ ok: false, delivery });
      }
      if (delivery === 'uncertain') request.log.error({ delivery }, 'Bot entry delivery unconfirmed; automatic resend blocked');
      return { ok: delivery !== 'uncertain', delivery };
    };
    if (update.message && (!Number.isSafeInteger(update.message.chat?.id) ||
      (update.message.migrate_to_chat_id !== undefined && !Number.isSafeInteger(update.message.migrate_to_chat_id)) ||
      (update.message.migrate_from_chat_id !== undefined && !Number.isSafeInteger(update.message.migrate_from_chat_id)))) return reply.code(400).send({ error: 'invalid message' });
    if (update.message?.chat.type === 'private' && typeof update.message.text === 'string') {
      const command = /^\/(start|help)(?:@([A-Za-z0-9_]+))?(?:\s|$)/.exec(update.message.text);
      if (command && (!command[2] || command[2].toLowerCase() === config.botUsername.toLowerCase())) {
        if (!Number.isSafeInteger(update.message.message_id) || update.message.message_id <= 0) return reply.code(400).send({ error: 'invalid message id' });
        return deliveryResult(await sendBotEntry(db, config, update.message.message_id, update.message.chat.id, command[1] === 'help'));
      }
    }
    if (update.message?.migrate_to_chat_id) await migrateChatBoard(db, update.message.chat.id, update.message.migrate_to_chat_id);
    if (update.message?.migrate_from_chat_id) await migrateChatBoard(db, update.message.migrate_from_chat_id, update.message.chat.id);
    const member = update.my_chat_member;
    if (!member) return { ok: true };
    if (!Number.isSafeInteger(member.chat?.id) || !Number.isSafeInteger(member.date) || typeof member.old_chat_member?.status !== 'string' || typeof member.new_chat_member?.status !== 'string') return reply.code(400).send({ error: 'invalid member update' });
    if (!member.new_chat_member.user?.is_bot || !['group', 'supergroup'].includes(member.chat.type)) return { ok: true };
    if (present(member.old_chat_member.status) && !present(member.new_chat_member.status)) {
      await freezeChatBoard(db, member.chat.id, update.update_id, member.date);
    } else if (!present(member.old_chat_member.status) && present(member.new_chat_member.status)) {
      await connectChatBoard(db, member.chat.id, typeof member.chat.title === 'string' ? member.chat.title.trim().slice(0, 120) || 'Доска чата' : 'Доска чата', update.update_id, member.date);
      return deliveryResult(await sendGroupWelcome(db, config, member.chat.id));
    }
    return { ok: true };
  });

  registerMcp(app, config, db, sendTaskNotification);
  app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') || request.url.startsWith('/mcp') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'));
  return app;
}
