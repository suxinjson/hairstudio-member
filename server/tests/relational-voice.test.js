import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createService } from './helpers/licensed-service.js';
import { relationalTestDatabase } from './helpers/relational-database.js';
import { createApi } from '../http.js';
import { signAliGenieRequest } from '../aligenie.js';
import { digest } from '../security.js';

const password = 'Voice-Relational-Fixture-2026!';
const secret = 'test-voice-' + randomUUID();
const voiceDevice = 'voice-' + digest('device-a');
const services = [{ id: 'trim', name: '精剪', priceCents: '3850' }, { id: 'wash', name: '洗发', priceCents: '1500' }];
const giftPolicy = { giftEnabled: true, giftRateBasisPoints: 1250 };
let database, pool, service, ledger, identity, epoch, storeId;

before(async () => { database = await relationalTestDatabase(); pool = database.pool; });
after(() => database?.close());
const configuration = (changes = {}) => ledger.updateConfiguration(identity, {
  expectedVersion: '1', services, rechargePlans: [], rechargeSettings: giftPolicy, ...changes
}, { id: randomUUID(), storeId, ledgerEpoch: epoch });
const actorConfig = () => ({ aligenie: { enabled: true, actorId: identity.id, token: secret, allowedDevices: ['device-a', 'device-b'] } });
beforeEach(async () => {
  await pool.query('TRUNCATE stores,login_limits RESTART IDENTITY CASCADE');
  service = createService(pool); ledger = service.relational;
  ({ storeId } = await service.createOwner({ username: 'voice-v2-owner', password }));

  const session = await service.login({ username: 'voice-v2-owner', password, deviceId: randomUUID() }, '127.0.0.1');
  identity = await service.authenticate(session.accessToken); ({ ledgerEpoch: epoch } = await ledger.getBook(identity));
  await ledger.importOpeningBalances(identity, { ledgerEpoch: epoch, batchId: randomUUID(), sourceDigest: 'a'.repeat(64), expectedCount: 3, members: [
    { id: 'primary', name: '合成张三', phone: '138-0000-1234', tags: [], notes: '合成备注', balanceCents: '10000' },
    { id: 'other', name: '合成张三丰', phone: '138-0000-1235', tags: [], notes: '', balanceCents: '0' },
    { id: 'big', name: '高余额会员', phone: '13800007777', tags: [], notes: '', balanceCents: '900719925474099301' }
  ] });
  await configuration({ expectedVersion: '0' });
  await service.saveVoiceConfig(identity, actorConfig(), 0);
});

const request = (utterance, extra = {}) => ({ requestId: randomUUID(), sessionId: 'voice-v2-session', utterance,
  requestData: { deviceOpenId: 'device-a', userOpenId: 'platform-user-a' }, ...extra });
const confirm = (preview, extra = {}) => request('是的', { sessionId: preview.sessionId, confirmationRequestId: preview.requestId, ...extra });
function send(body, instance = service, key = secret) {
  const timestamp = String(Date.now());
  return instance.handleAliGenieWebhook(body, { headers: { 'x-store-id': storeId, 'x-aligenie-timestamp': timestamp,
    'x-aligenie-signature': signAliGenieRequest(key, timestamp, storeId, body) } });
}
const reply = value => value.returnValue.reply;
const balance = async (id = 'primary') => (await ledger.getMember(identity, id)).balanceCents;
const dialog = async () => (await pool.query('SELECT pending FROM voice_dialogs WHERE store_id=$1', [storeId])).rows[0]?.pending;
const entries = id => ledger.listLedger(identity, { memberId: id });
async function standard(memberId, type, values) {
  const { accountVersion } = await ledger.getMember(identity, memberId);
  return ledger.executeCommand(identity, { id: randomUUID(), storeId, ledgerEpoch: epoch, type, memberId, expectedAccountVersion: accountVersion, ...values });
}

