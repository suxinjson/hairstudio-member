// A store can have multiple successive books after a controlled restore.
// Never infer the generation of an already captured request from current state.
export const LEDGER_EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function ledgerEpochOf(value) {
  if (typeof value !== 'string' || !LEDGER_EPOCH.test(value)) throw Object.assign(new Error('必须提供已捕获的账本代际'), { status: 400, code: 'LEDGER_EPOCH_REQUIRED' });
  return value;
}
export function requireLedgerEpoch(captured, current) {
  ledgerEpochOf(captured); ledgerEpochOf(current);
  if (captured !== current) throw Object.assign(new Error('账本已更换或恢复；保留原待办并核对，不得自动改代际或重新记账'), { status: 409, code: 'LEDGER_EPOCH_MISMATCH' });
  return captured;
}
