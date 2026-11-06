import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../database.js';
import { createService } from '../service.js';
import { createLocalDb } from '../../src/storage.js';
import { integrity } from '../security.js';
import { signAliGenieRequest, parseAmount, extractAmountFromUtterance, membersFromUtterance } from '../aligenie.js';
import { readVoiceConfig, synthesizeTTS } from '../voice.js';
import { assertVoiceUrl, resolveVoiceTarget, isPublicAddress, createVoiceFetch, readVoiceBody } from '../voice-network.js';

const password = 'Voice-Security-Regression-2026!';
const secret = 'new-signing-secret-' + randomUUID();
const memory = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) }; };
let db, pool, service, identity, memberId, leases = 0;
before(async () => {
  db = new PGlite(); let tail = Promise.resolve();
  pool = {
    async connect() {
      const previous = tail; let release;
      tail = new Promise(resolve => { release = resolve; }); await previous; leases++;
      return { query: (sql, params) => params ? db.query(sql, params) : sql.includes(';') ? db.exec(sql) : db.query(sql), release() { leases--; release(); } };
    },
    async query(sql, params) { const client = await this.connect(); try { return await client.query(sql, params); } finally { client.release(); } }
  };
  await migrate(pool);
});
after(() => db.close());
beforeEach(async () => {
  await pool.query('TRUNCATE stores,login_limits RESTART IDENTITY CASCADE');
  service = createService(pool);
  await service.createOwner({ username: 'owner', password });
  const login = await service.login({ username: 'owner', password, deviceId: randomUUID() }, 'local');
  identity = await service.authenticate(login.accessToken);
  const local = createLocalDb(memory()); local.init();
  local.createMember({ name: '张三', phone: '13800001234', initialBalance: 100 });
  memberId = local.readBackupState().members[0].id;
  await service.bootstrap(identity, { id: randomUUID(), data: local.readBackupState() });
  await service.saveVoiceConfig(identity, { aligenie: { enabled: true, actorId: identity.id, token: secret, allowedDevices: ['device-a', 'device-b'] } });
});
const request = (utterance, extra = {}) => ({ requestId: randomUUID(), sessionId: 'session-shared', utterance,
  context: { System: { device: { deviceOpenId: 'device-a' }, user: { userOpenId: 'voice-user' } } }, ...extra });
function send(body, instance = service, storeId = identity.store_id, key = secret) {
  const timestamp = String(Date.now());
  return instance.handleAliGenieWebhook(body, { headers: { 'x-store-id': storeId, 'x-aligenie-timestamp': timestamp,
    'x-aligenie-signature': signAliGenieRequest(key, timestamp, storeId, body) } });
}
const balance = async () => (await service.account(identity)).data.members.find(m => m.id === memberId).balance;

test('strict amounts reject partial numbers and identity numbers, preserving supported Chinese amounts', () => {
  for (const raw of ['-38', '+38', '1e3', '38.999', '38元垃圾', 'NaN', 'Infinity', '1234充值', '负三十八', '一百百', '一万五', '999999999999999999999']) assert.equal(parseAmount(raw), null, raw);
  for (const [raw, amount] of [['一百五', 150], ['一百零五', 105], ['一万二千三百四十五', 12345], ['三十八点五', 38.5], ['两百元', 200]]) assert.equal(parseAmount(raw), amount, raw);
  assert.equal(extractAmountFromUtterance('尾号1234充值'), null);
  assert.equal(extractAmountFromUtterance('张三扣款-38元', '张三'), null);
  assert.equal(extractAmountFromUtterance('尾号1234充值200元'), 200);
  const members = [{ id: 'a', name: '张三', phone: '13800001234' }, { id: 'b', name: '张三', phone: '13900001234' }];
  assert.equal(membersFromUtterance(members, '张三充值200').length, 2);
  assert.equal(membersFromUtterance(members, '尾号1234充值200').length, 2);
  assert.equal(membersFromUtterance([{ name: '张三' }, { name: '张三丰' }], '张三和张三丰充值200').length, 2);
});

