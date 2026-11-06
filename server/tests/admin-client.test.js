import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../database.js';
import { createService } from '../service.js';
import { createApi, defaultAllowedOrigins } from '../http.js';
import { createLocalDb } from '../../src/storage.js';
import { validateImportBatch } from '../../admin/src/utils/importer.js';
import { integrity } from '../security.js';

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
const newClient = (saved, requestFetch = fetch) => new AdminApiClient({ storage: saved, eventTarget: null, serverOrigin: url, fetch: (path, options) => requestFetch(url + path, options) });
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

test('the retained legacy completed task is archived before a new import replaces it', async () => {
  const data = await seed();
  const items = amount => validateImportBatch([[data.members[0].name, data.members[0].phone, String(amount), '0']], mapping, data.members, { conflictStrategy: 'merge_balance' }).results;
  const first = items(50), plan = client.planImport(first, 'merge_balance', false);
  await service.sync(identity, plan.batches[0].operations);
  const signature = integrity({ strategy: 'merge_balance', rows: first.map(item => item.data) });
  storage.setItem(client.scopedKey('import'), JSON.stringify({ id: randomUUID(), signature, status: 'complete', count: 1, total: 1 }));
  await client.getAccount();
  await client.executeBatchImport(items(20), 'merge_balance');
  const restored = newClient(storage); await restored.getAccount();
  assert.equal((await restored.executeBatchImport(first, 'merge_balance')).resumed, true);
  assert.equal(restored.accountData.value.members[0].balance, 17000);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM operations WHERE method='recharge'")).rows[0].count, 2);
  restored.dispose();
});

for (const interrupted of ['old uncertain batch', 'receipt migration', 'resolved receipt migration']) {
  test(`legacy import upgrade survives ${interrupted} without replaying money`, async () => {
    const data = await seed(101);
    const items = validateImportBatch(data.members.map(m => [m.name, m.phone, '50', '0']), mapping, data.members, { conflictStrategy: 'merge_balance' }).results;
    const plan = client.planImport(items, 'merge_balance', false);
    const job = { id: randomUUID(), signature: integrity({ strategy: 'merge_balance', rows: items.map(item => item.data) }),
      status: 'pending', cursor: 2, count: 100, ...plan };
    for (let index = 0; index < 2; index++) await service.sync(identity, job.batches[index].operations);
    storage.setItem(client.scopedKey('import'), JSON.stringify(job));
    if (interrupted === 'old uncertain batch') {
      await service.sync(identity, job.batches[2].operations);
      storage.setItem(client.scopedKey('pending'), JSON.stringify({ operations: job.batches[2].operations, uncertain: false }));
    } else {
      let receipts = 0;
      client.requestFetch = async (path, options) => {
        const response = await fetch(url + path, options);
        if (path === '/api/v1/sync' && ++receipts === 2) { await response.clone().json(); throw new Error('lost receipt migration'); }
        return response;
      };
      await assert.rejects(client.resumeBatchImport(), /lost receipt migration/);
      assert.equal(JSON.parse(storage.getItem(client.scopedKey('import'))).receiptCursor, 1);
    }
    const restored = newClient(storage); await restored.getAccount();
    if (interrupted === 'resolved receipt migration') {
      await restored.resolvePending();
      const progress = JSON.parse(storage.getItem(restored.scopedKey('import')));
      assert.equal(progress.cursor, 2); assert.equal(progress.count, 100);
    }
    assert.equal((await restored.resumeBatchImport()).count, 101);
    assert.ok(restored.accountData.value.members.every(m => m.balance === 15000));
    assert.equal((await service.importStatus(identity, job.signature)).status, 'complete');
    const device = newClient(new MemoryStorage()); await device.login('owner', password); await device.getAccount();
    assert.equal((await device.executeBatchImport(items, 'merge_balance')).resumed, true);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM operations WHERE method='recharge'")).rows[0].count, 101);
    restored.dispose(); device.dispose();
  });
}

