import { expect, test, type Page } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../api/src/app';
import { createDatabase, createProject, login } from '../../api/src/db';
import type { Config } from '../../api/src/config';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));
const surfaces = ['board', 'project', 'publication'] as const;
const scenarios = ['success', 'reload before debounce', 'reload in flight', 'offline reopen', 'reconnect during failure', 'reconnect during denial', 'offline conflict', 'local conflict', 'server conflict', 'choice race conflict', 'independent fields', 'raw input', 'lost response', 'lost response newer', 'uncertain revert', 'invalid', 'duplicate', 'storage failure', 'corrupt storage', 'late response', 'access loss', '401', '404', 'frozen', 'archived', 'membership revoked', 'user isolation', 'legacy draft upgrade', 'legacy attempt upgrade', 'legacy conflict upgrade'] as const;
for (const surface of surfaces) for (const scenario of scenarios) {
  if (scenario.startsWith('legacy ') && surface !== 'publication') continue;
  if ((scenario === 'independent fields' && surface !== 'publication') || (scenario === 'raw input' && surface === 'publication')) continue;
  if (scenario === 'duplicate' && surface !== 'project') continue;
  test(`settings API/DB ${surface}: ${scenario}`, async ({ page }) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required for settings tests');
    const db = createDatabase(databaseUrl);
    const config: Config = { botToken: 'test', databaseUrl, sessionSecret: 'settings-browser-secret', initDataMaxAgeSeconds: 60,
      sessionMaxAgeSeconds: 3600, host: '127.0.0.1', port: 0, production: false, webhookSecret: 'test-webhook', publicUrl: 'https://example.test', botUsername: 'test_bot' };
    const stamp = randomBytes(6).readUIntBE(0, 6);
    const users = await Promise.all([0, 1].map((index) => login(db, { id: stamp + index, first_name: `Settings ${index}` }, 3600, config.sessionSecret)));
    let currentUser = users[0];
    const boardId = randomUUID(), otherBoardId = randomUUID();
    const app = buildApp(config, db);
    const originalFetch = globalThis.fetch;
    let admin = true, fail = false, loseResponse = false;
    let offlineReads = false;
    let denied = 0;
    let release: (() => void) | undefined;
    let delay: Promise<void> | undefined;
    let responseDelay: Promise<void> | undefined;
    let concurrent = 0, maxConcurrent = 0;
    const writes: { input: Record<string, any>; status?: number }[] = [];
    const browserErrors: string[] = [];
    const unintendedActions: string[] = [];
    globalThis.fetch = (async (input) => {
      if (!String(input).endsWith('/getChatMember')) throw new Error('Unexpected external request');
      return Response.json({ ok: true, result: { status: admin ? 'administrator' : 'member' } });
    }) as typeof fetch;
    const call = (method: 'GET' | 'PATCH' | 'PUT', path: string, payload?: object) => app.inject({ method, url: path, payload, cookies: { session: users[0].token } });
    try {
      for (const [id, name, chat] of [[boardId, 'Settings team', -stamp], [otherBoardId, 'Other team', -stamp - 1]]) {
        await db.query("INSERT INTO boards (id,type,name,telegram_chat_id,status) VALUES ($1,'chat',$2,$3,'active')", [id, name, chat]);
        for (const user of users) await db.query("INSERT INTO memberships (board_id,user_id,role) VALUES ($1,$2,'admin')", [id, user.userId]);
        await db.query("INSERT INTO publication_schedules (board_id,kind,enabled,weekdays,local_time,timezone) VALUES ($1,'daily',true,ARRAY[1,2,3,4,5]::smallint[],'09:00','UTC')", [id]);
      }
      const project = await createProject(db, users[0].userId, boardId, 'Settings project');
      await createProject(db, users[0].userId, otherBoardId, 'Other project');
      const target = `/api/boards/${boardId}${surface === 'project' ? `/projects/${project.id}` : surface === 'publication' ? '/publications/daily' : ''}`;
      const field = surface === 'publication' ? 'timezone' : 'name';
      const initial = surface === 'publication' ? 'UTC' : surface === 'project' ? 'Settings project' : 'Settings team';
      const latest = surface === 'publication' ? 'Asia/Tokyo' : `Latest ${surface}`;
      const remote = surface === 'publication' ? 'Europe/Moscow' : `Remote ${surface}`;
      const before = surface === 'publication' ? 'Asia/Bangkok' : `Earlier ${surface}`;
      const storageKey = `tasks.settings.v1.${JSON.stringify([users[0].userId, boardId, surface, surface === 'project' ? project.id : surface === 'publication' ? 'daily' : boardId])}`;
      const readback = async () => {
        if (surface === 'board') return (await call('GET', '/api/boards')).json().boards.find((value: {id: string}) => value.id === boardId);
        if (surface === 'project') return (await call('GET', `/api/boards/${boardId}/projects?archived=true`)).json().projects.find((value: {id: string}) => value.id === project.id);
        return (await call('GET', `/api/boards/${boardId}/publications`)).json().schedules[0];
      };
      const remoteWrite = async (value: string) => {
        const response = await call(surface === 'publication' ? 'PUT' : 'PATCH', target, { [field]: value, expected: { [field]: (await readback())[field] } });
        expect(response.statusCode).toBe(200);
      };
      const open = async (other = false) => {
        await page.getByRole('button', { name: 'Настройки', exact: true }).click();
        await page.getByRole('button', { name: surface === 'publication' ? /Автоматизация/ : /Рабочее пространство/ }).click();
        const name = other ? 'Other team' : (await call('GET', '/api/boards')).json().boards.find((value: {id: string}) => value.id === boardId).name;
        await page.getByRole('button', { name: new RegExp(name) }).click();
        if (surface === 'publication') await page.getByRole('button', { name: 'Публикации в чат' }).click();
      };
      const editor = surface === 'publication' ? page.getByRole('group', { name: 'План дня', exact: true }) : page.locator('.settings-name-editor').nth(surface === 'board' ? 0 : 1);
      const input = surface === 'publication' ? editor.getByLabel('Часовой пояс', { exact: true }) : editor.locator('input');
      const status = editor.getByRole('status');
      page.on('pageerror', (error) => browserErrors.push(error.message));
      await page.setViewportSize({ width: 390, height: 844 });
      await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ contentType: 'application/javascript', body: "window.Telegram={WebApp:{initData:'settings-test',ready(){},expand(){}}};" }));
      await page.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/api/auth/telegram') return route.fulfill({ json: { userId: currentUser.userId } });
        if (offlineReads && request.method() === 'GET') return route.abort('internetdisconnected');
        if (request.method() !== 'GET' && url.pathname !== target && !url.pathname.endsWith('/task-filters')) unintendedActions.push(url.pathname);
        const write = url.pathname === target && ['PUT','PATCH'].includes(request.method()) ? { input: request.postDataJSON(), status: undefined as number | undefined } : undefined;
        if (write) {
          writes.push(write); maxConcurrent = Math.max(maxConcurrent, ++concurrent);
          if (delay) await delay;
          if (fail) {
            if (scenario === 'reconnect during failure') {
              await page.evaluate(() => window.dispatchEvent(new Event('online')));
              fail = false;
            }
            concurrent--; return route.abort('internetdisconnected');
          }
          if (denied) {
            if (scenario === 'reconnect during denial') await page.evaluate(() => window.dispatchEvent(new Event('online')));
            concurrent--; return route.fulfill({ status: denied, json: { error: 'Synthetic access denied' } });
          }
        }
        const response = await app.inject({ method: request.method() as 'GET' | 'PUT' | 'PATCH', url: url.pathname + url.search,
          cookies: { session: currentUser.token }, payload: request.postData() ? request.postDataJSON() : undefined });
        if (write) {
          write.status = response.statusCode; concurrent--;
          if (responseDelay) await responseDelay;
          if (loseResponse) { loseResponse = false; if (scenario === 'uncertain revert') offlineReads = true; return route.abort('failed'); }
        }
        await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
      });
      await page.goto('/'); await open(); await expect(input).toHaveValue(initial);
      if (scenario.startsWith('legacy ')) {
        const saved = await readback();
        const base = {enabled: saved.enabled, weekdays: saved.weekdays.join(','), local_time: saved.local_time, timezone: saved.timezone, included_statuses: saved.included_statuses};
        const draft = {...base, timezone: latest};
        const stored = {version: 1, base, draft, ...(scenario === 'legacy attempt upgrade' ? {attempt: {draft, fields: ['timezone']}} : {})};
        await page.evaluate(({key, value}) => localStorage.setItem(key, JSON.stringify(value)), {key: storageKey, value: stored});
        if (scenario === 'legacy attempt upgrade') await remoteWrite(latest);
        if (scenario === 'legacy conflict upgrade') await remoteWrite(remote);
        expect((await call('PUT', target, {included_board_ids: [], expected: {included_board_ids: [boardId]}})).statusCode).toBe(200);
        await page.reload(); await open();
        await expect(input).toHaveValue(latest);
        await expect(editor.getByText(/Локальная копия недоступна/)).toHaveCount(0);
        if (scenario === 'legacy conflict upgrade') {
          await expect(editor.getByRole('region', {name: 'Конфликт настроек'})).toBeVisible();
          await expect(editor).toContainText(`На сервере: ${remote}`);
          expect(writes).toHaveLength(0);
          await editor.getByRole('button', {name: 'Оставить моё'}).click();
        }
        await expect(status.filter({hasText: 'Сохранено'})).toBeVisible();
        expect(await readback()).toMatchObject({timezone: latest, included_board_ids: []});
        expect(writes).toHaveLength(scenario === 'legacy attempt upgrade' ? 0 : 1);
        if (writes.length) expect(writes[0].input).toEqual({timezone: latest, expected: {timezone: scenario === 'legacy conflict upgrade' ? remote : initial}});
        await page.reload(); await open(); await expect(input).toHaveValue(latest);
      } else if (scenario === 'success') {
        await input.fill('');
        await input.evaluate((element) => {
          (window as unknown as { settingsFrames: number[] }).settingsFrames = [];
          element.addEventListener('input', () => {
            const start = performance.now();
            requestAnimationFrame(() => (window as unknown as { settingsFrames: number[] }).settingsFrames.push(performance.now() - start));
          }, { capture: true });
        });
        await input.pressSequentially(latest, { delay: 25 });
        await expect(status).not.toHaveText('Сохранено');
        await expect(status).toHaveText('Сохранено');
        await expect(input).toBeFocused();
        const samples = await page.evaluate(() => (window as unknown as { settingsFrames: number[] }).settingsFrames.sort((a, b) => a - b));
        expect(samples.length).toBe(latest.length);
        await mkdir(evidence, { recursive: true });
        await appendFile(`${evidence}/issue147-settings-perf.jsonl`, `${JSON.stringify({ surface, metric: 'input-to-next-frame', samples: samples.length, p50: samples[Math.floor(samples.length / 2)], max: samples.at(-1) })}\n`);
        expect(writes).toHaveLength(1);
        expect(Object.keys(writes[0].input).sort()).toEqual(['expected', field].sort());
        expect((await readback())[field]).toBe(latest);
        await page.reload(); await open(); await expect(input).toHaveValue(latest);
      } else if (scenario === 'raw input') {
        await input.fill(`${latest} `);
        await expect(status).toHaveText('Сохранено');
        await expect(input).toHaveValue(`${latest} `);
        await expect(input).toBeFocused();
        expect(await input.evaluate((element: HTMLInputElement) => element.selectionStart)).toBe(`${latest} `.length);
        await input.pressSequentially('more', { delay: 10 });
        await expect(status).toHaveText('Сохранено');
        expect((await readback())[field]).toBe(`${latest} more`);
      } else if (scenario === 'independent fields') {
        delay = new Promise<void>((resolve) => { release = resolve; });
        await input.fill(latest);
        await expect.poll(() => writes.length).toBe(1);
        expect((await call('PUT', target, { enabled: false, expected: { enabled: true } })).statusCode).toBe(200);
        release!(); delay = undefined;
        await expect(status).toHaveText('Сохранено');
        await expect(editor.getByRole('checkbox', { name: 'Включена', exact: true })).not.toBeChecked();
        expect(await readback()).toMatchObject({ timezone: latest, enabled: false });
      } else if (scenario === 'reload in flight') {
        responseDelay = new Promise<void>((resolve) => { release = resolve; });
        await input.fill(before);
        await expect.poll(() => writes[0]?.status).toBe(200);
        await input.fill(latest);
        await page.reload();
        release!(); responseDelay = undefined;
        await open();
        await expect(input).toHaveValue(latest);
        await expect(status).toHaveText('Сохранено');
        expect((await readback())[field]).toBe(latest);
        expect(writes).toHaveLength(2);
      } else if (scenario === 'reload before debounce') {
        await input.fill(latest);
        await page.reload(); await open();
        await expect(input).toHaveValue(latest);
        await expect(status).toHaveText('Сохранено');
        expect((await readback())[field]).toBe(latest);
      } else if (scenario === 'reconnect during failure') {
        fail = true;
        await input.fill(latest);
        await expect(status).toHaveText('Сохранено');
        await mkdir(evidence, { recursive: true });
        await status.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${evidence}/issue147-${surface}-reconnect-saved.png` });
        expect((await readback())[field]).toBe(latest);
        expect(writes).toHaveLength(2);
        expect(maxConcurrent).toBe(1);
      } else if (scenario === 'reconnect during denial') {
        denied = 403;
        await input.fill(latest);
        await expect(status).toHaveText('Не сохранено');
        await page.waitForTimeout(850);
        expect(writes).toHaveLength(1);
        expect((await readback())[field]).toBe(initial);
        denied = 0;
        await editor.getByRole('button', { name: 'Повторить' }).click();
        await expect(status).toHaveText('Сохранено');
        expect((await readback())[field]).toBe(latest);
        expect(writes).toHaveLength(2);
      } else if (scenario === 'offline reopen' || scenario === 'user isolation') {
        fail = true;
        await input.fill(latest);
        await expect(status).toHaveText('Не сохранено');
        await page.reload();
        if (scenario === 'user isolation') currentUser = users[1];
        if (scenario === 'user isolation') await page.reload();
        await open();
        if (scenario === 'user isolation') {
          await expect(input).toHaveValue(initial);
          currentUser = users[0]; await page.reload(); await open();
        }
        await expect(input).toHaveValue(latest);
        await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey)).not.toBeNull();
        fail = false;
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await expect(status).toHaveText('Сохранено');
        expect((await readback())[field]).toBe(latest);
      } else if (scenario.endsWith('conflict')) {
        if (scenario === 'offline conflict') {
          fail = true;
          await input.fill(latest);
          await expect(status).toHaveText('Не сохранено');
          await remoteWrite(remote);
          await page.reload(); fail = false; await open();
        } else {
          // Hold one write so the other client wins after our read, not before it.
          delay = new Promise<void>((resolve) => { release = resolve; });
          await input.fill(latest);
          await expect.poll(() => writes.length).toBe(1);
          await remoteWrite(remote);
          release!(); delay = undefined;
        }
        await expect(editor.getByRole('region', { name: 'Конфликт настроек' })).toBeVisible();
        await expect(editor).toContainText(`Ваше: ${latest}`);
        await expect(editor).toContainText(`На сервере: ${remote}`);
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        expect(writes).toHaveLength(1);
        await page.reload(); await open();
        await expect(editor.getByRole('region', { name: 'Конфликт настроек' })).toBeVisible();
        if (scenario === 'local conflict') {
          await mkdir(evidence, { recursive: true });
          await page.setViewportSize({ width: 320, height: 520 });
          await editor.getByRole('button', { name: 'Оставить моё' }).scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${evidence}/issue147-${surface}-conflict-visible.png` });
        }
        if (scenario === 'choice race conflict') {
          await remoteWrite(before);
          await editor.getByRole('button', { name: 'Оставить моё' }).click();
          await expect(editor).toContainText(`На сервере: ${before}`);
          expect((await readback())[field]).toBe(before);
        }
        await editor.getByRole('button', { name: scenario === 'server conflict' ? 'Принять серверное' : 'Оставить моё' }).click();
        await expect(status).toHaveText('Сохранено');
        expect((await readback())[field]).toBe(scenario === 'server conflict' ? remote : latest);
      } else if (scenario === 'lost response') {
        loseResponse = true;
        await input.fill(latest);
        await expect(status).toHaveText('Сохранено');
        expect((await readback())[field]).toBe(latest);
        expect(writes).toHaveLength(1);
      } else if (scenario === 'lost response newer') {
        delay = new Promise<void>((resolve) => { release = resolve; });
        loseResponse = true;
        await input.fill(before);
        await expect.poll(() => writes.length).toBe(1);
        await input.fill(latest);
        release!(); delay = undefined;
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await expect(status).toHaveText('Сохранено');
        expect((await readback())[field]).toBe(latest);
        expect(writes).toHaveLength(2);
        expect(maxConcurrent).toBe(1);
      } else if (scenario === 'uncertain revert') {
        delay = new Promise<void>((resolve) => { release = resolve; });
        loseResponse = true;
        await input.fill(before);
        await expect.poll(() => writes.length).toBe(1);
        await input.fill(initial);
        release!(); delay = undefined;
        await expect(status).toHaveText('Не сохранено');
        await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey)).not.toBeNull();
        expect((await readback())[field]).toBe(before);
        offlineReads = false;
        await page.reload(); await open();
        await expect(input).toHaveValue(initial);
        await expect(status).toHaveText('Сохранено');
        expect((await readback())[field]).toBe(initial);
        expect(writes).toHaveLength(2);
      } else if (scenario === 'duplicate') {
        await createProject(db, users[0].userId, boardId, 'Duplicate project');
        await input.fill('Duplicate project');
        await expect(status).toHaveText('Не сохранено');
        await expect(input).toHaveValue('Duplicate project');
        expect((await readback())[field]).toBe(initial);
        await input.fill(latest);
        await expect(status).toHaveText('Сохранено');
        expect((await readback())[field]).toBe(latest);
      } else if (scenario === 'invalid') {
        const invalid = surface === 'publication' ? 'Invalid/Zone' : '';
        await input.fill(invalid);
        await expect(status).toHaveText('Не сохранено');
        await page.reload(); await open();
        await expect(input).toHaveValue(invalid);
        expect(writes).toHaveLength(0);
        expect((await readback())[field]).toBe(initial);
        if (surface === 'publication') {
          await editor.getByRole('checkbox', { name: 'Включена', exact: true }).uncheck();
          await expect.poll(async () => (await readback()).enabled).toBe(false);
          await expect(input).toHaveValue(invalid);
          await expect(status).toHaveText('Не сохранено');
        }
        await input.fill(latest);
        await expect(status).toHaveText('Сохранено');
      } else if (scenario === 'corrupt storage') {
        // Inject on the next document, after the old editor can no longer persist.
        await page.addInitScript((key) => localStorage.setItem(key, '{broken'), storageKey);
        await page.reload(); await open();
        await expect(editor.getByRole('alert').filter({ hasText: 'повреждена' })).toBeVisible();
        await page.locator('.settings-back').click(); await open();
        await page.waitForTimeout(850);
        await expect(editor.getByRole('alert').filter({ hasText: 'повреждена' })).toBeVisible();
        await mkdir(evidence, { recursive: true });
        await editor.getByRole('alert').filter({ hasText: 'повреждена' }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${evidence}/issue147-${surface}-storage-warning.png` });
        await expect(input).toHaveValue(initial);
        await input.fill(latest);
        await expect(status).toHaveText('Сохранено');
        await expect(editor.getByRole('alert').filter({ hasText: 'повреждена' })).toHaveCount(0);
      } else if (scenario === 'storage failure') {
        await page.evaluate(() => {
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) { if (key.startsWith('tasks.settings.') || key.startsWith('tasks.autosave.')) throw new DOMException('quota', 'QuotaExceededError'); return original.call(this, key, value); };
        });
        fail = true;
        await input.fill(latest);
        await expect(editor.getByRole('alert').filter({ hasText: 'Локальная копия' })).toBeVisible();
        await page.locator('.settings-back').click(); await open();
        await expect(input).toHaveValue(latest);
        fail = false;
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await expect(status).toHaveText('Сохранено');
      } else if (scenario === 'late response') {
        delay = new Promise<void>((resolve) => { release = resolve; });
        await input.fill(before);
        await expect.poll(() => writes.length).toBe(1);
        await input.fill(latest);
        await page.locator('.settings-back').click(); await open(true);
        await expect(input).toHaveValue(surface === 'publication' ? 'UTC' : surface === 'project' ? 'Other project' : 'Other team');
        release!(); delay = undefined;
        await expect.poll(async () => (await readback())[field]).toBe(latest);
        await expect(input).not.toHaveValue(latest);
        expect(maxConcurrent).toBe(1);
        await page.locator('.settings-back').click(); await open(); await expect(input).toHaveValue(latest);
      } else if (scenario === 'membership revoked') {
        delay = new Promise<void>((resolve) => { release = resolve; });
        await input.fill(latest);
        await expect.poll(() => writes.length).toBe(1);
        await db.query('DELETE FROM memberships WHERE board_id=$1 AND user_id=$2', [boardId, users[0].userId]);
        release!(); delay = undefined;
        await expect.poll(() => writes[0].status).toBe(404);
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect(page.getByRole('heading', {name: 'Доступ закрыт'})).toBeVisible();
        await expect(input).toHaveCount(0);
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        expect(writes).toHaveLength(1);
        await db.query("INSERT INTO memberships (board_id,user_id,role) VALUES ($1,$2,'admin')", [boardId, users[0].userId]);
        await page.reload(); await open();
        await expect(input).toHaveValue(latest);
        await expect(status).toHaveText('Сохранено');
      } else if (['access loss', '401', '404', 'frozen', 'archived'].includes(scenario)) {
        if (scenario === 'frozen' || scenario === 'archived') await db.query('UPDATE boards SET status=$2 WHERE id=$1', [boardId, scenario]);
        else denied = scenario === '401' ? 401 : scenario === '404' ? 404 : 403;
        await input.fill(latest);
        await expect(status).toHaveText('Не сохранено');
        expect((await readback())[field]).toBe(initial);
        const count = writes.length;
        await page.evaluate(() => { for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('online')); });
        await page.waitForTimeout(850);
        expect(writes).toHaveLength(count);
        await expect(input).toHaveValue(latest);
        denied = 0;
        if (scenario === 'frozen' || scenario === 'archived') await db.query("UPDATE boards SET status='active' WHERE id=$1", [boardId]);

        await editor.getByRole('button', { name: 'Повторить' }).click();
        await expect(status).toHaveText('Сохранено');
      }
      if (scenario === 'success' || scenario.endsWith('conflict')) {
        await mkdir(evidence, { recursive: true });
        for (const [width, height, size] of [[390,844,100], [320,844,100], [320,520,100], [1280,900,100], [320,844,200]]) {
          await page.setViewportSize({ width, height });
          await page.evaluate((size) => { document.documentElement.style.fontSize = `${size}%`; }, size);
          await input.scrollIntoViewIfNeeded();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          const bounds = await input.boundingBox();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
          await page.screenshot({ path: `${evidence}/issue147-${surface}-${scenario.replaceAll(' ', '-')}-${width}x${height}-${size}.png` });
        }
      }
      expect(browserErrors).toEqual([]);
      expect(unintendedActions).toEqual([]);
    } finally {
      release?.(); await page.close(); await app.close(); globalThis.fetch = originalFetch;
      await db.query('DELETE FROM boards WHERE id=ANY($1) OR owner_user_id=ANY($2)', [[boardId, otherBoardId], users.map((user) => user.userId)]);
      await db.query('DELETE FROM users WHERE id=ANY($1)', [users.map((user) => user.userId)]);
      await db.end();
    }
  });
}
