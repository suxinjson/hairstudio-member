import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { DEFAULT_VOICE_CONFIG } from './voice.js';

import { transaction } from './database.js';
import { integrity, digest, ApiError } from './security.js';
import { replayOperation } from '../src/cloud-storage.js';
import { mutationPrecondition, canonicalJSON, validateOperation } from '../src/sync-protocol.js';
import { validateSnapshot } from './service.js';
import { moneyToCent } from '../src/money.js';
import { assertJsonBudget } from '../src/data-limits.js';
import { rechargeGiftCent } from '../src/recharge-settings.js';

const SESSION_TTL_MS = 5 * 60 * 1000;

function isWelcomeRequest(req) {
  const intent = req.intentName.toLowerCase(), utterance = req.utterance || '';
  const dialogReply = getDialogReply(utterance);
  if (req.confirmationRequestId || req.confirmationStatus !== 'NONE' ||
      dialogReply ||
      /(consume|recharge|query|balance|confirm|deny|cancel)/.test(intent) ||
      /(消费|扣款|扣除|结账|买单|充值|充|存|查一下|查询|查|看看|看|余额|流水)/.test(utterance)) return false;
  return (!req.intentName && !utterance) || intent.includes('welcome') || intent.includes('default') ||
    utterance === '梦飞管家' || utterance === '打开梦飞管家';
}

function getDialogReply(utterance) {
  const clean = (utterance || '').replace(/^(天猫精灵|梦飞管家|打开梦飞管家|请|帮我)/g, '').trim();
  if (/^(取消|不要|算了|不对|别记|别扣|不充|否认|不用|不用了|不要了|按错了)$/.test(clean)) return 'deny';
  if (/^(确认|确定|是的|好的|对的|没错|没问题|要的|同意|成|确认扣款|确认充值|可以|行)$/.test(clean)) return 'confirm';
  return '';
}

function welcomeResponse() {
  return formatAliGenieResponse({
    text: '梦飞管家为您服务，您可以对我说：张三洗剪吹扣款38元、李四充值200元、或查询尾号1234余额。',
    shouldEndSession: false,
    expectSpeech: true
  });
}

export function parseAliGenieRequest(body) {
  if (!body || typeof body !== 'object') {
    throw new ApiError(400, '无效的天猫精灵请求体');
  }

  const isV2 = body.version === '2.0';
  const reqV2 = body.request || {};
  const intentV2 = reqV2.intent || {};
  const payload = body.payload || {};

  const requestId = String(reqV2.requestId || body.requestId || body.header?.messageId || payload.requestId || randomUUID());
  const sessionId = String(body.session?.sessionId || body.skillSession?.skillSessionId || body.skillSession?.sessionId || body.sessionId || payload.sessionId || randomUUID());
  const isNew = Boolean(body.session?.new ?? body.skillSession?.newSession ?? payload.skillSession?.newSession ?? false);
  const intentName = String(intentV2.name || body.intentName || payload.intentName || '').trim();
  const utterance = String(reqV2.input?.value || body.utterance || payload.utterance || '').trim();

  let confirmationStatus = String(intentV2.confirmationStatus || body.confirmStatus || payload.confirmStatus || 'NONE').toUpperCase();
  if (['CONFIRMED', 'CONFIRM'].includes(confirmationStatus)) confirmationStatus = 'CONFIRMED';
  else if (['DENIED', 'DENY'].includes(confirmationStatus)) confirmationStatus = 'DENIED';
  else confirmationStatus = 'NONE';

  const deviceOpenId = String(
    body.context?.System?.device?.deviceOpenId ||
    body.requestData?.deviceOpenId ||
    body.device?.deviceId ||
    body.device?.deviceOpenId ||
    ''
  ).trim();
  const userOpenId = String(
    body.context?.System?.user?.userOpenId ||
    body.requestData?.userOpenId ||
    body.user?.userId ||
    ''
  ).trim();

  // Extract raw slots
  const rawSlots = {};
  if (intentV2.slots && typeof intentV2.slots === 'object') {
    for (const [key, slot] of Object.entries(intentV2.slots)) {
      if (!slot) continue;
      if (Array.isArray(slot.values) && slot.values.length > 0) {
        rawSlots[key] = slot.values[0];
      } else if (slot.value !== undefined && slot.value !== null) {
        rawSlots[key] = slot.value;
      }
    }
  }
  const slotList = Array.isArray(body.slotEntities)
    ? body.slotEntities
    : Array.isArray(payload.slotEntities)
      ? payload.slotEntities
      : [];
  for (const item of slotList) {
    const key = item.intentParameterName || item.slotName;
    const val = item.standardValue ?? item.originalValue ?? item.slotValue;
    if (key && val !== undefined) {
      rawSlots[key] = val;
    }
  }

  // Normalized slot aliases
  const slots = {};
  for (const [k, v] of Object.entries(rawSlots)) {
    const lk = k.toLowerCase();
    const strVal = String(v).trim();
    if (['member', 'memberquery', 'member_entity', 'customer', 'name', 'phone', 'member_name'].includes(lk)) {
      slots.member = strVal;
    } else if (['amount', 'actualamount', 'price', 'sys.price', 'money'].includes(lk)) {
      slots.amount = strVal;
    } else if (['giftamount', 'gift'].includes(lk)) {
      slots.giftAmount = strVal;
    } else if (['service', 'serviceitem', 'service_item', 'item'].includes(lk)) {
      slots.service = strVal;
    } else {
      slots[k] = strVal;
    }
  }

  return {
    version: isV2 ? '2.0' : '1.0',
    requestId,
    sessionId,
    isNew,
    intentName,
    slots,
    utterance,
    confirmationStatus,
    confirmationRequestId: String(body.confirmationRequestId || reqV2.confirmationRequestId || payload.confirmationRequestId || ''),
    deviceOpenId,
    userOpenId
  };
}

