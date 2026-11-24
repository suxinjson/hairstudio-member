import { canonicalJSON } from './canonical-json.js';
import { DATA_LIMITS, boundedText, byteLength } from './data-limits.js';
import { ENTITY_ID, COMMAND_ID } from './relational-contract.js';
import { validateSqliteBackup } from './relational-sqlite-backup.js';
import { androidBackupDocuments } from './android-backup-documents.js';

const fail = (message, code) => Object.assign(new Error(message), { code });
const sha256 = async content => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))), byte => byte.toString(16).padStart(2, '0')).join('');

// A standalone-only file workflow. Its private preview holds an immutable
// capture, never a mutable caller object or a localStorage business snapshot.
export function createRelationalBackupFiles({ repository, getScope, documents = androidBackupDocuments(), hash = sha256, id = () => crypto.randomUUID() }) {
  let busy = false, candidate = null;
  function scope() {
    const value = getScope();
    if (!value || !['storeId', 'actorId', 'deviceId'].every(key => typeof value[key] === 'string') || !ENTITY_ID.test(value.storeId) || !ENTITY_ID.test(value.actorId) || !COMMAND_ID.test(value.deviceId)) throw fail('本地备份身份不可用', 'AUTH_CONTEXT_CHANGED');
    return { storeId: value.storeId, actorId: value.actorId, deviceId: value.deviceId };
  }
  const same = captured => { try { return canonicalJSON(scope()) === canonicalJSON(captured); } catch { return false; } };
  function requireScope(captured) { if (!same(captured)) throw fail('备份期间账号或设备已变化，请在当前身份重新选择文件', 'AUTH_CONTEXT_CHANGED'); }
  async function exclusive(work) {
    if (busy) throw fail('已有备份文件操作正在进行', 'BACKUP_FILE_BUSY');
    busy = true; try { return await work(); } finally { busy = false; }
  }
  function info(current) { return current ? { token: current.token, fileName: current.fileName, byteLength: current.byteLength, ...current.preview } : null; }
  return {
    getPreview: () => info(candidate),
    discardPreview() { if (busy) throw fail('备份操作仍在进行', 'BACKUP_FILE_BUSY'); candidate = null; },
    save() {
      return exclusive(async () => {
        const captured = scope(), exported = await repository.exportBackup(); requireScope(captured);
        const backup = JSON.parse(JSON.stringify(exported));
        await validateSqliteBackup(backup, { storeId: captured.storeId, hash }); requireScope(captured);
        const content = canonicalJSON(backup), checksum = await hash(content); requireScope(captured);
        const fileName = 'member-book-' + captured.storeId + '-' + backup.exportedAt.slice(0, 10) + '.json';
        const result = await documents.save({ content, fileName });
        if (result?.status === 'cancelled') return { status: 'cancelled' };
        if (result?.status !== 'saved-verified' || result.sha256 !== checksum || result.byteLength !== byteLength(content)) throw fail('保存的外部文件与导出账本不一致，请保留手机原账本', 'BACKUP_FILE_WRITE_FAILED');
        // A context change after the OS write does not undo that write or turn
        // it into a failure. The UI must suppress old-context success effects.
        return { status: 'saved-verified', fileName: result.fileName, byteLength: result.byteLength, sha256: checksum, digest: backup.digest, contextChanged: !same(captured) };
      });
    },
    chooseRestore() {
      return exclusive(async () => {
        candidate = null; const captured = scope(); await repository.getBook(); requireScope(captured);
        const selected = await documents.open(); requireScope(captured);
        const file = selected ? { ...selected } : null;
        if (file?.status === 'cancelled') return { status: 'cancelled' };
        boundedText(file?.content, DATA_LIMITS.restoreBytes, '备份文件', true);
        if (byteLength(file.content) > DATA_LIMITS.restoreBytes || file.byteLength !== byteLength(file.content) || await hash(file.content) !== file.sha256) throw fail('读取的外部文件完整性不匹配', 'BACKUP_FILE_READ_FAILED');
        requireScope(captured); let backup;
        try { backup = JSON.parse(file.content); } catch { throw fail('备份不是有效 JSON 文件', 'BACKUP_FILE_INVALID'); }
        await validateSqliteBackup(backup, { storeId: captured.storeId, hash }); requireScope(captured);
        const preview = await repository.previewBackupRestore(backup); requireScope(captured);
        candidate = { token: id(), scope: captured, backup, preview, fileName: typeof file.fileName === 'string' ? file.fileName.slice(0, 255) : 'backup.json', byteLength: file.byteLength };
        return { status: 'preview', ...info(candidate) };
      });
    },
    restore(token, reviewedDigest) {
      return exclusive(async () => {
        const current = candidate;
        if (!current || token !== current.token || reviewedDigest !== current.backup.digest) throw fail('请重新选择文件并核对备份摘要', 'BACKUP_REVIEW_REQUIRED');
        requireScope(current.scope);
        // Stable preview token is also the restore task ID. The repository
        // checks a completed receipt before the original target epoch, so an
        // unknown COMMIT result can be queried/retried after later business.
        const result = await repository.restoreBackup(current.backup, { ...current.scope, id: current.token, digest: reviewedDigest, ledgerEpoch: current.preview.ledgerEpoch });
        candidate = null;
        return { status: 'restored', result, contextChanged: !same(current.scope) };
      });
    }
  };
}
