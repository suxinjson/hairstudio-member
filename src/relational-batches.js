import { COMMAND_ID, ENTITY_ID, invalid, versionOf } from './relational-contract.js';
import { taskRequest } from './relational-tasks.js';
import { ledgerEpochOf, requireLedgerEpoch } from './ledger-epoch.js';
import { DATA_LIMITS, assertJsonBudget } from './data-limits.js';
import { canonicalJSON } from './canonical-json.js';

export const BATCH_TABLES = {
  application_batches: ['store_id', 'batch_id', 'ledger_epoch', 'actor_id', 'device_id', 'request_hash', 'source_digest', 'item_count', 'created_at'],
  application_batch_items: ['store_id', 'batch_id', 'position', 'task_id', 'request_hash', 'task_type', 'member_id', 'name', 'phone', 'notes', 'tags_present', 'expected_version'],
  application_batch_tags: ['store_id', 'task_id', 'position', 'tag'],
  application_batch_controls: ['store_id', 'batch_id', 'state', 'version']
};
export function nullableBatchColumn(table, column) {
  return table === 'application_batches' && column === 'source_digest' || table === 'application_batch_items' && ['member_id', 'name', 'phone', 'notes', 'expected_version'].includes(column);
}
const error = (message, code, status = 409) => Object.assign(new Error(message), { status, code });
function fields(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw invalid('批次字段无效');
}
export function batchScope(input) {
  ledgerEpochOf(input?.ledgerEpoch);
  for (const [key, pattern] of [['id', COMMAND_ID], ['storeId', ENTITY_ID], ['actorId', ENTITY_ID], ['deviceId', COMMAND_ID]]) if (typeof input[key] !== 'string' || !pattern.test(input[key])) throw invalid('批次标识或捕获身份无效');
  return { id: input.id, storeId: input.storeId, ledgerEpoch: input.ledgerEpoch, actorId: input.actorId, deviceId: input.deviceId };
}
export function bindBatch(scope, current) {
  requireLedgerEpoch(scope.ledgerEpoch, current.ledgerEpoch);
  if (scope.storeId !== current.storeId || scope.actorId !== current.actorId || scope.deviceId !== current.deviceId) throw error('批次与当前门店、账号或设备不同', 'BATCH_CONTEXT_CHANGED');
  return scope;
}
export function batchRequest(input) {
  fields(input, ['id', 'storeId', 'ledgerEpoch', 'actorId', 'deviceId', 'sourceDigest', 'items']);
  const scope = batchScope(input);
  assertJsonBudget(input, DATA_LIMITS.operationBytes);
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 500 || input.sourceDigest !== undefined && (typeof input.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceDigest))) throw invalid('批次须包含 1–500 行，文件摘要须为 SHA-256');
  const ids = new Set();
  const items = input.items.map(item => {
    fields(item, ['id', 'type', 'memberId', 'data']);
    const request = taskRequest({ ...scope, ...item });
    for (const key of ['phone', 'notes']) if (item.data[key] !== undefined && typeof item.data[key] !== 'string') throw invalid('批次可选资料字段须为文本或省略');
    if (request.type === 'configuration.update' || ids.has(request.id)) throw invalid('资料批次不能包含配置任务或重复行任务号');
    ids.add(request.id);
    return JSON.parse(JSON.stringify(item));
  });
  return { ...scope, ...(input.sourceDigest === undefined ? {} : { sourceDigest: input.sourceDigest }), items };
}
export function batchControl(input) {
  fields(input, ['id', 'storeId', 'ledgerEpoch', 'actorId', 'deviceId', 'state', 'expectedVersion']);
  const scope = batchScope(input); versionOf(input.expectedVersion);
  if (!['active', 'paused', 'cancelled'].includes(input.state)) throw invalid('批次状态无效');
  return { ...scope, state: input.state, expectedVersion: input.expectedVersion };
}
export function batchItemRequest(head, row, tags) {
  const data = row.task_type === 'member.archive' ? {} : { name: row.name,
    ...(row.phone === null ? {} : { phone: row.phone }), ...(row.notes === null ? {} : { notes: row.notes }),
    ...(String(row.tags_present) === '1' ? { tags: tags.map(item => item.tag) } : {}),
    ...(row.expected_version === null ? {} : { expectedVersion: String(row.expected_version) }) };
  return taskRequest({ id: row.task_id, storeId: head.store_id, ledgerEpoch: head.ledger_epoch, actorId: head.actor_id, deviceId: head.device_id,
    type: row.task_type, ...(row.member_id === null ? {} : { memberId: row.member_id }), data });
}