export function parseAmount(raw) {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim().replace(/(?:元|块钱|块)$/, '').trim();
  if (/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(str)) {
    try { const cents = moneyToCent(str); return cents > 0 && moneyToCent(cents / 100) === cents ? cents / 100 : null; } catch { return null; }
  }
  if (!/^[零一二两三四五六七八九十百千万]+(?:点[零一二三四五六七八九]{1,2})?$/.test(str)) return null;
  const digits = { 零:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
  const units = { 十:10, 百:100, 千:1000 };
  const [integer, fraction] = str.split('点');
  function section(text) {
    if (!text) return null;
    if (!/[十百千]/.test(text)) {
      if (text.length > 1 && !text.startsWith('零')) return null;
      return Number([...text].map(c => digits[c]).join(''));
    }
    let total = 0, digit = null, lastUnit = 10000, zero = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '零') { if (digit !== null || zero) return null; zero = true; continue; }
      if (digits[c] !== undefined) {
        if (digit !== null) return null;
        digit = digits[c];
      } else {
        const unit = units[c];
        if (!unit || unit >= lastUnit || (digit === null && !(unit === 10 && i === 0))) return null;
        total += (digit ?? 1) * unit; digit = null; lastUnit = unit; zero = false;
      }
    }
    if (zero && digit === null) return null;
    // Established speech shorthand: 一百五 means 150; 一百零五 means 105.
    return total + (digit ?? 0) * (!zero && lastUnit > 10 ? lastUnit / 10 : 1);
  }
  const parts = integer.split('万');
  if (parts.length > 2) return null;
  let result;
  if (parts.length === 2) {
    // Require explicit units for ambiguous shorthand above ten thousand.
    if (/^[一二两三四五六七八九]$/.test(parts[1])) return null;
    const high = section(parts[0]), low = parts[1] ? section(parts[1]) : 0;
    if (high === null || high <= 0 || low === null) return null;
    result = high * 10000 + low;
  } else result = section(integer);
  if (result === null) return null;
  if (fraction) result += Number([...fraction].map(c => digits[c]).join('')) / 10 ** fraction.length;
  try { return moneyToCent(result) > 0 ? result : null; } catch { return null; }
}

export function extractAmountFromUtterance(utterance, memberName = '') {
  if (!utterance) return null;
  let text = String(utterance);
  if (memberName) text = text.replaceAll(memberName, '');
  text = text.replace(/(?:手机|电话)?尾号\s*\d{3,8}|1\d{10}/g, '');
  const action = text.match(/(?:消费|扣款|扣除|结账|买单|充值|金额|实充|支付|付|充|存|扣)\s*(.+)$/);
  if (!action) return null;
  const candidate = action[1].trim().replace(/[，。！？!?]$/, '');
  return parseAmount(candidate);
}

export function cleanMemberQuery(raw) {
  if (!raw) return '';
  return String(raw)
    .trim()
    .replace(/^[给为对向]/, '')
    .replace(/^(查询|查一下|查看看|查一查|查看|找一下|找找|查|找)/, '')
    .replace(/^(会员|客户|顾客)/, '')
    .replace(/^尾号/, '')
    .replace(/[的得]$/, '')
    .replace(/[的得]?(会员|客户|顾客|账户|账本)$/, '')
    .trim();
}

