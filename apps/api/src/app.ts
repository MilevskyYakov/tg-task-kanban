import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateInitData } from './auth.js';
import { boardForUser, boardsForUser, login, renameBoard, sessionUserId, type Database } from './db.js';
import type { Config } from './config.js';

export function buildApp(config: Config, db: Database) {
  const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.headers.cookie', 'body.initData'] } });
  app.register(cookie);
  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/dist');
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
  app.patch<{Params: {id: string}, Body: {name?: string}}>('/api/boards/:id', async (request, reply) => {
    const id = await userId(request, reply); if (typeof id !== 'string') return id;
    const name = request.body?.name?.trim();
    if (!name || name.length > 120) return reply.code(400).send({ error: 'name must contain 1-120 characters' });
    const board = await renameBoard(db, id, request.params.id, name);
    return board ?? reply.code(404).send({ error: 'board not found' });
  });
  app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'));
  return app;
}
