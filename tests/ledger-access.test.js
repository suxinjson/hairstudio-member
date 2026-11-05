import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerPage, configureLedgerAccess } from '../src/ledger-access.js';
import { createLocalDb, localDb, STORAGE_KEYS, configureCloudWrites } from '../src/storage.js';
import { createCloudClient } from '../src/cloud-client.js';
import { getCloudState } from '../src/cloud-storage.js';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('a competing database cannot recover a live journal and erase a successful recharge', () => {
  const storage = new MemoryStorage(), first = createLocalDb(storage), second = createLocalDb(storage);
  first.init();
  const member = first.createMember({ name: '客户', phone: '13800001111', initialBalance: 100 });
  const remove = storage.removeItem.bind(storage); let observed = false;
  storage.removeItem = key => {
    if (key === 'hairstudio_pending_write_v1' && !observed) {
      observed = true;
      assert.throws(() => second.getMembers(), { code: 'LEDGER_BUSY' });
      assert.throws(() => second.recharge({ memberId: member.id, actualPay: 10 }), { code: 'LEDGER_BUSY' });
    }
    remove(key);
  };
  first.recharge({ memberId: member.id, actualPay: 50 });
  assert.equal(observed, true);
  assert.equal(second.readBackupState().members[0].balance, 15000);
  assert.equal(second.readBackupState().ledgers.length, 2);
});

test('two pages serialize storage, release on pagehide, and reacquire after pageshow', async () => {
  let tail = Promise.resolve();
  const locks = { request(name, { signal }, callback) {
    const result = tail.then(() => { if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); return callback(); });
    tail = result.catch(() => {}); return result;
  } };
  const eventsA = new EventTarget(), eventsB = new EventTarget();
  const storage = new MemoryStorage(), database = createLocalDb(storage);
  database.init();
  const member = database.createMember({ name: '客户', phone: '13800001111', initialBalance: 100 });
  const acquired = [], released = [];
  const first = createLedgerPage({ locks, eventTarget: eventsA, onAcquire: () => acquired.push('A'), onRelease: () => released.push('A') });
  const second = createLedgerPage({ locks, eventTarget: eventsB, onAcquire: () => {
    acquired.push('B'); assert.equal(database.getMemberById(member.id).balance, 15000);
  } });
  try {
    first.start(); second.start(); await tick();
    assert.deepEqual(acquired, ['A']); assert.equal(second.hasAccess(), false);
    database.recharge({ memberId: member.id, actualPay: 50 });
    eventsA.dispatchEvent(new Event('pagehide')); await tick();
    assert.deepEqual(acquired, ['A', 'B']); assert.equal(first.hasAccess(), false);
    eventsA.dispatchEvent(new Event('pageshow')); await tick();
    assert.deepEqual(acquired, ['A', 'B']);
    second.dispose(); await tick();
    assert.deepEqual(acquired, ['A', 'B', 'A']); assert.equal(first.hasAccess(), true);
    assert.deepEqual(released, ['A']);
  } finally { first.dispose(); second.dispose(); await tick(); }
});

test('a page without browser locks never opens or recovers the ledger', () => {
  let acquired = false, error;
  const page = createLedgerPage({ locks: null, eventTarget: null, onAcquire: () => { acquired = true; }, onError: value => { error = value; } });
  page.start();
  assert.equal(acquired, false); assert.equal(page.hasAccess(), false);
  assert.match(error.message, /浏览器/); page.dispose();
});

test('stale network responses cannot restore a session after another page takes over', async () => {
  globalThis.localStorage = new MemoryStorage(); localDb.init();
  let complete, started;
  const entered = new Promise(resolve => { started = resolve; });
  const response = new Promise(resolve => { complete = resolve; });
  const client = createCloudClient({ fetch: async () => { started(); return response; } });
  configureLedgerAccess(() => true);
  try {
    const pending = client.login('http://localhost', 'owner', 'test-password');
    await entered;
    configureLedgerAccess(() => false);
    assert.throws(() => localDb.getMembers(), { code: 'LEDGER_BUSY' });
    assert.throws(() => getCloudState(), { code: 'LEDGER_BUSY' });
    configureLedgerAccess(() => true);
    complete(new Response(JSON.stringify({ accessToken: 'access', refreshToken: 'refresh', user: { id: 'owner', storeId: 'store', role: 'owner' } }), { status: 200 }));
    await assert.rejects(pending);
    assert.equal(getCloudState().user, null);
    assert.deepEqual(JSON.parse(localStorage.getItem(STORAGE_KEYS.MEMBERS)), []);
  } finally { configureLedgerAccess(null); }
});

test('a late old-page disposer cannot disable the new page recording hook', () => {
  globalThis.localStorage = new MemoryStorage(); localDb.init();
  const member = localDb.createMember({ name: '客户', phone: '13800001111', initialBalance: 100 });
  let oldWrites = 0, newWrites = 0;
  const stopOld = configureCloudWrites(entries => { oldWrites++; return entries; });
  const stopNew = configureCloudWrites(entries => { newWrites++; return entries; });
  try {
    stopOld();
    localDb.recharge({ memberId: member.id, actualPay: 50 });
    assert.equal(oldWrites, 0); assert.equal(newWrites, 1);
    assert.equal(localDb.getMemberById(member.id).balance, 15000);
  } finally { stopNew(); }
});
