import { createHmac, timingSafeEqual } from 'node:crypto';

export type TelegramUser = { id: number; first_name: string; username?: string };

export function validateInitData(raw: string, botToken: string, maxAgeSeconds: number, now = Date.now()): TelegramUser {
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) throw new Error('invalid initData signature');
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest();
  const received = Buffer.from(hash, 'hex');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error('invalid initData signature');

  const authDate = Number(params.get('auth_date'));
  const age = Math.floor(now / 1000) - authDate;
  if (!Number.isInteger(authDate) || age < -30 || age > maxAgeSeconds) throw new Error('expired initData');

  let user: TelegramUser;
  try { user = JSON.parse(params.get('user') ?? ''); } catch { throw new Error('invalid Telegram user'); }
  if (!Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.first_name !== 'string' || !user.first_name.trim()) {
    throw new Error('invalid Telegram user');
  }
  return user;
}
