import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../database.js';
import { createService } from '../service.js';
import { createPlatformService } from '../platform.js';
import { createLicenseSigner } from '../license-signer.js';
import { createApi } from '../http.js';
import { verifyOfflineLicense } from '../../src/offline-license.js';
import { LICENSE_FEATURES, OFFLINE_LICENSE_FEATURES } from '../../src/license-policy.js';
import { createDeviceAccess } from '../../src/device-access.js';
import { createRelationalNativeSession } from '../../src/relational-native-session.js';
import { createNativeWorkspace } from '../../src/relational-native-workspace.js';
import { nativeCredentials, nativeFile, memoryStorage } from '../../tests/helpers/native-fixture.mjs';
import { nextTick } from 'vue';

let db, pool, platform, service, server, url, administrator, identity, shop;
const password = 'Platform-Security-Password-2026!', deviceId = 'offline-device-1234567890';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const signer = createLicenseSigner({ privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), keyId: 'test' });
const keys = { test: signer.publicKey };
const grant = overrides => ({ active: true, permanent: false, days: 30, offlineHours: 24, features: [...LICENSE_FEATURES], expectedVersion: -1, ...overrides });
const offlineInput = overrides => ({ deviceId, username: 'local-owner', displayName: '本地店主', days: 30, permanent: false, features: [...OFFLINE_LICENSE_FEATURES], ...overrides });
before(async () => {
  db = new PGlite(); let tail = Promise.resolve();
  pool = { async connect() { const previous = tail; let release; tail = new Promise(resolve => { release = resolve; }); await previous; return { query: (sql, params) => params ? db.query(sql, params) : sql.includes(';') ? db.exec(sql) : db.query(sql), release }; }, async query(sql, params) { const client = await this.connect(); try { return await client.query(sql, params); } finally { client.release(); } } };
  await migrate(pool); platform = createPlatformService(pool, { signer }); service = createService(pool);
  server = createApi({ service, platform, pool }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); url = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.close(); });
beforeEach(async () => {
  await pool.query('TRUNCATE stores,platform_users,login_limits RESTART IDENTITY CASCADE');
  await platform.bootstrap({ username: 'platform-root', password });
  administrator = await platform.login({ username: 'platform-root', password }, '127.0.0.1'); identity = await platform.authenticate(administrator.accessToken);
  shop = await service.createOwner({ username: 'merchant-owner', password });
});
async function activate(overrides) { return platform.setLicense(identity, shop.storeId, grant(overrides)); }
async function merchant(kind = 'web') { const result = await service.login({ username: 'merchant-owner', password, deviceId, clientKind: kind }, '127.0.0.1'); return { ...result, identity: await service.authenticate(result.accessToken) }; }
function request(path, bearer = administrator.accessToken, input, method = input === undefined ? 'GET' : 'POST') { return fetch(url + path, { method, headers: { ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}), ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) }); }

