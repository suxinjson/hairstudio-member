import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { transaction } from './database.js';
import { integrity, digest, ApiError } from './security.js';
import { replayOperation } from '../src/cloud-storage.js';
import { mutationPrecondition } from '../src/sync-protocol.js';
import { validateSnapshot } from './service.js';
import { moneyToCent } from '../src/money.js';
import { rechargeGiftCent, normalizeRechargeSettings } from '../src/recharge-settings.js';

// In-memory multi-turn session cache with 5 minutes TTL
const sessionStore = new Map();
const SESSION_TTL_MS = 5 * 60 * 1000;

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [key, session] of sessionStore.entries()) {
    if (session.expiresAt <= now) {
      sessionStore.delete(key);
    }
  }
}
setInterval(cleanExpiredSessions, 60 * 1000).unref();

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
    deviceOpenId,
    userOpenId
  };
}

export function parseAmount(raw) {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  if (!str) return null;

  // 1. Direct Arabic digits match (e.g. "38", "38.5", "100元")
  const digitMatch = str.match(/(\d+(?:\.\d{1,2})?)/);
  if (digitMatch) {
    const num = parseFloat(digitMatch[1]);
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  // 2. Chinese numerals match (e.g. "一百", "三十八", "两百", "一百五")
  const map = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  const units = { '十': 10, '百': 100, '千': 1000, '万': 10000 };

  const match = str.match(/[零一二两三四五六七八九十百千万]+/);
  if (!match) return null;
  const cn = match[0];

  let result = 0;
  let temp = 0;
  let hasUnit = false;

  for (let i = 0; i < cn.length; i++) {
    const char = cn[i];
    if (map[char] !== undefined) {
      temp = map[char];
      if (i === cn.length - 1 && hasUnit && temp > 0) {
        const prevUnit = units[cn[i - 1]];
        if (prevUnit && prevUnit > 10) {
          result += temp * (prevUnit / 10);
          temp = 0;
        }
      }
    } else if (units[char] !== undefined) {
      hasUnit = true;
      const unit = units[char];
      if (char === '十' && temp === 0 && (i === 0 || cn[i - 1] === '零')) {
        temp = 1;
      }
      result += temp * unit;
      temp = 0;
    }
  }
  result += temp;
  return Number.isFinite(result) && result > 0 ? result : null;
}

export function extractAmountFromUtterance(utterance, memberName = '') {
  if (!utterance) return null;
  let text = String(utterance);
  if (memberName) {
    text = text.replaceAll(memberName, '');
  }
  // 1. If there's an action keyword, look for amount immediately after or nearby
  const actionMatch = text.match(/(?:消费|扣款|扣除|结账|买单|充值|充|存|金额|扣|实充|支付|付)\s*([^\s,，。]+)/);
  if (actionMatch) {
    const parsed = parseAmount(actionMatch[1]);
    if (parsed) return parsed;
  }
  // 2. Look for amount with unit (e.g. 100元, 38块, 一百块)
  const unitMatch = text.match(/([零一二两三四五六七八九十百千万\d]+(?:\.\d+)?)\s*(?:元|块|块钱)/);
  if (unitMatch) {
    const parsed = parseAmount(unitMatch[1]);
    if (parsed) return parsed;
  }
  // 3. Fallback to parseAmount on the text without member name
  return parseAmount(text);
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

export function findMemberFromUtterance(members, utterance) {
  if (!members || !Array.isArray(members) || !utterance) return null;
  const active = members.filter(m => !m.isArchived);
  // 1. Check exact member names (longest names first to avoid prefix confusion)
  const sorted = [...active].sort((a, b) => b.name.length - a.name.length);
  for (const m of sorted) {
    if (m.name && utterance.includes(m.name)) {
      return m;
    }
  }
  // 2. Check 4-digit phone suffix
  for (const m of active) {
    const tail4 = (m.phone || '').replace(/\D/g, '').slice(-4);
    if (tail4 && tail4.length === 4 && utterance.includes(tail4)) {
      return m;
    }
  }
  return null;
}

export function formatAliGenieResponse({
  text,
  shouldEndSession = true,
  expectSpeech = false,
  directive = null
}) {
  const cleanText = String(text || '').trim();
  const resultType = shouldEndSession ? 'RESULT' : 'ASK_INF';

  const res = {
    // Protocol 1.0 & AliGenie Standard Custom Skill Response
    returnCode: '0',
    returnErrorSolution: '',
    returnMessage: '',
    returnValue: {
      reply: cleanText,
      resultType,
      executeCode: 'SUCCESS',
      msgInfo: ''
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

export function makeConfirmDirective() {
  return {
    type: 'Dialog.Confirm',
    confirmParaInfo: {
      confirmParameterName: 'confirm',
      denyParameterName: 'deny'
    }
  };
}

export async function executeVoiceOperation({ pool, storeId, method, args, requestId }) {
  return transaction(pool, async client => {
    const { rows: [account] } = await client.query('SELECT * FROM accounts WHERE store_id=$1 FOR UPDATE', [storeId]);
    if (!account) throw new ApiError(404, '门店账本不存在');
    if (integrity(account.data) !== account.integrity) throw new ApiError(503, '账本完整性检查失败');

    // Idempotency check with operations table
    const opHash = digest(requestId || randomUUID());
    const opId = ('voice-' + opHash).slice(0, 40);
    const voiceDeviceId = 'aligenie-voice-terminal';
    const { rows: [existing] } = await client.query('SELECT * FROM operations WHERE store_id=$1 AND id=$2', [storeId, opId]);
    if (existing) {
      return { duplicate: true, result: existing.result, account: account.data };
    }

    // Lookup owner for actor
    const { rows: [owner] } = await client.query('SELECT id FROM users WHERE store_id=$1 AND role=\'owner\' LIMIT 1', [storeId]);
    const actorId = owner ? owner.id : storeId;

    const ledgerId = 'TX' + randomUUID();
    const now = new Date().toISOString();
    const operation = {
      id: opId,
      actorId,
      deviceId: voiceDeviceId,
      method,
      args,
      precondition: mutationPrecondition(account.data, method, args),
      generated: {
        ids: [ledgerId],
        times: [now]
      }
    };

    let data = account.data;
    let revision = account.revision;
    const applied = replayOperation(data, operation);
    data = validateSnapshot(applied.data);
    revision++;

    const hash = integrity(operation);
    await client.query(
      'INSERT INTO operations(store_id, id, user_id, device_id, method, request_hash, result, revision) VALUES($1, $2, $3, $4, $5, $6, $7, $8)',
      [storeId, opId, actorId, voiceDeviceId, method, hash, JSON.stringify(applied.result), revision]
    );

    const checksum = integrity(data);
    await client.query('UPDATE accounts SET data=$1, revision=$2, integrity=$3 WHERE store_id=$4', [data, revision, checksum, storeId]);

    await client.query(
      'INSERT INTO audit_events(store_id, user_id, device_id, event, details, occurred_at) VALUES($1, $2, $3, $4, $5, $6)',
      [storeId, actorId, voiceDeviceId, 'voice_' + method, JSON.stringify({ operationId: opId, result: applied.result }), now]
    );

    return { duplicate: false, result: applied.result, account: data };
  });
}

export async function handleAliGenieWebhook({ pool, body, query = {}, headers = {}, aligenieDir = './aligenie' }) {
  try {
    const req = parseAliGenieRequest(body);
    const now = Date.now();

    // 1. Identify Store
    let targetStoreId = query.storeId || headers['x-store-id'];
    const token = query.token || headers['x-aligenie-token'];

    if (!targetStoreId && token) {
      const { rows } = await pool.query(
        "SELECT store_id FROM store_settings WHERE voice_config->'aligenie'->>'token' = $1 LIMIT 1",
        [token]
      );
      if (rows[0]) targetStoreId = rows[0].store_id;
    }

    if (!targetStoreId) {
      const { rows } = await pool.query('SELECT id FROM stores ORDER BY created_at ASC LIMIT 10');
      if (rows.length > 0) {
        const { rows: enabledRows } = await pool.query(
          "SELECT store_id FROM store_settings WHERE (voice_config->'aligenie'->>'enabled')::boolean = true LIMIT 1"
        );
        targetStoreId = enabledRows[0]?.store_id || rows[0].id;
      }
    }

    if (!targetStoreId) {
      return formatAliGenieResponse({
        text: '未找到绑定的门店账本，请在后台配置天猫精灵对接。',
        shouldEndSession: true
      });
    }

    // 2. Fetch Store Settings & Account data
    const { rows: [settingsRow] } = await pool.query('SELECT voice_config FROM store_settings WHERE store_id=$1', [targetStoreId]);
    const aligenieConfig = settingsRow?.voice_config?.aligenie || {};

    if (aligenieConfig.enabled === false) {
      return formatAliGenieResponse({
        text: '天猫精灵语音记账功能已暂停，请在管理后台开启。',
        shouldEndSession: true
      });
    }

    // Check token if configured
    if (aligenieConfig.token && token && aligenieConfig.token !== token) {
      return formatAliGenieResponse({
        text: '语音认证口令错误，拒绝操作。',
        shouldEndSession: true
      });
    }

    // Check device whitelist if configured
    if (Array.isArray(aligenieConfig.allowedDevices) && aligenieConfig.allowedDevices.length > 0) {
      if (!req.deviceOpenId || !aligenieConfig.allowedDevices.includes(req.deviceOpenId)) {
        return formatAliGenieResponse({
          text: '当前天猫精灵设备尚未绑定本店，请在管理后台绑定此设备后使用。',
          shouldEndSession: true
        });
      }
    }

    const { rows: [accountRow] } = await pool.query('SELECT data FROM accounts WHERE store_id=$1', [targetStoreId]);
    if (!accountRow || !accountRow.data) {
      return formatAliGenieResponse({
        text: '门店账本尚未初始化，请先在手机或电脑端建立账本。',
        shouldEndSession: true
      });
    }
    const accountData = accountRow.data;
    const members = accountData.members || [];
    const services = accountData.services || [];
    const rechargeSettings = accountData.rechargeSettings;

    // 3. Multi-turn Session Check (Pending Confirmation)
    const pending = sessionStore.get(req.sessionId);
    const isDenyUtterance = /^(取消|不要|算了|不对|别记|别扣|不充|否认|不用|不用了|不要了|按错了)$/.test(req.utterance);
    const isConfirmUtterance = /^(确认|确定|是的|好的|对的|没错|没问题|要的|同意|成|确认扣款|确认充值|可以|行)$/.test(req.utterance);

    if (pending && (req.confirmationStatus === 'DENIED' || isDenyUtterance)) {
      sessionStore.delete(req.sessionId);
      return formatAliGenieResponse({
        text: '已为您取消本次操作。',
        shouldEndSession: true
      });
    }

    if (pending && (req.confirmationStatus === 'CONFIRMED' || isConfirmUtterance || req.intentName === 'ConfirmIntent')) {
      sessionStore.delete(req.sessionId);
      if (pending.action === 'consume') {
        try {
          const { result } = await executeVoiceOperation({
            pool,
            storeId: targetStoreId,
            method: 'consume',
            args: [{
              memberId: pending.memberId,
              amount: (pending.amountCent / 100).toFixed(2),
              itemsSummary: pending.itemsSummary || '洗剪吹理发',
              remark: pending.remark || '天猫精灵语音扣款',
              allowDebt: pending.allowDebt || false
            }],
            requestId: req.requestId
          });
          const balanceYuan = (result.balanceAfter / 100).toFixed(2);
          const debtText = result.balanceAfter < 0
            ? `当前已欠款 ${Math.abs(result.balanceAfter / 100).toFixed(2)} 元。`
            : `卡内当前剩余 ${balanceYuan} 元。`;
          return formatAliGenieResponse({
            text: `扣款成功！已为会员${pending.memberName}扣除 ${(pending.amountCent / 100).toFixed(2)} 元，${debtText}`,
            shouldEndSession: true
          });
        } catch (err) {
          return formatAliGenieResponse({
            text: `扣款失败：${err.message}`,
            shouldEndSession: true
          });
        }
      } else if (pending.action === 'recharge') {
        try {
          const { result } = await executeVoiceOperation({
            pool,
            storeId: targetStoreId,
            method: 'recharge',
            args: [{
              memberId: pending.memberId,
              actualPay: (pending.actualCent / 100).toFixed(2),
              giftAmount: (pending.giftCent / 100).toFixed(2),
              payMethod: '语音充值',
              remark: '天猫精灵语音充值'
            }],
            requestId: req.requestId
          });
          const balanceYuan = (result.balanceAfter / 100).toFixed(2);
          return formatAliGenieResponse({
            text: `充值成功！会员${pending.memberName}已到账 ${(result.totalCredit / 100).toFixed(2)} 元，卡内当前余额 ${balanceYuan} 元。`,
            shouldEndSession: true
          });
        } catch (err) {
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
    const hasAction = /(消费|扣款|扣除|结账|买单|充值|充|存|查一下|查询|查|看看|看|余额)/.test(utterance);

    // A. Welcome / Default Intent (Only if no specific action was requested)
    if (!hasAction && (!req.intentName || normalizedIntent.includes('welcome') || normalizedIntent.includes('default') || utterance === '梦飞管家' || utterance === '打开梦飞管家')) {
      return formatAliGenieResponse({
        text: '梦飞管家为您服务，您可以对我说：张三洗剪吹扣款38元、李四充值200元、或查询尾号1234余额。',
        shouldEndSession: false,
        expectSpeech: true
      });
    }

    // B. Query Member / Balance Intent
    if (normalizedIntent.includes('query') || normalizedIntent.includes('balance') || /(查一下|查询|查|看看|看|余额|流水)/.test(utterance)) {
      let memberQuery = req.slots.member;
      if (!memberQuery) {
        const fromUtterance = findMemberFromUtterance(members, utterance);
        memberQuery = fromUtterance ? fromUtterance.name : utterance;
      }
      if (!memberQuery || memberQuery.length < 1) {
        return formatAliGenieResponse({
          text: '请问您想查询哪位会员，或者报手机尾号？',
          shouldEndSession: false,
          expectSpeech: true
        });
      }
      const matched = findMatchingMembers(members, memberQuery);
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
      let memberQuery = req.slots.member;
      if (!memberQuery) {
        const fromUtterance = findMemberFromUtterance(members, utterance);
        memberQuery = fromUtterance ? fromUtterance.name : utterance;
      }
      if (!memberQuery) {
        return formatAliGenieResponse({
          text: '请问是哪位会员需要扣款？',
          shouldEndSession: false,
          expectSpeech: true
        });
      }

      const matched = findMatchingMembers(members, memberQuery);
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
      let amount = parseAmount(req.slots.amount) || extractAmountFromUtterance(utterance, m.name);
      let itemsSummary = req.slots.service || '洗剪吹理发';

      // If amount is not explicitly provided, try to look up service price
      if (!amount) {
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
      let memberQuery = req.slots.member;
      if (!memberQuery) {
        const fromUtterance = findMemberFromUtterance(members, utterance);
        memberQuery = fromUtterance ? fromUtterance.name : utterance;
      }
      if (!memberQuery) {
        return formatAliGenieResponse({
          text: '请问要为哪位会员充值？',
          shouldEndSession: false,
          expectSpeech: true
        });
      }

      const matched = findMatchingMembers(members, memberQuery);
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
      const amount = parseAmount(req.slots.amount) || extractAmountFromUtterance(utterance, m.name);
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
  } catch (err) {
    console.error('[AliGenie Webhook Error]:', err);
    return formatAliGenieResponse({
      text: '抱歉，服务处理遇到异常，请稍后重试。',
      shouldEndSession: true
    });
  }
}

export async function getAliGenieVerificationContent(fileName, pool, baseDir = './server/aligenie') {
  if (!/^[a-zA-Z0-9_-]+\.txt$/.test(fileName)) return null;

  // 1. Try reading from disk: aligenie/
  const candidates = [
    resolve(baseDir, fileName),
    resolve('./aligenie', fileName),
    resolve('./server/aligenie', fileName)
  ];
  for (const p of candidates) {
    try {
      const s = await stat(p);
      if (s.isFile()) {
        const text = await readFile(p, 'utf8');
        return text.trim();
      }
    } catch {}
  }

  // 2. Try looking up in database store_settings
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

  return null;
}
