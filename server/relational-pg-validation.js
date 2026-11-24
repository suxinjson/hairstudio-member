import { PG_BACKUP_TABLES, PG_AUDIT_FILTER, logicalTables, validatePostgresRow } from './relational-backup.js';
import { postgresArchiveReader, pgProjection } from './relational-pg-reader.js';
import { BACKUP_TABLES, validateBackupRow, validateTaskResults, memberAuditMatches, backupEnsure as ensure } from '../src/relational-backup-rows.js';
import { ARCHIVE_LIMITS } from '../src/relational-archive.js';
import { BATCH_TABLES, batchCaptureChecks } from '../src/relational-batches.js';
import { canonicalJSON } from '../src/canonical-json.js';
import { parseCents } from '../src/ledger-domain.js';
import { memberInput, COMMAND_ID, ENTITY_ID, versionOf } from '../src/relational-contract.js';
import { configurationInput, saleSnapshot } from '../src/relational-sales.js';
import { validateRestoreReceipt } from '../src/relational-restore.js';

const empty = () => Object.fromEntries(Object.keys(PG_BACKUP_TABLES).map(table => [table, []]));
const map = (rows, column) => new Map(rows.map(row => [row[column], row]));
const logical = (table, rows) => logicalTables({ ...empty(), [table]: rows });
function groups(rows, column) { const result = new Map(); for (const row of rows) { if (!result.has(row[column])) result.set(row[column], []); result.get(row[column]).push(row); } return result; }
function positions(rows = []) { return [...rows].sort((a, b) => Number(a.position) - Number(b.position)).map((row, index) => { ensure(row.position === String(index), '成交明细位置不连续'); return row; }); }
const entity = "COALESCE(details->>'commandId',details->>'taskId',details->>'memberId',details->>'batchId','store')";
const fundEvents = "('ledger_recharge','ledger_consume','ledger_reversal')";
const memberEvents = ['member_created', 'member_updated', 'member_archived', 'member_reactivated'];

