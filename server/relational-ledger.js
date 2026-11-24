import { randomUUID } from 'node:crypto';
import { ApiError, digest } from './security.js';
import { canonicalJSON } from '../src/canonical-json.js';
import { applyFinancialCommand, createConsumption, createRecharge, createReversal, parseCents } from '../src/ledger-domain.js';
import { memberInput, normalizeOpeningInput, validateFinancialCommand as validateCommand, versionOf, text, phoneIdentity, batchNames } from '../src/relational-contract.js';
import { requireFeature, requireOperation } from './entitlements.js';
import { prepareSale } from '../src/relational-sales.js';
import { createConfigurationService, readConfiguration, readSales, writeSale } from './relational-sales.js';
import { createReportService, reportPeriod } from './relational-reports.js';
import { taskRequest } from '../src/relational-tasks.js';
import { createTaskRunner } from './relational-tasks.js';
import { ledgerEpochOf, requireLedgerEpoch } from '../src/ledger-epoch.js';
import { createBackupService } from './relational-backup.js';
import { archiveLifetime, createArchiveService } from './relational-archive.js';
import { writeRelationalArchive } from '../src/relational-archive.js';
import { REPLICA_FORMAT, REPLICA_TABLES, validateReplicaRow } from '../src/relational-replica.js';
import { createBatchService } from './relational-batches.js';
import { openingPayload, openingSummary, checkOpeningScope } from '../src/relational-opening-contract.js';

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const COMMAND_ID = /^[a-zA-Z0-9-]{16,80}$/;
const VOICE_ID = /^voice-[0-9a-f]{64}$/;
// This error is raised only by checks before the first financial write. SQL,
// audit and commit errors must escape to the webhook's transaction boundary.
class VoicePreviewStale extends ApiError {
  constructor(message) { super(409, message, 'VOICE_PREVIEW_STALE'); }
}
function normalizedPhone(phone) { return phone.replace(/[^0-9+]/g, ''); }
function encodeCursor(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeCursor(value) {
  if (!value) return null;
  try {
    if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!cursor || typeof cursor.at !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(cursor.at) ||
        !Number.isFinite(Date.parse(cursor.at)) || typeof cursor.id !== 'string' || !ID.test(cursor.id) || !/^[0-9a-f]{64}$/.test(cursor.scope || '')) throw new Error();
    const [year, month, day] = cursor.at.slice(0, 10).split('-').map(Number), calendar = new Date(Date.UTC(year, month - 1, day));
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) throw new Error();
    return { at: cursor.at, id: cursor.id, scope: cursor.scope, ledgerEpoch: ledgerEpochOf(cursor.ledgerEpoch) };
  } catch { throw new ApiError(400, '分页游标无效'); }
}
function pageScope(user, cursor, ledgerEpoch, dimensions) {
  const scope = digest(canonicalJSON([user.store_id, ...dimensions]));
  if (ledgerEpoch !== undefined) requireLedgerEpoch(ledgerEpoch, user.ledger_epoch);
  if (cursor) {
    requireLedgerEpoch(cursor.ledgerEpoch, user.ledger_epoch);
    if (cursor.scope !== scope) throw new ApiError(400, '分页条件已变化，请从第一页开始', 'CURSOR_SCOPE_MISMATCH');
  }
  return scope;
}
function limitOf(value, fallback = 50) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^[1-9][0-9]{0,2}$/.test(String(value)) || Number(value) > 100) throw new ApiError(400, '每页数量须为 1–100');
  return Number(value);
}
function publicMember(row, tags = []) {
  return { id: row.id, name: row.name, phone: row.phone, notes: row.notes, tags,
    balanceCents: String(row.balance_cents), version: String(row.profile_version), accountVersion: String(row.account_version ?? 0),
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null };
}
function openingRows(input) {
  const batch = normalizeOpeningInput(input);
  const payloadDigest = digest(openingPayload(batch));
  return { ...batch, payloadDigest, rows: batch.rows.map(row => ({ ...row, rowDigest: digest(canonicalJSON(row)), phoneNormalized: normalizedPhone(row.phone) })) };
}

export function previewOpeningImport(input) {
  const batch = openingRows(input);
  return { ...openingSummary(batch, batch.payloadDigest),
    members: batch.rows.map(({ rowDigest, phoneNormalized, ...member }) => member) };
}
const openingScope = user => ({ storeId: user.store_id, actorId: user.id, deviceId: user.device_id, ledgerEpoch: user.ledger_epoch });
const openingCapture = input => Object.fromEntries(['storeId', 'actorId', 'deviceId', 'payloadDigest'].map(key => [key, input[key]]));

