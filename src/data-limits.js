// Shared limits for local writes, backups and the cloud API. Never truncate history.
export const DATA_LIMITS = Object.freeze({
  name: 128, phone: 64, notes: 2000, remark: 4096, id: 128,
  members: 20000, ledgers: 50000, services: 500, rechargePlans: 200,
  restoreBytes: 32 * 1024 * 1024,
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