function interceptedPool(intercept) {
  return {
    query: (sql, args) => pool.query(sql, args),
    async connect() {
      const client = await pool.connect();
      return { query: (sql, params) => intercept(sql, params, () => client.query(sql, params)), release: (...args) => client.release(...args) };
    }
  };
}
async function counts() {
  const { rows: [row] } = await pool.query(`SELECT
    (SELECT count(*)::int FROM ledger_entries WHERE store_id=$1) AS entries,
    (SELECT count(*)::int FROM consumption_items WHERE store_id=$1) AS items,
    (SELECT count(*)::int FROM ledger_command_receipts WHERE store_id=$1) AS receipts,
    (SELECT count(*)::int FROM audit_events WHERE store_id=$1 AND event LIKE 'ledger_%') AS audits,
    (SELECT count(*)::int FROM voice_requests WHERE store_id=$1) AS voice,
    (SELECT head::text FROM store_change_heads WHERE store_id=$1) AS head`, [storeId]);
  return row;
}

let slotTime = Date.now();
function platformPreview(type) {
  const createdAt = ++slotTime;
  return request(type === 'recharge' ? '合成张三充值100.04元' : '合成张三精剪消费', {
    domainId: 10, skillId: 20, intentId: type === 'recharge' ? 30 : 40, intentName: type === 'recharge' ? 'RechargeIntent' : 'ConsumeIntent',
    confirmStatus: 'NONE', skillSession: { skillSessionId: 'platform-native-session', newSession: false },
    slotEntities: [['memberQuery', '合成张三', 'member_entity'], type === 'recharge' ? ['amount', '100.04元', 'sys.price'] : ['service', '精剪', 'service_entity']]
      .map(([name, value, entity], i) => ({ intentParameterId: 50 + i, intentParameterName: name, originalValue: value, standardValue: value,
        liveTime: 0, createTimeStamp: createdAt, slotName: name + ':' + entity, slotValue: value })) });
}
const platformConfirm = preview => ({ ...preview, requestId: randomUUID(), utterance: '是的', confirmStatus: 'CONFIRMED',
  slotEntities: preview.slotEntities.map(slot => ({ ...slot, liveTime: slot.liveTime + 1 })) });
async function platformApi(t, instance) {
  const server = createApi({ service: instance, pool });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port + '/api/v1/voice/aligenie';
  return async body => {
    const res = await fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'x-aligenie-token': secret } });
    assert.equal(res.status, 200); return res.json();
  };
}

for (const action of ['consume', 'recharge']) test('v2 native platform confirmation shares ledger writes and sale receipts: ' + action, async t => {
  // The SQL wrapper fails even a read of the old ledger, including fallbacks.
  const guarded = createService(interceptedPool(async (sql, _args, forward) => {
    assert.doesNotMatch(sql, /\b(?:FROM|UPDATE)\s+accounts\b/i);
    assert.doesNotMatch(sql, /\b(?:FROM|INSERT INTO)\s+operations\b/i);
    return forward();
  }));
  const post = await platformApi(t, guarded), preview = platformPreview(action);
  const prompt = await post(preview);
  assert.equal(prompt.returnValue.resultType, 'CONFIRM');
  assert.match(reply(prompt), action === 'consume' ? /精剪消费 38\.5 元/ : /实充 100\.04.*赠送 12\.51.*112\.55/);
  assert.equal(await balance(), '10000');
  const pending = await dialog();
  assert.equal(pending.command.actorId, identity.id); assert.equal(pending.command.deviceId, voiceDevice);
  assert.equal(pending.command.ledgerEpoch, epoch); assert.equal(pending.expectedProfileVersion, '0');
  assert.match(pending.command.id, /^voice-[0-9a-f]{64}$/);
  await assert.rejects(ledger.executeCommand(identity, pending.command), { code: 'INVALID_INPUT' });
  const body = platformConfirm(preview);
  const mismatched = { ...body, requestId: randomUUID(), slotEntities: body.slotEntities.map(slot => ({ ...slot, liveTime: slot.liveTime + 1 })) };
  assert.match(reply(await post(mismatched)), /不匹配/);
  const restarted = await platformApi(t, createService(pool));
  const duplicateResults = await Promise.all(Array.from({ length: 5 }, () => restarted(body)));
  for (const result of duplicateResults) assert.deepEqual(result, duplicateResults[0]);
  assert.match(reply(duplicateResults[0]), action === 'consume' ? /扣款成功.*38\.5 元.*61\.5 元/ : /充值成功.*112\.55.*212\.55/);
  assert.match(reply(await restarted({ ...body, requestId: randomUUID() })), /没有待确认/);
  await assert.rejects(send({ ...body, utterance: '内容变化' }), { code: 'VOICE_REQUEST_CONFLICT' });
  const { items: [entry] } = await entries('primary');
  assert.equal(entry.id, pending.command.id);
  if (action === 'consume') {
    assert.deepEqual(entry.items, [{ serviceId: 'trim', name: '精剪', quantity: 1, unitPriceCents: '3850', lineTotalCents: '3850' }]);
    assert.equal(await balance(), '6150');
  } else {
    assert.deepEqual(entry.payments, [{ method: '语音充值', amountCents: '10004' }]);
    assert.equal(entry.recharge.configurationVersion, '1'); assert.equal(entry.recharge.giftCents, '1251');
    assert.equal(await balance(), '21255');
  }
  const { rows: [audit] } = await pool.query('SELECT user_id,device_id,details FROM audit_events WHERE store_id=$1 AND event=$2', [storeId, 'ledger_' + action]);
  assert.equal(audit.user_id, identity.id); assert.equal(audit.device_id, voiceDevice); assert.equal(audit.details.source, 'voice');
  assert.equal((await counts()).receipts, 1); assert.equal(await dialog(), undefined);
});

