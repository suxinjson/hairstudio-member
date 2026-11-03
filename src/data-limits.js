// Shared limits for local writes, backups and the cloud API. Never truncate history.
import { normalizeRechargeSettings } from './recharge-settings.js';
export const DATA_LIMITS = Object.freeze({
  name: 128, phone: 64, notes: 2000, remark: 4096, id: 128,
  members: 20000, ledgers: 50000, services: 500, rechargePlans: 200,
  accountBytes: 10 * 1024 * 1024, backupBytes: 20 * 1024 * 1024,
  syncBytes: 2 * 1024 * 1024, restoreBytes: 32 * 1024 * 1024,
  operationBytes: 512 * 1024,
  depth: 24, nodes: 1000000
});
export class DataLimitError extends Error {
  constructor(message) { super(message); this.status = 413; this.code = 'DATA_LIMIT'; }
}
export const byteLength = value => new TextEncoder().encode(value).length;
function safeUnicode(value) {
  if (value.includes('\u0000') || /[\uD800-\uDFFF]/u.test(value)) throw Object.assign(new Error('文本包含无效字符'), { status: 400 });
}
export function boundedText(value, limit, label, required = false) {
  if (typeof value !== 'string' || (required && !value.trim())) throw Object.assign(new Error(label + '格式无效'), { status: 400 });
  if (value.length > limit) throw new DataLimitError(label + '过长，最多 ' + limit + ' 个字符');
  safeUnicode(value);
}
export function assertJsonBudget(value, maxBytes, maxString = 16384) {
  // Iterative traversal rejects cycles/deep input before stringify/canonicalization.
  const stack = [[value, 0]], seen = new WeakSet(); let nodes = 0;
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (++nodes > DATA_LIMITS.nodes || depth > DATA_LIMITS.depth) throw new DataLimitError('JSON 嵌套或节点数量超出限制');
    if (typeof item === 'string' && item.length > maxString) throw new DataLimitError('JSON 文本字段过长');
    if (typeof item === 'string') safeUnicode(item);
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('JSON 数值无效');
    if (item && typeof item === 'object') {
      if (seen.has(item)) throw new Error('JSON 包含重复引用或循环');
      seen.add(item);
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('JSON 对象格式无效');
      const keys = Object.keys(item);
      if (nodes + stack.length + keys.length > DATA_LIMITS.nodes) throw new DataLimitError('JSON 节点数量超出限制');
      for (const key of keys) {
        safeUnicode(key);
        if (key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('JSON 字段名无效');
        stack.push([item[key], depth + 1]);
      }
    }
  }
  if (byteLength(JSON.stringify(value)) > maxBytes) throw new DataLimitError('数据超出容量限制，请先导出备份并联系管理员');
}
export function assertAccountLimits(data) {
  assertJsonBudget(data, DATA_LIMITS.accountBytes);
  if (data.rechargeSettings != null) normalizeRechargeSettings(data.rechargeSettings);
  for (const field of ['members', 'ledgers', 'services', 'rechargePlans']) {
    if (!Array.isArray(data[field])) throw new Error('账本列表格式无效');
    if (data[field].length > DATA_LIMITS[field]) throw new DataLimitError(field + ' 记录数量超出限制');
  }
  const check = (record, field, max) => {
    if (record?.[field] != null) boundedText(record[field], max, field);
  };
  for (const item of data.members) {
    check(item, 'id', DATA_LIMITS.id); check(item, 'name', DATA_LIMITS.name);
    check(item, 'phone', DATA_LIMITS.phone); check(item, 'notes', DATA_LIMITS.notes);
  }
  for (const item of data.ledgers) {
    for (const field of ['id', 'memberId', 'originalLedgerId']) check(item, field, DATA_LIMITS.id);
    check(item, 'memberName', DATA_LIMITS.name); check(item, 'memberPhone', DATA_LIMITS.phone);
    check(item, 'remark', 8192); // Includes generated receipt/refund descriptions.
    check(item, 'created_at', 64);
  }
  for (const item of data.services) { check(item, 'id', DATA_LIMITS.id); check(item, 'name', DATA_LIMITS.name); }
}
export function validateMutationArgs(method, args) {
  if (method === 'importBackupData') {
    boundedText(args[0], DATA_LIMITS.backupBytes, '备份');
    if (byteLength(args[0]) > DATA_LIMITS.backupBytes) throw new DataLimitError('备份文件过大');
    if (args[1] !== undefined && (!args[1] || typeof args[1] !== 'object' || Array.isArray(args[1]) || !['replace', 'merge', undefined].includes(args[1].mode))) throw new Error('恢复选项无效');
    return;
  }
  assertJsonBudget(args, 64 * 1024);
  if (method === 'saveRechargeSettings') normalizeRechargeSettings(args[0]);
  const id = value => boundedText(value, DATA_LIMITS.id, '单号', true);
  const object = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('操作参数格式无效'); return value; };
  const labels = { name: '会员姓名', phone: '手机号码', notes: '会员备注', remark: '备注', payMethod: '付款方式', itemsSummary: '消费项目' };
  const texts = (item, fields) => { for (const [key, max] of Object.entries(fields)) if (item[key] !== undefined) boundedText(item[key], max, labels[key] || key, ['name', 'phone'].includes(key)); };
  const money = (item, fields) => { for (const key of fields) if (item[key] !== undefined && (typeof item[key] !== 'number' && typeof item[key] !== 'string' || String(item[key]).length > 32)) throw new Error('金额格式无效'); };
  if (['deleteMember', 'deleteService', 'refundLedger', 'updateMember'].includes(method)) id(args[0]);
  if (method === 'refundLedger' && args[1] !== undefined) boundedText(args[1], DATA_LIMITS.remark, '撤销原因');
  if (method === 'refundLedger' && args[2] !== undefined && typeof args[2] !== 'boolean') throw new Error('欠款确认必须是布尔值');
  if (['createMember', 'updateMember'].includes(method)) {
    const item = object(args[method === 'updateMember' ? 1 : 0]);
    texts(item, { name: DATA_LIMITS.name, phone: DATA_LIMITS.phone, notes: DATA_LIMITS.notes }); money(item, ['initialBalance']);
    if (method === 'createMember') { boundedText(item.name, DATA_LIMITS.name, '姓名', true); boundedText(item.phone, DATA_LIMITS.phone, '手机', true); }
  }
  if (['recharge', 'consume'].includes(method)) {
    const item = object(args[0]); id(item.memberId);
    texts(item, { payMethod: 64, itemsSummary: 512, remark: DATA_LIMITS.remark }); money(item, ['actualPay', 'giftAmount', 'amount']);
    if (method === 'consume' && item.allowDebt !== undefined && typeof item.allowDebt !== 'boolean') throw new Error('欠款确认必须是布尔值');
  }
  if (method === 'saveService') {
    const item = object(args[0]); boundedText(item.name, DATA_LIMITS.name, '服务名称', true);
    if (item.id !== undefined && item.id !== '') id(item.id); money(item, ['price']);
  }
}
