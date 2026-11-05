import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../database.js';
import { createService } from '../service.js';
import { createApi, defaultAllowedOrigins } from '../http.js';
import { createLocalDb } from '../../src/storage.js';
import { validateImportBatch } from '../../admin/src/utils/importer.js';

class MemoryStorage {
  values = new Map(); failPending = false;
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.failPending && key.includes('_pending:')) throw new Error('quota exceeded'); this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
globalThis.localStorage = new MemoryStorage();
const { AdminApiClient, buildAdminOperation } = await import('../../admin/src/api/client.js');
let db, pool, service, server, url, client, storage, identity;
const password = 'Correct-Horse-Admin-2026!';
const mapping = { name: 0, phone: 1, balance: 2, gift: 3, remark: null, tag: null };
before(async () => {
  db = new PGlite(); let tail = Promise.resolve();
  pool = {
    async connect() {
      const previous = tail; let release;
      tail = new Promise(resolve => { release = resolve; }); await previous;
      return { query: (sql, parameters) => parameters ? db.query(sql, parameters) : sql.includes(';') ? db.exec(sql) : db.query(sql), release };
    },
    async query(sql, parameters) { const connection = await this.connect(); try { return await connection.query(sql, parameters); } finally { connection.release(); } }
  };
  await migrate(pool); service = createService(pool); server = createApi({ service, pool });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); url = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.close(); });
const newClient = (saved, requestFetch = fetch) => new AdminApiClient({ storage: saved, eventTarget: null, fetch: (path, options) => requestFetch(url + path, options) });
beforeEach(async () => {
  await pool.query('TRUNCATE stores,login_limits,releases RESTART IDENTITY CASCADE');
  await service.createOwner({ username: 'owner', password });
  storage = new MemoryStorage(); client = newClient(storage); await client.login('owner', password);
  identity = await service.authenticate(client.accessToken.value);
});

async function seed(count = 1, initialBalance = 100) {
  const local = createLocalDb(new MemoryStorage()); local.init();
  for (let i = 0; i < count; i++) local.createMember({ name: '客户' + i, phone: String(13800000000 + i), initialBalance });
  await service.bootstrap(identity, { id: randomUUID(), data: local.readBackupState() });
  await client.getAccount(); return client.accountData.value;
}
function recharge(data, target = data.members[0], amount = 50) {
  return buildAdminOperation('recharge', [{ memberId: target.id, actualPay: amount }], data, client.identity());
}

test('a committed recharge with a lost response survives reload and retries its original ID exactly once', async () => {
  const data = await seed(), op = recharge(data); let lose = true;
  client.requestFetch = async (path, options) => {
    const response = await fetch(url + path, options);
    if (path === '/api/v1/sync' && lose) { lose = false; await response.clone().json(); throw new Error('lost acknowledgment'); }
    return response;
  };
  await assert.rejects(client.sync([op]), /lost acknowledgment/);
  assert.equal(client.hasPending.value, true);
  const restored = newClient(storage);
  await restored.getAccount(); assert.equal(restored.accountData.value.members[0].balance, 15000);
  await assert.rejects(restored.sync([recharge(restored.accountData.value)]), /待确认操作/);
  await restored.retryPending();
  assert.equal(restored.accountData.value.members[0].balance, 15000);
  assert.equal(restored.hasPending.value, false);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM operations WHERE method='recharge'")).rows[0].count, 1);
});

for (const status of [429, 403, 409]) {
  test(`a reload before recharge response handling retains its original ID after retry rejection ${status}`, async () => {
    const data = await seed(), op = recharge(data);
    let restoredStorage;
    client.requestFetch = async (path, options) => {
      const response = await fetch(url + path, options);
      await response.clone().json();
      // Capture the durable state before the disappearing page can handle a response/error.
      const saved = JSON.parse(storage.getItem(client.scopedKey('pending')));
      assert.equal(saved.uncertain, true);
      restoredStorage = new MemoryStorage(); restoredStorage.values = new Map(storage.values);
      // Upgrades must also retain older pending records interrupted with uncertain:false.
      if (status === 429) restoredStorage.setItem(client.scopedKey('pending'), JSON.stringify({ ...saved, uncertain: false }));
      throw new Error('page destroyed before response handling');
    };
    await assert.rejects(client.sync([op]), /page destroyed/);
    let rejectRetry = true;
    const restored = newClient(restoredStorage, async (path, options) => {
      if (path.endsWith('/sync') && rejectRetry) return new Response(JSON.stringify({ error: 'retry rejected' }), { status });
      return fetch(path, options);
    });
    await restored.getAccount();
    assert.equal(restored.accountData.value.members[0].balance, 15000);
    await assert.rejects(restored.retryPending(), { status });
    assert.equal(restored.hasPending.value, true);
    assert.equal(JSON.parse(restoredStorage.getItem(restored.scopedKey('pending'))).operations[0].id, op.id);
    await assert.rejects(restored.sync([recharge(restored.accountData.value)]), /待确认操作/);
    rejectRetry = false;
    await restored.retryPending();
    assert.equal(restored.hasPending.value, false);
    assert.equal(restored.accountData.value.members[0].balance, 15000);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM operations WHERE method='recharge'")).rows[0].count, 1);
  });
}

