import { BACKUP_TABLES, validateBackupRow, validateTaskResults, memberAuditMatches, backupEnsure as ensure } from './relational-backup-rows.js';
import { TASK_BACKUP_TABLES } from './relational-task-result-tables.js';
import { BATCH_TABLES, batchCaptureChecks } from './relational-batches.js';
import { canonicalJSON } from './canonical-json.js';
import { memberInput, COMMAND_ID, ENTITY_ID } from './relational-contract.js';
import { parseCents } from './ledger-domain.js';
import { configurationInput, saleSnapshot } from './relational-sales.js';
import { ARCHIVE_LIMITS } from './relational-archive.js';
import { validateRestoreReceipt } from './relational-restore.js';

// No result set crosses the native 1,000-row bridge limit. A collected relation
// is bounded by a domain limit (one task/batch or 64 financial entries), never
// by the total store size. Run against a single consistent SQLite snapshot.
export function sqliteArchiveReader({ all, storeId, checkpoint = async () => {} }) {
  async function* pages(table, where = '', params = [], size = 200) {
    ensure(Object.hasOwn(BACKUP_TABLES, table) && Number.isInteger(size) && size >= 1 && size <= 500, '备份表或分页不在白名单范围'); let after = null;
    for (;;) {
      // Whole-table scans seek the integer rowid directly. A store_id index
      // followed by a rowid sort can rescan the entire history for every page.
      // Domain-group lookups retain their (store_id, task/member/entry) index.
      const result = await all('SELECT rowid AS __rowid,' + BACKUP_TABLES[table].join(',') + ' FROM ' + table + (!where ? ' NOT INDEXED' : '') + ' WHERE store_id=?' + where +
        (after === null ? '' : ' AND rowid>CAST(? AS INTEGER)') + ' ORDER BY rowid LIMIT ' + size, [storeId, ...params, ...(after === null ? [] : [after])]);
      const rows = result.map(({ __rowid, ...row }) => { after = String(__rowid); return row; });
      await checkpoint(); if (rows.length) yield rows; if (rows.length < size) break;
    }
  }
  async function collect(table, where, params, maximum) {
    const rows = [];
    for await (const page of pages(table, where, params)) { rows.push(...page); ensure(rows.length <= maximum, '备份关联记录超出领域上限'); }
    return rows;
  }
  async function byIds(table, column, ids, maximum) {
    const result = [];
    for (let at = 0; at < ids.length; at += 100) {
      const group = ids.slice(at, at + 100), rows = await collect(table, ' AND ' + column + ' IN (' + group.map(() => '?').join(',') + ')', group, maximum);
      result.push(...rows); ensure(result.length <= maximum, '备份关联记录超出领域上限');
    }
    return result;
  }
  return { pages, collect, byIds };
}
const map = (rows, column) => new Map(rows.map(row => [row[column], row]));
function groups(rows, column) { const result = new Map(); for (const row of rows) { if (!result.has(row[column])) result.set(row[column], []); result.get(row[column]).push(row); } return result; }
function positions(rows = []) {
  return [...rows].sort((a, b) => Number(a.position) - Number(b.position)).map((row, index) => { ensure(row.position === String(index), '成交或任务明细位置不连续'); return row; });
}
export async function validateSqliteArchiveDatabase({ all, storeId, hash, checkpoint = async () => {} }) {
  const reader = sqliteArchiveReader({ all, storeId, checkpoint }), one = async (sql, p = []) => (await all(sql, p))[0], counts = {};
  let total = 0;
  for (const table of Object.keys(BACKUP_TABLES)) {
    ensure(!await one('SELECT 1 AS present FROM ' + table + ' WHERE store_id<>? LIMIT 1', [storeId]), '数据库包含其他门店业务');
    const count = Number((await one('SELECT count(*) AS n FROM ' + table + ' WHERE store_id=?', [storeId])).n); counts[table] = count;
    ensure(count <= ARCHIVE_LIMITS.tableRows && (total += count) <= ARCHIVE_LIMITS.totalRows, '数据库超出流式备份记录容量');
    for await (const page of reader.pages(table)) for (const row of page) validateBackupRow(table, row, storeId);
  }
  // Invalid databases fail here (including >1,000 violations); a valid result
  // is empty and does not materialize any business collection.
  ensure((await all('PRAGMA foreign_key_check')).length === 0, '备份数据库存在失效外键');
  ensure(counts.member_profiles === counts.member_accounts && counts.ledger_entries === counts.command_receipts, '会员账户或原单回执数量不一致');
  for (const table of ['sync_outbox', 'replica_reversal_links', 'entry_confirmations']) ensure(!await one('SELECT 1 AS present FROM ' + table + ' LIMIT 1'), '独立账本含未核对的云端同步状态');
  ensure(!await one("SELECT 1 AS present FROM ledger_entries e WHERE e.store_id=? AND NOT EXISTS(SELECT 1 FROM local_audit a WHERE a.store_id=e.store_id AND a.entity_id=e.entry_id AND a.event='ledger_'||e.kind AND a.actor_id=e.actor_id AND a.device_id=e.device_id) LIMIT 1", [storeId]), '资金原单缺少同身份核心审计');
  ensure(!await one('SELECT 1 AS present FROM member_accounts a WHERE a.store_id=? AND NOT EXISTS(SELECT 1 FROM member_profiles m WHERE m.store_id=a.store_id AND m.id=a.member_id) LIMIT 1', [storeId]), '账户缺少会员档案');
  ensure(!await one('SELECT 1 AS present FROM account_openings a WHERE a.store_id=? AND NOT EXISTS(SELECT 1 FROM account_opening_batches b WHERE b.store_id=a.store_id AND b.batch_id=a.batch_id) LIMIT 1', [storeId]), '期初引用不存在的批次');
  ensure(Number((await one("SELECT count(*) AS n FROM local_audit WHERE store_id=? AND event='ledger_restored'", [storeId])).n) === counts.local_restore_receipts, '恢复回执与审计数量不符');
  for await (const page of reader.pages('local_restore_receipts')) for (const receipt of page) {
    validateRestoreReceipt(receipt, ensure);
    ensure(await one("SELECT 1 AS present FROM local_audit WHERE store_id=? AND event='ledger_restored' AND entity_id=? AND actor_id=? AND device_id=? LIMIT 1", [storeId, receipt.task_id, receipt.actor_id, receipt.device_id]), '恢复回执缺少核心审计');
  }
  const settings = (await reader.collect('store_recharge_settings', '', [], 1))[0], currentVersion = settings?.version ?? '0';
  const services = await reader.collect('service_catalog', ' AND active=1', [], 500), plans = await reader.collect('recharge_plan_items', ' AND active=1', [], 200);
  configurationInput({ expectedVersion: currentVersion,
    services: services.sort((a, b) => Number(a.position) - Number(b.position)).map(row => ({ id: row.id, name: row.name, priceCents: row.price_cents })),
    rechargePlans: plans.sort((a, b) => Number(a.position) - Number(b.position)).map(row => ({ id: row.id, payCents: row.pay_cents, giftCents: row.gift_cents })),
    rechargeSettings: { giftEnabled: settings ? settings.gift_enabled === '1' : true, giftRateBasisPoints: settings ? Number(settings.gift_rate_basis_points) : 1000 } });
  for await (const page of reader.pages('account_opening_batches')) for (const batch of page) {
    ensure(COMMAND_ID.test(batch.batch_id) && /^[a-f0-9]{64}$/.test(batch.source_digest) && /^[a-f0-9]{64}$/.test(batch.payload_digest), '期初批次单号或摘要无效');
    let n = 0, net = 0n, positive = 0n, negative = 0n;
    for await (const rows of reader.pages('account_openings', ' AND batch_id=?', [batch.batch_id])) for (const row of rows) {
      const amount = BigInt(row.opening_balance_cents); n++; net += amount; if (amount > 0n) positive += amount; if (amount < 0n) negative += amount;
    }
    ensure(String(n) === batch.member_count && String(net) === batch.net_balance_cents && String(positive) === batch.positive_balance_cents && String(negative) === batch.negative_balance_cents, '期初批次人数或金额分项不一致');
  }
  for await (const page of reader.pages('ledger_reversals')) for (const link of page) {
    const original = await one('SELECT * FROM ledger_entries WHERE store_id=? AND entry_id=?', [storeId, link.original_entry_id]), reversal = await one('SELECT * FROM ledger_entries WHERE store_id=? AND entry_id=?', [storeId, link.reversal_entry_id]);
    ensure(original && reversal && original.kind !== 'reversal' && reversal.kind === 'reversal' && original.member_id === reversal.member_id && BigInt(original.delta_cents) === -BigInt(reversal.delta_cents) && BigInt(original.account_version) < BigInt(reversal.account_version), '冲正关系或金额无效');
  }
  for await (const page of reader.pages('member_profiles')) for (const member of page) {
    ensure(ENTITY_ID.test(member.id), '会员标识无效');
    const tags = await reader.collect('member_tags', ' AND member_id=?', [member.id], 32); memberInput({ name: member.name, phone: member.phone, notes: member.notes, tags: tags.map(row => row.tag) });
    const account = await one('SELECT * FROM member_accounts WHERE store_id=? AND member_id=?', [storeId, member.id]), opening = await one('SELECT opening_balance_cents FROM account_openings WHERE store_id=? AND member_id=?', [storeId, member.id]);
    ensure(account, '会员缺少资金账户'); let balance = BigInt(opening?.opening_balance_cents ?? '0'), version = 0n;
    const profileEvents = await all("SELECT event,count(*) AS n FROM local_audit WHERE store_id=? AND entity_id=? AND event IN ('member_created','member_updated','member_archived','member_reactivated') GROUP BY event", [storeId, member.id]);
    const profileCounts = new Map(profileEvents.map(row => [row.event, Number(row.n)]));
    ensure(memberAuditMatches(member, opening, event => profileCounts.get(event) ?? 0), '会员资料版本与核心审计不完整');
    for (;;) {
      const entries = await all('SELECT * FROM ledger_entries WHERE store_id=? AND member_id=? AND account_version>CAST(? AS INTEGER) ORDER BY account_version LIMIT 64', [storeId, member.id, String(version)]);
      if (!entries.length) break;
      const ids = entries.map(row => row.entry_id), receipts = map(await reader.byIds('command_receipts', 'command_id', ids, 64), 'command_id');
      const configurations = map(await reader.byIds('local_command_configurations', 'command_id', ids, 64), 'command_id');
      const items = groups(await reader.byIds('consumption_items', 'entry_id', ids, 6400), 'entry_id'), payments = groups(await reader.byIds('payment_records', 'entry_id', ids, 1024), 'entry_id');
      const recharge = map(await reader.byIds('recharge_details', 'entry_id', ids, 64), 'entry_id'), reversals = map(await reader.byIds('ledger_reversals', 'reversal_entry_id', ids, 64), 'reversal_entry_id');
      for (const entry of entries) {
        version++;
        ensure(COMMAND_ID.test(entry.entry_id) && ENTITY_ID.test(entry.actor_id) && COMMAND_ID.test(entry.device_id) && ['recharge', 'consume', 'reversal'].includes(entry.kind) && entry.account_version === String(version), '流水标识、类型或连续版本无效');
        ensure(entry.balance_before_cents === String(balance) && BigInt(entry.delta_cents) !== 0n, '流水前余额或变化无效'); balance += BigInt(entry.delta_cents); parseCents(String(balance));
        ensure(entry.balance_after_cents === String(balance), '流水后余额不守恒');
        ensure(entry.kind === 'recharge' ? BigInt(entry.actual_pay_cents) > 0n && BigInt(entry.gift_cents) >= 0n && BigInt(entry.delta_cents) === BigInt(entry.actual_pay_cents) + BigInt(entry.gift_cents) : entry.actual_pay_cents === '0' && entry.gift_cents === '0' && (entry.kind === 'consume' ? BigInt(entry.delta_cents) < 0n : reversals.has(entry.entry_id)), '充值、消费或冲正金额无效');
        const receipt = receipts.get(entry.entry_id), configuration = configurations.get(entry.entry_id), rule = recharge.get(entry.entry_id);
        ensure(receipt && /^[a-f0-9]{64}$/.test(receipt.request_hash), '命令回执缺失或摘要无效');
        for (const column of ['member_id', 'kind', 'actor_id', 'device_id', 'delta_cents', 'balance_before_cents', 'balance_after_cents', 'account_version', 'occurred_at']) ensure(receipt[column] === entry[column], '回执与原单不一致');
        ensure(entry.kind === 'reversal' ? !configuration : configuration && BigInt(configuration.version) <= BigInt(currentVersion), '命令配置版本缺失、多余或超前');
        if (rule) ensure(BigInt(rule.configuration_version) <= BigInt(currentVersion) && rule.configuration_version === configuration?.version, '充值规则版本与命令捕获不一致');
        saleSnapshot({ type: entry.kind, deltaCents: entry.delta_cents, actualPayCents: entry.actual_pay_cents, giftCents: entry.gift_cents,
          items: positions(items.get(entry.entry_id)).map(row => ({ serviceId: row.service_id, name: row.name, quantity: Number(row.quantity), unitPriceCents: row.unit_price_cents, lineTotalCents: row.line_total_cents })),
          payments: positions(payments.get(entry.entry_id)).map(row => ({ method: row.method, amountCents: row.amount_cents })),
          recharge: rule ? { configurationVersion: rule.configuration_version, planId: rule.plan_id, actualPayCents: rule.actual_pay_cents, giftCents: rule.gift_cents, giftEnabled: rule.gift_enabled === '1', giftRateBasisPoints: Number(rule.gift_rate_basis_points) } : null });
      }
      await checkpoint();
    }
    ensure(account.balance_cents === String(balance) && account.version === String(version) && (!member.archived_at || balance === 0n), '账户与完整历史不守恒');
  }
  for await (const page of reader.pages('local_task_receipts')) for (const receipt of page) {
    const t = Object.fromEntries(Object.keys(TASK_BACKUP_TABLES).map(table => [table, []])); t.local_task_receipts.push(receipt);
    for (const table of Object.keys(TASK_BACKUP_TABLES).filter(name => name !== 'local_task_receipts')) t[table] = await reader.collect(table, ' AND task_id=?', [receipt.task_id], table.endsWith('_services') ? 500 : table.endsWith('_plans') ? 200 : table.endsWith('_tags') ? 32 : 1);
    const profile = t.task_member_results[0], memberId = profile?.member_id ?? (receipt.task_type === 'member.archive' ? receipt.entity_id : null);
    const members = memberId ? await reader.collect('member_profiles', ' AND id=?', [memberId], 1) : [], accounts = memberId ? await reader.collect('member_accounts', ' AND member_id=?', [memberId], 1) : [];
    const openings = memberId ? await reader.collect('account_openings', ' AND member_id=?', [memberId], 1) : [], entries = profile && profile.account_version !== '0' ? await reader.collect('ledger_entries', ' AND member_id=? AND account_version=?', [memberId, profile.account_version], 1) : [];
    const audits = await all("SELECT actor_id,device_id,event FROM local_audit WHERE store_id=? AND entity_id=? AND event='task_completed' AND actor_id=? AND device_id=? LIMIT 1", [storeId, receipt.task_id, receipt.actor_id, receipt.device_id]);
    const wasArchived = receipt.task_type === 'member.archive' && await one("SELECT 1 AS present FROM local_audit WHERE store_id=? AND entity_id=? AND event='member_archived' LIMIT 1", [storeId, memberId]);
    validateTaskResults(t, { members: map(members, 'id'), accounts: map(accounts, 'member_id'), openings: map(openings, 'member_id'), entries: map(entries, 'entry_id'), audited: new Map([[receipt.task_id, audits]]), currentVersion, wasArchived: () => wasArchived });
  }
  for await (const page of reader.pages('application_batches')) for (const batch of page) {
    const t = Object.fromEntries(Object.keys(BATCH_TABLES).map(table => [table, []])); t.application_batches.push(batch);
    t.application_batch_controls = await reader.collect('application_batch_controls', ' AND batch_id=?', [batch.batch_id], 1);
    t.application_batch_items = await reader.collect('application_batch_items', ' AND batch_id=?', [batch.batch_id], 500);
    const ids = t.application_batch_items.map(row => row.task_id); t.application_batch_tags = await reader.byIds('application_batch_tags', 'task_id', ids, 16000);
    t.local_task_receipts = await reader.byIds('local_task_receipts', 'task_id', ids, 500); t.local_audit = [];
    const rows = await all("SELECT event,count(*) AS n FROM local_audit WHERE store_id=? AND entity_id=? AND actor_id=? AND device_id=? AND event IN ('batch_captured','batch_controlled') GROUP BY event", [storeId, batch.batch_id, batch.actor_id, batch.device_id]);
    const events = new Map(rows.map(row => [row.event, String(row.n)])), auditCounts = new Map([[canonicalJSON([batch.batch_id, batch.actor_id, batch.device_id]), { captured: events.get('batch_captured') ?? '0', controlled: events.get('batch_controlled') ?? '0' }]]);
    for (const check of batchCaptureChecks(t, storeId, ensure, { auditCounts })) ensure(await hash(canonicalJSON(check.value)) === check.hash, '批次原始捕获摘要不匹配');
  }
  return { memberCount: counts.member_profiles, entryCount: counts.ledger_entries, receiptCount: counts.command_receipts, rowCounts: counts };
}