export function findMatchingMembers(members, rawQuery) {
  if (!rawQuery) return [];
  const active = members.filter(m => !m.isArchived);
  const query = cleanMemberQuery(rawQuery);
  const digits = query.replace(/\D/g, '');

  // 1. Exact 11-digit phone match
  if (digits.length === 11) {
    const matched = active.filter(m => (m.phone || '').replace(/\D/g, '') === digits);
    if (matched.length > 0) return matched;
  }

  // 2. Phone suffix match (tail numbers: e.g. "尾号1234" or pure 3-8 digits)
  if (digits.length >= 3 && digits.length <= 8 && (query.includes('尾号') || !/[^\d\s]/.test(query))) {
    const matched = active.filter(m => (m.phone || '').replace(/\D/g, '').endsWith(digits));
    if (matched.length > 0) return matched;
  }

  // 3. Name exact match
  const exact = active.filter(m => m.name.trim() === query);
  if (exact.length > 0) return exact;

  // 4. Name substring match
  const substring = active.filter(m => m.name.includes(query) || query.includes(m.name));
  if (substring.length > 0) return substring;

  // 5. Fallback phone partial match (if user provided at least 4 digits)
  if (digits.length >= 4) {
    const matched = active.filter(m => (m.phone || '').replace(/\D/g, '').includes(digits));
    if (matched.length > 0) return matched;
  }

  return [];
}

