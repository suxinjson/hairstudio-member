import { assertJsonBudget, DATA_LIMITS } from './data-limits.js';
import { validateFinancialCommand, memberInput, versionOf, ENTITY_ID, COMMAND_ID } from './relational-contract.js';
import { taskRequest } from './relational-tasks.js';
import { ledgerEpochOf, requireLedgerEpoch } from './ledger-epoch.js';
import { parseCents } from './ledger-domain.js';
import { configurationInput } from './relational-sales.js';
import { canonicalJSON } from './canonical-json.js';

const validation = { command: validateFinancialCommand, task: taskRequest };
// Only these errors follow the server's ID lock and receipt check. Auth,
// generation, transport and receipt conflicts do not prove non-commit.
const checkedRejections = {
  command: new Map([['ACCOUNT_VERSION_CHANGED', 409], ['MEMBER_VERSION_CHANGED', 409], ['CONFIGURATION_VERSION_CHANGED', 409], ['SALE_PRICE_CHANGED', 409],
    ['GIFT_DISABLED', 409], ['BALANCE_CONFLICT', 409], ['ALREADY_REVERSED', 409], ['WRITE_MEMBER_ARCHIVED', 409],
    ['WRITE_MEMBER_NOT_FOUND', 404], ['ORIGINAL_ENTRY_NOT_FOUND', 404], ['ORIGINAL_ENTRY_MISMATCH', 409],
    ['ORIGINAL_ENTRY_REVERSAL', 409], ['REVERSAL_REJECTED', 400], ['MEMBER_PHONE_IN_USE', 409]]),
  task: new Map([['MEMBER_VERSION_CHANGED', 409], ['CONFIGURATION_VERSION_CHANGED', 409], ['MEMBER_BALANCE_NOT_ZERO', 409],
    ['WRITE_MEMBER_ARCHIVED', 409], ['WRITE_MEMBER_NOT_FOUND', 404], ['MEMBER_PHONE_IN_USE', 409], ['MEMBER_PHONE_INVALID', 400]])
};
// A timed-out first transmission might still arrive after a retry. Mutable
// rejection reasons cannot close that uncertain request without a DB fence.
const stableRejections = new Set(['ACCOUNT_VERSION_CHANGED', 'MEMBER_VERSION_CHANGED', 'CONFIGURATION_VERSION_CHANGED',
  'BALANCE_CONFLICT', 'ALREADY_REVERSED', 'ORIGINAL_ENTRY_MISMATCH', 'ORIGINAL_ENTRY_REVERSAL', 'REVERSAL_REJECTED']);
const errorWith = (message, code) => Object.assign(new Error(message), { code, status: 409 });
const keyOf = ({ storeId, actorId, deviceId }) => 'hairstudio_v2_pending:' + storeId + ':' + actorId + ':' + deviceId;
function actorMatches(a, b) { return a && b && a.storeId === b.storeId && a.actorId === b.actorId && a.deviceId === b.deviceId; }
function scopeOf(value) {
  if (typeof value?.storeId !== 'string' || !ENTITY_ID.test(value.storeId) || typeof value.actorId !== 'string' || !ENTITY_ID.test(value.actorId) ||
      typeof value.deviceId !== 'string' || !COMMAND_ID.test(value.deviceId)) throw errorWith('账本身份未确认', 'AUTH_CONTEXT_CHANGED');
  return { storeId: value.storeId, actorId: value.actorId, deviceId: value.deviceId, ledgerEpoch: ledgerEpochOf(value.ledgerEpoch) };
}

