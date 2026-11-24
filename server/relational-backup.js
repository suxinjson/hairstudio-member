import { PG_BACKUP_TABLES, PG_BASE_TABLES } from '../src/relational-pg-archive-tables.js';
import { randomUUID } from 'node:crypto';
import { canonicalJSON } from '../src/canonical-json.js';
import { DATA_LIMITS, assertJsonBudget } from '../src/data-limits.js';
import { BACKUP_TABLES, backupEnsure as ensure, backupTime, validateBackupRow, validateBackupTables } from '../src/relational-backup-rows.js';
import { ledgerEpochOf, requireLedgerEpoch } from '../src/ledger-epoch.js';
import { COMMAND_ID, versionOf } from '../src/relational-contract.js';
import { requireFeature } from './entitlements.js';
import { ApiError, digest } from './security.js';
import { BATCH_TABLES, batchCaptureChecks, nullableBatchColumn } from '../src/relational-batches.js';

// This bounded logical format contains no SQL, credentials, licences, sessions,
// voice secrets or old snapshots. Use the streaming archive for growth backups.
export { PG_BACKUP_TABLES };
const keys = {
  actors: ['id'], member_profiles: ['id'], member_tags: ['member_id', 'tag'], member_accounts: ['member_id'],
  account_opening_batches: ['batch_id'], account_openings: ['member_id'], ledger_entries: ['entry_id'], ledger_reversals: ['original_entry_id'],
  service_catalog: ['id'], recharge_plan_items: ['id'], store_recharge_settings: ['store_id'], consumption_items: ['entry_id', 'position'],
  payment_records: ['entry_id', 'position'], recharge_details: ['entry_id'], ledger_command_receipts: ['command_id'],
  application_task_receipts: ['task_id'], application_batches: ['batch_id'], application_batch_items: ['task_id'], application_batch_tags: ['task_id', 'position'], application_batch_controls: ['batch_id'], store_change_heads: ['store_id'], store_changes: ['cursor'], audit_events: ['event_id'], ledger_restore_receipts: ['task_id']
};
const auditFields = {
  member_created: ['memberId'], member_updated: ['memberId'], member_archived: ['memberId'], member_reactivated: ['memberId'],
  ledger_recharge: ['commandId', 'memberId', 'entryId'], ledger_consume: ['commandId', 'memberId', 'entryId'], ledger_reversal: ['commandId', 'memberId', 'entryId'],
  task_completed: ['taskId', 'type'], account_opening_imported: ['batchId', 'sourceDigest', 'memberCount', 'netBalanceCents'],
  configuration_updated: ['version', 'serviceCount', 'planCount'],
  batch_captured: ['batchId', 'itemCount'], batch_controlled: ['batchId', 'state', 'version'],
  ledger_restored: ['taskId', 'sourceDigest', 'sourceEpoch', 'targetEpoch', 'ledgerEpoch', 'memberCount', 'entryCount']
};
const auditFilter = " AND event IN (" + Object.keys(auditFields).map(event => "'" + event + "'").join(',') + ')';
const nullable = new Set(['archived_at', 'source_member_id', 'service_id', 'plan_id', 'occurred_at']);
const booleanColumns = new Set(['active', 'gift_enabled']);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const ms = value => value === null ? null : new Date(value).toISOString();
const pgTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && ms(value) === value.slice(0, 23) + 'Z';
const shape = (value, columns) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === columns.length && Object.keys(value).every(column => columns.includes(column));
const json = value => { try { return JSON.parse(value); } catch { ensure(false, '备份 JSON 结果无效'); } };
const unique = (rows, key) => { const map = new Map(rows.map(row => [row[key], row])); ensure(map.size === rows.length, '备份实体重复'); return map; };
const summaryResult = row => ({ taskId: row.task_id, storeId: row.store_id, targetEpoch: row.target_epoch, sourceEpoch: row.source_epoch,
  ledgerEpoch: row.restored_epoch, sourceDigest: row.source_digest, memberCount: Number(row.member_count), entryCount: Number(row.entry_count), completedAt: ms(row.completed_at) });

