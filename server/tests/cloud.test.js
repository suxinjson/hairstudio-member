import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { relationalTestDatabase } from './helpers/relational-database.js';
import { createService } from './helpers/licensed-service.js';
import { createApi } from '../http.js';
import { publishRelease } from '../publish-release.js';
import { buildUpdateManifest } from '../../tools/update-manifest.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { digest } from '../security.js';
import { DATA_LIMITS } from '../../src/data-limits.js';

let database, pool, service, server, url, owner;
const password = 'Correct-Horse-Cloud-2026!';
before(async () => {
  database = await relationalTestDatabase(); pool = database.pool; service = createService(pool);
  server = createApi({ service, pool });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await database?.close();
});
beforeEach(async () => {
  await pool.query('TRUNCATE stores,login_limits,releases RESTART IDENTITY CASCADE');
  await service.createOwner({ username: 'owner', password });
  owner = await login('owner');
});

async function login(username, deviceId = randomUUID()) {
  const session = await service.login({ username, password, deviceId }, '127.0.0.1');
  return { ...session, identity: await service.authenticate(session.accessToken), deviceId };
}

async function api(path, body, accessToken = owner.accessToken, method = body === undefined ? 'GET' : 'POST') {
  return fetch(url + '/api/v1' + path, { method, headers: { ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test('store profile is owner controlled, isolated between stores and versioned separately from accounting', async () => {
  const { ledgerEpoch } = await service.relational.getBook(owner.identity);
  const before = await service.relational.getConfiguration(owner.identity, { ledgerEpoch });
  const profile = { ...owner.storeProfile, name: '安心生活馆', phone: '020-12345678', address: '幸福路1号', memberNotesLabel: '客户需求', welcomeText: '欢迎来到{store}，请说', rechargeThanks: '谢谢光临！' };
  const response = await api('/store/profile', { profile, expectedVersion: 0 }, owner.accessToken, 'PATCH');
  assert.equal(response.status, 200); const saved = await response.json();
  assert.equal(saved.version, 1);
  assert.deepEqual(await service.relational.getConfiguration(owner.identity, { ledgerEpoch }), before);
  assert.deepEqual(await service.storeProfile(owner.identity), saved);
  assert.equal((await login('owner')).storeProfile.name, profile.name);
  assert.deepEqual((await service.refresh(owner.refreshToken)).storeProfile, saved);
  await assert.rejects(service.saveStoreProfile(owner.identity, { profile, expectedVersion: 0 }), { status: 409, code: 'STORE_PROFILE_CHANGED' });
  await assert.rejects(service.saveStoreProfile(owner.identity, { expectedVersion: 1 }), { status: 400 });
  await service.createUser(owner.identity, { username: 'clerk', displayName: '店员', role: 'clerk', password });
  const clerk = await login('clerk');
  assert.deepEqual(await service.storeProfile(clerk.identity), saved);
  await assert.rejects(service.saveStoreProfile(clerk.identity, { profile, expectedVersion: 1 }), { status: 403 });
  await service.createOwner({ username: 'other-store', password, storeName: '另一家门店' });
  const other = await login('other-store');
  assert.equal(other.storeProfile.name, '另一家门店');
  await service.saveStoreProfile(other.identity, { profile: { name: '独立名称' }, expectedVersion: 0, storeId: owner.identity.store_id });
  assert.deepEqual(await service.storeProfile(owner.identity), saved);
});

test('voice configuration versions prevent stale pages from restoring switches or removed speakers', async () => {
  const identity = owner.identity, account = await service.relational.getBook(identity);
  const initial = await service.getVoiceConfig(identity);
  assert.equal(initial.version, 0);
  for (const invalidVersion of [undefined, null, '0', -1, 0.5]) {
    await assert.rejects(service.saveVoiceConfig(identity, { enabled: true }, invalidVersion), { status: 400, code: 'VOICE_CONFIG_VERSION_REQUIRED' });
  }
  const enabled = await service.saveVoiceConfig(identity, { enabled: true, aligenie: {
    enabled: true, actorId: identity.id, token: 'config-version-secret-' + randomUUID(), allowedDevices: ['speaker-a', 'speaker-b']
  } }, initial.version);
  assert.equal(enabled.version, 1);
  const pageA = await service.getVoiceConfig(identity), pageB = await service.getVoiceConfig(identity);
  const saved = await service.saveVoiceConfig(identity, { ...pageA, enabled: false,
    aligenie: { ...pageA.aligenie, allowedDevices: ['speaker-a'] } }, pageA.version);
  assert.equal(saved.version, 2);
  const beforeAudit = await service.auditLog(identity);
  const stale = await api('/voice/config', { ...pageB, expectedVersion: pageB.version, templates: { consume: '陈旧页面的新模板' } });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'VOICE_CONFIG_CHANGED');
  assert.deepEqual(await service.getVoiceConfig(identity), saved);
  assert.deepEqual(await service.auditLog(identity), beforeAudit);

  const results = await Promise.allSettled([
    service.saveVoiceConfig(identity, { templates: { consume: '页面一模板' } }, saved.version),
    service.saveVoiceConfig(identity, { templates: { consume: '页面二模板' } }, saved.version)
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'VOICE_CONFIG_CHANGED');
  const latest = await service.getVoiceConfig(identity);
  assert.equal(latest.version, 3);
  assert.equal(latest.enabled, false);
  assert.deepEqual(latest.aligenie.allowedDevices, ['speaker-a']);
  assert.deepEqual(await service.relational.getBook(identity), account);
});

test('desktop login and logout preserve independent phone and admin sessions', async () => {
  const phone = owner;
  const cashier = await login('owner', 'browser-cashier-' + randomUUID());
  const admin = await login('owner', 'browser-admin-' + randomUUID());
  assert.equal((await service.authenticate(phone.accessToken)).sessionId, phone.identity.sessionId);
  assert.equal((await service.authenticate(cashier.accessToken)).sessionId, cashier.identity.sessionId);
  assert.equal((await service.authenticate(admin.accessToken)).sessionId, admin.identity.sessionId);
  await service.logout(cashier.identity);
  await assert.rejects(service.authenticate(cashier.accessToken), error => error.status === 401);
  assert.equal((await service.authenticate(phone.accessToken)).sessionId, phone.identity.sessionId);
  assert.equal((await service.authenticate(admin.accessToken)).sessionId, admin.identity.sessionId);
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
  for (const path of ['/users']) {
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

test('refresh credentials survive retries and concurrent pages until explicit logout', async () => {
  const refreshed = await service.refresh(owner.refreshToken);
  assert.equal(refreshed.refreshToken, owner.refreshToken);
  await service.authenticate(refreshed.accessToken);
  const retries = await Promise.all([service.refresh(owner.refreshToken), service.refresh(owner.refreshToken)]);
  for (const retry of retries) {
    assert.equal(retry.accessToken, refreshed.accessToken);
    assert.equal((await service.authenticate(retry.accessToken)).id, owner.identity.id);
  }
  await service.logout(owner.identity);
  await assert.rejects(service.refresh(owner.refreshToken), { status: 401 });
  await assert.rejects(service.authenticate(refreshed.accessToken), { status: 401 });
});

test('a legacy rotated credential and its replacement both recover without revoking the phone', async () => {
  const replacement = 'legacy-replacement-' + randomUUID();
  await pool.query('UPDATE sessions SET previous_refresh_hash=refresh_hash,refresh_hash=$1 WHERE id=$2', [digest(replacement), owner.identity.sessionId]);
  const [old, current] = await Promise.all([service.refresh(owner.refreshToken, 'native'), service.refresh(replacement, 'native')]);
  assert.equal((await service.authenticate(old.accessToken)).id, owner.identity.id);
  assert.equal((await service.authenticate(current.accessToken)).id, owner.identity.id);
});

test('native sessions stay signed in beyond 30 days and more than 20 logins preserve old devices', async () => {
  const phone = await service.login({ username: 'owner', password, deviceId: randomUUID(), clientKind: 'native' }, 'local');
  const phoneIdentity = await service.authenticate(phone.accessToken);
  await pool.query("UPDATE sessions SET expires_at=now()-interval '1 day',access_expires_at=now()-interval '1 day' WHERE id=$1", [phoneIdentity.sessionId]);
  const restored = await service.refresh(phone.refreshToken);
  assert.equal((await service.authenticate(restored.accessToken)).id, owner.identity.id);
  // Avoid the password hashing loop while exercising the actual login eviction boundary.
  for (let i = 0; i < 21; i++) await pool.query(`INSERT INTO sessions(id,user_id,device_id,access_hash,refresh_hash,access_expires_at,expires_at)
    VALUES($1,$2,$3,$4,$5,now()+interval '15 minutes',now()+interval '30 days')`, [randomUUID(), owner.identity.id, randomUUID(), digest(randomUUID()), digest(randomUUID())]);
  await login('owner');
  assert.equal((await service.authenticate(restored.accessToken)).id, owner.identity.id);
});

test('refresh cannot turn a web session into a perpetual native session or revive an expired web credential', async () => {
  const before = (await pool.query('SELECT client_kind,expires_at FROM sessions WHERE id=$1', [owner.identity.sessionId])).rows[0];
  const response = await api('/auth/refresh', { refreshToken: owner.refreshToken, clientKind: 'native' }, null);
  assert.equal(response.status, 200);
  const after = (await pool.query('SELECT client_kind,expires_at FROM sessions WHERE id=$1', [owner.identity.sessionId])).rows[0];
  assert.equal(after.client_kind, 'web');
  assert.deepEqual(after.expires_at, before.expires_at);
  await pool.query("UPDATE sessions SET expires_at=now()-interval '1 day',access_expires_at=now()-interval '1 day' WHERE id=$1", [owner.identity.sessionId]);
  for (const clientKind of [undefined, 'web', 'native']) {
    const rejected = await api('/auth/refresh', { refreshToken: owner.refreshToken, clientKind, deviceFingerprint: 'a'.repeat(64) }, null);
    assert.equal(rejected.status, 401);
  }
  assert.equal((await pool.query('SELECT client_kind FROM sessions WHERE id=$1', [owner.identity.sessionId])).rows[0].client_kind, 'web');
});

test('device restrictions are tenant-scoped, enforced inside writes, and reversible without relogin', async () => {
  const ledger = service.relational;
  const { ledgerEpoch } = await ledger.getBook(owner.identity);
  const member = { id: 'security-member', name: '设备测试会员', phone: '', tags: [], notes: '', balanceCents: '10000' };
  await ledger.importOpeningBalances(owner.identity, { ledgerEpoch, batchId: randomUUID(), sourceDigest: 'a'.repeat(64), expectedCount: 1, members: [member] });
  const phone = await service.login({ username: 'owner', password, deviceId: randomUUID(), clientKind: 'native', deviceFingerprint: 'b'.repeat(64) }, 'local');
  const phoneUser = await service.authenticate(phone.accessToken);
  const devices = await service.devices(owner.identity), device = devices.find(d => d.deviceId === phoneUser.device_id);
  assert.equal(device.offlineHours, 168);
  const policy = { active: false, offlineHours: 0, authorizedUntil: null, label: '店内手机' };
  await service.updateDevice(owner.identity, device.deviceId, policy);
  await assert.rejects(service.authenticate(phone.accessToken), { code: 'DEVICE_DISABLED' });
  await assert.rejects(ledger.executeCommand(phoneUser, { id: randomUUID(), ledgerEpoch, storeId: owner.identity.store_id,
    type: 'consume', memberId: member.id, expectedAccountVersion: '1', amountCents: '100' }), { code: 'DEVICE_DISABLED' });
  assert.equal((await ledger.getMember(owner.identity, member.id, { ledgerEpoch })).balanceCents, '10000');
  await assert.rejects(ledger.getMember(phoneUser, member.id, { ledgerEpoch }), { code: 'DEVICE_DISABLED' });
  await assert.rejects(service.refresh(phone.refreshToken, 'native'), { code: 'DEVICE_DISABLED' });
  await assert.rejects(service.login({ username: 'owner', password, deviceId: randomUUID(), clientKind: 'native', deviceFingerprint: 'b'.repeat(64) }, 'local'), { code: 'DEVICE_DISABLED' });
  await service.updateDevice(owner.identity, device.deviceId, { ...policy, active: true, offlineHours: 48 });
  assert.equal((await service.refresh(phone.refreshToken, 'native')).authorization.offlineHours, 48);
  await service.updateDevice(owner.identity, device.deviceId, { ...policy, active: true, authorizedUntil: '2020-01-01T00:00:00Z' });
  await assert.rejects(ledger.getMember(phoneUser, member.id, { ledgerEpoch }), { code: 'DEVICE_EXPIRED' });
  await service.createOwner({ username: 'other-store', password });
  const outsider = await login('other-store');
  assert.deepEqual(await service.devices(outsider.identity), (await service.devices(outsider.identity)).filter(d => d.deviceId !== device.deviceId));
  await assert.rejects(service.updateDevice(outsider.identity, device.deviceId, policy), { status: 404 });
  await service.createUser(owner.identity, { username: 'device-clerk', password, displayName: '店员', role: 'clerk' });
  const clerkSession = await login('device-clerk');
  await assert.rejects(service.devices(clerkSession.identity), { status: 403 });
  await assert.rejects(service.updateDevice(clerkSession.identity, device.deviceId, policy), { status: 403 });
});

test('v2 authentication and origin checks precede handling of protected requests', async () => {
  const routes = [
    ['GET', '/api/v2/book'], ['GET', '/api/v2/members'], ['GET', '/api/v2/ledger'],
    ['POST', '/api/v2/import/openings'], ['POST', '/api/v2/commands'], ['POST', '/api/v2/tasks'],
    ['POST', '/api/v2/batches'], ['GET', '/api/v2/sync/changes'], ['GET', '/api/v2/reports/business'],
    ['GET', '/api/v2/backup/archive'], ['POST', '/api/v2/backup/archive/restore'],
    ['GET', '/api/v1/users'], ['POST', '/api/v1/users'], ['POST', '/api/v1/auth/logout'],
    ['GET', '/api/v1/devices'], ['GET', '/api/v1/activity'], ['POST', '/api/v1/activity'],
    ['GET', '/api/v1/updates/latest'], ['GET', '/api/v1/updates/files/' + 'a'.repeat(64) + '.apk']
  ];
  for (const [method, path] of routes) {
    const response = await fetch(url + path, { method, ...(method === 'POST' ? { body: 'not JSON' } : {}) });
    assert.equal(response.status, 401, method + ' ' + path);
    await response.text();
  }
  const response = await fetch(url + '/api/v2/book', { headers: { Origin: 'https://untrusted.example', Authorization: 'Bearer ' + owner.accessToken } });
  assert.equal(response.status, 403);
});

test('v2 oversized or malformed writes leave balances, receipts and member profiles unchanged', async () => {
  const { ledgerEpoch } = await service.relational.getBook(owner.identity);
  const length = DATA_LIMITS.operationBytes;
  const headers = { Authorization: 'Bearer ' + owner.accessToken, 'Content-Type': 'application/json' };
  async function overBudget(path, stream = false) {
    return new Promise((resolve, reject) => {
      const request = httpRequest(url + path, { method: 'POST', agent: false, headers: { ...headers,
        ...(stream ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': length + 17 }) } }, response => {
        let text = ''; response.setEncoding('utf8'); response.on('data', part => { text += part; });
        response.once('error', reject); response.once('end', () => resolve([response.statusCode, JSON.parse(text).code]));
      });
      request.once('error', reject); request.setTimeout(5000, () => request.destroy(new Error('no bounded HTTP rejection')));
      if (stream) { request.write(Buffer.alloc(length, 'x')); request.end('overflow'); }
      else request.flushHeaders(); // An oversized declaration must be rejected without waiting for its body.
    });
  }
  for (const path of ['/api/v2/commands', '/api/v2/tasks', '/api/v2/batches']) {
    assert.deepEqual(await overBudget(path), [413, 'DATA_LIMIT']);
    assert.equal((await fetch(url + path, { method: 'POST', headers, body: '{' })).status, 400);
  }
  assert.deepEqual(await overBudget('/api/v2/commands', true), [413, 'DATA_LIMIT']);
  assert.equal((await fetch(url + '/api/v2/commands', { method: 'POST', headers, body: Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]) })).status, 400);
  assert.deepEqual((await service.relational.listMembers(owner.identity, { ledgerEpoch })).items, []);
  for (const table of ['ledger_entries', 'ledger_command_receipts', 'application_task_receipts']) {
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ' + table)).rows[0].count, 0);
  }
});

test('the deployed HTTP router rejects retired snapshot writes even with an owner session', async () => {
  for (const [method, path] of [['GET', '/account'], ['GET', '/account/head'], ['POST', '/account/bootstrap'], ['POST', '/sync']]) {
    assert.equal((await api(path, method === 'POST' ? {} : undefined, owner.accessToken, method)).status, 404);
  }
});

test('connection event retries are deduplicated', async () => {
  const events = [{ id: randomUUID(), type: 'offline', at: new Date().toISOString(), actorId: owner.identity.id, deviceId: owner.deviceId }];
  await service.activity(owner.identity, events); await service.activity(owner.identity, events);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE event='offline'")).rows[0].count, 1);
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
  assert.deepEqual(await (await api('/updates/latest')).json(), { available: false }, 'v1 clients are never offered the v2 APK');
  const latest = await (await api('/updates/latest?channel=relational-v2')).json();
  assert.equal(latest.versionCode, 2); assert.equal(latest.channel, 'relational-v2');
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