test('voice query retains exact cents, member and phone disambiguation, and excludes openings and reversed entries', async () => {
  assert.match(reply(await send(request('查询尾号七七七七余额'))), /9007199254740993\.01.*累计充值到账 0 元/);
  const ambiguous = await send(request('查询尾号0000余额', { intentName: 'QueryMemberIntent', slotEntities: [{ intentParameterName: 'memberQuery', slotValue: '0000' }] }));
  assert.match(reply(ambiguous), /找到多位会员/);
  const excluded = await standard('primary', 'consume', { amountCents: '50' });
  await standard('primary', 'reverse', { originalEntryId: excluded.entryId });
  const reimbursed = await standard('primary', 'recharge', { actualPayCents: '500', giftCents: '50' });
  await standard('primary', 'recharge', { actualPayCents: '120', giftCents: '10' });
  await standard('primary', 'reverse', { originalEntryId: reimbursed.entryId });
  const named = reply(await send(request('查询合成张三余额')));
  assert.match(named, /合成张三当前卡内余额 101\.3 元.*累计充值到账 1\.3 元.*合成备注/);
  assert.doesNotMatch(named, /上次到店/);
  await standard('primary', 'consume', { amountCents: '5' });
  assert.match(reply(await send(request('查询尾号幺二三四余额'))), /101\.25.*上次到店/);
  const preview = request('高余额会员扣款9007199254740993.00元');
  assert.match(reply(await send(preview)), /剩余 0\.01/);
  assert.match(reply(await send(confirm(preview))), /扣除 9007199254740993 元.*0\.01/);
  assert.equal(await balance('big'), '1');
});

for (const [changed, alter, message] of [
  ['balance', () => standard('primary', 'recharge', { actualPayCents: '1' }), /余额已变化/],
  ['profile', () => ledger.updateMember(identity, 'primary', { name: '改名后的合成会员', expectedVersion: '0' }, { id: randomUUID(), storeId, ledgerEpoch: epoch }), /会员资料已变化/],
  ['configuration', () => configuration({ services: [{ id: 'trim', name: '精剪', priceCents: '5800' }] }), /服务或充值规则已变化/],
  ['archive', () => ledger.archiveMember(identity, 'other', { id: randomUUID(), storeId, ledgerEpoch: epoch }), /会员资料已变化/]
]) test('a v2 confirmation requires the original ' + changed, async () => {
  const preview = request((changed === 'archive' ? '合成张三丰' : '合成张三') + '消费38元');
  assert.equal((await send(preview)).returnValue.resultType, 'CONFIRM');
  await alter(); const before = await counts();
  assert.match(reply(await send(confirm(preview))), message);
  assert.equal((await counts()).entries, before.entries); assert.equal((await counts()).receipts, before.receipts);
  assert.equal(await dialog(), undefined);
  assert.match(reply(await send(confirm(preview))), /没有待确认/);
});