export function logicalTables(tables) {
  const t = Object.fromEntries(Object.keys(BACKUP_TABLES).map(table => [table, []]));
  t.local_restore_receipts = tables.ledger_restore_receipts.map(row => ({ ...row, completed_at: ms(row.completed_at) }));
  for (const table of Object.keys(BATCH_TABLES)) t[table] = tables[table].map(row => ({ ...row, ...(table === 'application_batches' ? { created_at: ms(row.created_at) } : {}) }));
  for (const table of PG_BASE_TABLES) t[table] = tables[table].map(row => Object.fromEntries(BACKUP_TABLES[table].map(column => [column,
    row[column] === null ? null : column.endsWith('_at') ? ms(row[column]) : booleanColumns.has(column) ? row[column] === 'true' ? '1' : '0' : row[column]])));
  const entries = unique(t.ledger_entries, 'entry_id');
  const changes = unique(tables.store_changes, 'cursor');
  for (const row of tables.ledger_command_receipts) {
    const result = json(row.result), entry = entries.get(row.command_id);
    ensure(shape(result, ['storeId', 'ledgerEpoch', 'commandId', 'entryId', 'memberId', 'type', 'deltaCents', 'balanceBeforeCents', 'balanceAfterCents', 'accountVersion', 'occurredAt', 'cursor']) && entry, '资金回执结果不完整');
    ensure(result.storeId === row.store_id && result.ledgerEpoch === row.ledger_epoch && result.entryId === row.command_id && result.commandId === row.command_id &&
      row.command_type === (entry.kind === 'reversal' ? 'reverse' : entry.kind), '资金回执标识不一致');
    t.command_receipts.push({ store_id: row.store_id, command_id: row.command_id, request_hash: row.request_hash, actor_id: row.actor_id, device_id: row.device_id,
      member_id: result.memberId, kind: result.type, delta_cents: result.deltaCents, balance_before_cents: result.balanceBeforeCents,
      balance_after_cents: result.balanceAfterCents, account_version: result.accountVersion, occurred_at: result.occurredAt, ledger_epoch: row.ledger_epoch });
    versionOf(result.cursor);
    const change = changes.get(result.cursor);
    ensure(change?.entity_type === 'member' && change.entity_id === result.memberId && BigInt(result.cursor) > 1n, '资金回执水位与变更不一致');
    const ledgerChange = changes.get(String(BigInt(result.cursor) - 1n));
    ensure(ledgerChange?.entity_type === 'ledger' && ledgerChange.entity_id === row.command_id, '资金回执缺少流水变更');
  }
  for (const row of tables.application_task_receipts) {
    const common = { store_id: row.store_id, task_id: row.task_id }, result = json(row.result);
    t.local_task_receipts.push(Object.fromEntries(BACKUP_TABLES.local_task_receipts.map(column => [column, column === 'completed_at' ? ms(row[column]) : row[column]])));
    if (row.task_type === 'member.archive') { ensure(shape(result, ['success']) && result.success === true, '归档任务结果无效'); continue; }
    if (row.task_type === 'configuration.update') {
      ensure(shape(result, ['version', 'services', 'rechargePlans', 'rechargeSettings']) && shape(result.rechargeSettings, ['giftEnabled', 'giftRateBasisPoints']) && typeof result.rechargeSettings.giftEnabled === 'boolean' && Number.isInteger(result.rechargeSettings.giftRateBasisPoints), '配置任务结果无效');
      ensure(Array.isArray(result.services) && Array.isArray(result.rechargePlans), '配置任务明细无效');
      t.task_configuration_results.push({ ...common, version: result.version, gift_enabled: result.rechargeSettings.giftEnabled ? '1' : '0', gift_rate_basis_points: String(result.rechargeSettings.giftRateBasisPoints) });
      result.services.forEach((item, position) => { ensure(shape(item, ['id', 'name', 'priceCents']), '配置服务结果无效'); t.task_configuration_services.push({ ...common, position: String(position), id: item.id, name: item.name, price_cents: item.priceCents }); });
      result.rechargePlans.forEach((item, position) => { ensure(shape(item, ['id', 'payCents', 'giftCents']), '配置套餐结果无效'); t.task_configuration_plans.push({ ...common, position: String(position), id: item.id, pay_cents: item.payCents, gift_cents: item.giftCents }); });
    } else {
      ensure(shape(result, ['id', 'name', 'phone', 'notes', 'tags', 'balanceCents', 'version', 'accountVersion', 'createdAt', 'updatedAt', 'archivedAt']) && Array.isArray(result.tags), '会员任务结果无效');
      t.task_member_results.push({ ...common, member_id: result.id, name: result.name, phone: result.phone, notes: result.notes, balance_cents: result.balanceCents,
        profile_version: result.version, account_version: result.accountVersion, created_at: result.createdAt, updated_at: result.updatedAt, archived_at: result.archivedAt });
      result.tags.forEach(tag => t.task_member_tags.push({ ...common, tag }));
    }
  }
  tables.audit_events.forEach((row, position) => {
    const d = json(row.details), fields = auditFields[row.event];
    ensure(fields && shape(d, fields), '业务审计字段无效或包含非业务机密');
    t.local_audit.push({ id: String(position + 1), store_id: row.store_id, actor_id: row.user_id, device_id: row.device_id, event: row.event,
      entity_id: d.commandId ?? d.taskId ?? d.memberId ?? d.batchId ?? 'store', occurred_at: ms(row.occurred_at ?? row.received_at) });
  });
  return t;
}

