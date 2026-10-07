import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Config } from './config.js';
import { boardForUser, withBoardLock, type Database } from './db.js';
import { escapeHtml, telegramCall, TelegramRejectedError } from './telegram.js';
import { tutorialButton, tutorialPage, type TutorialPage } from './bot-tutorial.js';

type Delivery = 'sent' | 'failed' | 'uncertain' | 'sending' | 'skipped';

function entryKey(config: Config, key: string) {
  // The token prefix is the stable bot ID; never persist the token's secret part.
  const identity = createHash('sha256').update(config.botToken.split(':', 1)[0]).digest('hex');
  return `bot:${identity}:${key}`;
}

// Telegram has no send idempotency key. Unknown outcomes require operator inspection,
// never an automatic resend. A process crash after claiming is also an unknown outcome.
async function deliverEntry(db: Database, config: Config, key: string, prepare: () => Promise<{method: string; body: unknown}>, retryFailed = true): Promise<Delivery> {
  await db.query(`UPDATE telegram_entry_deliveries SET status = 'uncertain', error_code = 'interrupted'
    WHERE key = $1 AND status = 'sending' AND updated_at < now() - interval '2 minutes'`, [key]);
  const claimed = await db.query(`UPDATE telegram_entry_deliveries d SET status = 'sending', attempts = attempts + 1, updated_at = now(), error_code = NULL
    WHERE key = $1 AND (status = 'pending' OR ($2 AND status = 'failed'))
      AND (board_id IS NULL OR EXISTS (SELECT 1 FROM boards b WHERE b.id = d.board_id AND b.status <> 'frozen')) RETURNING key`, [key, retryFailed]);
  if (!claimed.rowCount) {
    const row = (await db.query<{status: Delivery}>('SELECT status FROM telegram_entry_deliveries WHERE key = $1', [key])).rows[0];
    if (!retryFailed && row?.status === 'failed') return 'failed';
    return row && ['sent', 'sending', 'uncertain'].includes(row.status) ? row.status : 'skipped';
  }
  let attempted = false;
  try {
    const { method, body } = await prepare();
    attempted = true;
    const result = await telegramCall<{message_id: number}>(config.botToken, method, body).catch((error) => {
      if (method === 'editMessageText' && error instanceof TelegramRejectedError && error.messageNotModified) {
        return { message_id: (body as {message_id: number}).message_id };
      }
      throw error;
    });
    if (!Number.isSafeInteger(result.message_id)) throw new Error('Message receipt missing');
    await db.query("UPDATE telegram_entry_deliveries SET status = 'sent', message_id = $2, updated_at = now() WHERE key = $1", [key, result.message_id]);
    return 'sent';
  } catch (error) {
    const rejected = error instanceof TelegramRejectedError;
    const status = !attempted || rejected ? 'failed' : 'uncertain';
    await db.query('UPDATE telegram_entry_deliveries SET status = $2, error_code = $3, updated_at = now() WHERE key = $1',
      [key, status, rejected ? `telegram_${error.code}` : attempted ? 'result_unknown' : 'prepare_failed']);
    return status;
  }
}