test('wrong identities, a cancelled or expired preview, and an earlier epoch cannot confirm', async () => {
  const first = request('合成张三扣款12元'); await send(first);
  for (const requestData of [{ deviceOpenId: 'device-b', userOpenId: 'platform-user-a' }, { deviceOpenId: 'device-a', userOpenId: 'platform-user-b' }]) {
    assert.match(reply(await send(confirm(first, { requestData }))), /没有待确认/);
  }
  await assert.rejects(send(confirm(first), service, secret + '-invalid'), { code: 'VOICE_AUTH_REQUIRED' });
  assert.match(reply(await send(request('取消'))), /取消/);
  assert.match(reply(await send(confirm(first))), /没有待确认/);
  const expired = request('合成张三扣款13元'); await send(expired);
  await pool.query("UPDATE voice_dialogs SET expires_at=clock_timestamp()-interval '1 second' WHERE store_id=$1", [storeId]);
  assert.match(reply(await send(confirm(expired))), /没有待确认/);
  const old = request('合成张三扣款14元'); await send(old);
  await pool.query('UPDATE stores SET ledger_epoch=$1 WHERE id=$2', [randomUUID(), storeId]);
  await assert.rejects(send(old), { code: 'VOICE_CONTEXT_CHANGED' });
  assert.match(reply(await send(confirm(old))), /账本或授权已变化/);
  assert.equal(await balance(), '10000'); assert.equal((await counts()).entries, 0);
});

test('actor revocation, entitlement revocation and version changes cannot rebind previews', async () => {
  const actorPreview = request('合成张三扣款17元'); await send(actorPreview);
  await pool.query('UPDATE users SET platform_disabled=true,version=version+1 WHERE id=$1', [identity.id]);
  await assert.rejects(send(confirm(actorPreview)), { code: 'VOICE_ACTOR_UNAVAILABLE' });
  await pool.query('UPDATE users SET platform_disabled=false,version=version+1 WHERE id=$1', [identity.id]);
  assert.match(reply(await send(confirm(actorPreview))), /账本或授权已变化/);
  const licensePreview = request('合成张三扣款18元'); await send(licensePreview);
  await pool.query('UPDATE store_licenses SET active=false,version=version+1 WHERE store_id=$1', [storeId]);
  await assert.rejects(send(confirm(licensePreview)), { code: 'LICENSE_REQUIRED' });
  await pool.query('UPDATE store_licenses SET active=true,version=version+1 WHERE store_id=$1', [storeId]);
  assert.match(reply(await send(confirm(licensePreview))), /账本或授权已变化/);
  const settingsPreview = request('合成张三扣款19元'); await send(settingsPreview);
  await service.saveVoiceConfig(identity, actorConfig(), 1);
  assert.match(reply(await send(confirm(settingsPreview))), /账本或授权已变化/);
  assert.equal(await balance(), '10000'); assert.equal((await counts()).entries, 0);
});

for (const [name, pattern] of [['ledger audit', /^INSERT INTO audit_events/], ['voice receipt', /^INSERT INTO voice_requests/], ['COMMIT', /^COMMIT$/]]) {
  test(name + ' failure rolls the financial writes and pending confirmation back together', async () => {
    const preview = request('合成张三扣款150.01元');
    assert.match(reply(await send(preview)), /欠款 50\.01.*确认/);
    const pending = await dialog(), before = await counts(), confirmation = confirm(preview);
    const fault = new Error('Injected ' + name + ' failure');
    const failing = createService(interceptedPool(async (sql, _args, forward) => {
      if (pattern.test(sql)) throw fault;
      return forward();
    }));
    await assert.rejects(send(confirmation, failing), error => error === fault);
    assert.equal(await balance(), '10000'); assert.deepEqual(await counts(), before); assert.deepEqual(await dialog(), pending);
    assert.match(reply(await send(confirmation)), /扣款成功.*150\.01.*欠款 50\.01/);
    assert.equal(await balance(), '-5001'); assert.equal(await dialog(), undefined);
  });
}

test('a lost voice COMMIT response can return the original result after another transaction without posting again', async () => {
  const preview = request('合成张三充值20元'); await send(preview);
  const confirmation = confirm(preview);
  const lostResponse = createService(interceptedPool(async (sql, _args, forward) => {
    const result = await forward(); if (sql === 'COMMIT') throw new Error('Lost committed voice response'); return result;
  }));
  await assert.rejects(send(confirmation, lostResponse), /Lost committed voice response/);
  await standard('primary', 'recharge', { actualPayCents: '777' });
  assert.match(reply(await send(confirmation, createService(pool))), /充值成功.*122\.5 元/);
  assert.equal(await balance(), '13027'); assert.equal((await counts()).entries, 2);
});
