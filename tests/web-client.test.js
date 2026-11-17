import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebClient } from '../src/web-client.js';
import { ADMIN_IDLE_TIMEOUT_MS, ADMIN_SESSION_KEY, AdminApiClient, buildAdminOperation } from '../admin/src/api/client.js';
import { createLocalDb, STORAGE_KEYS } from '../src/storage.js';
import { replayOperation } from '../src/cloud-storage.js';
import { canonicalJSON } from '../src/sync-protocol.js';
import { integrity } from '../server/security.js';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
const user = { id: 'owner-A', storeId: 'store-A', role: 'owner', username: 'owner' };
const session = { accessToken: 'access', refreshToken: 'refresh', user };
function fixture(t) {
  const storage = new MemoryStorage(), ledger = createLocalDb(new MemoryStorage());
  ledger.init(); const member = ledger.createMember({ name: '服务器会员', phone: '13800008001', initialBalance: 100 });
  let data = ledger.readBackupState(), revision = 1, loseResponse = false;
  const operations = new Map(), requests = [];
  const fetch = async (path, options) => {
    requests.push(path);
    if (path === '/api/v1/account/head') return Response.json({ revision, integrity: integrity(data) });
    if (path === '/api/v1/account') return Response.json({ data, revision, integrity: integrity(data) });
    if (path === '/api/v1/sync') {
      const body = JSON.parse(options.body);
      for (const operation of body.operations) {
        if (operations.has(operation.id)) { assert.equal(canonicalJSON(operation), operations.get(operation.id)); continue; }
        try { data = replayOperation(data, operation).data; }
        catch (error) { return Response.json({ error: error.message, code: 'SYNC_CONFLICT' }, { status: 409 }); }
        revision++; operations.set(operation.id, canonicalJSON(operation));
      }
      if (loseResponse) { loseResponse = false; throw new TypeError('response lost'); }
      return Response.json({ data, revision, integrity: integrity(data), acknowledged: body.operations.map(op => op.id) });
    }
    throw new Error('Unexpected request: ' + path);
  };
  const create = (eventTarget = null, documentTarget = null) => {
    const api = new AdminApiClient({ storage, fetch, eventTarget: null, serverOrigin: 'https://member.example.com' });
    const web = createWebClient({ api, eventTarget, documentTarget });
    t.after(() => web.dispose()); return { api, web };
  };
  const first = create(); first.api.saveSession(session, false);
  return { ...first, storage, member, create, requests, operations, loseResponse: () => { loseResponse = true; } };
}

test('online cashier reopens its saved session, reloads the server ledger and never persists account data', async t => {
  const { web, create, storage, member, requests } = fixture(t);
  await web.sync();
  const reopened = create();
  assert.equal(reopened.web.snapshot().user.id, user.id);
  assert.equal(reopened.web.getDb().getMembers().length, 0);
  await reopened.web.sync();
  assert.equal(reopened.web.getDb().getMemberById(member.id).balance, 10000);
  for (const key of Object.values(STORAGE_KEYS)) assert.equal(storage.getItem(key), null);
  assert.equal([...storage.values.values()].some(value => value.includes('服务器会员')), false);
  assert.deepEqual(requests, ['/api/v1/account', '/api/v1/account']);
});

test('a lost cashier response keeps the original request across reopening and confirms it only once', async t => {
  const { web, api, create, storage, member, operations, loseResponse } = fixture(t);
  await web.sync(); loseResponse();
  await assert.rejects(web.getDb().recharge({ memberId: member.id, actualPay: 100, giftAmount: 0, payMethod: '现金' }), /response lost/);
  assert.equal(web.getDb().getMemberById(member.id).balance, 10000);
  const original = JSON.parse(storage.getItem(api.scopedKey('pending'))).operations[0];
  assert.equal(operations.size, 1);
  const reopened = create(); await reopened.web.sync();
  assert.equal(reopened.web.getDb().getMemberById(member.id).balance, 20000);
  await assert.rejects(reopened.web.getDb().recharge({ memberId: member.id, actualPay: 100 }), /上一笔/);
  await reopened.web.retryPending();
  assert.equal(operations.size, 1);
  assert.ok(operations.has(original.id));
  assert.equal(storage.getItem(api.scopedKey('pending')), null);
  assert.equal(reopened.web.getDb().getMemberById(member.id).balance, 20000);
});

test('cashier and admin clients can load concurrently and reject stale financial preconditions', async t => {
  const { web, api, create, member } = fixture(t);
  const other = create(); await Promise.all([web.sync(), other.web.sync()]);
  assert.equal(other.api.deviceId, api.deviceId);
  await other.web.getDb().consume({ memberId: member.id, amount: 38, itemsSummary: '剪发' });
  await assert.rejects(web.getDb().consume({ memberId: member.id, amount: 38, itemsSummary: '剪发' }), /其他设备修改/);
  assert.equal(web.snapshot().pending, false);
  await web.sync();
  assert.equal(web.getDb().getMemberById(member.id).balance, 6200);
  assert.equal(other.web.getDb().getMemberById(member.id).balance, 6200);
});