test('admin can load and repair several legacy phone conflicts without changing balances or history', async () => {
  const data = JSON.parse(JSON.stringify(await seed(4)));
  data.members[1].phone = data.members[0].phone.slice(0, 3) + ' ' + data.members[0].phone.slice(3);
  data.members[3].phone = data.members[2].phone.slice(0, 3) + '-' + data.members[2].phone.slice(3);
  await pool.query('UPDATE accounts SET data=$1,integrity=$2,revision=revision+1 WHERE store_id=$3', [data, integrity(data), identity.store_id]);
  await client.getAccount();
  assert.deepEqual(client.accountData.value, data);
  assert.throws(() => buildAdminOperation('recharge', [{ memberId: data.members[0].id, actualPay: 10 }], data, client.identity()), /会员单号/);
  for (const index of [1, 3]) await client.sync([buildAdminOperation('updateMember', [data.members[index].id, { phone: String(13900000000 + index) }], client.accountData.value, client.identity())]);
  assert.deepEqual(client.accountData.value.ledgers, data.ledgers);
  assert.ok(client.accountData.value.members.every(m => m.balance === 10000));
  await client.sync([buildAdminOperation('recharge', [{ memberId: data.members[0].id, actualPay: 10 }], client.accountData.value, client.identity())]);
  assert.equal(client.accountData.value.members.find(m => m.id === data.members[0].id).balance, 11000);
});

test('A-B-A imports stay deduplicated across history, reload, fresh devices and other store writers', async () => {
  await seed();
  const items = amount => validateImportBatch([['客户0', '13800000000', String(amount), '0']], mapping, client.accountData.value.members, { conflictStrategy: 'merge_balance' }).results;
  await client.executeBatchImport(items(50), 'merge_balance');
  await client.executeBatchImport(items(20), 'merge_balance');
  assert.equal((await client.executeBatchImport(items(50), 'merge_balance')).resumed, true);
  assert.equal(client.accountData.value.members[0].balance, 17000);
  const reload = newClient(storage); await reload.getAccount();
  assert.equal((await reload.executeBatchImport(items(50), 'merge_balance')).resumed, true);
  const device = newClient(new MemoryStorage()); await device.login('owner', password); await device.getAccount();
  assert.equal((await device.executeBatchImport(items(50), 'merge_balance')).resumed, true);
  await service.createUser(identity, { username: 'cashier', displayName: '店员', password, role: 'clerk' });
  const cashier = newClient(new MemoryStorage()); await cashier.login('cashier', password); await cashier.getAccount();
  assert.equal((await cashier.executeBatchImport(items(50), 'merge_balance')).resumed, true);
  assert.equal(cashier.accountData.value.members[0].balance, 17000);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM operations WHERE method='recharge'")).rows[0].count, 2);
  reload.dispose(); device.dispose(); cashier.dispose();
});

test('a stale absent-task check cannot duplicate an import committed by another device', async () => {
  const data = await seed();
  const items = validateImportBatch([[data.members[0].name, data.members[0].phone, '50', '0']], mapping, data.members, { conflictStrategy: 'merge_balance' }).results;
  await client.executeBatchImport(items, 'merge_balance');
  const other = newClient(new MemoryStorage(), (path, options) => {
    if (new URL(path).pathname.startsWith('/api/v1/imports/')) return Promise.resolve(new Response(JSON.stringify({ signature: new URL(path).pathname.split('/').at(-1), status: 'absent', count: 0 })));
    return fetch(path, options);
  });
  await other.login('owner', password); await other.getAccount();
  await other.executeBatchImport(items, 'merge_balance');
  assert.equal(other.accountData.value.members[0].balance, 15000);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM operations WHERE method='recharge'")).rows[0].count, 1);
  other.dispose();
});

test('failed completion-history persistence retains progress and can finish without recharging', async () => {
  const data = await seed(), set = storage.setItem.bind(storage);
  let fail = true;
  storage.setItem = (key, value) => { if (key.includes('_import_history:') && fail) { fail = false; throw new Error('history quota exceeded'); } set(key, value); };
  const items = validateImportBatch([[data.members[0].name, data.members[0].phone, '50', '0']], mapping, data.members, { conflictStrategy: 'merge_balance' }).results;
  await assert.rejects(client.executeBatchImport(items, 'merge_balance'), /history quota/);
  assert.equal(client.hasPending.value, true);
  const reload = newClient(storage); await reload.resumeBatchImport();
  assert.equal(reload.hasPending.value, false); assert.equal(reload.accountData.value, null);
  await reload.getAccount(); assert.equal(reload.accountData.value.members[0].balance, 15000);
  await reload.executeBatchImport(items, 'merge_balance');
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM operations WHERE method='recharge'")).rows[0].count, 1);
  reload.dispose();
});