// Only bounded pages/domain groups cross the PG connection. Aggregates run in
// PG; no temporary tables, SQLite mirrors, local files or store-sized JS maps.
// Invoke within the export snapshot or the uncommitted recovery transaction.
export async function validatePostgresArchiveDatabase({ client, storeId, hash, checkpoint = async () => {} }) {
  const reader = postgresArchiveReader({ client, storeId, checkpoint }), counts = {};
  const query = async (sql, params = []) => { const { rows } = await client.query(sql, params); await checkpoint(); return rows; };
  const one = async (sql, params = []) => (await query(sql, params))[0];
  const auditRows = (event, id, maximum = 2) => reader.collect('audit_events', ' AND event=$2 AND ' + entity + '=$3', [event, id], maximum);
  const countAudit = async (event, id) => Number((await one('SELECT count(*)::text AS n FROM audit_events WHERE store_id=$1 AND event=$2 AND ' + entity + '=$3', [storeId, event, id])).n);
  let total = 0;
  for (const table of Object.keys(PG_BACKUP_TABLES)) {
    let count = 0;
    if (table === 'actors') { for await (const rows of reader.scan(table)) { for (const row of rows) validatePostgresRow(table, row, storeId); count += rows.length; } }
    else {
      count = Number((await one('SELECT count(*)::text AS n FROM ' + table + ' WHERE store_id=$1' + (table === 'audit_events' ? PG_AUDIT_FILTER : ''), [storeId])).n);
      for await (const rows of reader.scan(table)) {
        for (const row of rows) validatePostgresRow(table, row, storeId);
        if (!['ledger_command_receipts', 'store_changes', 'store_change_heads'].includes(table)) {
          const translated = logical(table, rows);
          for (const [name, values] of Object.entries(translated)) for (const row of values) validateBackupRow(name, row, storeId);
        }
      }
    }
    counts[table] = count;
    ensure(count <= ARCHIVE_LIMITS.tableRows && (total += count) <= ARCHIVE_LIMITS.totalRows, '数据库超出流式备份记录容量');
  }
  const actorSummary = await reader.actorDigest(); ensure(actorSummary.count === counts.actors, '操作人引用不完整');
  // Exact counts plus the matches required below prove a receipt and audit
  // bijection. An orphan cannot stand in for a missing match.
  ensure(counts.member_profiles === counts.member_accounts && counts.ledger_entries === counts.ledger_command_receipts, '账户或资金回执数量不完整');
  ensure(Number((await one('SELECT count(*)::text AS n FROM audit_events WHERE store_id=$1 AND event IN ' + fundEvents, [storeId])).n) === counts.ledger_entries, '资金核心审计数量不完整');
  ensure(Number((await one("SELECT count(*)::text AS n FROM audit_events WHERE store_id=$1 AND event='task_completed'", [storeId])).n) === counts.application_task_receipts, '任务核心审计数量不完整');
  // A rolled-back preview can leave table statistics describing an empty
  // store. Full joins reconcile both sides without repeated store scans from
  // a nested-loop plan. JSON values are compared without coercing their types.
  ensure(!await one('SELECT 1 FROM (SELECT * FROM ledger_entries WHERE store_id=$1) e' +
    ' FULL JOIN (SELECT event,details,user_id,device_id FROM audit_events WHERE store_id=$1 AND event IN ' + fundEvents + ') a' +
    " ON e.entry_id=a.details->>'commandId' WHERE e.entry_id IS NULL OR a.details IS NULL OR a.event IS DISTINCT FROM 'ledger_'||e.kind" +
    " OR a.user_id IS DISTINCT FROM e.actor_id OR a.device_id IS DISTINCT FROM e.device_id OR a.details->'entryId' IS DISTINCT FROM to_jsonb(e.entry_id)" +
    " OR a.details->'memberId' IS DISTINCT FROM to_jsonb(e.member_id) LIMIT 1", [storeId]), '资金核心审计缺失、重复或与原单不一致');
  for await (const rows of reader.scanQuery('member_audit', 'SELECT m.id,m.profile_version::text,m.archived_at IS NOT NULL AS archived_at,' +
    ' o.member_id IS NOT NULL AS opening,' + memberEvents.map(event => 'g.' + event).join(',') +
    ' FROM (SELECT id,profile_version,archived_at FROM member_profiles WHERE store_id=$1) m' +
    " FULL JOIN (SELECT details->>'memberId' AS id," + memberEvents.map(event => "count(*) FILTER(WHERE event='" + event + "')::text AS " + event).join(',') +
    " FROM audit_events WHERE store_id=$1 AND event IN ('" + memberEvents.join("','") + "') GROUP BY 1) g ON g.id=m.id" +
    ' LEFT JOIN account_openings o ON o.store_id=$1 AND o.member_id=m.id')) for (const member of rows) {
    ensure(member.id && memberAuditMatches(member, member.opening, event => Number(member[event])), '会员资料版本与核心审计不完整');
  }
  const settings = (await reader.collect('store_recharge_settings', '', [], 1))[0], currentVersion = settings?.version ?? '0'; versionOf(currentVersion);
  const services = await reader.collect('service_catalog', ' AND active=true', [], 500), plans = await reader.collect('recharge_plan_items', ' AND active=true', [], 200);
  for await (const rows of reader.scan('service_catalog')) for (const row of rows) versionOf(row.version);
  configurationInput({ expectedVersion: currentVersion,
    services: services.sort((a, b) => Number(a.position) - Number(b.position)).map(row => ({ id: row.id, name: row.name, priceCents: row.price_cents })),
    rechargePlans: plans.sort((a, b) => Number(a.position) - Number(b.position)).map(row => ({ id: row.id, payCents: row.pay_cents, giftCents: row.gift_cents })),
    rechargeSettings: { giftEnabled: settings ? settings.gift_enabled === 'true' : true, giftRateBasisPoints: settings ? Number(settings.gift_rate_basis_points) : 1000 } });
  ensure(String(await countAudit('configuration_updated', 'store')) === currentVersion, '配置版本与核心审计不完整');
  const head = (await reader.collect('store_change_heads', '', [], 1))[0]?.head ?? '0'; versionOf(head);
  const bounds = await one('SELECT min(cursor)::text AS lo,max(cursor)::text AS hi,count(*)::text AS n FROM store_changes WHERE store_id=$1', [storeId]);
  ensure(bounds.n === head && (head === '0' || bounds.lo === '1' && bounds.hi === head), '同步水位或变更不连续');
  ensure(!await one("SELECT 1 FROM store_changes c WHERE c.store_id=$1 AND NOT ((entity_type='member' AND change_type IN ('upsert','archive') AND EXISTS(SELECT 1 FROM member_profiles m WHERE m.store_id=c.store_id AND m.id=c.entity_id)) OR (entity_type='ledger' AND change_type='upsert' AND EXISTS(SELECT 1 FROM ledger_entries e WHERE e.store_id=c.store_id AND e.entry_id=c.entity_id)) OR (entity_type='configuration' AND entity_id='store' AND change_type='upsert')) LIMIT 1", [storeId]), '同步变更引用无效');
  for await (const rows of reader.scan('account_opening_batches')) for (const batch of rows) {
    ensure(COMMAND_ID.test(batch.batch_id), '期初批次单号无效');
    const sums = await one('SELECT count(*)::text AS n,COALESCE(sum(opening_balance_cents::numeric),0)::text AS net,COALESCE(sum(CASE WHEN opening_balance_cents>0 THEN opening_balance_cents::numeric ELSE 0 END),0)::text AS positive,COALESCE(sum(CASE WHEN opening_balance_cents<0 THEN opening_balance_cents::numeric ELSE 0 END),0)::text AS negative FROM account_openings WHERE store_id=$1 AND batch_id=$2', [storeId, batch.batch_id]);
    ensure(sums.n === batch.member_count && sums.net === batch.net_balance_cents && sums.positive === batch.positive_balance_cents && sums.negative === batch.negative_balance_cents && await countAudit('account_opening_imported', batch.batch_id) === 1, '期初批次人数、金额或审计不完整');
  }
  for await (const rows of reader.scan('ledger_reversals')) for (const link of rows) {
    const entries = map(await reader.byIds('ledger_entries', 'entry_id', [link.original_entry_id, link.reversal_entry_id], 2), 'entry_id');
    const original = entries.get(link.original_entry_id), reversal = entries.get(link.reversal_entry_id);
    ensure(original && reversal && original.kind !== 'reversal' && reversal.kind === 'reversal' && original.member_id === reversal.member_id && BigInt(original.delta_cents) === -BigInt(reversal.delta_cents) && BigInt(original.account_version) < BigInt(reversal.account_version), '冲正关系或金额无效');
  }
  for await (const rows of reader.scan('member_profiles')) for (const member of rows) {
    ensure(ENTITY_ID.test(member.id) && member.phone_normalized === member.phone.replace(/[^0-9+]/g, ''), '会员标识或电话检索字段无效');
    const tags = await reader.collect('member_tags', ' AND member_id=$2', [member.id], 32); memberInput({ name: member.name, phone: member.phone, notes: member.notes, tags: tags.map(row => row.tag) });
    const account = (await reader.collect('member_accounts', ' AND member_id=$2', [member.id], 1))[0], opening = (await reader.collect('account_openings', ' AND member_id=$2', [member.id], 1))[0];
    ensure(account, '会员缺少资金账户');
    let balance = BigInt(opening?.opening_balance_cents ?? '0'), version = 0n;
    for (;;) {
      // The archive projection renders account_version as text. Traverse the
      // underlying BIGINT so each page follows the account's commit order.
      const entries = await query('SELECT ' + pgProjection('ledger_entries') + ' FROM ledger_entries WHERE store_id=$1 AND member_id=$2 ' +
        'AND ledger_entries.account_version>$3::bigint ORDER BY ledger_entries.account_version LIMIT 64', [storeId, member.id, String(version)]);
      if (!entries.length) break;
      const ids = entries.map(row => row.entry_id), receipts = await reader.byIds('ledger_command_receipts', 'command_id', ids, 64);
      const cursors = receipts.flatMap(row => { const result = JSON.parse(row.result); versionOf(result.cursor); return [result.cursor, String(BigInt(result.cursor) - 1n)]; });
      // Bind the complete primary key per cursor. An ANY + ORDER BY query can
      // scan the unrelated entity index under stale empty-target statistics.
      const changes = cursors.length ? await query('SELECT matched.* FROM unnest($2::bigint[]) AS wanted(cursor)' +
        ' CROSS JOIN LATERAL (SELECT ' + pgProjection('store_changes') + ' FROM store_changes' +
        ' WHERE store_id=$1 AND store_changes.cursor=wanted.cursor LIMIT 1) AS matched', [storeId, [...new Set(cursors)]]) : [];
      const translated = logicalTables({ ...empty(), ledger_entries: entries, ledger_command_receipts: receipts, store_changes: changes });
      const originalReceipts = map(translated.command_receipts, 'command_id');
      const items = groups(await reader.byIds('consumption_items', 'entry_id', ids, 6400), 'entry_id'), payments = groups(await reader.byIds('payment_records', 'entry_id', ids, 1024), 'entry_id');
      const recharge = map(await reader.byIds('recharge_details', 'entry_id', ids, 64), 'entry_id'), reversals = map(await reader.byIds('ledger_reversals', 'reversal_entry_id', ids, 64), 'reversal_entry_id');
      for (const entry of translated.ledger_entries) {
        version++;
        ensure(COMMAND_ID.test(entry.entry_id) && ENTITY_ID.test(entry.actor_id) && COMMAND_ID.test(entry.device_id) && ['recharge', 'consume', 'reversal'].includes(entry.kind) && entry.account_version === String(version), '流水标识、类型或连续版本无效');
        ensure(entry.balance_before_cents === String(balance) && BigInt(entry.delta_cents) !== 0n, '流水前余额或变化无效'); balance += BigInt(entry.delta_cents); parseCents(String(balance));
        ensure(entry.balance_after_cents === String(balance), '流水后余额不守恒');
        ensure(entry.kind === 'recharge' ? BigInt(entry.actual_pay_cents) > 0n && BigInt(entry.gift_cents) >= 0n && BigInt(entry.delta_cents) === BigInt(entry.actual_pay_cents) + BigInt(entry.gift_cents) : entry.actual_pay_cents === '0' && entry.gift_cents === '0' && (entry.kind === 'consume' ? BigInt(entry.delta_cents) < 0n : reversals.has(entry.entry_id)), '充值、消费或冲正金额无效');
        const receipt = originalReceipts.get(entry.entry_id), rule = recharge.get(entry.entry_id);
        ensure(receipt, '缺少资金原单回执'); validateBackupRow('command_receipts', receipt, storeId);
        for (const column of ['member_id', 'kind', 'actor_id', 'device_id', 'delta_cents', 'balance_before_cents', 'balance_after_cents', 'account_version', 'occurred_at']) ensure(receipt[column] === entry[column], '回执与原单不一致');
        if (rule) ensure(BigInt(rule.configuration_version) <= BigInt(currentVersion), '充值规则版本超前');
        saleSnapshot({ type: entry.kind, deltaCents: entry.delta_cents, actualPayCents: entry.actual_pay_cents, giftCents: entry.gift_cents,
          items: positions(items.get(entry.entry_id)).map(row => ({ serviceId: row.service_id, name: row.name, quantity: Number(row.quantity), unitPriceCents: row.unit_price_cents, lineTotalCents: row.line_total_cents })),
          payments: positions(payments.get(entry.entry_id)).map(row => ({ method: row.method, amountCents: row.amount_cents })),
          recharge: rule ? { configurationVersion: rule.configuration_version, planId: rule.plan_id, actualPayCents: rule.actual_pay_cents, giftCents: rule.gift_cents, giftEnabled: rule.gift_enabled === 'true', giftRateBasisPoints: Number(rule.gift_rate_basis_points) } : null });
      }
    }
    ensure(account.balance_cents === String(balance) && account.version === String(version) && (!member.archived_at || balance === 0n), '账户与完整历史不守恒');
  }
  for await (const rows of reader.scan('application_task_receipts')) for (const receipt of rows) {
    const t = logical('application_task_receipts', [receipt]), profile = t.task_member_results[0], memberId = profile?.member_id ?? (receipt.task_type === 'member.archive' ? receipt.entity_id : null);
    const members = memberId ? logical('member_profiles', await reader.collect('member_profiles', ' AND id=$2', [memberId], 1)).member_profiles : [];
    const accounts = memberId ? logical('member_accounts', await reader.collect('member_accounts', ' AND member_id=$2', [memberId], 1)).member_accounts : [];
    const openings = memberId ? logical('account_openings', await reader.collect('account_openings', ' AND member_id=$2', [memberId], 1)).account_openings : [];
    const entries = profile && profile.account_version !== '0' ? logical('ledger_entries', await reader.collect('ledger_entries', ' AND member_id=$2 AND account_version=$3', [memberId, profile.account_version], 1)).ledger_entries : [];
    const audits = await auditRows('task_completed', receipt.task_id); ensure(audits.length === 1 && JSON.parse(audits[0].details).type === receipt.task_type, '任务审计不完整');
    const wasArchived = receipt.task_type === 'member.archive' && await countAudit('member_archived', memberId) > 0;
    validateTaskResults(t, { members: map(members, 'id'), accounts: map(accounts, 'member_id'), openings: map(openings, 'member_id'), entries: map(entries, 'entry_id'), audited: new Map([[receipt.task_id, logical('audit_events', audits).local_audit]]), currentVersion, wasArchived: () => wasArchived });
  }
  for await (const rows of reader.scan('application_batches')) for (const batch of rows) {
    const t = logical('application_batches', [batch]);
    t.application_batch_controls = await reader.collect('application_batch_controls', ' AND batch_id=$2', [batch.batch_id], 1);
    t.application_batch_items = await reader.collect('application_batch_items', ' AND batch_id=$2', [batch.batch_id], 500);
    const ids = t.application_batch_items.map(row => row.task_id); t.application_batch_tags = await reader.byIds('application_batch_tags', 'task_id', ids, 16000);
    t.local_task_receipts = [];
    for (let at = 0; at < ids.length; at += 200) {
      const rows = await query('SELECT ' + pgProjection('application_task_receipts', BACKUP_TABLES.local_task_receipts) + ' FROM application_task_receipts WHERE store_id=$1 AND task_id=ANY($2::text[]) LIMIT 200', [storeId, ids.slice(at, at + 200)]);
      t.local_task_receipts.push(...rows.map(row => ({ ...row, completed_at: new Date(row.completed_at).toISOString() })));
    }
    const events = await query('SELECT event,count(*)::text AS n FROM audit_events WHERE store_id=$1 AND ' + entity + "=$2 AND user_id=$3 AND device_id=$4 AND event IN ('batch_captured','batch_controlled') GROUP BY event", [storeId, batch.batch_id, batch.actor_id, batch.device_id]);
    const counts = new Map(events.map(row => [row.event, row.n])), auditCounts = new Map([[canonicalJSON([batch.batch_id, batch.actor_id, batch.device_id]), { captured: counts.get('batch_captured') ?? '0', controlled: counts.get('batch_controlled') ?? '0' }]]);
    for (const check of batchCaptureChecks(t, storeId, ensure, { auditCounts })) ensure(await hash(canonicalJSON(check.value)) === check.hash, '批次原始捕获摘要不匹配');
  }
  for await (const rows of reader.scan('audit_events')) for (const audit of rows) {
    ensure(/^[a-f0-9-]{36}$/.test(audit.event_id) && COMMAND_ID.test(audit.device_id), '核心审计标识无效');
    if (audit.event.startsWith('ledger_') && audit.event !== 'ledger_restored' || audit.event === 'task_completed' || memberEvents.includes(audit.event)) continue;
    const d = JSON.parse(audit.details);
    if (audit.event === 'account_opening_imported') { const batch = (await reader.byIds('account_opening_batches', 'batch_id', [d.batchId], 1))[0]; ensure(batch && Number.isInteger(d.memberCount) && batch.source_digest === d.sourceDigest && batch.member_count === String(d.memberCount) && batch.net_balance_cents === d.netBalanceCents, '期初审计不一致'); }
    if (audit.event === 'configuration_updated') { versionOf(d.version); ensure(BigInt(d.version) <= BigInt(currentVersion) && Number.isInteger(d.serviceCount) && Number.isInteger(d.planCount), '配置审计无效'); }
  }
  ensure(await countAudit('ledger_restored', 'store') === 0 && Number((await one("SELECT count(*)::text AS n FROM audit_events WHERE store_id=$1 AND event='ledger_restored'", [storeId])).n) === counts.ledger_restore_receipts, '恢复审计与回执不完整');
  for await (const rows of reader.scan('ledger_restore_receipts')) for (const receipt of rows) {
    validateRestoreReceipt(receipt, ensure); const audits = await auditRows('ledger_restored', receipt.task_id); ensure(audits.length === 1, '恢复审计缺失或重复');
    const a = audits[0], d = JSON.parse(a.details);
    ensure(a.user_id === receipt.actor_id && a.device_id === receipt.device_id && d.taskId === receipt.task_id && d.sourceDigest === receipt.source_digest && d.sourceEpoch === receipt.source_epoch && d.targetEpoch === receipt.target_epoch && d.ledgerEpoch === receipt.restored_epoch && String(d.memberCount) === receipt.member_count && String(d.entryCount) === receipt.entry_count, '恢复回执与审计不一致');
  }
  return { memberCount: counts.member_profiles, entryCount: counts.ledger_entries, receiptCount: counts.ledger_command_receipts, rowCounts: counts, actors: actorSummary };
}
