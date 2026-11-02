import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { migrate } from '../database.js';
import { createService } from '../service.js';
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

test('passwords are salted hashes and login failures are rate limited', async () => {
  const stored = (await pool.query('SELECT password_hash FROM users WHERE username=$1', ['owner'])).rows[0].password_hash;
  assert.match(stored, /^scrypt\$/); assert.equal(stored.includes(password), false);
  for (let count = 0; count < 10; count++) await assert.rejects(service.login({ username: 'owner', password: 'wrong', deviceId: randomUUID() }, 'attacker'), { status: 401 });
  await assert.rejects(service.login({ username: 'owner', password, deviceId: randomUUID() }, 'attacker'), { status: 429 });
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
test('two offline devices cannot overspend the same observed member balance', async () => {
  const account = await initialAccount(), otherDevice = await login('owner');
  const first = operation(account.data, owner, 'consume', [{ memberId: account.member.id, amount: 80 }]).operation;
  const second = operation(account.data, otherDevice, 'consume', [{ memberId: account.member.id, amount: 80 }]).operation;
  await service.sync(owner.identity, [first]);
  await assert.rejects(service.sync(otherDevice.identity, [second]), { status: 409 });
  assert.equal((await service.account(owner.identity)).data.members[0].balance, 2000);
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
  await assert.rejects(publishRelease(pool, manifest, bytes, directory, certificate), /必须高于/);
  const latest = await api('/updates/latest'); assert.equal((await latest.json()).versionCode, 2);
  const downloadServer = createApi({ service, pool, releaseDirectory: directory });
  await new Promise(resolve => downloadServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => { downloadServer.closeAllConnections(); await new Promise(resolve => downloadServer.close(resolve)); });
  const fileUrl = 'http://127.0.0.1:' + downloadServer.address().port + '/api/v1/updates/files/' + manifest.sha256 + '.apk';
  assert.equal((await fetch(fileUrl)).status, 401);
  const response = await fetch(fileUrl, { headers: { Authorization: 'Bearer ' + owner.accessToken } });
  assert.equal(response.status, 200); assert.equal(digest(Buffer.from(await response.arrayBuffer())), manifest.sha256);
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
