import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createTelegramDispatcher } from './telegram-transport.mjs';

const allowedUpdates = ['message', 'my_chat_member', 'callback_query'];
const heartbeat = '/tmp/telegram-poller-heartbeat';

// Telegram persists acknowledgements. After a crash, unconfirmed updates replay
// through the existing webhook's DB deduplication; no separate offset store is needed.
export async function deliverBatch(updates, deliver) {
  if (!Array.isArray(updates)) throw new Error('Invalid updates');
  let previous = -1;
  for (const update of updates) {
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0 ||
        update.update_id >= Number.MAX_SAFE_INTEGER || update.update_id <= previous) {
      throw new Error('Invalid update order');
    }
    previous = update.update_id;
  }
  for (const update of updates) await deliver(update);
  return updates.length ? previous + 1 : undefined;
}

export async function forwardUpdate(update, target, secret, signal) {
  const response = await fetch(target, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify(update)
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw Object.assign(new Error('Webhook rejected update'), { status: response.status });
  }
  const result = await response.json();
  if (typeof result?.ok !== 'boolean') throw new Error('Webhook receipt missing');
  // HTTP 200 with uncertain/failed callback delivery intentionally blocks resends.
  // Preserve that contract rather than retrying a possibly sent Telegram message.
  return result;
}

async function main() {
  const token = process.env.BOT_TOKEN ?? '';
  const secret = process.env.WEBHOOK_SECRET ?? '';
  const username = process.env.BOT_USERNAME ?? '';
  const target = new URL(process.env.TELEGRAM_WEBHOOK_FORWARD_URL ?? '');
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || secret.length < 32 ||
      !/^[A-Za-z0-9_]{5,32}$/.test(username) || target.protocol !== 'http:' ||
      !['app', 'tg-task-kanban-app-1', '127.0.0.1'].includes(target.hostname) ||
      target.port !== '2240' || target.pathname !== '/api/telegram/webhook' ||
      target.username || target.password || target.search || target.hash) {
    throw new Error('Invalid polling configuration');
  }
  const stop = new AbortController();
  process.once('SIGTERM', () => stop.abort());
  process.once('SIGINT', () => stop.abort());
  const dispatcher = process.env.TELEGRAM_API_PROXY ? createTelegramDispatcher(process.env.TELEGRAM_API_PROXY) : undefined;
  const signal = (milliseconds) => AbortSignal.any([stop.signal, AbortSignal.timeout(milliseconds)]);
  const log = (event, fields = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
  const beat = () => writeFile(heartbeat, String(Date.now()), { mode: 0o600 });
  async function call(method, body = {}) {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', redirect: 'error', dispatcher, signal: signal(50_000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    const value = await response.json();
    if (!response.ok || value.ok !== true) {
      const seconds = value.parameters?.retry_after;
      throw Object.assign(new Error('Telegram request failed'), {
        status: Number.isInteger(value.error_code) ? value.error_code : response.status,
        retrySeconds: Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 5
      });
    }
    return value.result;
  }
  try {
    const me = await call('getMe');
    if (me.id !== Number(token.split(':', 1)[0]) || me.username !== username || !me.is_bot) {
      throw new Error('Bot identity mismatch');
    }
    const probe = await fetch(target, {
      method: 'POST', redirect: 'error', signal: signal(10_000),
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: '{}'
    });
    await probe.body?.cancel();
    if (probe.status !== 400) throw new Error('Webhook authentication probe failed');
    if (process.argv.includes('--probe')) { log('probe_passed'); return; }
    const hook = await call('getWebhookInfo');
    if (hook.url !== '') {
      log('blocked', { reason: 'webhook_still_enabled' });
      await sleep(2_147_483_647, undefined, { signal: stop.signal });
      return;
    }
    log('ready');
    let offset;
    // ponytail: one sequential consumer, batches of ten; increase only after measured backlog.
    while (!stop.signal.aborted) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 25, limit: 10, allowed_updates: allowedUpdates });
        const next = await deliverBatch(updates, async (update) => {
          const started = Date.now();
          const result = await forwardUpdate(update, target, secret, signal(75_000));
          const delivery = ['sent', 'skipped', 'uncertain', 'failed', 'sending'].includes(result.delivery) ? result.delivery : 'accepted';
          log('forwarded', { milliseconds: Date.now() - started, delivery });
          await beat();
        });
        offset = next ?? offset;
        await beat();
      } catch (error) {
        if (stop.signal.aborted) break;
        const status = Number.isInteger(error.status) ? error.status : 0;
        log('retry', { status }); // Never print errors, request URLs, payloads or credentials.
        if ([401, 403, 404, 409].includes(status)) {
          log('blocked', { reason: 'authentication_or_consumer_conflict' });
          await sleep(2_147_483_647, undefined, { signal: stop.signal });
          break;
        }
        await sleep((error.retrySeconds ?? 5) * 1000, undefined, { signal: stop.signal });
      }
    }
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    await dispatcher?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(JSON.stringify({ event: 'startup_failed', details: 'suppressed' }));
    process.exitCode = 1;
  });
}