export async function sendGroupWelcome(db: Database, config: Config, chatId: number) {
  const board = (await db.query<{id: string}>("SELECT id FROM boards WHERE type = 'chat' AND telegram_chat_id = $1", [chatId])).rows[0];
  if (!board) return 'skipped';
  const key = entryKey(config, `board:${board.id}`);
  await db.query('INSERT INTO telegram_entry_deliveries (key, board_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [key, board.id]);
  return deliverEntry(db, config, key, async () => {
    const photo = await readFile(new URL('../../../artifacts/ux/assets/group-welcome.png', import.meta.url));
    const message = await withBoardLock(db, board.id, async (client) => {
      const current = (await client.query<{name: string; telegram_chat_id: string}>("SELECT name, telegram_chat_id FROM boards WHERE id = $1 AND status <> 'frozen' FOR UPDATE", [board.id])).rows[0];
      if (!current) throw new Error('Board frozen');
      // Only a definitely unsent attempt can reach here. Sent/uncertain links never rotate.
      const token = `board_${randomBytes(24).toString('base64url')}`;
      await client.query("UPDATE board_links SET revoked_at = now() WHERE board_id = $1 AND kind = 'launch' AND revoked_at IS NULL", [board.id]);
      await client.query("INSERT INTO board_links (token_hash, board_id, kind) VALUES ($1, $2, 'launch')", [createHash('sha256').update(token).digest('hex'), board.id]);
      return { ...current, token };
    });
    const body = new FormData();
    body.set('chat_id', message.telegram_chat_id);
    body.set('photo', new Blob([photo], { type: 'image/png' }), 'group-welcome.png');
    body.set('caption', `<b>Таска · ${escapeHtml(message.name)}</b>\n\nОбщие задачи вашей команды. Администратор запускает доску, участники добавляют задачи и берут их в работу.\n\nЗакрепите это сообщение — кнопка останется входом в доску.`);
    body.set('parse_mode', 'HTML');
    body.set('reply_markup', JSON.stringify({ inline_keyboard: [[{ text: 'Открыть задачи', url: `https://t.me/${config.botUsername}?startapp=${message.token}` }]] }));
    return { method: 'sendPhoto', body };
  });
}

export async function sendBotEntry(db: Database, config: Config, messageId: number, chatId: number, help: boolean) {
  const key = entryKey(config, `command:${createHash('sha256').update(`${chatId}:${messageId}`).digest('hex')}`);
  await db.query('INSERT INTO telegram_entry_deliveries (key) VALUES ($1) ON CONFLICT DO NOTHING', [key]);
  return deliverEntry(db, config, key, async () => ({ method: 'sendMessage', body: {
    chat_id: chatId, parse_mode: 'HTML', ...entryMessage(config, help)
  } }));
}

function entryMessage(config: Config, help: boolean): TutorialPage {
  const button = (text: string, start: string) => [{ text, url: `https://t.me/${config.botUsername}?startapp=${start}` }];
  return {
    text: help
      ? '<b>Таска · как начать</b>\n\n1. Выберите доску: личную, на двоих по приглашению или для группы.\n2. Создайте задачу кнопкой «+». Исполнитель и срок необязательны. Список задач можно вставить в бэклоге.\n3. Возьмите задачу себе или назначьте исполнителя. Меняйте статус по мере работы.\n\nИзменения существующей задачи сохраняются автоматически. Перед выходом проверьте статус сохранения; при ошибке связи дождитесь синхронизации, при конфликте выберите нужную версию.\n\nУведомление исполнителю отправляется только по вашему выбору при назначении. Публикации в группу настраивает администратор.\n\nПомощь всегда доступна командой /help и в настройках приложения.'
      : '<b>Таска — дела под рукой</b>\n\nЛичные и общие задачи в Telegram. Создавайте задачи, назначайте исполнителей и сроки, следите за выполнением.\n\nВпервые здесь? Пройдите короткое обучение прямо в этом чате: зачем нужен задачник и как начать. Или сразу выберите доску ниже.',
    reply_markup: { inline_keyboard: [[tutorialButton(help ? 'Пройти обучение ещё раз' : 'Как пользоваться Таской', 'intro')], button('Личные задачи', 'personal'), button('Доска на двоих', 'pair'), button('Доска для группы', 'group'), button('Как начать', 'help')] }
  };
}

export async function sendBoardEntry(db: Database, config: Config, messageId: number, chatId: number, boardId: string | null) {
  const key = entryKey(config, `command:${createHash('sha256').update(`${chatId}:${messageId}`).digest('hex')}`);
  await db.query('INSERT INTO telegram_entry_deliveries (key) VALUES ($1) ON CONFLICT DO NOTHING', [key]);
  return deliverEntry(db, config, key, async () => {
    const user = (await db.query<{id: string}>('SELECT id FROM users WHERE telegram_id = $1', [chatId])).rows[0];
    const board = user && boardId ? await boardForUser(db, user.id, boardId) : null;
    if (!board || !['chat', 'pair'].includes(board.type) || !['active', 'archived'].includes(board.status)) {
      return { method: 'sendMessage', body: { chat_id: chatId, text: 'Не удалось получить вход в доску. Откройте доступную вам общую доску в Таске и нажмите «Получить сообщение для пересылки».' } };
    }
    const url = `https://t.me/${config.botUsername}?startapp=open_${board.id}`;
    const photo = await readFile(new URL('../../../artifacts/ux/assets/board-entry.png', import.meta.url));
    const body = new FormData();
    body.set('chat_id', String(chatId));
    body.set('photo', new Blob([photo], { type: 'image/png' }), 'board-entry.png');
    body.set('caption', `<b>Таска · ${escapeHtml(board.name)}</b>\n\nВход в общую доску задач.\nДоска доступна только её участникам. Эта ссылка не приглашает новых людей.\n\nОткрыть доску: ${url}`);
    body.set('parse_mode', 'HTML');
    body.set('reply_markup', JSON.stringify({ inline_keyboard: [[{ text: 'Открыть доску', url }]] }));
    return { method: 'sendPhoto', body };
  });
}

export type TutorialCallback = {
  id: string;
  from: {id: number};
  data?: unknown;
  message?: {message_id: number; date: number; from?: {id: number; is_bot: boolean}; chat: {id: number; type: string}; reply_markup?: {inline_keyboard?: {callback_data?: unknown}[][]}};
};

export async function sendBotTutorial(db: Database, config: Config, callback: TutorialCallback): Promise<Delivery> {
  const message = callback.message;
  const page = callback.data === 'learn:v1:skip' ? entryMessage(config, false) : tutorialPage(callback.data, config.botUsername);
  const keyboard = message?.reply_markup?.inline_keyboard;
  const isTutorial = Array.isArray(keyboard) && keyboard.some(row => Array.isArray(row) && row.some(button =>
    button?.callback_data === 'learn:v1:skip' || tutorialPage(button?.callback_data, config.botUsername) !== null));
  let delivery: Delivery = 'skipped';
  if (page && isTutorial && message?.chat?.type === 'private' && message.chat.id === callback.from.id &&
    Number.isSafeInteger(message.message_id) && message.message_id > 0 && Number.isSafeInteger(message.date) && message.date > 0 &&
    message.from?.is_bot === true && message.from.id === Number(config.botToken.split(':', 1)[0])) {
    const key = entryKey(config, `tutorial:${createHash('sha256').update(callback.id).digest('hex')}`);
    await db.query('INSERT INTO telegram_entry_deliveries (key) VALUES ($1) ON CONFLICT DO NOTHING', [key]);
    delivery = await deliverEntry(db, config, key, async () => ({ method: 'editMessageText', body: {
      chat_id: message.chat.id, message_id: message.message_id, parse_mode: 'HTML', ...page
    } }), false);
  }
  // An expired/failed callback answer must never turn an already edited message into a retry.
  try {
    await telegramCall(config.botToken, 'answerCallbackQuery', {
      callback_query_id: callback.id, cache_time: 0, show_alert: delivery === 'skipped' || delivery === 'failed' || delivery === 'uncertain',
      text: delivery === 'sent' ? '' : delivery === 'sending' ? 'Шаг уже обновляется.' : 'Не удалось обновить шаг. Откройте обучение заново через /help в личном чате бота.'
    });
  } catch { /* The user can restart with /help; no extra message is sent. */ }
  return delivery;
}
