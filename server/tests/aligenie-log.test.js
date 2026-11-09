import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../http.js';
import { ApiError } from '../security.js';
import { createAliGenieTrace, redactAliGenieText } from '../aligenie-log.js';
import { formatAliGenieResponse, parseAliGenieRequest, parseAmount } from '../aligenie.js';

const secret = 'platform-secret-for-log-tests-1234567890';
const body = { requestId: 'request-private', sessionId: 'system-session-private', intentId: 3, intentName: 'ConsumeIntent',
  utterance: '手机号幺三八零零零零幺二三四消费一百元',
  requestData: { deviceOpenId: 'private-device', userOpenId: 'private-user' },
  skillSession: { skillSessionId: 'private-skill-session', newSession: false },
  slotEntities: [
    { intentParameterName: 'memberQuery', slotName: 'memberQuery:member_entity', originalValue: '13800001234', standardValue: '13800001234', liveTime: 1, createTimeStamp: 123456 },
    { intentParameterName: 'amount', slotName: 'amount:sys.price', originalValue: '一百元',
      standardValue: JSON.stringify({ success: true, type: 'CNY', unit: '元', value: 100, token: secret }), liveTime: 0, createTimeStamp: 234567 },
    { intentParameterName: 'apiKey', originalValue: secret, standardValue: secret }
  ] };