export function formatDate(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    const now = new Date();
    const diffDays = Math.floor((now.setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    if (diffDays === 2) return '前天';
    if (diffDays > 0 && diffDays < 30) return `${diffDays}天前`;
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  } catch {
    return '';
  }
}

export function lookupServicePrice(services, serviceQuery) {
  if (!services || !Array.isArray(services) || !serviceQuery) return null;
  const clean = serviceQuery.trim().toLowerCase();
  const exact = services.find(s => s.name.toLowerCase() === clean);
  if (exact) return { name: exact.name, price: exact.price };
  const sub = services.find(s => s.name.toLowerCase().includes(clean) || clean.includes(s.name.toLowerCase()));
  if (sub) return { name: sub.name, price: sub.price };
  return null;
}

export function membersFromUtterance(members, utterance) {
  if (!Array.isArray(members) || !utterance) return [];
  const active = members.filter(m => !m.isArchived);
  const named = active.filter(m => m.name && utterance.includes(m.name));
  if (named.length) {
    // Ignore a prefix name only when the utterance names a longer member.
    return named.filter(m => {
      let remaining = utterance;
      for (const other of named) if (other.name !== m.name && other.name.includes(m.name)) remaining = remaining.replaceAll(other.name, '');
      return remaining.includes(m.name);
    });
  }
  const identity = utterance.match(/(?:尾号\s*(\d{3,8})|(?<!\d)(1\d{10})(?!\d))/);
  return identity ? findMatchingMembers(active, identity[1] || identity[2]) : [];
}
export function findMemberFromUtterance(members, utterance) {
  const matches = membersFromUtterance(members, utterance);
  return matches.length === 1 ? matches[0] : null;
}

export function formatAliGenieResponse({
  text,
  shouldEndSession = true,
  expectSpeech = false,
  directive = null,
  executeCode = 'SUCCESS',
  msgInfo = ''
}) {
  const cleanText = String(text || '').trim();
  const resultType = shouldEndSession ? 'RESULT' : 'ASK_INF';

  const res = {
    // Protocol 1.0 & AliGenie Standard Custom Skill Response
    returnCode: '0',
    returnErrorSolution: '',
    returnMessage: '',
    resultType,
    returnResult: {
      reply: cleanText,
      resultType,
      executeCode,
      msgInfo
    },
    returnValue: {
      reply: cleanText,
      resultType,
      executeCode,
      msgInfo
    },
    // Protocol 2.0 Response (supports both outputSpeech object and outputSpeechs array)
    version: '2.0',
    response: {
      outputSpeech: {
        type: 'PlainText',
        text: cleanText
      },
      outputSpeechs: [
        {
          type: 'PlainText',
          text: cleanText
        }
      ],
      reprompt: {
        outputSpeech: {
          type: 'PlainText',
          text: cleanText
        }
      },
      shouldEndSession: Boolean(shouldEndSession),
      expectSpeech: Boolean(expectSpeech)
    }
  };
  if (directive) {
    res.response.directives = [directive];
  }
  return res;
}

// Only the authenticated platform Header adapter should convert these rejections
// to spoken skill replies. Internal signed API calls retain their HTTP errors.
export function formatAliGeniePlatformError(error, body) {
  if (!['VOICE_IDENTIFIERS_REQUIRED', 'VOICE_DEVICE_UNBOUND'].includes(error.code)) return null;
  const req = parseAliGenieRequest(body), detail = { code: error.code };
  let text;
  if (error.code === 'VOICE_DEVICE_UNBOUND') {
    text = '当前天猫精灵设备未绑定此门店，请在后台语音设置中绑定设备后重试。';
    detail.deviceOpenId = req.deviceOpenId;
  } else {
    detail.missingFields = error.missingFields || [];
    if (detail.missingFields.length === 2 && detail.missingFields.includes('userOpenId') && detail.missingFields.includes('deviceOpenId')) {
      const recognized = [req.slots.member && `会员${req.slots.member.slice(0, 80)}`,
        req.slots.amount && `金额${req.slots.amount.slice(0, 40)}`].filter(Boolean).join('、');
      text = `平台在线测试${recognized ? `已识别${recognized}。` : '已收到您的指令。'}网页在线测试不提供用户和设备标识，不能执行真实记账。请使用已绑定门店的天猫精灵音箱进行真机测试。`;
    } else {
      text = '本次请求缺少或包含无效的记账标识，请检查后端接入配置后重试。';
    }
  }
  return formatAliGenieResponse({ text, executeCode: 'PARAMS_ERROR', msgInfo: JSON.stringify(detail) });
}

export function makeConfirmDirective() {
  return {
    type: 'Dialog.Confirm',
    confirmParaInfo: {
      confirmParameterName: 'confirm',
      denyParameterName: 'deny'
    }
  };
}

function pendingOperation(pending, data, actorId, deviceId, requestId) {
  const method = pending.action;
  const args = [method === 'consume' ? {
    memberId: pending.memberId, amount: (pending.amountCent / 100).toFixed(2),
    itemsSummary: pending.itemsSummary, remark: pending.remark, allowDebt: pending.allowDebt
  } : {
    memberId: pending.memberId, actualPay: (pending.actualCent / 100).toFixed(2),
    giftAmount: (pending.giftCent / 100).toFixed(2), payMethod: '语音充值', remark: '天猫精灵语音充值'
  }];
  const operation = { id: 'voice-' + digest(requestId), actorId, deviceId, method, args,
    precondition: mutationPrecondition(data, method, args),
    generated: { ids: ['TX' + randomUUID()], times: [new Date().toISOString()] } };
  validateOperation(operation);
  return operation;
}

export async function executeVoiceOperation({ client, storeId, account, operation }) {
  validateOperation(operation);
  const { rows: [existing] } = await client.query('SELECT * FROM operations WHERE store_id=$1 AND id=$2', [storeId, operation.id]);
  const hash = integrity(operation);
  if (existing) {
    if (existing.request_hash !== hash) throw new ApiError(409, '语音操作单号冲突');
    return { result: existing.result };
  }
  if (canonicalJSON(operation.precondition) !== canonicalJSON(mutationPrecondition(account.data, operation.method, operation.args))) {
    throw new ApiError(409, '会员资料、余额或充值规则已变化，请重新发起操作并确认', 'VOICE_PREVIEW_STALE');
  }
  const applied = replayOperation(account.data, operation), data = validateSnapshot(applied.data);
  const revision = account.revision + 1;
  await client.query('INSERT INTO operations(store_id,id,user_id,device_id,method,request_hash,result,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [storeId, operation.id, operation.actorId, operation.deviceId, operation.method, hash, applied.result, revision]);
  await client.query('UPDATE accounts SET data=$1,revision=$2,integrity=$3 WHERE store_id=$4', [data, revision, integrity(data), storeId]);
  await client.query('INSERT INTO audit_events(store_id,user_id,device_id,event,details,occurred_at) VALUES($1,$2,$3,$4,$5,$6)',
    [storeId, operation.actorId, operation.deviceId, 'voice_' + operation.method, { operationId: operation.id, result: applied.result }, operation.generated.times[0]]);
  return { result: applied.result };
}

export function signAliGenieRequest(secret, timestamp, storeId, body) {
  return createHmac('sha256', secret).update(String(timestamp) + '\n' + storeId + '\n' + canonicalJSON(body)).digest('hex');
}

export async function handleAliGenieWebhook({ pool, body, headers = {} }) {
  const storeId = headers['x-store-id'];
  const timestamp = headers['x-aligenie-timestamp'];
  const signature = headers['x-aligenie-signature'];
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(storeId || '') || !/^\d{13}$/.test(timestamp || '') ||
      Math.abs(Date.now() - Number(timestamp)) > 5 * 60000 || !/^[a-f0-9]{64}$/.test(signature || '')) {
    throw new ApiError(401, '语音请求缺少有效签名或已过期', 'VOICE_AUTH_REQUIRED');
  }
  try { assertJsonBudget(body, 32 * 1024); } catch (error) { throw new ApiError(error.status || 400, error.message); }
  const req = parseAliGenieRequest(body);
  // Parser UUID defaults are for display helpers, not durable business deduplication.
  const identityFields = {
    requestId: (body.request?.requestId || body.requestId || body.header?.messageId || body.payload?.requestId) && req.requestId.length <= 128,
    sessionId: (body.session?.sessionId || body.skillSession?.skillSessionId || body.skillSession?.sessionId || body.sessionId || body.payload?.sessionId) && req.sessionId.length <= 128,
    userOpenId: req.userOpenId && req.userOpenId.length <= 128,
    deviceOpenId: req.deviceOpenId && req.deviceOpenId.length <= 128,
    confirmationRequestId: req.confirmationRequestId.length <= 128
  };
  const missingFields = Object.keys(identityFields).filter(key => !identityFields[key]);
  const hasAccountingIdentity = missingFields.length === 0;
  const { rows: [candidate] } = await pool.query('SELECT voice_config FROM store_settings WHERE store_id=$1', [storeId]);
  const configured = candidate?.voice_config?.aligenie;
  function authenticate(config, requireBoundDevice = true) {
    if (config?.enabled !== true || config.authVersion !== 2 || !/^[a-zA-Z0-9_-]{32,100}$/.test(config.token || '') ||
        !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(signAliGenieRequest(config.token, timestamp, storeId, body), 'hex'))) {
      throw new ApiError(401, '语音签名无效、设备未绑定或功能未启用', 'VOICE_AUTH_REQUIRED');
    }
    if (requireBoundDevice && (!Array.isArray(config.allowedDevices) || !config.allowedDevices.includes(req.deviceOpenId))) {
      throw new ApiError(401, '当前天猫精灵设备未绑定此门店', 'VOICE_DEVICE_UNBOUND');
    }
  }
  // Platform launch tests may lack stable IDs or use an unbound virtual device.
  // In that case, return only a greeting; bound sessions keep their existing reset/receipt flow.
  if (isWelcomeRequest(req)) {
    authenticate(configured, false);
    if (!hasAccountingIdentity || !Array.isArray(configured.allowedDevices) || !configured.allowedDevices.includes(req.deviceOpenId)) {
      return welcomeResponse();
    }
  }
  if (!hasAccountingIdentity) {
    const error = new ApiError(400, '语音请求须提供稳定请求、会话、用户及设备标识', 'VOICE_IDENTIFIERS_REQUIRED');
    error.missingFields = missingFields;
    throw error;
  }
  authenticate(configured);
  return transaction(pool, async client => {
    const { rows: [actor] } = await client.query('SELECT * FROM users WHERE store_id=$1 AND id=$2 FOR SHARE', [storeId, configured.actorId || null]);
    if (!actor?.active || actor.role === 'viewer') throw new ApiError(403, '语音记账账号已停用或无权限');
    const { rows: [settings] } = await client.query('SELECT voice_config FROM store_settings WHERE store_id=$1 FOR SHARE', [storeId]);
    authenticate(settings?.voice_config?.aligenie);
    if (settings.voice_config.aligenie.actorId !== actor.id) throw new ApiError(409, '语音记账账号已变化，请重试');
    const { rows: [account] } = await client.query('SELECT * FROM accounts WHERE store_id=$1 FOR UPDATE', [storeId]);
    if (!account || integrity(account.data) !== account.integrity) throw new ApiError(503, '账本完整性检查失败');
    const scope = digest(canonicalJSON([storeId, actor.id, req.deviceOpenId, req.userOpenId, req.sessionId, integrity(settings.voice_config.aligenie)]));
    const receiptId = digest(scope + ':' + req.requestId), hash = integrity(body);
    const { rows: [receipt] } = await client.query('SELECT * FROM voice_requests WHERE store_id=$1 AND id=$2', [storeId, receiptId]);
    if (receipt) {
      if (receipt.request_hash !== hash) throw new ApiError(409, '语音请求单号与原内容不一致');
      return receipt.response;
    }
    await client.query('DELETE FROM voice_dialogs WHERE store_id=$1 AND expires_at<=now()', [storeId]);
    await client.query("DELETE FROM voice_requests WHERE store_id=$1 AND received_at<now()-interval '1 day'", [storeId]);
    const { rows: [counts] } = await client.query('SELECT (SELECT count(*) FROM voice_dialogs WHERE store_id=$1) AS dialogs,(SELECT count(*) FROM voice_requests WHERE store_id=$1) AS requests', [storeId]);
    if (Number(counts.requests) >= 10000) throw new ApiError(429, '语音请求过多，请稍后重试');
    const { rows: [dialog] } = await client.query('SELECT pending FROM voice_dialogs WHERE store_id=$1 AND scope=$2', [storeId, scope]);
    let nextPending = req.isNew ? null : dialog?.pending || null;
    const sessionStore = {
      get: () => nextPending,
      delete: () => { nextPending = null; },
      set: (_key, value) => { nextPending = { ...value, previewRequestId: req.requestId, servicesIntegrity: integrity(account.data.services || []), operation: pendingOperation(value, account.data, actor.id, 'voice-' + digest(req.deviceOpenId), receiptId) }; }
    };
    const response = await dispatchVoiceDialog({ req, account, client, targetStoreId: storeId, sessionStore });
    if (nextPending && !dialog && Number(counts.dialogs) >= 256) throw new ApiError(429, '语音待确认操作过多，请稍后重试');
    if (nextPending?.previewRequestId === req.requestId) response.confirmationRequestId = req.requestId;
    if (nextPending) await client.query('INSERT INTO voice_dialogs(store_id,scope,pending,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(store_id,scope) DO UPDATE SET pending=$3,expires_at=$4', [storeId, scope, nextPending, new Date(nextPending.expiresAt)]);
    else await client.query('DELETE FROM voice_dialogs WHERE store_id=$1 AND scope=$2', [storeId, scope]);
    await client.query('INSERT INTO voice_requests(store_id,id,request_hash,response) VALUES($1,$2,$3,$4)', [storeId, receiptId, hash, response]);
    return response;
  });
}

