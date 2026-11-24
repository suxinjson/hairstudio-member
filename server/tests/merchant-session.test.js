import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MerchantSessionClient } from '../../admin/src/api/merchant-session.js';
import { memoryStorage } from '../../tests/helpers/native-fixture.mjs';
import { createService } from './helpers/licensed-service.js';
import { relationalTestDatabase } from './helpers/relational-database.js';
import { createApi, defaultAllowedOrigins } from '../http.js';

const password = 'Synthetic-Merchant-2026!';
let database, service, server, origin, create, client, identity, send;

before(async () => {
  database = await relationalTestDatabase();
  service = createService(database.pool);
  server = createApi({ service, pool: database.pool, production: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await database?.close();
});
beforeEach(async t => {
  await database.pool.query('TRUNCATE stores,login_limits RESTART IDENTITY CASCADE');
  await service.createOwner({ username: 'merchant-owner', password });
  const storage = memoryStorage();
  send = (path, options) => fetch(origin + path, options);
  create = () => {
    const session = new MerchantSessionClient({ storage, eventTarget: null, serverOrigin: origin, fetch: (path, options) => send(path, options) });
    t.after(() => session.dispose());
    return session;
  };
  client = create();
  await client.login('merchant-owner', password);
  identity = await service.authenticate(client.accessToken.value);
});

test('two merchant tabs rotate shared credentials only once', async () => {
  const other = create();
  let rotations = 0;
  send = (path, options) => {
    if (path === '/api/v1/auth/refresh') rotations++;
    return fetch(origin + path, options);
  };
  assert.deepEqual(await Promise.all([client.refresh(), other.refresh()]), [true, true]);
  assert.equal(rotations, 1);
  assert.equal(client.accessToken.value, other.accessToken.value);
  await service.authenticate(client.accessToken.value);
});

test('a failed refresh preserves the merchant session and logout revokes it even after access expiry', async () => {
  const refreshToken = client.refreshToken.value;
  await database.pool.query("UPDATE sessions SET access_expires_at=now()-interval '1 second' WHERE id=$1", [identity.sessionId]);
  send = (path, options) => {
    if (path === '/api/v1/auth/refresh') throw new Error('connection lost');
    return fetch(origin + path, options);
  };
  await assert.rejects(client.request('/api/v2/book'), /connection lost/);
  assert.equal(client.refreshToken.value, refreshToken);
  send = (path, options) => fetch(origin + path, options);
  await client.logout();
  assert.equal(client.user.value, null);
  assert.equal(create().user.value, null);
  await assert.rejects(service.refresh(refreshToken), { status: 401 });
});

test('merchant audit export traverses its store in order and retries the same page after rate limiting', async () => {
  const { storeId } = await service.createOwner({ username: 'other-owner', password });
  await database.pool.query("INSERT INTO audit_events(store_id,event) SELECT $1,'synthetic' FROM generate_series(1,1101)", [identity.store_id]);
  await database.pool.query("INSERT INTO audit_events(store_id,event) VALUES ($1,'other_store')", [storeId]);
  const first = await client.getActivity();
  const second = await client.getActivity({ before: first.at(-1).id });
  assert.equal(first.length, 100);
  assert.equal(second.length, 100);
  assert.ok(BigInt(second[0].id) < BigInt(first.at(-1).id));
  const attempts = [];
  send = (path, options) => {
    attempts.push(path);
    if (attempts.length === 2) return Response.json({ error: 'retry' }, { status: 429, headers: { 'Retry-After': '0.001' } });
    return fetch(origin + path, options);
  };
  const rows = await client.getAllActivity();
  assert.equal(attempts[1], attempts[2]);
  assert.equal(rows.filter(row => row.event === 'synthetic').length, 1101);
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  assert.ok(!rows.some(row => row.event === 'other_store'));
  await assert.rejects(client.getActivity({ before: '-1' }), { status: 400 });
  await assert.rejects(client.getActivity({ limit: 501 }), { status: 400 });
});

test('development login permits the documented local origin and rejects unrelated origins', async () => {
  assert.deepEqual(defaultAllowedOrigins(true), ['https://localhost']);
  const options = {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5174' },
    body: JSON.stringify({ username: 'merchant-owner', password, deviceId: client.deviceId })
  };
  assert.equal((await fetch(origin + '/api/v1/auth/login', options)).status, 200);
  assert.equal((await fetch(origin + '/api/v1/auth/login', { ...options, headers: { ...options.headers, Origin: 'https://unrelated.example' } })).status, 403);
});