test('unlicensed stores default to denied, including after rerunning the migration', async () => {
  await assert.rejects(merchant(), { status: 403, code: 'LICENSE_REQUIRED' }); await migrate(pool);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM store_licenses')).rows[0].count, 0);
  await assert.rejects(merchant(), { code: 'LICENSE_REQUIRED' });
});
test('merchant and platform sessions cannot cross their authentication boundary', async () => {
  await activate(); const owner = await merchant();
  assert.equal((await request('/api/platform/v1/stores', owner.accessToken)).status, 401);
  assert.equal((await request('/api/v1/account', administrator.accessToken)).status, 401);
  assert.equal((await request('/api/platform/v1/stores', null)).status, 401);
  assert.equal((await request('/api/platform/v1/bootstrap', null, {})).status, 401);
  assert.equal((await request('/api/ready', null)).status, 200);
});
test('platform provision creates an isolated store and owner but never silently grants a license', async () => {
  const created = await platform.createStore(identity, { username: 'new-merchant', password, displayName: '店主', storeName: '新门店' });
  assert.notEqual(created.storeId, shop.storeId);
  await assert.rejects(service.login({ username: 'new-merchant', password, deviceId }, 'local'), { code: 'LICENSE_REQUIRED' });
  const audit = await platform.logs(identity, { storeId: created.storeId }); assert.equal(audit[0].event, 'store_created');
});
test('online leases are capped by both the commercial term and merchant device policy', async () => {
  await activate({ days: 1, offlineHours: 6 }); const owner = await merchant('native');
  assert.equal(owner.authorization.offlineHours, 6); assert.equal(owner.authorization.authorizedUntil, owner.entitlements.expiresAt);
  await service.updateDevice(owner.identity, deviceId, { active: true, offlineHours: 8760, authorizedUntil: null, label: '' });
  assert.equal((await service.deviceAuthorization(owner.identity)).authorization.offlineHours, 6);
  await pool.query("UPDATE store_licenses SET starts_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE store_id=$1", [shop.storeId]);
  await assert.rejects(service.relational.getBook(owner.identity), { code: 'LICENSE_EXPIRED' });
});
test('saving feature policy preserves expiry and stale license versions cannot overwrite renewals', async () => {
  await activate(); const before = (await platform.license(identity, shop.storeId)).online;
  await platform.setLicense(identity, shop.storeId, grant({ action: 'policy', expectedVersion: 0, features: ['core'] }));
  const after = (await platform.license(identity, shop.storeId)).online;
  assert.equal(new Date(after.expires_at).toISOString(), new Date(before.expires_at).toISOString());
  await assert.rejects(platform.setLicense(identity, shop.storeId, grant({ expectedVersion: 0 })), { code: 'VERSION_CONFLICT' });
  await assert.rejects(platform.setLicense(identity, shop.storeId, grant({ expectedVersion: 1, features: ['unknown'] })), { status: 400 });
});
test('license features are checked inside financial transactions and administration methods', async () => {
  await activate(); const owner = await merchant();
  const { ledgerEpoch, storeId } = await service.relational.getBook(owner.identity);
  const operation = { id: randomUUID(), ledgerEpoch, storeId, type: 'member.create', data: { name: '未授权新增' } };
  await platform.setLicense(identity, shop.storeId, grant({ expectedVersion: 0, features: ['core'] }));
  await assert.rejects(service.relational.executeTask(owner.identity, operation), { code: 'FEATURE_DISABLED' });
  await assert.rejects(service.createUser(owner.identity, { username: 'no-staff', password, role: 'clerk', displayName: '店员' }), { code: 'FEATURE_DISABLED' });
  await assert.rejects(service.synthesizeVoice(owner.identity, { text: 'test' }), { code: 'FEATURE_DISABLED' });
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM member_profiles')).rows[0].count, 0);
});
test('platform suspension is immediate online and uses optimistic store versions', async () => {
  await activate(); const owner = await merchant();
  await platform.updateStore(identity, shop.storeId, { status: 'suspended', expectedVersion: 0 });
  await assert.rejects(service.relational.getBook(owner.identity), { code: 'STORE_DISABLED' });
  await assert.rejects(service.refresh(owner.refreshToken), { code: 'STORE_DISABLED' });
  await assert.rejects(platform.updateStore(identity, shop.storeId, { status: 'active', expectedVersion: 0 }), { code: 'VERSION_CONFLICT' });
  await platform.updateStore(identity, shop.storeId, { status: 'active', expectedVersion: 1 }); await merchant();
});
test('merchant owners cannot undo platform user disabling and stale role edits are rejected', async () => {
  await activate(); const owner = await merchant(); const clerk = await service.createUser(owner.identity, { username: 'merchant-clerk', password, role: 'clerk', displayName: '店员' });
  await platform.updateUser(identity, clerk.id, { storeId: shop.storeId, disabled: true, role: 'clerk', expectedVersion: 0 });
  await assert.rejects(platform.updateUser(identity, clerk.id, { storeId: shop.storeId, disabled: false, role: 'clerk', expectedVersion: 0 }), { code: 'VERSION_CONFLICT' });
  await service.updateUser(owner.identity, clerk.id, { active: true, role: 'clerk' });
  await assert.rejects(service.login({ username: 'merchant-clerk', password, deviceId }, 'local'), { code: 'USER_DISABLED' });
  assert.equal((await platform.users(identity, shop.storeId)).find(user => user.id === clerk.id).platform_disabled, true);
});
test('developer permissions do not imply operator or licensing authority', async () => {
  await platform.saveOperator(identity, null, { username: 'developer', password, displayName: '开发人员', role: 'developer', active: true });
  const login = await platform.login({ username: 'developer', password }, 'local'), developer = await platform.authenticate(login.accessToken);
  assert.equal((await platform.system(developer)).signer.keyId, 'test'); await platform.logs(developer);
  await assert.rejects(platform.setLicense(developer, shop.storeId, grant()), { code: 'PLATFORM_FORBIDDEN' });
  await assert.rejects(platform.operators(developer), { code: 'PLATFORM_FORBIDDEN' });
  await assert.rejects(platform.updateUser(developer, shop.userId, { storeId: shop.storeId, role: 'owner', disabled: true, expectedVersion: 0 }), { code: 'PLATFORM_FORBIDDEN' });
});
test('the last active platform superadmin cannot be disabled or demoted', async () => {
  const root = (await platform.operators(identity))[0];
  await assert.rejects(platform.saveOperator(identity, root.id, { displayName: root.displayName, role: 'developer', active: true, expectedVersion: root.version }), { status: 409 });
  await assert.rejects(platform.bootstrap({ username: 'another-root', password }), { status: 409 });
  await platform.changePassword(identity, { currentPassword: password, password: password + 'x' });
  await assert.rejects(platform.authenticate(administrator.accessToken), { status: 401 });
});
test('signed offline codes encode fixed days or perpetual terms, and reject mutation or another device', async () => {
  const result = await platform.issueOfflineLicense(identity, shop.storeId, offlineInput());
  const payload = await verifyOfflineLicense(result.code, { deviceId, keys });
  assert.equal(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt), 30 * 86400000);
  await assert.rejects(verifyOfflineLicense(result.code, { deviceId: 'different-device-00000', keys }), { code: 'LICENSE_INVALID' });
  await assert.rejects(verifyOfflineLicense(result.code, { deviceId, keys: {} }), { code: 'LICENSE_INVALID' });
  const parts = result.code.split('.'); parts[2] = Buffer.from(JSON.stringify({ ...payload, expiresAt: null })).toString('base64url');
  await assert.rejects(verifyOfflineLicense(parts.join('.'), { deviceId, keys }), { code: 'LICENSE_INVALID' });
  const permanent = await platform.issueOfflineLicense(identity, shop.storeId, offlineInput({ permanent: true, days: null }));
  assert.notEqual(permanent.payload.id, result.payload.id);
  assert.equal(permanent.payload.user.id, result.payload.user.id);
  assert.equal((await verifyOfflineLicense(permanent.code, { deviceId, keys })).expiresAt, null);
  const audit = JSON.stringify(await platform.logs(identity)); assert.equal(audit.includes(result.code), false); assert.equal(audit.includes(password), false);
});
test('offline renewal preserves the issuer identity and recovers a committed original after expiry', async t => {
  const first = await platform.issueOfflineLicense(identity, shop.storeId, offlineInput({ days: 1 }));
  let book, wall = Date.now(), tick = 0, saved = null;
  t.after(async () => book?.dispose());
  const file = await nativeFile(t), device = nativeCredentials(deviceId), storage = memoryStorage();
  const access = createDeviceAccess({ vault: { async load() { return saved; }, async save(value) { saved = structuredClone(value); } },
    licenseKeys: keys, now: () => wall, monotonic: () => tick });
  const session = createRelationalNativeSession({ device, access, isOnline: () => false });
  book = createNativeWorkspace(session, { openDriver: file.open, storage });
  await session.activateOffline(first.code, password); await nextTick(); await book.connect();
  const member = await book.submit('task', { type: 'member.create', data: { name: '续期合成会员' } }, book.getScope());
  file.failCommit('after');
  await assert.rejects(book.submit('command', { type: 'recharge', memberId: member.id, actualPayCents: '100', giftCents: '0', expectedAccountVersion: '0' }, book.getScope()), /commit response unavailable/);
  const original = book.state.pending; assert.ok(original?.local);
  wall += 86400001; tick += 86400001; session.publishAccess();
  assert.equal(session.state.deviceAccess.allowed, false);
  await session.logout();
  const renewal = await platform.issueOfflineLicense(identity, shop.storeId, offlineInput());
  assert.equal(renewal.payload.user.id, first.payload.user.id);
  await session.activateOffline(renewal.code, password); await nextTick(); await book.connect();
  assert.equal(book.state.pending.id, original.id);
  assert.equal((await book.read('getMember', member.id)).balanceCents, '100');
  const receipt = await book.retryPending();
  assert.equal(receipt.commandId, original.id);
  assert.equal(receipt.balanceAfterCents, '100');
  assert.equal(book.state.pending, null);
  assert.equal((await book.read('listLedger', {})).items.length, 1);
  const anotherDevice = await platform.issueOfflineLicense(identity, shop.storeId, offlineInput({ deviceId: 'another-device-20261125' }));
  const anotherUser = await platform.issueOfflineLicense(identity, shop.storeId, offlineInput({ username: 'another-local-owner' }));
  assert.notEqual(anotherDevice.payload.user.id, first.payload.user.id);
  assert.notEqual(anotherUser.payload.user.id, first.payload.user.id);
});

