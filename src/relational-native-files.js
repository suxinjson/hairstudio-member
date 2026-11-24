import { createRelationalArchiveFiles } from './relational-archive-files.js';
import { ledgerEpochOf, requireLedgerEpoch } from './ledger-epoch.js';
import { COMMAND_ID } from './relational-contract.js';
import { ARCHIVE_LIMITS } from './relational-archive.js';

const invalid = () => new Error('原恢复任务信息不可用，请保留原文件和任务号核对');
const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export function createNativeArchiveController(workspace, { documents } = {}) {
  let flow;
  const storageKey = scope => 'hairstudio_v2_native_restore:' + [scope.storeId, scope.actorId, scope.deviceId].join(':');
  const scope = () => {
    const value = workspace.getScope(); if (!value) throw new Error('请先打开已授权的本机账本'); return value;
  };
  const repository = Object.fromEntries(['getBook', 'getRestoreReceipt', 'exportArchive', 'previewArchiveRestore', 'restoreArchive']
    .map(method => [method, (...args) => workspace.repository[method](...args)]));
  function files() { return flow ??= createRelationalArchiveFiles({ repository, getScope: workspace.getScope, documents }); }
  function check(current, original) {
    if (current.storeId !== original.storeId || current.actorId !== original.actorId || current.deviceId !== original.deviceId) throw invalid();
  }
  function pending(current = scope()) {
    const value = workspace.storage.getItem(storageKey(current)); if (value === null) return null;
    try {
      const row = JSON.parse(value);
      if (row.storeId !== current.storeId || !COMMAND_ID.test(row?.token ?? '') || !sha256(row.digest) || !sha256(row.sha256) || !Number.isSafeInteger(row.byteLength) || row.byteLength < 1 || row.byteLength > ARCHIVE_LIMITS.totalBytes ||
        !Number.isSafeInteger(row.memberCount) || row.memberCount < 0 || !Number.isSafeInteger(row.entryCount) || row.entryCount < 0) throw invalid();
      ledgerEpochOf(row.ledgerEpoch); ledgerEpochOf(row.sourceLedgerEpoch); return { ...row, taskId: row.token };
    } catch { throw invalid(); }
  }
  function view(value) { return { ...value, taskId: value.token, sourceDigest: value.digest }; }
  function capture(value) {
    const { token, storeId, ledgerEpoch, sourceLedgerEpoch, digest, byteLength, sha256, memberCount, entryCount } = value;
    return { token, storeId, ledgerEpoch, sourceLedgerEpoch, digest, byteLength, sha256, memberCount, entryCount };
  }
  return {
    native: true, canSave: true, pending,
    save: options => files().save(options),
    async chooseRestore(_file, { signal } = {}) {
      if (pending()) throw new Error('请先核对原恢复任务');
      const value = await files().chooseRestore({ signal });
      return value.status === 'cancelled' ? value : view(value);
    },
    async restore(id, _file, { signal } = {}) {
      const original = scope(), key = storageKey(original);
      return workspace.lock(key, async () => {
        check(scope(), original);
        const saved = pending(original), reviewed = saved ?? files().getCapture();
        if (!reviewed || reviewed.token !== id) throw invalid();
        const query = { id, actorId: original.actorId, deviceId: original.deviceId, ledgerEpoch: reviewed.ledgerEpoch, digest: reviewed.digest };
        let result;
        if (saved) {
          try { result = await (await workspace.recoverConnection()).getRestoreReceipt(query); }
          catch (error) { if (error.code !== 'RESTORE_NOT_FOUND') throw error; }
        }
        if (!result) {
          requireLedgerEpoch(reviewed.ledgerEpoch, scope().ledgerEpoch);
          if (files().getPreview()?.token !== id) {
            const chosen = await files().chooseRestore({ signal, resume: capture(reviewed) });
            if (chosen.status === 'cancelled') return chosen;
          }
          check(scope(), original);
          const raw = JSON.stringify(capture(reviewed)); workspace.storage.setItem(key, raw);
          if (workspace.storage.getItem(key) !== raw) throw new Error('恢复任务未可靠保存，尚未提交');
          ({ result } = await files().restore(id, reviewed.digest, { signal }));
        }
        if (result?.storeId !== original.storeId || result.taskId !== id || result.targetEpoch !== reviewed.ledgerEpoch || result.sourceLedgerEpoch !== reviewed.sourceLedgerEpoch ||
          result.digest !== reviewed.digest || result.memberCount !== reviewed.memberCount || result.entryCount !== reviewed.entryCount ||
          ledgerEpochOf(result.ledgerEpoch) === result.targetEpoch || result.ledgerEpoch === result.sourceLedgerEpoch) throw invalid();
        check(scope(), original); workspace.storage.removeItem(key); return result;
      });
    },
    async forgetPreview() { if (flow) { try { await flow.discardPreview(); } catch {} } }
  };
}