export function validatePostgresBackup(input, storeId) {
  assertJsonBudget(input, DATA_LIMITS.restoreBytes, DATA_LIMITS.operationBytes);
  ensure(shape(input, ['format', 'formatVersion', 'schemaVersion', 'storeId', 'ledgerEpoch', 'exportedAt', 'tables', 'digest']) &&
    input.format === 'member-relational-postgres' && input.formatVersion === 2 && input.schemaVersion === 2 && input.storeId === storeId && backupTime(input.exportedAt), '云端备份格式或门店归属不匹配');
  ledgerEpochOf(input.ledgerEpoch);
  const { digest: checksum, ...payload } = input;
  ensure(/^[a-f0-9]{64}$/.test(checksum) && digest(canonicalJSON(payload)) === checksum, '云端备份摘要不匹配');
  ensure(shape(input.tables, Object.keys(PG_BACKUP_TABLES)), '云端备份关系表不完整');
  const t = input.tables;
  for (const [table, columns] of Object.entries(PG_BACKUP_TABLES)) {
    ensure(Array.isArray(t[table]) && t[table].length <= 150000, '云端备份数量超出边界');
    const seen = new Set();
    for (const row of t[table]) {
      validatePostgresRow(table, row, storeId);
      const key = canonicalJSON(keys[table].map(column => row[column])); ensure(!seen.has(key), '云端备份主键重复'); seen.add(key);
    }
  }
  const actors = unique(t.actors, 'id');
  for (const actor of actors.values()) ensure(uuid(actor.id) && actor.display_name.trim() && actor.display_name.length <= 128, '历史操作人引用无效');
  const referencedActors = new Set();
  for (const rows of Object.values(t)) for (const row of rows) for (const column of ['actor_id', 'imported_by', 'user_id']) {
    if (column in row) { ensure(actors.has(row[column]), '业务历史缺少同店操作人引用'); referencedActors.add(row[column]); }
  }
  ensure(referencedActors.size === actors.size, '备份包含无业务引用的操作人');
  for (const row of t.member_profiles) ensure(row.phone_normalized === row.phone.replace(/[^0-9+]/g, ''), '电话检索字段不一致');
  for (const row of t.service_catalog) versionOf(row.version);
  ensure(t.store_change_heads.length <= 1, '同步水位重复');
  const head = t.store_change_heads[0]?.head ?? '0'; versionOf(head);
  const changes = [...t.store_changes].sort((a, b) => BigInt(a.cursor) < BigInt(b.cursor) ? -1 : 1);
  ensure(head === String(changes.length), '同步水位或变更不完整');
  const members = unique(t.member_profiles, 'id'), entries = unique(t.ledger_entries, 'entry_id');
  changes.forEach((row, index) => ensure(row.cursor === String(index + 1) &&
    (row.entity_type === 'member' && members.has(row.entity_id) && ['upsert', 'archive'].includes(row.change_type) ||
      row.entity_type === 'ledger' && entries.has(row.entity_id) && row.change_type === 'upsert' ||
      row.entity_type === 'configuration' && row.entity_id === 'store' && row.change_type === 'upsert'), '同步变更不连续或引用无效'));
  const logical = logicalTables(t), summary = validateBackupTables(logical, storeId, { requireCommandConfiguration: false });
  for (const check of batchCaptureChecks(logical, storeId, ensure)) ensure(digest(canonicalJSON(check.value)) === check.hash, '批次捕获摘要与原内容不一致');
  const tasks = unique(t.application_task_receipts, 'task_id'), batches = unique(t.account_opening_batches, 'batch_id');
  const audits = new Map();
  for (const row of logical.local_audit) { const key = canonicalJSON([row.event, row.entity_id]); if (!audits.has(key)) audits.set(key, []); audits.get(key).push(row); }
  const auditCount = (event, id) => audits.get(canonicalJSON([event, id]))?.length ?? 0;
  for (const row of t.ledger_entries) ensure(auditCount('ledger_' + row.kind, row.entry_id) === 1, '资金核心审计缺失或重复');
  for (const row of t.application_task_receipts) ensure(auditCount('task_completed', row.task_id) === 1, '任务核心审计缺失或重复');
  for (const row of t.account_opening_batches) ensure(auditCount('account_opening_imported', row.batch_id) === 1, '期初核心审计缺失或重复');
  ensure(String(auditCount('configuration_updated', 'store')) === (t.store_recharge_settings[0]?.version ?? '0'), '配置版本与核心审计不完整');
  for (const row of t.audit_events) {
    ensure(uuid(row.event_id) && COMMAND_ID.test(row.device_id), '业务审计标识无效'); const d = json(row.details);
    if (row.event.startsWith('ledger_') && row.event !== 'ledger_restored') ensure(entries.get(d.entryId)?.member_id === d.memberId && d.commandId === d.entryId, '资金审计引用无效');
    if (row.event.startsWith('member_')) ensure(members.has(d.memberId), '会员审计引用无效');
    if (row.event === 'task_completed') ensure(tasks.get(d.taskId)?.task_type === d.type, '任务审计引用无效');
    if (row.event === 'account_opening_imported') { const batch = batches.get(d.batchId); ensure(batch && Number.isInteger(d.memberCount) && batch.source_digest === d.sourceDigest && batch.member_count === String(d.memberCount) && batch.net_balance_cents === d.netBalanceCents, '期初审计不一致'); }
    if (row.event === 'configuration_updated') { versionOf(d.version); ensure(BigInt(d.version) <= BigInt(t.store_recharge_settings[0]?.version ?? '0') && Number.isInteger(d.serviceCount) && Number.isInteger(d.planCount), '配置审计无效'); }
  }
  for (const row of t.ledger_restore_receipts) {
    ensure(COMMAND_ID.test(row.task_id) && COMMAND_ID.test(row.device_id) && row.restored_epoch !== row.source_epoch && row.restored_epoch !== row.target_epoch, '恢复回执标识无效');
    versionOf(row.member_count); versionOf(row.entry_count);
    ensure(t.audit_events.some(event => { const d = json(event.details); return event.event === 'ledger_restored' && event.user_id === row.actor_id && event.device_id === row.device_id &&
      d.taskId === row.task_id && d.sourceDigest === row.source_digest && d.sourceEpoch === row.source_epoch && d.targetEpoch === row.target_epoch && d.ledgerEpoch === row.restored_epoch && String(d.memberCount) === row.member_count && String(d.entryCount) === row.entry_count; }), '恢复回执缺少一致审计');
  }
  ensure(t.audit_events.filter(row => row.event === 'ledger_restored').length === t.ledger_restore_receipts.length, '恢复审计与回执不完整或重复');
  return { payload, digest: checksum, summary };
}

