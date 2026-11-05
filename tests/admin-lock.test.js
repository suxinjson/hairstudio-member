import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
globalThis.localStorage = new MemoryStorage();
const { AdminApiClient, ADMIN_IDLE_TIMEOUT_MS } = await import('../admin/src/api/client.js');
const user = { id: 'owner-A', storeId: 'store-A', username: 'owner', role: 'owner' };
const session = { accessToken: 'access', refreshToken: 'refresh', user };

function fixture(t) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const storage = new MemoryStorage();
  const create = () => {
    const client = new AdminApiClient({ storage, eventTarget: null });
    t.after(() => client.dispose()); return client;
  };
  const client = create(); client.saveSession(session, false);
  return { client, storage, create, advance: milliseconds => { now += milliseconds; } };
}

test('reopening preserves the idle deadline and locks expired sessions without discarding pending writes', async t => {
  const { client, storage, create, advance } = fixture(t);
  const pendingKey = client.scopedKey('pending'); storage.setItem(pendingKey, 'retained operation');
  const deadline = client.idleExpiresAt.value;
  advance(ADMIN_IDLE_TIMEOUT_MS - 1);
  const reopened = create();
  assert.equal(reopened.isLocked.value, false);
  assert.equal(reopened.idleExpiresAt.value, deadline);
  advance(1);
  const expired = create();
  assert.equal(expired.isLocked.value, true);
  expired.recordActivity();
  assert.equal(expired.isLocked.value, true);
  assert.equal(expired.idleExpiresAt.value, deadline);
  assert.equal(storage.getItem(pendingKey), 'retained operation');
  assert.equal(expired.refreshToken.value, session.refreshToken);
  await assert.rejects(expired.sync([]), /请先解锁/);
});

test('token rotation preserves the activity deadline and cannot unlock an expired session', async t => {
  const { client, advance } = fixture(t);
  const deadline = client.idleExpiresAt.value;
  let count = 0;
  client.requestFetch = async () => ({ ok: true, json: async () => ({ ...session, accessToken: 'access-' + ++count }) });
  advance(60000); await client.refresh();
  assert.equal(client.idleExpiresAt.value, deadline);
  assert.equal(client.isLocked.value, false);
  advance(ADMIN_IDLE_TIMEOUT_MS); await client.refresh();
  assert.equal(client.idleExpiresAt.value, deadline);
  assert.equal(client.isLocked.value, true);
});

test('activity and manual locks are shared across tabs and password login starts a new deadline', async t => {
  const { client, create, advance } = fixture(t);
  const other = create();
  const initialDeadline = client.idleExpiresAt.value;
  advance(60000); client.recordActivity(); other.restoreSession();
  assert.equal(other.idleExpiresAt.value, initialDeadline + 60000);
  advance(ADMIN_IDLE_TIMEOUT_MS - 60000); other.restoreSession();
  assert.equal(other.isLocked.value, false);
  client.isLocked.value = true; other.recordActivity();
  assert.equal(other.isLocked.value, true);
  advance(24 * 60 * 60 * 1000);
  other.requestFetch = async () => ({ ok: true, json: async () => session });
  await other.login('owner', 'password'); client.restoreSession();
  assert.equal(other.isLocked.value, false);
  assert.equal(client.isLocked.value, false);
  assert.equal(client.idleExpiresAt.value, Date.now() + ADMIN_IDLE_TIMEOUT_MS);
});

test('legacy saved credentials require password unlock instead of receiving a fresh idle window', t => {
  const { storage, create } = fixture(t);
  storage.setItem('hairstudio_admin_auth', JSON.stringify({ ...session, isLocked: false }));
  const legacy = create();
  assert.equal(legacy.isLocked.value, true);
  legacy.recordActivity();
  assert.equal(legacy.isLocked.value, true);
  assert.equal(legacy.idleExpiresAt.value, null);
});
