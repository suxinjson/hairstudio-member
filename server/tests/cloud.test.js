import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { migrate } from '../database.js';
import { createService, validateSnapshot } from '../service.js';
import { createApi } from '../http.js';
import { publishRelease } from '../publish-release.js';
import { buildUpdateManifest } from '../../tools/update-manifest.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { digest, integrity } from '../security.js';
import { createLocalDb, localDb, STORAGE_KEYS, configureCloudWrites } from '../../src/storage.js';
import { canonicalJSON, mutationPrecondition, CLOUD_STATE_KEY } from '../../src/sync-protocol.js';
import { createCloudClient } from '../../src/cloud-client.js';
import { getCloudState, saveCloudState } from '../../src/cloud-storage.js';
import { DATA_LIMITS } from '../../src/data-limits.js';

class MemoryStorage {
  values = new Map(); failKey = null; failOnce = false;
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) {
    if (key === this.failKey && this.failOnce) { this.failOnce = false; throw new Error('quota exceeded'); }
    this.values.set(key, String(value));
  }
  removeItem(key) { this.values.delete(key); }
}
let db, pool, service, server, url, owner, stopClient, cleanupDatabase;
const password = 'Correct-Horse-Cloud-2026!';
before(async () => {
  if (process.env.MEMBER_TEST_DATABASE_URL) {
    const schema = 'member_test_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Pool({ connectionString: process.env.MEMBER_TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.MEMBER_TEST_DATABASE_URL, max: 10,
      options: '-c search_path=' + schema, statement_timeout: 10000 });
    cleanupDatabase = async () => {
      await pool.end();
      try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
    };
  } else {
    db = new PGlite();
    let tail = Promise.resolve();
    pool = {
      async connect() {
        const previous = tail; let release;
        tail = new Promise(resolve => { release = resolve; }); await previous;
        return { query: (sql, parameters) => parameters ? db.query(sql, parameters) : sql.includes(';') ? db.exec(sql) : db.query(sql), release };
      },
      async query(sql, parameters) { const client = await this.connect(); try { return await client.query(sql, parameters); } finally { client.release(); } }
    };
    cleanupDatabase = () => db.close();
  }
  await migrate(pool); service = createService(pool);
  server = createApi({ service, pool });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await cleanupDatabase(); });
beforeEach(async () => {
  await pool.query('TRUNCATE stores,login_limits,releases RESTART IDENTITY CASCADE');
  await service.createOwner({ username: 'owner', password });
  owner = await login('owner');
  globalThis.localStorage = new MemoryStorage(); localDb.init();
});
afterEach(() => { stopClient?.(); stopClient = null; configureCloudWrites(null, null); });

async function login(username, deviceId = randomUUID()) {
  const session = await service.login({ username, password, deviceId }, '127.0.0.1');
  return { ...session, identity: await service.authenticate(session.accessToken), deviceId };
}
function localDatabase(data) {
  const storage = new MemoryStorage();
  for (const [field, key] of [['members', STORAGE_KEYS.MEMBERS], ['ledgers', STORAGE_KEYS.LEDGERS], ['services', STORAGE_KEYS.SERVICES], ['rechargePlans', STORAGE_KEYS.RECHARGE_PLANS]]) storage.setItem(key, JSON.stringify(data[field]));
  if (data.rechargeSettings !== undefined) storage.setItem(STORAGE_KEYS.RECHARGE_SETTINGS, JSON.stringify(data.rechargeSettings));
  return storage;
}
function operation(data, session, method, args) {
  let captured;
  const storage = localDatabase(data);
  const ledger = createLocalDb(storage, { beforeWrite(entries, mutation) {
    captured = { ...mutation, id: randomUUID(), actorId: session.identity.id, deviceId: session.deviceId,
      precondition: mutationPrecondition(ledger.readBackupState(), method, args) };
    return entries;
  } });
  ledger[method](...args);
  return { operation: captured, data: ledger.readBackupState() };
}
async function initialAccount() {
  const storage = new MemoryStorage(), ledger = createLocalDb(storage); ledger.init();
  const member = ledger.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  const account = await service.bootstrap(owner.identity, { id: randomUUID(), data: ledger.readBackupState() });
  return { ...account, member };
}