// Shared by the bounded and streaming formats. File data never supplies SQL
// identifiers, column lists, credentials or implicit database conversions.
export function validatePostgresRow(table, row, storeId) {
  const columns = PG_BACKUP_TABLES[table];
  ensure(columns && shape(row, columns) && row.store_id === storeId, '云端备份列或门店不匹配');
  for (const column of columns) {
    const value = row[column]; if (value === null && (nullable.has(column) || nullableBatchColumn(table, column))) continue;
    ensure(typeof value === 'string' && value.length <= (column === 'result' ? DATA_LIMITS.operationBytes : 8192), '云端备份值类型或长度无效');
    if (column.endsWith('_at')) ensure(pgTime(value), '云端备份时间须保留 UTC 微秒');
    if (booleanColumns.has(column)) ensure(['true', 'false'].includes(value), '云端布尔字段无效');
    if (column.endsWith('_epoch') || column === 'ledger_epoch') ledgerEpochOf(value);
    if (column.endsWith('_digest') || column === 'request_hash') ensure(/^[a-f0-9]{64}$/.test(value), '云端记录摘要无效');
  }
  if (table === 'actors') ensure(uuid(row.id) && row.display_name.trim() && row.display_name.length <= 128, '历史操作人引用无效');
  if (BACKUP_TABLES[table]) validateBackupRow(table, Object.fromEntries(BACKUP_TABLES[table].map(column => [column, row[column] === null ? null : column.endsWith('_at') ? ms(row[column]) : booleanColumns.has(column) ? row[column] === 'true' ? '1' : '0' : row[column]])), storeId);
  if (table === 'service_catalog') versionOf(row.version);
  if (table === 'store_change_heads') versionOf(row.head);
  if (table === 'store_changes') { versionOf(row.cursor); ensure(BigInt(row.cursor) > 0n, '同步变更水位无效'); }
}

