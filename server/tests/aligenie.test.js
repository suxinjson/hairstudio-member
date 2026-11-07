import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate } from '../database.js';
import { createService } from '../service.js';
import { createApi } from '../http.js';
import { DEFAULT_SERVICES, DEFAULT_RECHARGE_PLANS, createLocalDb } from '../../src/storage.js';
import { integrity } from '../security.js';
import {
  signAliGenieRequest,
  parseAliGenieRequest,
  parseAmount,
  cleanMemberQuery,
  findMatchingMembers,
  findMemberFromUtterance,
  lookupServicePrice,
  formatAliGenieResponse
} from '../aligenie.js';

test('signed member queries report only non-refunded visits and omit the visit date when all consumption is reversed', async () => {
  const db = new PGlite();
  const query = (sql, params) => params ? db.query(sql, params) : sql.includes(';') ? db.exec(sql) : db.query(sql);
  const pool = { query, connect: async () => ({ query, release() {} }) };
  try {
    await migrate(pool);
    const service = createService(pool), password = 'Visit-History-Regression-2026!';
    await service.createOwner({ username: 'visit-owner', password });
    const session = await service.login({ username: 'visit-owner', password, deviceId: randomUUID() });
    const identity = await service.authenticate(session.accessToken), secret = 'visit-secret-' + randomUUID();
    await service.saveVoiceConfig(identity, { aligenie: {
      enabled: true, actorId: identity.id, token: secret, allowedDevices: ['visit-device']
    } });
    const values = new Map(); let date = '2026-01-02T12:00:00.000Z';
    const ledger = createLocalDb({ getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }, { now: () => date });
    ledger.init(); const member = ledger.createMember({ name: '到店客户', phone: '13900008888', initialBalance: 100 });
    const older = ledger.consume({ memberId: member.id, amount: 10 });
    date = '2026-02-03T12:00:00.000Z';
    const latest = ledger.consume({ memberId: member.id, amount: 20 }); ledger.refundLedger(latest.ledgerId);
    async function ask() {
      const data = ledger.readBackupState();
      await pool.query('UPDATE accounts SET data=$1,integrity=$2,revision=revision+1 WHERE store_id=$3', [data, integrity(data), identity.store_id]);
      const body = { requestId: randomUUID(), sessionId: randomUUID(), intentName: 'QueryMemberIntent', utterance: '查询到店客户余额',
        slots: {}, context: { System: { device: { deviceOpenId: 'visit-device' }, user: { userOpenId: 'visit-user' } } } };
      const timestamp = String(Date.now());
      const response = await service.handleAliGenieWebhook(body, { headers: {
        'x-store-id': identity.store_id, 'x-aligenie-timestamp': timestamp,
        'x-aligenie-signature': signAliGenieRequest(secret, timestamp, identity.store_id, body)
      } });
      return response.response.outputSpeechs[0].text;
    }
    assert.match(await ask(), /上次到店是 1月2日/);
    ledger.refundLedger(older.ledgerId);
    assert.doesNotMatch(await ask(), /上次到店/);
  } finally { await db.close(); }
});

