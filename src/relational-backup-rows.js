import { DATA_LIMITS } from './data-limits.js';
import { parseCents } from './ledger-domain.js';
import { configurationInput, saleSnapshot } from './relational-sales.js';
import { TASK_BACKUP_TABLES } from './relational-task-result-tables.js';
import { COMMAND_ID, ENTITY_ID, memberInput } from './relational-contract.js';
import { TASK_TYPES } from './relational-tasks.js';
import { ledgerEpochOf } from './ledger-epoch.js';
import { BATCH_TABLES, batchCaptureChecks, nullableBatchColumn } from './relational-batches.js';
import { RESTORE_COLUMNS, validateRestoreReceipt } from './relational-restore.js';

// This is a logical external backup contract, not a JSON database. Only these
// relational columns may be restored; no SQL or credentials come from a file.
export const BACKUP_TABLES = {
  member_profiles: ['store_id', 'id', 'name', 'phone', 'notes', 'profile_version', 'created_at', 'updated_at', 'archived_at'],
  member_tags: ['store_id', 'member_id', 'tag'],
  member_accounts: ['store_id', 'member_id', 'balance_cents', 'version'],
  account_opening_batches: ['store_id', 'batch_id', 'source_digest', 'payload_digest', 'member_count', 'net_balance_cents', 'positive_balance_cents', 'negative_balance_cents', 'imported_at'],
  account_openings: ['store_id', 'member_id', 'batch_id', 'source_member_id', 'opening_balance_cents'],
  ledger_entries: ['store_id', 'entry_id', 'member_id', 'kind', 'account_version', 'delta_cents', 'balance_before_cents', 'balance_after_cents', 'actual_pay_cents', 'gift_cents', 'pay_method', 'items_summary', 'remark', 'actor_id', 'device_id', 'occurred_at'],
  ledger_reversals: ['store_id', 'original_entry_id', 'reversal_entry_id', 'reason'],
  command_receipts: ['store_id', 'command_id', 'request_hash', 'actor_id', 'device_id', 'member_id', 'kind', 'delta_cents', 'balance_before_cents', 'balance_after_cents', 'account_version', 'occurred_at', 'ledger_epoch'],
  local_command_configurations: ['store_id', 'command_id', 'version'],
  service_catalog: ['store_id', 'id', 'name', 'price_cents', 'position', 'active'],
  recharge_plan_items: ['store_id', 'id', 'pay_cents', 'gift_cents', 'position', 'active'],
  store_recharge_settings: ['store_id', 'version', 'gift_enabled', 'gift_rate_basis_points'],
  consumption_items: ['store_id', 'entry_id', 'position', 'service_id', 'name', 'quantity', 'unit_price_cents', 'line_total_cents'],
  payment_records: ['store_id', 'entry_id', 'position', 'method', 'amount_cents'],
  recharge_details: ['store_id', 'entry_id', 'configuration_version', 'plan_id', 'actual_pay_cents', 'gift_cents', 'gift_enabled', 'gift_rate_basis_points'],
  ...TASK_BACKUP_TABLES,
  ...BATCH_TABLES,
  local_restore_receipts: RESTORE_COLUMNS,
  local_audit: ['id', 'store_id', 'actor_id', 'device_id', 'event', 'entity_id', 'occurred_at']
};
const nullable = new Set(['archived_at', 'source_member_id', 'service_id', 'plan_id']);
const integerColumns = new Set(['id:local_audit', 'profile_version', 'version', 'member_count', 'account_version', 'position', 'active', 'quantity', 'gift_enabled', 'gift_rate_basis_points', 'configuration_version', 'item_count', 'tags_present', 'expected_version']);
const fail = message => Object.assign(new Error(message), { status: 400, code: 'BACKUP_INVALID' });
export function backupEnsure(value, message) { if (!value) throw fail(message); }
export function backupTime(value) { return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
export function memberAuditMatches(member, opening, count) {
  const archived = count('member_archived'), reactivated = count('member_reactivated');
  return count('member_created') === (opening ? 0 : 1)
    && archived - reactivated === (member.archived_at ? 1 : 0)
    && String(count('member_updated') + archived + reactivated) === member.profile_version;
}
function index(rows, column) { const map = new Map(rows.map(row => [row[column], row])); backupEnsure(map.size === rows.length, '备份存在重复实体单号'); return map; }
function group(rows, column) { const result = new Map(); for (const row of rows) { if (!result.has(row[column])) result.set(row[column], []); result.get(row[column]).push(row); } return result; }
function details(rows, entryId) { return (rows.get(entryId) ?? []).sort((a, b) => Number(a.position) - Number(b.position)).map((row, position) => { backupEnsure(row.position === String(position), '成交明细位置不连续'); return row; }); }

export function validateBackupRow(table, row, storeId) {
  const columns = BACKUP_TABLES[table];
  backupEnsure(columns && row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length === columns.length && Object.keys(row).every(key => columns.includes(key)), '备份关系列不完整');
  backupEnsure(row.store_id === storeId, '备份包含其他门店记录');
  for (const column of columns) {
    const value = row[column]; if (value === null && (nullable.has(column) || nullableBatchColumn(table, column))) continue;
    backupEnsure(typeof value === 'string' && value.length <= 8192, '备份关系值必须是有界文本或精确整数文本');
    if (column.endsWith('_cents')) parseCents(value);
    if (integerColumns.has(column) || integerColumns.has(column + ':' + table)) backupEnsure(/^(0|[1-9][0-9]*)$/.test(value) && parseCents(value) >= 0n, '备份整数无效');
    if (column.endsWith('_at')) backupEnsure(backupTime(value), '备份时间须为规范 UTC 毫秒时间');
    if (column === 'ledger_epoch' || column.endsWith('_epoch')) ledgerEpochOf(value);
  }
}

export function validateBackupTables(tables, storeId, { requireCommandConfiguration = true } = {}) {
  backupEnsure(tables && typeof tables === 'object' && Object.keys(tables).length === Object.keys(BACKUP_TABLES).length, '备份关系表不完整');
  for (const [table, columns] of Object.entries(BACKUP_TABLES)) {
    const rows = tables[table]; backupEnsure(Array.isArray(rows) && rows.length <= 150000, '备份关系表数量无效');
    for (const row of rows) validateBackupRow(table, row, storeId);
  }
  const t = tables, members = index(t.member_profiles, 'id'), accounts = index(t.member_accounts, 'member_id');
  backupEnsure(members.size <= DATA_LIMITS.members && t.ledger_entries.length <= DATA_LIMITS.ledgers && members.size === accounts.size, '会员或账户数量不一致或超出容量');
  const memberIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;
  for (const row of members.values()) {
    backupEnsure(memberIdPattern.test(row.id) && row.name.trim() && row.name.length <= 128 && row.phone.length <= 64 && row.notes.length <= 2000 && accounts.has(row.id), '备份会员档案无效');
  }
  const tags = group(t.member_tags, 'member_id');
  for (const [memberId, rows] of tags) backupEnsure(members.has(memberId) && rows.length <= 32 && rows.every(row => row.tag.trim() && row.tag.length <= 128) && new Set(rows.map(row => row.tag)).size === rows.length, '备份会员标签无效');
  const openings = index(t.account_openings, 'member_id'), batches = index(t.account_opening_batches, 'batch_id');
  for (const row of openings.values()) backupEnsure(members.has(row.member_id) && batches.has(row.batch_id), '期初引用不存在');
  const byBatch = group(t.account_openings, 'batch_id');
  for (const row of batches.values()) {
    backupEnsure(/^[a-f0-9]{64}$/.test(row.source_digest) && /^[a-f0-9]{64}$/.test(row.payload_digest), '期初来源摘要无效');
    const rows = byBatch.get(row.batch_id) ?? []; let net = 0n, positive = 0n, negative = 0n;
    for (const opening of rows) { const amount = BigInt(opening.opening_balance_cents); net += amount; if (amount > 0n) positive += amount; if (amount < 0n) negative += amount; }
    backupEnsure(String(rows.length) === row.member_count && String(net) === row.net_balance_cents && String(positive) === row.positive_balance_cents && String(negative) === row.negative_balance_cents, '期初批次人数或金额分项不一致');
  }
  const entries = index(t.ledger_entries, 'entry_id'), byMember = group(t.ledger_entries, 'member_id');
  const originals = index(t.ledger_reversals, 'original_entry_id'), reversals = index(t.ledger_reversals, 'reversal_entry_id');
  for (const link of originals.values()) {
    const original = entries.get(link.original_entry_id), reversal = entries.get(link.reversal_entry_id);
    backupEnsure(original && reversal && original.kind !== 'reversal' && reversal.kind === 'reversal' && original.member_id === reversal.member_id && BigInt(original.delta_cents) === -BigInt(reversal.delta_cents) && BigInt(original.account_version) < BigInt(reversal.account_version), '冲正关系或金额无效');
  }
  for (const [memberId, rows] of byMember) backupEnsure(members.has(memberId), '流水引用的会员不存在');
  for (const [memberId, member] of members) {
    let balance = BigInt(openings.get(memberId)?.opening_balance_cents ?? '0'), version = 0n;
    for (const entry of (byMember.get(memberId) ?? []).sort((a, b) => BigInt(a.account_version) < BigInt(b.account_version) ? -1 : 1)) {
      version++;
      backupEnsure(/^[a-zA-Z0-9-]{16,80}$/.test(entry.entry_id) && ['recharge', 'consume', 'reversal'].includes(entry.kind) && entry.account_version === String(version), '流水类型、单号或连续版本无效');
      backupEnsure(BigInt(entry.delta_cents) !== 0n && entry.balance_before_cents === String(balance), '流水前余额或变化无效');
      balance += BigInt(entry.delta_cents); backupEnsure(entry.balance_after_cents === String(balance), '流水后余额无效');
      if (entry.kind === 'recharge') backupEnsure(BigInt(entry.actual_pay_cents) > 0n && BigInt(entry.gift_cents) >= 0n && BigInt(entry.delta_cents) === BigInt(entry.actual_pay_cents) + BigInt(entry.gift_cents), '充值金额无效');
      else backupEnsure(entry.actual_pay_cents === '0' && entry.gift_cents === '0' && (entry.kind === 'consume' ? BigInt(entry.delta_cents) < 0n : reversals.has(entry.entry_id)), '消费或冲正金额无效');
    }
    const account = accounts.get(memberId); backupEnsure(account.balance_cents === String(balance) && account.version === String(version) && (!member.archived_at || balance === 0n), '账户与期初及新流水不守恒');
  }
  const receipts = index(t.command_receipts, 'command_id'), versions = index(t.local_command_configurations, 'command_id');
  backupEnsure(receipts.size === entries.size, '完整本地原单必须有且只有一个回执');
  const audited = group(t.local_audit, 'entity_id');
  for (const [id, member] of members) {
    const counts = new Map();
    for (const row of audited.get(id) ?? []) counts.set(row.event, (counts.get(row.event) ?? 0) + 1);
    backupEnsure(memberAuditMatches(member, openings.has(id), event => counts.get(event) ?? 0), '会员资料版本与核心审计不完整');
  }
  index(t.local_restore_receipts, 'task_id');
  for (const row of t.local_restore_receipts) {
    validateRestoreReceipt(row, backupEnsure);
    backupEnsure((audited.get(row.task_id) ?? []).some(a => a.event === 'ledger_restored' && a.actor_id === row.actor_id && a.device_id === row.device_id), '恢复回执缺少核心审计');
  }
  backupEnsure(t.local_audit.filter(a => a.event === 'ledger_restored').length === t.local_restore_receipts.length, '恢复审计与回执数量不符');
  for (const [id, entry] of entries) {
    const receipt = receipts.get(id); backupEnsure(receipt && /^[a-f0-9]{64}$/.test(receipt.request_hash), '命令回执缺失或摘要无效');
    for (const column of ['member_id', 'kind', 'actor_id', 'device_id', 'delta_cents', 'balance_before_cents', 'balance_after_cents', 'account_version', 'occurred_at']) backupEnsure(receipt[column] === entry[column], '回执与原单不一致');
    backupEnsure((audited.get(id) ?? []).some(row => row.event === 'ledger_' + entry.kind && row.actor_id === entry.actor_id && row.device_id === entry.device_id), '原单缺少核心审计');
    if (requireCommandConfiguration) backupEnsure(entry.kind === 'reversal' ? !versions.has(id) : versions.has(id), '命令配置捕获缺失或多余');
  }
  for (const id of versions.keys()) backupEnsure(entries.has(id), '命令配置引用不存在的原单');
  const configuration = t.store_recharge_settings[0]; backupEnsure(t.store_recharge_settings.length <= 1, '门店配置重复');
  const currentVersion = configuration?.version ?? '0';
  for (const row of versions.values()) backupEnsure(BigInt(row.version) <= BigInt(currentVersion), '命令配置版本超过当前配置');
  configurationInput({ expectedVersion: currentVersion,
    services: t.service_catalog.filter(row => row.active === '1').sort((a, b) => Number(a.position) - Number(b.position)).map(row => ({ id: row.id, name: row.name, priceCents: row.price_cents })),
    rechargePlans: t.recharge_plan_items.filter(row => row.active === '1').sort((a, b) => Number(a.position) - Number(b.position)).map(row => ({ id: row.id, payCents: row.pay_cents, giftCents: row.gift_cents })),
    rechargeSettings: { giftEnabled: configuration ? configuration.gift_enabled === '1' : true, giftRateBasisPoints: configuration ? Number(configuration.gift_rate_basis_points) : 1000 } });
  const itemGroups = group(t.consumption_items, 'entry_id'), paymentGroups = group(t.payment_records, 'entry_id'), rechargeDetails = index(t.recharge_details, 'entry_id');
  for (const rows of [t.consumption_items, t.payment_records, t.recharge_details]) for (const row of rows) backupEnsure(entries.has(row.entry_id), '成交快照引用不存在的原单');
  for (const [id, entry] of entries) {
    const recharge = rechargeDetails.get(id);
    if (recharge) backupEnsure(BigInt(recharge.configuration_version) <= BigInt(currentVersion), '充值规则版本超过当前配置');
    saleSnapshot({ type: entry.kind, deltaCents: entry.delta_cents, actualPayCents: entry.actual_pay_cents, giftCents: entry.gift_cents,
      items: details(itemGroups, id).map(row => ({ serviceId: row.service_id, name: row.name, quantity: Number(row.quantity), unitPriceCents: row.unit_price_cents, lineTotalCents: row.line_total_cents })),
      payments: details(paymentGroups, id).map(row => ({ method: row.method, amountCents: row.amount_cents })),
      recharge: recharge ? { configurationVersion: recharge.configuration_version, planId: recharge.plan_id, actualPayCents: recharge.actual_pay_cents, giftCents: recharge.gift_cents, giftEnabled: recharge.gift_enabled === '1', giftRateBasisPoints: Number(recharge.gift_rate_basis_points) } : null });
    if (recharge && requireCommandConfiguration) backupEnsure(recharge.configuration_version === versions.get(id)?.version, '充值规则快照与命令捕获不一致');
  }
  validateTaskResults(t, { members, accounts, entries, openings, audited, currentVersion });
  batchCaptureChecks(t, storeId, backupEnsure);
  return { memberCount: members.size, entryCount: entries.size, receiptCount: receipts.size };
}

export function validateTaskResults(t, { members, accounts, entries, openings, audited, currentVersion, wasArchived = id => (audited.get(id) ?? []).some(row => row.event === 'member_archived') }) {
  const receipts = index(t.local_task_receipts, 'task_id'), profiles = index(t.task_member_results, 'task_id'), configurations = index(t.task_configuration_results, 'task_id');
  const tags = group(t.task_member_tags, 'task_id'), services = group(t.task_configuration_services, 'task_id'), plans = group(t.task_configuration_plans, 'task_id');
  const balances = new Map([...entries.values()].map(row => [JSON.stringify([row.member_id, row.account_version]), row.balance_after_cents]));
  for (const [table, rows] of Object.entries(TASK_BACKUP_TABLES)) {
    if (table !== 'local_task_receipts') for (const row of t[table]) backupEnsure(receipts.has(row.task_id), '任务结果缺少回执');
  }
  for (const [id, receipt] of receipts) {
    backupEnsure(COMMAND_ID.test(id) && /^[a-f0-9]{64}$/.test(receipt.request_hash) && ENTITY_ID.test(receipt.actor_id) && COMMAND_ID.test(receipt.device_id) && TASK_TYPES.includes(receipt.task_type), '任务标识或归属无效');
    backupEnsure((audited.get(id) ?? []).some(row => row.event === 'task_completed' && row.actor_id === receipt.actor_id && row.device_id === receipt.device_id), '任务缺少核心审计');
    const profile = profiles.get(id), settings = configurations.get(id), memberTask = ['member.create', 'member.update'].includes(receipt.task_type);
    backupEnsure(memberTask === !!profile && (receipt.task_type === 'configuration.update') === !!settings, '任务结果类型或快照不完整');
    if (profile) {
      const current = members.get(profile.member_id), account = accounts.get(profile.member_id), snapshotTags = (tags.get(id) ?? []).map(row => row.tag);
      memberInput({ name: profile.name, phone: profile.phone, notes: profile.notes, tags: snapshotTags });
      backupEnsure(current && receipt.entity_id === profile.member_id && BigInt(current.profile_version) >= BigInt(profile.profile_version) && BigInt(account.version) >= BigInt(profile.account_version) && current.created_at === profile.created_at && profile.archived_at === null, '任务会员快照版本或归属无效');
      const balance = profile.account_version === '0' ? openings.get(profile.member_id)?.opening_balance_cents ?? '0' : balances.get(JSON.stringify([profile.member_id, profile.account_version]));
      backupEnsure(profile.balance_cents === balance, '任务会员结果余额与账户历史不符');
      if (receipt.task_type === 'member.create') backupEnsure(profile.profile_version === '0' && profile.account_version === '0' && profile.balance_cents === '0', '创建任务结果无效');
    } else backupEnsure(!tags.has(id), '非会员任务包含会员标签');
    if (settings) {
      backupEnsure(receipt.entity_id === 'store' && BigInt(settings.version) > 0n && BigInt(settings.version) <= BigInt(currentVersion), '任务配置版本无效');
      configurationInput({ expectedVersion: settings.version,
        services: details(services, id).map(row => ({ id: row.id, name: row.name, priceCents: row.price_cents })),
        rechargePlans: details(plans, id).map(row => ({ id: row.id, payCents: row.pay_cents, giftCents: row.gift_cents })),
        rechargeSettings: { giftEnabled: settings.gift_enabled === '1', giftRateBasisPoints: Number(settings.gift_rate_basis_points) } });
    } else backupEnsure(!services.has(id) && !plans.has(id), '非配置任务包含配置明细');
    if (receipt.task_type === 'member.archive') backupEnsure(members.has(receipt.entity_id) && wasArchived(receipt.entity_id), '归档任务缺少会员归档记录');
  }
}

