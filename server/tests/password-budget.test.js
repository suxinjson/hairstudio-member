import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPassword, hashPassword } from '../security.js';

test('password work rejects overload and releases its queue for subsequent legitimate logins', async () => {
  const burst = await Promise.allSettled(Array.from({ length: 40 }, () => verifyPassword('incorrect')));
  assert.equal(burst.filter(result => result.status === 'fulfilled' && result.value === false).length, 20);
  assert.equal(burst.filter(result => result.reason?.status === 503 && result.reason.code === 'SERVER_BUSY').length, 20);
  const password = 'Correct-Horse-Cloud-2026!';
  assert.equal(await verifyPassword(password, await hashPassword(password)), true);
});
