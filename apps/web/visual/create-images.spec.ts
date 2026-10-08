import { expect, test, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../api/src/app';
import { createDatabase, login } from '../../api/src/db';
import type { Config } from '../../api/src/config';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=', 'base64');
const evidence = fileURLToPath(new URL('../../../artifacts/visual-evidence/issue-179/create/', import.meta.url));
const title = (page: Page) => page.getByRole('textbox', { name: 'Что нужно сделать?' });
const description = (page: Page) => page.getByRole('textbox', { name: 'Описание', exact: true });
const create = (page: Page) => page.getByRole('button', { name: 'Создать задачу', exact: true });
const retry = (page: Page) => page.getByRole('button', { name: 'Дозагрузить изображения', exact: true });
const previews = (page: Page) => page.locator('.create-image-list img');

async function paste(page: Page, options: { name?: string; type?: string; text?: string; size?: number } = {}) {
  return page.evaluate(({ options, bytes }) => {
    const clipboardData = new DataTransfer();
    if (options.type !== 'text-only') clipboardData.items.add(new File([options.size === undefined ? Uint8Array.from(bytes) : new Uint8Array(options.size)], options.name ?? 'clipboard.png', { type: options.type ?? 'image/png' }));
    if (options.text !== undefined) clipboardData.setData('text/plain', options.text);
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData });
    (document.activeElement ?? document.body).dispatchEvent(event);
    return event.defaultPrevented;
  }, { options, bytes: [...png] });
}

async function withCreate(page: Page, run: (fixture: {
  db: ReturnType<typeof createDatabase>; boardId: string;
  state: { failure?: 'upload' | 'reply' | 'readback' | 'create'; rejectAt: number; hold?: Promise<void> };
  creates: Record<string, unknown>[]; uploads: string[]; reads: string[];
}) => Promise<void>) {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL required for create-image API/DB verification');
  const db = createDatabase(databaseUrl);
  const config: Config = { botToken: 'test', databaseUrl, sessionSecret: 'create-images-isolated-session-secret', initDataMaxAgeSeconds: 60,
    sessionMaxAgeSeconds: 3600, host: '127.0.0.1', port: 0, production: false, webhookSecret: 'create-images-isolated-webhook', publicUrl: 'https://example.test', botUsername: 'test_bot' };
  const owner = await login(db, { id: randomBytes(6).readUIntBE(0, 6), first_name: 'Images owner' }, 3600, config.sessionSecret);
  const boardId = (await db.query("SELECT id FROM boards WHERE type='personal' AND owner_user_id=$1", [owner.userId])).rows[0].id;
  const app = buildApp(config, db);
  const state: { failure?: 'upload' | 'reply' | 'readback' | 'create'; rejectAt: number; hold?: Promise<void> } = { rejectAt: 1 };
  const creates: Record<string, unknown>[] = [], uploads: string[] = [], reads: string[] = [], pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await page.addInitScript((id) => {
      localStorage.setItem('tasks.globalBoardId', id);
      const urls = new Set<string>();
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (file) => { const url = create(file); urls.add(url); return url; };
      URL.revokeObjectURL = (url) => { urls.delete(url); revoke(url); };
      (window as any).__draftUrls = urls;
    }, boardId);
    await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({ contentType: 'application/javascript',
      body: `window.__closing=false;window.__haptics=[];window.Telegram={WebApp:{initData:'test',ready(){},expand(){},isVersionAtLeast(){return true},enableClosingConfirmation(){window.__closing=true},disableClosingConfirmation(){window.__closing=false},HapticFeedback:{impactOccurred(style){window.__haptics.push(style)}}}};` }));
    await page.route('**/api/**', async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === '/api/auth/telegram') { await route.fulfill({ json: { userId: owner.userId } }); return; }
      const isCreate = request.method() === 'POST' && url.pathname.endsWith('/tasks');
      const isUpload = request.method() === 'POST' && url.pathname.endsWith('/attachments/file');
      if (isCreate) creates.push(request.postDataJSON());
      if (isUpload) uploads.push(request.headers()['x-upload-id']);
      if (url.pathname.endsWith('/collaboration')) reads.push(url.pathname);
      if ((isUpload && state.failure === 'upload' && uploads.length === state.rejectAt)
        || (url.pathname.endsWith('/collaboration') && state.failure === 'readback' && uploads.length)) {
        state.failure = undefined;
        await route.fulfill({ status: 503, json: { error: 'Контрольный сбой' } }); return;
      }
      const headers: Record<string, string> = {};
      for (const key of ['content-type', 'x-upload-id']) if (request.headers()[key]) headers[key] = request.headers()[key];
      const response = await app.inject({ method: request.method() as 'GET' | 'POST' | 'PATCH' | 'PUT', url: url.pathname + url.search,
        cookies: { session: owner.token }, headers, payload: request.postDataBuffer() ?? undefined });
      if ((isUpload && state.failure === 'reply') || (isCreate && state.failure === 'create')) {
        state.failure = undefined;
        await route.abort('failed'); return;
      }
      if (isUpload && state.hold) await state.hold;
      await route.fulfill({ status: response.statusCode, contentType: String(response.headers['content-type']), body: response.rawPayload });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await create(page).click();
    await expect(title(page)).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('margin', '0px');
    await run({ db, boardId, state, creates, uploads, reads });
    expect(pageErrors).toEqual([]);
  } finally {
    try { if (!page.isClosed()) await page.unrouteAll({ behavior: 'ignoreErrors' }); }
    finally {
      await app.close();
      try {
        await db.query('DELETE FROM boards WHERE owner_user_id=$1', [owner.userId]);
        await db.query('DELETE FROM users WHERE id=$1', [owner.userId]);
      } finally { await db.end(); }
    }
  }
}