export function batchCaptureChecks(t, storeId, ensure, { auditCounts } = {}) {
  const heads = new Map(t.application_batches.map(row => [row.batch_id, row])), controls = new Map(t.application_batch_controls.map(row => [row.batch_id, row]));
  ensure(heads.size === t.application_batches.length && controls.size === heads.size && controls.size === t.application_batch_controls.length, '批次头或控制行缺失、重复');
  const items = new Map(), tags = new Map(), checks = [], seen = new Set();
  for (const row of t.application_batch_items) {
    ensure(heads.has(row.batch_id) && !seen.has(row.task_id), '批次行归属或任务号无效'); seen.add(row.task_id);
    if (!items.has(row.batch_id)) items.set(row.batch_id, []); items.get(row.batch_id).push(row);
  }
  for (const row of t.application_batch_tags) {
    ensure(seen.has(row.task_id), '批次标签缺少行任务');
    if (!tags.has(row.task_id)) tags.set(row.task_id, []); tags.get(row.task_id).push(row);
  }
  const receipts = new Map(t.local_task_receipts.map(row => [row.task_id, row]));
  const auditGroups = new Map();
  for (const row of t.local_audit) {
    const key = canonicalJSON([row.entity_id, row.actor_id, row.device_id]);
    if (!auditGroups.has(key)) auditGroups.set(key, []); auditGroups.get(key).push(row);
  }
  for (const h of heads.values()) {
    const c = controls.get(h.batch_id), scope = batchScope({ id: h.batch_id, storeId, ledgerEpoch: h.ledger_epoch, actorId: h.actor_id, deviceId: h.device_id });
    ensure(c && ['active', 'paused', 'cancelled'].includes(c.state), '批次控制状态无效'); versionOf(c.version);
    const rows = (items.get(h.batch_id) ?? []).sort((a, b) => Number(a.position) - Number(b.position));
    ensure(String(rows.length) === h.item_count, '批次捕获行数不完整');
    const requestItems = rows.map((row, position) => {
      ensure(row.position === String(position) && ['0', '1'].includes(row.tags_present), '批次行序号或字段标记无效');
      const values = (tags.get(row.task_id) ?? []).sort((a, b) => Number(a.position) - Number(b.position));
      values.forEach((tag, index) => ensure(tag.position === String(index), '批次标签序号不连续'));
      ensure(row.tags_present === '1' || !values.length, '未捕获标签字段却包含标签');
      if (row.task_type === 'member.archive') ensure(row.name === null && row.phone === null && row.notes === null && row.expected_version === null && row.tags_present === '0', '归档任务包含多余资料');
      const task = batchItemRequest(h, row, values), r = receipts.get(row.task_id);
      ensure(/^[a-f0-9]{64}$/.test(row.request_hash), '批次行摘要无效');
      ensure(!r || r.request_hash === row.request_hash && r.actor_id === h.actor_id && r.device_id === h.device_id && r.ledger_epoch === h.ledger_epoch && r.task_type === row.task_type, '批次行回执与捕获不一致');
      checks.push({ value: task, hash: row.request_hash });
      const { storeId: _s, ledgerEpoch: _e, actorId: _a, deviceId: _d, ...item } = task; return item;
    });
    ensure(h.source_digest === null || /^[a-f0-9]{64}$/.test(h.source_digest), '批次来源摘要无效');
    const request = batchRequest({ ...scope, ...(h.source_digest === null ? {} : { sourceDigest: h.source_digest }), items: requestItems });
    ensure(/^[a-f0-9]{64}$/.test(h.request_hash), '批次摘要无效'); checks.push({ value: request, hash: h.request_hash });
    const key = canonicalJSON([h.batch_id, h.actor_id, h.device_id]), audits = auditGroups.get(key) ?? [];
    const counts = auditCounts?.get(key) ?? { captured: String(audits.filter(row => row.event === 'batch_captured').length), controlled: String(audits.filter(row => row.event === 'batch_controlled').length) };
    ensure(counts.captured === '1' && BigInt(counts.controlled) === BigInt(c.version), '批次核心审计不完整');
  }
  return checks;
}

