import { expect, test } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../api/src/app';
import { createDatabase, login } from '../../api/src/db';
import type { Config } from '../../api/src/config';

const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/', import.meta.url));

for (const scenario of ['daily', 'weekly', 'failure', 'failure latest', 'invalid', 'invalid in flight', 'permission revoked', 'board switch', 'read-only'] as const) {
  test(`publication autosave through real API/DB: ${scenario}`, async ({ page }) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required for publication browser/API/DB tests');
    const db = createDatabase(databaseUrl);
    const config: Config = { botToken: 'test', databaseUrl, sessionSecret: 'isolated-publications-secret', initDataMaxAgeSeconds: 60,
      sessionMaxAgeSeconds: 3600, host: '127.0.0.1', port: 0, production: false, webhookSecret: 'isolated-publications-webhook',
      publicUrl: 'https://example.test', botUsername: 'test_bot' };
    const stamp = randomBytes(6).readUIntBE(0, 6);
    const user = await login(db, { id: stamp, first_name: 'Publications test' }, 3600, config.sessionSecret);
    const boardId = randomUUID();
    const otherBoardId = randomUUID();
    const app = buildApp(config, db);
    const originalFetch = globalThis.fetch;
    let admin = true;
    globalThis.fetch = (async (input) => {
      if (!String(input).endsWith('/getChatMember')) throw new Error('Unexpected external request');
      return Response.json({ ok: true, result: { status: admin ? 'administrator' : 'member' } });
    }) as typeof fetch;
    const kind = scenario === 'weekly' ? 'weekly' : 'daily';
    const path = `/api/boards/${boardId}/publications/${kind}`;
    const writes: { input: Record<string, any>; status?: number }[] = [];
    let fail = false;
    let release: (() => void) | undefined;
    let delay: Promise<void> | undefined;
    let concurrent = 0;
    let maxConcurrent = 0;
    const errors: string[] = [];
    const readback = async (id = boardId) => {
      const response = await app.inject({ method: 'GET', url: `/api/boards/${id}/publications`, cookies: { session: user.token } });
      expect(response.statusCode).toBe(200);
      return response.json().schedules.find((schedule: { kind: string }) => schedule.kind === kind);
    };
    const open = async (name = 'Publication test') => {
      await page.getByRole('button', { name: 'Настройки', exact: true }).click();
      await page.getByRole('button', { name: /Автоматизация/ }).click();
      await page.getByRole('button', { name, exact: false }).click();
      await page.getByRole('button', { name: 'Публикации в чат' }).click();
    };
    try {
      for (const [id, name, chatId] of [[boardId, 'Publication test', -stamp], [otherBoardId, 'Other team', -stamp - 1]]) {
        await db.query("INSERT INTO boards (id,type,name,telegram_chat_id,status) VALUES ($1,'chat',$2,$3,'active')", [id, name, chatId]);
        await db.query("INSERT INTO memberships (board_id,user_id,role) VALUES ($1,$2,'admin')", [id, user.userId]);
        await db.query("INSERT INTO publication_schedules (board_id,kind,enabled,weekdays,local_time) VALUES ($1,'daily',true,ARRAY[1,2,3,4,5]::smallint[],'09:00'),($1,'weekly',true,ARRAY[1]::smallint[],'09:00')", [id]);
      }
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width: 390, height: 844 });
      await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ contentType: 'application/javascript',
        body: "window.Telegram={WebApp:{initData:'isolated-publications-test',ready(){},expand(){}}};" }));
      await page.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/api/auth/telegram') return route.fulfill({ json: { userId: user.userId } });
        const input = request.postData() ? request.postDataJSON() : undefined;
        const write = url.pathname === path && request.method() === 'PUT' ? { input, status: undefined as number | undefined } : undefined;
        if (write) {
          writes.push(write);
          maxConcurrent = Math.max(maxConcurrent, ++concurrent);
          if (delay) await delay;
          if (fail) {
            concurrent -= 1;
            write.status = 500;
            return route.fulfill({ status: 500, json: { error: 'Synthetic save failure' } });
          }
        }
        const response = await app.inject({ method: request.method() as 'GET' | 'POST' | 'PUT', url: url.pathname + url.search,
          cookies: { session: user.token }, payload: input });
        if (write) { write.status = response.statusCode; concurrent -= 1; }
        await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
      });
      await page.goto('/');
      await open();
      const editor = page.getByRole('group', { name: kind === 'daily' ? 'План дня' : 'Недельная сводка', exact: true });
      const enabled = editor.getByRole('checkbox', { name: 'Включена', exact: true });
      const status = editor.getByRole('status');
      await expect(enabled).toBeChecked();
      if (scenario === 'read-only') {
        await db.query("UPDATE boards SET status='frozen' WHERE id=$1", [boardId]);
        await enabled.uncheck();
        await expect(editor.getByRole('alert')).toContainText('board is read-only');
        await expect(status).toHaveText('Не сохранено');
        expect((await readback()).enabled).toBe(true);
        await page.reload();
        await page.getByRole('button', { name: 'Настройки', exact: true }).click();
        await page.getByRole('button', { name: /Автоматизация/ }).click();
        await page.getByRole('button', { name: 'Publication test', exact: false }).click();
        await expect(enabled).toHaveCount(0);
        expect(errors).toEqual([]);
        return;
      }
      if (scenario === 'failure' || scenario === 'permission revoked') {
        fail = scenario === 'failure';
        admin = scenario !== 'permission revoked';
        await enabled.uncheck();
        await expect(editor.getByRole('alert')).toContainText(scenario === 'failure' ? 'Synthetic save failure' : 'Telegram chat admin required');
        await expect(status).toContainText('Не сохранено');
        expect((await readback()).enabled).toBe(true);
        expect(writes).toHaveLength(1);
        if (scenario === 'failure') {
          await mkdir(evidence, { recursive: true });
          await status.scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${evidence}/issue146-publication-error.png` });
        }
        fail = false; admin = true;
        await editor.getByRole('button', { name: 'Повторить' }).click();
      } else if (scenario === 'invalid') {
        for (const [label, value] of [['Дни (1–7)', '0'], ['Время', ''], ['Часовой пояс', 'Invalid/Zone']]) {
          const field = editor.getByLabel(label, { exact: true });
          const before = await field.inputValue();
          await field.fill(value);
          await enabled.uncheck();
          await page.waitForTimeout(850);
          expect(writes).toHaveLength(0);
          await expect(status).toContainText('Не сохранено');
          expect((await readback()).enabled).toBe(true);
          await enabled.check();
          await field.fill(before);
        }
        // Invalid input cancels an already debounced valid edit.
        await editor.getByLabel('Часовой пояс', { exact: true }).fill('UTC');
        await editor.getByLabel('Дни (1–7)', { exact: true }).fill('');
        await page.waitForTimeout(850);
        expect(writes).toHaveLength(0);
        await editor.getByLabel('Дни (1–7)', { exact: true }).fill('1,2,3,4,5');
        const selected = editor.locator('.status-options input:checked');
        while (await selected.count()) await selected.first().uncheck();
        await page.waitForTimeout(850);
        expect(writes).toHaveLength(0);
        await expect(status).toHaveText('Не сохранено');
        await editor.getByRole('checkbox', { name: 'Новая', exact: true }).check();
        await enabled.uncheck();
      } else {
        delay = new Promise<void>((resolve) => { release = resolve; });
        await enabled.uncheck();
        await expect.poll(() => writes.length).toBe(1);
        await expect(status).not.toHaveText('Сохранено');
        expect((await readback()).enabled).toBe(true);
        if (scenario === 'invalid in flight') {
          await editor.getByLabel('Часовой пояс', { exact: true }).fill('Invalid/Zone');
          release!(); delay = undefined;
          await expect.poll(() => writes[0].status).toBe(200);
          await page.waitForTimeout(850);
          expect(writes).toHaveLength(1);
          await expect(status).toHaveText('Не сохранено');
          await expect(editor.getByLabel('Часовой пояс', { exact: true })).toHaveValue('Invalid/Zone');
          await enabled.check();
          await editor.getByLabel('Часовой пояс', { exact: true }).fill('UTC');
          await expect(status).toHaveText('Сохранено');
          expect(await readback()).toMatchObject({ enabled: true, timezone: 'UTC' });
          expect(errors).toEqual([]);
          return;
        }
        if (scenario === 'board switch') {
          await page.locator('.settings-back').click();
          await open('Other team');
          release!(); delay = undefined;
          await expect.poll(async () => (await readback()).enabled).toBe(false);
          await expect(page.getByRole('group', { name: 'План дня', exact: true }).getByRole('checkbox', { name: 'Включена', exact: true })).toBeChecked();
          expect((await readback(otherBoardId)).enabled).toBe(true);
          expect(errors).toEqual([]);
          return;
        }
        await enabled.check();
        await page.waitForTimeout(850);
        expect(writes).toHaveLength(1);
        if (scenario === 'failure latest') {
          fail = true;
          release!(); delay = undefined;
          await expect(status).toHaveText('Не сохранено');
          await expect(enabled).toBeChecked();
          expect(writes).toHaveLength(1);
          fail = false;
          await editor.getByRole('button', { name: 'Повторить' }).click();
        }
        release!(); delay = undefined;
        await expect(status).toHaveText('Сохранено');
        expect(writes.map((write) => write.input.enabled)).toEqual([false, true]);
        expect(maxConcurrent).toBe(1);
        expect((await readback()).enabled).toBe(true);
        await enabled.uncheck();
        await enabled.check();
        await enabled.uncheck();
      }
      await expect(status).toHaveText('Сохранено');
      expect((await readback()).enabled).toBe(false);
      expect(writes.at(-1)).toMatchObject({ input: { enabled: false }, status: 200 });
      if (scenario === 'daily') {
        await mkdir(evidence, { recursive: true });
        for (const [width, height, textSize] of [[390, 844, 100], [320, 844, 100], [320, 520, 100], [1280, 900, 100], [320, 844, 200]]) {
          await page.setViewportSize({ width, height });
          await page.evaluate((size) => { document.documentElement.style.fontSize = `${size}%`; }, textSize);
          await enabled.scrollIntoViewIfNeeded();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await expect(enabled).toBeInViewport();
          await page.screenshot({ path: `${evidence}/issue146-publication-${width}x${height}-${textSize}.png` });
        }
      }
      await page.reload();
      await open();
      await expect(enabled).not.toBeChecked();
      await enabled.check();
      await expect(status).toHaveText('Сохранено');
      expect((await readback()).enabled).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      release?.();
      await page.close();
      await app.close();
      globalThis.fetch = originalFetch;
      await db.query('DELETE FROM boards WHERE id=ANY($1) OR owner_user_id=$2', [[boardId, otherBoardId], user.userId]);
      await db.query('DELETE FROM users WHERE id=$1', [user.userId]);
      await db.end();
    }
  });
}
