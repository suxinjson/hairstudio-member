import { canonicalJSON } from './canonical-json.js';
import { parseCents, applyFinancialCommand, createRecharge, createConsumption, createReversal } from './ledger-domain.js';
import { ENTITY_ID, COMMAND_ID, memberInput, normalizeOpeningInput, validateFinancialCommand, versionOf, invalid, text, phoneIdentity, batchNames } from './relational-contract.js';
import { normalizeMemberName } from './member-identity.js';
import { allowsFeature, operationFeature } from './license-policy.js';
import { configurationInput, prepareSale, saleSnapshot } from './relational-sales.js';
import { SQLITE_SALES_SCHEMA, sqliteSales } from './relational-sqlite-sales.js';
import { BACKUP_TABLES, validateBackupTables, validateSqliteBackup } from './relational-sqlite-backup.js';
import { sqliteReports } from './relational-sqlite-reports.js';
import { bindTask, mutationTask, taskRequest } from './relational-tasks.js';
import { SQLITE_TASK_SCHEMA, sqliteTasks } from './relational-sqlite-tasks.js';
import { ledgerEpochOf, requireLedgerEpoch } from './ledger-epoch.js';
import { batchRequest, batchScope, batchControl, bindBatch, batchStore } from './relational-batches.js';
import { batchSchema } from './relational-batch-schema.js';
import { SQLITE_RESTORE_SCHEMA, restoreCapture, restoreResult } from './relational-restore.js';
import { sqliteArchives } from './relational-sqlite-archive.js';
import { reportPeriod } from './relational-reports.js';
import { openingPayload, openingSummary, checkOpeningScope } from './relational-opening-contract.js';
import { readRelationalArchive } from './relational-archive.js';
import { REPLICA_FORMAT, REPLICA_TABLES, validateReplicaRow } from './relational-replica.js';

// Every business collection is represented by rows. JSON is used only to hash
// a captured command in memory, never as a database or localStorage ledger.
export const SQLITE_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS book_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),store_id TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN (\'standalone\',\'cloud\')),schema_version INTEGER NOT NULL CHECK(schema_version=6),cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor>=0),ledger_epoch TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS member_profiles(store_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,phone TEXT NOT NULL,notes TEXT NOT NULL,profile_version INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT,PRIMARY KEY(store_id,id))',
  'CREATE TABLE IF NOT EXISTS member_tags(store_id TEXT NOT NULL,member_id TEXT NOT NULL,tag TEXT NOT NULL,PRIMARY KEY(store_id,member_id,tag),FOREIGN KEY(store_id,member_id) REFERENCES member_profiles(store_id,id))',
  'CREATE TABLE IF NOT EXISTS member_accounts(store_id TEXT NOT NULL,member_id TEXT NOT NULL,balance_cents INTEGER NOT NULL CHECK(typeof(balance_cents)=\'integer\'),version INTEGER NOT NULL DEFAULT 0 CHECK(typeof(version)=\'integer\' AND version>=0),PRIMARY KEY(store_id,member_id),FOREIGN KEY(store_id,member_id) REFERENCES member_profiles(store_id,id))',
  "CREATE TABLE IF NOT EXISTS account_opening_batches(store_id TEXT NOT NULL,batch_id TEXT NOT NULL,source_digest TEXT NOT NULL,payload_digest TEXT NOT NULL,member_count INTEGER NOT NULL,net_balance_cents INTEGER NOT NULL CHECK(typeof(net_balance_cents)='integer'),positive_balance_cents INTEGER NOT NULL CHECK(typeof(positive_balance_cents)='integer'),negative_balance_cents INTEGER NOT NULL CHECK(typeof(negative_balance_cents)='integer'),imported_at TEXT NOT NULL,PRIMARY KEY(store_id,batch_id),UNIQUE(store_id,source_digest))",
  'CREATE TABLE IF NOT EXISTS account_openings(store_id TEXT NOT NULL,member_id TEXT NOT NULL,batch_id TEXT,source_member_id TEXT,opening_balance_cents INTEGER NOT NULL CHECK(typeof(opening_balance_cents)=\'integer\'),PRIMARY KEY(store_id,member_id),FOREIGN KEY(store_id,member_id) REFERENCES member_profiles(store_id,id),FOREIGN KEY(store_id,batch_id) REFERENCES account_opening_batches(store_id,batch_id))',
  'CREATE TABLE IF NOT EXISTS ledger_entries(store_id TEXT NOT NULL,entry_id TEXT NOT NULL,member_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN (\'recharge\',\'consume\',\'reversal\')),account_version INTEGER NOT NULL CHECK(typeof(account_version)=\'integer\' AND account_version>0),delta_cents INTEGER NOT NULL CHECK(typeof(delta_cents)=\'integer\' AND delta_cents<>0),balance_before_cents INTEGER NOT NULL CHECK(typeof(balance_before_cents)=\'integer\'),balance_after_cents INTEGER NOT NULL CHECK(typeof(balance_after_cents)=\'integer\'),actual_pay_cents INTEGER NOT NULL CHECK(typeof(actual_pay_cents)=\'integer\' AND actual_pay_cents>=0),gift_cents INTEGER NOT NULL CHECK(typeof(gift_cents)=\'integer\' AND gift_cents>=0),pay_method TEXT NOT NULL,items_summary TEXT NOT NULL,remark TEXT NOT NULL,actor_id TEXT NOT NULL,device_id TEXT NOT NULL,occurred_at TEXT NOT NULL,PRIMARY KEY(store_id,entry_id),UNIQUE(store_id,member_id,account_version),FOREIGN KEY(store_id,member_id) REFERENCES member_profiles(store_id,id))',
  'CREATE TABLE IF NOT EXISTS ledger_reversals(store_id TEXT NOT NULL,original_entry_id TEXT NOT NULL,reversal_entry_id TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(store_id,original_entry_id),UNIQUE(store_id,reversal_entry_id),FOREIGN KEY(store_id,original_entry_id) REFERENCES ledger_entries(store_id,entry_id),FOREIGN KEY(store_id,reversal_entry_id) REFERENCES ledger_entries(store_id,entry_id))',
  'CREATE TABLE IF NOT EXISTS command_receipts(store_id TEXT NOT NULL,command_id TEXT NOT NULL,request_hash TEXT NOT NULL,actor_id TEXT NOT NULL,device_id TEXT NOT NULL,member_id TEXT NOT NULL,kind TEXT NOT NULL,delta_cents INTEGER NOT NULL,balance_before_cents INTEGER NOT NULL,balance_after_cents INTEGER NOT NULL,account_version INTEGER NOT NULL,occurred_at TEXT NOT NULL,ledger_epoch TEXT NOT NULL,PRIMARY KEY(store_id,command_id),FOREIGN KEY(store_id,command_id) REFERENCES ledger_entries(store_id,entry_id))',
  'CREATE TABLE IF NOT EXISTS sync_outbox(store_id TEXT NOT NULL,command_id TEXT NOT NULL,member_id TEXT NOT NULL,command_type TEXT NOT NULL,expected_account_version INTEGER NOT NULL,actual_pay_cents INTEGER,gift_cents INTEGER,amount_cents INTEGER,original_entry_id TEXT,reason TEXT,allow_debt INTEGER,pay_method TEXT,items_summary TEXT,remark TEXT,status TEXT NOT NULL DEFAULT \'pending\' CHECK(status IN (\'pending\',\'conflict\')),error_code TEXT,PRIMARY KEY(store_id,command_id),FOREIGN KEY(store_id,command_id) REFERENCES command_receipts(store_id,command_id))',
  'CREATE TABLE IF NOT EXISTS outbox_profile_checks(store_id TEXT NOT NULL,command_id TEXT NOT NULL,profile_version INTEGER NOT NULL CHECK(typeof(profile_version)=\'integer\' AND profile_version>=0),PRIMARY KEY(store_id,command_id),FOREIGN KEY(store_id,command_id) REFERENCES sync_outbox(store_id,command_id) ON DELETE CASCADE)',
  'CREATE TABLE IF NOT EXISTS local_audit(id INTEGER PRIMARY KEY,store_id TEXT NOT NULL,actor_id TEXT NOT NULL,device_id TEXT NOT NULL,event TEXT NOT NULL,entity_id TEXT NOT NULL,occurred_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS replica_reversal_links(store_id TEXT NOT NULL,original_entry_id TEXT NOT NULL,reversal_entry_id TEXT NOT NULL,PRIMARY KEY(store_id,original_entry_id))',
  'CREATE TABLE IF NOT EXISTS entry_confirmations(store_id TEXT NOT NULL,entry_id TEXT NOT NULL,occurred_at TEXT NOT NULL,PRIMARY KEY(store_id,entry_id),FOREIGN KEY(store_id,entry_id) REFERENCES ledger_entries(store_id,entry_id))',
  'CREATE TABLE IF NOT EXISTS replica_readiness(singleton INTEGER PRIMARY KEY CHECK(singleton=1),ledger_epoch TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS replica_write_block(singleton INTEGER PRIMARY KEY CHECK(singleton=1),ledger_epoch TEXT NOT NULL,error_code TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS replica_origin(singleton INTEGER PRIMARY KEY CHECK(singleton=1),initial_epoch TEXT NOT NULL,current_epoch TEXT NOT NULL)',
  "CREATE TABLE IF NOT EXISTS replica_pending_reviews(store_id TEXT NOT NULL,command_id TEXT NOT NULL,source_epoch TEXT NOT NULL,target_epoch TEXT NOT NULL,actor_id TEXT NOT NULL,device_id TEXT NOT NULL,resolution TEXT NOT NULL CHECK(resolution IN ('covered','manual')),document_digest TEXT NOT NULL,reviewed_at TEXT NOT NULL,PRIMARY KEY(store_id,command_id,source_epoch,target_epoch))",
  'CREATE INDEX IF NOT EXISTS member_page ON member_profiles(store_id,created_at,id)',
  'CREATE INDEX IF NOT EXISTS ledger_page ON ledger_entries(store_id,occurred_at DESC,entry_id DESC)',
  'CREATE INDEX IF NOT EXISTS ledger_member_page ON ledger_entries(store_id,member_id,account_version)',
  'CREATE INDEX IF NOT EXISTS ledger_member_time ON ledger_entries(store_id,member_id,occurred_at DESC,entry_id DESC)',
  "CREATE INDEX IF NOT EXISTS ledger_member_visits ON ledger_entries(store_id,member_id,occurred_at DESC,entry_id DESC) WHERE kind='consume'",
  'CREATE INDEX IF NOT EXISTS outbox_member ON sync_outbox(store_id,member_id,expected_account_version)',
  'CREATE INDEX IF NOT EXISTS audit_entity ON local_audit(store_id,entity_id,event,actor_id,device_id)',
  'CREATE INDEX IF NOT EXISTS audit_event ON local_audit(store_id,event)',
  'CREATE TRIGGER IF NOT EXISTS immutable_ledger_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT,\'ledger immutable\'); END',
  'CREATE TRIGGER IF NOT EXISTS immutable_ledger_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT,\'ledger immutable\'); END',
  'CREATE TRIGGER IF NOT EXISTS immutable_opening_update BEFORE UPDATE ON account_openings BEGIN SELECT RAISE(ABORT,\'opening immutable\'); END',
  'CREATE TRIGGER IF NOT EXISTS immutable_opening_delete BEFORE DELETE ON account_openings BEGIN SELECT RAISE(ABORT,\'opening immutable\'); END',
  ...SQLITE_SALES_SCHEMA,
  ...SQLITE_TASK_SCHEMA,
  ...SQLITE_RESTORE_SCHEMA,
  ...batchSchema()
];