test('pending confirmations and successful response receipts survive service restart and cannot be replayed with changed bodies', async () => {
  const preview = request('张三扣款38元');
  const response = await send(preview);
  assert.equal(response.confirmationRequestId, preview.requestId);
  const confirmation = request('确认', { confirmationRequestId: preview.requestId });
  const restarted = createService(pool);
  const first = await send(confirmation, restarted);
  assert.match(first.returnValue.reply, /扣款成功/);
  assert.deepEqual(await send(confirmation, createService(pool)), first);
  assert.equal(await balance(), 6200);
  await assert.rejects(send({ ...confirmation, utterance: '不确认' }), { status: 409 });
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM operations WHERE method='consume'")).rows[0].count, 1);
});

test('session IDs are isolated by device, platform user, store, and explicit preview reference', async () => {
  const preview = request('张三扣款38元'); await send(preview);
  for (const [device, user] of [['device-b', 'voice-user'], ['device-a', 'other-user']]) {
    const confirmation = request('确认', { confirmationRequestId: preview.requestId, context: { System: { device: { deviceOpenId: device }, user: { userOpenId: user } } } });
    await send(confirmation); assert.equal(await balance(), 10000);
  }
  const other = await service.createOwner({ username: 'other', password });
  const login = await service.login({ username: 'other', password, deviceId: randomUUID() }, 'local');
  const otherIdentity = await service.authenticate(login.accessToken);
  await service.saveVoiceConfig(otherIdentity, { aligenie: { enabled: true, actorId: otherIdentity.id, token: secret, allowedDevices: ['device-a'] } });
  await send(request('确认', { confirmationRequestId: preview.requestId }), service, other.storeId);
  assert.equal(await balance(), 10000);
  await send(request('确认', { confirmationRequestId: 'old-preview' }));
  assert.equal(await balance(), 10000);
  await send(request('确认', { confirmationRequestId: preview.requestId }));
  assert.equal(await balance(), 6200);
});

test('cancellation fences late confirmations even when the session has a new pending action', async () => {
  const old = request('张三扣款38元'); await send(old);
  await send(request('取消'));
  const next = request('张三充值200元'); await send(next);
  await send(request('确认', { confirmationRequestId: old.requestId }));
  assert.equal(await balance(), 10000);
  await send(request('确认', { confirmationRequestId: next.requestId }));
  assert.equal(await balance(), 32000);
});

test('bound welcomes reset new sessions and default-intent replies still cancel and confirm', async () => {
  const old = request('张三扣款38元'); await send(old);
  await send(request('梦飞管家', { intentName: 'DefaultWelcomeIntent', skillSession: { newSession: true } }));
  await send(request('确认', { intentName: 'DefaultWelcomeIntent', confirmationRequestId: old.requestId }));
  assert.equal(await balance(), 10000);
  const cancelled = request('张三扣款38元'); await send(cancelled);
  const reply = await send(request('取消', { intentName: 'DefaultWelcomeIntent' }));
  assert.match(reply.returnValue.reply, /已为您取消/);
  await send(request('确认', { confirmationRequestId: cancelled.requestId }));
  assert.equal(await balance(), 10000);
  const current = request('张三扣款38元'); await send(current);
  await send(request('确认', { intentName: 'DefaultWelcomeIntent', confirmationRequestId: current.requestId }));
  assert.equal(await balance(), 6200);
});

for (const changed of ['balance', 'archive', 'rechargeSettings', 'services']) {
  test(`confirmation rejects changes to preview ${changed}`, async () => {
    const preview = request(changed === 'rechargeSettings' ? '张三充值200元' : '张三扣款38元'); await send(preview);
    const account = await service.account(identity), data = structuredClone(account.data);
    if (changed === 'balance') data.members[0].balance = 2000;
    if (changed === 'archive') data.members[0].isArchived = true;
    if (changed === 'rechargeSettings') data.rechargeSettings = { giftEnabled: true, giftRate: 50 };
    if (changed === 'services') data.services[0].price += 1;
    await pool.query('UPDATE accounts SET data=$1,integrity=$2,revision=revision+1 WHERE store_id=$3', [data, integrity(data), identity.store_id]);
    const reply = await send(request('确认', { confirmationRequestId: preview.requestId }));
    assert.match(reply.returnValue.reply, /已变化/);
    assert.equal(await balance(), changed === 'balance' ? 2000 : 10000);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM voice_dialogs')).rows[0].count, 0);
  });
}

