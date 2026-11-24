import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { DEFAULT_VOICE_CONFIG } from './voice.js';

import { transaction } from './database.js';
import { integrity, digest, ApiError } from './security.js';
import { canonicalJSON } from '../src/canonical-json.js';
import { moneyToCent } from '../src/money.js';
import { normalizeVoiceText } from '../src/voice-text.js';
import { assertJsonBudget } from '../src/data-limits.js';
import { readStoreProfile } from './store-profile.js';
import { storeWelcome } from '../src/store-profile.js';
import { storeEntitlement, requireFeature } from './entitlements.js';
import { centsString } from '../src/ledger-domain.js';
import { createRelationalVoice, voiceYuan } from './relational-voice.js';

const SESSION_TTL_MS = 5 * 60 * 1000;

function isWelcomeRequest(req) {
  const intent = req.intentName.toLowerCase(), utterance = req.utterance || '';
  const dialogReply = getDialogReply(utterance);
  if (req.confirmationRequestId || req.confirmationStatus !== 'NONE' ||
      dialogReply ||
      /(consume|recharge|query|balance|confirm|deny|cancel)/.test(intent) ||
      /(消费|扣款|扣除|结账|买单|充值|充|存|查一下|查询|查|看看|看|余额|流水)/.test(utterance)) return false;
  return (!req.intentName && !utterance) || intent.includes('welcome') || intent.includes('default') ||
    /^(?:打开)?(?:会员管家|梦飞管家)$/.test(utterance);
}

function getDialogReply(utterance) {
  const clean = (utterance || '').replace(/^(天猫精灵|打开会员管家|会员管家|打开梦飞管家|梦飞管家|请|帮我)/g, '').trim();
  if (/^(取消|不要|算了|不对|别记|别扣|不充|否认|不用|不用了|不要了|按错了)$/.test(clean)) return 'deny';
  if (/^(确认|确定|是的|好的|对的|没错|没问题|要的|同意|成|确认扣款|确认充值|可以|行)$/.test(clean)) return 'confirm';
  return '';
}

function resolveBusinessIntent(req, members) {
  const intent = req.intentName.toLowerCase();
  // A recognized business intent takes precedence over words in names or services.
  if (/(query|balance)/.test(intent)) return 'query';
  if (intent.includes('consume')) return 'consume';
  if (intent.includes('recharge')) return 'recharge';
  // Older requests may have no recognized intent. Remove known member names
  // before inferring the action so names such as 查女士 or 消费顾客 stay literal.
  let command = req.utterance || '';
  for (const member of membersFromUtterance(members, command)) command = command.replaceAll(member.name, '');
  if (/(查一下|查询|查|看看|看|余额|流水)/.test(command)) return 'query';
  if (/(消费|扣款|扣除|结账|买单)/.test(command)) return 'consume';
  if (/(充值|充|存)/.test(command)) return 'recharge';
  return '';
}