const replicaProjectionTables = ['sync_outbox', 'local_command_configurations', 'command_receipts', 'entry_confirmations', 'replica_reversal_links', 'ledger_reversals',
  'consumption_items', 'payment_records', 'recharge_details', 'ledger_entries', 'account_openings', 'account_opening_batches',
  'member_tags', 'member_accounts', 'member_profiles', 'service_catalog', 'recharge_plan_items', 'store_recharge_settings'];
const replicaProjectionDeleteTriggers = SQLITE_SCHEMA.flatMap(sql => {
  const match = /^CREATE TRIGGER IF NOT EXISTS ([a-z_]+) BEFORE DELETE ON ([a-z_]+) /.exec(sql);
  return match && replicaProjectionTables.includes(match[2]) ? [{ name: match[1], sql }] : [];
});

function conflict(message, code) { return Object.assign(new Error(message), { status: 409, code }); }
function receiptResult(row) {
  return { storeId: row.store_id, ledgerEpoch: row.ledger_epoch, commandId: row.command_id, entryId: row.command_id, memberId: row.member_id, type: row.kind,
    deltaCents: String(row.delta_cents), balanceBeforeCents: String(row.balance_before_cents), balanceAfterCents: String(row.balance_after_cents),
    accountVersion: String(row.account_version), occurredAt: row.occurred_at };
}
function validId(value) { if (typeof value !== 'string' || !ENTITY_ID.test(value)) throw invalid('实体单号无效'); return value; }
const openingCapture = input => Object.fromEntries(['storeId', 'actorId', 'deviceId', 'payloadDigest', 'ledgerEpoch'].map(key => [key, input[key]]));
function pageLimit(value = 50) { if (!Number.isInteger(value) || value < 1 || value > 100) throw invalid('每页数量须为 1–100'); return value; }
const readFeature = { read: 'core', sync: 'core', memberRead: 'members', ledgerRead: 'cashier' };
function pageCursor(cursor, book, dimensions) {
  const scope = canonicalJSON([book.storeId, ...dimensions]);
  if (cursor === null) return scope;
  if (!cursor || typeof cursor.at !== 'string' || cursor.at.length > 32 || !Number.isFinite(Date.parse(cursor.at)) || typeof cursor.id !== 'string' || !ENTITY_ID.test(cursor.id)) throw invalid('分页游标无效');
  requireLedgerEpoch(cursor.ledgerEpoch, book.ledgerEpoch);
  if (cursor.scope !== scope) throw invalid('分页条件已变化，请从第一页开始', 'CURSOR_SCOPE_MISMATCH');
  return scope;
}
export async function sha256(value) {
  const bytes = new TextEncoder().encode(value), hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Driver interface: exec(sql), run(sql, parameters), all(sql, parameters),
// close(). All methods may be async. One repository owns one connection.
export function createRelationalSqlite({ driver, storeId, mode, ledgerEpoch, authorize, hash = sha256, now = () => new Date().toISOString(), id = () => crypto.randomUUID() }) {
  validId(storeId);
  if (mode === 'cloud' || ledgerEpoch !== undefined) ledgerEpochOf(ledgerEpoch);
  if (!driver || typeof authorize !== 'function' || !['standalone', 'cloud'].includes(mode)) throw invalid('SQLite 驱动、授权或账本模式无效');
  let tail = Promise.resolve(), initialized = false, poisoned = false, closed = false;
  const snapshots = new Set();
  const all = (sql, params = []) => driver.all(sql, params), run = (sql, params = []) => driver.run(sql, params);
  const one = async (sql, params = []) => (await all(sql, params))[0];
  async function book() { const row = await one('SELECT ledger_epoch FROM book_identity WHERE singleton=1'); return { storeId, ledgerEpoch: ledgerEpochOf(row?.ledger_epoch) }; }
  const sales = sqliteSales({ all, one, run, storeId });
  const reports = sqliteReports({ all, one, storeId, mode });
  const tasks = sqliteTasks({ all, one, run, storeId });
  function serial(work) {
    const result = tail.then(async () => { if (closed || poisoned) throw new Error('SQLite 连接不可用，须重新打开'); return work(); });
    tail = result.catch(() => {}); return result;
  }
  async function identity(permission, operation) {
    const user = await authorize({ storeId, mode, permission, operation });
    if (!user || user.storeId !== storeId || typeof user.id !== 'string' || !ENTITY_ID.test(user.id) || typeof user.deviceId !== 'string' || !COMMAND_ID.test(user.deviceId) ||
        !['owner', 'clerk', 'viewer'].includes(user.role) || permission === 'owner' && user.role !== 'owner' || permission === 'write' && user.role === 'viewer') throw Object.assign(new Error('本地身份或操作权限无效'), { status: 403, code: 'FORBIDDEN' });
    if (!allowsFeature(user.features, readFeature[operation] ?? operationFeature(operation))) throw Object.assign(new Error('许可未包含此功能'), { status: 403, code: 'FEATURE_DISABLED' });
    return user;
  }
  function transaction(permission, operation, work, { rollbackOnly = false } = {}) {
    return serial(async () => {
      if (!initialized) throw new Error('请先初始化 SQLite');
      await driver.exec(permission === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE');
      try {
        const user = await identity(permission, operation), result = await work(user);
        const currentUser = await identity(permission, operation); // A long import may cross a license boundary.
        if (currentUser.id !== user.id || currentUser.deviceId !== user.deviceId || currentUser.role !== user.role || currentUser.contextVersion !== user.contextVersion) throw conflict('提交前本地登录身份已变化', 'AUTH_CONTEXT_CHANGED');
        await driver.exec(rollbackOnly ? 'ROLLBACK' : 'COMMIT'); return result;
      } catch (error) {
        try { await driver.exec('ROLLBACK'); } catch { poisoned = true; }
        throw error;
      }
    });
  }
  const publicMember = (row, tags) => ({ id: row.id, name: row.name, phone: row.phone, notes: row.notes, tags,
    balanceCents: String(row.balance_cents), version: String(row.profile_version), accountVersion: String(row.account_version),
    createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at });
  async function readMember(memberId) {
    const row = await one('SELECT m.*,a.balance_cents,a.version AS account_version FROM member_profiles m JOIN member_accounts a ON a.store_id=m.store_id AND a.member_id=m.id WHERE m.store_id=? AND m.id=?', [storeId, memberId]);
    if (!row) throw Object.assign(new Error('会员不存在'), { status: 404 });
    const tags = await all('SELECT tag FROM member_tags WHERE store_id=? AND member_id=? ORDER BY tag', [storeId, memberId]);
    return publicMember(row, tags.map(tag => tag.tag));
  }
  async function insertMember(row, at) {
    await run('INSERT INTO member_profiles(store_id,id,name,phone,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [storeId, row.id, row.name, row.phone, row.notes, at, at]);
    await run('INSERT INTO member_accounts(store_id,member_id,balance_cents) VALUES(?,?,?)', [storeId, row.id, row.balanceCents ?? '0']);
    for (const tag of row.tags) await run('INSERT INTO member_tags(store_id,member_id,tag) VALUES(?,?,?)', [storeId, row.id, tag]);
  }
  async function audit(user, event, entityId, at) { await run('INSERT INTO local_audit(store_id,actor_id,device_id,event,entity_id,occurred_at) VALUES(?,?,?,?,?,?)', [storeId, user.id, user.deviceId, event, entityId, at]); }
  async function requireAvailablePhone(phone, memberId = '') {
    const digits = phoneIdentity(phone);
    if (!digits) return;
    // Legacy opening rows keep their display text. Narrow candidates using the
    // digits in order, then strip every non-digit in SQL for an exact match.
    const owner = await one(`WITH RECURSIVE candidates(id, rest, digits) AS (
      SELECT id,phone,'' FROM member_profiles WHERE store_id=? AND archived_at IS NULL AND id<>? AND phone LIKE ?
      UNION ALL SELECT id,substr(rest,2),digits||CASE WHEN substr(rest,1,1) GLOB '[0-9]' THEN substr(rest,1,1) ELSE '' END
      FROM candidates WHERE rest<>'' AND substr(?,1,length(digits))=digits
      ) SELECT 1 AS present FROM candidates WHERE rest='' AND digits=? LIMIT 1`,
    [storeId, memberId, '%' + [...digits].join('%') + '%', digits, digits]);
    if (owner) throw conflict('该手机号已用于其他在用会员，请先核对原档案', 'MEMBER_PHONE_IN_USE');
  }
  async function openSnapshot() {
    if (!initialized || closed || poisoned || typeof driver.openSnapshot !== 'function') throw conflict('驱动不支持独立只读快照，不能阻塞营业连接执行增长备份', 'ARCHIVE_SNAPSHOT_UNAVAILABLE');
    const reader = await driver.openSnapshot();
    if (closed || poisoned) { await reader.close(); throw new Error('SQLite 连接不可用'); }
    let done = false;
    const snapshot = { all: (sql, params) => { if (done) throw new Error('SQLite 快照已关闭'); return reader.all(sql, params); },
      exec: sql => { if (done) throw new Error('SQLite 快照已关闭'); return reader.exec(sql); },
      async close() { if (!done) { done = true; snapshots.delete(snapshot); await reader.close(); } } };
    snapshots.add(snapshot); return snapshot;
  }
  async function checkRestore(capture, user) {
    if (capture.actorId !== user.id || capture.deviceId !== user.deviceId) throw conflict('恢复捕获与当前身份不同', 'AUTH_CONTEXT_CHANGED');
    requireLedgerEpoch(capture.ledgerEpoch, (await book()).ledgerEpoch);
  }
  async function findRestore(capture, user) {
    if (capture.actorId !== user.id || capture.deviceId !== user.deviceId) throw conflict('恢复捕获与当前身份不同', 'AUTH_CONTEXT_CHANGED');
    const prior = await one('SELECT * FROM local_restore_receipts WHERE store_id=? AND task_id=?', [storeId, capture.id]);
    if (!prior) return null;
    if (prior.actor_id !== capture.actorId || prior.device_id !== capture.deviceId || prior.target_epoch !== capture.ledgerEpoch || prior.source_digest !== capture.digest) throw conflict('同恢复任务号对应不同文件、目标或身份', 'RESTORE_TASK_CONFLICT');
    return restoreResult(prior);
  }
  async function finishRestore(capture, user, sourceEpoch, summary) {
    if (await one('SELECT 1 AS present FROM local_restore_receipts WHERE store_id=? AND task_id=?', [storeId, capture.id])) throw conflict('恢复任务号与来源历史重复', 'RESTORE_TASK_CONFLICT');
    const nextEpoch = ledgerEpochOf(crypto.randomUUID());
    if (nextEpoch === capture.ledgerEpoch || nextEpoch === sourceEpoch) throw conflict('恢复必须创建新的账本代际', 'LEDGER_EPOCH_MISMATCH');
    const at = now(), row = { store_id: storeId, task_id: capture.id, actor_id: user.id, device_id: user.deviceId, target_epoch: capture.ledgerEpoch,
      source_epoch: sourceEpoch, restored_epoch: nextEpoch, source_digest: capture.digest, member_count: String(summary.memberCount), entry_count: String(summary.entryCount), completed_at: at };
    const columns = Object.keys(row);
    await run('UPDATE book_identity SET ledger_epoch=?,cursor=0 WHERE singleton=1', [nextEpoch]);
    await run('INSERT INTO local_restore_receipts(' + columns.join(',') + ') VALUES(' + columns.map(() => '?').join(',') + ')', columns.map(column => row[column]));
    await audit(user, 'ledger_restored', capture.id, at); return restoreResult(row);
  }
  const batches = user => batchStore({ one, all, run, receiptTable: 'local_task_receipts', hash, now,
    audit: (event, details) => audit(user, event, details.batchId, now()) });
  async function batchContext(scope, user) { bindBatch(scope, { ...await book(), actorId: user.id, deviceId: user.deviceId }); }
  async function pending(memberId) { return one('SELECT command_id FROM sync_outbox WHERE store_id=? AND member_id=? LIMIT 1', [storeId, memberId]); }
  async function applyReplicaEntity(item, rebuilding = false) {
    const value = item.value; validId(value.id);
    if (item.entityType === 'configuration') {
      if (value.id !== 'store') throw invalid('配置实体单号无效');
      const data = configurationInput({ expectedVersion: value.version, services: value.services, rechargePlans: value.rechargePlans, rechargeSettings: value.rechargeSettings });
      const current = await sales.configuration();
      if (BigInt(value.version) < BigInt(current.version)) throw conflict('远端配置版本倒退', 'CONFIGURATION_VERSION_CHANGED');
      if (value.version === current.version && canonicalJSON({ version: value.version, services: data.services, rechargePlans: data.rechargePlans, rechargeSettings: data.rechargeSettings }) !== canonicalJSON(current)) throw conflict('同版本配置内容不一致', 'CONFIGURATION_VERSION_CHANGED');
      return sales.saveConfiguration({ ...data, version: value.version });
    }
    const memberId = item.entityType === 'member' ? value.id : validId(value.memberId);
    if (await pending(memberId)) throw conflict('须先提交或核对该会员的本地待办，再拉取远端变更', 'SYNC_PENDING');
    versionOf(value.accountVersion, '账户版本');
    if (item.entityType === 'member') {
      const data = memberInput({ name: value.name, phone: value.phone, notes: value.notes, tags: value.tags });
      versionOf(value.version, '资料版本'); parseCents(value.balanceCents);
      for (const time of [value.createdAt, value.updatedAt, ...(value.archivedAt ? [value.archivedAt] : [])]) if (typeof time !== 'string' || !Number.isFinite(Date.parse(time))) throw invalid('同步时间无效');
      const current = await one('SELECT profile_version FROM member_profiles WHERE store_id=? AND id=?', [storeId, value.id]);
      if (rebuilding && current) throw conflict('云端副本含重复会员', 'REPLICA_SNAPSHOT_INVALID');
      if (!current) await insertMember({ ...data, id: value.id, balanceCents: value.balanceCents }, value.createdAt);
      const account = await one('SELECT version FROM member_accounts WHERE store_id=? AND member_id=?', [storeId, value.id]);
      if (BigInt(value.version) >= BigInt(current?.profile_version ?? 0)) {
        await run('UPDATE member_profiles SET name=?,phone=?,notes=?,profile_version=?,created_at=?,updated_at=?,archived_at=? WHERE store_id=? AND id=?', [data.name, data.phone, data.notes, value.version, value.createdAt, value.updatedAt, value.archivedAt, storeId, value.id]);
        await run('DELETE FROM member_tags WHERE store_id=? AND member_id=?', [storeId, value.id]);
        for (const tag of data.tags) await run('INSERT INTO member_tags VALUES(?,?,?)', [storeId, value.id, tag]);
      }
      if (BigInt(value.accountVersion) >= BigInt(account.version)) await run('UPDATE member_accounts SET balance_cents=?,version=? WHERE store_id=? AND member_id=?', [value.balanceCents, value.accountVersion, storeId, value.id]);
      if (value.openingBalanceCents !== null && value.openingBalanceCents !== undefined) {
        parseCents(value.openingBalanceCents); const prior = await one('SELECT opening_balance_cents FROM account_openings WHERE store_id=? AND member_id=?', [storeId, value.id]);
        if (prior && String(prior.opening_balance_cents) !== value.openingBalanceCents) throw conflict('远端期初与本地记录不一致', 'OPENING_CONFLICT');
        if (!prior) await run('INSERT INTO account_openings(store_id,member_id,opening_balance_cents) VALUES(?,?,?)', [storeId, value.id, value.openingBalanceCents]);
      }
    } else {
      if (!['recharge', 'consume', 'reversal'].includes(value.type)) throw invalid('远端流水类型无效');
      for (const field of ['deltaCents', 'balanceBeforeCents', 'balanceAfterCents', 'actualPayCents', 'giftCents']) parseCents(value[field]);
      if (BigInt(value.balanceAfterCents) - BigInt(value.balanceBeforeCents) !== BigInt(value.deltaCents)) throw invalid('远端流水金额关系无效');
      if (typeof value.occurredAt !== 'string' || !Number.isFinite(Date.parse(value.occurredAt))) throw invalid('远端流水时间无效');
      const prior = await one('SELECT * FROM ledger_entries WHERE store_id=? AND entry_id=?', [storeId, value.id]);
      if (rebuilding && prior) throw conflict('云端副本含重复流水', 'REPLICA_SNAPSHOT_INVALID');
      const detail = saleSnapshot(value);
      if (prior) {
        for (const [field, column] of Object.entries({ memberId: 'member_id', type: 'kind', accountVersion: 'account_version', deltaCents: 'delta_cents', balanceBeforeCents: 'balance_before_cents', balanceAfterCents: 'balance_after_cents', actualPayCents: 'actual_pay_cents', giftCents: 'gift_cents' })) if (String(prior[column]) !== value[field]) throw conflict('远端原单与本地原单不一致', 'ENTRY_CONFLICT');
        if (canonicalJSON((await sales.read([value.id])).get(value.id)) !== canonicalJSON(detail)) throw conflict('远端成交快照与本地原单不一致', 'ENTRY_CONFLICT');
      } else {
        await run('INSERT INTO ledger_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [storeId, value.id, value.memberId, value.type, value.accountVersion, value.deltaCents, value.balanceBeforeCents, value.balanceAfterCents, value.actualPayCents, value.giftCents, value.payMethod, value.itemsSummary, value.remark, 'server', 'server', value.occurredAt]);
        await sales.write(value.id, detail);
      }
      await run('INSERT OR IGNORE INTO entry_confirmations VALUES(?,?,?)', [storeId, value.id, value.occurredAt]);
      if (value.reversed) {
        validId(value.reversalEntryId); const link = await one('SELECT reversal_entry_id FROM replica_reversal_links WHERE store_id=? AND original_entry_id=?', [storeId, value.id]);
        if (link && link.reversal_entry_id !== value.reversalEntryId) throw conflict('同一原单有不同冲正关系', 'ENTRY_CONFLICT');
        await run('INSERT OR IGNORE INTO replica_reversal_links VALUES(?,?,?)', [storeId, value.id, value.reversalEntryId]);
      }
    }
  }
  const linkReplicaReversals = () => run('INSERT OR IGNORE INTO ledger_reversals(store_id,original_entry_id,reversal_entry_id,reason) SELECT l.store_id,l.original_entry_id,l.reversal_entry_id,\'服务器冲正确认\' FROM replica_reversal_links l JOIN ledger_entries a ON a.store_id=l.store_id AND a.entry_id=l.original_entry_id JOIN ledger_entries b ON b.store_id=l.store_id AND b.entry_id=l.reversal_entry_id AND b.member_id=a.member_id WHERE l.store_id=?', [storeId]);
  async function extendCommand(command, row) {
    for (const [field, column] of Object.entries({ actualPayCents: 'actual_pay_cents', giftCents: 'gift_cents', amountCents: 'amount_cents', originalEntryId: 'original_entry_id', reason: 'reason', payMethod: 'pay_method', itemsSummary: 'items_summary', remark: 'remark' })) if (row[column] !== null) command[field] = String(row[column]);
    if (row.allow_debt !== null) command.allowDebt = String(row.allow_debt) === '1';
    const profileCheck = await one('SELECT profile_version FROM outbox_profile_checks WHERE store_id=? AND command_id=?', [storeId, command.id]);
    if (profileCheck) command.expectedProfileVersion = String(profileCheck.profile_version);
    await sales.extendOutbox(command);
  }
  async function originalPending(id, user) {
    const row = await one('SELECT o.*,r.actor_id,r.device_id,r.ledger_epoch FROM sync_outbox o JOIN command_receipts r ON r.store_id=o.store_id AND r.command_id=o.command_id WHERE o.store_id=? AND o.command_id=?', [storeId, id]);
    if (!row || row.actor_id !== user.id || row.device_id !== user.deviceId) throw conflict('须使用原账号和设备核对', 'PENDING_ACTOR_CHANGED');
    const command = { storeId, ledgerEpoch: row.ledger_epoch, actorId: row.actor_id, deviceId: row.device_id,
      id: row.command_id, type: row.command_type, memberId: row.member_id, expectedAccountVersion: String(row.expected_account_version) };
    await extendCommand(command, row);
    return { command, status: row.status, errorCode: row.error_code };
  }
  function checkReplicaReview({ id, targetEpoch, resolution }) {
    if (mode !== 'cloud' || !COMMAND_ID.test(id ?? '') || !['covered', 'manual'].includes(resolution)) throw invalid('原单核对请求无效');
    return { id, targetEpoch: ledgerEpochOf(targetEpoch), resolution };
  }
  async function replicaFence(sourceEpoch, targetEpoch) {
    const block = await one('SELECT ledger_epoch,error_code FROM replica_write_block WHERE singleton=1');
    if (!block || block.ledger_epoch !== sourceEpoch || block.error_code === 'STORE_MISMATCH' ||
        sourceEpoch === targetEpoch && block.error_code !== 'CURSOR_HISTORY_INCOMPLETE') throw conflict('当前副本不允许重建或归档待办', 'REPLICA_REBUILD_BLOCKED');
  }
  async function reviewEvidence({ id, targetEpoch, resolution }, user) {
    const { ledgerEpoch } = await book();
    if (targetEpoch === ledgerEpoch) throw conflict('同代际原单须向服务器核对', 'REPLICA_REVIEW_EPOCH');
    await replicaFence(ledgerEpoch, targetEpoch);
    const pending = await originalPending(id, user);
    requireLedgerEpoch(ledgerEpoch, pending.command.ledgerEpoch);
    const receipt = receiptResult(await one('SELECT * FROM command_receipts WHERE store_id=? AND command_id=?', [storeId, id]));
    return canonicalJSON({ format: 'member-pending-review', version: 1, ...pending, receipt, targetEpoch, resolution });
  }
  async function verifyReplicaBalances() {
    // Adjacent balances avoid SUM and preserve precision at the 64-bit bounds.
    const broken = await one('SELECT 1 AS invalid FROM member_accounts a LEFT JOIN account_openings o ON o.store_id=a.store_id AND o.member_id=a.member_id ' +
      'LEFT JOIN ledger_entries e ON e.store_id=a.store_id AND e.member_id=a.member_id AND e.account_version=a.version WHERE a.store_id=? ' +
      'AND (a.version=0 AND a.balance_cents<>COALESCE(o.opening_balance_cents,0) OR a.version>0 AND (e.entry_id IS NULL OR e.balance_after_cents<>a.balance_cents)) LIMIT 1', [storeId]);
    const gap = await one('SELECT 1 AS invalid FROM ledger_entries e JOIN member_accounts a ON a.store_id=e.store_id AND a.member_id=e.member_id ' +
      'LEFT JOIN account_openings o ON o.store_id=e.store_id AND o.member_id=e.member_id LEFT JOIN ledger_entries p ON p.store_id=e.store_id AND p.member_id=e.member_id AND p.account_version=e.account_version-1 ' +
      'WHERE e.store_id=? AND (e.account_version>a.version OR e.account_version=1 AND e.balance_before_cents<>COALESCE(o.opening_balance_cents,0) ' +
      'OR e.account_version>1 AND (p.entry_id IS NULL OR p.balance_after_cents<>e.balance_before_cents)) LIMIT 1', [storeId]);
    const reversal = await one('SELECT 1 AS invalid FROM replica_reversal_links l LEFT JOIN ledger_reversals r ON r.store_id=l.store_id AND r.original_entry_id=l.original_entry_id ' +
      'WHERE l.store_id=? AND r.reversal_entry_id IS NULL UNION ALL SELECT 1 FROM ledger_entries e LEFT JOIN ledger_reversals r ON r.store_id=e.store_id AND r.reversal_entry_id=e.entry_id ' +
      "LEFT JOIN ledger_entries p ON p.store_id=r.store_id AND p.entry_id=r.original_entry_id WHERE e.store_id=? AND (e.kind='reversal' AND (p.entry_id IS NULL OR p.kind='reversal' OR p.account_version>=e.account_version OR p.delta_cents+e.delta_cents<>0) OR e.kind<>'reversal' AND p.entry_id IS NOT NULL) LIMIT 1", [storeId, storeId]);
    if (broken || gap || reversal) throw conflict('云端副本流水、期初或余额校验不通过', 'REPLICA_SNAPSHOT_INVALID');
  }
  function withTask(permission, operation, type, data, metadata, memberId, work) {
    const request = mutationTask(type, data, metadata, memberId);
    if (mode !== 'standalone') throw conflict('云端资料和配置任务须由在线应用服务确认', 'ONLINE_REQUIRED');
    return transaction(permission, operation, async user => {
      const bound = bindTask(request, { ...await book(), actorId: user.id, deviceId: user.deviceId }), requestHash = await hash(canonicalJSON(bound)), prior = await tasks.find(request.id);
      if (prior) {
        requireLedgerEpoch(prior.ledger_epoch, bound.ledgerEpoch);
        if (prior.request_hash !== requestHash || prior.actor_id !== user.id || prior.device_id !== user.deviceId) throw conflict('同任务号对应不同内容、账号或设备', 'TASK_CONFLICT');
        return tasks.read(prior);
      }
      await batches(user).guardTask(bound, requestHash);
      const result = await work(user), at = now();
      await tasks.save(bound, requestHash, result, at); await audit(user, 'task_completed', request.id, at); return result;
    });
  }
  const api = {
    mode,
    get needsReopen() { return poisoned; },
    ...sqliteArchives({ storeId, mode, hash, now, transaction, book, all, run, identity, openSnapshot, checkRestore, findRestore, finishRestore }),
    getRestoreReceipt(input) {
      const capture = restoreCapture(input);
      return transaction('owner', 'importBackupData', async user => {
        const result = await findRestore(capture, user);
        if (!result) throw Object.assign(new Error('未找到当前身份的恢复回执'), { status: 404, code: 'RESTORE_NOT_FOUND' });
        return result;
      });
    },
    getBook() { return transaction('read', 'read', book); },
    captureBatch(input) {
      const request = batchRequest(input);
      if (mode !== 'standalone') throw conflict('云端资料批次须在线持久捕获', 'ONLINE_REQUIRED');
      const owner = request.items.some(item => item.type === 'member.archive');
      return transaction(owner ? 'owner' : 'write', 'createMember', async user => {
        await batchContext(request, user);
        for (const type of new Set(request.items.map(item => item.type))) await identity(owner ? 'owner' : 'write', { 'member.create': 'createMember', 'member.update': 'updateMember', 'member.archive': 'deleteMember' }[type]);
        return batches(user).capture(request);
      });
    },
    controlBatch(input) {
      const request = batchControl(input);
      return transaction('write', 'createMember', async user => { await batchContext(request, user); return batches(user).change(request); });
    },
    getBatch(input, page) {
      const scope = batchScope(input);
      return transaction('read', 'memberRead', async user => { await batchContext(scope, user); return batches(user).progress(scope, page); });
    },
    getBatchItem(input, taskId) {
      const scope = batchScope(input);
      if (!COMMAND_ID.test(taskId ?? '')) throw invalid('行任务号无效');
      return transaction('read', 'memberRead', async user => { await batchContext(scope, user); return batches(user).task(scope, taskId); });
    },
    listBatches({ ledgerEpoch, after = '', limit = 50 } = {}) {
      if (after && !COMMAND_ID.test(after) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('批次分页无效');
      return transaction('read', 'memberRead', async user => {
        requireLedgerEpoch(ledgerEpoch, (await book()).ledgerEpoch);
        const rows = await all('SELECT batch_id,created_at,source_digest,item_count FROM application_batches WHERE store_id=? AND actor_id=? AND device_id=? AND ledger_epoch=? AND batch_id>? ORDER BY batch_id LIMIT ?', [storeId, user.id, user.deviceId, ledgerEpoch, after, limit + 1]);
        return { items: rows.slice(0, limit).map(row => ({ batchId: row.batch_id, createdAt: row.created_at, sourceDigest: row.source_digest, itemCount: Number(row.item_count) })), nextAfter: rows.length > limit ? rows[limit - 1].batch_id : null };
      });
    },
    async executeBatchItem(input, taskId) {
      const scope = batchScope(input);
      if (!COMMAND_ID.test(taskId ?? '')) throw invalid('行任务号无效');
      const request = await transaction('read', 'memberRead', async user => { await batchContext(scope, user); return batches(user).task(scope, taskId); });
      return api.executeTask(request);
    },
    async executeTask(input) {
      const request = taskRequest(input), { id, storeId: targetStore, ledgerEpoch, actorId, deviceId } = request, metadata = { id, storeId: targetStore, ledgerEpoch, actorId, deviceId };
      if (request.type === 'member.create') return api.createMember(request.data, metadata);
      if (request.type === 'member.update') return api.updateMember(request.memberId, request.data, metadata);
      if (request.type === 'member.archive') return api.archiveMember(request.memberId, metadata);
      return api.updateConfiguration(request.data, metadata);
    },
    getTask(taskId, { ledgerEpoch } = {}) {
      ledgerEpochOf(ledgerEpoch);
      if (typeof taskId !== 'string' || !COMMAND_ID.test(taskId)) throw invalid('任务号无效');
      return transaction('read', 'read', async user => {
        requireLedgerEpoch(ledgerEpoch, (await book()).ledgerEpoch);
        const row = await tasks.find(taskId);
        if (!row || row.actor_id !== user.id || row.device_id !== user.deviceId) throw Object.assign(new Error('未找到当前身份的已提交任务'), { status: 404, code: 'TASK_NOT_FOUND' });
        requireLedgerEpoch(row.ledger_epoch, ledgerEpoch);
        return { ledgerEpoch, taskId, type: row.task_type, result: await tasks.read(row), completedAt: row.completed_at };
      });
    },
    getCommand(id, { ledgerEpoch } = {}) {
      if (typeof id !== 'string' || !COMMAND_ID.test(id)) throw invalid('命令号无效');
      return transaction('read', 'ledgerRead', async user => {
        requireLedgerEpoch(ledgerEpoch, (await book()).ledgerEpoch);
        const row = await one('SELECT * FROM command_receipts WHERE store_id=? AND command_id=? AND actor_id=? AND device_id=?', [storeId, id, user.id, user.deviceId]);
        if (!row) throw Object.assign(new Error('未找到该身份的本机账务回执'), { status: 404, code: 'COMMAND_NOT_FOUND' });
        requireLedgerEpoch(ledgerEpoch, row.ledger_epoch);
        return receiptResult(row);
      });
    },
    report(input) { return transaction('read', 'reports', () => reports.summary(input)); },
    reportBreakdown(input) { return transaction('read', 'reports', () => reports.breakdown(input)); },
    reportBusiness(input) { return transaction('read', 'reports', () => reports.business(input)); },
    exportBackup() {
      if (mode !== 'standalone') throw conflict('云端副本不能充当完整离线账本备份，须执行服务器备份和待办核对', 'WRONG_AUTHORITY');
      return transaction('owner', 'exportBackupData', async () => {
        const tables = {};
        for (const [table, columns] of Object.entries(BACKUP_TABLES)) {
          const rows = []; let after = null;
          for (;;) {
            const page = await all('SELECT rowid AS __rowid,' + columns.join(',') + ' FROM ' + table + ' NOT INDEXED WHERE store_id=?' + (after === null ? '' : ' AND rowid>CAST(? AS INTEGER)') + ' ORDER BY rowid LIMIT 500', [storeId, ...(after === null ? [] : [after])]);
            for (const { __rowid, ...row } of page) { rows.push(row); after = String(__rowid); }
            if (rows.length > 150000) throw Object.assign(new Error('备份关系表超过容量，未生成截断文件'), { status: 413, code: 'BACKUP_CAPACITY' });
            if (page.length < 500) break;
          }
          tables[table] = rows;
        }
        validateBackupTables(tables, storeId);
        const payload = { format: 'member-relational-sqlite', formatVersion: 4, schemaVersion: 6, ...await book(), mode, exportedAt: now(), tables };
        const backup = { ...payload, digest: await hash(canonicalJSON(payload)) };
        // Enforce the same capacity at export that a fresh installation can read.
        await validateSqliteBackup(backup, { storeId, hash }); return backup;
      });
    },
    async previewBackupRestore(input) {
      if (mode !== 'standalone') throw conflict('云端副本不能用文件覆盖远端权威或未确认待办', 'WRONG_AUTHORITY');
      const backup = await validateSqliteBackup(input, { storeId, hash });
      return transaction('owner', 'importBackupData', async () => {
        for (const table of Object.keys(BACKUP_TABLES)) if (await one('SELECT 1 AS present FROM ' + table + ' LIMIT 1')) throw conflict('恢复目标已有业务、配置或审计记录；须使用经过核对的新空账本', 'BACKUP_NOT_EMPTY');
        return { ...backup.summary, ...await book(), sourceLedgerEpoch: backup.payload.ledgerEpoch, digest: backup.digest };
      });
    },
    async restoreBackup(input, metadata = {}) {
      if (mode !== 'standalone') throw conflict('云端副本不能用文件覆盖远端权威或未确认待办', 'WRONG_AUTHORITY');
      const capture = restoreCapture(metadata);
      const backup = await validateSqliteBackup(input, { storeId, hash });
      return transaction('owner', 'importBackupData', async user => {
        if (capture.digest !== backup.digest) throw conflict('所选文件与已核对摘要不同', 'BACKUP_REVIEW_REQUIRED');
        const prior = await findRestore(capture, user); if (prior) return prior;
        await checkRestore(capture, user);
        for (const table of Object.keys(BACKUP_TABLES)) if (await one('SELECT 1 AS present FROM ' + table + ' LIMIT 1')) throw conflict('恢复目标已有业务、配置或审计记录；须使用经过核对的新空账本', 'BACKUP_NOT_EMPTY');
        for (const [table, columns] of Object.entries(BACKUP_TABLES)) for (const row of backup.payload.tables[table]) await run('INSERT INTO ' + table + '(' + columns.join(',') + ') VALUES(' + columns.map(() => '?').join(',') + ')', columns.map(column => row[column]));
        return finishRestore(capture, user, backup.payload.ledgerEpoch, backup.summary);
      });
    },
    async init() {
      return serial(async () => {
        await driver.exec('PRAGMA foreign_keys=ON'); await driver.exec('PRAGMA journal_mode=WAL'); await driver.exec('PRAGMA synchronous=FULL'); await driver.exec('PRAGMA busy_timeout=5000');
        await driver.exec('BEGIN IMMEDIATE');
        try {
          const fk = await one('PRAGMA foreign_keys'), journal = await one('PRAGMA journal_mode'), sync = await one('PRAGMA synchronous');
          if (String(fk.foreign_keys) !== '1' || journal.journal_mode !== 'wal' || String(sync.synchronous) !== '2') throw new Error('SQLite 外键、WAL 或 FULL 持久化配置未生效');
          // Fail before new DDL or INSERT refers to columns absent in older
          // development schemas. Never delete an older database to make it open.
          if (await one("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='book_identity'")) {
            const previous = await one('SELECT store_id,mode,schema_version FROM book_identity WHERE singleton=1');
            if (!previous || previous.store_id !== storeId || previous.mode !== mode || String(previous.schema_version) !== '6') throw new Error('SQLite 账本归属、模式或版本不一致，拒绝自动覆盖');
          }
          for (const sql of SQLITE_SCHEMA) await driver.exec(sql);
          await run('INSERT OR IGNORE INTO book_identity(singleton,store_id,mode,schema_version,ledger_epoch) VALUES(1,?,?,6,?)', [storeId, mode, ledgerEpochOf(ledgerEpoch ?? crypto.randomUUID())]);
          const book = await one('SELECT * FROM book_identity WHERE singleton=1');
          if (book.store_id !== storeId || book.mode !== mode || String(book.schema_version) !== '6') throw new Error('SQLite 账本归属、模式或版本不一致，拒绝自动覆盖');
          ledgerEpochOf(book.ledger_epoch);
          if (mode === 'cloud') {
            const origin = await one('SELECT initial_epoch,current_epoch FROM replica_origin WHERE singleton=1');
            if (origin) { requireLedgerEpoch(ledgerEpoch, origin.initial_epoch); requireLedgerEpoch(book.ledger_epoch, origin.current_epoch); }
            else { requireLedgerEpoch(ledgerEpoch, book.ledger_epoch); await run('INSERT INTO replica_origin VALUES(1,?,?)', [ledgerEpoch, ledgerEpoch]); }
          } else if (ledgerEpoch !== undefined) requireLedgerEpoch(ledgerEpoch, book.ledger_epoch);
          await driver.exec('COMMIT'); initialized = true;
          return { foreignKeys: true, journalMode: journal.journal_mode, synchronous: 'FULL', schemaVersion: 6 };
        } catch (error) { try { await driver.exec('ROLLBACK'); } catch { poisoned = true; } throw error; }
      });
    },
    getConfiguration() { return transaction('read', 'read', () => sales.configuration()); },
    updateConfiguration(input, task) {
      const data = configurationInput(input); if (mode !== 'standalone') throw conflict('云端配置须由在线应用服务确认', 'ONLINE_REQUIRED');
      return withTask('owner', 'settings', 'configuration.update', input, task, undefined, async user => {
        const current = await sales.configuration(); if (current.version !== data.expectedVersion) throw conflict('配置已变化，请重新核对', 'CONFIGURATION_VERSION_CHANGED');
        const version = String(BigInt(current.version) + 1n); versionOf(version);
        await sales.saveConfiguration({ ...data, version }); await audit(user, 'configuration_updated', version, now()); return sales.configuration();
      });
    },
    getMember(memberId) { validId(memberId); return transaction('read', 'memberRead', () => readMember(memberId)); },
    findActiveNames({ names } = {}) {
      const keys = new Map(batchNames(names).map(name => [normalizeMemberName(name), 0]));
      return transaction('read', 'memberRead', async () => {
        const matches = []; let after = '';
        while (keys.size) {
          const rows = await all('SELECT id,name,profile_version FROM member_profiles WHERE store_id=? AND archived_at IS NULL AND id>? ORDER BY id LIMIT 100', [storeId, after]);
          for (const row of rows) {
            const nameKey = normalizeMemberName(row.name);
            if (!keys.has(nameKey)) continue;
            if (keys.get(nameKey)) keys.delete(nameKey); else keys.set(nameKey, 1);
            matches.push({ nameKey, id: row.id, version: String(row.profile_version) });
          }
          if (rows.length < 100) break;
          after = rows.at(-1).id;
        }
        return matches;
      });
    },
    listMembers({ search = '', sameName = '', balance = 'all', cursor = null, after = cursor, limit = 50 } = {}) {
      pageLimit(limit); search = text(search, 128, '搜索内容'); sameName = text(sameName, 128, '同名会员姓名');
      const recent = balance === 'recent';
      const filters = { all: '', recent: '', archived: '', positive: ' AND a.balance_cents>0', low: ' AND a.balance_cents BETWEEN 0 AND 5000', debt: ' AND a.balance_cents<0' };
      if (!Object.hasOwn(filters, balance) || recent && (after || sameName)) throw invalid('会员余额筛选无效');
      return transaction('read', 'memberRead', async () => {
        const current = await book(), scope = pageCursor(after, current, ['members', search, balance, sameName]);
        const digits = /^[\d+() -]+$/.test(search) ? search.replace(/[^0-9+]/g, '') : '';
        const order = recent
          ? "(SELECT e.occurred_at FROM ledger_entries e WHERE e.store_id=m.store_id AND e.member_id=m.id AND e.kind='consume' AND NOT EXISTS (SELECT 1 FROM ledger_reversals r WHERE r.store_id=e.store_id AND r.original_entry_id=e.entry_id) ORDER BY e.occurred_at DESC,e.entry_id DESC LIMIT 1) DESC,m.created_at DESC,m.id"
          : 'm.created_at,m.id';
        const select = (position, count) => all('SELECT m.*,a.balance_cents,a.version AS account_version FROM member_profiles m JOIN member_accounts a ON a.store_id=m.store_id AND a.member_id=m.id WHERE m.store_id=? AND m.archived_at IS ' +
          (balance === 'archived' ? 'NOT NULL' : 'NULL') + filters[balance] +
          (search ? " AND (instr(lower(m.name),lower(?))>0 OR instr(lower(m.notes),lower(?))>0 OR instr(m.phone,?)>0 OR (?<>'' AND instr(replace(replace(replace(replace(m.phone,' ',''),'-',''),'(',''),')',''),?)>0))" : '') +
          (position ? ' AND (m.created_at,m.id)>(?,?)' : '') + ' ORDER BY ' + order + ' LIMIT ?',
          [storeId, ...(search ? [search, search, search, digits, digits] : []), ...(position ? [position.at, position.id] : []), count]);
        let rows;
        if (!sameName) rows = await select(after, recent ? Math.min(limit, 12) : limit + 1);
        else {
          // SQLite has no NFKC operator. Compare bounded pages in the same snapshot.
          rows = [];
          let position = after;
          const nameKey = normalizeMemberName(sameName);
          while (rows.length <= limit) {
            const candidates = await select(position, 100);
            rows.push(...candidates.filter(row => normalizeMemberName(row.name) === nameKey));
            if (candidates.length < 100) break;
            const last = candidates.at(-1); position = { at: last.created_at, id: last.id };
          }
        }
        const page = rows.slice(0, limit), tags = new Map(page.map(row => [row.id, []]));
        // Each member has at most 32 tags. Keep reads below the native bridge's row limit.
        for (let offset = 0; offset < page.length; offset += 30) {
          const ids = page.slice(offset, offset + 30).map(row => row.id);
          for (const row of await all('SELECT member_id,tag FROM member_tags WHERE store_id=? AND member_id IN (' + ids.map(() => '?').join(',') + ') ORDER BY member_id,tag', [storeId, ...ids])) tags.get(row.member_id).push(row.tag);
        }
        return { items: page.map(row => publicMember(row, tags.get(row.id))), nextCursor: rows.length > limit ? { at: page.at(-1).created_at,
          id: page.at(-1).id, ledgerEpoch: current.ledgerEpoch, scope } : null };
      });
    },
    createMember(input, task) {
      const data = memberInput(input); if (mode !== 'standalone') throw conflict('云端会员新增须由在线应用服务确认', 'ONLINE_REQUIRED');
      return withTask('write', 'createMember', 'member.create', input, task, undefined, async user => {
        if (data.phone && !phoneIdentity(data.phone)) throw invalid('手机号码格式无效', 'MEMBER_PHONE_INVALID');
        await requireAvailablePhone(data.phone);
        const memberId = validId(id()), at = now();
        await insertMember({ id: memberId, ...data }, at);
        await audit(user, 'member_created', memberId, at);
        return readMember(memberId);
      });
    },
    updateMember(memberId, input, task) {
      validId(memberId); const data = memberInput(input, { update: true }), expectedVersion = input.expectedVersion;
      if (mode !== 'standalone') throw conflict('云端资料编辑须由在线应用服务确认', 'ONLINE_REQUIRED');
      return withTask('write', 'updateMember', 'member.update', input, task, memberId, async user => {
        const current = await readMember(memberId); if (current.archivedAt || current.version !== expectedVersion) throw conflict('会员资料已变化或归档', 'MEMBER_VERSION_CHANGED');
        if (current.phone !== data.phone && data.phone && !phoneIdentity(data.phone)) throw invalid('手机号码格式无效', 'MEMBER_PHONE_INVALID');
        if (phoneIdentity(current.phone) !== phoneIdentity(data.phone)) await requireAvailablePhone(data.phone, memberId);
        const version = String(BigInt(current.version) + 1n); versionOf(version); const at = now();
        await run('UPDATE member_profiles SET name=?,phone=?,notes=?,profile_version=?,updated_at=? WHERE store_id=? AND id=?', [data.name, data.phone, data.notes, version, at, storeId, memberId]);
        await run('DELETE FROM member_tags WHERE store_id=? AND member_id=?', [storeId, memberId]);
        for (const tag of data.tags) await run('INSERT INTO member_tags(store_id,member_id,tag) VALUES(?,?,?)', [storeId, memberId, tag]);
        await audit(user, 'member_updated', memberId, at); return readMember(memberId);
      });
    },
    archiveMember(memberId, task) {
      validId(memberId); if (mode !== 'standalone') throw conflict('云端归档须由在线应用服务确认', 'ONLINE_REQUIRED');
      return withTask('owner', 'deleteMember', 'member.archive', {}, task, memberId, async user => {
        const member = await readMember(memberId); if (member.balanceCents !== '0') throw conflict('余额或欠款不为零，不能归档', 'BALANCE_NOT_ZERO');
        if (member.archivedAt) throw conflict('会员已归档', 'MEMBER_ARCHIVED'); const at = now();
        const version = String(BigInt(member.version) + 1n); versionOf(version);
        await run('UPDATE member_profiles SET archived_at=?,profile_version=?,updated_at=? WHERE store_id=? AND id=?', [at, version, at, storeId, memberId]);
        await audit(user, 'member_archived', memberId, at); return { success: true };
      });
    },
    previewOpeningImport(input) {
      if (mode !== 'standalone') throw conflict('云端期初须从服务器增量加载', 'ONLINE_REQUIRED');
      const batch = normalizeOpeningInput(input), captured = openingCapture(input);
      return transaction('owner', 'importBackupData', async user => {
        const scope = await book(), payloadDigest = await hash(openingPayload(batch));
        checkOpeningScope(captured, { ...scope, actorId: user.id, deviceId: user.deviceId }, payloadDigest);
        return { ...scope, ...openingSummary(batch, payloadDigest) };
      });
    },
    importOpeningBalances(input) {
      if (mode !== 'standalone') throw conflict('云端期初须从服务器增量加载', 'ONLINE_REQUIRED');
      const batch = normalizeOpeningInput(input), captured = openingCapture(input);
      return transaction('owner', 'importBackupData', async user => {
        const scope = await book(), payloadDigest = await hash(openingPayload(batch));
        checkOpeningScope(captured, { ...scope, actorId: user.id, deviceId: user.deviceId }, payloadDigest);
        const summary = { ...scope, ...openingSummary(batch, payloadDigest) };
        const prior = await one('SELECT * FROM account_opening_batches WHERE store_id=? AND (batch_id=? OR source_digest=?) LIMIT 1', [storeId, batch.batchId, batch.sourceDigest]);
        if (prior) {
          if (prior.source_digest !== batch.sourceDigest || prior.payload_digest !== payloadDigest) throw conflict('期初批次内容已变化', 'OPENING_BATCH_CONFLICT');
          return { ...summary, batchId: prior.batch_id, importedAt: prior.imported_at, alreadyImported: true };
        }
        if (await one('SELECT id FROM member_profiles WHERE store_id=? LIMIT 1', [storeId])) throw conflict('账本已有业务，不能再导入期初', 'OPENING_NOT_EMPTY');
        const at = now();
        await run('INSERT INTO account_opening_batches(store_id,batch_id,source_digest,payload_digest,member_count,net_balance_cents,positive_balance_cents,negative_balance_cents,imported_at) VALUES(?,?,?,?,?,?,?,?,?)', [storeId, batch.batchId, batch.sourceDigest, payloadDigest, batch.expectedCount, batch.netBalanceCents, batch.positiveBalanceCents, batch.negativeBalanceCents, at]);
        for (const row of batch.rows) { await insertMember(row, at); await run('INSERT INTO account_openings(store_id,member_id,batch_id,source_member_id,opening_balance_cents) VALUES(?,?,?,?,?)', [storeId, row.id, batch.batchId, row.sourceMemberId, row.balanceCents]); }
        await audit(user, 'account_opening_imported', batch.batchId, at); return { ...summary, importedAt: at, alreadyImported: false };
      });
    },
    executeCommand(input) {
      const captured = validateFinancialCommand({ storeId, ...input }), operation = captured.type === 'reverse' ? 'refundLedger' : captured.type;
      if (captured.storeId !== storeId) throw invalid('资金命令的门店归属不一致');
      return transaction(captured.type === 'reverse' ? 'owner' : 'write', operation, async user => {
        requireLedgerEpoch(captured.ledgerEpoch, (await book()).ledgerEpoch);
        if (captured.actorId !== undefined && captured.actorId !== user.id || captured.deviceId !== undefined && captured.deviceId !== user.deviceId) throw invalid('命令账号或设备与当前身份不匹配');
        const command = { ...captured, actorId: user.id, deviceId: user.deviceId };
        const prior = await one('SELECT * FROM command_receipts WHERE store_id=? AND command_id=?', [storeId, command.id]);
        const configuration = command.type === 'reverse' ? null : await sales.configuration();
        if (configuration && command.configurationVersion === undefined) {
          const original = prior ? await one('SELECT version FROM local_command_configurations WHERE store_id=? AND command_id=?', [storeId, command.id]) : null;
          command.configurationVersion = String(original?.version ?? configuration.version);
        }
        const requestHash = await hash(canonicalJSON(command));
        if (prior) { requireLedgerEpoch(prior.ledger_epoch, command.ledgerEpoch); if (prior.request_hash !== requestHash || prior.actor_id !== user.id || prior.device_id !== user.deviceId) throw conflict('同命令号对应不同内容、账号或设备', 'COMMAND_CONFLICT'); return receiptResult(prior); }
        if (mode === 'cloud') {
          const blocked = await one('SELECT error_code FROM replica_write_block WHERE singleton=1');
          if (blocked) throw conflict('云端账本已变化，请保留原账本和待办核对', blocked.error_code);
          if (!await one('SELECT 1 AS ready FROM replica_readiness WHERE singleton=1 AND ledger_epoch=?', [command.ledgerEpoch])) {
            throw conflict('请先联网完成首次账本同步', 'REPLICA_NOT_READY');
          }
        }
        const sale = prepareSale(command, configuration);
        if (await one('SELECT command_id FROM sync_outbox WHERE store_id=? AND member_id=? AND status=\'conflict\' LIMIT 1', [storeId, command.memberId])) throw conflict('该会员有待核对的同步冲突', 'MEMBER_SYNC_CONFLICT');
        if (await one('SELECT o.command_id FROM sync_outbox o JOIN command_receipts r ON r.store_id=o.store_id AND r.command_id=o.command_id WHERE o.store_id=? AND o.member_id=? AND (r.actor_id<>? OR r.device_id<>?) LIMIT 1', [storeId, command.memberId, user.id, user.deviceId])) throw conflict('该会员有其他身份的待办，须先完成原身份同步', 'PENDING_ACTOR_CHANGED');
        const member = await readMember(command.memberId);
        if (command.expectedProfileVersion !== undefined && member.version !== command.expectedProfileVersion) throw conflict('会员资料已变化，请重新核对', 'MEMBER_VERSION_CHANGED');
        if (member.archivedAt && command.type !== 'reverse') throw conflict('会员已归档，不能记账', 'MEMBER_ARCHIVED');
        if (member.accountVersion !== command.expectedAccountVersion) throw conflict('资金账户已变化', 'ACCOUNT_VERSION_CHANGED');
        const nextVersion = String(BigInt(member.accountVersion) + 1n); versionOf(nextVersion);
        let financial, actualPay = '0', gift = '0', kind = command.type === 'reverse' ? 'reversal' : command.type;
        if (command.type === 'recharge') { const recharge = createRecharge(command); actualPay = recharge.actualPayCents; gift = recharge.giftCents; financial = applyFinancialCommand(member.balanceCents, recharge); }
        else if (command.type === 'consume') financial = applyFinancialCommand(member.balanceCents, createConsumption(command));
        else {
          const original = await one('SELECT * FROM ledger_entries WHERE store_id=? AND entry_id=? AND member_id=?', [storeId, command.originalEntryId, command.memberId]);
          if (!original) throw conflict('原流水不存在或不属于该会员', 'ORIGINAL_NOT_FOUND');
          if (await one('SELECT 1 FROM ledger_reversals WHERE store_id=? AND original_entry_id=?', [storeId, command.originalEntryId])) throw conflict('原流水已冲正', 'ALREADY_REVERSED');
          financial = createReversal({ originalKind: original.kind, originalDeltaCents: String(original.delta_cents), currentBalanceCents: member.balanceCents, allowDebt: command.allowDebt === true });
        }
        const at = now();
        if (member.archivedAt) {
          await requireAvailablePhone(member.phone, member.id);
          const profileVersion = versionOf(String(BigInt(member.version) + 1n));
          await run('UPDATE member_profiles SET archived_at=NULL,profile_version=?,updated_at=? WHERE store_id=? AND id=?', [profileVersion, at, storeId, member.id]);
          await audit(user, 'member_reactivated', member.id, at);
        }
        const payMethod = command.type === 'recharge' ? (command.payments ? (sale.payments.length === 1 ? sale.payments[0].method : '组合支付') : (command.payMethod ?? '').trim()) : '';
        const itemsSummary = command.type === 'consume' ? (command.itemsSummary ?? '消费').trim() : '';
        const remark = (command.type === 'reverse' ? command.reason ?? '店主手工撤销' : command.remark ?? '').trim();
        await run('INSERT INTO ledger_entries(store_id,entry_id,member_id,kind,account_version,delta_cents,balance_before_cents,balance_after_cents,actual_pay_cents,gift_cents,pay_method,items_summary,remark,actor_id,device_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [storeId, command.id, command.memberId, kind, nextVersion, financial.deltaCents, financial.balanceBeforeCents, financial.balanceAfterCents, actualPay, gift, payMethod, itemsSummary, remark, user.id, user.deviceId, at]);
        await sales.write(command.id, sale);
        await run('UPDATE member_accounts SET balance_cents=?,version=? WHERE store_id=? AND member_id=?', [financial.balanceAfterCents, nextVersion, storeId, command.memberId]);
        if (command.type === 'reverse') await run('INSERT INTO ledger_reversals VALUES(?,?,?,?)', [storeId, command.originalEntryId, command.id, command.reason ?? '']);
        await run('INSERT INTO command_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [storeId, command.id, requestHash, user.id, user.deviceId, command.memberId, kind, financial.deltaCents, financial.balanceBeforeCents, financial.balanceAfterCents, nextVersion, at, command.ledgerEpoch]);
        if (configuration) await run('INSERT INTO local_command_configurations VALUES(?,?,?)', [storeId, command.id, command.configurationVersion]);
        if (mode === 'cloud') await run('INSERT INTO sync_outbox(store_id,command_id,member_id,command_type,expected_account_version,actual_pay_cents,gift_cents,amount_cents,original_entry_id,reason,allow_debt,pay_method,items_summary,remark) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [storeId, command.id, command.memberId, command.type, command.expectedAccountVersion, command.actualPayCents ?? null, command.giftCents ?? null, command.amountCents ?? null, command.originalEntryId ?? null, command.reason ?? null, command.allowDebt === undefined ? null : command.allowDebt ? 1 : 0, command.payMethod ?? null, command.itemsSummary ?? null, command.remark ?? null]);
        if (mode === 'cloud') await sales.captureOutbox(command);
        if (mode === 'cloud' && command.expectedProfileVersion !== undefined) {
          await run('INSERT INTO outbox_profile_checks VALUES(?,?,?)', [storeId, command.id, command.expectedProfileVersion]);
        }
        await audit(user, 'ledger_' + kind, command.id, at);
        return { storeId, ledgerEpoch: command.ledgerEpoch, commandId: command.id, entryId: command.id, memberId: command.memberId, type: kind,
          deltaCents: financial.deltaCents, balanceBeforeCents: financial.balanceBeforeCents, balanceAfterCents: financial.balanceAfterCents, accountVersion: nextVersion, occurredAt: at };
      });
    },
    pendingCommands({ limit = 50 } = {}) {
      pageLimit(limit);
      return transaction('read', 'read', async user => {
        const { ledgerEpoch } = await book();
        const rows = await all('SELECT o.*,r.actor_id,r.device_id,r.ledger_epoch FROM sync_outbox o JOIN command_receipts r ON r.store_id=o.store_id AND r.command_id=o.command_id WHERE o.store_id=? ORDER BY o.rowid LIMIT ?', [storeId, limit]);
        return Promise.all(rows.map(async row => {
          const command = { storeId, ledgerEpoch: row.ledger_epoch, actorId: row.actor_id, deviceId: row.device_id, id: row.command_id, type: row.command_type, memberId: row.member_id, expectedAccountVersion: String(row.expected_account_version) };
          if (row.actor_id === user.id && row.device_id === user.deviceId) await extendCommand(command, row);
          const actorChanged = row.actor_id !== user.id || row.device_id !== user.deviceId;
          const epochChanged = row.ledger_epoch !== ledgerEpoch;
          return { command, status: actorChanged || epochChanged ? 'blocked' : row.status, errorCode: epochChanged ? 'LEDGER_EPOCH_MISMATCH' : actorChanged ? 'PENDING_ACTOR_CHANGED' : row.error_code };
        }));
      });
    },
    pendingSummaries({ limit = 25, targetEpoch = null } = {}) {
      pageLimit(limit); if (targetEpoch !== null) ledgerEpochOf(targetEpoch);
      return transaction('read', 'ledgerRead', async user => {
        return (await all('SELECT r.command_id,r.kind,r.member_id,r.ledger_epoch,r.balance_after_cents,r.occurred_at,o.error_code,o.status,r.actor_id,r.device_id,v.target_epoch AS reviewed_epoch ' +
          'FROM sync_outbox o JOIN command_receipts r ON r.store_id=o.store_id AND r.command_id=o.command_id ' +
          'LEFT JOIN replica_pending_reviews v ON v.store_id=r.store_id AND v.command_id=r.command_id AND v.source_epoch=r.ledger_epoch AND v.target_epoch=? ' +
          'WHERE o.store_id=? ORDER BY (v.target_epoch IS NOT NULL),(r.actor_id<>? OR r.device_id<>?),o.rowid LIMIT ?', [targetEpoch, storeId, user.id, user.deviceId, limit]))
          .map(row => row.actor_id !== user.id || row.device_id !== user.deviceId ? { id: row.command_id, status: 'blocked', errorCode: 'PENDING_ACTOR_CHANGED' } :
            { id: row.command_id, type: row.kind, memberId: row.member_id, ledgerEpoch: row.ledger_epoch, status: row.status,
              balanceAfterCents: String(row.balance_after_cents), occurredAt: row.occurred_at, errorCode: row.error_code, reviewedEpoch: row.reviewed_epoch });
      });
    },
    pendingDetails(id) {
      if (!COMMAND_ID.test(id ?? '')) throw invalid('待办号无效');
      return transaction('read', 'ledgerRead', user => originalPending(id, user));
    },
    pendingReviewDocument(input) {
      const request = checkReplicaReview(input);
      return transaction('read', 'ledgerRead', user => reviewEvidence(request, user));
    },
    recordPendingReview(input) {
      const request = checkReplicaReview(input), documentDigest = input.sha256;
      if (typeof documentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(documentDigest)) throw invalid('须提供已读回核验的外部原单摘要');
      return transaction('write', 'ledgerRead', async user => {
        const { ledgerEpoch } = await book();
        if (await hash(await reviewEvidence(request, user)) !== documentDigest) throw conflict('外部原单与本机原单不匹配', 'REPLICA_REVIEW_MISMATCH');
        const at = now(), target = request.targetEpoch, values = [storeId, request.id, ledgerEpoch, target];
        const prior = await one('SELECT resolution,document_digest FROM replica_pending_reviews WHERE store_id=? AND command_id=? AND source_epoch=? AND target_epoch=?', values);
        if (prior && (prior.resolution !== request.resolution || prior.document_digest !== documentDigest)) throw conflict('此原单已有不同的核对记录', 'REPLICA_REVIEW_MISMATCH');
        if (!prior) await run('INSERT INTO replica_pending_reviews VALUES(?,?,?,?,?,?,?,?,?)', [...values, user.id, user.deviceId, request.resolution, documentDigest, at]);
        if (!prior) await audit(user, 'replica_pending_reviewed', request.id, at);
        return { reviewed: true };
      });
    },
    listLedger({ memberId = '', kind = '', search = '', from, to, cursor = null, after = cursor, limit = 50 } = {}) {
      pageLimit(limit); if (memberId) validId(memberId); search = text(search, 128, '搜索内容');
      if (!['', 'recharge', 'consume', 'reversal'].includes(kind)) throw invalid('流水类型筛选无效');
      if (from !== undefined || to !== undefined) ({ from, to } = reportPeriod({ from, to }));
      return transaction('read', 'ledgerRead', async () => {
        const current = await book(), scope = pageCursor(after, current, ['ledger', memberId, kind, search, from ?? null, to ?? null]);
        const at = mode === 'cloud' ? 'COALESCE(c.occurred_at,e.occurred_at)' : 'e.occurred_at';
        const rows = await all('SELECT e.*,p.name AS member_name,r.reversal_entry_id,o.original_entry_id,c.occurred_at AS confirmed_at' +
          ' FROM ledger_entries e JOIN member_profiles p ON p.store_id=e.store_id AND p.id=e.member_id' +
          ' LEFT JOIN ledger_reversals r ON r.store_id=e.store_id AND r.original_entry_id=e.entry_id' +
          ' LEFT JOIN ledger_reversals o ON o.store_id=e.store_id AND o.reversal_entry_id=e.entry_id' +
          ' LEFT JOIN entry_confirmations c ON c.store_id=e.store_id AND c.entry_id=e.entry_id WHERE e.store_id=?' +
          (memberId ? ' AND e.member_id=?' : '') + (kind ? ' AND e.kind=?' : '') +
          (search ? ' AND (instr(lower(p.name),lower(?))>0 OR instr(p.phone,?)>0 OR instr(lower(e.items_summary),lower(?))>0 OR instr(e.entry_id,?)>0)' : '') +
          (from ? ' AND ' + at + '>=? AND ' + at + '<?' : '') + (after ? ' AND (e.occurred_at,e.entry_id)<(?,?)' : '') +
          ' ORDER BY e.occurred_at DESC,e.entry_id DESC LIMIT ?', [storeId, ...(memberId ? [memberId] : []), ...(kind ? [kind] : []),
            ...(search ? [search, search, search, search] : []), ...(from ? [from, to] : []), ...(after ? [after.at, after.id] : []), limit + 1]);
        const page = rows.slice(0, limit), details = await sales.read(page.map(row => row.entry_id));
        return { items: page.map(row => ({ id: row.entry_id, memberId: row.member_id, memberName: row.member_name, type: row.kind, accountVersion: String(row.account_version),
          deltaCents: String(row.delta_cents), balanceBeforeCents: String(row.balance_before_cents), balanceAfterCents: String(row.balance_after_cents), actualPayCents: String(row.actual_pay_cents), giftCents: String(row.gift_cents),
          payMethod: row.pay_method, itemsSummary: row.items_summary, remark: row.remark, occurredAt: row.occurred_at, confirmedAt: row.confirmed_at,
          reversed: Boolean(row.reversal_entry_id), reversalEntryId: row.reversal_entry_id, originalEntryId: row.original_entry_id, ...details.get(row.entry_id) })),
          nextCursor: rows.length > limit ? { at: page.at(-1).occurred_at, id: page.at(-1).entry_id, ledgerEpoch: current.ledgerEpoch, scope } : null };
      });
    },
    syncState() { return transaction('read', 'read', async () => ({ mode, ...await book(), cursor: String((await one('SELECT cursor FROM book_identity WHERE singleton=1')).cursor), pendingCount: Number((await one('SELECT count(*) AS n FROM sync_outbox WHERE store_id=?', [storeId])).n) })); },
    replicaReady() { return transaction('read', 'sync', async () => Boolean(await one('SELECT 1 AS ready FROM replica_readiness WHERE singleton=1 AND ledger_epoch=?', [(await book()).ledgerEpoch]))); },
    replicaWriteBlock() {
      return transaction('read', 'sync', async () => (await one('SELECT error_code FROM replica_write_block WHERE singleton=1'))?.error_code ?? null);
    },
    blockReplicaWrites(ledgerEpoch, errorCode) {
      if (mode !== 'cloud' || !['LEDGER_EPOCH_MISMATCH', 'LEDGER_EPOCH_REQUIRED', 'STORE_MISMATCH', 'CURSOR_AHEAD', 'CURSOR_HISTORY_INCOMPLETE'].includes(errorCode)) throw invalid('无效的副本写入阻断');
      return transaction('read', 'sync', async () => {
        requireLedgerEpoch(ledgerEpoch, (await book()).ledgerEpoch);
        await run('INSERT OR IGNORE INTO replica_write_block(singleton,ledger_epoch,error_code) VALUES(1,?,?)', [ledgerEpoch, errorCode]);
      });
    },
    rebuildReplica({ sourceEpoch, targetEpoch, chunks, verifyTarget, checkpoint = async () => {} }) {
      if (mode !== 'cloud') throw conflict('独立离线账本不能重建云端副本', 'WRONG_AUTHORITY');
      ledgerEpochOf(sourceEpoch); ledgerEpochOf(targetEpoch);
      if (typeof verifyTarget !== 'function') throw invalid('提交前须复查云端账本水位');
      return transaction('owner', 'sync', async user => {
        requireLedgerEpoch(sourceEpoch, (await book()).ledgerEpoch); await replicaFence(sourceEpoch, targetEpoch); await checkpoint();
        const unreviewed = await one('SELECT o.command_id FROM sync_outbox o JOIN command_receipts r ON r.store_id=o.store_id AND r.command_id=o.command_id ' +
          'LEFT JOIN replica_pending_reviews v ON v.store_id=r.store_id AND v.command_id=r.command_id AND v.source_epoch=r.ledger_epoch AND v.target_epoch=? ' +
          'AND v.actor_id=r.actor_id AND v.device_id=r.device_id WHERE o.store_id=? AND (v.command_id IS NULL OR r.ledger_epoch<>?) LIMIT 1', [targetEpoch, storeId, sourceEpoch]);
        if (unreviewed) throw conflict('还有原待办未核对和保存，不能覆盖本机副本', 'REPLICA_PENDING_REVIEW');
        const previous = (await one('SELECT cursor FROM book_identity WHERE singleton=1')).cursor;
        // The files for reviewed outbox rows have already been written and read
        // back. The immutable review metadata stays in this SQLite database.
        // Nothing is cleared if the replacement stream or COMMIT fails.
        // Only this fenced cloud transaction replaces projections. Suspend
        // delete triggers for the clear and restore them before reading bytes.
        // The schema changes and data changes roll back together.
        for (const { name } of replicaProjectionDeleteTriggers) await driver.exec('DROP TRIGGER ' + name);
        for (const table of replicaProjectionTables) await run('DELETE FROM ' + table + ' WHERE store_id=?', [storeId]);
        for (const { sql } of replicaProjectionDeleteTriggers) await driver.exec(sql);
        let head, configured = false;
        const result = await readRelationalArchive({ chunks, tables: REPLICA_TABLES, ...REPLICA_FORMAT, storeId, hash, validateRow: validateReplicaRow, checkpoint,
          onHeader: header => requireLedgerEpoch(targetEpoch, header.ledgerEpoch),
          async onRows(table, rows) {
            for (const { value } of rows) {
              await checkpoint();
              if (table === 'head') {
                if (head !== undefined) throw invalid('云端副本水位重复');
                versionOf(value, '云端副本水位'); head = value;
              } else {
                if (table === 'configuration') {
                  if (configured) throw invalid('云端副本配置重复');
                  configured = true;
                }
                await applyReplicaEntity({ entityType: table, value }, true);
              }
            }
          }
        });
        if (head === undefined || !configured || sourceEpoch === targetEpoch && BigInt(head) < BigInt(previous)) throw conflict('云端副本水位或配置不完整', 'REPLICA_SNAPSHOT_INVALID');
        await linkReplicaReversals(); await verifyReplicaBalances(); await checkpoint();
        await run('UPDATE book_identity SET ledger_epoch=?,cursor=? WHERE singleton=1', [targetEpoch, head]);
        await run('UPDATE replica_origin SET current_epoch=? WHERE singleton=1', [targetEpoch]);
        await run('INSERT OR REPLACE INTO replica_readiness VALUES(1,?)', [targetEpoch]);
        await run('DELETE FROM replica_write_block WHERE singleton=1');
        await audit(user, 'replica_rebuilt', targetEpoch, now());
        // A restore after the download started can invalidate a complete stream.
        await verifyTarget(head); await checkpoint();
        return { storeId, ledgerEpoch: targetEpoch, cursor: head, memberCount: result.rowCounts.member, entryCount: result.rowCounts.ledger };
      });
    },
    applyChanges(page) {
      if (mode !== 'cloud') throw conflict('独立离线账本不能接收云端覆盖', 'WRONG_AUTHORITY');
      if (!page || page.storeId !== storeId || !Array.isArray(page.items) || page.items.length > 100) throw invalid('增量页面或门店归属无效');
      ledgerEpochOf(page.ledgerEpoch);
      versionOf(page.cursor, '同步游标'); versionOf(page.head, '同步水位');
      const captured = JSON.parse(JSON.stringify(page));
      return transaction('read', 'sync', async () => {
        requireLedgerEpoch(captured.ledgerEpoch, (await book()).ledgerEpoch);
        let cursor = BigInt((await one('SELECT cursor FROM book_identity WHERE singleton=1')).cursor);
        if (BigInt(captured.head) < BigInt(captured.cursor)) throw conflict('同步页面水位无效', 'CURSOR_CONFLICT');
        if (captured.hasMore === false && captured.cursor !== captured.head) throw conflict('服务器增量页面提前结束', 'CURSOR_CONFLICT');
        const ready = () => run('INSERT OR IGNORE INTO replica_readiness(singleton,ledger_epoch) VALUES(1,?)', [captured.ledgerEpoch]);
        if (BigInt(captured.cursor) <= cursor) {
          if (captured.hasMore === false && BigInt(captured.cursor) === cursor && !captured.items.length) await ready();
          return { cursor: String(cursor), alreadyApplied: true };
        }
        for (const item of captured.items) {
          versionOf(item.cursor, '变更游标');
          if (BigInt(item.cursor) !== cursor + 1n || !['member', 'ledger', 'configuration'].includes(item.entityType) || !item.value || item.value.id !== item.entityId) throw conflict('同步页面不连续或实体无效', 'CURSOR_CONFLICT');
          await applyReplicaEntity(item);
          cursor = BigInt(item.cursor);
        }
        if (cursor !== BigInt(captured.cursor)) throw conflict('页面结束游标与变更不一致', 'CURSOR_CONFLICT');
        if (captured.items.some(item => item.entityType === 'ledger')) await linkReplicaReversals();
        await run('UPDATE book_identity SET cursor=? WHERE singleton=1', [captured.cursor]);
        if (captured.hasMore === false) await ready();
        return { cursor: captured.cursor };
      });
    },
    acknowledge(commandId, result) {
      return transaction('read', 'sync', async user => {
        requireLedgerEpoch(result?.ledgerEpoch, (await book()).ledgerEpoch);
        const row = await one('SELECT * FROM command_receipts WHERE store_id=? AND command_id=?', [storeId, commandId]);
        if (!row) throw conflict('本地命令不存在', 'COMMAND_NOT_FOUND');
        if (row.actor_id !== user.id || row.device_id !== user.deviceId) throw conflict('须使用原账号和设备核对', 'PENDING_ACTOR_CHANGED');
        const expected = receiptResult(row);
        for (const field of ['storeId', 'ledgerEpoch', 'commandId', 'entryId', 'memberId', 'type', 'deltaCents', 'balanceBeforeCents', 'balanceAfterCents', 'accountVersion']) if (result?.[field] !== expected[field]) throw conflict('服务器回执与本地资金效果不一致，须核对', 'RECEIPT_MISMATCH');
        await run('DELETE FROM sync_outbox WHERE store_id=? AND command_id=?', [storeId, commandId]); return { success: true };
      });
    },
    markConflict(commandId, code = 'SYNC_CONFLICT') {
      if (typeof code !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(code)) throw invalid('冲突代码无效');
      return transaction('read', 'sync', async user => {
        const row = await one('SELECT actor_id,device_id FROM command_receipts WHERE store_id=? AND command_id=?', [storeId, commandId]);
        if (!row || row.actor_id !== user.id || row.device_id !== user.deviceId) throw conflict('须使用原账号和设备核对', 'PENDING_ACTOR_CHANGED');
        await run('UPDATE sync_outbox SET status=\'conflict\',error_code=? WHERE store_id=? AND command_id=?', [code, storeId, commandId]); return { success: true };
      });
    },
    async close() {
      await tail;
      if (!closed) {
        closed = true; initialized = false;
        try { await Promise.all([...snapshots].map(snapshot => snapshot.close())); } finally { await driver.close(); }
      }
    }
  };
  return api;
}