test('legacy changed-actor renewals keep uncertain originals visible and recover them without rebinding', async t => {
  const first = await platform.issueOfflineLicense(identity, shop.storeId, offlineInput());
  let book, saved = null;
  t.after(async () => book?.dispose());
  const file = await nativeFile(t), device = nativeCredentials(deviceId), storage = memoryStorage();
  const access = createDeviceAccess({ vault: { async load() { return saved; }, async save(value) { saved = structuredClone(value); } }, licenseKeys: keys });
  const session = createRelationalNativeSession({ device, access, isOnline: () => false });
  book = createNativeWorkspace(session, { openDriver: file.open, storage });
  await session.activateOffline(first.code, password); await nextTick(); await book.connect();
  const member = await book.submit('task', { type: 'member.create', data: { name: '历史续期合成会员' } }, book.getScope());
  file.failCommit('after');
  await assert.rejects(book.submit('command', { type: 'recharge', memberId: member.id, actualPayCents: '100', giftCents: '0', expectedAccountVersion: '0' }, book.getScope()), /commit response unavailable/);
  const original = book.state.pending;
  await session.logout();
  const legacy = { ...first.payload, id: randomUUID(), user: { ...first.payload.user, id: randomUUID() } };
  await session.activateOffline(signer.sign(legacy), password); await nextTick(); await book.connect();
  assert.equal(book.state.pendingError, '');
  assert.ok(book.state.pending);
  assert.equal(book.state.pending.id, original.id);
  assert.equal(book.state.pending.foreignIdentity, true);
  await assert.rejects(book.submit('task', { type: 'member.create', data: { name: '尚不能换号重做' } }, book.getScope()), { code: 'PENDING_IN_PROGRESS' });
  await assert.rejects(book.repository.getCommand(original.id, { ledgerEpoch: original.ledgerEpoch }), { code: 'COMMAND_NOT_FOUND' });
  const receipt = await book.retryPending();
  assert.equal(receipt.commandId, original.id);
  assert.equal(book.state.pending, null);
  const backup = await book.repository.exportBackup();
  assert.equal(backup.tables.command_receipts.find(row => row.command_id === original.id).actor_id, first.payload.user.id);
  assert.equal((await book.read('getMember', member.id)).balanceCents, '100');
});

