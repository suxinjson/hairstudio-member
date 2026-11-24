import { LICENSE_FEATURES } from '../src/license-policy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceAccess } from '../src/device-access.js';

function fixture() {
  let wall = Date.parse('2026-11-11T00:00:00Z'), tick = 0, saved = null, failRead = false, failSave = false;
  const vault = { load: async () => { if (failRead) throw new Error('Keystore unavailable'); return saved; },
    save: async value => { if (failSave) throw new Error('storage unavailable'); saved = structuredClone(value); } };
  const create = () => createDeviceAccess({ vault, now: () => wall, monotonic: () => tick });
  return { create, vault, advance(ms) { wall += ms; tick += ms; }, rollback(ms) { wall -= ms; },
    grant(hours = 168) { return { deviceId: 'phone-device-00001', active: true, features: [...LICENSE_FEATURES], offlineHours: hours, authorizedUntil: null, serverTime: new Date(wall).toISOString() }; },
    failRead(value) { failRead = value; }, failSave(value) { failSave = value; } };
}

test('anonymous access never creates a trial, including across restarts and clock rollback', async () => {
  const f = fixture(); let access = f.create(); await access.initialize();
  assert.equal(access.snapshot({ loggedIn: true }).allowed, false);
  f.advance(6 * 86400000); await access.checkpoint();
  access = f.create(); await access.initialize();
  f.advance(86400000); assert.equal(access.snapshot({ loggedIn: true }).allowed, false);
  f.rollback(3 * 86400000); await access.checkpoint();
  access = f.create(); await access.initialize(); assert.equal(access.snapshot({ loggedIn: true }).allowed, false);
});

test('offline leases expire, prohibited offline use locks immediately, and authorized expiry caps the lease', async () => {
  const f = fixture(), access = f.create(); await access.initialize();
  await access.accept(f.grant(1), 'phone-device-00001');
  f.advance(3600000); assert.equal(access.snapshot({ loggedIn: true }).allowed, false);
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
  access = f.create(); await access.initialize(); assert.equal(access.snapshot({ loggedIn: true }).allowed, false);
  await access.accept(f.grant(), 'phone-device-00001'); assert.equal(access.snapshot({ loggedIn: true }).allowed, true);
});

test('unreadable or unwritable authorization never grants a new trial and can be repaired online', async () => {
  const f = fixture(); f.failRead(true); const access = f.create();
  await assert.rejects(access.initialize()); assert.equal(access.snapshot({ loggedIn: true }).allowed, false);
  f.failRead(false); f.failSave(true);
  await assert.rejects(access.accept(f.grant(), 'phone-device-00001'));
  assert.equal(access.snapshot({ loggedIn: true }).allowed, false);
  f.failSave(false); await access.accept(f.grant(), 'phone-device-00001'); assert.equal(access.snapshot({ loggedIn: true }).allowed, true);
  await assert.rejects(access.accept(f.grant(), 'another-phone'));
});