const mismatch = () => errorWith('服务器回执与原请求不匹配，已保留待办', 'RECEIPT_MISMATCH');
const instant = value => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function commandResult(row, original) {
  if (!row || row.storeId !== original.storeId || row.ledgerEpoch !== original.ledgerEpoch || row.memberId !== original.memberId ||
      row.commandId !== original.id || row.entryId !== original.id || row.type !== (original.type === 'reverse' ? 'reversal' : original.type) ||
      row.accountVersion !== String(BigInt(original.expectedAccountVersion) + 1n) || !instant(row.occurredAt)) throw mismatch();
  versionOf(row.cursor, '回执水位');
  const delta = parseCents(row.deltaCents);
  if (delta === 0n || parseCents(row.balanceBeforeCents) + delta !== parseCents(row.balanceAfterCents) ||
      original.type === 'consume' && delta !== -BigInt(original.amountCents) ||
      original.type === 'recharge' && delta !== BigInt(original.actualPayCents) + BigInt(original.giftCents ?? '0')) throw mismatch();
  return row;
}
function taskResult(receipt, input, replay) {
  const row = receipt?.result;
  if (receipt?.taskId !== input.id || receipt.ledgerEpoch !== input.ledgerEpoch || receipt.type !== input.type ||
      replay && !instant(receipt.completedAt) || !row || typeof row !== 'object' || Array.isArray(row)) throw mismatch();
  if (input.type === 'member.archive') {
    if (row.success !== true || Object.keys(row).length !== 1) throw mismatch();
  } else if (input.type === 'configuration.update') {
    const { version, services, rechargePlans, rechargeSettings } = row, expected = configurationInput(input.data);
    if (version !== String(BigInt(expected.expectedVersion) + 1n) || canonicalJSON({ services, rechargePlans, rechargeSettings }) !==
      canonicalJSON({ services: expected.services, rechargePlans: expected.rechargePlans, rechargeSettings: expected.rechargeSettings })) throw mismatch();
  } else {
    const update = input.type === 'member.update', { name, phone, notes, tags } = row;
    if (typeof row.id !== 'string' || !ENTITY_ID.test(row.id) || update && row.id !== input.memberId ||
        row.version !== (update ? String(BigInt(input.data.expectedVersion) + 1n) : '0') || row.archivedAt !== null ||
        !instant(row.createdAt) || !instant(row.updatedAt) || canonicalJSON({ name, phone, notes, tags }) !== canonicalJSON(memberInput(input.data, { update }))) throw mismatch();
    versionOf(row.accountVersion);
    if (!update && (row.balanceCents !== '0' || row.accountVersion !== '0')) throw mismatch();
    parseCents(row.balanceCents);
  }
  return row;
}
function verified(kind, row, input, replay) {
  try { return kind === 'command' ? commandResult(row, input) : taskResult(row, input, replay); }
  catch { throw mismatch(); }
}