function welcomeResponse(profile) {
  return formatAliGenieResponse({
    text: storeWelcome(profile),
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
    const val = /^(amount|actualamount|price|sys\.price|money|giftamount|gift)$/i.test(key || '')
      ? normalizeMoneySlot(item) : item.standardValue ?? item.originalValue ?? item.slotValue;
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
    intentId: body.intentId || payload.intentId || null,
    slots,
    utterance,
    confirmationStatus,
    confirmationRequestId: String(body.confirmationRequestId || reqV2.confirmationRequestId || payload.confirmationRequestId || ''),
    platformConfirmation: isV2 ? null : platformConfirmationSnapshot(body, slotList),
    deviceOpenId,
    userOpenId
  };
}

function normalizeMoneySlot(slot) {
  const standard = slot.standardValue ?? slot.originalValue ?? slot.slotValue;
  let price = standard;
  if (typeof standard === 'string' && standard.trim().startsWith('{')) {
    try { price = JSON.parse(standard); } catch { return standard; }
  }
  if (price && typeof price === 'object' && !Array.isArray(price)) {
    // sys.price can return a JSON normalization result. Its originalValue is
    // the actual spoken amount; do not pick an arbitrary number from the JSON.
    const original = String(slot.originalValue ?? slot.slotValue ?? '').trim();
    if (price.success === true && price.type === 'CNY' && ['元', '块', '块钱'].includes(price.unit) &&
        parseVoiceCents(original) !== null) return original;
    return typeof standard === 'string' ? standard : JSON.stringify(standard);
  }
  return standard;
}

// Web Service 1.0 retains slot creation timestamps and advances liveTime on
// confirmation. Unlike custom response attributes, these fields round-trip.
function platformConfirmationSnapshot(body, slotList) {
  const intentName = String(body.intentName || '').trim();
  if (!/^(ConsumeIntent|RechargeIntent)$/.test(intentName) || !slotList.length) return null;
  const ids = [body.domainId, body.skillId, body.intentId].map(Number);
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return null;
  const names = new Set(), slots = [];
  for (const slot of slotList) {
    const name = slot.intentParameterName;
    const parameterId = Number(slot.intentParameterId), createdAt = Number(slot.createTimeStamp), liveTime = slot.liveTime;
    if (typeof name !== 'string' || !name || names.has(name) ||
        !Number.isSafeInteger(parameterId) || parameterId <= 0 ||
        !Number.isSafeInteger(createdAt) || createdAt <= 0 ||
        !Number.isSafeInteger(liveTime) || liveTime < 0 ||
        ['originalValue', 'standardValue', 'slotName', 'slotValue'].some(key => typeof slot[key] !== 'string')) return null;
    names.add(name);
    slots.push({ name, parameterId, createdAt, liveTime,
      originalValue: slot.originalValue, standardValue: slot.standardValue,
      slotName: slot.slotName, slotValue: slot.slotValue });
  }
  if (!names.has('memberQuery') || !(names.has('amount') || (intentName === 'ConsumeIntent' && names.has('service')))) return null;
  slots.sort((a, b) => a.name.localeCompare(b.name));
  return { ids, intentName, slots };
}

function matchesPlatformConfirmation(preview, current) {
  if (!preview || !current) return false;
  const expected = { ...preview, slots: preview.slots.map(slot => ({ ...slot, liveTime: slot.liveTime + 1 })) };
  return canonicalJSON(expected) === canonicalJSON(current);
}

function parseVoiceCents(raw) {
  if (raw === undefined || raw === null) return null;
  const spoken = String(raw).trim();
  if (spoken.length > 64) return null;
  // NLU can put an unrecognized member's mobile number into the amount slot.
  // A bare mobile number is ambiguous identity input, not an explicit price.
  if (/^1[3-9]\d{9}$/.test(spoken)) return null;
  const str = spoken.replace(/(?:元|块钱|块)$/, '').trim();
  if (/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(str)) {
    const [whole, fraction = ''] = str.split('.');
    try { return centsString(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))); } catch { return null; }
  }
  if (!/^[零一二两三四五六七八九十百千万]+(?:点[零一二三四五六七八九]{1,2})?$/.test(str)) return null;
  const digits = { 零:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
  const units = { 十:10, 百:100, 千:1000 };
  const [integer, fraction] = str.split('点');
  function section(text) {
    if (!text) return null;
    if (!/[十百千]/.test(text)) {
      if (text.length > 1 && !text.startsWith('零')) return null;
      return BigInt([...text].map(c => digits[c]).join(''));
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
    return BigInt(total + (digit ?? 0) * (!zero && lastUnit > 10 ? lastUnit / 10 : 1));
  }
  const parts = integer.split('万');
  if (parts.length > 2) return null;
  let result;
  if (parts.length === 2) {
    // Require explicit units for ambiguous shorthand above ten thousand.
    if (/^[一二两三四五六七八九]$/.test(parts[1])) return null;
    const high = section(parts[0]), low = parts[1] ? section(parts[1]) : 0n;
    if (high === null || high <= 0n || low === null) return null;
    result = high * 10000n + low;
  } else result = section(integer);
  if (result === null) return null;
  const decimal = fraction ? [...fraction].map(c => digits[c]).join('').padEnd(2, '0') : '0';
  try { return centsString(result * 100n + BigInt(decimal)); } catch { return null; }
}

export function parseAmount(raw) {
  const cents = parseVoiceCents(raw);
  if (cents === null || cents === '0') return null;
  const result = Number(cents) / 100;
  try { return String(moneyToCent(result)) === cents ? result : null; } catch { return null; }
}

function spokenAmountCandidate(utterance, memberName = '') {
  if (!utterance) return null;
  let text = String(utterance);
  if (memberName) text = text.replaceAll(memberName, '');
  text = text.replace(/(?:手机|电话)?尾号\s*[\d零〇一幺二两三四五六七八九]{3,8}(?![\d零〇一幺二两三四五六七八九])|(?<![\d.])1[3-9]\d{9}(?![\d.]|\s*(?:元|块))/g, '');
  const action = text.match(/(?:消费|扣款|扣除|结账|买单|充值|金额|实充|支付|付|充|存|扣)\s*(.+)$/);
  if (!action) return null;
  return action[1].trim().replace(/[，。！？!?]$/, '');
}

export function extractAmountFromUtterance(utterance, memberName = '') {
  return parseAmount(spokenAmountCandidate(utterance, memberName));
}

function stripMemberQuery(raw) {
  if (!raw) return '';
  return String(raw)
    .trim()
    .replace(/^[给为对向]/, '')
    .replace(/^(查询|查一下|查看看|查一查|查看|找一下|找找|查|找)/, '')
    .replace(/^(会员|客户|顾客|用户)/, '')
    .replace(/^尾号/, '')
    .replace(/[的得]$/, '')
    .replace(/[的得]?(会员|客户|顾客|用户|账户|账本)$/, '')
    .trim();
}

export function cleanMemberQuery(raw) {
  const query = stripMemberQuery(raw);
  const digits = { 零: '0', 〇: '0', 一: '1', 幺: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9' };
  // Only identity sequences are normalized, never money or general utterances.
  if (/^[\d零〇一幺二两三四五六七八九\s]+$/.test(query)) {
    const number = query.replace(/\s/g, '').replace(/[零〇一幺二两三四五六七八九]/g, c => digits[c]);
    if ((number.length >= 3 && number.length <= 8) || number.length === 11) return number;
  }
  return query;
}

export function findMatchingMembers(members, rawQuery) {
  if (!rawQuery) return [];
  const active = members.filter(m => !m.isArchived);
  // Match a complete real name before stripping query prefixes such as 查.
  const literal = active.filter(m => m.name.trim() === String(rawQuery).trim());
  if (literal.length) return literal;
  const query = cleanMemberQuery(rawQuery);
  if (!query) return [];
  // Preserve a real name made of numeral characters before phone normalization.
  const literalQuery = stripMemberQuery(rawQuery);
  if (literalQuery !== query) {
    const named = active.filter(m => m.name.trim() === literalQuery);
    if (named.length) return named;
  }
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
  const identity = phoneFromUtterance(utterance);
  return identity ? findMatchingMembers(active, identity) : [];
}

function phoneFromUtterance(utterance) {
  const identity = utterance.match(/(?:尾号\s*([\d零〇一幺二两三四五六七八九]{3,8})(?![\d零〇一幺二两三四五六七八九])|(?:手机|手机号|电话)\s*([\d零〇一幺二两三四五六七八九]{11})(?![\d零〇一幺二两三四五六七八九])|(?<![\d.])(1[3-9]\d{9})(?![\d.]|\s*(?:元|块)))/);
  return identity ? identity[1] || identity[2] || identity[3] : '';
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
  askedInfos = null,
  executeCode = 'SUCCESS',
  msgInfo = ''
}) {
  const cleanText = normalizeVoiceText(String(text || '').trim());
  const resultType = directive?.type === 'Dialog.Confirm' ? 'CONFIRM' : shouldEndSession ? 'RESULT' : 'ASK_INF';

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
  if (askedInfos?.length) {
    res.returnValue.askedInfos = askedInfos;
    res.returnResult.askedInfos = askedInfos;
  }
  return res;
}

function askAliGenieParameter(req, parameterName, text) {
  const intentId = Number(req.intentId);
  return formatAliGenieResponse({ text, shouldEndSession: false, expectSpeech: true,
    askedInfos: req.version === '1.0' && Number.isSafeInteger(intentId) && intentId > 0
      ? [{ parameterName, intentId }] : null });
}

const PLATFORM_BUSINESS_REPLIES = new Map([
  ['VOICE_ACTOR_UNAVAILABLE', '当前语音记账账号已停用或无权限，请店主在语音设置中选择可用的记账账号。'],
  ['VOICE_ACTOR_CHANGED', '语音记账账号已变化，请重新说完整的消费、充值或查询指令。'],
  ['VOICE_CONTEXT_CHANGED', '原请求的账本或授权已变化，请重新说完整的指令并确认。'],
  ['VOICE_PREVIEW_STALE', '语音预览已过期，请重新发起操作并确认。'],
  ['VOICE_LEDGER_INVALID', '门店账本校验失败，暂时无法查询或记账，请店主检查云端账本。'],
  ['VOICE_REQUEST_CONFLICT', '本次语音请求编号与之前的内容冲突，请重新唤起技能后再试。']
]);

// Only the authenticated platform Header adapter should convert these rejections
// to spoken skill replies. Internal signed API calls retain their HTTP errors.
export function formatAliGeniePlatformError(error, body) {
  const businessReply = PLATFORM_BUSINESS_REPLIES.get(error.code);
  if (!businessReply && !['VOICE_IDENTIFIERS_REQUIRED', 'VOICE_DEVICE_UNBOUND'].includes(error.code)) return null;
  const req = parseAliGenieRequest(body), detail = { code: error.code };
  let text;
  if (businessReply) {
    text = businessReply;
  } else if (error.code === 'VOICE_DEVICE_UNBOUND') {
    text = '当前天猫精灵设备未绑定此门店，请在后台语音设置中绑定设备后重试。';
    detail.deviceOpenId = req.deviceOpenId;
  } else {
    detail.missingFields = error.missingFields || [];
    if (detail.missingFields.length === 2 && detail.missingFields.includes('userOpenId') && detail.missingFields.includes('deviceOpenId')) {
      const recognized = [req.slots.member && `会员${req.slots.member.slice(0, 80)}`,
        req.slots.service && `服务${req.slots.service.slice(0, 80)}`,
        req.slots.amount && `金额${req.slots.amount.slice(0, 40)}`].filter(Boolean).join('、');
      text = `平台在线测试${recognized ? `已识别${recognized}。` : '已收到您的指令。'}网页在线测试不提供用户和设备标识，不能执行真实记账。请使用已绑定门店的天猫精灵音箱进行真机测试。`;
    } else {
      text = '本次请求缺少或包含无效的记账标识，请检查后端接入配置后重试。';
    }
  }
  // AliGenie replaces error executeCodes with its generic service-error reply.
  // Deliver this explanation as a normal dialog response; accounting stays rejected.
  return formatAliGenieResponse({ text, msgInfo: JSON.stringify(detail) });
}

export function makeConfirmDirective() {
  return {
    // Use the built-in yes/no model; no nonexistent custom intent parameters.
    type: 'Dialog.Confirm'
  };
}

export function signAliGenieRequest(secret, timestamp, storeId, body) {
  return createHmac('sha256', secret).update(String(timestamp) + '\n' + storeId + '\n' + canonicalJSON(body)).digest('hex');
}

export function aliGenieDeviceScope(config) {
  return digest(canonicalJSON([config?.authVersion, config?.token]));
}

async function rememberAliGenieDevice(pool, storeId, req, config) {
  const scope = aliGenieDeviceScope(config);
  await transaction(pool, async client => {
    // Serialize candidate retention and configuration changes for this store.
    await client.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE', [storeId]);
    const { rows: [settings] } = await client.query('SELECT voice_config FROM store_settings WHERE store_id=$1', [storeId]);
    const current = settings?.voice_config?.aligenie;
    if (!current?.enabled || current.authVersion !== 2 || aliGenieDeviceScope(current) !== scope ||
        current.allowedDevices?.includes(req.deviceOpenId)) return;
    await client.query("DELETE FROM voice_device_candidates WHERE store_id=$1 AND (credential_scope<>$2 OR last_seen_at<now()-interval '1 day')", [storeId, scope]);
    await client.query(`INSERT INTO voice_device_candidates(store_id,device_open_id,credential_scope,request_id,intent_name)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(store_id,device_open_id) DO UPDATE
      SET request_id=$4,intent_name=$5,last_seen_at=now()`,
      [storeId, req.deviceOpenId, scope, req.requestId, req.intentName.slice(0, 128)]);
    await client.query(`DELETE FROM voice_device_candidates WHERE store_id=$1 AND device_open_id IN
      (SELECT device_open_id FROM voice_device_candidates WHERE store_id=$1 ORDER BY last_seen_at DESC,device_open_id OFFSET 20)`, [storeId]);
  });
}

export async function handleAliGenieWebhook({ pool, body, headers = {}, platformTokenAuthenticated = false, trace = null, executeRelationalVoice }) {
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
    trace?.parsed(req, body);
    if (!hasAccountingIdentity || !Array.isArray(configured.allowedDevices) || !configured.allowedDevices.includes(req.deviceOpenId)) {
      trace?.state('welcome_without_bound_identity');
      if (hasAccountingIdentity) await rememberAliGenieDevice(pool, storeId, req, configured);
      return welcomeResponse(await readStoreProfile(pool, storeId));
    }
  }
  if (!hasAccountingIdentity) {
    const error = new ApiError(400, '语音请求须提供稳定请求、会话、用户及设备标识', 'VOICE_IDENTIFIERS_REQUIRED');
    error.missingFields = missingFields;
    throw error;
  }
  authenticate(configured, false);
  trace?.parsed(req, body);
  if (!Array.isArray(configured.allowedDevices) || !configured.allowedDevices.includes(req.deviceOpenId)) {
    await rememberAliGenieDevice(pool, storeId, req, configured);
    throw new ApiError(401, '当前天猫精灵设备未绑定此门店', 'VOICE_DEVICE_UNBOUND');
  }
  const response = await transaction(pool, async client => {
    const entitlement = await storeEntitlement(client, storeId, { feature: 'voice' });
    requireFeature(entitlement, 'members'); requireFeature(entitlement, 'cashier');
    const { rows: [book] } = await client.query('SELECT ledger_epoch,version FROM stores WHERE id=$1', [storeId]);
    const { rows: [actor] } = await client.query(
      "SELECT u.id,u.active,u.platform_disabled,u.historical_only,u.version,EXISTS (SELECT 1 FROM merchant_role_permissions p WHERE p.role_id=u.role AND p.permission_id='account.write') AS can_write FROM users u WHERE u.store_id=$1 AND u.id=$2 FOR SHARE OF u",
      [storeId, configured.actorId || null]);
    if (!actor?.active || actor.platform_disabled || actor.historical_only || !actor.can_write) throw new ApiError(403, '语音记账账号已停用或无权限', 'VOICE_ACTOR_UNAVAILABLE');
    const { rows: [settings] } = await client.query('SELECT voice_config,voice_config_version FROM store_settings WHERE store_id=$1 FOR SHARE', [storeId]);
    authenticate(settings?.voice_config?.aligenie);
    if (settings.voice_config.aligenie.actorId !== actor.id) throw new ApiError(409, '语音记账账号已变化，请重试', 'VOICE_ACTOR_CHANGED');
    trace?.state('account_authorized', { storeRef: digest(storeId).slice(0, 16), actorRef: digest(actor.id).slice(0, 16) });
    const configHash = integrity(settings.voice_config.aligenie);
    const scope = digest(canonicalJSON(['relational-v2', storeId, req.deviceOpenId, req.userOpenId, req.sessionId]));
    const binding = digest(canonicalJSON([book.ledger_epoch, book.version, actor.id, actor.version,
      entitlement.licenseId, entitlement.version, settings.voice_config_version, configHash]));
    const deviceId = 'voice-' + digest(req.deviceOpenId);
    if (typeof executeRelationalVoice !== 'function') throw new ApiError(503, '语音账本服务未配置');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['voice-dialog:' + scope]);
    const checkLicenseDeadline = () => {
      if (entitlement.expiresAt && Date.parse(entitlement.expiresAt) <= Date.now()) throw new ApiError(403, '门店授权已到期', 'LICENSE_EXPIRED');
    };
    checkLicenseDeadline();
    const receiptId = digest(scope + ':' + req.requestId), hash = integrity(body);
    const { rows: [receipt] } = await client.query('SELECT * FROM voice_requests WHERE store_id=$1 AND id=$2', [storeId, receiptId]);
    if (receipt) {
      if (receipt.request_hash !== hash) throw new ApiError(409, '语音请求单号与原内容不一致', 'VOICE_REQUEST_CONFLICT');
      if (receipt.response.binding !== binding) throw new ApiError(409, '原请求属于其他账本或授权版本，请重新发起指令', 'VOICE_CONTEXT_CHANGED');
      trace?.state('receipt_replayed');
      return receipt.response.result;
    }
    const { rows: [dialog] } = await client.query('SELECT pending FROM voice_dialogs WHERE store_id=$1 AND scope=$2 AND expires_at>clock_timestamp()', [storeId, scope]);
    let nextPending = req.isNew ? null : dialog?.pending || null, marker = null, completedDeadline = null;
    const sessionStore = {
      get: () => nextPending,
      delete: () => { nextPending = null; },
      complete: expiresAt => { completedDeadline = expiresAt; nextPending = null; },
      set: async (_key, value) => {
        const platformConfirmation = platformTokenAuthenticated && req.version === '1.0' ? req.platformConfirmation : null;
        if (platformTokenAuthenticated && req.version === '1.0') {
          if (!platformConfirmation) {
            nextPending = null;
            return false;
          }
          // Remember each platform preview turn after cancellation/completion.
          // Reusing the same slot timestamps AND lifetimes must not create a
          // second operation that a delayed confirmation could authorize.
          const markerId = digest(scope + ':platform-preview:' + canonicalJSON(platformConfirmation));
          const { rows: [seen] } = await client.query("SELECT id FROM voice_requests WHERE store_id=$1 AND id=$2 AND received_at>=clock_timestamp()-interval '1 day'", [storeId, markerId]);
          if (seen) { nextPending = null; return false; }
          marker = [storeId, markerId, integrity(platformConfirmation), { previewRequestId: req.requestId }];
        }
        nextPending = { ...value, platformConfirmation, previewRequestId: req.requestId, binding };
        return true;
      }
    };
    trace?.state('pending_loaded', { hasPending: Boolean(nextPending), pendingAction: nextPending?.action || null,
      previewRef: nextPending ? digest(nextPending.previewRequestId).slice(0, 16) : null });
    const params = { req, client, targetStoreId: storeId, sessionStore, platformTokenAuthenticated };
    const response = await dispatchRelationalVoiceDialog({ ...params, binding,
      voice: createRelationalVoice({ client, user: { ...actor, store_id: storeId, ledger_epoch: book.ledger_epoch, device_id: deviceId, entitlements: entitlement },
        req, receiptId, executeCommand: executeRelationalVoice,
        language: { cleanMemberQuery, stripMemberQuery, phoneFromUtterance, membersFromUtterance, parseVoiceCents, spokenAmountCandidate } }) });
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['voice-quota:' + storeId]);
    await client.query('DELETE FROM voice_dialogs WHERE store_id=$1 AND expires_at<=clock_timestamp()', [storeId]);
    await client.query("DELETE FROM voice_requests WHERE store_id=$1 AND received_at<clock_timestamp()-interval '1 day'", [storeId]);
    const { rows: [counts] } = await client.query('SELECT (SELECT count(*) FROM voice_dialogs WHERE store_id=$1 AND scope<>$2) AS dialogs,(SELECT count(*) FROM voice_requests WHERE store_id=$1) AS requests', [storeId, scope]);
    if (Number(counts.requests) + (marker ? 2 : 1) > 10000) throw new ApiError(429, '语音请求过多，请稍后重试');
    if (nextPending && Number(counts.dialogs) >= 256) throw new ApiError(429, '语音待确认操作过多，请稍后重试');
    if (marker) await client.query('INSERT INTO voice_requests(store_id,id,request_hash,response) VALUES($1,$2,$3,$4)', marker);
    if (nextPending?.previewRequestId === req.requestId) response.confirmationRequestId = req.requestId;
    if (nextPending) await client.query('INSERT INTO voice_dialogs(store_id,scope,pending,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(store_id,scope) DO UPDATE SET pending=$3,expires_at=$4', [storeId, scope, nextPending, new Date(nextPending.expiresAt)]);
    else await client.query('DELETE FROM voice_dialogs WHERE store_id=$1 AND scope=$2', [storeId, scope]);
    await client.query('INSERT INTO voice_requests(store_id,id,request_hash,response) VALUES($1,$2,$3,$4)',
      [storeId, receiptId, hash, { binding, result: response }]);
    if (completedDeadline !== null && completedDeadline <= Date.now()) throw new ApiError(409, '语音预览已过期，请重新确认', 'VOICE_PREVIEW_STALE');
    checkLicenseDeadline();
    return response;
  });
  trace?.state('transaction_committed');
  return response;
}

