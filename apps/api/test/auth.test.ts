import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { validateInitData } from '../src/auth.js';

const token = '123456:test-token';
function signed(authDate: number, user = { id: 42, first_name: 'Яков' }) {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify(user), query_id: 'q' });
  const data = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(data).digest('hex'));
  return params.toString();
}

test('accepts valid Telegram data', () => assert.equal(validateInitData(signed(1_000), token, 100, 1_050_000).id, 42));
test('rejects changed Telegram data', () => assert.throws(() => validateInitData(signed(1_000).replace('%D0%AF%D0%BA%D0%BE%D0%B2', 'Mallory'), token, 100, 1_050_000), /signature/));
test('rejects expired Telegram data', () => assert.throws(() => validateInitData(signed(1_000), token, 100, 1_101_000), /expired/));