// Only the original unresolved request lives here. No membership/ledger cache
// or generated replacement is written to browser storage. The key excludes the
// epoch explicitly so a restore cannot hide or rebind the original request.
export function createOnlineLedgerWrites({ remote, storage, lock, getScope, id = () => crypto.randomUUID() }) {
  const assertCurrent = captured => {
    const current = scopeOf(getScope());
    if (!actorMatches(captured, current)) throw errorWith('账号或设备已变化，请保留原待办并重新登录核对', 'AUTH_CONTEXT_CHANGED');
    requireLedgerEpoch(captured.ledgerEpoch, current.ledgerEpoch);
    return current;
  };
  function read(key, context) {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    try {
      const captured = JSON.parse(raw);
      if (!['command', 'task'].includes(captured?.kind)) throw new Error();
      const normalized = validation[captured.kind](captured.input);
      if (!actorMatches(context, normalized)) throw new Error();
      if (captured.rejected !== undefined && !checkedRejections[captured.kind].has(captured.rejected)) throw new Error();
      return { kind: captured.kind, input: normalized, rejected: captured.rejected };
    } catch { throw errorWith('原待办不可读取，请保留浏览器数据以供核对', 'PENDING_INVALID'); }
  }
  async function settle(captured, context, key, replay) {
    const { kind, input } = captured;
    assertCurrent(context);
    requireLedgerEpoch(input.ledgerEpoch, context.ledgerEpoch);
    if (captured.rejected) throw errorWith('原请求已被拒绝，请核对后确认结束', captured.rejected);
    let result;
    if (replay) {
      try {
        const options = { ledgerEpoch: input.ledgerEpoch };
        result = verified(kind, await remote[kind === 'command' ? 'getCommand' : 'getTask'](input.id, options), input, true);
      } catch (error) { if (error.status !== 404 || error.code !== (kind === 'command' ? 'COMMAND_NOT_FOUND' : 'TASK_NOT_FOUND')) throw error; }
    }
    if (result === undefined) {
      assertCurrent(context);
      try {
        result = verified(kind, await remote[kind === 'command' ? 'executeCommand' : 'executeTask'](input), input, false);
      } catch (error) {
        if (error.status !== undefined && checkedRejections[kind].get(error.code) === error.status && (!replay || stableRejections.has(error.code))) {
          assertCurrent(context);
          storage.setItem(key, JSON.stringify({ kind, input, rejected: error.code }));
        }
        throw error;
      }
    }
    assertCurrent(context);
    storage.removeItem(key);
    return result;
  }
  async function recover({ rejectedId } = {}) {
    const context = scopeOf(getScope()), key = keyOf(context);
    return lock(key, async () => {
      assertCurrent(context);
      const pending = read(key, context);
      if (!pending) return null;
      if (rejectedId !== undefined) {
        if (pending.input.id !== rejectedId || !pending.rejected) throw errorWith('此待办仍须按原号核对', 'PENDING_IN_PROGRESS');
        storage.removeItem(key);
        return { rejected: true, code: pending.rejected };
      }
      return settle(pending, context, key, true);
    });
  }
  return {
    pending() {
      const current = getScope();
      if (!current) return null;
      const context = scopeOf(current), pending = read(keyOf(context), context);
      return pending ? { kind: pending.kind, id: pending.input.id, type: pending.input.type, ledgerEpoch: pending.input.ledgerEpoch,
        rejection: pending.rejected ?? null, generationChanged: context.ledgerEpoch !== pending.input.ledgerEpoch } : null;
    },
    async submit(kind, draft, scope) {
      if (!['command', 'task'].includes(kind)) throw Error('未知账本请求');
      const context = scopeOf(scope), key = keyOf(context);
      const input = validation[kind]({ ...draft, ...context, id: id() });
      assertJsonBudget(input, DATA_LIMITS.operationBytes);
      const captured = { kind, input }, raw = JSON.stringify(captured);
      return lock(key, async () => {
        assertCurrent(context);
        if (read(key, context)) throw errorWith('请先核对同一账号设备的原待办', 'PENDING_IN_PROGRESS');
        storage.setItem(key, raw);
        if (storage.getItem(key) !== raw) throw errorWith('未能可靠保存原请求，尚未提交', 'PENDING_STORAGE');
        return settle(captured, context, key, false);
      });
    },
    retry: () => recover(),
    archiveObsolete(id, targetEpoch, save, verifyContext = () => {}) {
      ledgerEpochOf(targetEpoch);
      const context = scopeOf(getScope()), key = keyOf(context);
      return lock(key, async () => {
        const checkTarget = async () => {
          assertCurrent(context); verifyContext();
          const current = await remote.getBook(); assertCurrent(context); verifyContext();
          if (current.storeId !== context.storeId) throw errorWith('原待办不属于当前门店', 'AUTH_CONTEXT_CHANGED');
          requireLedgerEpoch(targetEpoch, current.ledgerEpoch);
        };
        const captured = read(key, context);
        if (!captured || captured.input.id !== id || captured.input.ledgerEpoch === targetEpoch || captured.rejected) throw errorWith('此原待办不适用旧代际核对', 'PENDING_IN_PROGRESS');
        await checkTarget();
        const content = canonicalJSON({ format: 'member-pending-review', version: 1, ...captured, targetEpoch, resolution: 'manual' });
        const result = await save({ content, fileName: 'member-pending-' + captured.input.id + '.json' });
        if (result?.status !== 'saved-verified') return { reviewed: false };
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))), value => value.toString(16).padStart(2, '0')).join('');
        if (result.sha256 !== digest) throw errorWith('外部文件和原操作不一致，原待办仍保留', 'REPLICA_REVIEW_MISMATCH');
        await checkTarget();
        const reviewedKey = key.replace('hairstudio_v2_pending:', 'hairstudio_v2_reviewed:') + ':' + captured.input.id;
        const record = JSON.stringify({ id: captured.input.id, ledgerEpoch: captured.input.ledgerEpoch, targetEpoch, digest });
        storage.setItem(reviewedKey, record);
        if (storage.getItem(reviewedKey) !== record) throw errorWith('核对记录无法保存，原待办仍保留', 'PENDING_STORAGE');
        storage.removeItem(key);
        return { reviewed: true };
      });
    },
    acknowledgeRejected(rejectedId) {
      if (typeof rejectedId !== 'string' || !COMMAND_ID.test(rejectedId)) throw errorWith('待办号无效', 'PENDING_INVALID');
      return recover({ rejectedId });
    }
  };
}
