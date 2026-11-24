import { parseCents, createConsumption, createRecharge } from './ledger-domain.js';
import { DATA_LIMITS, boundedText } from './data-limits.js';
import { validateSaleFields } from './relational-sales.js';
import { ledgerEpochOf } from './ledger-epoch.js';

export const ENTITY_ID = /^[a-zA-Z0-9_-]{1,128}$/;
export const COMMAND_ID = /^[a-zA-Z0-9-]{16,80}$/;
export const phoneIdentity = phone => phone.replace(/\D/g, '');
export function invalid(message, code = 'INVALID_INPUT') { return Object.assign(new Error(message), { status: 400, code }); }
export function text(value, limit, label, required = false) { boundedText(value, limit, label, required); return value.trim(); }
export function batchNames(names) {
  if (!Array.isArray(names) || names.length > 500) throw invalid('同名预检最多查询 500 个姓名');
  return [...new Set(names.map(name => text(name, 128, '会员姓名', true)))];
}
export function versionOf(value, label = '版本') {
  try { if (parseCents(value, label) < 0n || String(BigInt(value)) !== value) throw new Error(); }
  catch { throw invalid(label + '必须是非负 BIGINT 整数字符串'); }
  return value;
}
export function tagsOf(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw invalid('会员标签格式无效');
  const tags = value.map(tag => text(tag, 128, '会员标签', true));
  if (new Set(tags).size !== tags.length) throw invalid('会员标签不能重复');
  return tags.sort((left, right) => {
    const a = [...left], b = [...right];
    for (let index = 0; index < Math.min(a.length, b.length); index++) { const delta = a[index].codePointAt(0) - b[index].codePointAt(0); if (delta) return delta; }
    return a.length - b.length;
  });
}
function onlyFields(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) throw invalid('请求包含不支持的字段');
}
export function memberInput(input, { update = false } = {}) {
  onlyFields(input, ['name', 'phone', 'notes', 'tags', ...(update ? ['expectedVersion'] : [])]);
  if (update) versionOf(input.expectedVersion, '会员资料版本');
  return { name: text(input.name, DATA_LIMITS.name, '姓名', true), phone: text(input.phone ?? '', DATA_LIMITS.phone, '手机号'),
    notes: text(input.notes ?? '', DATA_LIMITS.notes, '备注'), tags: tagsOf(input.tags) };
}
export function normalizeOpeningInput(input) {
  if (!input || typeof input !== 'object' || typeof input.batchId !== 'string' || !COMMAND_ID.test(input.batchId) || typeof input.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceDigest) ||
      !Number.isInteger(input.expectedCount) || input.expectedCount < 1 || input.expectedCount > DATA_LIMITS.members ||
      !Array.isArray(input.members) || input.members.length !== input.expectedCount) throw invalid('期初导入批次无效，记录数必须与确认数量完全一致');
  const seen = new Set(); let net = 0n, positive = 0n, negative = 0n;
  try {
    const rows = input.members.map((source, index) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw invalid('第 ' + (index + 1) + ' 行会员格式无效');
      const id = text(source.id, DATA_LIMITS.id, '会员单号', true);
      if (!ENTITY_ID.test(id) || seen.has(id)) throw invalid('第 ' + (index + 1) + ' 行会员单号无效或重复');
      seen.add(id);
      const balance = parseCents(source.balanceCents, '第 ' + (index + 1) + ' 行余额');
      net += balance; if (balance > 0n) positive += balance; if (balance < 0n) negative += balance;
      const sourceMemberId = source.sourceMemberId == null ? null : text(source.sourceMemberId, DATA_LIMITS.id, '原会员单号');
      return { id, ...memberInput({ name: source.name, phone: source.phone, notes: source.notes, tags: source.tags }), balanceCents: String(balance), sourceMemberId };
    });
    // Aggregate using unbounded integers first: a valid final total must not
    // depend on the order of positive and negative source rows.
    for (const sum of [net, positive, negative]) parseCents(String(sum), '期初汇总金额');
    return { batchId: input.batchId, sourceDigest: input.sourceDigest, expectedCount: input.expectedCount, rows,
      netBalanceCents: String(net), positiveBalanceCents: String(positive), negativeBalanceCents: String(negative),
      zeroBalanceCount: rows.filter(row => row.balanceCents === '0').length,
      negativeBalanceCount: rows.filter(row => BigInt(row.balanceCents) < 0n).length };
  } catch (error) { if (!error.status) error.status = 400; throw error; }
}
export function validateFinancialCommand(input) {
  ledgerEpochOf(input?.ledgerEpoch);
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.id !== 'string' || !COMMAND_ID.test(input.id) ||
      typeof input.storeId !== 'string' || !ENTITY_ID.test(input.storeId) ||
      !['recharge', 'consume', 'reverse'].includes(input.type) || typeof input.memberId !== 'string' || !ENTITY_ID.test(input.memberId)) throw invalid('资金命令格式无效');
  const specific = input.type === 'recharge' ? ['actualPayCents', 'giftCents', 'payMethod', 'remark', 'payments', 'planId', 'configurationVersion'] :
    input.type === 'consume' ? ['amountCents', 'itemsSummary', 'remark', 'allowDebt', 'items', 'configurationVersion'] : ['originalEntryId', 'reason', 'allowDebt'];
  onlyFields(input, ['id', 'storeId', 'ledgerEpoch', 'actorId', 'deviceId', 'type', 'memberId', 'expectedAccountVersion', 'expectedProfileVersion', ...specific]);
  if (input.actorId !== undefined && (typeof input.actorId !== 'string' || !ENTITY_ID.test(input.actorId)) || input.deviceId !== undefined && (typeof input.deviceId !== 'string' || !COMMAND_ID.test(input.deviceId))) throw invalid('命令账号或设备格式无效');
  versionOf(input.expectedAccountVersion, '资金账户版本');
  if (input.expectedProfileVersion !== undefined) versionOf(input.expectedProfileVersion, '会员档案版本');
  try {
    if (input.type === 'recharge') { createRecharge(input); text(input.payMethod ?? '', 64, '付款方式'); }
    else if (input.type === 'consume') { createConsumption(input); text(input.itemsSummary ?? '消费', 512, '消费项目'); }
    else {
      if (typeof input.originalEntryId !== 'string' || !ENTITY_ID.test(input.originalEntryId)) throw invalid('原流水单号无效');
      text(input.reason ?? '店主手工撤销', 4096, '撤销原因');
      if (input.allowDebt !== undefined && typeof input.allowDebt !== 'boolean') throw invalid('欠款确认必须是布尔值');
    }
    text(input.remark ?? '', 4096, '备注');
    validateSaleFields(input);
  } catch (error) { if (!error.status) error.status = 400; throw error; }
  // Capture a value rather than retaining a caller-mutable request across await.
  return JSON.parse(JSON.stringify(input));
}