// The caller supplies one transaction, a dialect adapter and the task lock.
// Payloads are typed immutable rows; receipts are the only completion authority.
export function batchStore({ one, all, run, lockBatch = async () => {}, lockTask = async () => {}, receiptTable, hash, now, audit }) {
  async function head(scope) {
    const row = await one('SELECT * FROM application_batches WHERE store_id=? AND batch_id=?', [scope.storeId, scope.id]);
    if (!row || row.actor_id !== scope.actorId || row.device_id !== scope.deviceId) throw error('未找到当前身份捕获的批次', 'BATCH_NOT_FOUND', 404);
    requireLedgerEpoch(row.ledger_epoch, scope.ledgerEpoch); return row;
  }
  async function control(scope) { return one('SELECT * FROM application_batch_controls WHERE store_id=? AND batch_id=?', [scope.storeId, scope.id]); }
  async function capture(request) {
    // Same order everywhere: task lock(s), then batch lock. Sorted locks also
    // serialize overlapping captures with different batch IDs without deadlock.
    for (const id of request.items.map(item => item.id).sort()) await lockTask(request.storeId, id);
    await lockBatch(request.storeId, request.id);
    const requestHash = await hash(canonicalJSON(request));
    const prior = await one('SELECT * FROM application_batches WHERE store_id=? AND batch_id=?', [request.storeId, request.id]);
    if (prior) {
      await head(request);
      if (prior.request_hash !== requestHash) throw error('同批次号对应不同原始内容', 'BATCH_CONFLICT');
      return { batchId: request.id, ledgerEpoch: request.ledgerEpoch, itemCount: Number(prior.item_count), alreadyCaptured: true };
    }
    const { storeId, id, ledgerEpoch, actorId, deviceId } = request;
    await run('INSERT INTO application_batches(store_id,batch_id,ledger_epoch,actor_id,device_id,request_hash,source_digest,item_count,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [storeId, id, ledgerEpoch, actorId, deviceId, requestHash, request.sourceDigest ?? null, request.items.length, now()]);
    for (const [position, item] of request.items.entries()) {
      if (await one('SELECT task_id FROM application_batch_items WHERE store_id=? AND task_id=?', [storeId, item.id])) throw error('行任务号已属于其他批次', 'BATCH_TASK_CONFLICT');
      const bound = taskRequest({ id, storeId, ledgerEpoch, actorId, deviceId, ...item }), itemHash = await hash(canonicalJSON(bound));
      const receipt = await one('SELECT request_hash,actor_id,device_id,ledger_epoch FROM ' + receiptTable + ' WHERE store_id=? AND task_id=?', [storeId, item.id]);
      if (receipt && (receipt.request_hash !== itemHash || receipt.actor_id !== actorId || receipt.device_id !== deviceId || receipt.ledger_epoch !== ledgerEpoch)) throw error('行任务号已有不同回执', 'TASK_CONFLICT');
      const d = item.data;
      await run('INSERT INTO application_batch_items(store_id,batch_id,position,task_id,request_hash,task_type,member_id,name,phone,notes,tags_present,expected_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        [storeId, id, position, item.id, itemHash, item.type, item.memberId ?? null, d.name ?? null, d.phone ?? null, d.notes ?? null, d.tags === undefined ? '0' : '1', d.expectedVersion ?? null]);
      for (const [index, tag] of (d.tags ?? []).entries()) await run('INSERT INTO application_batch_tags(store_id,task_id,position,tag) VALUES(?,?,?,?)', [storeId, item.id, index, tag]);
    }
    await run('INSERT INTO application_batch_controls(store_id,batch_id,state,version) VALUES(?,?,?,?)', [storeId, id, 'paused', '0']);
    await audit('batch_captured', { batchId: id, itemCount: request.items.length });
    return { batchId: id, ledgerEpoch, itemCount: request.items.length, alreadyCaptured: false };
  }
  async function change(request) {
    await lockBatch(request.storeId, request.id); await head(request);
    const row = await control(request), current = String(row.version);
    if (current !== request.expectedVersion) {
      // An exact lost-response retry is safe until a later control transition.
      if (BigInt(current) === BigInt(request.expectedVersion) + 1n && row.state === request.state) return { batchId: request.id, state: row.state, version: current };
      throw error('批次控制版本已变化，请核对当前进度', 'BATCH_VERSION_CHANGED');
    }
    if (row.state === 'cancelled' && request.state !== 'cancelled') throw error('终止取消的批次不能续传', 'BATCH_CANCELLED');
    versionOf(String(BigInt(current) + 1n));
    const next = String(BigInt(current) + 1n);
    await run('UPDATE application_batch_controls SET state=?,version=? WHERE store_id=? AND batch_id=?', [request.state, next, request.storeId, request.id]);
    await audit('batch_controlled', { batchId: request.id, state: request.state, version: next });
    return { batchId: request.id, state: request.state, version: next };
  }
  async function guardTask(request, requestHash) {
    const row = await one('SELECT * FROM application_batch_items WHERE store_id=? AND task_id=?', [request.storeId, request.id]);
    if (!row) return;
    await lockBatch(request.storeId, row.batch_id);
    const scope = { ...request, id: row.batch_id }; await head(scope);
    if (row.request_hash !== requestHash) throw error('批次行内容与原始捕获不同', 'TASK_CONFLICT');
    const state = (await control(scope)).state;
    if (state !== 'active') throw error(state === 'cancelled' ? '批次已终止取消' : '批次已暂停，须明确继续', state === 'cancelled' ? 'BATCH_CANCELLED' : 'BATCH_PAUSED');
  }
  async function task(scope, taskId) {
    const h = await head(scope), row = await one('SELECT * FROM application_batch_items WHERE store_id=? AND batch_id=? AND task_id=?', [scope.storeId, scope.id, taskId]);
    if (!row) throw error('批次行不存在', 'BATCH_ITEM_NOT_FOUND', 404);
    const tags = await all('SELECT tag FROM application_batch_tags WHERE store_id=? AND task_id=? ORDER BY position', [scope.storeId, taskId]);
    const request = batchItemRequest(h, row, tags);
    if (await hash(canonicalJSON(request)) !== row.request_hash) throw error('批次捕获内容完整性校验失败', 'BATCH_CORRUPT');
    return request;
  }
  async function progress(scope, { after = -1, limit = 100 } = {}) {
    if (!Number.isInteger(after) || after < -1 || after > 499 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('批次分页无效');
    const h = await head(scope), c = await control(scope);
    const count = await one('SELECT count(*) AS n FROM application_batch_items i JOIN ' + receiptTable + ' r ON r.store_id=i.store_id AND r.task_id=i.task_id AND r.request_hash=i.request_hash WHERE i.store_id=? AND i.batch_id=?', [scope.storeId, scope.id]);
    const rows = await all('SELECT i.position,i.task_id,i.task_type,r.task_id AS completed FROM application_batch_items i LEFT JOIN ' + receiptTable + ' r ON r.store_id=i.store_id AND r.task_id=i.task_id AND r.request_hash=i.request_hash WHERE i.store_id=? AND i.batch_id=? AND i.position>? ORDER BY i.position LIMIT ?', [scope.storeId, scope.id, after, limit + 1]);
    const page = rows.slice(0, limit), completed = Number(count.n), total = Number(h.item_count);
    return { batchId: scope.id, ledgerEpoch: h.ledger_epoch, state: c.state, version: String(c.version), itemCount: total, completedCount: completed,
      pendingCount: c.state === 'cancelled' ? 0 : total - completed, cancelledCount: c.state === 'cancelled' ? total - completed : 0,
      items: page.map(row => ({ position: Number(row.position), taskId: row.task_id, type: row.task_type, state: row.completed ? 'completed' : c.state === 'cancelled' ? 'cancelled' : 'pending' })),
      nextAfter: rows.length > limit ? Number(page.at(-1).position) : null };
  }
  return { capture, change, guardTask, task, progress };
}