test('HTTP cloud sync reads legacy duplicate pairs, blocks accounting and permits individual profile repairs', async () => {
  const ledger = createLocalDb(new MemoryStorage()); ledger.init();
  const members = Array.from({ length: 4 }, (_, i) => ledger.createMember({
    name: '旧客户' + i, phone: String(13800000000 + i), initialBalance: 100
  }));
  const account = await service.bootstrap(owner.identity, { id: randomUUID(), data: ledger.readBackupState() });
  // Retain an old valid operation to prove the server independently blocks it.
  const financial = operation(account.data, owner, 'recharge', [{ memberId: members[0].id, actualPay: 10 }]).operation;
  const legacy = structuredClone(account.data);
  legacy.members.find(m => m.id === members[1].id).phone = '138 0000 0000';
  legacy.members.find(m => m.id === members[3].id).phone = '(138) 0000-0002';
  await pool.query('UPDATE accounts SET data=$1,integrity=$2 WHERE store_id=$3', [legacy, integrity(legacy), owner.identity.store_id]);
  let online = false;
  const mobile = await connectedClient({ online: () => online });
  await mobile.useCloudLedger();
  assert.deepEqual(localDb.readBackupState(), legacy);
  assert.throws(() => localDb.recharge({ memberId: members[0].id, actualPay: 10 }), /会员单号/);
  const rejected = await api('/sync', { operations: [financial] });
  assert.equal(rejected.status, 409);
  assert.match((await rejected.json()).error, /会员单号/);
  assert.equal((await service.account(owner.identity)).revision, account.revision);
  localDb.updateMember(members[1].id, { phone: '13900000001' });
  online = true;
  await mobile.sync();
  online = false;
  assert.equal(getCloudState().outbox.length, 0);
  assert.throws(() => localDb.consume({ memberId: members[0].id, amount: 10 }), /会员单号/);
  localDb.updateMember(members[3].id, { phone: '13900000003' });
  online = true;
  await mobile.sync();
  online = false;
  const repaired = await service.account(owner.identity);
  assert.deepEqual(repaired.data.ledgers, legacy.ledgers);
  assert.ok(repaired.data.members.every(m => m.balance === 10000 && m.total_recharge === 10000 && m.total_consume === 0));
  localDb.recharge({ memberId: members[0].id, actualPay: 10 });
  online = true;
  await mobile.sync();
  assert.equal((await service.account(owner.identity)).data.members.find(m => m.id === members[0].id).balance, 11000);
});
async function api(path, body, accessToken = owner.accessToken, method = body === undefined ? 'GET' : 'POST') {
  return fetch(url + '/api/v1' + path, { method, headers: { ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function connectedClient({ requestFetch, online = () => true, vault, username = 'owner' } = {}) {
  let saved = null;
  const client = createCloudClient({ fetch: requestFetch || fetch, isOnline: online,
    vault: vault || { load: async () => saved, save: async value => { saved = value; }, clear: async () => { saved = null; } } });
  await client.login(url, username, password);
  stopClient = await client.start();
  // 初次启动的后台同步可能尚在查询账本版本，等待其完成再进行测试操作。
  for (let count = 0; client.snapshot().busy && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 5));
  return client;
}

for (const sameRevision of [false, true]) {
  for (const alreadyQueued of [false, true]) {
    test(`cloud ${sameRevision ? 'same-revision mutation' : 'rollback'} blocks writes and persists after login (pending=${alreadyQueued})`, async () => {
      const account = await initialAccount();
      let online = false, uploads = 0;
      const client = await connectedClient({ online: () => online, requestFetch: (input, options) => {
        if (input.endsWith('/sync')) uploads++;
        return fetch(input, options);
      } });
      const second = localDb.createMember({ name: '第二会员', phone: '13900001111', initialBalance: 100 });
      online = true; await client.sync(); online = false;
      const baseline = await service.account(owner.identity);
      localDb.recharge({ memberId: account.member.id, actualPay: 50 });
      online = true; await client.sync(); online = false;
      const latest = getCloudState().revision;
      if (alreadyQueued) localDb.recharge({ memberId: second.id, actualPay: 10 });
      const original = localDb.readBackupState(), pending = structuredClone(getCloudState().outbox);
      await pool.query('UPDATE accounts SET revision=$1,data=$2,integrity=$3 WHERE store_id=$4',
        [sameRevision ? latest : baseline.revision, baseline.data, baseline.integrity, owner.identity.store_id]);
      uploads = 0; online = true;
      await assert.rejects(client.sync(), { code: 'CLOUD_INTEGRITY_CONFLICT' });
      assert.equal(getCloudState().status, 'conflict');
      assert.equal(getCloudState().conflictReason, 'integrity');
      assert.throws(() => localDb.recharge({ memberId: second.id, actualPay: 10 }), /同步冲突/);
      await client.sync();
      assert.equal(uploads, 0);
      assert.deepEqual(localDb.readBackupState(), original);
      assert.deepEqual(getCloudState().outbox, pending);
      stopClient(); stopClient = null;
      await client.logout();
      const restarted = await connectedClient({ online: () => online });
      assert.equal(restarted.snapshot().status, 'conflict');
      assert.equal(restarted.snapshot().conflictReason, 'integrity');
      assert.throws(() => localDb.consume({ memberId: second.id, amount: 1 }), /同步冲突/);
      await restarted.sync();
      assert.deepEqual(localDb.readBackupState(), original);
      assert.deepEqual(getCloudState().outbox, pending);
      assert.equal((await service.account(owner.identity)).data.members.find(member => member.id === account.member.id).balance, 10000);
    });
  }
}

test('owner-confirmed integrity recovery preserves pending records and retries a lost response exactly once', async () => {
  const baseline = await initialAccount();
  let online = false, lose = false;
  const client = await connectedClient({ online: () => online, requestFetch: async (input, options) => {
    const response = await fetch(input, options);
    if (lose && input.endsWith('/sync')) { lose = false; await response.arrayBuffer(); throw new TypeError('lost response'); }
    return response;
  } });
  localDb.recharge({ memberId: baseline.member.id, actualPay: 50 });
  online = true; await client.sync(); online = false;
  localDb.consume({ memberId: baseline.member.id, amount: 38 });
  const expected = localDb.readBackupState(), pending = structuredClone(getCloudState().outbox);
  await pool.query('UPDATE accounts SET revision=$1,data=$2,integrity=$3 WHERE store_id=$4',
    [baseline.revision, baseline.data, baseline.integrity, owner.identity.store_id]);
  online = true;
  await assert.rejects(client.sync(), { code: 'CLOUD_INTEGRITY_CONFLICT' });
  await assert.rejects(client.useCloudLedger(), /回退/);
  lose = true;
  await assert.rejects(client.uploadRecoveredLedger(), { network: true });
  const recovery = JSON.parse(localStorage.getItem('hairstudio_cloud_pre_replace_v1'));
  assert.deepEqual(recovery.data, expected);
  assert.deepEqual(recovery.cloud.outbox, pending);
  assert.equal(getCloudState().outbox[0].method, 'importBackupData');
  await client.sync();
  assert.deepEqual((await service.account(owner.identity)).data, expected);
  assert.deepEqual(localDb.readBackupState(), expected);
  assert.equal(getCloudState().outbox.length, 0);
  assert.equal(getCloudState().conflictReason, null);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM operations WHERE method='importBackupData'")).rows[0].count, 1);
});

test('a valid checksum at an unchanged sync revision cannot acknowledge newer data or clear pending records', async () => {
  const account = await initialAccount(); let online = false;
  const client = await connectedClient({ online: () => online, requestFetch: async (input, options) => {
    const response = await fetch(input, options);
    if (input.endsWith('/sync')) {
      const result = await response.json(); result.revision = getCloudState().revision;
      return new Response(JSON.stringify(result));
    }
    return response;
  } });
  localDb.consume({ memberId: account.member.id, amount: 38 });
  const original = localDb.readBackupState(), pending = structuredClone(getCloudState().outbox);
  online = true;
  await assert.rejects(client.sync(), { code: 'CLOUD_INTEGRITY_CONFLICT' });
  assert.deepEqual(localDb.readBackupState(), original);
  assert.deepEqual(getCloudState().outbox, pending);
  assert.equal(getCloudState().conflictReason, 'integrity');
});

for (const sameRevision of [false, true]) {
  test(`a ${sameRevision ? 'same-revision mutation' : 'rollback'} after the head check rejects a whole batch under the server lock`, async () => {
    const baseline = await initialAccount(); let online = false, race = false;
    const client = await connectedClient({ online: () => online, requestFetch: async (input, options) => {
      if (race && input.endsWith('/sync')) {
        race = false;
        const expected = JSON.parse(options.body).observedHead;
        assert.equal(expected.revision, getCloudState().revision);
        await pool.query('UPDATE accounts SET revision=$1,data=$2,integrity=$3 WHERE store_id=$4',
          [sameRevision ? expected.revision : baseline.revision, baseline.data, baseline.integrity, owner.identity.store_id]);
      }
      return fetch(input, options);
    } });
    localDb.recharge({ memberId: baseline.member.id, actualPay: 50 });
    online = true; await client.sync(); online = false;
    localDb.createMember({ name: '新会员一', phone: '13900001111', initialBalance: 10 });
    localDb.createMember({ name: '新会员二', phone: '13700001111', initialBalance: 20 });
    const expected = localDb.readBackupState(), pending = structuredClone(getCloudState().outbox);
    const operationCount = (await pool.query('SELECT count(*)::int AS count FROM operations')).rows[0].count;
    race = true; online = true;
    await assert.rejects(client.sync(), { code: 'CLOUD_INTEGRITY_CONFLICT', status: 409 });
    assert.equal(getCloudState().conflictReason, 'integrity');
    assert.deepEqual(getCloudState().outbox, pending);
    assert.deepEqual(localDb.readBackupState(), expected);
    assert.deepEqual((await service.account(owner.identity)).data, baseline.data);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM operations')).rows[0].count, operationCount);
  });
}

test('invalid client head declarations are rejected without writing the server ledger', async () => {
  const baseline = await initialAccount();
  const charge = operation(baseline.data, owner, 'consume', [{ memberId: baseline.member.id, amount: 10 }]).operation;
  for (const observedHead of [{ revision: -1, integrity: baseline.integrity }, { revision: 1, integrity: 'invalid' }, 'invalid']) {
    const response = await api('/sync', { operations: [charge], observedHead });
    assert.equal(response.status, 400);
    assert.deepEqual((await service.account(owner.identity)).data, baseline.data);
  }
});

test('server integrity failures persist an accounting conflict and preserve pending operations', async () => {
  const baseline = await initialAccount(); let online = false;
  const client = await connectedClient({ online: () => online });
  localDb.consume({ memberId: baseline.member.id, amount: 10 });
  const expected = localDb.readBackupState(), pending = structuredClone(getCloudState().outbox);
  await pool.query('UPDATE accounts SET integrity=$1 WHERE store_id=$2', ['0'.repeat(64), owner.identity.store_id]);
  online = true;
  await assert.rejects(client.sync(), { code: 'INTEGRITY_FAILED' });
  assert.equal(getCloudState().conflictReason, 'integrity');
  assert.throws(() => localDb.consume({ memberId: baseline.member.id, amount: 1 }), /同步冲突/);
  assert.deepEqual(localDb.readBackupState(), expected);
  assert.deepEqual(getCloudState().outbox, pending);
});

test('local and server backup validation agree on service IDs and legacy tag representations', async () => {
  const account = await initialAccount();
  for (const services of [[{ ...account.data.services[0], id: '' }], [{ ...account.data.services[0], id: ' ' }],
    [account.data.services[0], { ...account.data.services[0], name: '重复单号' }]]) {
    const data = { ...account.data, services };
    assert.throws(() => validateSnapshot(data), /服务项目/);
    assert.throws(() => localDb.parseAndValidateBackup(JSON.stringify({ data })), /服务项目/);
    const response = await api('/account/bootstrap', { id: randomUUID(), data });
    assert.equal(response.status, 400);
    assert.deepEqual((await service.account(owner.identity)).data, account.data);
  }
  for (const tags of ['VIP', ['常客', '年卡'], null]) {
    const data = structuredClone(account.data); data.members[0].tags = tags;
    assert.deepEqual(validateSnapshot(data).members[0].tags, tags);
  }
});

test('failed mobile head checks persist an unconfirmed state until a successful synchronization', async () => {
  let fail = false;
  const client = await connectedClient({ requestFetch: (path, options) => {
    if (String(path).endsWith('/account/head') && fail) return Promise.resolve(new Response(JSON.stringify({ error: '服务器繁忙', code: 'SERVER_BUSY' }), { status: 503 }));
    return fetch(path, options);
  } });
  assert.equal(client.snapshot().syncStatus, 'confirmed');
  const original = localDb.readBackupState(), successfulTime = client.snapshot().lastSync;
  fail = true;
  await assert.rejects(client.sync(), { status: 503 });
  assert.equal(client.snapshot().syncStatus, 'error'); assert.equal(client.snapshot().online, true);
  assert.equal(client.snapshot().lastSync, successfulTime);
  assert.equal(getCloudState().syncError, '服务器繁忙');
  assert.deepEqual(localDb.readBackupState(), original);
  fail = false; await client.sync();
  assert.equal(client.snapshot().syncStatus, 'confirmed'); assert.equal(client.snapshot().syncError, '');
});

test('equal-revision mobile head checks reject changed integrity without overwriting the local account', async () => {
  let alter = false;
  const client = await connectedClient({ requestFetch: async (path, options) => {
    const response = await fetch(path, options);
    if (String(path).endsWith('/account/head') && alter) {
      const head = await response.json(); return new Response(JSON.stringify({ ...head, integrity: 'f'.repeat(64) }));
    }
    return response;
  } });
  const original = localDb.readBackupState(); alter = true;
  await assert.rejects(client.sync(), /版本核验失败/);
  assert.equal(client.snapshot().syncStatus, 'error'); assert.deepEqual(localDb.readBackupState(), original);
});

test('passwords are salted hashes and login failures are rate limited', async () => {
  const stored = (await pool.query('SELECT password_hash FROM users WHERE username=$1', ['owner'])).rows[0].password_hash;
  assert.match(stored, /^scrypt\$/); assert.equal(stored.includes(password), false);
  for (let count = 0; count < 10; count++) await assert.rejects(service.login({ username: 'owner', password: 'wrong', deviceId: randomUUID() }, 'attacker'), { status: 401 });
  await assert.rejects(service.login({ username: 'owner', password, deviceId: randomUUID() }, 'attacker'), { status: 429 });
});
test('concurrent wrong logins reserve shared user and IP quotas before password work', async () => {
  const results = await Promise.allSettled(Array.from({ length: 24 }, () => service.login({ username: 'owner', password: 'wrong', deviceId: randomUUID() }, 'attacker')));
  assert.equal(results.filter(item => item.reason?.status === 401).length, 10);
  assert.equal(results.filter(item => item.reason?.status === 429).length, 14);
  assert.equal(results.some(item => item.status === 'fulfilled'), false);
  const count = await pool.query('SELECT failures FROM login_limits WHERE bucket=$1', [digest('user:owner')]);
  assert.equal(count.rows[0].failures, 10);
});
test('a shared IP quota also bounds concurrent guesses against different usernames', async () => {
  const results = await Promise.allSettled(Array.from({ length: 24 }, (_, index) => service.login({ username: 'missing-' + index, password: 'wrong', deviceId: randomUUID() }, 'shared-attacker')));
  assert.equal(results.filter(item => item.reason?.status === 401).length, 10);
  assert.equal(results.filter(item => item.reason?.status === 429).length, 14);
});
test('successful login refunds only its failure reservation and keeps its total attempt budget', async () => {
  await login('owner');
  const limits = (await pool.query('SELECT bucket,failures FROM login_limits')).rows;
  assert.equal(limits.find(item => item.bucket === digest('user:owner')).failures, 0);
  assert.equal(limits.find(item => item.bucket === digest('attempt-user:owner')).failures, 2);
  await pool.query('UPDATE login_limits SET failures=60 WHERE bucket=$1', [digest('attempt-user:owner')]);
  await assert.rejects(login('owner'), { status: 429 });
  await pool.query("UPDATE login_limits SET window_start=now()-interval '16 minutes'");
  await login('owner');
});
test('forbidden owner actions check the actual role before inspecting expensive input', async () => {
  await service.createUser(owner.identity, { username: 'viewer', password, displayName: '只读', role: 'viewer' });
  const viewer = await login('viewer');
  const hostile = new Proxy({}, { get() { throw new Error('payload inspected before permission'); } });
  await assert.rejects(service.createUser({ ...viewer.identity, role: 'owner' }, hostile), { status: 403 });
  await assert.rejects(service.bootstrap({ ...viewer.identity, role: 'owner' }, hostile), { status: 403 });
  for (const path of ['/users', '/account/bootstrap', '/sync']) {
    const response = await fetch(url + '/api/v1' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + viewer.accessToken, 'Content-Type': 'text/plain' }, body: 'not JSON' });
    assert.equal(response.status, 403);
  }
});
test('owner authorization is rechecked if the role changes while a password is being prepared', async () => {
  let connections = 0;
  const guarded = { query: (...args) => pool.query(...args), async connect() {
    if (++connections === 2) await pool.query("UPDATE users SET role='viewer' WHERE id=$1", [owner.identity.id]);
    return pool.connect();
  } };
  await assert.rejects(createService(guarded).createUser(owner.identity, { username: 'new-user', password, displayName: '新账号', role: 'clerk' }), { status: 403 });
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM users WHERE username='new-user'")).rows[0].count, 0);
});
test('oversized fields, nested preconditions and wrong argument types cannot change an account', async () => {
  const account = await initialAccount();
  const valid = operation(account.data, owner, 'createMember', [{ name: '新会员', phone: '13900003333' }]).operation;
  for (const mutate of [
    op => { op.args[0].name = 'x'.repeat(512 * 1024); },
    op => { op.args[0].phone = '1'.repeat(DATA_LIMITS.phone + 1); },
    op => { op.args[0].notes = 'x'.repeat(DATA_LIMITS.notes + 1); },
    op => { let node = op.precondition; for (let i = 0; i < 50; i++) node = node.child = {}; }
  ]) {
    const op = structuredClone(valid); mutate(op);
    assert.equal((await api('/sync', { operations: [op] })).status, 413);
  }
  const malformed = structuredClone(valid); malformed.args[0].notes = {};
  assert.equal((await api('/sync', { operations: [malformed] })).status, 400);
  for (const name of ['bad\u0000name', '\ud800']) {
    const invalidText = structuredClone(valid); invalidText.args[0].name = name;
    assert.equal((await api('/sync', { operations: [invalidText] })).status, 400);
  }
  assert.deepEqual(await service.account(owner.identity), { data: account.data, revision: account.revision, integrity: account.integrity });
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM operations WHERE method='createMember'")).rows[0].count, 0);
});
test('final account growth is rejected atomically instead of truncating saved records', async () => {
  const data = (await service.account(owner.identity)).data;
  data.services = Array.from({ length: DATA_LIMITS.services }, (_, i) => ({ id: 'service-' + i, name: '项目' + i, price: 1 }));
  const account = await service.bootstrap(owner.identity, { id: randomUUID(), data });
  // Build a valid request without running the local writer that also enforces this limit.
  const op = { id: randomUUID(), actorId: owner.identity.id, deviceId: owner.deviceId, method: 'saveService', args: [{ name: '超额项目', price: 1 }], generated: { ids: ['new-service'], times: [new Date().toISOString()] }, precondition: { services: data.services } };
  await assert.rejects(service.sync(owner.identity, [op]), { status: 413 });
  assert.deepEqual(await service.account(owner.identity), { data: account.data, revision: account.revision, integrity: account.integrity });
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM operations WHERE method='saveService'")).rows[0].count, 0);
});
test('concurrent account creation cannot exceed the per-store account limit', async () => {
  const hash = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [owner.identity.id])).rows[0].password_hash;
  await pool.query("INSERT INTO users(id,store_id,username,display_name,password_hash,role) SELECT gen_random_uuid(),$1,'fixture-'||n,'店员',$2,'clerk' FROM generate_series(1,98) n", [owner.identity.store_id, hash]);
  const results = await Promise.allSettled(['last-one', 'last-two'].map(username => service.createUser(owner.identity, { username, password, displayName: '最后账号', role: 'clerk' })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.reason?.status === 413).length, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM users')).rows[0].count, 100);
});
test('small authentication and administration routes reject large bodies before any writes', async () => {
  const response = await api('/auth/login', { username: 'owner', password, deviceId: randomUUID(), padding: 'x'.repeat(17000) }, null);
  assert.equal(response.status, 413);
  assert.equal((await api('/users', { username: 'new-user', password, displayName: 'x'.repeat(129), role: 'clerk' })).status, 413);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM users')).rows[0].count, 1);
});
test('large valid service preconditions synchronize in size-limited batches without losing pending operations', async () => {
  const data = (await service.account(owner.identity)).data;
  data.services = Array.from({ length: DATA_LIMITS.services }, (_, i) => ({ id: 'service-' + i, name: '长服务名称'.repeat(20), price: 1 }));
  await service.bootstrap(owner.identity, { id: randomUUID(), data });
  let online = false; const sizes = [];
  const client = await connectedClient({ online: () => online, requestFetch: async (input, options) => {
    if (input.endsWith('/sync')) sizes.push(Buffer.byteLength(options.body));
    return fetch(input, options);
  } });
  for (let i = 0; i < 20; i++) localDb.saveService({ ...data.services[0], price: i + 2 });
  assert.equal(getCloudState().outbox.length, 20);
  online = true; await client.sync();
  assert.ok(sizes.length > 1); assert.ok(sizes.every(size => size <= DATA_LIMITS.syncBytes));
  assert.equal(getCloudState().outbox.length, 0);
  assert.equal((await service.account(owner.identity)).data.services[0].price, 21);
});
test('refresh tokens rotate and replay revokes the associated session', async () => {
  const refreshed = await service.refresh(owner.refreshToken);
  assert.notEqual(refreshed.refreshToken, owner.refreshToken);
  await service.authenticate(refreshed.accessToken);
  await assert.rejects(service.refresh(owner.refreshToken), { status: 401 });
  await assert.rejects(service.authenticate(refreshed.accessToken), { status: 401 });
});
test('initial migration is owner-only, idempotent and cannot replace an existing cloud account', async () => {
  const account = await initialAccount();
  const id = randomUUID();
  await assert.rejects(service.bootstrap(owner.identity, { id, data: account.data }), { status: 409 });
  await service.createOwner({ username: 'second-owner', password });
  const second = await login('second-owner');
  const request = { id, data: account.data };
  const first = await service.bootstrap(second.identity, request);
  const retry = await service.bootstrap(second.identity, request);
  assert.equal(first.revision, 1); assert.deepEqual(retry.data, first.data);
});

