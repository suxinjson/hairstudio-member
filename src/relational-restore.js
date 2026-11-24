import { COMMAND_ID, ENTITY_ID, invalid } from './relational-contract.js';
import { ledgerEpochOf } from './ledger-epoch.js';

export const RESTORE_COLUMNS = ['store_id', 'task_id', 'actor_id', 'device_id', 'target_epoch', 'source_epoch', 'restored_epoch', 'source_digest', 'member_count', 'entry_count', 'completed_at'];
export const SQLITE_RESTORE_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS local_restore_receipts(store_id TEXT NOT NULL,task_id TEXT NOT NULL,actor_id TEXT NOT NULL,device_id TEXT NOT NULL,target_epoch TEXT NOT NULL,source_epoch TEXT NOT NULL,restored_epoch TEXT NOT NULL,source_digest TEXT NOT NULL,member_count INTEGER NOT NULL,entry_count INTEGER NOT NULL,completed_at TEXT NOT NULL,PRIMARY KEY(store_id,task_id))',
  "CREATE TRIGGER IF NOT EXISTS immutable_restore_update BEFORE UPDATE ON local_restore_receipts BEGIN SELECT RAISE(ABORT,'restore receipt immutable'); END",
  "CREATE TRIGGER IF NOT EXISTS immutable_restore_delete BEFORE DELETE ON local_restore_receipts BEGIN SELECT RAISE(ABORT,'restore receipt immutable'); END"
];
export function restoreCapture(input, { requireTask = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.actorId !== 'string' || !ENTITY_ID.test(input.actorId) ||
      typeof input.deviceId !== 'string' || !COMMAND_ID.test(input.deviceId) || requireTask && (typeof input.id !== 'string' || !COMMAND_ID.test(input.id) ||
        typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/.test(input.digest))) throw invalid('恢复任务、原身份或已核对摘要无效');
  return { id: input.id, ledgerEpoch: ledgerEpochOf(input.ledgerEpoch), actorId: input.actorId, deviceId: input.deviceId, digest: input.digest };
}
export function restoreResult(row) {
  return { taskId: row.task_id, storeId: row.store_id, targetEpoch: row.target_epoch, sourceLedgerEpoch: row.source_epoch,
    ledgerEpoch: row.restored_epoch, digest: row.source_digest, memberCount: Number(row.member_count), entryCount: Number(row.entry_count),
    receiptCount: Number(row.entry_count), completedAt: row.completed_at, restored: true };
}
export function validateRestoreReceipt(row, ensure) {
  ensure(COMMAND_ID.test(row.task_id) && ENTITY_ID.test(row.actor_id) && COMMAND_ID.test(row.device_id) && /^[a-f0-9]{64}$/.test(row.source_digest), '恢复回执标识或摘要无效');
  for (const column of ['target_epoch', 'source_epoch', 'restored_epoch']) ledgerEpochOf(row[column]);
  ensure(row.restored_epoch !== row.target_epoch && row.restored_epoch !== row.source_epoch, '恢复回执必须创建新的代际');
  ensure(/^(0|[1-9][0-9]*)$/.test(row.member_count) && /^(0|[1-9][0-9]*)$/.test(row.entry_count) &&
    BigInt(row.member_count) <= 4000000n && BigInt(row.entry_count) <= 4000000n, '恢复回执数量无效');
}