test('batch progress and the unacknowledged final chunk survive refresh without repeating earlier credits', async () => {
  const data = await seed(51);
  const items = validateImportBatch(data.members.map(member => [member.name, member.phone, '50', '0']), mapping, data.members, { conflictStrategy: 'merge_balance' }).results;
  let writes = 0;
  client.requestFetch = async (path, options) => {
    const response = await fetch(url + path, options);
    if (path === '/api/v1/sync' && ++writes === 2) { await response.clone().json(); throw new Error('lost second chunk'); }
    return response;
  };
  await assert.rejects(client.executeBatchImport(items, 'merge_balance'), /lost second chunk/);
  assert.equal(client.pendingImport.value.count, 50);
  const restored = newClient(storage); await restored.getAccount();
  await assert.rejects(restored.executeBatchImport([{ ...items[0], data: { ...items[0].data, balanceCents: 100 } }], 'merge_balance'), /原任务/);
  const result = await restored.resumeBatchImport(); assert.equal(result.count, 51);
  assert.ok(restored.accountData.value.members.every(member => member.balance === 15000));
  await restored.executeBatchImport(items, 'merge_balance');
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM operations WHERE method='recharge'")).rows[0].count, 51);
});

test('new and existing debts require confirmation and produce consistent immutable opening debt ledgers', async () => {
  const data = await seed(1, 0);
  const rows = [[data.members[0].name, data.members[0].phone, '-25.01', '0'], ['新欠款客户', '13900001111', '-100.01', '0']];
  const items = validateImportBatch(rows, mapping, data.members, { conflictStrategy: 'merge_balance' }).results;
  await assert.rejects(client.executeBatchImport(items, 'merge_balance'), /确认期初欠款/);
  assert.equal((await service.account(identity)).data.ledgers.length, 0);
  const result = await client.executeBatchImport(items, 'merge_balance', () => {}, { allowDebt: true });
  assert.equal(result.count, 2);
  const next = client.accountData.value;
  assert.deepEqual(next.members.map(member => member.balance).sort((a, b) => a - b), [-10001, -2501]);
  assert.equal(next.ledgers.length, 2);
  assert.ok(next.ledgers.every(ledger => ledger.type === 'CONSUME' && ledger.remark.includes('期初导入欠款')));
});

test('import money remains exact at the safe integer boundary', async () => {
  await seed(1, 0);
  const items = validateImportBatch([['大额客户', '13900002222', '90071992547409.91', '0']], mapping).results;
  await client.executeBatchImport(items, 'skip');
  assert.equal(client.accountData.value.members.find(member => member.phone === '13900002222').balance, Number.MAX_SAFE_INTEGER);
});

test('failed durable storage prevents all financial network requests', async () => {
  const data = await seed(); let requests = 0;
  client.requestFetch = async () => { requests++; throw new Error('unexpected request'); };
  storage.failPending = true;
  await assert.rejects(client.sync([recharge(data)]), /quota exceeded/);
  assert.equal(requests, 0); assert.equal((await service.account(identity)).data.members[0].balance, 10000);
});

test('a corrupt acknowledgment retains the original operation until a valid retry is confirmed', async () => {
  const data = await seed(); let corrupt = true;
  client.requestFetch = async (path, options) => {
    const response = await fetch(url + path, options);
    if (path === '/api/v1/sync' && corrupt) {
      corrupt = false; const result = await response.json(); result.integrity = 'bad'; return new Response(JSON.stringify(result), { status: 200 });
    }
    return response;
  };
  await assert.rejects(client.sync([recharge(data)]), /校验失败/);
  assert.equal(client.accountStatus.value, 'error'); assert.equal(client.hasPending.value, true);
  await client.retryPending(); assert.equal(client.accountData.value.members[0].balance, 15000);
});

test('two tabs refresh shared credentials under one lock without triggering refresh replay revocation', async () => {
  await seed(); const other = newClient(storage); let rotations = 0;
  const transport = async (path, options) => { if (path === '/api/v1/auth/refresh') rotations++; return fetch(url + path, options); };
  client.requestFetch = transport; other.requestFetch = transport;
  assert.deepEqual(await Promise.all([client.refresh(), other.refresh()]), [true, true]);
  assert.equal(rotations, 1);
  assert.equal(client.accessToken.value, other.accessToken.value);
  await service.authenticate(client.accessToken.value);
});

