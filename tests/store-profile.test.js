import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalDb, STORAGE_KEYS } from '../src/storage.js';
import { normalizeStoreProfile, latestStoreProfile, storeWelcome, storeFilePrefix, APP_NAME } from '../src/store-profile.js';
import { AdminApiClient } from '../admin/src/api/client.js';

test('fresh installations use a generic name and no industry service presets; saved services survive initialization', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const db = createLocalDb(storage); db.init();
  assert.equal(APP_NAME, '会员管家'); assert.deepEqual(db.getServices(), []);
  const services = [{ id: 'existing', name: '原店项目', price: 38 }];
  storage.setItem(STORAGE_KEYS.SERVICES, JSON.stringify(services)); db.init();
  assert.deepEqual(db.getServices(), services);
});

test('store settings validate fields and supply configurable speech and safe export names', () => {
  const profile = normalizeStoreProfile({ name: '安心门店', welcomeText: '欢迎来到{store}，请说', version: 5 });
  assert.equal(storeWelcome(profile), '欢迎来到安心门店，请说');
  assert.equal(storeFilePrefix({ name: '安心/门店:一楼' }), '安心_门店_一楼');
  for (const value of [null, [], { name: '' }, { phone: 138 }, { address: 'x'.repeat(257) }, { name: '坏\u0000店名' }]) assert.throws(() => normalizeStoreProfile(value));
  assert.equal(latestStoreProfile(profile, { name: '旧名称', version: 4 }).name, '安心门店');
});

test('multiple browser pages retain current store settings, reject stale writes and isolate account switches', async () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  let profile = normalizeStoreProfile({ name: '门店A' });
  const fetch = async (path, options = {}) => {
    assert.equal(path, '/api/v1/store/profile');
    if (options.method === 'PATCH') {
      const input = JSON.parse(options.body);
      if (input.expectedVersion !== profile.version) return Response.json({ error: '请重新加载后核对', code: 'STORE_PROFILE_CHANGED' }, { status: 409 });
      profile = normalizeStoreProfile({ ...input.profile, version: profile.version + 1 });
    }
    return Response.json(profile);
  };
  const create = () => new AdminApiClient({ storage, fetch, eventTarget: null, serverOrigin: 'https://member.example.com' });
  const user = { id: 'owner-A', storeId: 'store-A', role: 'owner' };
  const first = create(); first.saveSession({ accessToken: 'a', refreshToken: 'r', user, storeProfile: profile }, false);
  const deadline = first.idleExpiresAt.value, second = create();
  await first.saveStoreProfile({ name: '修改后的门店A' }, 0);
  second.restoreSession(); assert.equal(second.storeProfile.value.name, '修改后的门店A');
  assert.equal(second.idleExpiresAt.value, deadline);
  await assert.rejects(second.saveStoreProfile({ name: '旧页面未保存' }, 0), { status: 409 });
  assert.equal((await second.loadStoreProfile()).name, '修改后的门店A');
  first.keepStoreProfile({ name: '旧响应', version: 0 });
  assert.equal(first.storeProfile.value.name, '修改后的门店A');
  first.saveSession({ accessToken: 'b', refreshToken: 'rb', user: { ...user, id: 'owner-B', storeId: 'store-B' }, storeProfile: { name: '门店B' } }, false);
  second.restoreSession(); assert.equal(second.storeProfile.value.name, '门店B');
  second.clearSession(); assert.equal(second.storeProfile.value.name, '我的门店');
});