async function dispatchVoiceDialog({ req, account, client, targetStoreId, sessionStore }) {
    const now = Date.now(), accountData = account.data;
    const members = accountData.members || [], services = accountData.services || [];
    const rechargeSettings = accountData.rechargeSettings;
    // 3. Multi-turn Session Check (Pending Confirmation)
    const pending = sessionStore.get(req.sessionId);
    const dialogReply = getDialogReply(req.utterance);

    if (pending && (req.confirmationStatus === 'DENIED' || dialogReply === 'deny')) {
      sessionStore.delete(req.sessionId);
      return formatAliGenieResponse({
        text: '已为您取消本次操作。',
        shouldEndSession: true
      });
    }

    if (pending && (req.confirmationStatus === 'CONFIRMED' || dialogReply === 'confirm' || req.intentName === 'ConfirmIntent')) {
      if (req.confirmationRequestId !== pending.previewRequestId) return formatAliGenieResponse({ text: '确认请求与本次预览不匹配，请重新核对并确认。', shouldEndSession: false, expectSpeech: true });
      if (pending.servicesIntegrity !== integrity(account.data.services || [])) {
        sessionStore.delete(req.sessionId);
        return formatAliGenieResponse({ text: '服务价格已变化，请重新发起操作并确认。', shouldEndSession: true });
      }
      if (pending.action === 'consume') {
        try {
          const { result } = await executeVoiceOperation({ client, storeId: targetStoreId, account, operation: pending.operation });
          sessionStore.delete(req.sessionId);
          const balanceYuan = (result.balanceAfter / 100).toFixed(2);
          const debtText = result.balanceAfter < 0
            ? `当前已欠款 ${Math.abs(result.balanceAfter / 100).toFixed(2)} 元。`
            : `卡内当前剩余 ${balanceYuan} 元。`;
          return formatAliGenieResponse({
            text: `扣款成功！已为会员${pending.memberName}扣除 ${(pending.amountCent / 100).toFixed(2)} 元，${debtText}`,
            shouldEndSession: true
          });
        } catch (err) {
          if (err.code === 'VOICE_PREVIEW_STALE') sessionStore.delete(req.sessionId);
          else throw err;
          return formatAliGenieResponse({
            text: `扣款失败：${err.message}`,
            shouldEndSession: true
          });
        }
      } else if (pending.action === 'recharge') {
        try {
          const { result } = await executeVoiceOperation({ client, storeId: targetStoreId, account, operation: pending.operation });
          sessionStore.delete(req.sessionId);
          const balanceYuan = (result.balanceAfter / 100).toFixed(2);
          return formatAliGenieResponse({
            text: `充值成功！会员${pending.memberName}已到账 ${(result.totalCredit / 100).toFixed(2)} 元，卡内当前余额 ${balanceYuan} 元。`,
            shouldEndSession: true
          });
        } catch (err) {
          if (err.code === 'VOICE_PREVIEW_STALE') sessionStore.delete(req.sessionId);
          else throw err;
          return formatAliGenieResponse({
            text: `充值失败：${err.message}`,
            shouldEndSession: true
          });
        }
      }
    }

    // 4. Intent Dispatch
    const normalizedIntent = req.intentName.toLowerCase();
    const utterance = req.utterance || '';
    if (isWelcomeRequest(req)) return welcomeResponse();

    // B. Query Member / Balance Intent
    if (normalizedIntent.includes('query') || normalizedIntent.includes('balance') || /(查一下|查询|查|看看|看|余额|流水)/.test(utterance)) {
      const memberQuery = req.slots.member || utterance;
      if (!memberQuery || memberQuery.length < 1) {
        return formatAliGenieResponse({
          text: '请问您想查询哪位会员，或者报手机尾号？',
          shouldEndSession: false,
          expectSpeech: true
        });
      }
      const matched = req.slots.member ? findMatchingMembers(members, memberQuery) : membersFromUtterance(members, utterance);
      if (matched.length === 0) {
        return formatAliGenieResponse({
          text: `未在会员库中找到“${cleanMemberQuery(memberQuery)}”，请核对姓名或报手机尾号重试。`,
          shouldEndSession: true
        });
      }
      if (matched.length > 1) {
        const names = matched.slice(0, 3).map(m => `${m.name}（手机尾号${(m.phone || '').slice(-4)}）`).join('、');
        return formatAliGenieResponse({
          text: `找到多位会员：${names}，请问您要查询哪一位？`,
          shouldEndSession: false,
          expectSpeech: true
        });
      }

      const m = matched[0];
      const balanceYuan = (m.balance / 100).toFixed(2);
      let reply = '';
      if (m.balance < 0) {
        reply = `会员${m.name}当前卡内欠款 ${Math.abs(m.balance / 100).toFixed(2)} 元。`;
      } else {
        reply = `会员${m.name}当前卡内余额 ${balanceYuan} 元，累计充值 ${(m.total_recharge / 100).toFixed(2)} 元。`;
      }

      const lastConsume = (accountData.ledgers || [])
        .filter(l => l.memberId === m.id && l.type === 'CONSUME')
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      if (lastConsume) {
        const visitDate = formatDate(lastConsume.created_at);
        if (visitDate) reply += ` 上次到店是 ${visitDate}。`;
      }
      if (m.notes && m.notes.trim()) {
        reply += ` 偏好备注：${m.notes.trim()}。`;
      }
      return formatAliGenieResponse({
        text: reply,
        shouldEndSession: true
      });
    }

    // C. Consume Intent (扣款消费)
    if (normalizedIntent.includes('consume') || /(消费|扣款|扣除|结账|买单)/.test(utterance)) {
      const memberQuery = req.slots.member || utterance;
      if (!memberQuery) {
        return formatAliGenieResponse({
          text: '请问是哪位会员需要扣款？',
          shouldEndSession: false,
          expectSpeech: true
        });
      }

      const matched = req.slots.member ? findMatchingMembers(members, memberQuery) : membersFromUtterance(members, utterance);
      if (matched.length === 0) {
        return formatAliGenieResponse({
          text: `未在会员库中找到“${cleanMemberQuery(memberQuery)}”，请核对姓名或报手机尾号重试。`,
          shouldEndSession: true
        });
      }
      if (matched.length > 1) {
        const names = matched.slice(0, 3).map(m => `${m.name}（手机尾号${(m.phone || '').slice(-4)}）`).join('、');
        return formatAliGenieResponse({
          text: `找到多位会员：${names}，请问是哪一位？`,
          shouldEndSession: false,
          expectSpeech: true
        });
      }

      const m = matched[0];
      let amount = req.slots.amount !== undefined ? parseAmount(req.slots.amount) : extractAmountFromUtterance(utterance, m.name);
      let itemsSummary = req.slots.service || '洗剪吹理发';

      // If amount is not explicitly provided, try to look up service price
      if (!amount && req.slots.amount === undefined && !/(?:消费|扣款|扣除|结账|买单)\s*[-+\d零一二两三四五六七八九十百千万]/.test(utterance.replaceAll(m.name, ''))) {
        const foundService = lookupServicePrice(services, req.slots.service || utterance);
        if (foundService) {
          amount = foundService.price;
          itemsSummary = foundService.name;
        }
      }

      if (!amount) {
        return formatAliGenieResponse({
          text: `已找到会员${m.name}，请问本次消费扣款多少元？`,
          shouldEndSession: false,
          expectSpeech: true
        });
      }

      const amountCent = moneyToCent(amount);
      const balanceBefore = m.balance;
      const balanceAfter = balanceBefore - amountCent;
      const allowDebt = balanceAfter < 0;

      let confirmPrompt = '';
      if (allowDebt) {
        confirmPrompt = `会员${m.name}当前卡内余额仅为 ${(balanceBefore / 100).toFixed(2)} 元，本次扣款 ${(amountCent / 100).toFixed(2)} 元后将产生欠款 ${Math.abs(balanceAfter / 100).toFixed(2)} 元，请问确认扣款并记入欠款吗？`;
      } else {
        confirmPrompt = `会员${m.name}本次${itemsSummary}消费 ${(amountCent / 100).toFixed(2)} 元，扣款后卡内剩余 ${(balanceAfter / 100).toFixed(2)} 元，请问确认扣款吗？`;
      }

      // Save pending action in session cache
      sessionStore.set(req.sessionId, {
        action: 'consume',
        memberId: m.id,
        memberName: m.name,
        amountCent,
        itemsSummary,
        allowDebt,
        remark: '天猫精灵语音扣款',
        expiresAt: now + SESSION_TTL_MS
      });

      return formatAliGenieResponse({
        text: confirmPrompt,
        shouldEndSession: false,
        expectSpeech: true,
        directive: makeConfirmDirective()
      });
    }

    // D. Recharge Intent (充值储值)
    if (normalizedIntent.includes('recharge') || /(充值|充|存)/.test(utterance)) {
      const memberQuery = req.slots.member || utterance;
      if (!memberQuery) {
        return formatAliGenieResponse({
          text: '请问要为哪位会员充值？',
          shouldEndSession: false,
          expectSpeech: true
        });
      }

      const matched = req.slots.member ? findMatchingMembers(members, memberQuery) : membersFromUtterance(members, utterance);
      if (matched.length === 0) {
        return formatAliGenieResponse({
          text: `未在会员库中找到“${cleanMemberQuery(memberQuery)}”，请核对姓名或报手机尾号重试。`,
          shouldEndSession: true
        });
      }
      if (matched.length > 1) {
        const names = matched.slice(0, 3).map(m => `${m.name}（手机尾号${(m.phone || '').slice(-4)}）`).join('、');
        return formatAliGenieResponse({
          text: `找到多位会员：${names}，请问是哪一位？`,
          shouldEndSession: false,
          expectSpeech: true
        });
      }

      const m = matched[0];
      const amount = req.slots.amount !== undefined ? parseAmount(req.slots.amount) : extractAmountFromUtterance(utterance, m.name);
      if (!amount) {
        return formatAliGenieResponse({
          text: `已找到会员${m.name}，请问充值多少金额？`,
          shouldEndSession: false,
          expectSpeech: true
        });
      }

      const actualCent = moneyToCent(amount);
      let giftCent = 0;
      if (req.slots.giftAmount) {
        const g = parseAmount(req.slots.giftAmount);
        if (!g && !/^(?:0(?:\.0{1,2})?|零)(?:元|块钱|块)?$/.test(req.slots.giftAmount)) return formatAliGenieResponse({ text: '赠送金额无效，请重新报金额。', shouldEndSession: false, expectSpeech: true });
        if (g) giftCent = moneyToCent(g);
      } else {
        giftCent = rechargeGiftCent((actualCent / 100).toFixed(2), rechargeSettings);
      }

      const totalCent = actualCent + giftCent;
      const balanceAfter = m.balance + totalCent;

      let confirmPrompt = '';
      if (giftCent > 0) {
        confirmPrompt = `即将为会员${m.name}实充 ${(actualCent / 100).toFixed(2)} 元，赠送 ${(giftCent / 100).toFixed(2)} 元，合计到账 ${(totalCent / 100).toFixed(2)} 元，到账后卡内余额为 ${(balanceAfter / 100).toFixed(2)} 元，请问确认充值吗？`;
      } else {
        confirmPrompt = `即将为会员${m.name}充值 ${(actualCent / 100).toFixed(2)} 元，充值后卡内余额为 ${(balanceAfter / 100).toFixed(2)} 元，请问确认充值吗？`;
      }

      sessionStore.set(req.sessionId, {
        action: 'recharge',
        memberId: m.id,
        memberName: m.name,
        actualCent,
        giftCent,
        expiresAt: now + SESSION_TTL_MS
      });

      return formatAliGenieResponse({
        text: confirmPrompt,
        shouldEndSession: false,
        expectSpeech: true,
        directive: makeConfirmDirective()
      });
    }

    // E. Fallback
    return formatAliGenieResponse({
      text: '抱歉，梦飞管家暂未理解该指令。您可以说：张三洗剪吹扣款38元、李四充值200元、或查询尾号1234余额。',
      shouldEndSession: true
    });
}

export async function getAliGenieVerificationContent(fileName, pool) {
  if (!/^[a-zA-Z0-9_-]+\.txt$/.test(fileName)) return null;

  // 1. 从数据库 store_settings 中读取天猫精灵校验内容
  if (pool) {
    try {
      const { rows } = await pool.query(
        "SELECT voice_config FROM store_settings WHERE voice_config->'aligenie'->>'verificationFile' = $1 LIMIT 1",
        [fileName]
      );
      if (rows[0]?.voice_config?.aligenie?.verificationContent) {
        return rows[0].voice_config.aligenie.verificationContent.trim();
      }
    } catch {}
  }

  // 2. 匹配预设默认校验文件名与内容（全在内存/数据库，无需任何磁盘文件）
  if (DEFAULT_VOICE_CONFIG.aligenie?.verificationFile === fileName) {
    return DEFAULT_VOICE_CONFIG.aligenie.verificationContent;
  }

  return null;
}