for (const field of ['services', 'rechargePlans']) {
  for (const initialized of [false, true]) {
    test(`first login preserves customized ${field} until explicitly choosing a ledger (cloud initialized: ${initialized})`, async () => {
      if (initialized) await initialAccount();
      if (field === 'services') localDb.saveService({ id: 's1', name: '自定义剪发', price: 66 });
      else localStorage.setItem(STORAGE_KEYS.RECHARGE_PLANS, JSON.stringify([{ pay: 100, gift: 15 }]));
      const local = localDb.readBackupState();
      const client = await connectedClient({ online: () => false });
      assert.equal(getCloudState().status, initialized ? 'needs-choice' : 'needs-bootstrap');
      assert.equal(getCloudState().binding, null);
      assert.deepEqual(localDb.readBackupState(), local);
      if (initialized) {
        await client.useCloudLedger();
        assert.deepEqual(JSON.parse(localStorage.getItem('hairstudio_cloud_pre_replace_v1')).data, local);
      } else {
        await client.bootstrap();
        assert.deepEqual((await service.account(owner.identity)).data, local);
      }
      assert.equal(getCloudState().status, 'synced');
    });
  }
}

for (const role of ['owner', 'clerk', 'viewer']) {
  test(`first browser login keeps ${role} writes blocked through account loading, failure and ledger choice`, async () => {
    await initialAccount();
    const username = role === 'owner' ? 'owner' : role;
    if (role !== 'owner') await service.createUser(owner.identity, { username, password, displayName: role, role });
    const member = localDb.createMember({ name: '未绑定本机会员', phone: '13900002222', initialBalance: 20 });
    const original = localDb.readBackupState();
    let loading, release, failAccount = true;
    const started = new Promise(resolve => { loading = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const client = createCloudClient({ isOnline: () => false, fetch: async (input, options) => {
      if (input.endsWith('/account') && failAccount) {
        loading(); await barrier;
        return new Response(JSON.stringify({ error: '账本暂时不可用' }), { status: 503 });
      }
      return fetch(input, options);
    } });
    stopClient = await client.start();
    const rejected = assert.rejects(client.login(url, username, password), { status: 503 });
    await started;
    assert.equal(getCloudState().user.role, role);
    assert.equal(getCloudState().binding, null);
    assert.throws(() => localDb.recharge({ memberId: member.id, actualPay: 50 }), /权限|绑定/);
    release(); await rejected;
    assert.throws(() => localDb.createMember({ name: '不能建档', phone: '13700003333' }), /权限|绑定/);
    assert.deepEqual(localDb.readBackupState(), original);
    assert.equal(getCloudState().outbox.length, 0);
    failAccount = false;
    await client.login(url, username, password);
    assert.equal(getCloudState().status, 'needs-choice');
    assert.throws(() => localDb.recharge({ memberId: member.id, actualPay: 50 }), /权限|绑定/);
    await client.useCloudLedger();
    assert.equal(getCloudState().binding.storeId, owner.user.storeId);
    const cloudMember = localDb.getMembers()[0];
    if (role === 'viewer') assert.throws(() => localDb.recharge({ memberId: cloudMember.id, actualPay: 50 }), /权限/);
    else {
      localDb.recharge({ memberId: cloudMember.id, actualPay: 50 });
      assert.equal(localDb.getMemberById(cloudMember.id).balance, 15000);
      assert.equal(getCloudState().outbox.length, 1);
    }
  });
}

test('first browser binding is committed with the ledger and remains locked after a failed local write', async t => {
  t.mock.method(console, 'error', () => {});
  await initialAccount();
  const client = createCloudClient({ fetch, isOnline: () => false });
  stopClient = await client.start();
  const original = localDb.readBackupState();
  localStorage.failKey = STORAGE_KEYS.MEMBERS; localStorage.failOnce = true;
  await assert.rejects(client.login(url, 'owner', password), /写入失败/);
  assert.equal(getCloudState().binding, null);
  assert.deepEqual(localDb.readBackupState(), original);
  assert.throws(() => localDb.createMember({ name: '不能建档', phone: '13900002222' }), /绑定/);
  await client.login(url, 'owner', password);
  assert.equal(getCloudState().binding.storeId, owner.user.storeId);
  assert.equal(localDb.getMembers()[0].balance, 10000);
});

for (const status of ['pending', 'conflict']) {
  test(`a browser restart requires login without losing its ${status} ledger or operations`, async () => {
    const account = await initialAccount();
    await connectedClient({ online: () => false });
    localDb.consume({ memberId: account.member.id, amount: 38 });
    if (status === 'conflict') saveCloudState({ ...getCloudState(), status, conflictReason: 'data' });
    const before = getCloudState(), local = localDb.readBackupState();
    stopClient(); stopClient = null;
    const client = createCloudClient({ fetch, isOnline: () => false });
    await client.restoreSession();
    assert.equal(client.snapshot().user, null);
    assert.equal(client.snapshot().status, 'login-required');
    for (const key of ['binding', 'outbox', 'activity', 'revision', 'conflictReason']) {
      assert.deepEqual(getCloudState()[key], before[key]);
    }
    assert.deepEqual(localDb.readBackupState(), local);
    await client.login(url, 'owner', password);
    assert.equal(getCloudState().status, status);
    assert.deepEqual(getCloudState().outbox, before.outbox);
  });
}

test('a missing refresh token locks the ledger even when secure storage clearing fails', async () => {
  await initialAccount();
  await connectedClient({ online: () => false });
  const local = localDb.readBackupState(), before = getCloudState();
  const client = createCloudClient({ fetch, vault: { clear: async () => { throw new Error('vault unavailable'); } } });
  await assert.rejects(client.request('/account'));
  assert.equal(client.snapshot().user, null);
  assert.equal(client.snapshot().status, 'login-required');
  assert.deepEqual(getCloudState().binding, before.binding);
  assert.deepEqual(localDb.readBackupState(), local);
});

test('a saved native session still permits offline recording after restarting', async () => {
  const account = await initialAccount();
  let saved;
  const vault = { load: async () => saved, save: async value => { saved = value; }, clear: async () => { saved = null; } };
  await connectedClient({ vault, online: () => false });
  stopClient(); stopClient = null;
  const client = createCloudClient({ fetch, vault, isOnline: () => false });
  stopClient = await client.start();
  assert.equal(client.snapshot().user.id, owner.user.id);
  localDb.consume({ memberId: account.member.id, amount: 38 });
  assert.equal(localDb.getMemberById(account.member.id).balance, 6200);
  assert.equal(getCloudState().outbox.length, 1);
});

for (const storageMode of ['available', 'missing', 'temporarily-unreadable']) {
  test(`native offline restart preserves identity and pending charges when secure storage is ${storageMode}`, async () => {
    const account = await initialAccount();
    let saved, online = false, fetchCount = 0;
    const originalVault = { load: async () => saved, save: async value => { saved = value; }, clear: async () => { saved = null; } };
    await connectedClient({ vault: originalVault, online: () => false });
    stopClient(); stopClient = null;
    const before = getCloudState();
    const client = createCloudClient({ allowOffline: true, isOnline: () => online,
      vault: { ...originalVault, load: async () => {
        if (storageMode === 'temporarily-unreadable') throw new Error('Keystore unavailable');
        return storageMode === 'missing' ? null : saved;
      } },
      fetch: (...args) => { fetchCount++; assert.equal(online, true); return fetch(...args); }
    });
    stopClient = await client.start();
    assert.deepEqual(client.snapshot().user, before.user);
    assert.deepEqual(client.snapshot().binding, before.binding);
    assert.equal(Boolean(client.snapshot().syncLoginRequired), storageMode !== 'available');
    localDb.consume({ memberId: account.member.id, amount: 38 });
    assert.equal(localDb.getMemberById(account.member.id).balance, 6200);
    assert.equal(getCloudState().outbox[0].actorId, before.user.id);
    assert.equal(fetchCount, 0);
    online = true;
    if (storageMode !== 'available') {
      await client.sync();
      assert.equal(fetchCount, 0);
      assert.equal(getCloudState().outbox.length, 1);
      await client.login(url, 'owner', password);
    }
    await client.sync();
    await client.sync();
    assert.equal(getCloudState().outbox.length, 0);
    assert.equal(client.snapshot().syncLoginRequired, false);
    const remote = await service.account(owner.identity);
    assert.equal(remote.data.members[0].balance, 6200);
    assert.equal(remote.data.ledgers.filter(entry => entry.type === 'CONSUME').length, 1);
  });
}

test('native concurrent startup and sync wait for secure storage instead of losing the cached login', async () => {
  const account = await initialAccount();
  let saved, finishRead;
  await connectedClient({ online: () => false, vault: { load: async () => saved, save: async value => { saved = value; }, clear: async () => {} } });
  stopClient(); stopClient = null;
  let networkCalls = 0;
  const client = createCloudClient({ allowOffline: true, isOnline: () => true,
    vault: { load: () => new Promise(resolve => { finishRead = resolve; }), save: async value => { saved = value; }, clear: async () => {} },
    fetch: (...args) => { networkCalls++; return fetch(...args); }
  });
  const starting = client.start();
  const syncing = client.sync();
  localDb.consume({ memberId: account.member.id, amount: 38 });
  assert.equal(networkCalls, 0);
  finishRead(saved);
  stopClient = await starting;
  await syncing;
  for (let count = 0; client.snapshot().busy && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(client.snapshot().user.id, owner.user.id);
  assert.equal(getCloudState().outbox.length, 0);
  assert.equal((await service.account(owner.identity)).data.members[0].balance, 6200);
});

test('native network failures and revoked cloud credentials keep local identity and pending records', async () => {
  const account = await initialAccount();
  let saved, mode = 'network';
  const vault = { load: async () => saved, save: async value => { saved = value; }, clear: async () => { saved = null; } };
  await connectedClient({ vault, online: () => false });
  stopClient(); stopClient = null;
  const client = createCloudClient({ allowOffline: true, isOnline: () => true, vault,
    fetch: (...args) => {
      if (mode === 'network') throw new TypeError('network unreachable');
      if (mode === 'revoked') return Promise.resolve(new Response(JSON.stringify({ error: 'session expired' }), { status: 401 }));
      return fetch(...args);
    }
  });
  await client.restoreSession();
  // 保持自动记账钩子，但由测试显式触发同步，避免后台同步干扰失败阶段。
  const { installCloudRecording } = await import('../../src/cloud-storage.js');
  stopClient = installCloudRecording();
  localDb.consume({ memberId: account.member.id, amount: 38 });
  const pending = getCloudState().outbox;
  await assert.rejects(client.sync(), { network: true });
  assert.equal(client.snapshot().online, false);
  assert.equal(client.snapshot().user.id, owner.user.id);
  assert.deepEqual(getCloudState().outbox, pending);
  mode = 'revoked';
  await assert.rejects(client.sync(), { status: 401 });
  assert.equal(client.snapshot().syncLoginRequired, true);
  assert.equal(client.snapshot().user.id, owner.user.id);
  assert.deepEqual(getCloudState().outbox, pending);
  localDb.recharge({ memberId: account.member.id, actualPay: 20 });
  assert.equal(localDb.getMemberById(account.member.id).balance, 8200);
  mode = 'online';
  await client.login(url, 'owner', password);
  await client.sync();
  assert.equal(getCloudState().outbox.length, 0);
  assert.equal((await service.account(owner.identity)).data.members[0].balance, 8200);
});

test('native explicit logout cannot silently restore credentials left by a failed vault clear', async () => {
  await initialAccount();
  let saved;
  const vault = { load: async () => saved, save: async value => { saved = value; }, clear: async () => { throw new Error('vault unavailable'); } };
  const client = createCloudClient({ allowOffline: true, vault, fetch, isOnline: () => false });
  await client.login(url, 'owner', password);
  await assert.rejects(client.logout(), /vault unavailable/);
  await client.restoreSession();
  assert.equal(client.snapshot().user, null);
  assert.equal(client.snapshot().syncLoginRequired, true);
});
test('sync recomputes monetary values and atomically writes balances, ledgers and audit records', async () => {
  const account = await initialAccount();
  const recharge = operation(account.data, owner, 'recharge', [{ memberId: account.member.id, actualPay: '20.01', giftAmount: '0.07', balanceAfter: 999999 }]);
  const consume = operation(recharge.data, owner, 'consume', [{ memberId: account.member.id, amount: '38.00' }]);
  const result = await service.sync(owner.identity, [recharge.operation, consume.operation]);
  assert.equal(result.data.members[0].balance, 8208);
  assert.equal(result.data.ledgers.length, 3); assert.equal(result.integrity, integrity(result.data));
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE event IN ('recharge','consume')")).rows[0].count, 2);
  const retry = await service.sync(owner.identity, [recharge.operation, consume.operation]);
  assert.equal(retry.revision, result.revision); assert.deepEqual(retry.data, result.data);
});
test('a rejected operation rolls back the whole batch including audit and deduplication records', async () => {
  const account = await initialAccount();
  const first = operation(account.data, owner, 'consume', [{ memberId: account.member.id, amount: 10 }]);
  const second = operation(first.data, owner, 'consume', [{ memberId: account.member.id, amount: 10 }]);
  second.operation.args[0].amount = 1000;
  await assert.rejects(service.sync(owner.identity, [first.operation, second.operation]), { status: 409 });
  const after = await service.account(owner.identity);
  assert.deepEqual(after.data, account.data); assert.equal(after.revision, account.revision);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM operations WHERE method='consume'")).rows[0].count, 0);
});
test('reusing an operation ID with changed contents is rejected', async () => {
  const account = await initialAccount();
  const recorded = operation(account.data, owner, 'recharge', [{ memberId: account.member.id, actualPay: 20 }]).operation;
  await service.sync(owner.identity, [recorded]);
  const altered = JSON.parse(JSON.stringify(recorded)); altered.args[0].actualPay = 200;
  await assert.rejects(service.sync(owner.identity, [altered]), { status: 409 });
  assert.equal((await service.account(owner.identity)).data.members[0].balance, 12000);
});
test('two offline devices cannot both consume against the same stale observed balance', async () => {
  const account = await initialAccount(), otherDevice = await login('owner');
  const first = operation(account.data, owner, 'consume', [{ memberId: account.member.id, amount: 80 }]).operation;
  const second = operation(account.data, otherDevice, 'consume', [{ memberId: account.member.id, amount: 80 }]).operation;
  await service.sync(owner.identity, [first]);
  await assert.rejects(service.sync(otherDevice.identity, [second]), { status: 409 });
  assert.equal((await service.account(owner.identity)).data.members[0].balance, 2000);
});

test('cloud sync preserves acknowledged debt, partial repayments and reversal without duplicate deductions', async () => {
  const account = await initialAccount();
  const consumed = operation(account.data, owner, 'consume', [{ memberId: account.member.id, amount: '138.01', allowDebt: true }]);
  const result = await service.sync(owner.identity, [consumed.operation]);
  assert.equal(result.data.members[0].balance, -3801);
  assert.equal(result.data.members[0].total_consume, 13801);
  const retry = await service.sync(owner.identity, [consumed.operation]);
  assert.equal(retry.revision, result.revision);
  assert.equal(retry.data.ledgers.filter(l => l.type === 'CONSUME').length, 1);
  const recharge = operation(result.data, owner, 'recharge', [{ memberId: account.member.id, actualPay: '10.01' }]);
  const partial = await service.sync(owner.identity, [recharge.operation]);
  assert.equal(partial.data.members[0].balance, -2800);
  const reversal = operation(partial.data, owner, 'refundLedger', [recharge.data.ledgers[0].id, '还款误录', true]);
  const reversed = await service.sync(owner.identity, [reversal.operation]);
  assert.equal(reversed.data.members[0].balance, -3801);
  assert.equal((await service.account(owner.identity)).data.members[0].balance, -3801);
});

test('cloud replay rejects missing or forged debt acknowledgement and stale debt preconditions atomically', async () => {
  const account = await initialAccount();
  const debt = operation(account.data, owner, 'consume', [{ memberId: account.member.id, amount: 138, allowDebt: true }]);
  const missing = structuredClone(debt.operation); delete missing.args[0].allowDebt;
  await assert.rejects(service.sync(owner.identity, [missing]), /确认欠款/);
  const forged = structuredClone(debt.operation); forged.args[0].allowDebt = 'true';
  await assert.rejects(service.sync(owner.identity, [forged]), /布尔值/);
  assert.equal((await service.account(owner.identity)).data.members[0].balance, 10000);
  await service.sync(owner.identity, [debt.operation]);
  const stale = operation(account.data, owner, 'consume', [{ memberId: account.member.id, amount: 20 }]);
  await assert.rejects(service.sync(owner.identity, [stale.operation]), /变化|冲突|不一致/);
  assert.equal((await service.account(owner.identity)).data.members[0].balance, -3800);
});
test('independent member changes from different devices can both synchronize', async () => {
  const account = await initialAccount(), second = await login('owner');
  const newMember = operation(account.data, owner, 'createMember', [{ name: '李哥', phone: '13900002222', initialBalance: 50 }]);
  const consume = operation(account.data, second, 'consume', [{ memberId: account.member.id, amount: 20 }]);
  await service.sync(owner.identity, [newMember.operation]);
  const result = await service.sync(second.identity, [consume.operation]);
  assert.equal(result.data.members.length, 2); assert.equal(result.data.members.find(member => member.id === account.member.id).balance, 8000);
});
test('cashiers and viewers cannot bypass server permissions with a forged role', async () => {
  const account = await initialAccount();
  await service.createUser(owner.identity, { username: 'cashier', password, displayName: '店员', role: 'clerk' });
  await service.createUser(owner.identity, { username: 'viewer', password, displayName: '只读', role: 'viewer' });
  const cashier = await login('cashier'), viewer = await login('viewer');
  const restore = operation(account.data, cashier, 'importBackupData', [JSON.stringify({ data: account.data })]).operation;
  await assert.rejects(service.sync({ ...cashier.identity, role: 'owner' }, [restore]), { status: 403 });
  const consumed = operation(account.data, viewer, 'consume', [{ memberId: account.member.id, amount: 10 }]).operation;
  await assert.rejects(service.sync({ ...viewer.identity, role: 'owner' }, [consumed]), { status: 403 });
});
test('permissions are rechecked and disabled sessions cannot upload queued operations', async () => {
  const account = await initialAccount();
  await service.createUser(owner.identity, { username: 'cashier', password, displayName: '店员', role: 'clerk' });
  const cashier = await login('cashier');
  const recorded = operation(account.data, cashier, 'consume', [{ memberId: account.member.id, amount: 10 }]).operation;
  await service.updateUser(owner.identity, cashier.identity.id, { active: false, role: 'clerk' });
  await assert.rejects(service.sync(cashier.identity, [recorded]), { status: 401 });
  await assert.rejects(service.authenticate(cashier.accessToken), { status: 401 });
  await assert.rejects(service.updateUser(owner.identity, owner.identity.id, { active: false, role: 'owner' }), { status: 409 });
});
test('tenant identity comes from the session and a foreign member ID cannot reach another store', async () => {
  const account = await initialAccount();
  await service.createOwner({ username: 'other-store', password });
  const other = await login('other-store');
  const recorded = operation(account.data, other, 'consume', [{ memberId: account.member.id, amount: 10 }]).operation;
  await assert.rejects(service.sync(other.identity, [recorded]), { status: 409 });
  assert.equal((await service.account(owner.identity)).data.members[0].balance, 10000);
  assert.equal((await service.account(other.identity)).data.members.length, 0);
});
test('tampered database content fails the server integrity check', async () => {
  await initialAccount();
  await pool.query('UPDATE accounts SET integrity=$1 WHERE store_id=$2', ['bad-checksum', owner.identity.store_id]);
  await assert.rejects(service.account(owner.identity), { status: 503 });
  await assert.rejects(service.sync(owner.identity, []), { status: 503 });
});
test('unapproved origins and unauthenticated accounting requests are rejected', async () => {
  assert.equal((await api('/account', undefined, '')).status, 401);
  const response = await fetch(url + '/api/v1/account', { headers: { Origin: 'https://untrusted.example', Authorization: 'Bearer ' + owner.accessToken } });
  assert.equal(response.status, 403);
});

test('every protected HTTP route rejects a missing access token before processing its input', async () => {
  const routes = [
    ['GET', '/account'], ['GET', '/account/head'], ['POST', '/account/bootstrap'],
    ['POST', '/sync'], ['GET', '/users'], ['POST', '/users'],
    ['PATCH', '/users/' + randomUUID()], ['POST', '/auth/logout'],
    ['GET', '/activity'], ['POST', '/activity'], ['GET', '/updates/latest'],
    ['GET', '/updates/files/' + 'a'.repeat(64) + '.apk']
  ];
  for (const [method, path] of routes) {
    const response = await api(path, method === 'GET' ? undefined : {}, '', method);
    assert.equal(response.status, 401, `${method} ${path}`);
    await response.text();
  }
});

for (const role of ['owner', 'clerk', 'viewer']) {
  test(`HTTP sync checks the session's ${role} permissions for every business write method`, async () => {
    const initial = await initialAccount();
    const extra = operation(initial.data, owner, 'createMember', [{ name: '零余额会员', phone: '13800003333' }]);
    const prepared = await service.sync(owner.identity, [extra.operation]);
    const zero = prepared.data.members.find(member => member.phone === '13800003333');
    let actor = owner;
    if (role !== 'owner') {
      await service.createUser(owner.identity, { username: 'matrix-' + role, password, displayName: role, role });
      actor = await login('matrix-' + role);
    }
    const cases = [
      ['createMember', [{ name: '新会员', phone: '13800004444' }]],
      ['updateMember', [initial.member.id, { notes: '核对后的备注' }]],
      ['deleteMember', [zero.id]],
      ['recharge', [{ memberId: initial.member.id, actualPay: 10 }]],
      ['consume', [{ memberId: initial.member.id, amount: 10 }]],
      ['refundLedger', [initial.data.ledgers[0].id]],
      ['saveService', [{ name: '测试护理', price: 20 }]],
      ['deleteService', ['s1']],
      ['saveRechargeSettings', [{ giftEnabled: false, giftRate: 12.5 }]],
      ['importBackupData', [JSON.stringify({ data: prepared.data }), { mode: 'replace' }]]
    ];
    for (const [method, args] of cases) {
      const before = await service.account(owner.identity);
      const recorded = operation(before.data, actor, method, args);
      const allowed = role === 'owner' || (role === 'clerk' && ['createMember', 'updateMember', 'recharge', 'consume'].includes(method));
      const response = await api('/sync', { role: 'owner', storeId: randomUUID(), operations: [recorded.operation] }, actor.accessToken);
      assert.equal(response.status, allowed ? 200 : 403, `${role}: ${method}`);
      await response.text();
      const after = await service.account(owner.identity);
      if (allowed) {
        assert.equal(after.revision, before.revision + 1);
        assert.deepEqual(after.data, recorded.data);
      } else {
        assert.deepEqual(after, before);
      }
    }
  });
}
test('gift rules sync and reject stale or forged recharge operations without changing the account', async () => {
  const initial = await initialAccount();
  const charge = operation(initial.data, owner, 'recharge', [{ memberId: initial.member.id, actualPay: 100, giftAmount: 10 }]);
  const settings = operation(initial.data, owner, 'saveRechargeSettings', [{ giftEnabled: false, giftRate: 12.5 }]);
  const configured = await service.sync(owner.identity, [settings.operation]);
  assert.deepEqual(configured.data.rechargeSettings, { giftEnabled: false, giftRate: 12.5 });
  await assert.rejects(service.sync(owner.identity, [charge.operation]), { status: 409 });
  const forged = structuredClone(charge.operation);
  forged.precondition = mutationPrecondition(configured.data, 'recharge', forged.args);
  await assert.rejects(service.sync(owner.identity, [forged]), { status: 409 });
  delete forged.precondition.rechargeSettings;
  await assert.rejects(service.sync(owner.identity, [forged]), { status: 409 });
  const unchanged = await service.account(owner.identity);
  assert.deepEqual(unchanged.data, configured.data);
  assert.equal(unchanged.revision, configured.revision);
  assert.equal(unchanged.integrity, configured.integrity);
  const allowed = operation(configured.data, owner, 'recharge', [{ memberId: initial.member.id, actualPay: 100 }]);
  const final = await service.sync(owner.identity, [allowed.operation]);
  assert.equal(final.data.members[0].balance, 20000);
  assert.deepEqual(final.data.rechargeSettings, configured.data.rechargeSettings);
});

test('old queued recharge operations remain compatible until explicit gift settings are saved', async () => {
  const initial = await initialAccount();
  const charge = operation(initial.data, owner, 'recharge', [{ memberId: initial.member.id, actualPay: 100, giftAmount: 10 }]);
  delete charge.operation.precondition.rechargeSettings;
  const result = await service.sync(owner.identity, [charge.operation]);
  assert.equal(result.data.members[0].balance, 21000);
  assert.equal(Object.hasOwn(result.data, 'rechargeSettings'), false);
});

test('offline gift settings are captured and replayed to the cloud', async () => {
  await initialAccount(); let online = false;
  const client = await connectedClient({ online: () => online });
  localDb.saveRechargeSettings({ giftEnabled: true, giftRate: 25 });
  const member = localDb.getMembers()[0];
  localDb.recharge({ memberId: member.id, actualPay: 100, giftAmount: 25 });
  assert.equal(getCloudState().outbox.length, 2);
  online = true; await client.sync();
  assert.equal(getCloudState().outbox.length, 0);
  const account = await service.account(owner.identity);
  assert.deepEqual(account.data.rechargeSettings, { giftEnabled: true, giftRate: 25 });
  assert.equal(account.data.members[0].balance, 22500);
});

test('connection event retries are deduplicated', async () => {
  const events = [{ id: randomUUID(), type: 'offline', at: new Date().toISOString(), actorId: owner.identity.id, deviceId: owner.deviceId }];
  await service.activity(owner.identity, events); await service.activity(owner.identity, events);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE event='offline'")).rows[0].count, 1);
});

test('switching users cannot attribute the previous user connection records to the new user', async () => {
  let online = false;
  const client = await connectedClient({ online: () => online });
  const previousEvents = getCloudState().activity;
  assert.ok(previousEvents.length > 0);
  await service.createUser(owner.identity, { username: 'viewer', password, displayName: '只读', role: 'viewer' });
  await client.logout(); await client.login(url, 'viewer', password);
  const currentUserId = getCloudState().user.id;
  client.recordConnection('online'); online = true; await client.sync();
  assert.deepEqual(getCloudState().activity, previousEvents);
  const events = (await pool.query("SELECT user_id,event FROM audit_events WHERE event IN ('online','offline')")).rows;
  assert.deepEqual(events, [{ user_id: currentUserId, event: 'online' }]);
  const session = await login('viewer', getCloudState().deviceId);
  await assert.rejects(service.activity(session.identity, previousEvents), { status: 403 });
});

test('more than one batch of offline connection events remains queued until each batch is acknowledged', async () => {
  let online = false;
  const client = await connectedClient({ online: () => online });
  for (let count = 0; count < 101; count++) client.recordConnection(count % 2 ? 'online' : 'offline');
  const total = getCloudState().activity.length;
  assert.ok(total > 100);
  online = true; await client.sync();
  assert.equal(getCloudState().activity.length, total - 100);
  await client.sync(); assert.equal(getCloudState().activity.length, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE event IN ('online','offline')")).rows[0].count, total);
});
test('offline recording stores the financial operation atomically and synchronizes when connectivity returns', async () => {
  const account = await initialAccount(); let online = false;
  const client = await connectedClient({ online: () => online });
  localDb.consume({ memberId: account.member.id, amount: 38 });
  assert.equal(localDb.getMemberById(account.member.id).balance, 6200); assert.equal(getCloudState().outbox.length, 1);
  await client.sync(); assert.equal((await service.account(owner.identity)).data.members[0].balance, 10000);
  online = true; await client.sync();
  assert.equal(getCloudState().outbox.length, 0); assert.equal((await service.account(owner.identity)).data.members[0].balance, 6200);
});
test('a lost HTTP acknowledgment retries the same operation without double charging', async () => {
  const account = await initialAccount(); let loseAcknowledgment = true, online = false;
  const client = await connectedClient({ online: () => online, requestFetch: async (input, options) => {
    const response = await fetch(input, options);
    if (input.endsWith('/sync') && loseAcknowledgment) { loseAcknowledgment = false; await response.arrayBuffer(); throw new TypeError('connection dropped'); }
    return response;
  } });
  localDb.consume({ memberId: account.member.id, amount: 38 }); online = true;
  await assert.rejects(client.sync(), /本机账本/);
  assert.equal(getCloudState().outbox.length, 1); assert.equal((await service.account(owner.identity)).data.members[0].balance, 6200);
  await client.sync(); assert.equal(getCloudState().outbox.length, 0); assert.equal(localDb.getMemberById(account.member.id).balance, 6200);
});
test('local storage failure cannot drop an operation or falsely acknowledge synchronization', async t => {
  t.mock.method(console, 'error', () => {});
  const account = await initialAccount(); let online = false;
  const client = await connectedClient({ online: () => online });
  localStorage.failKey = CLOUD_STATE_KEY; localStorage.failOnce = true;
  const before = localDb.getMemberById(account.member.id).balance;
  assert.throws(() => localDb.consume({ memberId: account.member.id, amount: 38 }));
  assert.equal(localDb.getMemberById(account.member.id).balance, before); assert.equal(getCloudState().outbox.length, 0);
  localDb.consume({ memberId: account.member.id, amount: 38 }); online = true;
  localStorage.failKey = CLOUD_STATE_KEY; localStorage.failOnce = true;
  await assert.rejects(client.sync()); assert.equal(getCloudState().outbox.length, 1);
  await client.sync(); assert.equal(getCloudState().outbox.length, 0); assert.equal(localDb.getMemberById(account.member.id).balance, 6200);
});
test('a sync conflict preserves the local balance and queued records until explicitly resolved', async () => {
  const account = await initialAccount(); let online = false;
  const client = await connectedClient({ online: () => online });
  localDb.consume({ memberId: account.member.id, amount: 80 });
  const other = await login('owner'), recorded = operation(account.data, other, 'consume', [{ memberId: account.member.id, amount: 38 }]);
  await service.sync(other.identity, [recorded.operation]); online = true;
  await assert.rejects(client.sync()); assert.equal(getCloudState().status, 'conflict');
  assert.equal(getCloudState().outbox.length, 1); assert.equal(localDb.getMemberById(account.member.id).balance, 2000);
  await client.useCloudLedger(); assert.equal(localDb.getMemberById(account.member.id).balance, 6200); assert.equal(getCloudState().outbox.length, 0);
  assert.equal(JSON.parse(localStorage.getItem('hairstudio_cloud_pre_replace_v1')).cloud.outbox.length, 1);
});

test('operations entered while a response is in flight are replayed and synchronized without loss', async () => {
  const account = await initialAccount(); let online = false, release, seen;
  const inFlight = new Promise(resolve => { seen = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  let pause = true;
  const client = await connectedClient({ online: () => online, requestFetch: async (input, options) => {
    const response = await fetch(input, options);
    if (pause && input.endsWith('/sync')) { pause = false; seen(); await resume; }
    return response;
  } });
  localDb.consume({ memberId: account.member.id, amount: 10 }); online = true;
  const syncing = client.sync(); await inFlight;
  localDb.consume({ memberId: account.member.id, amount: 20 });
  release(); await syncing;
  assert.equal(localDb.getMemberById(account.member.id).balance, 7000);
  assert.equal((await service.account(owner.identity)).data.members[0].balance, 7000);
  assert.equal(getCloudState().outbox.length, 0);
});
test('a corrupted sync response cannot overwrite the ledger or clear its queued operation', async () => {
  const account = await initialAccount(); let online = false;
  const client = await connectedClient({ online: () => online, requestFetch: async (input, options) => {
    const response = await fetch(input, options);
    if (input.endsWith('/sync')) {
      const result = await response.json(); result.data.members[0].balance = 999999;
      return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return response;
  } });
  localDb.consume({ memberId: account.member.id, amount: 38 }); online = true;
  await assert.rejects(client.sync(), /校验失败/);
  assert.equal(localDb.getMemberById(account.member.id).balance, 6200); assert.equal(getCloudState().outbox.length, 1);
});
test('explicit cloud replacement rolls back both data and queued operations on storage failure', async t => {
  t.mock.method(console, 'error', () => {});
  const account = await initialAccount();
  const client = await connectedClient({ online: () => false });
  localDb.consume({ memberId: account.member.id, amount: 38 });
  localStorage.failKey = CLOUD_STATE_KEY; localStorage.failOnce = true;
  await assert.rejects(client.useCloudLedger());
  assert.equal(localDb.getMemberById(account.member.id).balance, 6200); assert.equal(getCloudState().outbox.length, 1);
});
test('update publication checks file integrity, fixed certificate and strictly increasing versions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'member-release-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true }); });
  const bytes = Buffer.from('APK fixture'), certificate = 'a'.repeat(64);
  const manifest = buildUpdateManifest(bytes, { versionCode: 2, versionName: '1.0.2', certificateSha256: certificate });
  await assert.rejects(publishRelease(pool, { ...manifest, sha256: 'b'.repeat(64) }, bytes, directory, certificate));
  await assert.rejects(publishRelease(pool, manifest, bytes, directory, 'b'.repeat(64)));
  await publishRelease(pool, manifest, bytes, directory, certificate);
  assert.equal((await publishRelease(pool, manifest, bytes, directory, certificate)).unchanged, true);
  await assert.rejects(publishRelease(pool, { ...manifest, notes: 'changed' }, bytes, directory, certificate), /必须高于/);
  const different = Buffer.from('different-apk');
  const replacement = buildUpdateManifest(different, { versionCode: 2, versionName: '1.0.2', certificateSha256: certificate });
  await assert.rejects(publishRelease(pool, replacement, different, directory, certificate), /必须高于/);
  const latest = await api('/updates/latest'); assert.equal((await latest.json()).versionCode, 2);
  const downloadServer = createApi({ service, pool, releaseDirectory: directory });
  await new Promise(resolve => downloadServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => { downloadServer.closeAllConnections(); await new Promise(resolve => downloadServer.close(resolve)); });
  const fileUrl = 'http://127.0.0.1:' + downloadServer.address().port + '/api/v1/updates/files/' + manifest.sha256 + '.apk';
  assert.equal((await fetch(fileUrl)).status, 401);
  const response = await fetch(fileUrl, { headers: { Authorization: 'Bearer ' + owner.accessToken } });
  assert.equal(response.status, 200); assert.equal(digest(Buffer.from(await response.arrayBuffer())), manifest.sha256);
});

test('release retention cleans up older physical APK files and database records beyond retention limit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'member-release-retention-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true }); });
  const certificate = 'a'.repeat(64);
  const files = [];
  for (let version = 10; version <= 13; version++) {
    const bytes = Buffer.from('APK-version-' + version);
    const manifest = buildUpdateManifest(bytes, { versionCode: version, versionName: '1.0.' + version, certificateSha256: certificate });
    await publishRelease(pool, manifest, bytes, directory, certificate, { retentionCount: 2 });
    files.push(join(directory, manifest.sha256 + '.apk'));
  }
  const { stat } = await import('node:fs/promises');
  await assert.rejects(stat(files[0]));
  await assert.rejects(stat(files[1]));
  assert.ok(await stat(files[2]));
  assert.ok(await stat(files[3]));
  const { rows } = await pool.query('SELECT version_code FROM releases WHERE version_code >= 10 ORDER BY version_code ASC');
  assert.deepEqual(rows.map(r => r.version_code), [12, 13]);
});

