import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import type { Config } from '../src/config.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
test('public landing serves built assets without intercepting API, health or MCP', async () => {
  const db = createDatabase(url!);
  const config: Config = { botToken: 'test', databaseUrl: url!, sessionSecret: 'isolated-public-entry-secret', initDataMaxAgeSeconds: 60, sessionMaxAgeSeconds: 3600,
    host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-webhook', publicUrl: 'https://example.test', botUsername: 'current_test_bot' };
  const app = buildApp(config, db);
  try {
    const entry = await app.inject('/api/bot-entry');
    assert.deepEqual(entry.json(), { botUrl: 'https://t.me/current_test_bot?start=landing', groupUrl: 'https://t.me/current_test_bot?startgroup=tasks' });
    assert.equal(entry.headers['cache-control'], 'no-store');
    for (const path of ['/', '/?tgWebAppStartParam=personal']) {
      const result = await app.inject(path);
      assert.equal(result.statusCode, 200);
      assert.match(result.body, /Таска/);
      assert.match(String(result.headers['content-type']), /text\/html/);
    }
    for (const path of ['/brand/favicon.png', '/brand/social-preview.png', '/brand/app-preview.webp']) {
      const result = await app.inject(path);
      assert.equal(result.statusCode, 200);
      assert.match(String(result.headers['content-type']), /image\//);
    }
    for (const [method, path, status] of [['GET', '/health', 200], ['GET', '/api/boards', 401], ['POST', '/api/auth/telegram', 401], ['POST', '/api/telegram/webhook', 401], ['GET', '/mcp', 401], ['POST', '/mcp', 401], ['GET', '/api/missing', 404], ['GET', '/api', 404], ['GET', '/health/missing', 404], ['POST', '/mcp/missing', 404]] as const) {
      const result = await app.inject({ method, url: path });
      assert.equal(result.statusCode, status, `${method} ${path}`);
      assert.match(String(result.headers['content-type']), /application\/json/);
      assert.doesNotMatch(result.body, /<!doctype html>/i);
    }
  } finally { await app.close(); await db.end(); }
});