export { keys as PG_BACKUP_KEYS, auditFields as PG_AUDIT_FIELDS, auditFilter as PG_AUDIT_FILTER, emptyTarget, summaryResult };

async function selectTable(client, table, storeId, budget) {
  const columns = PG_BACKUP_TABLES[table], order = keys[table], result = []; let last;
  for (;;) {
    const orderedColumns = order.map(column => table + '.' + column);
    const params = [storeId, ...(last ?? [])], after = last ? ' AND (' + orderedColumns.join(',') + ') > (' + order.map((_, i) => '$' + (i + 2)).join(',') + ')' : '';
    const projection = columns.map(column => column.endsWith('_at') ? 'to_char(' + column + " AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS " + column : column + '::text AS ' + column).join(',');
    // Qualify ORDER BY: the exported text alias must never change a BIGINT
    // key's native ordering (1,10,100...) and duplicate/skip subsequent pages.
    const { rows } = await client.query('SELECT ' + projection + ' FROM ' + table + ' WHERE store_id=$1' + (table === 'audit_events' ? auditFilter : '') + after + ' ORDER BY ' + orderedColumns.join(',') + ' LIMIT 500', params);
    budget.bytes += Buffer.byteLength(JSON.stringify(rows));
    if (budget.bytes > DATA_LIMITS.restoreBytes - 4096) throw new ApiError(413, '备份超过当前逻辑格式容量，请使用经验证的数据库备份流程', 'DATA_LIMIT');
    result.push(...rows); if (result.length > 150000) throw new ApiError(413, '备份超过当前逻辑格式容量，请使用经验证的数据库备份流程', 'DATA_LIMIT');
    if (rows.length < 500) return result; last = order.map(column => rows.at(-1)[column]);
  }
}
async function emptyTarget(client, storeId) {
  // Authentication/audits may already exist in a newly provisioned store.
  for (const table of Object.keys(PG_BACKUP_TABLES).filter(table => !['actors', 'store_recharge_settings'].includes(table))) {
    if ((await client.query('SELECT 1 FROM ' + table + ' WHERE store_id=$1' + (table === 'audit_events' ? auditFilter : '') + ' LIMIT 1', [storeId])).rows.length) throw new ApiError(409, '恢复目标已有业务数据，必须使用同门店空账本', 'RESTORE_NOT_EMPTY');
  }
  const { rows: [settings] } = await client.query('SELECT version,gift_enabled,gift_rate_basis_points FROM store_recharge_settings WHERE store_id=$1', [storeId]);
  if (settings && (String(settings.version) !== '0' || !settings.gift_enabled || settings.gift_rate_basis_points !== 1000)) throw new ApiError(409, '恢复目标已有门店配置', 'RESTORE_NOT_EMPTY');
}
async function actorConflicts(client, t, storeId) {
  const { rows } = await client.query('SELECT id,store_id FROM users WHERE id=ANY($1::uuid[])', [t.actors.map(row => row.id)]);
  if (rows.some(row => row.store_id !== storeId)) throw new ApiError(409, '历史操作人标识已属于其他门店，禁止自动映射', 'RESTORE_ACTOR_CONFLICT');
  const present = new Set(rows.map(row => row.id)); return t.actors.filter(row => !present.has(row.id));
}
function capture(input, storeId) {
  // Copy before the first await: callers cannot change a reviewed file in flight.
  assertJsonBudget(input, DATA_LIMITS.restoreBytes, DATA_LIMITS.operationBytes);
  ensure(shape(input, ['id', 'ledgerEpoch', 'reviewedDigest', 'backup']) && COMMAND_ID.test(input.id), '恢复任务请求无效');
  const copy = JSON.parse(JSON.stringify(input)); ledgerEpochOf(copy.ledgerEpoch);
  const checked = validatePostgresBackup(copy.backup, storeId);
  ensure(copy.reviewedDigest === checked.digest, '须核对并提交备份摘要'); return { ...copy, ...checked };
}
export function createBackupService({ withAuthorized, audit }) {
  return {
    exportBackup(identity) {
      return withAuthorized(identity, 'owner', async (client, user) => {
        requireFeature(user.entitlements, 'backup');
        const tables = {}, budget = { bytes: 0 };
        for (const table of Object.keys(PG_BACKUP_TABLES).filter(table => table !== 'actors')) tables[table] = await selectTable(client, table, user.store_id, budget);
        const ids = new Set(); for (const rows of Object.values(tables)) for (const row of rows) for (const column of ['actor_id', 'imported_by', 'user_id']) if (row[column]) ids.add(row[column]);
        tables.actors = (await client.query("SELECT id::text,store_id::text,display_name,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at FROM users WHERE store_id=$1 AND id=ANY($2::uuid[]) ORDER BY id", [user.store_id, [...ids]])).rows;
        const payload = { format: 'member-relational-postgres', formatVersion: 2, schemaVersion: 2, storeId: user.store_id, ledgerEpoch: user.ledger_epoch, exportedAt: new Date().toISOString(), tables };
        // Leave room for the restore request wrapper, never truncate a file.
        assertJsonBudget(payload, DATA_LIMITS.restoreBytes - 4096, DATA_LIMITS.operationBytes);
        const result = { ...payload, digest: digest(canonicalJSON(payload)) }; validatePostgresBackup(result, user.store_id); return result;
      }, { consistentRead: true });
    },
    async previewBackupRestore(identity, input) {
      assertJsonBudget(input, DATA_LIMITS.restoreBytes, DATA_LIMITS.operationBytes); const captured = JSON.parse(JSON.stringify(input));
      return withAuthorized(identity, 'owner', async (client, user) => {
        requireFeature(user.entitlements, 'backup'); const request = capture(captured, user.store_id); requireLedgerEpoch(request.ledgerEpoch, user.ledger_epoch);
        await emptyTarget(client, user.store_id); const missing = await actorConflicts(client, request.payload.tables, user.store_id);
        return { taskId: request.id, sourceDigest: request.digest, sourceEpoch: request.payload.ledgerEpoch, targetEpoch: user.ledger_epoch, ...request.summary, historicalActorCount: missing.length };
      }, { consistentRead: true });
    },
    async restoreBackup(identity, input) {
      assertJsonBudget(input, DATA_LIMITS.restoreBytes, DATA_LIMITS.operationBytes); const captured = JSON.parse(JSON.stringify(input));
      // The recovery transaction takes the exclusive store lock before any
      // authorization locks. All normal v2 writers take the shared store lock.
      return withAuthorized(identity, 'owner', async (client, user) => {
        requireFeature(user.entitlements, 'backup'); const request = capture(captured, user.store_id), t = request.payload.tables;
        const { rows: [prior] } = await client.query('SELECT * FROM ledger_restore_receipts WHERE store_id=$1 AND task_id=$2', [user.store_id, request.id]);
        if (prior) {
          if (prior.actor_id !== user.id || prior.device_id !== user.device_id || prior.target_epoch !== request.ledgerEpoch || prior.source_digest !== request.digest || prior.source_epoch !== request.payload.ledgerEpoch) throw new ApiError(409, '恢复任务号已绑定其他内容或身份', 'RESTORE_TASK_CONFLICT');
          // This exact completed task alone may query its original target epoch.
          // It never re-runs restore or relabels any queued business request.
          return summaryResult(prior);
        }
        requireLedgerEpoch(request.ledgerEpoch, user.ledger_epoch); await emptyTarget(client, user.store_id);
        ensure(!t.ledger_restore_receipts.some(row => row.task_id === request.id), '恢复任务号与来源历史重复');
        const missing = await actorConflicts(client, t, user.store_id);
        for (const row of missing) await client.query("INSERT INTO users(id,store_id,username,display_name,password_hash,role,active,historical_only,created_at) VALUES($1,$2,$3,$4,'!restored-history-no-password','viewer',false,true,$5)", [row.id, user.store_id, '~history~' + row.id, row.display_name, row.created_at]);
        for (const [table, columns] of Object.entries(PG_BACKUP_TABLES)) {
          if (table === 'actors') continue;
          for (const row of t[table]) {
            const conflict = table === 'store_recharge_settings' ? ' ON CONFLICT(store_id) DO UPDATE SET ' + columns.filter(column => column !== 'store_id').map(column => column + '=EXCLUDED.' + column).join(',') : '';
            await client.query('INSERT INTO ' + table + '(' + columns.join(',') + ') VALUES(' + columns.map((_, i) => '$' + (i + 1)).join(',') + ')' + conflict, columns.map(column => row[column]));
          }
        }
        let epoch; do { epoch = randomUUID(); } while ([request.payload.ledgerEpoch, user.ledger_epoch].includes(epoch));
        await client.query('UPDATE stores SET ledger_epoch=$1 WHERE id=$2', [epoch, user.store_id]);
        const at = new Date().toISOString(), result = { store_id: user.store_id, task_id: request.id, actor_id: user.id, device_id: user.device_id, target_epoch: user.ledger_epoch,
          source_epoch: request.payload.ledgerEpoch, restored_epoch: epoch, source_digest: request.digest, member_count: String(request.summary.memberCount), entry_count: String(request.summary.entryCount), completed_at: at };
        const columns = PG_BACKUP_TABLES.ledger_restore_receipts;
        await client.query('INSERT INTO ledger_restore_receipts(' + columns.join(',') + ') VALUES(' + columns.map((_, i) => '$' + (i + 1)).join(',') + ')', columns.map(column => result[column]));
        await audit(client, user, 'ledger_restored', { taskId: request.id, sourceDigest: request.digest, sourceEpoch: request.payload.ledgerEpoch, targetEpoch: user.ledger_epoch, ledgerEpoch: epoch, memberCount: request.summary.memberCount, entryCount: request.summary.entryCount });
        return summaryResult(result);
      }, { exclusiveStore: true, recovery: true });
    },
    getRestore(identity, id, { ledgerEpoch } = {}) {
      ledgerEpochOf(ledgerEpoch); ensure(COMMAND_ID.test(id), '恢复任务号无效');
      return withAuthorized(identity, 'owner', async (client, user) => {
        requireFeature(user.entitlements, 'backup');
        const { rows: [row] } = await client.query('SELECT * FROM ledger_restore_receipts WHERE store_id=$1 AND task_id=$2 AND actor_id=$3 AND device_id=$4 AND target_epoch=$5', [user.store_id, id, user.id, user.device_id, ledgerEpoch]);
        if (!row) throw new ApiError(404, '未找到当前身份的恢复回执', 'RESTORE_NOT_FOUND'); return summaryResult(row);
      });
    }
  };
}