function publicEntry(row) {
  return { id: row.entry_id, memberId: row.member_id, type: row.kind, accountVersion: String(row.account_version),
    deltaCents: String(row.delta_cents), balanceBeforeCents: String(row.balance_before_cents), balanceAfterCents: String(row.balance_after_cents),
    actualPayCents: String(row.actual_pay_cents), giftCents: String(row.gift_cents), payMethod: row.pay_method,
    itemsSummary: row.items_summary, remark: row.remark, occurredAt: new Date(row.occurred_at).toISOString(),
    reversed: Boolean(row.reversal_entry_id), reversalEntryId: row.reversal_entry_id ?? null,
    ...(row.member_name === undefined ? {} : { memberName: row.member_name, originalEntryId: row.original_entry_id ?? null }) };
}
export function createRelationalLedger({ withAuthorized, audit }) {
  const withTask = createTaskRunner({ withAuthorized, audit });
  async function syncHead(client, storeId) {
    const { rows: [row] } = await client.query('SELECT head FROM store_change_heads WHERE store_id=$1', [storeId]);
    return String(row?.head ?? 0);
  }
  async function memberProjection(client, storeId, rows) {
    const tags = await memberTags(client, storeId, rows.map(row => row.id));
    return rows.map(row => ({ ...publicMember(row, tags.get(row.id)), openingBalanceCents: row.opening_balance_cents === null ? null : String(row.opening_balance_cents) }));
  }
  async function ledgerProjection(client, storeId, rows) {
    const sales = await readSales(client, storeId, rows.map(row => row.entry_id));
    return rows.map(row => ({ ...publicEntry(row), ...sales.get(row.entry_id) }));
  }
  const memberSelect = 'SELECT m.*,a.balance_cents,a.version AS account_version,o.opening_balance_cents ' +
    'FROM member_profiles m JOIN member_accounts a ON a.store_id=m.store_id AND a.member_id=m.id ' +
    'LEFT JOIN account_openings o ON o.store_id=m.store_id AND o.member_id=m.id WHERE m.store_id=$1';
  const ledgerSelect = 'SELECT e.*,r.reversal_entry_id FROM ledger_entries e ' +
    'LEFT JOIN ledger_reversals r ON r.store_id=e.store_id AND r.original_entry_id=e.entry_id WHERE e.store_id=$1';
  async function recordChange(client, storeId, entityType, entityId, changeType = 'upsert') {
    const { rows: [head] } = await client.query(`INSERT INTO store_change_heads(store_id,head) VALUES($1,1)
      ON CONFLICT(store_id) DO UPDATE SET head=store_change_heads.head+1 RETURNING head`, [storeId]);
    await client.query('INSERT INTO store_changes(store_id,cursor,entity_type,entity_id,change_type) VALUES($1,$2,$3,$4,$5)',
      [storeId, head.head, entityType, entityId, changeType]);
    return String(head.head);
  }
  async function memberTags(client, storeId, ids) {
    if (!ids.length) return new Map();
    const { rows } = await client.query('SELECT member_id,tag FROM member_tags WHERE store_id=$1 AND member_id=ANY($2::text[]) ORDER BY tag COLLATE "C"', [storeId, ids]);
    const result = new Map(ids.map(id => [id, []]));
    for (const row of rows) result.get(row.member_id).push(row.tag);
    return result;
  }
  async function requireAvailablePhone(client, storeId, phone, memberId = '') {
    const normalized = phoneIdentity(phone);
    if (!normalized) return;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [storeId, 'active-member-phone:' + normalized]);
    const { rows } = await client.query("SELECT 1 FROM member_profiles WHERE store_id=$1 AND replace(phone_normalized,'+','')=$2 AND id<>$3 AND archived_at IS NULL LIMIT 1",
      [storeId, normalized, memberId]);
    if (rows.length) throw new ApiError(409, '该手机号已用于其他在用会员，请先核对原档案', 'MEMBER_PHONE_IN_USE');
  }
  async function lockAccount(client, storeId, memberId, { voicePreview, modifyProfile = false, allowArchived = false } = {}) {
    const { rows: [account] } = await client.query('SELECT member_id,balance_cents,version FROM member_accounts WHERE store_id=$1 AND member_id=$2 FOR UPDATE', [storeId, memberId]);
    if (!account && voicePreview) throw new VoicePreviewStale('会员已变化，请重新发起操作并确认');
    if (!account) throw new ApiError(404, '会员不存在', 'WRITE_MEMBER_NOT_FOUND');
    const { rows: [profile] } = await client.query('SELECT phone,profile_version,archived_at FROM member_profiles WHERE store_id=$1 AND id=$2' +
      (modifyProfile ? ' FOR NO KEY UPDATE' : ' FOR SHARE'), [storeId, memberId]);
    if (voicePreview && (profile.archived_at || String(profile.profile_version) !== voicePreview.expectedProfileVersion)) {
      throw new VoicePreviewStale('会员资料已变化，请重新发起操作并确认');
    }
    if (profile.archived_at && !allowArchived) throw new ApiError(409, '会员已归档，不能记账', 'WRITE_MEMBER_ARCHIVED');
    return { ...account, profile };
  }
  async function applyCommand(client, user, command, voicePreview) {
    const requestHash = digest(canonicalJSON(voicePreview ? { command, expectedProfileVersion: voicePreview.expectedProfileVersion } : command));
    if (command.storeId !== user.store_id) throw new ApiError(403, '命令门店与当前身份不匹配', 'FORBIDDEN');
    requireLedgerEpoch(command.ledgerEpoch, user.ledger_epoch);
    if (command.actorId !== undefined && command.actorId !== user.id || command.deviceId !== undefined && command.deviceId !== user.device_id) throw new ApiError(403, '命令账号或设备与当前身份不匹配', 'FORBIDDEN');
    const operation = command.type === 'reverse' ? 'refundLedger' : command.type;
    requireOperation(user.entitlements, operation);
    // A command lock handles duplicate IDs even when conflicting requests
    // name different accounts. Receipts are inserted complete and immutable.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [user.store_id, command.id]);
    const { rows: [receipt] } = await client.query('SELECT actor_id,device_id,request_hash,ledger_epoch,result FROM ledger_command_receipts WHERE store_id=$1 AND command_id=$2', [user.store_id, command.id]);
    if (receipt) {
      if (receipt.ledger_epoch !== command.ledgerEpoch) throw new ApiError(409, '命令属于其他或未标记代际，须保留并核对', 'LEDGER_EPOCH_MISMATCH');
      if (receipt.actor_id !== user.id || receipt.device_id !== user.device_id || receipt.request_hash !== requestHash) throw new ApiError(409, '同一命令号对应不同内容、账号或设备', 'COMMAND_CONFLICT');
      return receipt.result;
    }
    const configuration = command.type === 'reverse' ? null : await readConfiguration(client, user.store_id, { lock: true });
    if (voicePreview && configuration.version !== command.configurationVersion) throw new VoicePreviewStale('服务或充值规则已变化，请重新发起操作并确认');
    const sale = prepareSale(command, configuration);
    if (command.type === 'reverse') {
      const { rows: [entry] } = await client.query('SELECT member_id FROM ledger_entries WHERE store_id=$1 AND entry_id=$2', [user.store_id, command.originalEntryId]);
      if (!entry) throw new ApiError(404, '原流水不存在', 'ORIGINAL_ENTRY_NOT_FOUND');
      if (entry.member_id !== command.memberId) throw new ApiError(409, '原流水不属于该会员', 'ORIGINAL_ENTRY_MISMATCH');
    }
    const reversing = command.type === 'reverse';
    const account = await lockAccount(client, user.store_id, command.memberId, { voicePreview, allowArchived: reversing, modifyProfile: reversing });
    if (command.expectedProfileVersion !== undefined && String(account.profile.profile_version) !== command.expectedProfileVersion) {
      throw new ApiError(409, '会员资料已变化，请重新加载并核对', 'MEMBER_VERSION_CHANGED');
    }
    if (voicePreview && String(account.version) !== command.expectedAccountVersion) throw new VoicePreviewStale('余额已变化，请重新发起操作并确认');
    if (voicePreview && Date.now() >= voicePreview.expiresAt) throw new VoicePreviewStale('语音预览已过期，请重新发起操作并确认');
    if (String(account.version) !== command.expectedAccountVersion) throw new ApiError(409, '资金账户已变化，请重新加载并核对', 'ACCOUNT_VERSION_CHANGED');
    const nextVersion = (BigInt(account.version) + 1n).toString();
    try { parseCents(nextVersion, '资金账户版本'); } catch (error) { throw new ApiError(409, error.message); }
    let financial, kind, actualPay = '0', gift = '0', payMethod = '', itemsSummary = '', remark = '';
    if (command.type === 'recharge') {
      financial = createRecharge(command); kind = 'recharge'; actualPay = financial.actualPayCents; gift = financial.giftCents;
      payMethod = command.payments ? (sale.payments.length === 1 ? sale.payments[0].method : '组合支付') : text(command.payMethod ?? '', 64, '付款方式'); remark = text(command.remark ?? '', 4096, '备注');
    } else if (command.type === 'consume') {
      financial = createConsumption(command); kind = 'consume'; itemsSummary = text(command.itemsSummary ?? '消费', 512, '消费项目');
      remark = text(command.remark ?? '', 4096, '备注');
    } else {
      const { rows: [source] } = await client.query(`SELECT kind,delta_cents FROM ledger_entries
        WHERE store_id=$1 AND entry_id=$2 AND member_id=$3`, [user.store_id, command.originalEntryId, command.memberId]);
      if (!source) throw new ApiError(409, '原流水已变化或不属于该会员');
      if (source.kind === 'reversal') throw new ApiError(409, '不能撤销一笔冲正', 'ORIGINAL_ENTRY_REVERSAL');
      const { rows: existing } = await client.query('SELECT 1 FROM ledger_reversals WHERE store_id=$1 AND original_entry_id=$2', [user.store_id, command.originalEntryId]);
      if (existing.length) throw new ApiError(409, '该流水已撤销', 'ALREADY_REVERSED');
      try { financial = createReversal({ originalKind: source.kind, originalDeltaCents: String(source.delta_cents), currentBalanceCents: String(account.balance_cents), allowDebt: command.allowDebt === true }); }
      catch (error) { throw new ApiError(400, error.message, 'REVERSAL_REJECTED'); }
      kind = 'reversal'; remark = text(command.reason ?? '店主手工撤销', 4096, '撤销原因');
    }
    if (command.type !== 'reverse') {
      try { financial = applyFinancialCommand(String(account.balance_cents), financial); }
      catch (error) { throw new ApiError(409, error.message, 'BALANCE_CONFLICT'); }
    }
    if (financial.deltaCents === '0') throw new ApiError(400, '资金变化不能为零');
    if (account.profile.archived_at) {
      await requireAvailablePhone(client, user.store_id, account.profile.phone, command.memberId);
      await client.query('UPDATE member_profiles SET archived_at=NULL,profile_version=profile_version+1,updated_at=now() WHERE store_id=$1 AND id=$2',
        [user.store_id, command.memberId]);
      await audit(client, user, 'member_reactivated', { memberId: command.memberId });
    }
    const { rows: [entry] } = await client.query(`INSERT INTO ledger_entries(store_id,entry_id,member_id,kind,delta_cents,balance_before_cents,balance_after_cents,
      actual_pay_cents,gift_cents,pay_method,items_summary,remark,actor_id,device_id,account_version,occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,clock_timestamp()) RETURNING occurred_at`,
      [user.store_id, command.id, command.memberId, kind, financial.deltaCents, financial.balanceBeforeCents, financial.balanceAfterCents,
        actualPay, gift, payMethod, itemsSummary, remark, user.id, user.device_id, nextVersion]);
    await writeSale(client, user.store_id, command.id, sale);
    await client.query('UPDATE member_accounts SET balance_cents=$1,version=version+1,updated_at=now() WHERE store_id=$2 AND member_id=$3',
      [financial.balanceAfterCents, user.store_id, command.memberId]);
    if (command.type === 'reverse') {
      await client.query('INSERT INTO ledger_reversals(store_id,original_entry_id,reversal_entry_id,reason) VALUES($1,$2,$3,$4)',
        [user.store_id, command.originalEntryId, command.id, remark]);
      await recordChange(client, user.store_id, 'ledger', command.originalEntryId);
    }
    await recordChange(client, user.store_id, 'ledger', command.id);
    const cursor = await recordChange(client, user.store_id, 'member', command.memberId);
    const result = { storeId: user.store_id, ledgerEpoch: command.ledgerEpoch, commandId: command.id, entryId: command.id, memberId: command.memberId, type: kind,
      deltaCents: financial.deltaCents, balanceBeforeCents: financial.balanceBeforeCents, balanceAfterCents: financial.balanceAfterCents,
      accountVersion: nextVersion, occurredAt: new Date(entry.occurred_at).toISOString(), cursor };
    await client.query(`INSERT INTO ledger_command_receipts(store_id,command_id,actor_id,device_id,request_hash,command_type,result,ledger_epoch)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [user.store_id, command.id, user.id, user.device_id, requestHash, command.type, result, command.ledgerEpoch]);
    await audit(client, user, 'ledger_' + kind, { commandId: command.id, memberId: command.memberId, entryId: command.id,
      ...(voicePreview ? { source: 'voice' } : {}) });
    return result;
  }
  const api = {
    getBook(identity) {
      return withAuthorized(identity, 'read', async (_client, user) => ({ storeId: user.store_id, ledgerEpoch: user.ledger_epoch }));
    },
    getExportWatermark(identity, { ledgerEpoch }) {
      ledgerEpochOf(ledgerEpoch);
      return withAuthorized(identity, 'owner', async (client, user) => {
        requireLedgerEpoch(ledgerEpoch, user.ledger_epoch);
        return { storeId: user.store_id, ledgerEpoch, cursor: await syncHead(client, user.store_id) };
      }, { consistentRead: true });
    },
    ...createConfigurationService({ withAuthorized, withTask, audit, recordChange }),
    ...createReportService({ withAuthorized }),
    ...createBackupService({ withAuthorized, audit }),
    ...createArchiveService({ withAuthorized, audit }),
    ...createBatchService({ withAuthorized, audit, executeTask: (identity, request) => api.executeTask(identity, request) }),
    async executeTask(identity, input) {
      const request = taskRequest(input), { id, storeId, ledgerEpoch, actorId, deviceId } = request, metadata = { id, storeId, ledgerEpoch, actorId, deviceId };
      if (request.type === 'member.create') return api.createMember(identity, request.data, metadata);
      if (request.type === 'member.update') return api.updateMember(identity, request.memberId, request.data, metadata);
      if (request.type === 'member.archive') return api.archiveMember(identity, request.memberId, metadata);
      return api.updateConfiguration(identity, request.data, metadata);
    },
    getTask(identity, id, { ledgerEpoch } = {}) {
      ledgerEpochOf(ledgerEpoch);
      if (typeof id !== 'string' || !COMMAND_ID.test(id)) throw new ApiError(400, '任务号无效');
      return withAuthorized(identity, 'read', async (client, user) => {
        requireLedgerEpoch(ledgerEpoch, user.ledger_epoch);
        const { rows: [row] } = await client.query('SELECT task_type,result,completed_at,ledger_epoch FROM application_task_receipts WHERE store_id=$1 AND task_id=$2 AND actor_id=$3 AND device_id=$4', [user.store_id, id, user.id, user.device_id]);
        if (!row) throw new ApiError(404, '未找到当前身份的已提交任务', 'TASK_NOT_FOUND');
        if (row.ledger_epoch !== ledgerEpoch) throw new ApiError(409, '任务属于其他或未标记代际，须保留并核对', 'LEDGER_EPOCH_MISMATCH');
        return { ledgerEpoch, taskId: id, type: row.task_type, result: row.result, completedAt: new Date(row.completed_at).toISOString() };
      });
    },
    async getCommand(identity, id, { ledgerEpoch } = {}) {
      ledgerEpochOf(ledgerEpoch);
      if (!COMMAND_ID.test(id || '')) throw new ApiError(400, '命令号无效');
      return withAuthorized(identity, 'read', async (client, user) => {
        requireLedgerEpoch(ledgerEpoch, user.ledger_epoch);
        const { rows: [receipt] } = await client.query('SELECT result,ledger_epoch FROM ledger_command_receipts WHERE store_id=$1 AND command_id=$2 AND actor_id=$3 AND device_id=$4', [user.store_id, id, user.id, user.device_id]);
        if (!receipt) throw new ApiError(404, '未找到已提交的命令回执', 'COMMAND_NOT_FOUND');
        if (receipt.ledger_epoch !== ledgerEpoch) throw new ApiError(409, '命令属于其他或未标记代际，须保留并核对', 'LEDGER_EPOCH_MISMATCH');
        return receipt.result;
      });
    },
    async changes(identity, { after = '0', limit: requestedLimit, ledgerEpoch } = {}) {
      ledgerEpochOf(ledgerEpoch);
      versionOf(after, '同步游标'); const limit = limitOf(requestedLimit);
      return withAuthorized(identity, 'read', async (client, user) => {
        requireLedgerEpoch(ledgerEpoch, user.ledger_epoch);
        const headValue = await syncHead(client, user.store_id);
        if (BigInt(after) > BigInt(headValue)) throw new ApiError(409, '同步游标超过当前账本水位，请核对账本归属', 'CURSOR_AHEAD');
        const { rows: changes } = await client.query('SELECT cursor,entity_type,entity_id,change_type FROM store_changes WHERE store_id=$1 AND cursor>$2 AND cursor<=$3 ORDER BY cursor LIMIT $4', [user.store_id, after, headValue, limit]);
        if (changes.some((row, index) => BigInt(row.cursor) !== BigInt(after) + BigInt(index + 1)) ||
          changes.length < limit && BigInt(after) + BigInt(changes.length) !== BigInt(headValue)) {
          throw new ApiError(409, '同步历史不完整，请保留本机账本并由店主核对', 'CURSOR_HISTORY_INCOMPLETE');
        }
        const memberIds = [...new Set(changes.filter(row => row.entity_type === 'member').map(row => row.entity_id))];
        const entryIds = [...new Set(changes.filter(row => row.entity_type === 'ledger').map(row => row.entity_id))];
        const { rows: members } = await client.query(memberSelect + ' AND m.id=ANY($2::text[])', [user.store_id, memberIds]);
        const { rows: entries } = await client.query(ledgerSelect + ' AND e.entry_id=ANY($2::text[])', [user.store_id, entryIds]);
        const memberMap = new Map((await memberProjection(client, user.store_id, members)).map(row => [row.id, row]));
        const entryMap = new Map((await ledgerProjection(client, user.store_id, entries)).map(row => [row.id, row]));
        const configuration = changes.some(row => row.entity_type === 'configuration') ? await readConfiguration(client, user.store_id) : null;
        const next = String(changes.at(-1)?.cursor ?? after);
        return { storeId: user.store_id, ledgerEpoch, head: headValue, cursor: next, hasMore: BigInt(next) < BigInt(headValue), items: changes.map(row => ({
          cursor: String(row.cursor), entityType: row.entity_type, entityId: row.entity_id, changeType: row.change_type,
          value: row.entity_type === 'member' ? memberMap.get(row.entity_id) : row.entity_type === 'ledger' ? entryMap.get(row.entity_id) : row.entity_type === 'configuration' ? { id: 'store', ...configuration } : null
        })) };
      }, { consistentRead: true });
    },
    async exportReplica(identity, { ledgerEpoch, write, signal }) {
      ledgerEpochOf(ledgerEpoch);
      const life = archiveLifetime(signal);
      try {
        return await withAuthorized(identity, 'owner', async (client, user) => {
          requireLedgerEpoch(ledgerEpoch, user.ledger_epoch); life.check(user);
          const storeId = user.store_id, head = await syncHead(client, storeId);
          let heartbeat = Date.now();
          const checkpoint = async () => {
            life.check(user);
            if (Date.now() - heartbeat > 5000) { await client.query('SELECT 1'); heartbeat = Date.now(); life.check(user); }
          };
          async function* readTable(table) {
            if (table === 'head') { yield [{ value: head }]; return; }
            if (table === 'configuration') { yield [{ value: { id: 'store', ...await readConfiguration(client, storeId) } }]; return; }
            const member = table === 'member', key = member ? 'm.id' : 'e.entry_id';
            let after = '';
            for (;;) {
              await checkpoint();
              const { rows } = await client.query((member ? memberSelect : ledgerSelect) + ' AND ' + key + '>$2 ORDER BY ' + key + ' LIMIT 100', [storeId, after]);
              if (!rows.length) break;
              const values = await (member ? memberProjection : ledgerProjection)(client, storeId, rows);
              yield values.map(value => ({ value }));
              if (rows.length < 100) break;
              after = values.at(-1).id;
            }
          }
          return writeRelationalArchive({ header: { kind: 'header', format: 'member-relational-stream', formatVersion: 1, ...REPLICA_FORMAT,
            storeId, ledgerEpoch, exportedAt: new Date().toISOString() }, tables: REPLICA_TABLES, readTable, hash: digest,
            validateRow: validateReplicaRow, checkpoint, write: line => life.wait(() => write(line)) });
        }, { consistentRead: true });
      } finally { life.close(); }
    },
    async report(identity, { from, to, ledgerEpoch } = {}) {
      ({ from, to } = reportPeriod({ from, to }));
      return withAuthorized(identity, 'read', async (client, user) => {
        requireFeature(user.entitlements, 'reports');
        if (ledgerEpoch !== undefined) requireLedgerEpoch(ledgerEpoch, user.ledger_epoch);
        const { rows: [accounts] } = await client.query(`SELECT count(*)::int AS member_count,
          COALESCE(sum(CASE WHEN balance_cents>0 THEN balance_cents ELSE 0 END),0)::text AS stored_cents,
          COALESCE(sum(CASE WHEN balance_cents<0 THEN balance_cents ELSE 0 END),0)::text AS debt_cents
          FROM member_accounts WHERE store_id=$1`, [user.store_id]);
        const { rows: [period] } = await client.query(`SELECT count(*)::int AS entry_count,
          COALESCE(sum(e.delta_cents),0)::text AS net_change_cents,
          COALESCE(sum(e.actual_pay_cents),0)::text AS actual_pay_cents,
          COALESCE(sum(e.gift_cents),0)::text AS gift_cents,
          COALESCE(sum(CASE WHEN e.kind='consume' THEN -e.delta_cents ELSE 0 END),0)::text AS consumption_cents,
          COALESCE(sum(CASE WHEN e.kind='reversal' THEN e.delta_cents ELSE 0 END),0)::text AS reversal_delta_cents
          FROM ledger_entries e WHERE e.store_id=$1 AND e.occurred_at>=$2::timestamptz AND e.occurred_at<$3::timestamptz`, [user.store_id, from, to]);
        const { rows: [reversed] } = await client.query(`SELECT COALESCE(sum(o.actual_pay_cents),0)::text AS actual_pay_cents,COALESCE(sum(o.gift_cents),0)::text AS gift_cents,
          COALESCE(sum(CASE WHEN o.kind='consume' THEN -o.delta_cents::numeric ELSE 0 END),0)::text AS consumption_cents
          FROM ledger_entries e JOIN ledger_reversals r ON r.store_id=e.store_id AND r.reversal_entry_id=e.entry_id JOIN ledger_entries o ON o.store_id=r.store_id AND o.entry_id=r.original_entry_id
          WHERE e.store_id=$1 AND e.occurred_at>=$2::timestamptz AND e.occurred_at<$3::timestamptz`, [user.store_id, from, to]);
        return { from, to, memberCount: accounts.member_count, storedCents: accounts.stored_cents, debtCents: accounts.debt_cents,
          entryCount: period.entry_count, netChangeCents: period.net_change_cents, actualPayCents: period.actual_pay_cents,
          giftCents: period.gift_cents, consumptionCents: period.consumption_cents, reversalDeltaCents: period.reversal_delta_cents,
          reversedActualPayCents: reversed.actual_pay_cents, reversedGiftCents: reversed.gift_cents, reversedConsumptionCents: reversed.consumption_cents,
          netActualPayCents: String(BigInt(period.actual_pay_cents) - BigInt(reversed.actual_pay_cents)), netGiftCents: String(BigInt(period.gift_cents) - BigInt(reversed.gift_cents)),
          netConsumptionCents: String(BigInt(period.consumption_cents) - BigInt(reversed.consumption_cents)) };
      }, { consistentRead: true });
    },
    async listMembers(identity, { search = '', sameName = '', balance = 'all', cursor: cursorValue = '', limit: requestedLimit, ledgerEpoch } = {}) {
      search = text(search, 128, '搜索内容'); sameName = text(sameName, 128, '同名会员姓名');
      const cursor = decodeCursor(cursorValue), limit = limitOf(requestedLimit), recent = balance === 'recent';
      if (!['all', 'positive', 'low', 'debt', 'archived', 'recent'].includes(balance) || recent && (cursor || sameName)) throw new ApiError(400, '会员余额筛选无效');
      return withAuthorized(identity, 'read', async (client, user) => {
        requireFeature(user.entitlements, 'members');
        const scope = pageScope(user, cursor, ledgerEpoch, ['members', search, balance, sameName]);
        const order = recent ? `(SELECT e.occurred_at FROM ledger_entries e
          WHERE e.store_id=m.store_id AND e.member_id=m.id AND e.kind='consume'
          AND NOT EXISTS (SELECT 1 FROM ledger_reversals r WHERE r.store_id=e.store_id AND r.original_entry_id=e.entry_id)
          ORDER BY e.occurred_at DESC,e.entry_id DESC LIMIT 1) DESC NULLS LAST,m.created_at DESC,m.id` : 'm.created_at,m.id';
        const { rows } = await client.query(`SELECT m.id,m.name,m.phone,m.notes,m.profile_version,m.created_at,m.created_at::text AS page_at,m.updated_at,m.archived_at,a.balance_cents,a.version AS account_version
          FROM member_profiles m JOIN member_accounts a ON a.store_id=m.store_id AND a.member_id=m.id
          WHERE m.store_id=$1 AND (m.archived_at IS NOT NULL)=($6='archived')
          AND ($6 IN ('all','archived','recent') OR $6='positive' AND a.balance_cents>0 OR $6='low' AND a.balance_cents BETWEEN 0 AND 5000 OR $6='debt' AND a.balance_cents<0)
          AND ($2='' OR strpos(lower(m.name),lower($2))>0 OR strpos(lower(m.notes),lower($2))>0 OR strpos(m.phone,$2)>0 OR (length($7)>0 AND strpos(m.phone_normalized,$7)>0))
          AND ($8='' OR lower(btrim(regexp_replace(normalize(m.name,NFKC),'[[:space:]]+',' ','g')))=lower(btrim(regexp_replace(normalize($8,NFKC),'[[:space:]]+',' ','g'))))
          AND ($3::timestamptz IS NULL OR (m.created_at,m.id)>($3::timestamptz,$4::text))
          ORDER BY ${order} LIMIT $5`, [user.store_id, search, cursor?.at || null, cursor?.id || null, recent ? Math.min(limit, 12) : limit + 1, balance,
          /^[\d+() -]+$/.test(search) ? normalizedPhone(search) : '', sameName]);
        const hasMore = !recent && rows.length > limit, page = rows.slice(0, limit), tags = await memberTags(client, user.store_id, page.map(row => row.id));
        return { items: page.map(row => publicMember(row, tags.get(row.id))), nextCursor: hasMore ? encodeCursor({ at: page.at(-1).page_at, id: page.at(-1).id, ledgerEpoch: user.ledger_epoch, scope }) : null };
      }, { consistentRead: true });
    },
    async getMember(identity, id, { ledgerEpoch } = {}) {
      if (typeof id !== 'string' || !ID.test(id)) throw new ApiError(400, '会员单号无效');
      return withAuthorized(identity, 'read', async (client, user) => {
        if (ledgerEpoch !== undefined) requireLedgerEpoch(ledgerEpoch, user.ledger_epoch);
        requireFeature(user.entitlements, 'members');
        const { rows: [row] } = await client.query(`SELECT m.id,m.name,m.phone,m.notes,m.profile_version,m.created_at,m.updated_at,m.archived_at,a.balance_cents,a.version AS account_version
          FROM member_profiles m JOIN member_accounts a ON a.store_id=m.store_id AND a.member_id=m.id WHERE m.store_id=$1 AND m.id=$2`, [user.store_id, id]);
        if (!row) throw new ApiError(404, '会员不存在');
        const tags = await memberTags(client, user.store_id, [id]); return publicMember(row, tags.get(id));
      }, { consistentRead: true });
    },
    async findActiveNames(identity, { names, ledgerEpoch } = {}) {
      const requested = batchNames(names);
      return withAuthorized(identity, 'read', async (client, user) => {
        requireLedgerEpoch(ledgerEpoch, user.ledger_epoch);
        requireFeature(user.entitlements, 'members');
        const { rows } = await client.query(`WITH keys AS (
          SELECT DISTINCT lower(btrim(regexp_replace(normalize(name,NFKC),'[[:space:]]+',' ','g'))) AS name_key FROM unnest($2::text[]) n(name)
        ) SELECT k.name_key AS "nameKey",m.id,m.profile_version::text AS version FROM keys k CROSS JOIN LATERAL (
          SELECT id,profile_version FROM member_profiles WHERE store_id=$1 AND archived_at IS NULL
          AND lower(btrim(regexp_replace(normalize(name,NFKC),'[[:space:]]+',' ','g')))=k.name_key ORDER BY id LIMIT 2
        ) m ORDER BY k.name_key,m.id`, [user.store_id, requested]);
        return rows;
      }, { consistentRead: true });
    },
    async createMember(identity, input, task) {
      let name, phone, notes, tags;
      try { ({ name, phone, notes, tags } = memberInput(input)); }
      catch (error) { throw new ApiError(400, error.message); }
      return withTask(identity, 'write', 'createMember', 'member.create', input, task, undefined, async (client, user) => {
        requireOperation(user.entitlements, 'createMember');
        if (phone && !phoneIdentity(phone)) throw new ApiError(400, '手机号码格式无效', 'MEMBER_PHONE_INVALID');
        await requireAvailablePhone(client, user.store_id, phone);
        // Initialize configuration before any account becomes spendable. Cash
        // commands only share-lock this committed row; they must not contend on
        // a lazy INSERT while another account is waiting for its own row lock.
        await client.query('INSERT INTO store_recharge_settings(store_id) VALUES($1) ON CONFLICT(store_id) DO NOTHING', [user.store_id]);
        const id = randomUUID();
        const { rows: [row] } = await client.query(`INSERT INTO member_profiles(store_id,id,name,phone,phone_normalized,notes)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,phone,notes,profile_version,created_at,updated_at,archived_at`,
          [user.store_id, id, name, phone, normalizedPhone(phone), notes]);
        await client.query('INSERT INTO member_accounts(store_id,member_id,balance_cents) VALUES($1,$2,0)', [user.store_id, id]);
        for (const tag of tags) await client.query('INSERT INTO member_tags(store_id,member_id,tag) VALUES($1,$2,$3)', [user.store_id, id, tag]);
        await recordChange(client, user.store_id, 'member', id); await audit(client, user, 'member_created', { memberId: id });
        return publicMember({ ...row, balance_cents: '0' }, tags);
      });
    },
    async updateMember(identity, id, input, task) {
      if (!ID.test(id || '')) throw new ApiError(400, '会员单号无效');
      const expectedVersion = versionOf(input?.expectedVersion, '会员资料版本');
      let name, phone, notes, tags;
      try { ({ name, phone, notes, tags } = memberInput(input, { update: true })); }
      catch (error) { throw new ApiError(400, error.message); }
      return withTask(identity, 'write', 'updateMember', 'member.update', input, task, id, async (client, user) => {
        requireOperation(user.entitlements, 'updateMember');
        const { rows: [current] } = await client.query('SELECT phone,archived_at,profile_version FROM member_profiles WHERE store_id=$1 AND id=$2 FOR NO KEY UPDATE',
          [user.store_id, id]);
        if (!current) throw new ApiError(404, '会员不存在', 'WRITE_MEMBER_NOT_FOUND');
        if (current.archived_at || String(current.profile_version) !== expectedVersion) throw new ApiError(409, '会员资料已变化或已归档，请重新加载后核对', 'MEMBER_VERSION_CHANGED');
        if (phone !== current.phone && phone && !phoneIdentity(phone)) throw new ApiError(400, '手机号码格式无效', 'MEMBER_PHONE_INVALID');
        if (phoneIdentity(current.phone) !== phoneIdentity(phone)) await requireAvailablePhone(client, user.store_id, phone, id);
        const { rows: [row] } = await client.query(`UPDATE member_profiles SET name=$1,phone=$2,phone_normalized=$3,notes=$4,
          profile_version=profile_version+1,updated_at=now() WHERE store_id=$5 AND id=$6 AND profile_version=$7 AND archived_at IS NULL
          RETURNING id,name,phone,notes,profile_version,created_at,updated_at,archived_at`,
          [name, phone, normalizedPhone(phone), notes, user.store_id, id, expectedVersion]);
        if (!row) { const exists = await client.query('SELECT 1 FROM member_profiles WHERE store_id=$1 AND id=$2', [user.store_id, id]);
          if (!exists.rows.length) throw new ApiError(404, '会员不存在');
          throw new ApiError(409, '会员资料已变化或已归档，请重新加载后核对', 'MEMBER_VERSION_CHANGED'); }
        await client.query('DELETE FROM member_tags WHERE store_id=$1 AND member_id=$2', [user.store_id, id]);
        for (const tag of tags) await client.query('INSERT INTO member_tags(store_id,member_id,tag) VALUES($1,$2,$3)', [user.store_id, id, tag]);
        const { rows: [account] } = await client.query('SELECT balance_cents,version FROM member_accounts WHERE store_id=$1 AND member_id=$2', [user.store_id, id]);
        await recordChange(client, user.store_id, 'member', id); await audit(client, user, 'member_updated', { memberId: id });
        return publicMember({ ...row, balance_cents: account.balance_cents, account_version: account.version }, tags);
      });
    },
    async archiveMember(identity, id, task) {
      if (!ID.test(id || '')) throw new ApiError(400, '会员单号无效');
      return withTask(identity, 'owner', 'deleteMember', 'member.archive', {}, task, id, async (client, user) => {
        requireOperation(user.entitlements, 'deleteMember');
        const account = await lockAccount(client, user.store_id, id, { modifyProfile: true });
        if (BigInt(account.balance_cents) !== 0n) throw new ApiError(409, '余额或欠款不为零，不能归档', 'MEMBER_BALANCE_NOT_ZERO');
        await client.query('UPDATE member_profiles SET archived_at=now(),profile_version=profile_version+1,updated_at=now() WHERE store_id=$1 AND id=$2', [user.store_id, id]);
        await recordChange(client, user.store_id, 'member', id, 'archive'); await audit(client, user, 'member_archived', { memberId: id });
        return { success: true };
      });
    },
    async listLedger(identity, { memberId = '', kind = '', search = '', from, to, cursor: cursorValue = '', limit: requestedLimit, ledgerEpoch } = {}) {
      if (memberId && !ID.test(memberId)) throw new ApiError(400, '会员单号无效');
      if (!['', 'recharge', 'consume', 'reversal'].includes(kind)) throw new ApiError(400, '流水类型筛选无效');
      search = text(search, 128, '搜索内容');
      if (from !== undefined || to !== undefined) ({ from, to } = reportPeriod({ from, to }));
      const cursor = decodeCursor(cursorValue), limit = limitOf(requestedLimit);
      return withAuthorized(identity, 'read', async (client, user) => {
        requireFeature(user.entitlements, 'cashier');
        const scope = pageScope(user, cursor, ledgerEpoch, ['ledger', memberId, kind, search, from ?? null, to ?? null]);
        const { rows } = await client.query(`SELECT e.entry_id,e.member_id,e.kind,e.account_version,e.delta_cents,e.balance_before_cents,e.balance_after_cents,
          e.actual_pay_cents,e.gift_cents,e.pay_method,e.items_summary,e.remark,e.occurred_at,e.occurred_at::text AS page_at,
          p.name AS member_name,r.reversal_entry_id,o.original_entry_id
          FROM ledger_entries e JOIN member_profiles p ON p.store_id=e.store_id AND p.id=e.member_id
          LEFT JOIN ledger_reversals r ON r.store_id=e.store_id AND r.original_entry_id=e.entry_id
          LEFT JOIN ledger_reversals o ON o.store_id=e.store_id AND o.reversal_entry_id=e.entry_id
          WHERE e.store_id=$1 AND ($2='' OR e.member_id=$2)
          AND ($3::timestamptz IS NULL OR (e.occurred_at,e.entry_id)<($3::timestamptz,$4::text))
          AND ($6='' OR e.kind=$6)
          AND ($7='' OR strpos(lower(p.name),lower($7))>0 OR strpos(p.phone,$7)>0 OR strpos(lower(e.items_summary),lower($7))>0 OR strpos(e.entry_id,$7)>0)
          AND ($8::timestamptz IS NULL OR e.occurred_at>=$8) AND ($9::timestamptz IS NULL OR e.occurred_at<$9)
          ORDER BY e.occurred_at DESC,e.entry_id DESC LIMIT $5`,
        [user.store_id, memberId, cursor?.at || null, cursor?.id || null, limit + 1, kind, search, from ?? null, to ?? null]);
        const hasMore = rows.length > limit, page = rows.slice(0, limit);
        const sales = await readSales(client, user.store_id, page.map(row => row.entry_id));
        return { items: page.map(row => ({ ...publicEntry(row), ...sales.get(row.entry_id) })),
          nextCursor: hasMore ? encodeCursor({ at: page.at(-1).page_at, id: page.at(-1).entry_id, ledgerEpoch: user.ledger_epoch, scope }) : null };
      }, { consistentRead: true });
    },
    async executeCommand(identity, input) {
      const command = validateCommand(input);
      if (VOICE_ID.test(command.id)) throw new ApiError(400, '语音命令号专供签名确认使用', 'INVALID_INPUT');
      return withAuthorized(identity, command.type === 'reverse' ? 'owner' : 'write', (client, user) => applyCommand(client, user, command));
    },
    // Internal only: caller holds the store, license and configured actor locks
    // and commits the response/deduplication records on this same connection.
    async executeVoiceCommand(client, user, input, { expectedProfileVersion, expiresAt }) {
      const command = validateCommand(input);
      if (!VOICE_ID.test(command.id) || !VOICE_ID.test(user.device_id) || !['recharge', 'consume'].includes(command.type) ||
          command.actorId !== user.id || command.deviceId !== user.device_id || command.configurationVersion === undefined ||
          !Number.isSafeInteger(expiresAt)) throw new ApiError(400, '语音确认命令无效');
      versionOf(expectedProfileVersion, '会员资料版本');
      try { return { result: await applyCommand(client, user, command, { expectedProfileVersion, expiresAt }) }; }
      catch (error) {
        if (error instanceof VoicePreviewStale) return { stale: error.message };
        throw error;
      }
    },
    async previewOpeningImport(identity, input) {
      const preview = previewOpeningImport(input), ledgerEpoch = ledgerEpochOf(input?.ledgerEpoch), captured = { ...openingCapture(input), ledgerEpoch };
      return withAuthorized(identity, 'owner', async (_client, user) => {
        requireFeature(user.entitlements, 'backup'); checkOpeningScope(captured, openingScope(user), preview.payloadDigest);
        return { ...preview, storeId: user.store_id, ledgerEpoch };
      });
    },
    async importOpeningBalances(identity, input) {
      const batch = openingRows(input), ledgerEpoch = ledgerEpochOf(input?.ledgerEpoch), captured = { ...openingCapture(input), ledgerEpoch };
      return withAuthorized(identity, 'owner', async (client, user) => {
        requireFeature(user.entitlements, 'backup');
        checkOpeningScope(captured, openingScope(user), batch.payloadDigest);
        const scope = { storeId: user.store_id, ledgerEpoch, payloadDigest: batch.payloadDigest };
        const { rows: [existingById] } = await client.query('SELECT * FROM account_opening_batches WHERE store_id=$1 AND batch_id=$2', [user.store_id, batch.batchId]);
        const { rows: [existingByDigest] } = await client.query('SELECT * FROM account_opening_batches WHERE store_id=$1 AND source_digest=$2', [user.store_id, batch.sourceDigest]);
        const prior = existingById || existingByDigest;
        if (prior) {
          if (prior.source_digest !== batch.sourceDigest || prior.payload_digest !== batch.payloadDigest || Number(prior.member_count) !== batch.expectedCount) throw new ApiError(409, '期初批次号或来源摘要已用于其他数据', 'OPENING_BATCH_CONFLICT');
          return { ...scope, batchId: prior.batch_id, sourceDigest: prior.source_digest, memberCount: Number(prior.member_count),
            netBalanceCents: String(prior.net_balance_cents), positiveBalanceCents: String(prior.positive_balance_cents),
            negativeBalanceCents: String(prior.negative_balance_cents), importedAt: new Date(prior.imported_at).toISOString(), alreadyImported: true };
        }
        const { rows: [state] } = await client.query(`SELECT
          (SELECT count(*) FROM member_profiles WHERE store_id=$1) AS members,
          (SELECT count(*) FROM account_openings WHERE store_id=$1) AS openings,
          (SELECT count(*) FROM ledger_entries WHERE store_id=$1) AS entries`, [user.store_id]);
        if (Number(state.members) || Number(state.openings) || Number(state.entries)) throw new ApiError(409, '新账本已有业务数据，不能导入期初余额', 'OPENING_NOT_EMPTY');
        await client.query(`INSERT INTO account_opening_batches(store_id,batch_id,source_digest,payload_digest,member_count,net_balance_cents,positive_balance_cents,negative_balance_cents,imported_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [user.store_id, batch.batchId, batch.sourceDigest, batch.payloadDigest, batch.expectedCount, batch.netBalanceCents, batch.positiveBalanceCents, batch.negativeBalanceCents, user.id]);
        await client.query('INSERT INTO store_recharge_settings(store_id) VALUES($1) ON CONFLICT(store_id) DO NOTHING', [user.store_id]);
        for (const row of batch.rows) {
          await client.query(`INSERT INTO member_profiles(store_id,id,name,phone,phone_normalized,notes) VALUES($1,$2,$3,$4,$5,$6)`,
            [user.store_id, row.id, row.name, row.phone, row.phoneNormalized, row.notes]);
          await client.query('INSERT INTO member_accounts(store_id,member_id,balance_cents) VALUES($1,$2,$3)', [user.store_id, row.id, row.balanceCents]);
          await client.query('INSERT INTO account_openings(store_id,member_id,batch_id,source_member_id,opening_balance_cents,row_digest) VALUES($1,$2,$3,$4,$5,$6)',
            [user.store_id, row.id, batch.batchId, row.sourceMemberId, row.balanceCents, row.rowDigest]);
          for (const tag of row.tags) await client.query('INSERT INTO member_tags(store_id,member_id,tag) VALUES($1,$2,$3)', [user.store_id, row.id, tag]);
          await recordChange(client, user.store_id, 'member', row.id);
        }
        await audit(client, user, 'account_opening_imported', { batchId: batch.batchId, sourceDigest: batch.sourceDigest, memberCount: batch.expectedCount, netBalanceCents: batch.netBalanceCents });
        const { rows: [saved] } = await client.query('SELECT imported_at FROM account_opening_batches WHERE store_id=$1 AND batch_id=$2', [user.store_id, batch.batchId]);
        return { ...scope, batchId: batch.batchId, sourceDigest: batch.sourceDigest, memberCount: batch.expectedCount,
          netBalanceCents: batch.netBalanceCents, positiveBalanceCents: batch.positiveBalanceCents,
          negativeBalanceCents: batch.negativeBalanceCents, importedAt: new Date(saved.imported_at).toISOString(), alreadyImported: false };
      }, { exclusiveStore: true });
    }
  };
  return api;
}