test('logout with expired access credentials revokes the live refresh session and clears the cached account immediately', async () => {
  await seed(); const refresh = client.refreshToken.value;
  await pool.query("UPDATE sessions SET access_expires_at=now()-interval '1 second' WHERE id=$1", [identity.sessionId]);
  await client.logout();
  assert.equal(client.user.value, null); assert.equal(client.accountData.value, null);
  await assert.rejects(service.refresh(refresh), { status: 401 });
});

test('old account responses cannot populate the cache after signing into a different store', async () => {
  await seed(); let started, release;
  const startedPromise = new Promise(resolve => { started = resolve; }), barrier = new Promise(resolve => { release = resolve; });
  client.requestFetch = async (path, options) => { const response = await fetch(url + path, options); started(); await barrier; return response; };
  const pending = client.getAccount(); await startedPromise;
  await service.createOwner({ username: 'other', password });
  const other = await service.login({ username: 'other', password, deviceId: client.deviceId }, '127.0.0.1');
  client.clearSession(); client.saveSession(other); release();
  await assert.rejects(pending, { code: 'SESSION_CHANGED' });
  assert.equal(client.accountData.value, null); assert.equal(client.accountRevision.value, 0);
  assert.equal(client.user.value.storeId, other.user.storeId);
});

test('a temporary refresh network failure retains credentials and never reports a synchronized account', async () => {
  await seed(); const refresh = client.refreshToken.value;
  await pool.query("UPDATE sessions SET access_expires_at=now()-interval '1 second' WHERE id=$1", [identity.sessionId]);
  client.requestFetch = async (path, options) => { if (path === '/api/v1/auth/refresh') throw new Error('offline'); return fetch(url + path, options); };
  await assert.rejects(client.getAccount(), /offline/);
  assert.equal(client.refreshToken.value, refresh); assert.equal(client.accountStatus.value, 'error');
});

test('audit browsing paginates and full export traverses every store-scoped row beyond 100 records', async () => {
  await pool.query("INSERT INTO audit_events(store_id,event) SELECT $1,'online' FROM generate_series(1,1101)", [identity.store_id]);
  const total = (await pool.query('SELECT count(*)::int AS count FROM audit_events WHERE store_id=$1', [identity.store_id])).rows[0].count;
  const first = await client.getActivity(); assert.equal(first.length, 100);
  const second = await client.getActivity({ before: first.at(-1).id });
  assert.equal(second.length, 100); assert.ok(BigInt(second[0].id) < BigInt(first.at(-1).id));
  const all = await client.getAllActivity(); assert.equal(all.length, total); assert.equal(new Set(all.map(row => String(row.id))).size, total);
  await assert.rejects(client.getActivity({ before: '-1' }), { status: 400 });
  await assert.rejects(client.getActivity({ limit: 501 }), { status: 400 });
});

test('development login allows documented localhost ports while production and unrelated origins stay restricted', async () => {
  assert.deepEqual(defaultAllowedOrigins(true), ['https://localhost']);
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5174' },
    body: JSON.stringify({ username: 'owner', password, deviceId: client.deviceId }) };
  const allowed = await fetch(url + '/api/v1/auth/login', options); assert.equal(allowed.status, 200);
  const forbidden = await fetch(url + '/api/v1/auth/login', { ...options, headers: { ...options.headers, Origin: 'https://unrelated.example' } });
  assert.equal(forbidden.status, 403);
});

test('a confirmed stale import can cancel only uncommitted work while an uncertain import cannot be cancelled', async () => {
  const data = await seed();
  const items = validateImportBatch([[data.members[0].name, data.members[0].phone, '50', '0']], mapping, data.members, { conflictStrategy: 'merge_balance' }).results;
  await service.sync(identity, [recharge(data, data.members[0], 10)]);
  await assert.rejects(client.executeBatchImport(items, 'merge_balance'), { status: 409 });
  assert.equal(client.pendingImport.value.canCancel, true);
  await client.cancelRemainingImport(); assert.equal(client.hasPending.value, false);
  assert.equal((await service.account(identity)).data.members[0].balance, 11000);
  await client.getAccount();
  client.requestFetch = async (path, options) => {
    const response = await fetch(url + path, options);
    if (path === '/api/v1/sync') { await response.clone().json(); throw new Error('lost response'); }
    return response;
  };
  await assert.rejects(client.executeBatchImport(items, 'merge_balance'), /lost response/);
  await assert.rejects(client.cancelRemainingImport(), /尚未确认/);
});

test('full audit export retries the same cursor after rate limiting instead of truncating the export', async () => {
  let calls = 0;
  client.getActivity = async ({ before }) => {
    calls++;
    if (calls === 1) return Array.from({ length: 500 }, (_, index) => ({ id: String(1000 - index) }));
    assert.equal(before, '501');
    if (calls === 2) throw Object.assign(new Error('rate limit'), { status: 429, retryAfter: 0.001 });
    return [{ id: '500' }, { id: '499' }];
  };
  const all = await client.getAllActivity(); assert.equal(all.length, 502); assert.equal(calls, 3);
});
