import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../http.js';
import { createRequestGuard, normalizeIP, proxyIdentity } from '../request-guard.js';

test('proxy headers cannot grant HTTPS or choose a login IP from an untrusted connection', () => {
  const request = { socket: { remoteAddress: '::ffff:192.0.2.1' }, headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '1.2.3.4' } };
  assert.equal(normalizeIP(request.socket.remoteAddress), '192.0.2.1');
  assert.throws(() => proxyIdentity(request, true, new Set(['192.0.2.2'])), { status: 400, code: 'UNTRUSTED_PROXY' });
  request.socket.remoteAddress = '::ffff:192.0.2.2';
  request.headers['x-forwarded-for'] = '1.2.3.4, 198.51.100.7';
  assert.equal(proxyIdentity(request, true, new Set(['192.0.2.2'])), '198.51.100.7');
  for (const value of ['http', 'https,http', undefined]) {
    request.headers['x-forwarded-proto'] = value;
    assert.throws(() => proxyIdentity(request, true, new Set(['192.0.2.2'])), { status: 400 });
  }
});
test('request quotas, concurrent work and limiter memory have bounded lifetimes', () => {
  let time = 0;
  const guard = createRequestGuard({ maxEntries: 2, maxActive: 2, now: () => time });
  guard.take('one', 2); guard.take('one', 2);
  assert.throws(() => guard.take('one', 2), { status: 429 });
  guard.take('two', 1); assert.throws(() => guard.take('three', 1), { status: 503 });
  const release = guard.enter('restore', 1);
  assert.throws(() => guard.enter('restore', 1), { status: 503 });
  const second = guard.enter(); assert.throws(() => guard.enter(), { status: 503 });
  release(); release(); second(); guard.enter()();
  time = 60001; guard.take('three', 1); guard.take('one', 1);
});
test('production HTTP fails closed without trusted proxies and rate limits ignore forged earlier hops', async t => {
  const rejected = createApi({ production: true });
  const accepted = createApi({ production: true, trustedProxyIPs: ['127.0.0.1'] });
  for (const server of [rejected, accepted]) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  }
  const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.7' };
  assert.equal((await fetch('http://127.0.0.1:' + rejected.address().port + '/api/health', { headers })).status, 400);
  const url = 'http://127.0.0.1:' + accepted.address().port + '/api/health';
  assert.equal((await fetch(url, { headers: { ...headers, 'x-forwarded-proto': 'http' } })).status, 400);
  for (let i = 0; i < 180; i++) assert.equal((await fetch(url, { headers: { ...headers, 'x-forwarded-for': '192.0.2.' + (i % 200 + 1) + ', 198.51.100.7' } })).status, 200);
  const limited = await fetch(url, { headers });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
});