async function imageCount(db: ReturnType<typeof createDatabase>, boardId: string) {
  return (await db.query('SELECT count(*)::int AS count FROM task_attachments WHERE board_id=$1', [boardId])).rows[0].count;
}

test('create images stay local, preserve paste defaults, remove previews and clear between tasks', async ({ page }) => {
  await withCreate(page, async ({ db, boardId, creates, uploads }) => {
    await expect(create(page)).toBeDisabled();
    expect(await paste(page)).toBe(true);
    await expect(previews(page)).toHaveCount(1);
    await expect(create(page)).toBeDisabled();
    await title(page).fill('Со скриншотом');
    await description(page).fill('Описание не теряется');
    expect(await paste(page, { text: 'Обычный текст', type: 'text-only' })).toBe(false);
    expect(await paste(page, { name: 'mixed.png', text: 'Текст рядом с картинкой' })).toBe(false);
    // Synthetic paste tests cancellation, not native text insertion. Both inputs must stay intact.
    await expect(title(page)).toHaveValue('Со скриншотом');
    await expect(description(page)).toHaveValue('Описание не теряется');
    await page.getByLabel('Выбрать изображения').setInputFiles({ name: 'picker.png', mimeType: 'image/png', buffer: png });
    await expect(previews(page)).toHaveCount(3);
    await page.getByRole('button', { name: 'Удалить clipboard.png', exact: true }).click();
    await expect(previews(page)).toHaveCount(2);
    expect(await page.evaluate(() => (window as any).__draftUrls.size)).toBe(2);
    expect(creates).toEqual([]); expect(uploads).toEqual([]);
    expect((await db.query('SELECT id FROM tasks WHERE board_id=$1', [boardId])).rowCount).toBe(0);
    expect(await page.evaluate(() => (window as any).__closing)).toBe(true);
    await page.getByRole('button', { name: /Исполнитель.*Без ответственного/ }).click();
    await page.getByRole('radio', { name: 'Images owner' }).click();
    await page.getByRole('button', { name: 'Создать и добавить ещё', exact: true }).click();
    await expect(title(page)).toHaveValue('');
    await expect(previews(page)).toHaveCount(0);
    expect(creates).toHaveLength(1); expect(uploads).toHaveLength(2);
    expect(new Set(uploads).size).toBe(2);
    expect(await imageCount(db, boardId)).toBe(2);
    const saved = (await db.query('SELECT file_data, file_name FROM task_attachments WHERE board_id=$1 ORDER BY file_name', [boardId])).rows;
    expect(saved.map((row) => row.file_name)).toEqual(['mixed.png', 'picker.png']);
    saved.forEach((row) => expect(row.file_data).toEqual(png));
    expect(await page.evaluate(() => (window as any).__draftUrls.size)).toBe(0);
    expect(await page.evaluate(() => (window as any).__closing)).toBe(false);
    await title(page).fill('Без картинки'); await create(page).click();
    await expect(page.locator('.create-screen')).toHaveCount(0);
    expect(creates).toHaveLength(2); expect(uploads).toHaveLength(2);
    await page.reload();
    await page.locator('.unassessed-tasks > summary').click();
    await page.getByRole('button').filter({ hasText: 'Со скриншотом' }).first().click();
    await expect(page.locator('.detail-attachment-image img')).toHaveCount(2);
    await expect.poll(() => page.locator('.detail-attachment-image img').first().evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  });
});

test('create images retry only missing files in the same task after partial failure and double submit', async ({ page }) => {
  await withCreate(page, async ({ db, boardId, state, creates, uploads, reads }) => {
    await title(page).fill('Частичный сбой'); await description(page).fill('Не терять текст');
    await paste(page); await paste(page, { name: 'second.png' });
    state.failure = 'upload'; state.rejectAt = 2;
    await page.locator('.create-screen form').evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
    await expect(retry(page)).toBeEnabled();
    await expect(page.locator('.app-message')).toContainText('Задача создана. Не удалось сохранить изображение.');
    await expect(title(page)).toHaveValue('Частичный сбой'); await expect(title(page)).toBeDisabled();
    await expect(description(page)).toHaveValue('Не терять текст');
    expect(creates).toHaveLength(1); expect(uploads).toHaveLength(2); expect(await imageCount(db, boardId)).toBe(1);
    expect(await page.evaluate(() => (window as any).__haptics)).toEqual([]);
    await paste(page, { name: 'busy.png' }); await expect(previews(page)).toHaveCount(2);
    await page.locator('.create-board-selector').click(); await expect(page.getByRole('dialog')).toHaveCount(0);
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('.create-screen > header button').click();
    await create(page).click();
    await expect(title(page)).toHaveValue('Частичный сбой'); await expect(title(page)).toBeDisabled();
    await expect(previews(page)).toHaveCount(2);
    await expect(page.locator('.create-message')).toContainText('Задача создана');
    const readCount = reads.length;
    await page.locator('.create-screen form').evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
    await expect(page.locator('.create-screen')).toHaveCount(0);
    expect(creates).toHaveLength(1); expect(uploads).toHaveLength(3); expect(uploads[2]).toBe(uploads[1]);
    expect(reads.length).toBeGreaterThan(readCount);
    expect(await imageCount(db, boardId)).toBe(2);
    expect((await db.query('SELECT title, description FROM tasks WHERE board_id=$1', [boardId])).rows).toEqual([{ title: 'Частичный сбой', description: 'Не терять текст' }]);
    expect(await page.evaluate(() => (window as any).__haptics)).toEqual(['soft']);
  });
});

for (const failure of ['reply', 'readback', 'create'] as const) test(`create images recover unknown ${failure} without duplicate task or upload`, async ({ page }) => {
  await withCreate(page, async ({ db, boardId, state, creates, uploads, reads }) => {
    await title(page).fill('Неопределённый ответ'); await paste(page);
    state.failure = failure;
    await create(page).click();
    if (failure === 'create') {
      await expect(page.locator('.app-message')).toContainText('Повторите отправку');
      expect(uploads).toHaveLength(0);
      await create(page).click();
    } else {
      await expect(retry(page)).toBeEnabled();
      expect(await imageCount(db, boardId)).toBe(1);
      await retry(page).click();
    }
    await expect(page.locator('.create-screen')).toHaveCount(0);
    expect(uploads).toHaveLength(1);
    expect(creates).toHaveLength(failure === 'create' ? 2 : 1);
    if (failure === 'create') expect(creates[1].requestId).toBe(creates[0].requestId);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect((await db.query('SELECT id FROM tasks WHERE board_id=$1', [boardId])).rowCount).toBe(1);
    expect(await imageCount(db, boardId)).toBe(1);
  });
});

test('create images warn on exit, survive navigation and release URLs when removed', async ({ page }) => {
  await withCreate(page, async ({ creates, uploads }) => {
    await title(page).fill('Локальный черновик'); await paste(page);
    const back = page.locator('.create-screen > header button');
    page.once('dialog', (dialog) => dialog.dismiss()); await back.click();
    await expect(previews(page)).toHaveCount(1);
    page.once('dialog', (dialog) => dialog.accept()); await back.click();
    await expect(page.locator('.create-screen')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__draftUrls.size)).toBe(0);
    expect(await page.evaluate(() => (window as any).__closing)).toBe(true);
    await create(page).click();
    await expect(title(page)).toHaveValue('Локальный черновик'); await expect(previews(page)).toHaveCount(1);
    expect(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
    })).toBe(true);
    await page.getByRole('button', { name: 'Удалить clipboard.png', exact: true }).click();
    expect(await page.evaluate(() => (window as any).__draftUrls.size)).toBe(0);
    expect(await page.evaluate(() => (window as any).__closing)).toBe(false);
    expect(creates).toEqual([]); expect(uploads).toEqual([]);
  });
});

