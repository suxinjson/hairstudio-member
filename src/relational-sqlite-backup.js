import { canonicalJSON } from './canonical-json.js';
import { DATA_LIMITS, assertJsonBudget } from './data-limits.js';
import { ledgerEpochOf } from './ledger-epoch.js';
import { batchCaptureChecks } from './relational-batches.js';
import { validateBackupTables, backupEnsure as ensure, backupTime as canonicalTime } from './relational-backup-rows.js';
export { BACKUP_TABLES, validateBackupTables } from './relational-backup-rows.js';

export async function validateSqliteBackup(input, { storeId, hash }) {
  assertJsonBudget(input, DATA_LIMITS.restoreBytes);
  const captured = JSON.parse(JSON.stringify(input));
  ensure(captured && Object.keys(captured).length === 9 && captured.format === 'member-relational-sqlite' && captured.formatVersion === 4 && captured.schemaVersion === 6 && captured.mode === 'standalone' && captured.storeId === storeId && canonicalTime(captured.exportedAt), '备份格式、门店归属或模式不匹配');
  ledgerEpochOf(captured.ledgerEpoch);
  const { digest, ...payload } = captured;
  ensure(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest) && await hash(canonicalJSON(payload)) === digest, '备份完整性摘要不匹配');
  const summary = validateBackupTables(payload.tables, storeId);
  for (const check of batchCaptureChecks(payload.tables, storeId, ensure)) ensure(await hash(canonicalJSON(check.value)) === check.hash, '批次捕获摘要与原内容不一致');
  return { payload, digest, summary };
}