test('partially cancelled imports block a full restart on every device while remaining rows may be imported', async () => {
  const data = await seed(51);
  const items = validateImportBatch(data.members.map(member => [member.name, member.phone, '50', '0']), mapping, data.members, { conflictStrategy: 'merge_balance' }).results;
  let batches = 0;
  client.requestFetch = (path, options) => {
    if (path === '/api/v1/sync' && ++batches === 2) return Promise.resolve(new Response(JSON.stringify({ error: 'stale batch', code: 'SYNC_CONFLICT' }), { status: 409 }));
    return fetch(url + path, options);
  };
  await assert.rejects(client.executeBatchImport(items, 'merge_balance'), { status: 409 });
  assert.equal(client.pendingImport.value.count, 50);
  await client.cancelRemainingImport();
  await assert.rejects(client.executeBatchImport(items, 'merge_balance'), /部分入库/);
  const other = newClient(new MemoryStorage()); await other.login('owner', password); await other.getAccount();
  await assert.rejects(other.executeBatchImport(items, 'merge_balance'), /部分导入/);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM operations WHERE method='recharge'")).rows[0].count, 50);
  await other.executeBatchImport(items.slice(50), 'merge_balance');
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM operations WHERE method='recharge'")).rows[0].count, 51);
  other.dispose();
});

test('import receipt failures roll back accounting and receipts reject altered batches and viewers', async () => {
  const data = await seed(), op = recharge(data), signature = 'e'.repeat(64);
  const meta = { signature, taskId: randomUUID(), batchIndex: 0, totalBatches: 1, total: 2, count: 1 };
  await assert.rejects(service.sync(identity, [op], meta), { status: 400 });
  assert.equal((await service.account(identity)).data.members[0].balance, 10000);
  assert.equal((await service.importStatus(identity, signature)).status, 'absent');
  meta.total = 1;
  await service.sync(identity, [op], meta);
  assert.equal((await service.importStatus(identity, signature)).status, 'complete');
  await assert.rejects(service.sync(identity, [{ ...op, args: [{ ...op.args[0], actualPay: 60 }] }], meta), { status: 409 });
  await service.createUser(identity, { username: 'reader', displayName: '只读', password, role: 'viewer' });
  const session = await service.login({ username: 'reader', password, deviceId: randomUUID() }, '127.0.0.1');
  await assert.rejects(service.importStatus(await service.authenticate(session.accessToken), signature), { status: 403 });
  assert.equal((await service.account(identity)).data.members[0].balance, 15000);
});
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
      if (path !== '/api/v1/sync') return response;
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
  await assert.rejects(client.sync([recharge(data)]), { code: 'CLOUD_INTEGRITY_CONFLICT' });
  assert.equal(client.accountStatus.value, 'error'); assert.equal(client.hasPending.value, true);
  await assert.rejects(client.retryPending(), { code: 'CLOUD_INTEGRITY_CONFLICT' });
  const backup = await client.reconciliationBackup();
  await client.reconcileAccount(backup);
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

test('resolving an unreceived stale recharge cancels it durably and unblocks replacement accounting', async () => {
  const data = await seed(), op = recharge(data);
  client.requestFetch = async () => { throw new Error('request never reached server'); };
  await assert.rejects(client.sync([op]), /never reached/);
  client.requestFetch = (path, options) => fetch(url + path, options);
  const change = buildAdminOperation('consume', [{ memberId: data.members[0].id, amount: 10 }], data, client.identity());
  await service.sync(identity, [change]);
  await assert.rejects(client.retryPending(), { status: 409 });
  const resolved = await client.resolvePending();
  assert.deepEqual(resolved.resolved, [{ id: op.id, status: 'cancelled' }]);
  assert.equal(client.hasPending.value, false);
  assert.equal(client.accountData.value.members[0].balance, 9000);
  // A delayed original request can never commit after the cancellation.
  await assert.rejects(service.sync(identity, [op]), { code: 'OPERATION_CANCELLED' });
  await client.sync([recharge(client.accountData.value)]);
  assert.equal(client.accountData.value.members[0].balance, 14000);
});

test('resolution preserves committed transactions and cancels only absent operations in a mixed batch', async () => {
  const data = await seed(2), first = recharge(data, data.members[0]), second = recharge(data, data.members[1]);
  await service.sync(identity, [first]);
  client.requestFetch = async () => { throw new Error('lost request'); };
  await assert.rejects(client.sync([first, second]), /lost request/);
  client.requestFetch = (path, options) => fetch(url + path, options);
  const resolved = await client.resolvePending();
  assert.deepEqual(resolved.resolved, [{ id: first.id, status: 'committed' }, { id: second.id, status: 'cancelled' }]);
  assert.equal(client.accountData.value.members.find(m => m.id === data.members[0].id).balance, 15000);
  assert.equal(client.accountData.value.members.find(m => m.id === data.members[1].id).balance, 10000);
  assert.deepEqual((await service.resolveOperations(identity, [first, second])).resolved, resolved.resolved);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE event='operation_cancelled'")).rows[0].count, 1);
});

