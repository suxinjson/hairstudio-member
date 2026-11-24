import { canonicalJSON } from './canonical-json.js';
import { ARCHIVE_LIMITS, readRelationalArchive } from './relational-archive.js';
import { PG_BACKUP_TABLES } from './relational-pg-archive-tables.js';
import { sha256Stream } from './sha256-stream.js';
import { COMMAND_ID } from './relational-contract.js';
import { ledgerEpochOf } from './ledger-epoch.js';

const route = '/api/v2/backup/archive';
const contentType = 'application/x-ndjson';
const failure = (message, code = 'RESTORE_REVIEW_REQUIRED') => Object.assign(new Error(message), { code });
const fileDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = ({ storeId, actorId, deviceId }) => [storeId, actorId, deviceId];
async function hashFrame(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
function fileLength(file) {
  if (!file || typeof file.stream !== 'function' || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > ARCHIVE_LIMITS.totalBytes) throw failure('文件大小无效或超限');
}
async function* chunks(stream, checkpoint) {
  const reader = stream.getReader();
  try {
    for (;;) {
      checkpoint(); const { value, done } = await reader.read();
      checkpoint(); if (done) return;
      for (let i = 0; i < value.length; i += ARCHIVE_LIMITS.chunkBytes) yield value.subarray(i, i + ARCHIVE_LIMITS.chunkBytes);
    }
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}
async function bytesOf(file, checkpoint) {
  const hash = sha256Stream();
  for await (const value of chunks(file.stream(), checkpoint)) hash.update(value);
  if (hash.byteLength !== file.size) throw failure('文件在读取期间变化');
  return hash.hex();
}
function capture(value) {
  if (!COMMAND_ID.test(value?.taskId ?? '') || !fileDigest(value.sourceDigest) || !fileDigest(value.sha256) ||
    !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > ARCHIVE_LIMITS.totalBytes ||
    !Number.isSafeInteger(value.memberCount) || value.memberCount < 0 || !Number.isSafeInteger(value.entryCount) || value.entryCount < 0) throw failure('恢复任务记录无效，请保留并核对');
  ledgerEpochOf(value.targetEpoch); ledgerEpochOf(value.sourceEpoch);
  return value;
}

export function createServerArchiveFiles({ workspace, api, savePicker = globalThis.showSaveFilePicker?.bind(globalThis) }) {
  const storage = workspace.storage;
  let lastPreview = null;
  const key = scope => 'hairstudio_v2_restore:' + identity(scope).join(':');
  const snapshot = () => { const scope = workspace.getScope(); if (!scope) throw failure('请先连接当前账本'); return scope; };
  function same(scope, { permitNewEpoch = false } = {}) {
    const now = snapshot();
    if (canonicalJSON(identity(scope)) !== canonicalJSON(identity(now)) || !permitNewEpoch && scope.ledgerEpoch !== now.ledgerEpoch) throw failure('文件操作期间身份或账本已变化', 'AUTH_CONTEXT_CHANGED');
  }
  function pending(scope = snapshot()) {
    const saved = storage.getItem(key(scope));
    return saved === null ? null : capture(JSON.parse(saved));
  }
  function verifyReceipt(result, review, scope) {
    if (result?.storeId !== scope.storeId || result.taskId !== review.taskId || result.targetEpoch !== review.targetEpoch ||
        result.sourceEpoch !== review.sourceEpoch || result.sourceDigest !== review.sourceDigest || result.memberCount !== review.memberCount ||
        result.entryCount !== review.entryCount || ledgerEpochOf(result.ledgerEpoch) === review.targetEpoch || result.ledgerEpoch === review.sourceEpoch) throw failure('恢复回执与原任务不一致');
    same(scope, { permitNewEpoch: true }); storage.removeItem(key(scope)); lastPreview = null;
    return result;
  }
  const upload = (suffix, query, file, signal) => api.requestStream(route + '/restore' + suffix + '?' + new URLSearchParams(query), undefined,
    { method: 'POST', body: file, headers: { 'Content-Type': contentType }, signal });
  return {
    canSave: Boolean(savePicker), pending,
    async save({ signal } = {}) {
      if (!savePicker) throw failure('请使用支持选择外部保存位置的 Chrome 或 Edge 浏览器');
      const scope = snapshot();
      const handle = await savePicker({ suggestedName: 'member-book-' + new Date().toISOString().slice(0, 10) + '.ndjson',
        types: [{ description: '会员账本备份', accept: { [contentType]: ['.ndjson'] } }] });
      same(scope); const target = await handle.createWritable(); let closed = false;
      try {
        const transfer = sha256Stream();
        const archive = await api.requestStream(route, async (response, assertSession) => {
          if (!response.body || !response.headers.get('content-type')?.startsWith(contentType)) throw failure('服务器未返回账本备份文件');
          const checkpoint = () => { signal?.throwIfAborted(); assertSession(); same(scope); };
          async function* tap() {
            for await (const value of chunks(response.body, checkpoint)) { transfer.update(value); await target.write(value); yield value; }
          }
          return readRelationalArchive({ chunks: tap(), tables: PG_BACKUP_TABLES, engine: 'postgres', schemaVersion: 2, storeId: scope.storeId,
            hash: hashFrame, validateRow: () => {}, checkpoint, onHeader: header => {
              if (header.ledgerEpoch !== scope.ledgerEpoch) throw failure('备份账本代际已变化');
            } });
        }, { signal });
        same(scope); signal?.throwIfAborted(); await target.close(); closed = true;
        const saved = await handle.getFile();
        if (saved.size !== archive.byteLength || await bytesOf(saved, () => { signal?.throwIfAborted(); same(scope); }) !== transfer.hex()) throw failure('外部文件读回与服务器导出不同');
        return { status: 'saved-verified', digest: archive.digest, byteLength: archive.byteLength, fileName: saved.name };
      } finally { if (!closed) { try { await target.abort(); } catch {} } }
    },
    async chooseRestore(file, { signal } = {}) {
      fileLength(file); const scope = snapshot();
      if (pending(scope)) throw failure('请先核对原恢复任务');
      lastPreview = null;
      const sha256 = await bytesOf(file, () => { signal?.throwIfAborted(); same(scope); });
      const id = crypto.randomUUID();
      const preview = await upload('/preview', { id, ledgerEpoch: scope.ledgerEpoch }, file, signal);
      same(scope);
      if (preview?.taskId !== id || preview.targetEpoch !== scope.ledgerEpoch || preview.byteLength !== file.size) throw failure('服务器预览与所选文件或目标不同');
      const review = capture({ taskId: id, targetEpoch: preview.targetEpoch, sourceEpoch: preview.sourceEpoch, sourceDigest: preview.sourceDigest,
        sha256, byteLength: preview.byteLength, memberCount: preview.memberCount, entryCount: preview.entryCount });
      lastPreview = { file, scope, review };
      return { ...review, fileName: file.name };
    },
    async restore(taskId, fileOverride, { signal } = {}) {
      const scope = snapshot();
      return workspace.lock(key(scope), async () => {
        same(scope); const saved = pending(scope), reviewed = lastPreview?.review;
        if ((saved ?? reviewed)?.taskId !== taskId || !saved && !lastPreview) throw failure('请先选择并核对原文件');
        const review = saved ?? reviewed;
        if (saved) {
          const query = new URLSearchParams({ ledgerEpoch: saved.targetEpoch });
          try { return verifyReceipt(await api.request('/api/v2/backup/restores/' + saved.taskId + '?' + query), saved, scope); }
          catch (error) { if (error.status !== 404 || error.code !== 'RESTORE_NOT_FOUND') throw error; }
        }
        if (review.targetEpoch !== scope.ledgerEpoch) throw failure('原任务属于其他代际，请保留文件和任务号');
        const file = lastPreview?.review.taskId === taskId ? lastPreview.file : fileOverride;
        fileLength(file);
        if (file.size !== review.byteLength || await bytesOf(file, () => { signal?.throwIfAborted(); same(scope); }) !== review.sha256) throw failure('请重选与原任务摘要一致的文件');
        same(scope);
        const record = JSON.stringify(review); storage.setItem(key(scope), record);
        if (storage.getItem(key(scope)) !== record) throw failure('原恢复任务未可靠保存，尚未提交');
        return verifyReceipt(await upload('', { id: review.taskId, ledgerEpoch: review.targetEpoch, sourceEpoch: review.sourceEpoch, reviewedDigest: review.sourceDigest }, file, signal), review, scope);
      });
    },
    forgetPreview() { lastPreview = null; }
  };
}