async function startApi(t, service, logger) {
  const pool = { query: async () => ({ rows: [{ store_id: 'store-test', voice_config: { aligenie: { enabled: true, token: secret } } }] }) };
  const server = createApi({ pool, service, aligenieLogger: logger });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return (payload, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/v1/voice/aligenie`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-aligenie-token': secret, ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload)
  });
}

test('AliGenie diagnostics correlate turns and redact credentials and Arabic/spoken phone identities', () => {
  const records = [], trace = createAliGenieTrace(record => records.push(record));
  trace.received(body, 'platform_or_unsigned'); trace.parsed(parseAliGenieRequest(body), body);
  trace.state('pending_loaded', { hasPending: false });
  trace.response(200, formatAliGenieResponse({ text: '手机号13800001234消费100元，确认吗？', shouldEndSession: false }));
  const text = JSON.stringify(records);
  for (const value of [secret, body.requestId, body.sessionId, 'private-device', 'private-user', 'private-skill-session', '13800001234', '幺三八零零零零幺二三四']) assert.ok(!text.includes(value), value);
  assert.match(text, /138\*\*\*\*1234/);
  assert.equal(records[2].slots.amount, '一百元');
  assert.equal(records[2].slotEntities[1].liveTime, 0);
  assert.equal(records[2].slotEntities[2].standard, undefined);
  assert.equal(records.at(-1).status, 200);
  assert.ok(records.every(record => record.traceId === records[0].traceId));
  const next = createAliGenieTrace(record => records.push(record)); next.received({ ...body, requestId: 'next-turn' }, 'platform_or_unsigned');
  assert.equal(records.at(-1).skillSessionRef, records[1].skillSessionRef);
  assert.notEqual(records.at(-1).requestRef, records[1].requestRef);
  assert.equal(redactAliGenieText('张三消费100元'), '张三消费100元');
  assert.equal(redactAliGenieText('手机138 0000 1234'), '手机138****1234');
  assert.equal(redactAliGenieText('幺 三 八 零 零 零 零 幺 二 三 四'), '138****1234');
});

test('sys.price JSON uses validated original CNY speech rather than arbitrary normalized numeric fields', () => {
  for (const [original, expected] of [['一百元', 100], ['38.50元', 38.5], ['两百元', 200]]) {
    const request = { slotEntities: [{ intentParameterName: 'amount', originalValue: original,
      standardValue: JSON.stringify({ success: true, type: 'CNY', unit: '元', value: 999 }) }] };
    assert.equal(parseAmount(parseAliGenieRequest(request).slots.amount), expected);
  }
  for (const [price, original] of [
    [{ success: false, type: 'CNY', unit: '元' }, '一百元'],
    [{ success: true, type: 'USD', unit: '美元' }, '一百元'],
    [{ success: true, type: 'CNY', unit: '角' }, '一百元'],
    [{ success: true, type: 'CNY', unit: '元' }, '-100元'],
    [{ success: true, type: 'CNY', unit: '元' }, '100元垃圾'],
    [{ success: true, type: 'CNY', unit: '元' }, '13800001234'],
    [{ success: true, type: 'CNY', unit: '元' }, ''],
  ]) {
    const request = { slotEntities: [{ intentParameterName: 'amount', originalValue: original, standardValue: JSON.stringify(price) }] };
    assert.equal(parseAmount(parseAliGenieRequest(request).slots.amount), null);
  }
});

test('HTTP diagnostics capture recognized fields and replies without copying any request headers or token URL', async t => {
  const records = [];
  const post = await startApi(t, { async handleAliGenieWebhook(input, options) {
    assert.equal(options.platformTokenAuthenticated, true);
    options.trace.state('transaction_committed');
    return formatAliGenieResponse({ text: '已收到会员与金额', shouldEndSession: false });
  } }, record => records.push(record));
  const res = await post(body, { Authorization: 'Bearer another-secret-in-headers' });
  assert.equal(res.status, 200);
  assert.equal(records.at(-1).event, 'aligenie.response');
  assert.equal(records.at(-1).resultType, 'ASK_INF');
  assert.ok(records.some(record => record.event === 'aligenie.parsed' && record.slots.amount === '一百元'));
  assert.ok(!JSON.stringify(records).includes(secret));
  assert.ok(!JSON.stringify(records).includes('another-secret-in-headers'));
});

test('HTTP rejections and malformed JSON are logged once with accurate statuses', async t => {
  const records = [];
  const post = await startApi(t, { async handleAliGenieWebhook() { throw new ApiError(401, '拒绝请求', 'VOICE_AUTH_REQUIRED'); } }, record => records.push(record));
  assert.equal((await post(body)).status, 401);
  assert.equal(records.filter(record => record.event === 'aligenie.rejected').length, 1);
  assert.equal(records.at(-1).status, 401);
  records.length = 0;
  assert.equal((await post('{')).status, 400);
  assert.equal(records.filter(record => record.event === 'aligenie.rejected').length, 1);
  assert.equal(records.at(-1).status, 400);
});

test('platform actor-change replies use fixed explanations and unexpected server errors remain HTTP errors', async t => {
  const records = [], privateMessage = 'internal credential must never be spoken';
  let error = new ApiError(409, privateMessage, 'VOICE_ACTOR_CHANGED');
  const post = await startApi(t, { async handleAliGenieWebhook() { throw error; } }, record => records.push(record));
  const res = await post(body), reply = await res.json();
  assert.equal(res.status, 200);
  assert.match(reply.returnValue.reply, /记账账号已变化/);
  assert.equal(JSON.parse(reply.returnValue.msgInfo).code, 'VOICE_ACTOR_CHANGED');
  assert.ok(!JSON.stringify(reply).includes(privateMessage));
  assert.ok(records.some(record => record.event === 'aligenie.rejected' && record.status === 409));
  error = new Error(privateMessage);
  const unexpected = await post({ ...body, requestId: 'unexpected-error' });
  assert.equal(unexpected.status, 500);
  assert.deepEqual(await unexpected.json(), { error: '服务暂时不可用，请稍后重试', code: 'REQUEST_FAILED' });
  assert.ok(!JSON.stringify(records).includes(privateMessage));
});

test('broken log writers cannot prevent HTTP replies', async t => {
  const post = await startApi(t, { async handleAliGenieWebhook() { return formatAliGenieResponse({ text: '处理完成' }); } }, () => { throw new Error('log writer unavailable'); });
  const res = await post(body); assert.equal(res.status, 200); assert.equal((await res.json()).returnValue.reply, '处理完成');
});