async function dispatchRelationalVoiceDialog({ req, voice, binding, client, targetStoreId, sessionStore, platformTokenAuthenticated }) {
  const pending = sessionStore.get(req.sessionId), dialogReply = getDialogReply(req.utterance);
  const confirm = req.confirmationStatus === 'CONFIRMED' || dialogReply === 'confirm' || req.intentName === 'ConfirmIntent';
  const deny = req.confirmationStatus === 'DENIED' || dialogReply === 'deny';
  if (!pending && (confirm || deny)) return formatAliGenieResponse({ text: '当前没有待确认的操作，请重新说完整的消费或充值指令。' });
  if (pending && deny) {
    sessionStore.delete(req.sessionId);
    return formatAliGenieResponse({ text: '已为您取消本次操作。' });
  }
  if (pending && confirm) {
    const explicitMatch = req.confirmationRequestId === pending.previewRequestId;
    const platformMatch = !req.confirmationRequestId && platformTokenAuthenticated && req.version === '1.0' &&
      req.confirmationStatus === 'CONFIRMED' && matchesPlatformConfirmation(pending.platformConfirmation, req.platformConfirmation);
    if (!explicitMatch && !platformMatch) return formatAliGenieResponse({ text: '确认请求与本次预览不匹配，请重新说完整的消费或充值指令。' });
    if (pending.binding !== binding || pending.expiresAt <= Date.now()) {
      sessionStore.delete(req.sessionId);
      return formatAliGenieResponse({ text: '原预览的账本或授权已变化，或已过期，请重新发起操作并确认。' });
    }
    const settled = await voice.execute(pending);
    if (settled.stale) {
      sessionStore.delete(req.sessionId);
      return formatAliGenieResponse({ text: settled.stale + '。' });
    }
    sessionStore.complete(pending.expiresAt);
    const { result } = settled, balance = BigInt(result.balanceAfterCents);
    if (pending.action === 'recharge') return formatAliGenieResponse({ text: '充值成功！会员' + pending.memberName + '已到账 ' +
      voiceYuan(result.deltaCents) + ' 元，卡内当前余额 ' + voiceYuan(balance) + ' 元。' });
    const balanceText = balance < 0n ? '当前已欠款 ' + voiceYuan(-balance) : '卡内当前剩余 ' + voiceYuan(balance);
    return formatAliGenieResponse({ text: '扣款成功！已为会员' + pending.memberName + '扣除 ' + voiceYuan(-BigInt(result.deltaCents)) +
      ' 元，' + balanceText + ' 元。' });
  }
  if (isWelcomeRequest(req)) return welcomeResponse(await readStoreProfile(client, targetStoreId));

  const { matches, names, tooMany } = await voice.findMembers();
  const action = resolveBusinessIntent(req, names);
  if (!action) return formatAliGenieResponse({ text: '抱歉，暂未理解该指令。您可以说：张三消费38元、李四充值200元、或查询尾号1234余额。' });
  if (tooMany || matches.length > 1) {
    const examples = matches.slice(0, 3).map(member => member.name + (member.phone ? '（手机尾号' + member.phone.replace(/\D/g, '').slice(-4) + '）' : '')).join('、');
    return askAliGenieParameter(req, 'memberQuery', (examples ? '找到多位会员：' + examples + '。' : '找到多位会员。') + '请报完整姓名或手机尾号。');
  }
  if (!matches.length) {
    if (!req.slots.member && !req.utterance) return askAliGenieParameter(req, 'memberQuery', '请说会员姓名或手机尾号。');
    return formatAliGenieResponse({ text: '未在会员库中找到“' + cleanMemberQuery(req.slots.member || req.utterance) + '”，请核对姓名或报手机尾号重试。' });
  }
  const member = matches[0];
  if (action === 'query') {
    const summary = await voice.accountSummary(member.id);
    if (!summary) return formatAliGenieResponse({ text: '会员资料已变化，请重新查询。' });
    const balance = BigInt(summary.balance_cents);
    let reply = '会员' + summary.name + (balance < 0n ? '当前卡内欠款 ' + voiceYuan(-balance) + ' 元。' :
      '当前卡内余额 ' + voiceYuan(balance) + ' 元，切换以来累计充值到账 ' + voiceYuan(summary.recharge_cents) + ' 元。');
    if (summary.last_visit) reply += ' 上次到店是 ' + formatDate(summary.last_visit) + '。';
    if (summary.notes.trim()) reply += ' 偏好备注：' + summary.notes.trim() + '。';
    return formatAliGenieResponse({ text: reply });
  }

  const preview = await voice.prepare(action, member);
  if (preview.askAmount || preview.askService) return askAliGenieParameter(req, 'amount', preview.askService ?
    '匹配到多个服务项目，请报本次扣款金额。' : '已找到会员' + member.name + '，请报本次' + (action === 'consume' ? '消费' : '充值') + '金额，例如一百元。');
  if (preview.businessError) return formatAliGenieResponse({ text: preview.businessError + '。', shouldEndSession: false, expectSpeech: true });
  const { command, expectedProfileVersion, before, after, label } = preview;
  let prompt;
  if (action === 'consume') {
    const amount = voiceYuan(command.amountCents);
    prompt = command.allowDebt ? '会员' + member.name + '当前卡内余额 ' + voiceYuan(before) + ' 元，本次扣款 ' + amount +
      ' 元后将欠款 ' + voiceYuan(-BigInt(after)) + ' 元，请问确认扣款并记入欠款吗？' :
      '会员' + member.name + '本次' + (label === '消费' ? '' : label) + '消费 ' + amount + ' 元，扣款后卡内剩余 ' + voiceYuan(after) + ' 元，请问确认扣款吗？';
  } else {
    const actual = voiceYuan(command.actualPayCents), gift = voiceYuan(command.giftCents);
    prompt = '即将为会员' + member.name + '实充 ' + actual + ' 元' + (command.giftCents === '0' ? '' : '，赠送 ' + gift + ' 元，合计到账 ' +
      voiceYuan(BigInt(command.actualPayCents) + BigInt(command.giftCents)) + ' 元') + '，到账后卡内余额为 ' + voiceYuan(after) + ' 元，请问确认充值吗？';
  }
  const saved = await sessionStore.set(req.sessionId, { action, command, expectedProfileVersion, memberName: member.name, expiresAt: Date.now() + SESSION_TTL_MS });
  if (!saved) return formatAliGenieResponse({ text: '本次指令缺少新的可核验确认信息，请重新打开语音技能并说完整的指令。' });
  return formatAliGenieResponse({ text: prompt, shouldEndSession: false, expectSpeech: true, directive: makeConfirmDirective() });
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
