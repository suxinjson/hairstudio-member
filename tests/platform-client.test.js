import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformClient } from '../admin/src/api/platform-client.js';

const token = 'A'.repeat(43), expiresAt = new Date(Date.now() + 3600000).toISOString();
function storage(saved) { const values = new Map(saved ? [['member_platform_session_v1', JSON.stringify(saved)]] : []); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; }
function response(status, value) { return { ok: status < 400, status, json: async () => value, headers: new Headers({ 'X-Request-Id': 'request-id' }) }; }

test('platform sessions ignore expired storage and never send merchant credentials', async () => {
  let request;
  const client = new PlatformClient({ storage: storage({ token, expiresAt: '2000-01-01T00:00:00.000Z' }), fetch: async (url, options) => { request = { url, ...options }; return response(200, {}); } });
  assert.equal(client.token, '');
  await client.request('/stores');
  assert.equal(request.url, '/api/platform/v1/stores'); assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error');
  assert.equal(request.headers.Authorization, undefined);
});

test('platform invalidation clears only its own session and discards old in-flight responses', async () => {
  const saved = storage({ token, expiresAt }); saved.setItem('merchant_session', 'retain');
  let complete; const pending = new Promise(resolve => { complete = resolve; });
  const client = new PlatformClient({ storage: saved, fetch: () => pending });
  const result = client.request('/stores'); client.clear(); complete(response(200, [{ id: 'old-store' }]));
  await assert.rejects(result, { status: 401 });
  assert.equal(saved.getItem('member_platform_session_v1'), null); assert.equal(saved.getItem('merchant_session'), 'retain');
});

test('platform authentication errors clear credentials while permission errors retain a valid session', async () => {
  for (const status of [401, 403]) {
    const saved = storage({ token, expiresAt });
    const client = new PlatformClient({ storage: saved, fetch: async () => response(status, { error: 'denied', code: 'DENIED' }) });
    await assert.rejects(client.request('/operators'), { status, code: 'DENIED', requestId: 'request-id' });
    assert.equal(Boolean(client.token), status === 403); assert.equal(Boolean(saved.getItem('member_platform_session_v1')), status === 403);
  }
});

test('platform logout removes the local token even when the server is unreachable', async () => {
  const saved = storage({ token, expiresAt });
  const client = new PlatformClient({ storage: saved, fetch: async () => { throw new Error('network'); } });
  await assert.rejects(client.logout(), /network/);
  assert.equal(client.token, ''); assert.equal(saved.getItem('member_platform_session_v1'), null);
});
