import { createHash, randomUUID } from 'node:crypto';

const KNOWN_SLOTS = /^(member|memberquery|member_entity|customer|name|phone|member_name|amount|actualamount|price|sys\.price|money|giftamount|gift|service|serviceitem|service_item|item)$/i;
const SECRET_FIELD = /token|secret|password|api.?key|signature|authorization|cookie|credential|openid|deviceid|sessionattrs/i;

export function redactAliGenieText(value, limit = 240) {
  const spokenDigits = { 零: '0', 〇: '0', 一: '1', 幺: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9' };
  const maskPhone = digits => digits.slice(0, 3) + '****' + digits.slice(-4);
  const text = String(value ?? '')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, maskPhone)
    .replace(/(?<![\d零〇一幺二两三四五六七八九])[\d零〇一幺二两三四五六七八九](?:[\s-]*[\d零〇一幺二两三四五六七八九]){10}(?![\d零〇一幺二两三四五六七八九])/g,
      value => maskPhone(value.replace(/[\s-]/g, '').replace(/[零〇一幺二两三四五六七八九]/g, c => spokenDigits[c])))
    .replace(/Bearer\s+\S+|[A-Za-z0-9_+/=-]{32,}/gi, '[redacted]');
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

function reference(value) {
  return value ? createHash('sha256').update(String(value)).digest('hex').slice(0, 16) : null;
}

function safeValue(value) {
  function clean(value, depth = 0) {
    if (depth > 2) return '[nested]';
    if (Array.isArray(value)) return value.slice(0, 8).map(item => clean(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 12)
      .map(([key, item]) => [redactAliGenieText(key, 60), SECRET_FIELD.test(key) ? '[redacted]' : clean(item, depth + 1)]));
    return typeof value === 'string' ? redactAliGenieText(value, 120) : value;
  }
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try { value = JSON.parse(value); } catch { return '[invalid JSON]'; }
  }
  return redactAliGenieText(value && typeof value === 'object' ? JSON.stringify(clean(value)) : value, 400);
}

export const writeAliGenieLog = record => console.info(JSON.stringify(record));

// The logger is owned by the HTTP server, never supplied through a request body.
// Logging failures must not change accounting or prevent a successful response.
export function createAliGenieTrace(write) {
  if (typeof write !== 'function') return null;
  const context = { traceId: randomUUID() }, started = performance.now();
  let parsed = false, rejected = false, responded = false;
  const emit = (event, details = {}) => {
    try { write({ time: new Date().toISOString(), event: 'aligenie.' + event, ...context, ...details }); } catch {}
  };
  emit('http');
  return {
    received(body, source) {
      const slots = Array.isArray(body.slotEntities) ? body.slotEntities : body.payload?.slotEntities;
      context.requestRef = reference(body.request?.requestId || body.requestId || body.header?.messageId || body.payload?.requestId);
      context.systemSessionRef = reference(body.sessionId || body.payload?.sessionId);
      context.skillSessionRef = reference(body.session?.sessionId || body.skillSession?.skillSessionId || body.skillSession?.sessionId);
      emit('request', { source, version: body.version === '2.0' ? '2.0' : '1.0',
        intentName: redactAliGenieText(body.request?.intent?.name || body.intentName || body.payload?.intentName, 80),
        slotCount: Array.isArray(slots) ? slots.length : Object.keys(body.request?.intent?.slots || {}).length,
        slotNames: (Array.isArray(slots) ? slots.map(slot => slot?.intentParameterName || slot?.slotName) : Object.keys(body.request?.intent?.slots || {}))
          .slice(0, 12).map(name => redactAliGenieText(name, 60)) });
    },
    parsed(req, body) {
      if (parsed) return; parsed = true;
      context.deviceRef = reference(req.deviceOpenId); context.userRef = reference(req.userOpenId);
      const slots = Array.isArray(body.slotEntities) ? body.slotEntities : body.payload?.slotEntities;
      emit('parsed', { intentName: redactAliGenieText(req.intentName, 80), intentId: redactAliGenieText(req.intentId, 40),
        newSession: req.isNew, sessionRef: reference(req.sessionId), utterance: redactAliGenieText(req.utterance),
        confirmationStatus: req.confirmationStatus, confirmationRef: reference(req.confirmationRequestId),
        missingIdentity: [...['requestRef', 'deviceRef', 'userRef'].filter(key => !context[key]),
          ...(!context.systemSessionRef && !context.skillSessionRef ? ['sessionRef'] : [])],
        slots: Object.fromEntries(Object.entries(req.slots).slice(0, 12).filter(([name]) => KNOWN_SLOTS.test(name)).map(([name, value]) => [name, safeValue(value)])),
        slotEntities: (Array.isArray(slots) ? slots : []).slice(0, 8).map(slot => {
          const name = slot?.intentParameterName || slot?.slotName;
          const info = { name: redactAliGenieText(name, 60), entity: redactAliGenieText(slot?.slotName, 80),
            liveTime: Number.isSafeInteger(slot?.liveTime) ? slot.liveTime : null,
            createdAt: Number.isSafeInteger(slot?.createTimeStamp) ? slot.createTimeStamp : null };
          return KNOWN_SLOTS.test(name) ? { ...info, original: safeValue(slot.originalValue), standard: safeValue(slot.standardValue) } : info;
        }) });
    },
    state(outcome, details = {}) {
      emit('dialog', { outcome, ...details });
    },
    reject(error, status) {
      if (rejected) return; rejected = true;
      emit('rejected', { status: status || error.status || (error.code === '23505' ? 409 : error instanceof TypeError || error instanceof SyntaxError ? 400 : 500),
        code: /^[A-Z0-9_]{1,60}$/.test(error.code || '') ? error.code : 'REQUEST_FAILED',
        errorType: redactAliGenieText(error.name, 40) });
    },
    response(status, value) {
      if (responded) return; responded = true;
      const result = value.returnValue || value.returnResult || {};
      emit('response', { status, durationMs: Math.round(performance.now() - started),
        resultType: result.resultType || null, executeCode: result.executeCode || null,
        reply: redactAliGenieText(result.reply || value.error),
        askedParameters: (result.askedInfos || []).slice(0, 8).map(info => redactAliGenieText(info.parameterName, 60)),
        previewRef: reference(value.confirmationRequestId) });
    }
  };
}
