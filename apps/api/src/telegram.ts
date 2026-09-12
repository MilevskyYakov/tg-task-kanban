type TelegramResult<T> = { ok: boolean; result?: T; description?: string; error_code?: number };

export class TelegramRejectedError extends Error {
  constructor(public code: number) { super(`Telegram rejected request (${code})`); }
}

export const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export async function telegramCall<T>(botToken: string, method: string, body: unknown): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    ...(body instanceof FormData ? { body } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  });
  const data = await response.json() as TelegramResult<T>;
  if (!data.ok && data.error_code && data.error_code >= 400 && data.error_code < 500) throw new TelegramRejectedError(data.error_code);
  if (!response.ok || !data.ok || data.result === undefined) throw new Error(`Telegram ${method} result unknown`);
  return data.result;
}

export async function isChatAdmin(botToken: string, chatId: string | number, telegramUserId: string | number) {
  const member = await telegramCall<{status: string}>(botToken, 'getChatMember', { chat_id: chatId, user_id: telegramUserId });
  return member.status === 'creator' || member.status === 'administrator';
}
