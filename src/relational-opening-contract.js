import { canonicalJSON } from './canonical-json.js';
import { invalid } from './relational-contract.js';
import { requireLedgerEpoch } from './ledger-epoch.js';

export function openingPayload(batch) {
  return canonicalJSON([...batch.rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
export function openingSummary(batch, payloadDigest) {
  const { batchId, sourceDigest, expectedCount, netBalanceCents, positiveBalanceCents, negativeBalanceCents, zeroBalanceCount, negativeBalanceCount } = batch;
  return { batchId, sourceDigest, payloadDigest, memberCount: expectedCount, netBalanceCents, positiveBalanceCents, negativeBalanceCents, zeroBalanceCount, negativeBalanceCount };
}
export function checkOpeningScope(input, current, payloadDigest) {
  requireLedgerEpoch(input.ledgerEpoch, current.ledgerEpoch);
  if (['storeId', 'actorId', 'deviceId'].some(key => input[key] !== undefined && input[key] !== current[key])) throw invalid('期初批次与当前门店、账号或设备不一致', 'OPENING_CONTEXT_CHANGED');
  if (input.payloadDigest !== undefined && input.payloadDigest !== payloadDigest) throw invalid('期初内容与核对的摘要不一致', 'OPENING_REVIEW_MISMATCH');
}
