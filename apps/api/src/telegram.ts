type TelegramResult<T> = { ok: boolean; result?: T; description?: string };

export async function telegramCall<T>(botToken: string, method: string, body: unknown): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await response.json() as TelegramResult<T>;
  if (!response.ok || !data.ok || data.result === undefined) throw new Error(data.description ?? `Telegram ${method} failed`);
  return data.result;
}

export async function isChatAdmin(botToken: string, chatId: string | number, telegramUserId: string | number) {
  const member = await telegramCall<{status: string}>(botToken, 'getChatMember', { chat_id: chatId, user_id: telegramUserId });
  return member.status === 'creator' || member.status === 'administrator';
}