test('offline signing is unavailable without a configured private key and fails closed', async () => {
  const unsigned = createPlatformService(pool, { signer: null });
  await assert.rejects(unsigned.issueOfflineLicense(identity, shop.storeId, offlineInput()), { code: 'SIGNER_UNAVAILABLE' });
  await assert.rejects(platform.issueOfflineLicense(identity, shop.storeId, offlineInput({ days: -1 })), { status: 400 });
});
test('offline activation, login, SQLite restart, expiry and logout work without a single network request', async t => {
  const { code } = await platform.issueOfflineLicense(identity, shop.storeId, offlineInput({ days: 1 }));
  let wall = Date.now(), tick = 0, networkCalls = 0;
  const device = nativeCredentials(deviceId), file = await nativeFile(t), storage = memoryStorage();
  const accessVault = { async load() { return JSON.parse((await device.loadAccess()).access); },
    async save(value) { await device.saveAccess({ access: JSON.stringify(value) }); } };
  const create = () => {
    const access = createDeviceAccess({ vault: accessVault, licenseKeys: keys, now: () => wall, monotonic: () => tick });
    const client = createRelationalNativeSession({ device, access, isOnline: () => false, fetch: async () => { networkCalls++; throw new Error('No network'); } });
    return { client, book: createNativeWorkspace(client, { openDriver: file.open, storage }) };
  };
  let pair = create();
  try {
    await pair.client.init();
    assert.equal(pair.client.state.deviceAccess.allowed, false);
    await assert.rejects(pair.book.submit('task', { type: 'member.create', data: { name: '未登录' } }), { code: 'AUTH_CONTEXT_CHANGED' });
    await pair.client.activateOffline(code, password); await nextTick(); await pair.book.connect();
    assert.equal(pair.book.mode, 'standalone');
    const member = await pair.book.submit('task', { type: 'member.create', data: { name: '离线会员', phone: '13800001111' } }, pair.book.getScope());
    await pair.book.submit('command', { type: 'recharge', memberId: member.id, expectedAccountVersion: '0', actualPayCents: '10000' }, pair.book.getScope());
    await pair.book.submit('command', { type: 'consume', memberId: member.id, expectedAccountVersion: '1', amountCents: '1000' }, pair.book.getScope());
    await pair.client.logout(); assert.equal(pair.client.state.deviceAccess.allowed, false);
    await assert.rejects(pair.book.read('getMember', member.id), { code: 'AUTH_CONTEXT_CHANGED' });
    await assert.rejects(pair.client.loginOffline('local-owner', password + 'bad'));
    await pair.client.loginOffline('local-owner', password); await pair.book.dispose(); pair = create(); await pair.client.init(); await nextTick(); await pair.book.connect();
    assert.equal(pair.client.state.deviceAccess.allowed, true); assert.equal((await pair.book.read('getMember', member.id)).balanceCents, '9000');
    wall += 2 * 86400000; tick += 2 * 86400000;
    pair.client.publishAccess();
    assert.equal(pair.client.state.deviceAccess.allowed, false);
    await assert.rejects(pair.book.read('getMember', member.id), { code: 'AUTH_CONTEXT_CHANGED' });
    assert.equal(networkCalls, 0);
  } finally { await pair.book.dispose(); }
});
test('a platform-disabled owner cannot count as the remaining usable merchant administrator', async () => {
  await activate(); const owner = await merchant();
  const second = await service.createUser(owner.identity, { username: 'disabled-owner', displayName: '停用店主', role: 'owner', password });
  await platform.updateUser(identity, second.id, { storeId: shop.storeId, disabled: true, role: 'owner', expectedVersion: 0 });
  await assert.rejects(service.updateUser(owner.identity, owner.user.id, { active: true, role: 'viewer' }), { status: 409 });
  const remaining = (await platform.users(identity, shop.storeId)).find(user => user.id === owner.user.id);
  assert.equal(remaining.role, 'owner'); assert.equal(remaining.active, true); assert.equal(remaining.platform_disabled, false);
});

test('audit paging is bounded, ordered and excludes the cursor record', async () => {
  for (let i = 0; i < 3; i++) await activate({ expectedVersion: i - 1 });
  const first = await platform.logs(identity, { limit: 2 }), second = await platform.logs(identity, { limit: 2, before: String(first.at(-1).id) });
  assert.equal(first.length, 2); assert.ok(BigInt(first.at(-1).id) > BigInt(second[0].id));
  await assert.rejects(platform.logs(identity, { limit: 1000 }), { status: 400 });
  await assert.rejects(platform.logs(identity, { before: '1 OR 1=1' }), { status: 400 });
});
