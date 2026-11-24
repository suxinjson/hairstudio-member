import { assertJsonBudget, byteLength } from './data-limits.js';
import { invalid, normalizeOpeningInput } from './relational-contract.js';
import { ledgerEpochOf } from './ledger-epoch.js';
import { sha256Stream } from './sha256-stream.js';
import { openingPayload, openingSummary } from './relational-opening-contract.js';

export const OPENING_FILE_LIMIT = 4 * 1024 * 1024;
export const CUTOVER_MEMBER_COUNT = 91;
const keys = ['storeId', 'actorId', 'deviceId', 'ledgerEpoch'];
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = text => { const state = sha256Stream(); state.update(new TextEncoder().encode(text)); return state.hex(); };
const mismatch = () => invalid('期初文件或回执与核对的摘要不一致', 'OPENING_REVIEW_MISMATCH');
const same = (a, b, fields = keys) => a && b && fields.every(field => a[field] === b[field]);

const receiptFields = ['batchId', 'sourceDigest', 'payloadDigest', 'memberCount', 'netBalanceCents', 'positiveBalanceCents', 'negativeBalanceCents'];
export function createOpeningFiles(workspace) {
  function scope() {
    const value = workspace.getScope(); if (!value) throw invalid('请先打开已授权的目标账本', 'OPENING_CONTEXT_CHANGED');
    return Object.fromEntries(keys.map(key => [key, value[key]]));
  }
  function check(original) {
    if (!same(scope(), original)) throw invalid('目标门店、账号、设备或账本代际已变化，请保留原期初资料', 'OPENING_CONTEXT_CHANGED');
  }
  const key = ({ storeId, actorId, deviceId }) => 'hairstudio_v2_opening:' + [storeId, actorId, deviceId].join(':');
  const metaFields = ['ledgerEpoch', 'batchId', 'sourceDigest', 'payloadDigest', 'memberCount'];
  function pending(current = scope()) {
    const raw = workspace.storage.getItem(key(current)); if (raw === null) return null;
    try {
      const value = JSON.parse(raw); ledgerEpochOf(value.ledgerEpoch);
      if (!/^[a-zA-Z0-9-]{16,80}$/.test(value.batchId) || !sha(value.sourceDigest) || !sha(value.payloadDigest) || !Number.isInteger(value.memberCount) || value.memberCount < 1) throw mismatch();
      return value;
    } catch { throw invalid('原期初任务不可读，请保留原文件和记录', 'OPENING_PENDING_INVALID'); }
  }
  let candidate = null;
  function decode(content, expectedSource, expectedPayload) {
    if (typeof content !== 'string' || byteLength(content) > OPENING_FILE_LIMIT || !sha(expectedSource) || !sha(expectedPayload)) throw mismatch();
    let source; try { source = JSON.parse(content.replace(/^\uFEFF/, '')); } catch { throw invalid('请选择预检工具生成的期初 JSON 文件', 'OPENING_FILE_INVALID'); }
    assertJsonBudget(source, OPENING_FILE_LIMIT);
    if (!source || Object.keys(source).some(key => !['batchId', 'sourceDigest', 'expectedCount', 'members'].includes(key)) || !Number.isInteger(source.expectedCount) || source.expectedCount < 1 || source.sourceDigest !== expectedSource) throw mismatch();
    const batch = normalizeOpeningInput(source), digest = hash(openingPayload(batch));
    if (digest !== expectedPayload) throw mismatch();
    return batch;
  }
  return {
    pending, clear() { candidate = null; },
    async review(content, { sourceDigest, payloadDigest }) {
      candidate = null;
      const original = scope(), batch = decode(content, sourceDigest, payloadDigest);
      const summary = openingSummary(batch, payloadDigest), meta = Object.fromEntries(metaFields.map(key => [key, key === 'ledgerEpoch' ? original.ledgerEpoch : summary[key]]));
      const prior = pending(original);
      if (prior && !same(prior, meta, metaFields)) throw mismatch();
      const input = { ...original, batchId: batch.batchId, sourceDigest, payloadDigest, expectedCount: batch.expectedCount, members: batch.rows };
      const preview = await workspace.reviewOpenings(input, original); check(original);
      if (!same(preview, original, ['storeId', 'ledgerEpoch']) || !same(preview, summary, [...receiptFields, 'zeroBalanceCount', 'negativeBalanceCount'])) throw mismatch();
      candidate = { original, input, summary, meta };
      return { ...summary, members: structuredClone(batch.rows), ledgerEpoch: original.ledgerEpoch };
    },
    async submit() {
      if (!candidate) throw invalid('请先读取并逐人核对期初文件', 'OPENING_REVIEW_REQUIRED');
      const { original, input, summary, meta } = candidate, storageKey = key(original);
      return workspace.lock(storageKey, async () => {
        check(original);
        const prior = pending(original);
        if (prior && !same(prior, meta, metaFields)) throw mismatch();
        const encoded = JSON.stringify(meta); workspace.storage.setItem(storageKey, encoded);
        if (workspace.storage.getItem(storageKey) !== encoded) throw invalid('原期初批次未可靠保存，尚未提交', 'OPENING_PENDING_INVALID');
        const result = await workspace.importOpenings(input, original); check(original);
        if (!same(result, original, ['storeId', 'ledgerEpoch']) || !same(result, summary, receiptFields)) throw mismatch();
        workspace.storage.removeItem(storageKey); candidate = null; return result;
      });
    }
  };
}
