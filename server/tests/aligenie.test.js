import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrate } from '../database.js';
import { createService } from '../service.js';
import { createApi } from '../http.js';
import { DEFAULT_SERVICES, DEFAULT_RECHARGE_PLANS } from '../../src/storage.js';
import {
  parseAliGenieRequest,
  parseAmount,
  cleanMemberQuery,
  findMatchingMembers,
  lookupServicePrice,
  formatAliGenieResponse
} from '../aligenie.js';

test('AliGenie parser and utility functions', () => {
  // 1. Amount parsing
  assert.equal(parseAmount('38元'), 38);
  assert.equal(parseAmount('38.5块钱'), 38.5);
  assert.equal(parseAmount('100'), 100);
  assert.equal(parseAmount('0'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount(null), null);

  // 2. Member query cleaning
  assert.equal(cleanMemberQuery('给张三'), '张三');
  assert.equal(cleanMemberQuery('为李四会员'), '李四');
  assert.equal(cleanMemberQuery('查一下王五'), '王五');
  assert.equal(cleanMemberQuery('查询客户赵六'), '赵六');
  assert.equal(cleanMemberQuery('尾号1234'), '1234');

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
  const filePath = resolve('./server/aligenie', testFileName);
  await mkdir(resolve('./server/aligenie'), { recursive: true });
  await writeFile(filePath, 'test_verify_hash_9876543210', 'utf8');

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
    assert.match(welcomeData.response.outputSpeechs[0].text, /梦飞管家为您服务/);
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
    assert.match(queryData1.response.outputSpeechs[0].text, /卡内余额 100.00 元/);
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
    assert.match(queryData2.response.outputSpeechs[0].text, /20.00 元/);

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
    assert.match(queryData3.response.outputSpeechs[0].text, /当前卡内欠款 15.00 元/);

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
    assert.match(consumeData1.response.outputSpeechs[0].text, /本次洗剪吹理发消费 38.00 元/);
    assert.match(consumeData1.response.outputSpeechs[0].text, /扣款后卡内剩余 62.00 元/);
    assert.match(consumeData1.response.outputSpeechs[0].text, /请问确认扣款吗/);
    assert.equal(consumeData1.response.directives[0].type, 'Dialog.Confirm');
    assert.equal(consumeData1.response.shouldEndSession, false);

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
    assert.match(consumeData2.response.outputSpeechs[0].text, /扣除 38.00 元/);
    assert.match(consumeData2.response.outputSpeechs[0].text, /卡内当前剩余 62.00 元/);
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
    assert.match(debtData1.response.outputSpeechs[0].text, /余额仅为 20.00 元/);
    assert.match(debtData1.response.outputSpeechs[0].text, /产生欠款 18.00 元/);
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
    assert.match(debtData2.response.outputSpeechs[0].text, /当前已欠款 18.00 元/);

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
    assert.match(rechargeData1.response.outputSpeechs[0].text, /实充 200.00 元/);
    assert.match(rechargeData1.response.outputSpeechs[0].text, /赠送 20.00 元/);
    assert.match(rechargeData1.response.outputSpeechs[0].text, /合计到账 220.00 元/);
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
    assert.match(rechargeData2.response.outputSpeechs[0].text, /到账 220.00 元/);

    // Check DB: Zhang San balance was 6200, + 22000 = 28200 (¥282.00)
    const headRecharge = await service.account(identity);
    const zhangSanRecharged = headRecharge.data.members.find(m => m.id === 'M-1');
    assert.equal(zhangSanRecharged.balance, 28200);
    assert.equal(headRecharge.data.ledgers[0].type, 'RECHARGE');
    assert.equal(headRecharge.data.ledgers[0].changeAmount, 22000);

    // 9. Test Security: Device Whitelist & Token
    // Configure store with allowedDevices and token
    await service.saveVoiceConfig(identity, {
      aligenie: {
        enabled: true,
        token: 'secret-token-xyz',
        allowedDevices: ['allowed-device-888']
      }
    });

    // 9.1 Invalid token rejected
    const badTokenRes = await fetch(`${baseUrl}/api/v1/voice/aligenie?token=wrong-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '2.0',
        request: { intent: { name: 'DefaultWelcomeIntent' } }
      })
    });
    const badTokenData = await badTokenRes.json();
    assert.match(badTokenData.response.outputSpeechs[0].text, /语音认证口令错误/);

    // 9.2 Unauthorized device rejected
    const badDevRes = await fetch(`${baseUrl}/api/v1/voice/aligenie?token=secret-token-xyz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '2.0',
        context: { System: { device: { deviceOpenId: 'unauthorized-dev' } } },
        request: { intent: { name: 'DefaultWelcomeIntent' } }
      })
    });
    const badDevData = await badDevRes.json();
    assert.match(badDevData.response.outputSpeechs[0].text, /尚未绑定本店/);

    // 9.3 Authorized device and valid token accepted
    const goodRes = await fetch(`${baseUrl}/api/v1/voice/aligenie?token=secret-token-xyz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '2.0',
        context: { System: { device: { deviceOpenId: 'allowed-device-888' } } },
        request: { intent: { name: 'DefaultWelcomeIntent' } }
      })
    });
    const goodData = await goodRes.json();
    assert.match(goodData.response.outputSpeechs[0].text, /梦飞管家为您服务/);

  } finally {
    try { await unlink(filePath); } catch {}
    await new Promise(r => server.close(r));
  }
});