test('platform Header welcomes and business validation replies use the skill protocol without weakening accounting authorization', async () => {
  const db = new PGlite();
  const query = (sql, params) => params ? db.query(sql, params) : sql.includes(';') ? db.exec(sql) : db.query(sql);
  const pool = { query, connect: async () => ({ query, release() {} }) };
  let server;
  try {
    await migrate(pool);
    const service = createService(pool);
    const password = 'Platform-Welcome-Regression-2026!';
    await service.createOwner({ username: 'welcome-owner', password });
    const login = await service.login({ username: 'welcome-owner', password, deviceId: randomUUID() });
    const identity = await service.authenticate(login.accessToken);
    const secret = 'platform-token-' + randomUUID();
    await service.saveVoiceConfig(identity, { aligenie: {
      enabled: true, actorId: identity.id, token: secret, allowedDevices: ['bound-device']
    } });
    const before = await service.account(identity);
    server = createApi({ service, pool, production: false });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/v1/voice/aligenie`;
    // Send the configured platform Header directly; do not inject signatures or IDs.
    const post = (body, headers = { 'x-aligenie-token': secret }) => globalThis.fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
    });
    for (const body of [
      { intentName: 'DefaultWelcomeIntent', utterance: '梦飞管家' },
      { intentName: 'DefaultWelcomeIntent', utterance: '顾客' },
      { utterance: '打开梦飞管家' },
      { version: '2.0', request: { type: 'LaunchRequest' } },
      { requestId: randomUUID(), sessionId: 'platform-test', intentName: 'DefaultWelcomeIntent',
        requestData: { deviceOpenId: 'unbound-ide-device', userOpenId: 'ide-user' } }
    ]) {
      const res = await post(body);
      const result = await res.json();
      assert.equal(res.status, 200, JSON.stringify(result));
      assert.equal(result.returnValue.reply, '梦飞空间欢迎您，请说');
      assert.equal(result.resultType, 'ASK_INF');
      assert.equal(result.response.shouldEndSession, false);
      assert.equal(result.response.expectSpeech, true);
    }
    const welcome = { intentName: 'DefaultWelcomeIntent' };
    for (const headers of [{}, { 'x-aligenie-token': 'invalid-platform-token-' + randomUUID() }]) {
      assert.equal((await post(welcome, headers)).status, 401);
    }
    const expired = String(Date.now() - 600000);
    assert.equal((await post(welcome, {
      'x-aligenie-token': secret, 'x-store-id': identity.store_id, 'x-aligenie-timestamp': expired,
      'x-aligenie-signature': signAliGenieRequest(secret, expired, identity.store_id, welcome)
    })).status, 401);
    for (const body of [
      { intentName: 'ConsumeIntent' }, { intentName: 'RechargeIntent' }, { intentName: 'QueryMemberIntent' },
      { utterance: '确认' }, { utterance: '取消' }, { intentName: 'ConfirmIntent' },
      { intentName: 'DefaultWelcomeIntent', confirmationRequestId: 'preview-request' },
      { intentName: 'DefaultWelcomeIntent', utterance: '张三洗剪吹扣款38元' },
      { utterance: '李四充值200元' }, { utterance: '查询尾号1234余额' }
    ]) {
      const res = await post(body), result = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(result.returnValue.executeCode, 'SUCCESS');
      assert.equal(result.returnResult.executeCode, 'SUCCESS');
      assert.match(result.returnValue.msgInfo, /VOICE_IDENTIFIERS_REQUIRED/);
      assert.match(result.returnValue.reply, /标识/);
    }
    // AliGenie's documented online-test request has request/session IDs and slots,
    // but requestData and device are empty. It must explain the limitation without writing.
    const platformBody = {
      sessionId: 'system-session', requestId: randomUUID(), intentName: 'ConsumeIntent',
      utterance: '张三洗剪吹扣款38元', requestData: {}, device: {},
      skillSession: { skillSessionId: 'skill-session', newSession: false },
      slotEntities: [
        { intentParameterName: 'memberQuery', standardValue: '张三' },
        { intentParameterName: 'service', standardValue: '洗剪吹' },
        { intentParameterName: 'amount', standardValue: '38元' }
      ]
    };
    assert.deepEqual(parseAliGenieRequest(platformBody).slots, { member: '张三', service: '洗剪吹', amount: '38元' });
    const platformRes = await post(platformBody), platformResult = await platformRes.json();
    assert.equal(platformRes.status, 200);
    assert.equal(platformResult.returnCode, '0');
    assert.equal(platformResult.returnValue.executeCode, 'SUCCESS');
    assert.equal(platformResult.returnResult.executeCode, 'SUCCESS');
    assert.match(platformResult.returnValue.reply, /在线测试.*已识别会员张三.*服务洗剪吹.*38元.*用户和设备标识.*已绑定.*音箱/);
    assert.equal(platformResult.response.shouldEndSession, true);
    assert.equal(platformResult.response.directives, undefined);
    const detail = JSON.parse(platformResult.returnValue.msgInfo);
    assert.equal(detail.code, 'VOICE_IDENTIFIERS_REQUIRED');
    assert.deepEqual(detail.missingFields, ['userOpenId', 'deviceOpenId']);
    const normalizedPriceBody = structuredClone(platformBody);
    normalizedPriceBody.slotEntities[2].originalValue = '一百元';
    normalizedPriceBody.slotEntities[2].standardValue = JSON.stringify({ success: true, type: 'CNY', unit: '元', value: 100 });
    const normalizedPriceResult = await (await post(normalizedPriceBody)).json();
    assert.match(normalizedPriceResult.returnValue.reply, /金额一百元/);
    assert.doesNotMatch(normalizedPriceResult.returnValue.reply, /success|CNY|\{/);
    const timestamp = String(Date.now());
    const internalRes = await post(platformBody, {
      'x-store-id': identity.store_id, 'x-aligenie-timestamp': timestamp,
      'x-aligenie-signature': signAliGenieRequest(secret, timestamp, identity.store_id, platformBody)
    });
    assert.equal(internalRes.status, 400);
    for (const intentName of ['ConsumeIntent', 'RechargeIntent', 'QueryMemberIntent']) {
      const body = { requestId: randomUUID(), sessionId: 'platform-test', intentName,
        requestData: { deviceOpenId: 'unbound-ide-device', userOpenId: 'ide-user' }
      };
      const res = await post(body), result = await res.json();
      assert.equal(res.status, 200);
      assert.equal(result.returnValue.executeCode, 'SUCCESS');
      assert.equal(result.returnResult.executeCode, 'SUCCESS');
      assert.match(result.returnValue.reply, /设备.*未绑定/);
      assert.equal(JSON.parse(result.returnValue.msgInfo).code, 'VOICE_DEVICE_UNBOUND');
      const timestamp = String(Date.now());
      assert.equal((await post(body, {
        'x-store-id': identity.store_id, 'x-aligenie-timestamp': timestamp,
        'x-aligenie-signature': signAliGenieRequest(secret, timestamp, identity.store_id, body)
      })).status, 401);
    }
    assert.deepEqual(await service.account(identity), before);
    for (const table of ['voice_dialogs', 'voice_requests']) {
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0);
    }
    await service.saveVoiceConfig(identity, { aligenie: { enabled: false } });
    assert.equal((await post(welcome)).status, 401);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await db.close();
  }
});

test('AliGenie parser and utility functions', () => {
  // 1. Amount parsing (Arabic + Chinese numerals)
  assert.equal(parseAmount('38元'), 38);
  assert.equal(parseAmount('38.5块钱'), 38.5);
  assert.equal(parseAmount('100'), 100);
  assert.equal(parseAmount('一百'), 100);
  assert.equal(parseAmount('三十八'), 38);
  assert.equal(parseAmount('两百元'), 200);
  assert.equal(parseAmount('十五块'), 15);
  assert.equal(parseAmount('五十'), 50);
  assert.equal(parseAmount('一百五'), 150);
  assert.equal(parseAmount('0'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount(null), null);

  // 2. Member query cleaning
  assert.equal(cleanMemberQuery('给张三'), '张三');
  assert.equal(cleanMemberQuery('为李四会员'), '李四');
  assert.equal(cleanMemberQuery('查一下王五'), '王五');
  assert.equal(cleanMemberQuery('查询客户赵六'), '赵六');
  assert.equal(cleanMemberQuery('尾号1234'), '1234');
  assert.equal(cleanMemberQuery('查询苏新用户'), '苏新');
  assert.equal(cleanMemberQuery('用户苏新'), '苏新');

  // 3. Member matching
  const testMembers = [
    { id: 'm1', name: '张三', phone: '13800001234', isArchived: false },
    { id: 'm2', name: '李四', phone: '13900005678', isArchived: false },
    { id: 'm3', name: '张三丰', phone: '13700001234', isArchived: false },
    { id: 'm4', name: '王五', phone: '13600009999', isArchived: true } // archived
  ];

  // Exact phone
  assert.deepEqual(findMatchingMembers(testMembers, '13800001234').map(m => m.id), ['m1']);
  // Tail phone 4 digits
  assert.deepEqual(findMatchingMembers(testMembers, '尾号5678').map(m => m.id), ['m2']);
  // Tail phone with multiple matches
  assert.deepEqual(findMatchingMembers(testMembers, '尾号1234').map(m => m.id), ['m1', 'm3']);
  // Exact name takes precedence
  assert.deepEqual(findMatchingMembers(testMembers, '张三').map(m => m.id), ['m1']);
  // Substring name
  assert.deepEqual(findMatchingMembers(testMembers, '三丰').map(m => m.id), ['m3']);
  // Archived member should not match
  assert.deepEqual(findMatchingMembers(testMembers, '王五'), []);
  // Not found
  assert.deepEqual(findMatchingMembers(testMembers, '赵六'), []);

  // 4. Service price lookup
  const services = [
    { id: 's1', name: '精致洗剪吹', price: 38 },
    { id: 's2', name: '寸头快剪', price: 25 }
  ];
  assert.deepEqual(lookupServicePrice(services, '精致洗剪吹'), { name: '精致洗剪吹', price: 38 });
  assert.deepEqual(lookupServicePrice(services, '洗剪吹'), { name: '精致洗剪吹', price: 38 });
  assert.deepEqual(lookupServicePrice(services, '染发'), null);

  // 4.1 Utterance member extraction
  assert.equal(findMemberFromUtterance(testMembers, '张三消费一百')?.id, 'm1');
  assert.equal(findMemberFromUtterance(testMembers, '张三丰剪发38元')?.id, 'm3');
  assert.equal(findMemberFromUtterance(testMembers, '查一下李四余额')?.id, 'm2');
  assert.equal(findMemberFromUtterance(testMembers, '尾号5678充值200')?.id, 'm2');

  // 4.2 Format response verification (supports both 1.0 returnCode/returnValue and 2.0 outputSpeech)
  const resp1 = formatAliGenieResponse({ text: '欢迎使用', shouldEndSession: false });
  assert.equal(resp1.returnCode, '0');
  assert.equal(resp1.returnValue.reply, '欢迎使用');
  assert.equal(resp1.returnValue.resultType, 'ASK_INF');
  assert.equal(resp1.version, '2.0');
  assert.equal(resp1.response.outputSpeech.text, '欢迎使用');
  assert.equal(resp1.response.outputSpeechs[0].text, '欢迎使用');
  assert.equal(resp1.response.shouldEndSession, false);

  const resp2 = formatAliGenieResponse({ text: '扣款完成', shouldEndSession: true });
  assert.equal(resp2.returnCode, '0');
  assert.equal(resp2.returnValue.resultType, 'RESULT');
  assert.equal(resp2.response.shouldEndSession, true);

  // 5. 2.0 Request parsing
  const v2Body = {
    version: '2.0',
    session: { sessionId: 'sess-123', new: false },
    context: {
      System: {
        device: { deviceOpenId: 'dev-456' },
        user: { userOpenId: 'usr-789' }
      }
    },
    request: {
      type: 'IntentRequest',
      requestId: 'req-001',
      intent: {
        name: 'ConsumeIntent',
        slots: {
          member: { name: 'member', values: ['张三'] },
          amount: { name: 'amount', values: ['38元'] }
        },
        confirmationStatus: 'CONFIRMED'
      },
      input: { type: 'TEXT', value: '张三洗剪吹扣款38元' }
    }
  };
  const parsedV2 = parseAliGenieRequest(v2Body);
  assert.equal(parsedV2.version, '2.0');
  assert.equal(parsedV2.sessionId, 'sess-123');
  assert.equal(parsedV2.requestId, 'req-001');
  assert.equal(parsedV2.intentName, 'ConsumeIntent');
  assert.equal(parsedV2.slots.member, '张三');
  assert.equal(parsedV2.slots.amount, '38元');
  assert.equal(parsedV2.confirmationStatus, 'CONFIRMED');
  assert.equal(parsedV2.deviceOpenId, 'dev-456');

  // 6. 1.0 Request parsing compatibility
  const v1Body = {
    sessionId: 'sess-v1',
    requestId: 'req-v1',
    intentName: 'RechargeIntent',
    slotEntities: [
      { intentParameterName: 'memberQuery', standardValue: '李四' },
      { intentParameterName: 'actualAmount', standardValue: '200' }
    ],
    confirmStatus: 'NONE',
    requestData: { deviceOpenId: 'dev-v1' },
    utterance: '给李四充值200元'
  };
  const parsedV1 = parseAliGenieRequest(v1Body);
  assert.equal(parsedV1.version, '1.0');
  assert.equal(parsedV1.sessionId, 'sess-v1');
  assert.equal(parsedV1.intentName, 'RechargeIntent');
  assert.equal(parsedV1.slots.member, '李四');
  assert.equal(parsedV1.slots.amount, '200');
  assert.equal(parsedV1.confirmationStatus, 'NONE');
  assert.equal(parsedV1.deviceOpenId, 'dev-v1');
});

test('AliGenie Webhook End-to-End flow: Verification, Query, Consume, Recharge, and Idempotency', async () => {
  const db = new PGlite();
  const pool = {
    query: (sql, params) => params ? db.query(sql, params) : sql.includes(';') ? db.exec(sql) : db.query(sql),
    connect: async () => ({ query: (sql, params) => params ? db.query(sql, params) : sql.includes(';') ? db.exec(sql) : db.query(sql), release() {} })
  };
  await migrate(pool);

  const service = createService(pool);
  const server = createApi({ service, pool, production: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // 1. Create owner and initial store account
  const owner = await service.createOwner({
    username: 'boss',
    password: 'Password123!',
    displayName: '梦飞店长',
    storeName: '梦飞造型沙龙'
  });
  const ownerLogin = await service.login({ username: 'boss', password: 'Password123!', deviceId: randomUUID() });
  const identity = await service.authenticate(ownerLogin.accessToken);

  const signingSecret = 'test-signing-secret-' + randomUUID();
  await service.saveVoiceConfig(identity, { aligenie: { enabled: true, actorId: identity.id, token: signingSecret, allowedDevices: ['allowed-device-888'] } });
  const previewRequests = new Map();
  const fetch = async (url, options = {}) => {
    if (options.method !== 'POST' || !url.includes('/api/v1/voice/aligenie')) return globalThis.fetch(url, options);
    const body = JSON.parse(options.body);
    body.requestId ||= body.request?.requestId || randomUUID();
    body.sessionId ||= body.session?.sessionId || randomUUID();
    body.context ||= { System: {} }; body.context.System ||= {};
    body.context.System.device ||= { deviceOpenId: 'allowed-device-888' };
    body.context.System.user ||= { userOpenId: 'signed-user' };
    body.confirmationRequestId ||= previewRequests.get(body.sessionId) || '';
    const timestamp = String(Date.now());
    const result = await globalThis.fetch(url, { ...options, body: JSON.stringify(body), headers: { ...options.headers,
      'x-store-id': identity.store_id, 'x-aligenie-timestamp': timestamp,
      'x-aligenie-signature': signAliGenieRequest(signingSecret, timestamp, identity.store_id, body) } });
    const response = await result.clone().json();
    if (response.confirmationRequestId) previewRequests.set(body.sessionId, response.confirmationRequestId);
    return result;
  };

  // Bootstrap initial ledger data
  const initialData = {
    members: [
      { id: 'M-1', name: '张三', phone: '13800001234', balance: 10000, total_recharge: 10000, total_consume: 0, notes: '短发寸头，不贴皮', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: 'M-2', name: '李四', phone: '13900005678', balance: 2000, total_recharge: 5000, total_consume: 3000, notes: '植物染发棕色', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: 'M-3', name: '张三丰', phone: '13700001234', balance: 5000, total_recharge: 5000, total_consume: 0, notes: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: 'M-4', name: '王五', phone: '13600008888', balance: -1500, total_recharge: 0, total_consume: 1500, notes: '挂账欠款', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    ],
    ledgers: [
      { id: 'TX-INIT-2B', memberId: 'M-2', memberName: '李四', memberPhone: '13900005678', type: 'CONSUME', changeAmount: -3000, balanceBefore: 5000, balanceAfter: 2000, remark: '精致洗剪吹', created_at: new Date(Date.now() - 3600000).toISOString() },
      { id: 'TX-INIT-2A', memberId: 'M-2', memberName: '李四', memberPhone: '13900005678', type: 'RECHARGE', changeAmount: 5000, balanceBefore: 0, balanceAfter: 5000, remark: '充值50元', created_at: new Date(Date.now() - 7200000).toISOString() },
      { id: 'TX-INIT-1', memberId: 'M-1', memberName: '张三', memberPhone: '13800001234', type: 'RECHARGE', changeAmount: 10000, balanceBefore: 0, balanceAfter: 10000, remark: '开卡充值100元', created_at: new Date(Date.now() - 86400000).toISOString() },
      { id: 'TX-INIT-3', memberId: 'M-3', memberName: '张三丰', memberPhone: '13700001234', type: 'RECHARGE', changeAmount: 5000, balanceBefore: 0, balanceAfter: 5000, remark: '充值50元', created_at: new Date(Date.now() - 86400000).toISOString() },
      { id: 'TX-INIT-4', memberId: 'M-4', memberName: '王五', memberPhone: '13600008888', type: 'CONSUME', changeAmount: -1500, balanceBefore: 0, balanceAfter: -1500, remark: '欠款消费15元', created_at: new Date(Date.now() - 86400000).toISOString() }
    ],
    services: DEFAULT_SERVICES,
    rechargePlans: DEFAULT_RECHARGE_PLANS,
    rechargeSettings: { giftEnabled: true, giftRate: 10 }
  };
  await service.bootstrap(identity, { id: randomUUID(), data: initialData });

  // 2. Test Verification File Serving (GET /aligenie/<file>.txt)
  const testFileName = 'test_verify_hash_9876543210.txt';
  await service.saveVoiceConfig(identity, { aligenie: { verificationFile: testFileName, verificationContent: 'test_verify_hash_9876543210' } });



  try {
    const verifyRes = await fetch(`${baseUrl}/aligenie/${testFileName}`);
    assert.equal(verifyRes.status, 200);
    assert.equal(verifyRes.headers.get('content-type'), 'text/plain; charset=utf-8');
    const verifyBody = await verifyRes.text();
    assert.equal(verifyBody, 'test_verify_hash_9876543210');

    // Non-existent file returns 404
    const notFoundRes = await fetch(`${baseUrl}/aligenie/non_existent_file.txt`);
    assert.equal(notFoundRes.status, 404);

    // 3. Test Default Welcome Intent
    const welcomeRes = await fetch(`${baseUrl}/api/v1/voice/aligenie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '2.0',
        session: { sessionId: 's-welcome', new: true },
        request: {
          type: 'IntentRequest',
          requestId: 'req-welcome',
          intent: { name: 'DefaultWelcomeIntent' }
        }
      })
    });
    assert.equal(welcomeRes.status, 200);
    const welcomeData = await welcomeRes.json();
    assert.equal(welcomeData.version, '2.0');
    assert.equal(welcomeData.response.outputSpeechs[0].text, '梦飞空间欢迎您，请说');
    assert.equal(welcomeData.response.shouldEndSession, false);
    assert.equal(welcomeData.response.expectSpeech, true);

    // 4. Test Member Query Intent
    // 4.1 Query Zhang San by exact name
    const queryRes1 = await fetch(`${baseUrl}/api/v1/voice/aligenie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '2.0',
        session: { sessionId: 's-q1' },
        request: {
          type: 'IntentRequest',
          requestId: 'req-q1',
          intent: {
            name: 'QueryMemberIntent',
            slots: { member: { values: ['张三'] } }
          }
        }
      })
    });
    const queryData1 = await queryRes1.json();
    assert.match(queryData1.response.outputSpeechs[0].text, /卡内余额 100 元/);
    assert.match(queryData1.response.outputSpeechs[0].text, /短发寸头/);
    assert.equal(queryData1.response.shouldEndSession, true);

    // 4.2 Query Li Si by tail 4 digits "5678"
    const queryRes2 = await fetch(`${baseUrl}/api/v1/voice/aligenie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '2.0',
        session: { sessionId: 's-q2' },
        request: {
          type: 'IntentRequest',
          requestId: 'req-q2',
          intent: {
            name: 'QueryMemberIntent',
            slots: { member: { values: ['尾号5678'] } }
          }
        }
      })
    });
    const queryData2 = await queryRes2.json();
    assert.match(queryData2.response.outputSpeechs[0].text, /会员李四/);
    assert.match(queryData2.response.outputSpeechs[0].text, /20 元/);

    // 4.3 Query Wang Wu (debt customer)
    const queryRes3 = await fetch(`${baseUrl}/api/v1/voice/aligenie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '2.0',
        session: { sessionId: 's-q3' },
        request: {
          type: 'IntentRequest',
          requestId: 'req-q3',
          intent: {
            name: 'QueryMemberIntent',
            slots: { member: { values: ['王五'] } }
          }
        }
      })
    });
    const queryData3 = await queryRes3.json();
    assert.match(queryData3.response.outputSpeechs[0].text, /当前卡内欠款 15 元/);

    // 4.4 Ambiguous query: "尾号1234" matches both 张三 and 张三丰
    const queryAmbRes = await fetch(`${baseUrl}/api/v1/voice/aligenie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '2.0',
        session: { sessionId: 's-q-amb' },
        request: {
          type: 'IntentRequest',
          requestId: 'req-q-amb',
          intent: {
            name: 'QueryMemberIntent',
            slots: { member: { values: ['1234'] } }
          }
        }
      })
    });
    const queryAmbData = await queryAmbRes.json();
    assert.match(queryAmbData.response.outputSpeechs[0].text, /找到多位会员/);
    assert.match(queryAmbData.response.outputSpeechs[0].text, /张三/);
    assert.match(queryAmbData.response.outputSpeechs[0].text, /张三丰/);
    assert.equal(queryAmbData.response.shouldEndSession, false);
    assert.equal(queryAmbData.response.expectSpeech, true);

    // 5. Test Consume Intent with Confirmation & Idempotency
    const consumeSessionId = 'sess-consume-flow-1';
    // 5.1 First turn: "张三剪发扣款38元"
    const consumeRes1 = await fetch(`${baseUrl}/api/v1/voice/aligenie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '2.0',
        session: { sessionId: consumeSessionId },
        request: {
          type: 'IntentRequest',
          requestId: 'req-c-1',
          intent: {
            name: 'ConsumeIntent',
            slots: {
              member: { values: ['张三'] },
              amount: { values: ['38元'] }
            },
            confirmationStatus: 'NONE'
          },
          input: { type: 'TEXT', value: '张三扣款38元' }
        }
      })
    });
    const consumeData1 = await consumeRes1.json();
    assert.match(consumeData1.response.outputSpeechs[0].text, /本次洗剪吹理发消费 38 元/);
    assert.match(consumeData1.response.outputSpeechs[0].text, /扣款后卡内剩余 62 元/);
    assert.match(consumeData1.response.outputSpeechs[0].text, /请问确认扣款吗/);
    assert.equal(consumeData1.returnCode, '0');
    assert.equal(consumeData1.returnValue.resultType, 'CONFIRM');
    assert.equal(consumeData1.returnValue.confirmParaInfo, undefined);
    assert.equal(consumeData1.response.directives[0].type, 'Dialog.Confirm');
    assert.equal(consumeData1.response.shouldEndSession, false);

    // 5.1.1 Direct utterance "张三消费一百" without slots (supports Chinese number "一百")
    const pureRes = await fetch(`${baseUrl}/api/v1/voice/aligenie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        utterance: '张三消费一百'
      })
    });
    const pureData = await pureRes.json();
    assert.equal(pureData.returnCode, '0');
    assert.match(pureData.returnValue.reply, /会员张三本次洗剪吹理发消费 100 元/);
    assert.match(pureData.returnValue.reply, /扣款后卡内剩余 0 元/);
    assert.match(pureData.returnValue.reply, /请问确认扣款吗/);

    // Verify Zhang San balance has NOT changed yet in DB
    const head1 = await service.account(identity);
    assert.equal(head1.data.members.find(m => m.id === 'M-1').balance, 10000);

    // 5.2 Second turn: User says "确认" (re-invokes or confirms with same sessionId)
    const consumeRes2 = await fetch(`${baseUrl}/api/v1/voice/aligenie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '2.0',
        session: { sessionId: consumeSessionId },
        request: {
          type: 'IntentRequest',
          requestId: 'req-c-2',
          intent: {
            name: 'ConsumeIntent',
            confirmationStatus: 'CONFIRMED'
          },
          input: { type: 'TEXT', value: '确认' }
        }
      })
    });
    const consumeData2 = await consumeRes2.json();
    assert.match(consumeData2.response.outputSpeechs[0].text, /扣款成功/);
    assert.match(consumeData2.response.outputSpeechs[0].text, /扣除 38 元/);
    assert.match(consumeData2.response.outputSpeechs[0].text, /卡内当前剩余 62 元/);
    assert.equal(consumeData2.response.shouldEndSession, true);

    // Verify Zhang San balance IS updated to 6200 in DB
    const head2 = await service.account(identity);
    const zhangSan = head2.data.members.find(m => m.id === 'M-1');
    assert.equal(zhangSan.balance, 6200);
    assert.equal(zhangSan.total_consume, 3800);
    assert.equal(head2.data.ledgers[0].changeAmount, -3800);
    assert.equal(head2.data.ledgers[0].type, 'CONSUME');

    // 5.3 Third turn: Duplicate request retry with same requestId (req-c-2)
    const consumeResRetry = await fetch(`${baseUrl}/api/v1/voice/aligenie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '2.0',
        session: { sessionId: consumeSessionId },
        request: {
          type: 'IntentRequest',
          requestId: 'req-c-2', // identical requestId
          intent: {
            name: 'ConsumeIntent',
            confirmationStatus: 'CONFIRMED'
          },
          input: { type: 'TEXT', value: '确认' }
        }
      })
    });
    assert.equal(consumeResRetry.status, 200);
    // Balance must not be deducted again!
    const head3 = await service.account(identity);
    assert.equal(head3.data.members.find(m => m.id === 'M-1').balance, 6200);

    // 6. Test Consume with Price Lookup & Debt Warning (Li Si has ¥20.00, item is ¥38.00)
    const debtSessionId = 'sess-consume-debt';
    const debtRes1 = await fetch(`${baseUrl}/api/v1/voice/aligenie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '2.0',
        session: { sessionId: debtSessionId },
        request: {
          type: 'IntentRequest',
          requestId: 'req-debt-1',
          intent: {
            name: 'ConsumeIntent',
            slots: {
              member: { values: ['李四'] },
              service: { values: ['精致洗剪吹'] } // no amount specified -> looks up 38
            }
          }
        }
      })
    });
    const debtData1 = await debtRes1.json();
    assert.match(debtData1.response.outputSpeechs[0].text, /余额仅为 20 元/);
    assert.match(debtData1.response.outputSpeechs[0].text, /产生欠款 18 元/);
    assert.match(debtData1.response.outputSpeechs[0].text, /确认扣款并记入欠款吗/);

    // Confirm debt deduction
    const debtRes2 = await fetch(`${baseUrl}/api/v1/voice/aligenie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '2.0',
        session: { sessionId: debtSessionId },
        request: {
          type: 'IntentRequest',
          requestId: 'req-debt-2',
          intent: { name: 'ConfirmIntent', confirmationStatus: 'CONFIRMED' },
          input: { type: 'TEXT', value: '确认' }
        }
      })
    });
    const debtData2 = await debtRes2.json();
    assert.match(debtData2.response.outputSpeechs[0].text, /扣款成功/);
    assert.match(debtData2.response.outputSpeechs[0].text, /当前已欠款 18 元/);

    const headDebt = await service.account(identity);
    const liSi = headDebt.data.members.find(m => m.id === 'M-2');
    assert.equal(liSi.balance, -1800); // -¥18.00

    // 7. Test Consume Cancellation / Deny
    const cancelSessionId = 'sess-cancel-1';
    await fetch(`${baseUrl}/api/v1/voice/aligenie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '2.0',
        session: { sessionId: cancelSessionId },
        request: {
          type: 'IntentRequest',
          requestId: 'req-can-1',
          intent: {
            name: 'ConsumeIntent',
            slots: { member: { values: ['张三'] }, amount: { values: ['20元'] } }
          }
        }
      })
    });

    const cancelRes2 = await fetch(`${baseUrl}/api/v1/voice/aligenie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '2.0',
        session: { sessionId: cancelSessionId },
        request: {
          type: 'IntentRequest',
          requestId: 'req-can-2',
          intent: { name: 'DenyIntent', confirmationStatus: 'DENIED' },
          input: { type: 'TEXT', value: '取消' }
        }
      })
    });
    const cancelData2 = await cancelRes2.json();
    assert.match(cancelData2.response.outputSpeechs[0].text, /已为您取消本次操作/);
    assert.equal(cancelData2.response.shouldEndSession, true);

    // 8. Test Recharge Intent with Gift Calculation & Confirmation
    const rechargeSessionId = 'sess-recharge-1';
    // User says "给张三充值200元", default gift is 10% -> 20 yuan gift
    const rechargeRes1 = await fetch(`${baseUrl}/api/v1/voice/aligenie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '2.0',
        session: { sessionId: rechargeSessionId },
        request: {
          type: 'IntentRequest',
          requestId: 'req-r-1',
          intent: {
            name: 'RechargeIntent',
            slots: { member: { values: ['张三'] }, amount: { values: ['200'] } }
          }
        }
      })
    });
    const rechargeData1 = await rechargeRes1.json();
    assert.match(rechargeData1.response.outputSpeechs[0].text, /实充 200 元/);
    assert.match(rechargeData1.response.outputSpeechs[0].text, /赠送 20 元/);
    assert.match(rechargeData1.response.outputSpeechs[0].text, /合计到账 220 元/);
    assert.match(rechargeData1.response.outputSpeechs[0].text, /请问确认充值吗/);

    // Confirm recharge
    const rechargeRes2 = await fetch(`${baseUrl}/api/v1/voice/aligenie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '2.0',
        session: { sessionId: rechargeSessionId },
        request: {
          type: 'IntentRequest',
          requestId: 'req-r-2',
          intent: { name: 'ConfirmIntent', confirmationStatus: 'CONFIRMED' },
          input: { type: 'TEXT', value: '是的' }
        }
      })
    });
    const rechargeData2 = await rechargeRes2.json();
    assert.match(rechargeData2.response.outputSpeechs[0].text, /充值成功/);
    assert.match(rechargeData2.response.outputSpeechs[0].text, /到账 220 元/);

    // Check DB: Zhang San balance was 6200, + 22000 = 28200 (¥282.00)
    const headRecharge = await service.account(identity);
    const zhangSanRecharged = headRecharge.data.members.find(m => m.id === 'M-1');
    assert.equal(zhangSanRecharged.balance, 28200);
    assert.equal(headRecharge.data.ledgers[0].type, 'RECHARGE');
    assert.equal(headRecharge.data.ledgers[0].changeAmount, 22000);

    // Unsigned, expired, invalid signature, and unbound devices are rejected by HTTP.
    const signedBody = { requestId: randomUUID(), sessionId: randomUUID(), utterance: '查询张三余额', context: { System: { device: { deviceOpenId: 'allowed-device-888' }, user: { userOpenId: 'signed-user' } } } };
    for (const mode of ['missing', 'invalid', 'expired']) {
      const timestamp = String(mode === 'expired' ? Date.now() - 600000 : Date.now());
      const headers = { 'Content-Type': 'application/json', 'x-store-id': identity.store_id,
        'x-aligenie-timestamp': timestamp, 'x-aligenie-signature': mode === 'invalid' ? '0'.repeat(64) : signAliGenieRequest(signingSecret, timestamp, identity.store_id, signedBody) };
      if (mode === 'missing') delete headers['x-aligenie-signature'];
      const res = await globalThis.fetch(`${baseUrl}/api/v1/voice/aligenie`, { method: 'POST', headers, body: JSON.stringify(signedBody) });
      assert.equal(res.status, 401, mode);
    }
    const forbidden = await fetch(`${baseUrl}/api/v1/voice/aligenie`, { method: 'POST', body: JSON.stringify({ ...signedBody, context: { System: { device: { deviceOpenId: 'unbound' } } } }), headers: { 'Content-Type': 'application/json' } });
    assert.equal(forbidden.status, 401);

  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    await db.close();
  }
});
