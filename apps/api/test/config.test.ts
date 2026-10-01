import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

test('public origins are opt-in, exact and secret-free; current defaults stay unchanged', () => {
  const original = process.env;
  process.env = { BOT_TOKEN: 'synthetic', DATABASE_URL: 'synthetic', SESSION_SECRET: 's'.repeat(32), WEBHOOK_SECRET: 'w'.repeat(32) };
  try {
    assert.equal(loadConfig().publicUrl, 'https://task.kairos-ai.ru');
    assert.equal(loadConfig().botUsername, 'kairostask_bot');
    assert.deepEqual(loadConfig().publicUrlAliases, []);
    process.env.PUBLIC_URL_ALIASES = 'https://new.example/,https://old.example, https://new.example';
    assert.deepEqual(loadConfig().publicUrlAliases, ['https://new.example', 'https://old.example']);
    for (const value of ['bad', 'http://public.example', 'https://user:private@example.test', 'https://example.test/path', 'https://example.test?secret=private', 'https://example.test#private', 'https://*.example.test', 'https://example.test,']) {
      process.env.PUBLIC_URL_ALIASES = value;
      assert.throws(() => loadConfig(), /Public URL/);
    }
    delete process.env.PUBLIC_URL_ALIASES;
    for (const value of ['http://127.0.0.1:4193', 'http://localhost:4193', 'http://[::1]:4193']) {
      process.env.PUBLIC_URL = value;
      assert.equal(loadConfig().publicUrl, value);
    }
    process.env.BOT_USERNAME = 'not/a/bot';
    assert.throws(() => loadConfig(), /BOT_USERNAME/);
  } finally { process.env = original; }
});
