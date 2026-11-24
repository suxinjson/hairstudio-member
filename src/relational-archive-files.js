import { androidArchiveDocuments } from './android-archive-documents.js';
import { canonicalJSON } from './canonical-json.js';
import { ENTITY_ID, COMMAND_ID } from './relational-contract.js';
import { requireLedgerEpoch } from './ledger-epoch.js';
import { ARCHIVE_LIMITS } from './relational-archive.js';
import { sha256Stream } from './sha256-stream.js';

const fail = (message, code) => Object.assign(new Error(message), { code });
function checkpoint(signal) { if (signal?.aborted) throw fail('备份操作已取消', 'ARCHIVE_ABORTED'); }
function bytesInfo(value) {
  if (!Number.isSafeInteger(value?.byteLength) || value.byteLength < 1 || value.byteLength > ARCHIVE_LIMITS.totalBytes || !/^[a-f0-9]{64}$/.test(value.sha256)) throw fail('外部文件字节摘要无效', 'BACKUP_FILE_READ_FAILED');
  return { byteLength: value.byteLength, sha256: value.sha256 };
}

// Retain an opaque external document handle and bounded review metadata only.
// No complete archive, URI, permission or file content is saved in the client.
export function createRelationalArchiveFiles({ repository, getScope, documents = androidArchiveDocuments(), id = () => crypto.randomUUID() }) {
  let busy = false, candidate = null;
  function scope() {
    const value = getScope();
    if (!value || typeof value.storeId !== 'string' || !ENTITY_ID.test(value.storeId) || typeof value.actorId !== 'string' || !ENTITY_ID.test(value.actorId) || typeof value.deviceId !== 'string' || !COMMAND_ID.test(value.deviceId)) throw fail('备份身份不可用', 'AUTH_CONTEXT_CHANGED');
    return { storeId: value.storeId, actorId: value.actorId, deviceId: value.deviceId };
  }
  function same(captured) { try { return canonicalJSON(scope()) === canonicalJSON(captured); } catch { return false; } }
  function requireScope(captured) { if (!same(captured)) throw fail('备份期间账号或设备已变化，请在原身份查询结果', 'AUTH_CONTEXT_CHANGED'); }
  async function exclusive(work) { if (busy) throw fail('已有备份文件操作正在进行', 'BACKUP_FILE_BUSY'); busy = true; try { return await work(); } finally { busy = false; } }
  const info = current => current ? { token: current.token, fileName: current.handle.fileName, ...structuredClone(current.preview) } : null;
  async function release(current) { if (current) { try { await current.handle.close(); } catch { current.handle.cancel(); } } }
  return {
    getPreview: () => info(candidate),
    getCapture: () => candidate ? { ...info(candidate), sha256: candidate.bytes.sha256 } : null,
    discardPreview() { return exclusive(async () => { const previous = candidate; candidate = null; await release(previous); }); },
    save({ signal } = {}) {
      return exclusive(async () => {
        checkpoint(signal); const captured = scope(); let handle, saved = false;
        try {
          // The picker runs before a physical database snapshot is acquired.
          handle = await documents.create({ fileName: 'member-book-' + captured.storeId + '-' + new Date().toISOString().slice(0, 10) + '.ndjson', signal });
          if (handle?.status === 'cancelled') return { status: 'cancelled' };
          checkpoint(signal); requireScope(captured);
          const book = await repository.getBook();
          if (book.storeId !== captured.storeId) throw fail('备份目标门店不同', 'AUTH_CONTEXT_CHANGED');
          checkpoint(signal); requireScope(captured);
          const hash = sha256Stream();
          const exported = await repository.exportArchive({ signal, write: async line => {
            checkpoint(signal); requireScope(captured); await handle.write(line); hash.update(new TextEncoder().encode(line));
          } });
          checkpoint(signal); requireScope(captured);
          const result = await handle.finish();
          if (result?.status !== 'saved-verified' || result.byteLength !== exported.byteLength || result.byteLength !== hash.byteLength || result.sha256 !== hash.hex()) throw fail('外部文件写后读回与导出内容不同', 'BACKUP_FILE_WRITE_FAILED');
          saved = true;
          return { status: 'saved-verified', fileName: result.fileName, byteLength: result.byteLength, sha256: result.sha256, digest: exported.digest, contextChanged: !same(captured) };
        } finally { if (handle && handle.status !== 'cancelled' && !saved) handle.cancel(); }
      });
    },
    chooseRestore({ signal, resume } = {}) {
      return exclusive(async () => {
        const previous = candidate; candidate = null; await release(previous);
        checkpoint(signal); const captured = scope(), book = await repository.getBook(); requireScope(captured);
        if (book.storeId !== captured.storeId) throw fail('备份目标门店不同', 'AUTH_CONTEXT_CHANGED');
        let handle, retained = false;
        try {
          handle = await documents.open({ signal });
          if (handle?.status === 'cancelled') return { status: 'cancelled' };
          checkpoint(signal); requireScope(captured);
          let preview;
          if (resume) {
            requireLedgerEpoch(resume.ledgerEpoch, book.ledgerEpoch);
            const hash = sha256Stream();
            for await (const chunk of handle.chunks()) { checkpoint(signal); requireScope(captured); hash.update(chunk); }
            if (hash.byteLength !== resume.byteLength || hash.hex() !== resume.sha256) throw fail('请重选与原任务摘要一致的文件', 'BACKUP_REVIEW_REQUIRED');
            const { token, fileName, sha256, ...fields } = resume;
            preview = fields;
          } else preview = await repository.previewArchiveRestore({ ...captured, ledgerEpoch: book.ledgerEpoch, chunks: handle.chunks(), signal });
          checkpoint(signal); requireScope(captured); requireLedgerEpoch(book.ledgerEpoch, preview.ledgerEpoch);
          const bytes = bytesInfo(handle.lastRead);
          if (bytes.byteLength !== preview.byteLength) throw fail('预览与原文件长度不同', 'BACKUP_FILE_READ_FAILED');
          const token = resume?.token ?? id(); if (typeof token !== 'string' || !COMMAND_ID.test(token)) throw fail('恢复任务号无效', 'BACKUP_REVIEW_REQUIRED');
          candidate = { token, scope: captured, ledgerEpoch: book.ledgerEpoch, handle, bytes, preview: structuredClone(preview) }; retained = true;
          return { status: 'preview', ...info(candidate) };
        } finally { if (handle && handle.status !== 'cancelled' && !retained) handle.cancel(); }
      });
    },
    restore(token, reviewedDigest, { signal } = {}) {
      return exclusive(async () => {
        checkpoint(signal); const current = candidate;
        if (!current || token !== current.token || reviewedDigest !== current.preview.digest) throw fail('请重新选择文件并核对摘要', 'BACKUP_REVIEW_REQUIRED');
        requireScope(current.scope);
        const capture = { ...current.scope, id: current.token, ledgerEpoch: current.ledgerEpoch, digest: current.preview.digest };
        let result;
        // A committed original task is authoritative even if the selected
        // document has disappeared or later transactions have been recorded.
        try { result = await repository.getRestoreReceipt(capture); }
        catch (error) { if (error.code !== 'RESTORE_NOT_FOUND') throw error; }
        if (!result) {
          checkpoint(signal); requireScope(current.scope);
          async function* reviewedBytes() {
            const hash = sha256Stream();
            for await (const chunk of current.handle.chunks()) { checkpoint(signal); requireScope(current.scope); hash.update(chunk); yield chunk; }
            const read = bytesInfo(current.handle.lastRead);
            // This check executes before iterator completion, inside restore's
            // database transaction. A changed file can never commit its rows.
            if (hash.byteLength !== current.bytes.byteLength || hash.hex() !== current.bytes.sha256 || read.byteLength !== hash.byteLength || read.sha256 !== hash.hex()) throw fail('文件在预览后已变化，请重新核对', 'BACKUP_REVIEW_REQUIRED');
            checkpoint(signal); requireScope(current.scope);
          }
          result = await repository.restoreArchive({ ...capture, chunks: reviewedBytes(), signal });
        }
        candidate = null; await release(current);
        return { status: 'restored', result, contextChanged: !same(current.scope) };
        // A submission error deliberately retains the original task capture.
        // An explicit retry checks its receipt before touching the file again.
      });
    }
  };
}
