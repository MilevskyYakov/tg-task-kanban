import assert from 'node:assert/strict';
import test from 'node:test';
import type { Database } from '../src/db.js';
import { startPublicationScheduler } from '../src/publications.js';

test('publication scheduler reports tick failures', async () => {
  const error = new Error('database unavailable');
  const db = { query: async () => { throw error; } } as unknown as Database;
  await new Promise<void>((resolve) => {
    const stop = startPublicationScheduler(db, 'token', 'bot', (caught) => {
      assert.equal(caught, error);
      stop();
      resolve();
    });
  });
});