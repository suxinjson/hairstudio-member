import { Capacitor, registerPlugin } from '@capacitor/core';
import { DATA_LIMITS, byteLength, boundedText } from './data-limits.js';

const bridge = registerPlugin('BackupDocuments');
const fail = (message, code = 'BACKUP_FILE_INVALID') => Object.assign(new Error(message), { code });
export function androidBackupDocuments({ plugin = bridge, native = Capacitor.isNativePlatform() } = {}) {
  let active = false;
  async function exclusive(work) {
    if (!native) throw fail('独立离线备份文件需要 Android 系统文档选择器', 'BACKUP_FILE_UNAVAILABLE');
    if (active) throw fail('已有文件操作正在进行', 'BACKUP_FILE_BUSY');
    active = true; try { return await work(); } finally { active = false; }
  }
  return {
    save({ content, fileName }) {
      return exclusive(async () => {
        boundedText(content, DATA_LIMITS.restoreBytes, '备份文件', true);
        if (typeof content !== 'string' || !content.length || byteLength(content) > DATA_LIMITS.restoreBytes || !/^[a-zA-Z0-9_-]{1,180}\.json$/.test(fileName)) throw fail('备份文件内容、名称或大小无效');
        const { token } = await plugin.stage({ content });
        if (typeof token !== 'string' || !/^[a-f0-9-]{36}$/.test(token)) throw fail('无法捕获外部备份');
        try {
          // Keep the Activity's saved call small: only a random token and name,
          // never a multi-megabyte book in Android's saved-instance Bundle.
          const result = await plugin.save({ token, fileName });
          if (result?.cancelled === true) return { status: 'cancelled' };
          if (result?.status !== 'saved-verified' || !/^[a-f0-9]{64}$/.test(result.sha256) || !Number.isSafeInteger(result.byteLength) || result.byteLength !== byteLength(content)) throw fail('外部文件写入未完成校验', 'BACKUP_FILE_WRITE_FAILED');
          return result;
        } finally { await plugin.discard({ token }).catch(() => {}); }
      });
    },
    open({ maxBytes = DATA_LIMITS.restoreBytes } = {}) {
      return exclusive(async () => {
        if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > DATA_LIMITS.restoreBytes) throw fail('文档读取上限无效');
        const result = await plugin.open({ maxBytes }); if (result?.cancelled === true) return { status: 'cancelled' };
        if (typeof result?.content !== 'string' || byteLength(result.content) > maxBytes || byteLength(result.content) !== result.byteLength || !/^[a-f0-9]{64}$/.test(result.sha256)) throw fail('读取的外部文件无效', 'BACKUP_FILE_READ_FAILED');
        return result;
      });
    }
  };
}