test('a lost resolution response survives reload and retries resolution without resending the original recharge', async () => {
  const data = await seed(), op = recharge(data); let loseSync = true, loseResolution = true;
  client.requestFetch = async (path, options) => {
    if (path === '/api/v1/sync' && loseSync) throw new Error('lost sync request');
    const response = await fetch(url + path, options);
    if (path === '/api/v1/sync/resolve' && loseResolution) { await response.clone().json(); throw new Error('lost resolution response'); }
    return response;
  };
  await assert.rejects(client.sync([op]), /lost sync/); loseSync = false;
  await assert.rejects(client.resolvePending(), /lost resolution/); loseResolution = false;
  assert.equal(JSON.parse(storage.getItem(client.scopedKey('pending'))).resolving, true);
  const paths = [], restored = newClient(storage, (path, options) => { paths.push(new URL(path).pathname); return fetch(path, options); });
  await restored.retryPending();
  assert.deepEqual(paths, ['/api/v1/sync/resolve']);
  assert.equal(restored.hasPending.value, false);
  assert.equal(restored.accountData.value.members[0].balance, 10000);
  await assert.rejects(service.sync(identity, [op]), { code: 'OPERATION_CANCELLED' });
});

test('resolution rejects foreign actors or altered original data without cancelling any operations', async () => {
  const data = await seed(), op = recharge(data);
  await assert.rejects(service.resolveOperations(identity, JSON.parse(JSON.stringify([op, { ...op, id: randomUUID(), actorId: randomUUID() }]))), { status: 403 });
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM operations WHERE id=$1', [op.id])).rows[0].count, 0);
  await service.sync(identity, [op]);
  await assert.rejects(service.resolveOperations(identity, [{ ...op, args: [{ ...op.args[0], actualPay: 60 }] }]), { status: 409 });
  assert.equal((await service.account(identity)).data.members[0].balance, 15000);
});

test('uncertain imports can be resolved then safely cancelled without resuming cancelled batch IDs', async () => {
  const data = await seed();
  const items = validateImportBatch([[data.members[0].name, data.members[0].phone, '50', '0']], mapping, data.members, { conflictStrategy: 'merge_balance' }).results;
  client.requestFetch = (path, options) => {
    if (path === '/api/v1/sync') throw new Error('lost import request');
    return fetch(url + path, options);
  };
  await assert.rejects(client.executeBatchImport(items, 'merge_balance'), /lost import/);
  client.requestFetch = (path, options) => fetch(url + path, options);
  await client.resolvePending();
  assert.equal(client.pendingImport.value.canCancel, true);
  await assert.rejects(client.resumeBatchImport(), /已取消/);
  await client.cancelRemainingImport();
  assert.equal(client.hasPending.value, false);
  assert.equal((await service.account(identity)).data.members[0].balance, 10000);
});

test('a committed import batch advances exactly once if pending removal fails during resolution', async () => {
  const data = await seed();
  const items = validateImportBatch([[data.members[0].name, data.members[0].phone, '50', '0']], mapping, data.members, { conflictStrategy: 'merge_balance' }).results;
  client.requestFetch = async (path, options) => {
    const response = await fetch(url + path, options);
    if (path === '/api/v1/sync') { await response.clone().json(); throw new Error('lost committed import response'); }
    return response;
  };
  await assert.rejects(client.executeBatchImport(items, 'merge_balance'), /lost committed/);
  const remove = storage.removeItem.bind(storage); let failRemoval = true;
  storage.removeItem = key => {
    if (key === client.scopedKey('pending') && failRemoval) { failRemoval = false; throw new Error('pending removal interrupted'); }
    remove(key);
  };
  await assert.rejects(client.resolvePending(), /interrupted/);
  const restored = newClient(storage);
  await restored.retryPending();
  const job = JSON.parse(storage.getItem(restored.scopedKey('import')));
  assert.equal(job.count, 1); assert.equal(job.cursor, 1);
  await restored.resumeBatchImport();
  assert.equal(restored.hasPending.value, false);
  assert.equal(restored.accountData.value.members[0].balance, 15000);
});

