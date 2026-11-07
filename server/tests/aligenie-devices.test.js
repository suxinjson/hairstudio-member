import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../database.js';
import { createService } from '../service.js';
import { createApi } from '../http.js';

async function fixture(run) {
  const db = new PGlite();
  const query = (sql, params) => params ? db.query(sql, params) : sql.includes(';') ? db.exec(sql) : db.query(sql);
  const pool = { query, connect: async () => ({ query, release() {} }) };
  let server;
  try {
    await migrate(pool);
    const service = createService(pool), password = 'Device-Discovery-Test-2026!';
    await service.createOwner({ username: 'device-owner', password });
    const owner = await service.login({ username: 'device-owner', password, deviceId: randomUUID() });
    const identity = await service.authenticate(owner.accessToken), secret = 'device-secret-' + randomUUID();
    await service.saveVoiceConfig(identity, { aligenie: { enabled: true, actorId: identity.id, token: secret, allowedDevices: ['*'] } });
    server = createApi({ service, pool, production: false });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const root = `http://127.0.0.1:${server.address().port}/api/v1`;
    const call = (route, options = {}, accessToken = owner.accessToken) => fetch(root + route, {
      ...options, headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}), ...options.headers }
    });
    const body = (device = 'real-speaker', intentName = 'DefaultWelcomeIntent') => ({
      intentName, requestId: randomUUID(), sessionId: 'speaker-session',
      requestData: { deviceOpenId: device, userOpenId: 'real-user' }, utterance: intentName === 'DefaultWelcomeIntent' ? '梦飞管家' : '查询张三余额'
    });
    const post = (input, token = secret) => call('/voice/aligenie', { method: 'POST', headers: { 'x-aligenie-token': token }, body: JSON.stringify(input) }, null);
    await run({ service, pool, owner, identity, secret, password, call, body, post });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await db.close();
  }
}

test('authenticated speakers are discoverable only by their store owner and remain blocked until explicitly saved', async () => fixture(async ({service,pool,owner,identity,password,call,body,post}) => {
  const before = await service.account(identity);
  assert.equal((await call('/voice/aligenie/devices', {}, null)).status, 401);
  const denied = await post(body(), 'invalid-device-secret-' + randomUUID());
  assert.equal(denied.status, 401);
  await post({ intentName: 'DefaultWelcomeIntent' });
  await post({ ...body(), requestData: { deviceOpenId: 'missing-user-device' } });
  assert.deepEqual(await (await call('/voice/aligenie/devices')).json(), []);
  const first = body();
  assert.equal((await post(first)).status, 200);
  const retry = body('real-speaker', 'QueryMemberIntent');
  const reply = await (await post(retry)).json();
  assert.equal(JSON.parse(reply.returnValue.msgInfo).code, 'VOICE_DEVICE_UNBOUND');
  const devices = await (await call('/voice/aligenie/devices')).json();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].deviceOpenId, 'real-speaker');
  assert.equal(devices[0].requestId, retry.requestId);
  assert.equal(devices[0].intentName, 'QueryMemberIntent');
  assert.equal('credential_scope' in devices[0], false);
  assert.equal('userOpenId' in devices[0], false);
  await service.createUser(identity, { username: 'device-clerk', password, displayName: '店员', role: 'clerk' });
  const clerk = await service.login({ username: 'device-clerk', password, deviceId: randomUUID() });
  assert.equal((await call('/voice/aligenie/devices', {}, clerk.accessToken)).status, 403);
  await service.createOwner({ username: 'other-device-owner', password });
  const other = await service.login({ username: 'other-device-owner', password, deviceId: randomUUID() });
  assert.deepEqual(await (await call('/voice/aligenie/devices', {}, other.accessToken)).json(), []);
  assert.deepEqual(await service.account(identity), before);
  for (const table of ['voice_requests','voice_dialogs','operations']) assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0);
  const save = await call('/voice/config', { method: 'POST', body: JSON.stringify({ aligenie: { allowedDevices: ['real-speaker'] } }) });
  assert.equal(save.status, 200);
  assert.deepEqual(await (await call('/voice/aligenie/devices')).json(), []);
  const bound = await (await post(body('real-speaker','QueryMemberIntent'))).json();
  assert.match(bound.returnValue.reply, /未在会员库中找到/);
  assert.equal(bound.returnValue.msgInfo, '');
  assert.deepEqual(await service.account(identity), before);
}));

test('device candidates expire, are bounded, and cannot cross signing-secret rotations', async () => fixture(async ({service,pool,identity,call,body,post,secret}) => {
  for (let i=0; i<22; i++) await post(body('speaker-' + i));
  assert.equal((await (await call('/voice/aligenie/devices')).json()).length, 20);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM voice_device_candidates')).rows[0].count, 20);
  await pool.query("UPDATE voice_device_candidates SET last_seen_at=now()-interval '2 days'");
  assert.deepEqual(await (await call('/voice/aligenie/devices')).json(), []);
  const v2 = { version:'2.0',request:{requestId:randomUUID(),intent:{name:'DefaultWelcomeIntent'}},session:{sessionId:'v2-session'},
    context:{System:{device:{deviceOpenId:'v2-speaker'},user:{userOpenId:'v2-user'}}} };
  assert.equal((await post(v2)).status, 200);
  assert.deepEqual((await (await call('/voice/aligenie/devices')).json()).map(d=>d.deviceOpenId), ['v2-speaker']);
  const nextSecret = 'next-device-secret-' + randomUUID();
  await service.saveVoiceConfig(identity, { aligenie: { token: nextSecret } });
  assert.deepEqual(await (await call('/voice/aligenie/devices')).json(), []);
  assert.equal((await post(body('old-secret-speaker'), secret)).status, 401);
  assert.deepEqual(await (await call('/voice/aligenie/devices')).json(), []);
  await post(body('new-secret-speaker'), nextSecret);
  assert.deepEqual((await (await call('/voice/aligenie/devices')).json()).map(d=>d.deviceOpenId), ['new-secret-speaker']);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM voice_device_candidates')).rows[0].count, 1);
}));
