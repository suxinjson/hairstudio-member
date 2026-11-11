import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceAccess } from '../src/device-access.js';
import { createCloudClient } from '../src/cloud-client.js';
import { localDb, configureCloudWrites } from '../src/storage.js';
import { getCloudState, saveCloudState } from '../src/cloud-storage.js';

function fixture() {
  let wall = Date.parse('2026-11-11T00:00:00Z'), tick = 0, saved = null, failRead = false, failSave = false;
  const vault = { load: async () => { if (failRead) throw new Error('Keystore unavailable'); return saved; },
    save: async value => { if (failSave) throw new Error('storage unavailable'); saved = structuredClone(value); } };
  const create = () => createDeviceAccess({ vault, now: () => wall, monotonic: () => tick });
  return { create, vault, advance(ms) { wall += ms; tick += ms; }, rollback(ms) { wall -= ms; },
    grant(hours = 168) { return { deviceId: 'phone-device-00001', active: true, offlineHours: hours, authorizedUntil: null, serverTime: new Date(wall).toISOString() }; },
    failRead(value) { failRead = value; }, failSave(value) { failSave = value; } };
}

test('the trial expires after seven days across restarts and clock rollback cannot restart it', async () => {
  const f = fixture(); let access = f.create(); await access.initialize();
  assert.equal(access.snapshot().allowed, true);
  f.advance(6 * 86400000); await access.checkpoint();
  access = f.create(); await access.initialize();
  f.advance(86400000); assert.equal(access.snapshot().allowed, false);
  f.rollback(3 * 86400000); await access.checkpoint();
  access = f.create(); await access.initialize(); assert.equal(access.snapshot().allowed, false);
});

test('offline leases expire, prohibited offline use locks immediately, and authorized expiry caps the lease', async () => {
  const f = fixture(), access = f.create(); await access.initialize();
  await access.accept(f.grant(1), 'phone-device-00001');
  f.advance(3600000); assert.equal(access.snapshot().allowed, false);
  await access.accept(f.grant(0), 'phone-device-00001');
  assert.equal(access.snapshot({ connected: true, loggedIn: true }).allowed, true);
  access.disconnect(); assert.equal(access.snapshot({ connected: true, loggedIn: true }).allowed, false);
  const grant = f.grant(168); grant.authorizedUntil = new Date(Date.parse(grant.serverTime) + 60000).toISOString();
  await access.accept(grant, grant.deviceId); f.advance(60000);
  assert.equal(access.snapshot({ connected: true, loggedIn: true }).allowed, false);
});

test('a disabled device stays locked offline after restarting until the server grants access again', async () => {
  const f = fixture(); let access = f.create(); await access.initialize();
  await access.accept(f.grant(), 'phone-device-00001'); await access.deny('DEVICE_DISABLED');
  access = f.create(); await access.initialize(); assert.equal(access.snapshot().allowed, false);
  await access.accept(f.grant(), 'phone-device-00001'); assert.equal(access.snapshot().allowed, true);
});

test('unreadable or unwritable authorization never grants a new trial and can be repaired online', async () => {
  const f = fixture(); f.failRead(true); const access = f.create();
  await assert.rejects(access.initialize()); assert.equal(access.snapshot().allowed, false);
  f.failRead(false); f.failSave(true);
  await assert.rejects(access.accept(f.grant(), 'phone-device-00001'));
  assert.equal(access.snapshot().allowed, false);
  f.failSave(false); await access.accept(f.grant(), 'phone-device-00001'); assert.equal(access.snapshot().allowed, true);
  await assert.rejects(access.accept(f.grant(), 'another-phone'));
});

test('expiring device authorization blocks financial writes and disabled responses preserve identity and pending work', async () => {
  const values = new Map(); globalThis.localStorage = { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,String(v)), removeItem: k => values.delete(k) };
  configureCloudWrites(null, null); localDb.init(); const member = localDb.createMember({ name: '客户', phone: '13800001111', initialBalance: 100 });
  const user = { id: 'owner-1', storeId: 'store-1', role: 'owner' }, f = fixture(), access = f.create();
  await access.initialize(); await access.accept(f.grant(1), 'phone-device-00001');
  saveCloudState({ ...getCloudState(), user, serverUrl: 'https://member.example.com', binding: { storeId: user.storeId }, deviceId: 'phone-device-00001' });
  let online = false, secure = { refreshToken: 'refresh', user, userId: user.id, storeId: user.storeId, serverUrl: 'https://member.example.com' };
  const client = createCloudClient({ allowOffline: true, deviceAccess: access, isOnline: () => online,
    vault: { load: async () => secure, save: async value => { secure = value; }, clear: async () => { secure = null; } },
    fetch: async () => Response.json({ error: '设备已禁用', code: 'DEVICE_DISABLED' }, { status: 403 }) });
  const stop = await client.start();
  try {
    localDb.consume({ memberId: member.id, amount: 10 });
    const pending = getCloudState().outbox; f.advance(3600000);
    assert.throws(() => localDb.consume({ memberId: member.id, amount: 10 }), { code: 'DEVICE_ACCESS_REQUIRED' });
    online = true; await assert.rejects(client.sync(), { code: 'DEVICE_DISABLED' });
    assert.equal(client.snapshot().deviceAccess.allowed, false);
    assert.equal(getCloudState().user.id, user.id); assert.deepEqual(getCloudState().outbox, pending);
  } finally { stop(); configureCloudWrites(null, null); }
});

test('secure storage write failure keeps a usable native session and retries saving without another login', async () => {
  const values = new Map(); globalThis.localStorage = { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,String(v)), removeItem: k => values.delete(k) };
  configureCloudWrites(null, null); localDb.init();
  const user = { id: 'owner-1', storeId: 'store-1', role: 'owner' };
  saveCloudState({ ...getCloudState(), user, serverUrl: 'https://member.example.com', deviceId: 'phone-device-00001' });
  let saved = { refreshToken: 'stable-refresh', serverUrl: 'https://member.example.com', user }, failSave = true, loginCalls = 0;
  const f = fixture(), deviceAccess = f.create(); await deviceAccess.initialize();
  const client = createCloudClient({ allowOffline: true, deviceAccess,
    vault: { load: async () => saved, save: async value => { if (failSave) throw new Error('Keystore unavailable'); saved = value; }, clear: async () => { throw new Error('must not clear session'); } },
    fetch: async url => {
      if (url.endsWith('/auth/login')) loginCalls++;
      return Response.json(url.endsWith('/auth/refresh') ? { accessToken: 'access', refreshToken: 'stable-refresh', user, authorization: f.grant() } :
        url.endsWith('/device/authorization') ? { user, authorization: f.grant() } : { ok: true });
    } });
  assert.deepEqual(await client.request('/voice/config'), { ok: true });
  assert.equal(client.snapshot().user.id, user.id); assert.equal(client.snapshot().syncLoginRequired, false);
  failSave = false; await client.sync();
  assert.equal(saved.refreshToken, 'stable-refresh'); assert.equal(saved.userId, user.id);
  assert.equal(loginCalls, 0);
});
