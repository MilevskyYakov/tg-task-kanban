import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateInitData } from './auth.js';
import { activateChatBoard, boardForUser, boardMembers, boardsForUser, connectChatBoard, createInvite, createProject, createTask, freezeChatBoard, login, migrateChatBoard, projectsForBoard, redeemBoardLink, renameBoard, revokeInvites, sessionUser, sessionUserId, setTaskArchived, tasksForAssignee, tasksForBoard, updateProject, updateTask, type Database, type TaskInput } from './db.js';
import type { Config } from './config.js';
import { isChatAdmin, telegramCall } from './telegram.js';

type ChatMemberUpdate = {
  chat: { id: number; title?: string; type: string };
  old_chat_member: { status: string; user: { is_bot: boolean } };
  new_chat_member: { status: string; user: { is_bot: boolean } };
};
type TelegramUpdate = { my_chat_member?: ChatMemberUpdate; message?: { chat: { id: number }; migrate_to_chat_id?: number; migrate_from_chat_id?: number } };
const present = (status: string) => status === 'member' || status === 'administrator';

export function buildApp(config: Config, db: Database) {
  const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers.x-telegram-bot-api-secret-token', 'body.initData'] } });
  app.register(cookie);
  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  app.register(fastifyStatic, { root: publicDir });
  app.get('/health', async () => { await db.query('SELECT 1'); return { status: 'ok' }; });

  app.post<{Body: {initData?: string}}>('/api/auth/telegram', async (request, reply) => {
    try {
      const telegram = validateInitData(request.body?.initData ?? '', config.botToken, config.initDataMaxAgeSeconds);
      const session = await login(db, telegram, config.sessionMaxAgeSeconds, config.sessionSecret);
      reply.setCookie('session', session.token, { path: '/', httpOnly: true, secure: config.production, sameSite: 'strict', maxAge: config.sessionMaxAgeSeconds });
      return { ok: true };
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
  app.post<{Body: {token?: string}}>('/api/board-links/redeem', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const token = request.body?.token;
    if (!token || token.length > 128) return reply.code(400).send({ error: 'invalid board link' });
    const board = await redeemBoardLink(db, id, token);
    return board ?? reply.code(404).send({ error: 'board link is invalid or revoked' });
  });
  app.post<{Params: {id: string}, Body: {name?: string}}>('/api/boards/:id/activate', async (request, reply) => {
    const user = await sessionUser(db, request.cookies.session, config.sessionSecret);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    const board = await boardForUser(db, user.id, request.params.id);
    const name = request.body?.name?.trim();
    if (!board || board.type !== 'chat') return reply.code(404).send({ error: 'board not found' });
    if (!name || name.length > 120) return reply.code(400).send({ error: 'name must contain 1-120 characters' });
    if (!await isChatAdmin(config.botToken, board.telegram_chat_id, user.telegram_id)) return reply.code(403).send({ error: 'Telegram chat admin required' });
    return activateChatBoard(db, user.id, request.params.id, name);
  });
  app.post<{Params: {id: string}}>('/api/boards/:id/invites', async (request, reply) => {
    const user = await sessionUser(db, request.cookies.session, config.sessionSecret);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    const board = await boardForUser(db, user.id, request.params.id);
    if (!board || board.type !== 'chat') return reply.code(404).send({ error: 'board not found' });
    if (!await isChatAdmin(config.botToken, board.telegram_chat_id, user.telegram_id)) return reply.code(403).send({ error: 'Telegram chat admin required' });
    const token = await createInvite(db, user.id, request.params.id);
    return token ? { url: `https://t.me/${config.botUsername}?startapp=${encodeURIComponent(token)}` } : reply.code(404).send({ error: 'board not found' });
  });
  app.delete<{Params: {id: string}}>('/api/boards/:id/invites', async (request, reply) => {
    const user = await sessionUser(db, request.cookies.session, config.sessionSecret);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    const board = await boardForUser(db, user.id, request.params.id);
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

  app.get('/api/tasks/mine', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    return { tasks: await tasksForAssignee(db, id) };
  });
  app.get<{Params: {id: string}}>('/api/boards/:id/members', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    return { members: await boardMembers(db, id, request.params.id) };
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
    const project = await updateProject(db, id, request.params.id, request.params.projectId, { name, archived: request.body.archived });
    return project ?? reply.code(404).send({ error: 'project not found' });
  });
  app.get<{Params: {id: string}, Querystring: {archived?: string}}>('/api/boards/:id/tasks', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    return { tasks: await tasksForBoard(db, id, request.params.id, request.query.archived === 'true') };
  });
  const taskInput = (body: TaskInput | undefined, partial = false): TaskInput | string => {
    const title = body?.title?.trim();
    if ((!partial || body?.title !== undefined) && (!title || title.length > 200)) return 'title must contain 1-200 characters';
    if (body?.status && !['todo', 'in_progress', 'waiting', 'done'].includes(body.status)) return 'invalid status';
    if (body?.priority && !['normal', 'urgent'].includes(body.priority)) return 'invalid priority';
    if (body?.status === 'waiting' && !body.waitReason?.trim()) return 'wait reason is required';
    for (const value of [body?.deadline, body?.waitCheckAt]) if (value && Number.isNaN(Date.parse(value))) return 'invalid date';
    return { ...body!, ...(title ? { title } : {}) };
  };
  app.post<{Params: {id: string}, Body: TaskInput}>('/api/boards/:id/tasks', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const input = taskInput(request.body); if (typeof input === 'string') return reply.code(400).send({ error: input });
    const task = await createTask(db, id, request.params.id, input);
    return task ?? reply.code(404).send({ error: 'board, project or assignee not found' });
  });
  app.patch<{Params: {id: string; taskId: string}, Body: TaskInput}>('/api/boards/:id/tasks/:taskId', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const input = taskInput(request.body, true); if (typeof input === 'string') return reply.code(400).send({ error: input });
    const task = await updateTask(db, id, request.params.id, request.params.taskId, input);
    return task ?? reply.code(403).send({ error: 'task action is not allowed' });
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

  app.post<{Body: TelegramUpdate}>('/api/telegram/webhook', async (request, reply) => {
    if (request.headers['x-telegram-bot-api-secret-token'] !== config.webhookSecret) return reply.code(401).send({ error: 'invalid webhook secret' });
    const update = request.body;
    if (update.message?.migrate_to_chat_id) await migrateChatBoard(db, update.message.chat.id, update.message.migrate_to_chat_id);
    if (update.message?.migrate_from_chat_id) await migrateChatBoard(db, update.message.migrate_from_chat_id, update.message.chat.id);
    const member = update.my_chat_member;
    if (!member?.new_chat_member.user.is_bot || member.chat.type === 'private') return { ok: true };
    if (present(member.old_chat_member.status) && !present(member.new_chat_member.status)) {
      await freezeChatBoard(db, member.chat.id);
    } else if (!present(member.old_chat_member.status) && present(member.new_chat_member.status)) {
      const board = await connectChatBoard(db, member.chat.id, member.chat.title?.trim() || 'Доска чата');
      if (board.token) await telegramCall(config.botToken, 'sendMessage', {
        chat_id: member.chat.id,
        text: 'Доска создана. Администратор, откройте её и завершите настройку.',
        reply_markup: { inline_keyboard: [[{ text: 'Настроить доску', url: `https://t.me/${config.botUsername}?startapp=${encodeURIComponent(board.token)}` }]] }
      });
    }
    return { ok: true };
  });

  app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'));
  return app;
}