test('a token refresh does not erase operations recorded while secure storage is saving', async () => {
  const account = await initialAccount(); let delay = false, saved = null, seen, release;
  const saving = new Promise(resolve => { seen = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const client = await connectedClient({ online: () => false, vault: {
    load: async () => saved, clear: async () => { saved = null; },
    save: async value => { if (delay) { seen(); await resume; } saved = value; }
  } });
  delay = true;
  const refreshing = client.downloadAuthorization(); await saving;
  localDb.consume({ memberId: account.member.id, amount: 38 });
  release(); await refreshing;
  assert.equal(getCloudState().outbox.length, 1); assert.equal(localDb.getMemberById(account.member.id).balance, 6200);
});
test('logout locks the local cloud ledger immediately while remote revocation is in flight', async () => {
  const account = await initialAccount(); let seen, release;
  const inFlight = new Promise(resolve => { seen = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const client = await connectedClient({ online: () => false, requestFetch: async (input, options) => {
    const response = await fetch(input, options);
    if (input.endsWith('/auth/logout')) { seen(); await resume; }
    return response;
  } });
  const loggingOut = client.logout(); await inFlight;
  assert.equal(getCloudState().user, null);
  assert.throws(() => localDb.consume({ memberId: account.member.id, amount: 38 }), /登录/);
  release(); await loggingOut;
  assert.equal(localDb.getMemberById(account.member.id).balance, 10000);
});

test('logout with an expired access token never unlocks the ledger during refresh or revocation', async () => {
  const account = await initialAccount(); let saved = null, seen, release;
  const inFlight = new Promise(resolve => { seen = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const client = await connectedClient({ online: () => false, vault: {
    load: async () => saved, save: async value => { saved = value; }, clear: async () => { saved = null; }
  }, requestFetch: async (input, options) => {
    const response = await fetch(input, options);
    if (input.endsWith('/auth/logout') && response.ok) { seen(); await resume; }
    return response;
  } });
  const originalRefresh = saved.refreshToken;
  await pool.query("UPDATE sessions SET access_expires_at=now()-interval '1 minute'");
  const observations = [];
  const unsubscribe = client.subscribe(state => observations.push(state.user));
  const loggingOut = client.logout(); await inFlight;
  assert.equal(saved, null); assert.equal(client.snapshot().user, null);
  assert.throws(() => localDb.consume({ memberId: account.member.id, amount: 38 }), /登录/);
  release(); await loggingOut; unsubscribe();
  const lockedAt = observations.findIndex(user => user === null);
  assert.ok(lockedAt >= 0);
  assert.equal(observations.slice(lockedAt).every(user => user === null), true);
  await assert.rejects(service.refresh(originalRefresh), { status: 401 });
});

test('invalid operation, bootstrap and account inputs return client errors without changing the ledger', async () => {
  const original = await service.account(owner.identity);
  const requests = [
    ['/sync', { operations: [{ id: randomUUID(), method: 'recharge' }] }],
    ['/account/bootstrap', { id: randomUUID(), data: {} }],
    ['/users', { username: '!', password, displayName: '无效', role: 'clerk' }],
    ['/users', { username: 'valid-user', password: 'short', displayName: '无效', role: 'clerk' }]
  ];
  for (const [path, body] of requests) {
    const response = await api(path, body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'REQUEST_FAILED');
  }
  assert.deepEqual(await service.account(owner.identity), original);
});

test('a downgraded clerk can preserve and resolve offline charges after signing in again', async () => {
  const account = await initialAccount();
  const cashier = await service.createUser(owner.identity, { username: 'cashier', password, displayName: '店员', role: 'clerk' });
  let online = false;
  const client = await connectedClient({ username: 'cashier', online: () => online });
  localDb.consume({ memberId: account.member.id, amount: 38 });
  const pending = getCloudState().outbox;
  await service.updateUser(owner.identity, cashier.id, { role: 'viewer', active: true });
  online = true;
  await assert.rejects(client.sync(), { status: 401 });
  await client.login(url, 'cashier', password);
  assert.equal(getCloudState().status, 'conflict');
  assert.equal(getCloudState().conflictReason, 'permissions');
  assert.deepEqual(getCloudState().outbox, pending);
  await client.sync();
  assert.equal((await service.account(owner.identity)).data.members[0].balance, 10000);
  await client.useCloudLedger();
  assert.equal(localDb.getMemberById(account.member.id).balance, 10000);
  assert.equal(getCloudState().outbox.length, 0);
  assert.deepEqual(JSON.parse(localStorage.getItem('hairstudio_cloud_pre_replace_v1')).cloud.outbox, pending);
  assert.throws(() => localDb.consume({ memberId: account.member.id, amount: 1 }), /权限/);
  await client.unlink();
  assert.equal(getCloudState().binding, null);
});

test('a forbidden upload still exposes resolution when the subsequent account request is offline', async () => {
  const account = await initialAccount();
  let online = false, rejected = false;
  const client = await connectedClient({ online: () => online, requestFetch: async (input, options) => {
    if (input.endsWith('/sync')) { rejected = true; return new Response(JSON.stringify({ error: '权限已变化', code: 'FORBIDDEN' }), { status: 403 }); }
    if (rejected && input.endsWith('/account')) throw new TypeError('offline');
    return fetch(input, options);
  } });
  localDb.consume({ memberId: account.member.id, amount: 38 });
  const pending = getCloudState().outbox;
  online = true;
  await assert.rejects(client.sync(), { status: 403 });
  assert.equal(getCloudState().status, 'conflict');
  assert.equal(getCloudState().conflictReason, 'permissions');
  assert.deepEqual(getCloudState().outbox, pending);
  assert.equal(localDb.getMemberById(account.member.id).balance, 6200);
});

test('restoring the original role allows retained operations to synchronize without recreating them', async () => {
  const account = await initialAccount();
  const cashier = await service.createUser(owner.identity, { username: 'cashier', password, displayName: '店员', role: 'clerk' });
  let online = false;
  const client = await connectedClient({ username: 'cashier', online: () => online });
  localDb.consume({ memberId: account.member.id, amount: 38 });
  const operationId = getCloudState().outbox[0].id;
  await service.updateUser(owner.identity, cashier.id, { role: 'viewer', active: true });
  await client.login(url, 'cashier', password);
  assert.equal(getCloudState().status, 'conflict');
  await service.updateUser(owner.identity, cashier.id, { role: 'clerk', active: true });
  await client.login(url, 'cashier', password);
  assert.equal(getCloudState().status, 'pending');
  assert.equal(getCloudState().outbox[0].id, operationId);
  online = true; await client.sync();
  assert.equal(getCloudState().outbox.length, 0);
  assert.equal((await service.account(owner.identity)).data.members[0].balance, 6200);
});

for (const retry of [false, true]) test(`bootstrap competition is resolvable during ${retry ? 'a queued retry' : 'initial migration'}`, async () => {
  localDb.createMember({ name: '本机会员', phone: '13800001111', initialBalance: 100 });
  let online = false, loseRequest = retry;
  const client = await connectedClient({ online: () => online, requestFetch: async (input, options) => {
    if (loseRequest && input.endsWith('/account/bootstrap')) { loseRequest = false; throw new TypeError('offline'); }
    return fetch(input, options);
  } });
  if (retry) await assert.rejects(client.bootstrap(), { network: true });
  const other = await login('owner');
  await service.bootstrap(other.identity, { id: randomUUID(), data: localDb.readBackupState() });
  online = true;
  await assert.rejects(retry ? client.sync() : client.bootstrap(), { status: 409 });
  const pendingBootstrap = getCloudState().bootstrap;
  assert.ok(pendingBootstrap);
  assert.equal(getCloudState().status, 'conflict');
  assert.equal(getCloudState().conflictReason, 'bootstrap');
  await client.useCloudLedger();
  assert.equal(getCloudState().bootstrap, null);
  assert.deepEqual(JSON.parse(localStorage.getItem('hairstudio_cloud_pre_replace_v1')).cloud.bootstrap, pendingBootstrap);
  await client.sync();
  assert.equal(getCloudState().status, 'synced');
});

test('a lost bootstrap acknowledgment retries the original request without creating a conflict', async () => {
  localDb.createMember({ name: '本机会员', phone: '13800001111', initialBalance: 100 });
  let online = false, loseResponse = true;
  const client = await connectedClient({ online: () => online, requestFetch: async (input, options) => {
    const response = await fetch(input, options);
    if (loseResponse && input.endsWith('/account/bootstrap')) { loseResponse = false; await response.arrayBuffer(); throw new TypeError('offline'); }
    return response;
  } });
  await assert.rejects(client.bootstrap(), { network: true });
  assert.equal(getCloudState().status, 'pending');
  online = true; await client.sync();
  assert.equal(getCloudState().status, 'synced');
  assert.equal(getCloudState().bootstrap, null);
  assert.equal((await service.account(owner.identity)).revision, 1);
});

test('a cloud-bound owner can restore a corrupt ledger offline while preserving raw bytes and all pending operations', async t => {
  t.mock.method(console, 'error', () => {});
  const account = await initialAccount();
  const client = await connectedClient({ online: () => false });
  const backup = localDb.exportBackupData({ archiveSnapshot: false });
  localDb.consume({ memberId: account.member.id, amount: 38 });
  const pending = getCloudState().outbox;
  localStorage.setItem(STORAGE_KEYS.MEMBERS, '{broken');
  const original = localDb.readRecoveryState().storage;
  assert.equal(localDb.previewBackup(backup).isValid, true);
  localDb.importBackupData(backup, { mode: 'replace' });
  assert.equal(localDb.getMemberById(account.member.id).balance, 10000);
  assert.deepEqual(getCloudState().outbox, pending);
  assert.equal(getCloudState().status, 'conflict');
  assert.equal(getCloudState().conflictReason, 'recovery');
  const safety = JSON.parse(localStorage.getItem(STORAGE_KEYS.SAFETY_SNAPSHOT));
  assert.deepEqual(safety.storage, original);
  assert.deepEqual(safety.cloud.outbox, pending);
  await client.sync();
  await assert.rejects(client.uploadRecoveredLedger(), /联网/);
  assert.throws(() => localDb.consume({ memberId: account.member.id, amount: 1 }), /同步冲突/);
});

test('adopting a cloud ledger preserves corrupt local bytes and pending charges before replacement', async t => {
  t.mock.method(console, 'error', () => {});
  const account = await initialAccount();
  const client = await connectedClient({ online: () => false });
  localDb.consume({ memberId: account.member.id, amount: 38 });
  const pending = getCloudState().outbox;
  localStorage.setItem(STORAGE_KEYS.MEMBERS, '{broken');
  const original = localDb.readRecoveryState().storage;
  await client.useCloudLedger();
  assert.equal(localDb.getMemberById(account.member.id).balance, 10000);
  assert.equal(getCloudState().outbox.length, 0);
  const safety = JSON.parse(localStorage.getItem('hairstudio_cloud_pre_replace_v1'));
  assert.deepEqual(safety.storage, original);
  assert.deepEqual(safety.cloud.outbox, pending);
  assert.equal(safety.data, null);
});

test('a cloud-bound owner can recover a damaged transaction journal offline without losing pending operations', async t => {
  t.mock.method(console, 'error', () => {});
  const account = await initialAccount();
  await connectedClient({ online: () => false });
  const backup = localDb.exportBackupData({ archiveSnapshot: false });
  localDb.consume({ memberId: account.member.id, amount: 38 });
  const pending = getCloudState().outbox;
  localStorage.setItem('hairstudio_pending_write_v1', '{broken');
  const original = localDb.readRecoveryState();
  localDb.importBackupData(backup, { mode: 'replace' });
  assert.equal(localDb.getMemberById(account.member.id).balance, 10000);
  assert.deepEqual(getCloudState().outbox, pending);
  assert.equal(getCloudState().conflictReason, 'recovery');
  const safety = JSON.parse(localStorage.getItem(STORAGE_KEYS.SAFETY_SNAPSHOT));
  assert.equal(safety.pendingWrite, '{broken');
  assert.deepEqual(safety.storage, original.storage);
  assert.deepEqual(safety.cloud.outbox, pending);
});

test('explicit cloud adoption preserves a damaged journal and the original outbox before replacing them', async t => {
  t.mock.method(console, 'error', () => {});
  const account = await initialAccount();
  const client = await connectedClient({ online: () => false });
  localDb.consume({ memberId: account.member.id, amount: 38 });
  const pending = getCloudState().outbox;
  localStorage.setItem('hairstudio_pending_write_v1', '{broken');
  await client.useCloudLedger();
  assert.equal(localDb.getMemberById(account.member.id).balance, 10000);
  assert.equal(localStorage.getItem('hairstudio_pending_write_v1'), null);
  assert.equal(getCloudState().outbox.length, 0);
  const safety = JSON.parse(localStorage.getItem('hairstudio_cloud_pre_replace_v1'));
  assert.equal(safety.pendingWrite, '{broken');
  assert.deepEqual(safety.cloud.outbox, pending);
});

test('a failure to save the corrupt cloud recovery point leaves both raw data and the outbox untouched', async t => {
  t.mock.method(console, 'error', () => {});
  const account = await initialAccount();
  const client = await connectedClient({ online: () => false });
  const backup = localDb.exportBackupData({ archiveSnapshot: false });
  localDb.consume({ memberId: account.member.id, amount: 38 });
  localStorage.setItem(STORAGE_KEYS.MEMBERS, '{broken');
  const original = localDb.readRecoveryState().storage, cloud = getCloudState();
  localStorage.failKey = STORAGE_KEYS.SAFETY_SNAPSHOT; localStorage.failOnce = true;
  assert.throws(() => localDb.importBackupData(backup, { mode: 'replace' }));
  assert.deepEqual(localDb.readRecoveryState().storage, original);
  assert.deepEqual(getCloudState(), cloud);
  localStorage.failKey = 'hairstudio_cloud_pre_replace_v1'; localStorage.failOnce = true;
  await assert.rejects(client.useCloudLedger());
  assert.deepEqual(localDb.readRecoveryState().storage, original);
  assert.deepEqual(getCloudState(), cloud);
  localStorage.failKey = CLOUD_STATE_KEY; localStorage.failOnce = true;
  assert.throws(() => localDb.importBackupData(backup, { mode: 'replace' }));
  assert.deepEqual(localDb.readRecoveryState().storage, original);
  assert.deepEqual(getCloudState(), cloud);
});

test('an explicitly confirmed recovered ledger uploads atomically and retries a lost response without duplication', async t => {
  t.mock.method(console, 'error', () => {});
  const account = await initialAccount();
  let online = false, loseResponse = true;
  const client = await connectedClient({ online: () => online, requestFetch: async (input, options) => {
    const response = await fetch(input, options);
    if (loseResponse && input.endsWith('/sync')) { loseResponse = false; await response.arrayBuffer(); throw new TypeError('offline'); }
    return response;
  } });
  localDb.consume({ memberId: account.member.id, amount: 38 });
  const pending = getCloudState().outbox;
  const backup = localDb.exportBackupData({ archiveSnapshot: false });
  localStorage.setItem(STORAGE_KEYS.MEMBERS, '{broken');
  localDb.importBackupData(backup, { mode: 'replace' });
  const recovered = localDb.readBackupState();
  online = true;
  await assert.rejects(client.uploadRecoveredLedger(), { network: true });
  assert.deepEqual(JSON.parse(localStorage.getItem('hairstudio_cloud_pre_replace_v1')).cloud.outbox, pending);
  assert.equal(getCloudState().outbox.length, 1);
  assert.equal(getCloudState().outbox[0].method, 'importBackupData');
  assert.deepEqual((await service.account(owner.identity)).data, recovered);
  await assert.rejects(client.uploadRecoveredLedger(), /同步重试/);
  await client.sync();
  assert.equal(getCloudState().outbox.length, 0);
  assert.equal(getCloudState().conflictReason, null);
  assert.equal((await service.account(owner.identity)).revision, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM operations WHERE method='importBackupData'")).rows[0].count, 1);
});

test('concurrent remote changes reject a recovered snapshot without clearing the recovery operation', async t => {
  t.mock.method(console, 'error', () => {});
  const account = await initialAccount();
  let online = false, race = false;
  const client = await connectedClient({ online: () => online, requestFetch: async (input, options) => {
    if (race && input.endsWith('/sync')) {
      race = false;
      const other = await login('owner');
      const remote = await service.account(other.identity);
      const charge = operation(remote.data, other, 'consume', [{ memberId: account.member.id, amount: 20 }]);
      await service.sync(other.identity, [charge.operation]);
    }
    return fetch(input, options);
  } });
  const backup = localDb.exportBackupData({ archiveSnapshot: false });
  localStorage.setItem(STORAGE_KEYS.MEMBERS, '{broken');
  localDb.importBackupData(backup, { mode: 'replace' });
  online = true; race = true;
  await assert.rejects(client.uploadRecoveredLedger(), { status: 409 });
  assert.equal(getCloudState().status, 'conflict');
  assert.equal(getCloudState().conflictReason, 'recovery');
  assert.equal(getCloudState().outbox.length, 1);
  assert.equal((await service.account(owner.identity)).data.members[0].balance, 8000);
  assert.equal(localDb.getMemberById(account.member.id).balance, 10000);
});

test('permission changes during a recovery upload cannot replace the retained operations', async t => {
  t.mock.method(console, 'error', () => {});
  const account = await initialAccount();
  await service.createUser(owner.identity, { username: 'manager', password, displayName: '第二店主', role: 'owner' });
  const manager = await login('manager');
  let online = false, revoke = false;
  const client = await connectedClient({ online: () => online, requestFetch: async (input, options) => {
    if (revoke && input.endsWith('/account')) {
      revoke = false;
      await service.updateUser(manager.identity, owner.identity.id, { role: 'viewer', active: true });
    }
    return fetch(input, options);
  } });
  localDb.consume({ memberId: account.member.id, amount: 38 });
  const backup = localDb.exportBackupData({ archiveSnapshot: false });
  const pending = getCloudState().outbox;
  localStorage.setItem(STORAGE_KEYS.MEMBERS, '{broken');
  localDb.importBackupData(backup, { mode: 'replace' });
  online = true; revoke = true;
  await assert.rejects(client.uploadRecoveredLedger(), { status: 401 });
  assert.deepEqual(getCloudState().outbox, pending);
  assert.equal(localDb.getMemberById(account.member.id).balance, 6200);
  assert.equal((await service.account(manager.identity)).data.members[0].balance, 10000);
  await client.login(url, 'owner', password);
  assert.equal(getCloudState().conflictReason, 'recovery');
  await assert.rejects(client.uploadRecoveredLedger(), /仅店主/);
  const viewer = await login('owner', getCloudState().deviceId);
  await assert.rejects(service.sync(viewer.identity, pending), { status: 403 });
});

test('merging many service definitions synchronizes their generated IDs and preserves both ledgers', async () => {
  const account = await initialAccount(); let online = false;
  const client = await connectedClient({ online: () => online });
  const backup = JSON.parse(localDb.exportBackupData({ archiveSnapshot: false }));
  for (let index = 0; index < 12; index++) backup.data.services.push({ id: 'extra' + index, name: '服务' + index, price: 10.01 });
  const content = JSON.stringify(backup);
  assert.equal(localDb.previewBackup(content).mergeError, '');
  localDb.importBackupData(content, { mode: 'merge' });
  assert.equal(getCloudState().outbox[0].generated.ids.length, 12);
  const expected = localDb.readBackupState();
  online = true; await client.sync();
  assert.deepEqual((await service.account(owner.identity)).data, expected);
  assert.equal(localDb.getMemberById(account.member.id).balance, 10000);
  assert.equal(getCloudState().outbox.length, 0);
});

test('excess generated IDs in a restore request are rejected without any server writes', async () => {
  const account = await initialAccount();
  const restore = operation(account.data, owner, 'importBackupData', [JSON.stringify({ data: account.data }), { mode: 'replace' }]).operation;
  restore.generated.ids.push('unexpected');
  await assert.rejects(service.sync(owner.identity, [restore]), { status: 400 });
  assert.equal((await service.account(owner.identity)).revision, account.revision);
});

test('PostgreSQL concurrent charges on one observed member commit only one batch', { skip: !process.env.MEMBER_TEST_DATABASE_URL }, async () => {
  const account = await initialAccount(), other = await login('owner');
  const first = operation(account.data, owner, 'consume', [{ memberId: account.member.id, amount: 80 }]);
  const second = operation(account.data, other, 'consume', [{ memberId: account.member.id, amount: 38 }]);
  const results = await Promise.allSettled([service.sync(owner.identity, [first.operation]), service.sync(other.identity, [second.operation])]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const committed = await service.account(owner.identity);
  assert.ok([2000, 6200].includes(committed.data.members[0].balance));
  assert.equal(committed.revision, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE event='consume'")).rows[0].count, 1);
});

test('PostgreSQL concurrent changes to independent members both commit', { skip: !process.env.MEMBER_TEST_DATABASE_URL }, async () => {
  const account = await initialAccount(), other = await login('owner');
  const created = operation(account.data, owner, 'createMember', [{ name: '李哥', phone: '13900002222', initialBalance: 100 }]);
  const base = await service.sync(owner.identity, [created.operation]);
  const secondMember = base.data.members.find(member => member.id !== account.member.id);
  const first = operation(base.data, owner, 'consume', [{ memberId: account.member.id, amount: 10 }]);
  const second = operation(base.data, other, 'consume', [{ memberId: secondMember.id, amount: 20 }]);
  await Promise.all([service.sync(owner.identity, [first.operation]), service.sync(other.identity, [second.operation])]);
  const committed = await service.account(owner.identity);
  assert.equal(committed.data.members.find(member => member.id === account.member.id).balance, 9000);
  assert.equal(committed.data.members.find(member => member.id === secondMember.id).balance, 8000);
  assert.equal(committed.revision, 4);
});

test('PostgreSQL resolution fences an in-flight original transaction without duplicate accounting', { skip: !process.env.MEMBER_TEST_DATABASE_URL }, async () => {
  const account = await initialAccount();
  const op = operation(account.data, owner, 'recharge', [{ memberId: account.member.id, actualPay: 50 }]).operation;
  const [synced, resolved] = await Promise.allSettled([service.sync(owner.identity, [op]), service.resolveOperations(owner.identity, [op])]);
  assert.equal(resolved.status, 'fulfilled');
  const status = resolved.value.resolved[0].status;
  const next = await service.account(owner.identity);
  if (status === 'committed') {
    assert.equal(synced.status, 'fulfilled'); assert.equal(next.data.members[0].balance, 15000);
  } else {
    assert.equal(status, 'cancelled'); assert.equal(synced.status, 'rejected');
    assert.equal(synced.reason.code, 'OPERATION_CANCELLED'); assert.equal(next.data.members[0].balance, 10000);
  }
  assert.deepEqual((await service.resolveOperations(owner.identity, [op])).resolved, resolved.value.resolved);
});

test('PostgreSQL a recovered snapshot and a competing charge cannot overwrite each other', { skip: !process.env.MEMBER_TEST_DATABASE_URL }, async () => {
  const account = await initialAccount(), other = await login('owner');
  const recovered = operation(account.data, owner, 'consume', [{ memberId: account.member.id, amount: 10 }]).data;
  const restore = operation(account.data, owner, 'importBackupData', [JSON.stringify({ data: recovered }), { mode: 'replace' }]);
  const charge = operation(account.data, other, 'consume', [{ memberId: account.member.id, amount: 20 }]);
  const results = await Promise.allSettled([service.sync(owner.identity, [restore.operation]), service.sync(other.identity, [charge.operation])]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const committed = await service.account(owner.identity);
  assert.ok([8000, 9000].includes(committed.data.members[0].balance));
  assert.equal(committed.revision, 2);
});
