import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ActionRow, AppShell, Icon, TasksScreen } from '../../../apps/web/src/app-shell';
import { PairScreen } from '../../../apps/web/src/pair-board';

// Local consultation prototype only. No Telegram requests, API or database writes.
async function main() {
const root = pathToFileURL(`${process.cwd()}/`);
const output = new URL('artifacts/visual-evidence/issue-180/', root);
await mkdir(output, { recursive: true });
const css = await readFile(new URL('apps/web/src/style.css', root), 'utf8');
const font = await readFile(new URL('apps/web/public/fonts/manrope-variable.ttf', root));
const cover = await readFile(new URL('artifacts/ux/assets/board-entry.png', root));
const boardName = 'Запуск сайта';
const noop = () => {};
const screens = {
  board: <AppShell message="" navigation={{ screen: 'tasks' }} navigate={noop}>
    <TasksScreen boardName={boardName} onSelectBoard={noop}>
      <ActionRow label="Доступ" value="Доска на двоих" onClick={noop}/>
      <ActionRow label="Вход в эту доску" value="Получить сообщение для пересылки" icon={<Icon name="send"/>} data-preview-next="message" onClick={noop}/>
      <div className="scope-tabs" aria-label="Очередь задач"><button aria-pressed="false">Мои</button><button aria-pressed="true">Все</button><button aria-pressed="false">Бэклог</button></div>
      <div className="task-toolbar">
        <div className="list-controls"><div className="view-switch" aria-label="Вид задач"><button className="active" aria-label="Список"><svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h3v3H5zM11 6h8M5 11h3v3H5zM11 11h8M5 16h3v3H5zM11 16h8"/></svg></button><button aria-label="Канбан"><svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h4v14H5zM10 5h4v14h-4zM15 5h4v14h-4z"/></svg></button></div></div>
        <button className="search-trigger" aria-label="Поиск"><Icon name="search"/></button>
        <button className="filter-trigger" aria-label="Фильтры"><Icon name="sliders"/></button>
      </div>
      <section className="task-state"><h2>Начните с первой задачи.</h2><p>Добавьте задачу или вставьте список. Исполнителя можно выбрать позже.</p><button>Добавить задачу</button><button className="secondary">Вставить список</button></section>
    </TasksScreen>
  </AppShell>,
  message: <main className="pair-screen">
    <header><h1>Сообщение бота</h1></header>
    <p className="pair-context">Макет содержимого, не снимок Telegram</p>
    <section className="preview-message">
      <img src={`data:image/png;base64,${cover.toString('base64')}`} alt="Таска — дела под рукой"/>
      <strong>Таска · {boardName}</strong>
      <p>Вход в общую доску задач.</p>
      <p>Доска доступна только её участникам. Эта ссылка не приглашает новых людей.</p>
      <a href="#" aria-label="Пример ссылки на доску">Открыть доску: [ссылка на эту доску]</a>
      <button data-preview-next="board">Открыть доску</button>
    </section>
    <p>Перешлите это сообщение в нужный личный диалог. Ссылка в тексте останется альтернативой кнопке.</p>
    <p className="pair-notice">Сохранность ссылки и кнопки после реальной пересылки ещё предстоит проверить.</p>
    <div className="pair-actions"><button className="secondary" data-preview-next="denied">Посмотреть макет «Нет доступа»</button></div>
  </main>,
  denied: <PairScreen title="Доска недоступна" onBack={noop} actions={<button data-preview-next="board">К моим задачам</button>}>
    <h2>Нужен доступ к доске.</h2>
    <p>Эта ссылка не выдаёт доступ. Попросите отправителя прислать отдельное приглашение.</p>
    <p>Если приглашение уже было принято, попросите владельца проверить ваш доступ.</p>
  </PairScreen>
};
const extraCss = `
@font-face { font-family: Manrope; src: url(data:font/ttf;base64,${font.toString('base64')}) format('truetype'); font-weight: 200 800; }
/* This static prototype shows the online state; the SSR offline fallback is not hydrated. */
.offline-banner { display: none; }
.preview-message { margin: 0; padding: 22px; display: grid; gap: 14px; border: 1px solid var(--glass-border); border-radius: 28px; background: var(--card-fill); box-shadow: var(--shadow-card); }
.preview-message p { margin: 0; }
.preview-message img { display: block; width: 100%; border-radius: 16px; }
.preview-message a { overflow-wrap: anywhere; }
`;
const documents = Object.fromEntries(Object.entries(screens).map(([name, element]) => [name, `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Таска #180 — макет: ${name}</title><style>${css}\n${extraCss}</style><body>${renderToStaticMarkup(element)}<script>document.querySelectorAll('[data-preview-next]').forEach(button => button.addEventListener('click', () => { location.href = button.dataset.previewNext + '.html'; }));</script></body></html>`]));
for (const [name, html] of Object.entries(documents)) await writeFile(new URL(`${name}.html`, output), html);
const overview = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Таска #180 — макет на согласование</title><style>body{margin:0;background:#EDF0EA;color:#183C2C;font:16px system-ui}h1{font-size:24px;padding:16px;margin:0}p{padding:0 16px}.screens{display:flex;gap:16px;padding:16px;flex-wrap:wrap}iframe{width:390px;height:844px;border:1px solid #BDCCB5;border-radius:24px;background:#EDF0EA}h2{font-size:18px}</style><h1>Таска #180 · макет на согласование</h1><p>Иллюстрация сценария. Telegram, сервер и выдача доступа не подключены.</p><div class="screens">${Object.keys(screens).map((name, index) => `<section><h2>${['1. Открытая доска', '2. Готовое сообщение', '3. Получатель без доступа'][index]}</h2><iframe title="${name}" src="${name}.html"></iframe></section>`).join('')}</div></html>`;
await writeFile(new URL('index.html', output), overview);

// Playwright launches a new, isolated headless Chrome, never the personal profile.
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results: {screen: string; width: number; textScale: number; overflow: boolean}[] = [];
try {
  const context = await browser.newContext({ reducedMotion: 'reduce', locale: 'ru-RU' });
  await context.route('**/*', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()?.replace('.html', '');
    const html = name === 'index' ? overview : documents[name ?? ''];
    if (html) await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    else await route.abort();
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const screen of Object.keys(screens)) {
      await page.goto(`https://preview.invalid/${screen}.html`);
      await page.evaluate(() => document.fonts.ready);
      for (const textScale of [100, 200]) {
        await page.evaluate((scale) => { document.documentElement.style.fontSize = `${scale}%`; }, textScale);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert.equal(overflow, false, `${screen}, ${width}px, ${textScale}% text`);
        results.push({ screen, width, textScale, overflow });
        await page.screenshot({ path: fileURLToPath(new URL(`${screen}-${width}-${textScale}.png`, output)), fullPage: true });
      }
    }
  }
  await page.goto('https://preview.invalid/board.html');
  const action = page.getByRole('button', { name: 'Вход в эту доску Получить сообщение для пересылки' });
  await action.focus();
  assert.equal(await action.evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.waitForURL('**/message.html');
  assert.equal(new URL(page.url()).pathname, '/message.html');
  await page.getByRole('button', { name: 'Посмотреть макет «Нет доступа»' }).click();
  await page.waitForURL('**/denied.html');
  assert.equal(new URL(page.url()).pathname, '/denied.html');
  assert.equal(await page.getByText(boardName, { exact: true }).count(), 0, 'No board name in the denied screen');
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 1260, height: 1040 });
  await page.goto('https://preview.invalid/index.html');
  await page.screenshot({ path: fileURLToPath(new URL('overview.png', output)), fullPage: true });
  await writeFile(new URL('checks.json', output), JSON.stringify({ kind: 'consultation-prototype-only', browser: await browser.version(), results, keyboardNavigation: 'pass', pageErrors: errors, realTelegramTested: false }, null, 2));
  console.log(JSON.stringify({ preview: fileURLToPath(new URL('index.html', output)), screenshot: fileURLToPath(new URL('overview.png', output)), checks: results.length, keyboardNavigation: 'pass', realTelegramTested: false }, null, 2));
} finally { await browser.close(); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