test('transaction failure preserves pending preview and rolls back accounting before the same confirmation retry', async () => {
  const preview = request('张三扣款38元'); await send(preview);
  const broken = { query: (...args) => pool.query(...args), async connect() {
    const client = await pool.connect();
    return { release: () => client.release(), query(sql, params) { if (sql.startsWith('INSERT INTO voice_requests')) throw new Error('receipt persistence failed'); return client.query(sql, params); } };
  } };
  const confirmation = request('确认', { confirmationRequestId: preview.requestId });
  await assert.rejects(send(confirmation, createService(broken)), /receipt persistence failed/);
  assert.equal(await balance(), 10000);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM voice_dialogs')).rows[0].count, 1);
  await send(confirmation); assert.equal(await balance(), 6200);
});

test('unsigned and legacy integrations fail closed and bound actors lose access when disabled or read-only', async () => {
  await assert.rejects(service.handleAliGenieWebhook(request('张三扣款38元')), { status: 401 });
  const preview = request('张三扣款38元'); await send(preview);
  await pool.query("UPDATE users SET role='viewer' WHERE id=$1", [identity.id]);
  await assert.rejects(send(request('确认', { confirmationRequestId: preview.requestId })), { status: 403 });
  await pool.query("UPDATE users SET role='owner',active=false WHERE id=$1", [identity.id]);
  await assert.rejects(send(request('确认', { confirmationRequestId: preview.requestId })), { status: 403 });
  const legacy = readVoiceConfig({ aligenie: { enabled: true, token: 'old-leaked-token', allowedDevices: ['device-a'] } });
  assert.equal(legacy.aligenie.enabled, false); assert.equal(legacy.aligenie.token, '');
});

test('only owners can test disabled synthesis, and no role can read saved credentials', async () => {
  await service.saveVoiceConfig(identity, { apiKey: 'new-server-only-key', enabled: false });
  const clerk = await service.createUser(identity, { username: 'clerk', password, displayName: '收银', role: 'clerk' });
  await service.createUser(identity, { username: 'viewer', password, displayName: '查看', role: 'viewer' });
  for (const username of ['owner', 'clerk', 'viewer']) {
    const session = await service.login({ username, password, deviceId: randomUUID() }, 'local');
    const user = await service.authenticate(session.accessToken), config = await service.getVoiceConfig(user);
    assert.equal(config.apiKey, ''); assert.equal(JSON.stringify(config).includes(secret), false);
    if (username !== 'owner') {
      assert.equal(config.aligenie, undefined);
      await assert.rejects(service.synthesizeVoice(user, { text: 'hello', test: true }), { status: 403 });
      await assert.rejects(service.synthesizeVoice(user, { text: 'hello' }), { status: 400 });
    }
  }
  assert.ok(clerk.id);
});