test('create images cancel opening a previous result without bypassing the exit warning', async ({ page }) => {
  await withCreate(page, async ({ creates, uploads }) => {
    await title(page).fill('Предыдущая задача');
    await page.getByRole('button', { name: 'Создать и добавить ещё', exact: true }).click();
    await expect(title(page)).toHaveValue('');
    await title(page).fill('Черновик со скриншотом'); await paste(page);
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('region', { name: 'Результат создания' }).getByRole('button', { name: 'Открыть', exact: true }).click();
    await expect(title(page)).toHaveValue('Черновик со скриншотом');
    await expect(previews(page)).toHaveCount(1);
    await expect(page.locator('.task-details')).toHaveCount(0);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('region', { name: 'Результат создания' }).getByRole('button', { name: 'Открыть', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Название задачи' })).toHaveValue('Предыдущая задача');
    await page.getByRole('button', { name: 'Назад к задачам' }).click();
    await create(page).click();
    await expect(title(page)).toHaveValue('Черновик со скриншотом');
    await expect(previews(page)).toHaveCount(1);
    expect(creates).toHaveLength(1); expect(uploads).toHaveLength(0);
  });
});

test('create images reject unsupported, empty and oversized drafts without creating a task', async ({ page }) => {
  await withCreate(page, async ({ creates, uploads }) => {
    for (const [options, error] of [[{ type: 'image/svg+xml' }, 'PNG, JPEG, WebP и GIF'], [{ size: 0 }, 'Пустое изображение'], [{ size: 15 * 1024 * 1024 + 1 }, 'Файл больше 15 МБ']] as const) {
      await paste(page, options);
      await expect(page.locator('.app-message')).toContainText(error);
      await expect(previews(page)).toHaveCount(0);
    }
    await page.getByLabel('Выбрать изображения').setInputFiles({ name: 'text.txt', mimeType: 'text/plain', buffer: Buffer.from('text') });
    await expect(page.locator('.app-message')).toContainText('PNG, JPEG, WebP и GIF');
    expect(creates).toEqual([]); expect(uploads).toEqual([]);
  });
});

for (const width of [320, 390]) test(`create images partial recovery stays usable at ${width} and 200% text`, async ({ page }) => {
  await withCreate(page, async ({ db, boardId, state, creates }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await title(page).fill('Текст и изображение');
    await paste(page, { name: 'Очень-длинное-название-скриншота-для-проверки-переносов.png' });
    state.failure = 'upload'; await create(page).click();
    await expect(retry(page)).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.create-screen > header h1').evaluate((heading) => heading.scrollWidth <= heading.clientWidth)).toBe(true);
    const message = await page.locator('.create-message').boundingBox();
    const actions = await page.locator('.create-recovery-action').boundingBox();
    expect(message).not.toBeNull(); expect(actions).not.toBeNull();
    expect(actions!.y).toBeGreaterThanOrEqual(message!.y + message!.height);
    await retry(page).scrollIntoViewIfNeeded();
    await expect(retry(page)).toBeInViewport();
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/partial-${width}-200.png`, fullPage: true });
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('button', { name: 'Оставить задачу без дозагрузки' }).click();
    await expect(previews(page)).toHaveCount(1);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Оставить задачу без дозагрузки' }).click();
    await expect(page.locator('.create-screen')).toHaveCount(0);
    expect(creates).toHaveLength(1); expect(await imageCount(db, boardId)).toBe(0);
    expect((await db.query('SELECT id FROM tasks WHERE board_id=$1', [boardId])).rowCount).toBe(1);
    await create(page).click(); await expect(previews(page)).toHaveCount(0); await expect(title(page)).toHaveValue('');
  });
});

test('create images timeout permits readback recovery and ignores a late reply in the next draft', async ({ page }) => {
  await withCreate(page, async ({ db, boardId, state, creates, uploads }) => {
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => { release = resolve; });
    try {
      await page.clock.install();
      await title(page).fill('Таймаут'); await paste(page);
      await page.getByRole('button', { name: 'Создать и добавить ещё', exact: true }).click();
      await expect.poll(() => imageCount(db, boardId)).toBe(1);
      await page.clock.fastForward(30_001);
      await expect(retry(page)).toBeEnabled();
      await expect(page.locator('.app-message')).toContainText('30 секунд');
      await retry(page).click();
      await expect(title(page)).toHaveValue('');
      await title(page).fill('Следующий черновик');
      release();
      await expect(title(page)).toHaveValue('Следующий черновик');
      await expect(previews(page)).toHaveCount(0);
      expect(creates).toHaveLength(1); expect(uploads).toHaveLength(1);
    } finally { release(); }
  });
});