test('failed resolution persistence sends no cancellation request and keeps the original operation', async () => {
  const data = await seed(), op = recharge(data);
  client.requestFetch = async () => { throw new Error('lost request'); };
  await assert.rejects(client.sync([op]), /lost request/);
  let requests = 0;
  client.requestFetch = async () => { requests++; throw new Error('must not send'); };
  storage.failPending = true;
  await assert.rejects(client.resolvePending(), /quota exceeded/);
  assert.equal(requests, 0);
  const pending = JSON.parse(storage.getItem(client.scopedKey('pending')));
  assert.equal(pending.operations[0].id, op.id); assert.equal(pending.resolving, undefined);
});

for (const change of ['rollback', 'same-revision']) {
  test(`PC observes ${change} across reload and blocks every financial upload until owner reconciliation`, async () => {
    const data = await seed(), op = recharge(data), previous = await service.account(identity);
    const altered = JSON.parse(JSON.stringify(data)); altered.members[0].notes = '云端发生恢复';
    await pool.query('UPDATE accounts SET data=$1,integrity=$2,revision=$3 WHERE store_id=$4', [altered, integrity(altered), previous.revision - (change === 'rollback' ? 1 : 0), identity.store_id]);
    let writes = 0;
    const restored = newClient(storage, (path, options) => { if (new URL(path).pathname === '/api/v1/sync') writes++; return fetch(path, options); });
    await assert.rejects(restored.getAccount(), { code: 'CLOUD_INTEGRITY_CONFLICT' });
    await assert.rejects(restored.sync([op]), { code: 'CLOUD_INTEGRITY_CONFLICT' });
    assert.equal(writes, 0); assert.equal(restored.headConflict.value, true);
    // Restoring the server alone must not silently erase the persisted conflict.
    await pool.query('UPDATE accounts SET data=$1,integrity=$2,revision=$3 WHERE store_id=$4', [data, previous.integrity, previous.revision, identity.store_id]);
    const again = newClient(storage);
    await assert.rejects(again.getAccount(), { code: 'CLOUD_INTEGRITY_CONFLICT' });
    const backup = await again.reconciliationBackup(); await again.reconcileAccount(backup);
    await again.sync([op]); assert.equal(again.accountData.value.members[0].balance, 15000);
    restored.dispose(); again.dispose();
  });
}

test('server checks the observed revision inside the transaction when rollback happens after the PC head read', async () => {
  const data = await seed(), original = await service.account(identity);
  client.requestFetch = async (path, options) => {
    if (path === '/api/v1/sync') {
      assert.deepEqual(JSON.parse(options.body).observedHead, { revision: original.revision, integrity: original.integrity });
      await pool.query('UPDATE accounts SET revision=revision-1 WHERE store_id=$1', [identity.store_id]);
    }
    return fetch(url + path, options);
  };
  await assert.rejects(client.sync([recharge(data)]), { code: 'CLOUD_INTEGRITY_CONFLICT' });
  assert.equal((await service.account(identity)).data.members[0].balance, 10000);
  assert.equal(client.headConflict.value, true);
});

test('PC head records are scoped to server and store, and malformed stored heads fail closed', async () => {
  await seed();
  const other = new AdminApiClient({ storage, eventTarget: null, serverOrigin: 'https://other.example', fetch: (path, options) => fetch(url + path, options) });
  assert.equal(other.observedHead(), null); await other.getAccount(); assert.notEqual(other.headKey(), client.headKey());
  storage.setItem(client.headKey(), '{damaged');
  await assert.rejects(client.getAccount(), { code: 'CLOUD_INTEGRITY_CONFLICT' });
  assert.equal(client.headConflict.value, true);
  await other.getAccount(); other.dispose();
});

test('a delayed snapshot from another tab is refreshed without creating a false rollback conflict', async () => {
  const data = await seed(); let release, arrived;
  const waiting = new Promise(resolve => { release = resolve; }), received = new Promise(resolve => { arrived = resolve; });
  let first = true;
  const other = newClient(storage, async (path, options) => {
    const response = await fetch(path, options);
    if (new URL(path).pathname === '/api/v1/account' && first) { first = false; await response.clone().json(); arrived(); await waiting; }
    return response;
  });
  const loading = other.getAccount(); await received;
  await client.sync([recharge(data)]); release(); await loading;
  assert.equal(other.headConflict.value, false); assert.equal(other.accountData.value.members[0].balance, 15000);
  other.dispose();
});
