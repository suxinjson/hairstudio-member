import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nativeCredentials } from './helpers/native-fixture.mjs';
import { createDeviceAccess } from '../src/device-access.js';
import { createRelationalNativeSession } from '../src/relational-native-session.js';
import { LICENSE_FEATURES } from '../src/license-policy.js';
import { memoryStorage } from './helpers/native-fixture.mjs';

const origin = 'https://native.example.test';

test('standalone owner profile persists across restart, rejects stale versions and enforces role and feature permissions', async () => {
  const device = nativeCredentials(randomUUID()), storage = memoryStorage();
  const claims = { id: 'local-license', storeId: 'offline-profile-store', storeName: '许可门店', user: { id: 'offline-owner', storeId: 'offline-profile-store', role: 'owner' } };
  let features = [...LICENSE_FEATURES];
  const access = { initialize: async () => {}, localLicense: () => claims, cachedUser: () => claims.user, snapshot: () => ({ allowed: true, features }), assert() {}, inspectOffline: async () => claims, activateOffline: async () => claims };
  const create = () => createRelationalNativeSession({ device, storage, access, isOnline: () => false });
  const session = create(); await session.activateOffline('synthetic-license', 'synthetic-password');
  const result = await session.saveStoreProfile({ ...session.state.storeProfile, name: '离线新门店', memberNotesLabel: '注意事项' }, 0);
  assert.equal(result.version, 1);
  const restarted = create(); await restarted.init(); assert.equal(restarted.state.storeProfile.name, '离线新门店'); assert.equal((await restarted.loadStoreProfile()).memberNotesLabel, '注意事项');
  await assert.rejects(restarted.saveStoreProfile(result, 0), { code: 'STORE_PROFILE_CHANGED' });
  restarted.state.user = { ...restarted.state.user, role: 'viewer' };
  await assert.rejects(restarted.saveStoreProfile(result, 1), { code: 'FORBIDDEN' });
  restarted.state.user = { ...restarted.state.user, role: 'owner' }; features = ['core', 'members'];
  await assert.rejects(restarted.saveStoreProfile(result, 1), { code: 'FORBIDDEN' });
  assert.equal(JSON.parse(storage.getItem('hairstudio_v2_store_profile:' + claims.storeId)).name, '离线新门店');
});

function fixture() {
  const deviceId = randomUUID(), ledgerEpoch = randomUUID();
  const device = nativeCredentials(deviceId);
  const user = { id: 'native-owner', storeId: 'native-store', role: 'owner' };
  let online = true, clock = Date.now(), saved = null, revoked = false, failSession = false, logins = 0, refreshes = 0, expireSpeech = false;
  const credentials = { ...device, async saveSession(value) {
    if (failSession) throw new Error('Keystore not ready');
    return device.saveSession(value);
  } };
  const grant = () => ({ user, deviceId, active: true, features: LICENSE_FEATURES, offlineHours: 1, authorizedUntil: null, serverTime: new Date(clock).toISOString() });
  const auth = token => ({ user, authorization: grant(), refreshToken: 'refresh-' + token, accessToken: 'access-' + token });
  const create = () => createRelationalNativeSession({ device: credentials, isOnline: () => online,
    access: createDeviceAccess({ vault: { async load() { return saved; }, async save(data) { saved = structuredClone(data); } }, now: () => clock }),
    async fetch(url, options) {
      const { pathname } = new URL(url);
      if (pathname === '/api/v1/auth/login') return Response.json(auth(++logins));
      if (pathname === '/api/v2/book') return Response.json({ storeId: user.storeId, ledgerEpoch });
      if (revoked) return Response.json({ code: 'DEVICE_DISABLED', error: '设备已禁用' }, { status: 403 });
      if (pathname === '/api/v1/device/authorization') return Response.json({ user, authorization: grant() });
      if (pathname === '/api/v1/auth/refresh') return Response.json(auth('rotation-' + ++refreshes));
      if (pathname === '/api/v1/voice/synthesize') {
        if (expireSpeech) { expireSpeech = false; return Response.json({}, { status: 401 }); }
        assert.equal(options.headers.Authorization, 'Bearer access-rotation-1');
        assert.deepEqual(JSON.parse(options.body), { text: '测试语音' });
        return new Response('test-audio', { headers: { 'Content-Type': 'audio/mpeg' } });
      }
      throw new Error('Unexpected native route: ' + pathname);
    } });
  return { create, device, user, get logins() { return logins; }, get refreshes() { return refreshes; },
    online(value) { online = value; }, advance(ms) { clock += ms; }, revoke() { revoked = true; }, expireSpeech() { expireSpeech = true; },
    failSession(value) { failSession = value; } };
}

test('native refresh retries audio with updated credentials and no provider secret', async () => {
  const f = fixture(), client = f.create();
  await client.login(origin, 'native-owner', 'synthetic-password');
  f.expireSpeech();
  const audio = await client.synthesizeVoice({ text: '测试语音' });
  assert.equal(await audio.text(), 'test-audio');
  assert.equal(f.refreshes, 1);
});

test('native token storage can recover without another login, while expiry and revocation prevent access', async () => {
  const f = fixture(), client = f.create(), scope = { mode: 'cloud', storeId: f.user.storeId };
  f.failSession(true);
  await client.login(origin, 'native-owner', 'synthetic-password');
  assert.equal(client.authorize(scope).id, f.user.id);
  assert.equal((await f.device.loadSession()).session, null);
  f.failSession(false);
  await client.heartbeat();
  assert.equal(f.logins, 1);
  assert.equal(JSON.parse((await f.device.loadSession()).session).user.id, f.user.id);
  f.online(false);
  await client.heartbeat();
  f.advance(3600000);
  assert.throws(() => client.authorize(scope));
  f.online(true); f.revoke();
  await assert.rejects(client.heartbeat(), { code: 'DEVICE_DISABLED' });
  assert.equal((await f.device.loadSession()).session, null);
  const reopened = f.create(); await reopened.init();
  assert.throws(() => reopened.authorize(scope));
  assert.equal(reopened.state.binding.storeId, f.user.storeId);
});