test('an acknowledged write retains its ID when newer-tab account confirmation is rate limited', async t => {
  const { api, member, storage } = fixture(t);
  await api.getAccount();
  const originalFetch = api.requestFetch;
  api.requestFetch = async (path, options) => {
    if (path === '/api/v1/account') return Response.json({ error: 'rate limited' }, { status: 429, headers: { 'Retry-After': '1' } });
    const response = await originalFetch(path, options);
    if (path === '/api/v1/sync') storage.setItem(api.headKey(), JSON.stringify({ revision: 3, integrity: 'a'.repeat(64) }));
    return response;
  };
  const operation = buildAdminOperation('recharge', [{ memberId: member.id, actualPay: 100 }], api.accountData.value, api.identity());
  await assert.rejects(api.sync([operation]), error => error.status === 429);
  const pending = JSON.parse(storage.getItem(api.scopedKey('pending')));
  assert.equal(pending.operations[0].id, operation.id);
  assert.equal(pending.uncertain, true);
});

test('cashier auto-locks at the idle deadline without waiting for the periodic ledger refresh', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { create } = fixture(t);
  const target = new EventTarget(), { api, web } = create(target);
  await web.start();
  t.mock.timers.tick(ADMIN_IDLE_TIMEOUT_MS - 1);
  assert.equal(api.isLocked.value, false);
  t.mock.timers.tick(1);
  assert.equal(api.isLocked.value, true);
});

for (const event of ['focus', 'visibilitychange']) {
  test(`cashier rechecks expiry on ${event} before activity can renew a suspended session`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const { create, requests } = fixture(t);
    const target = new EventTarget(), documentTarget = new EventTarget();
    documentTarget.visibilityState = 'visible';
    const { api, web } = create(target, documentTarget);
    await web.start();
    const loaded = requests.length, deadline = api.idleExpiresAt.value;
    t.mock.timers.setTime(deadline);
    (event === 'focus' ? target : documentTarget).dispatchEvent(new Event(event));
    assert.equal(api.isLocked.value, true);
    target.dispatchEvent(new Event('pointerdown'));
    assert.equal(api.isLocked.value, true);
    assert.equal(api.idleExpiresAt.value, deadline);
    assert.equal(requests.length, loaded);
  });
}

test('cashier activity reschedules the deadline, repeated start reuses listeners, and stop removes them', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { create } = fixture(t);
  const target = new EventTarget(), documentTarget = new EventTarget();
  const { api, web } = create(target, documentTarget);
  const stop = await web.start();
  assert.equal(await web.start(), stop);
  const activity = t.mock.method(api, 'recordActivity');
  const restore = t.mock.method(api, 'restoreSession');
  t.mock.timers.tick(60000);
  target.dispatchEvent(new Event('pointerdown'));
  assert.equal(activity.mock.callCount(), 1);
  t.mock.timers.tick(ADMIN_IDLE_TIMEOUT_MS - 60000);
  assert.equal(api.isLocked.value, false);
  t.mock.timers.tick(60000);
  assert.equal(api.isLocked.value, true);
  await api.saveSession(session, false, { resetIdle: true });
  stop();
  const reads = restore.mock.callCount();
  t.mock.timers.tick(ADMIN_IDLE_TIMEOUT_MS);
  target.dispatchEvent(new Event('focus'));
  documentTarget.dispatchEvent(new Event('visibilitychange'));
  target.dispatchEvent(new Event('keydown'));
  assert.equal(activity.mock.callCount(), 1);
  assert.equal(restore.mock.callCount(), reads);
});

test('stopping during the initial ledger request cannot recreate a lock timer or stop a later start', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { create } = fixture(t), target = new EventTarget();
  const { api, web } = create(target);
  let resolve;
  api.requestFetch = () => new Promise(done => { resolve = done; });
  const starting = web.start();
  const stopFirst = await web.start();
  stopFirst();
  const restarting = web.start();
  resolve(Response.json({ data: { members: [], ledgers: [], services: [], rechargePlans: [] }, revision: 1, integrity: integrity({ members: [], ledgers: [], services: [], rechargePlans: [] }) }));
  const [stopped, stopSecond] = await Promise.all([starting, restarting]);
  assert.equal(stopped, stopFirst);
  assert.notEqual(stopSecond, stopFirst);
  stopFirst();
  t.mock.timers.tick(ADMIN_IDLE_TIMEOUT_MS);
  assert.equal(api.isLocked.value, true);
  stopSecond();
});

test('cross-tab activity and token updates do not reload the ledger, while head changes and unlocks do', { timeout: 10000 }, async t => {
  const { create, storage, requests } = fixture(t);
  const target = new EventTarget();
  const { api, web } = create(target);
  await web.start();
  const loaded = requests.length;
  const dispatch = (key, oldValue) => target.dispatchEvent(Object.assign(new Event('storage'), { key, oldValue }));
  const saved = storage.getItem(ADMIN_SESSION_KEY);
  for (let i = 0; i < 200; i++) {
    dispatch(ADMIN_SESSION_KEY, saved);
    dispatch('unrelated-key', null);
    dispatch(api.scopedKey('pending'), null);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, loaded);
  const waitForSync = async action => {
    const finished = new Promise(resolve => {
      let started = false;
      const stop = web.subscribe(state => { if (state.busy) started = true; else if (started) { stop(); resolve(); } });
    });
    action(); await finished;
  };
  await waitForSync(() => dispatch(api.headKey(), null));
  assert.equal(requests.length, loaded + 1);
  await waitForSync(() => dispatch(ADMIN_SESSION_KEY, JSON.stringify({ ...JSON.parse(saved), isLocked: true })));
  assert.equal(requests.length, loaded + 2);
});