test('synthesis releases SQL connections before network IO and caps concurrency independently', async () => {
  await service.saveVoiceConfig(identity, { apiKey: 'server-only-key', enabled: true });
  let calls = 0, releaseNetwork;
  const pending = new Promise(resolve => { releaseNetwork = resolve; });
  const instance = createService(pool, { fetchFn: async () => {
    calls++;
    await pending;
    return new Response('audio', { headers: { 'content-type': 'audio/mpeg' } });
  } });
  const requests = [instance.synthesizeVoice(identity, { text: 'hello' })];
  while (calls < 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(leases, 0);
  requests.push(...Array.from({ length: 3 }, () => instance.synthesizeVoice(identity, { text: 'hello' }))); 
  while (calls < 4) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(instance.synthesizeVoice(identity, { text: 'hello' }), { code: 'VOICE_BUSY' });
  assert.equal(leases, 0); releaseNetwork(); await Promise.all(requests);
});

test('outbound targets deny SSRF, private DNS, rebinding mixed addresses, redirects, and excessive response streams', async () => {
  for (const value of ['http://api.fish.audio/v1/tts', 'https://127.0.0.1/', 'https://db/', 'https://169.254.169.254/', 'https://api.fish.audio@evil.example/']) assert.throws(() => assertVoiceUrl(value));
  for (const address of ['127.0.0.1', '10.0.0.2', '172.16.0.2', '192.168.1.2', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', '2001::1', '2002:7f00:1::', '2001:db8::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true); assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  await assert.rejects(resolveVoiceTarget(new URL('https://api.fish.audio/'), async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]), { code: 'VOICE_TARGET_FORBIDDEN' });
  await assert.rejects(createVoiceFetch({ fetchFn: async () => new Response(null, { status: 302, headers: { location: 'http://db/' } }) })('https://api.fish.audio/'), { code: 'VOICE_TARGET_FORBIDDEN' });
  await assert.rejects(readVoiceBody(new Response(new Uint8Array(100), { headers: { 'content-length': '100' } }), 20), { code: 'VOICE_RESPONSE_LIMIT' });
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(21)); c.close(); } }));
  await assert.rejects(readVoiceBody(response, 20), { code: 'VOICE_RESPONSE_LIMIT' });
  await assert.rejects(synthesizeTTS({ provider: 'heygen', apiKey: 'fresh-key', text: 'hello', fetchFn: async () => Response.json({ data: { audio_url: 'http://db/private' } }) }), { code: 'VOICE_TARGET_FORBIDDEN' });
});

test('production voice transport pins verified DNS while preserving the original HTTPS host and aborts slow DNS', async () => {
  let address, resolutions = 0;
  const transport = createVoiceFetch({
    resolve: async () => { resolutions++; return [{ address: '8.8.8.8', family: 4 }]; },
    requestFn(url, options, callback) {
      assert.equal(url.hostname, 'api.fish.audio'); assert.equal(url.protocol, 'https:');
      assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, undefined);
      options.lookup('api.fish.audio', {}, (_error, pinned, family) => { address = pinned; assert.equal(family, 4); });
      const req = new EventEmitter();
      req.end = () => {
        const response = Readable.from([Buffer.from('audio')]);
        response.statusCode = 200; response.headers = { 'content-type': 'audio/mpeg' };
        callback(response);
      };
      return req;
    }
  });
  assert.equal((await readVoiceBody(await transport('https://api.fish.audio/v1/tts'), 20)).toString(), 'audio');
  assert.equal(address, '8.8.8.8'); assert.equal(resolutions, 1);
  const controller = new AbortController();
  const stalled = createVoiceFetch({ resolve: () => new Promise(() => {}), requestFn: () => { throw new Error('must not connect'); } });
  const operation = stalled('https://api.fish.audio/v1/tts', { signal: controller.signal });
  controller.abort();
  await assert.rejects(operation, { name: 'AbortError' });
});

test('empty upstream responses are rejected without invalid Response construction', async () => {
  const empty = createVoiceFetch({ resolve: async () => [{ address: '8.8.8.8', family: 4 }], requestFn(_url, _options, callback) {
    const req = new EventEmitter(); req.end = () => {
      const response = Readable.from([]); response.statusCode = 204; response.headers = {};
      callback(response);
    }; return req;
  } });
  assert.equal((await empty('https://api.fish.audio/')).status, 204);
  await assert.rejects(synthesizeTTS({ apiKey: 'fresh-key', text: 'hello', fetchFn: empty }), { status: 502 });
});

test('expired voice previews cannot execute and must be issued again', async () => {
  const preview = request('张三扣款38元'); await send(preview);
  await pool.query("UPDATE voice_dialogs SET expires_at=now()-interval '1 second'");
  await send(request('确认', { confirmationRequestId: preview.requestId }));
  assert.equal(await balance(), 10000);
});
