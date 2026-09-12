import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Config } from './config.js';
import { withBoardLock, type Database } from './db.js';
import { escapeHtml, telegramCall, TelegramRejectedError } from './telegram.js';

type Delivery = 'sent' | 'failed' | 'uncertain' | 'sending' | 'skipped';

// Telegram has no send idempotency key. Unknown outcomes require operator inspection,
// never an automatic resend. A process crash after claiming is also an unknown outcome.
async function deliverEntry(db: Database, config: Config, key: string, prepare: () => Promise<{method: string; body: unknown}>): Promise<Delivery> {
  await db.query(`UPDATE telegram_entry_deliveries SET status = 'uncertain', error_code = 'interrupted'
    WHERE key = $1 AND status = 'sending' AND updated_at < now() - interval '2 minutes'`, [key]);
  const claimed = await db.query(`UPDATE telegram_entry_deliveries d SET status = 'sending', attempts = attempts + 1, updated_at = now(), error_code = NULL
    WHERE key = $1 AND status IN ('pending', 'failed')
      AND (board_id IS NULL OR EXISTS (SELECT 1 FROM boards b WHERE b.id = d.board_id AND b.status <> 'frozen')) RETURNING key`, [key]);
  if (!claimed.rowCount) {
    const row = (await db.query<{status: Delivery}>('SELECT status FROM telegram_entry_deliveries WHERE key = $1', [key])).rows[0];
    return row && ['sent', 'sending', 'uncertain'].includes(row.status) ? row.status : 'skipped';
  }
  let attempted = false;
  try {
    const { method, body } = await prepare();
    attempted = true;
    const result = await telegramCall<{message_id: number}>(config.botToken, method, body);
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
  return deliverEntry(db, config, `board:${board.id}`, async () => {
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
    body.set('caption', `<b>Задачи команды · ${escapeHtml(message.name)}</b>\n\nДобавляйте задачи, берите их в работу и отслеживайте выполнение.`);
    body.set('parse_mode', 'HTML');
    body.set('reply_markup', JSON.stringify({ inline_keyboard: [[{ text: 'Открыть задачи', url: `https://t.me/${config.botUsername}?startapp=${message.token}` }]] }));
    return { method: 'sendPhoto', body };
  });
}

export async function sendBotEntry(db: Database, config: Config, messageId: number, chatId: number, help: boolean) {
  const key = `command:${createHash('sha256').update(`${chatId}:${messageId}`).digest('hex')}`;
  await db.query('INSERT INTO telegram_entry_deliveries (key) VALUES ($1) ON CONFLICT DO NOTHING', [key]);
  const button = (text: string, start: string) => [{ text, url: `https://t.me/${config.botUsername}?startapp=${start}` }];
  return deliverEntry(db, config, key, async () => ({ method: 'sendMessage', body: {
    chat_id: chatId, parse_mode: 'HTML',
    text: help
      ? '<b>Как начать</b>\n\nЛичные задачи — только для вас. Доска на двоих — по приглашению, без группы. Доска для группы — общий вход через сообщение бота.\n\nВыберите свой путь: внутри — короткая инструкция. Добавьте задачу кнопкой «+» или вставьте список в бэклоге. Задачу без исполнителя можно взять себе.\n\nПомощь всегда доступна командой /help и в настройках приложения.'
      : '<b>Личные и общие задачи в Telegram</b>\n\nДобавляйте задачи, выбирайте исполнителя и следите за сроками.\n\nКак будете работать?',
    reply_markup: { inline_keyboard: [button('Личные задачи', 'personal'), button('Доска на двоих', 'pair'), button('Доска для группы', 'group'), button('Как начать', 'help')] }
  } }));
}
