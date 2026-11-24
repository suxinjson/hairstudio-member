import { Capacitor, registerPlugin } from '@capacitor/core';
import { ARCHIVE_LIMITS } from './relational-archive.js';
import { sha256Stream } from './sha256-stream.js';

const bridge = registerPlugin('ArchiveDocuments'), CHUNK_BYTES = 64 * 1024;
const fail = (message, code = 'ARCHIVE_FILE_INVALID') => Object.assign(new Error(message), { code });
const aborted = () => fail('外部备份已取消或文件提供方无响应', 'ARCHIVE_ABORTED');
function encoded(bytes) {
  let text = ''; for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192)); return btoa(text);
}
function decoded(text) {
  if (typeof text !== 'string' || !text.length || text.length > Math.ceil(CHUNK_BYTES / 3) * 4) throw fail('原生文件块尺寸无效');
  let value; try { value = atob(text); } catch { throw fail('原生文件块编码无效'); }
  const bytes = Uint8Array.from(value, char => char.charCodeAt(0));
  if (bytes.length > CHUNK_BYTES || encoded(bytes) !== text) throw fail('原生文件块不是规范字节编码'); return bytes;
}

// A selected handle owns the one document slot until close/verified save.
// Only bounded bytes and opaque tokens cross the bridge, never a URI or book.
export function androidArchiveDocuments({ plugin = bridge, native = Capacitor.isNativePlatform(), idleMs = 15000, totalMs = 10 * 60 * 1000 } = {}) {
  let active = false;
  async function select(method, input, signal) {
    if (!native) throw fail('流式外部备份需要 Android 系统文档选择器', 'BACKUP_FILE_UNAVAILABLE');
    if (active) throw fail('已有外部文件操作正在进行', 'BACKUP_FILE_BUSY');
    if (signal?.aborted) throw aborted(); active = true;
    let abortSelection;
    try {
      // A person may leave the picker open. No snapshot or restore transaction
      // starts until selection completes, so picker time has no I/O deadline.
      const cancelled = new Promise((_, reject) => { abortSelection = () => { void plugin.cancel({}).catch(() => {}); reject(aborted()); }; signal?.addEventListener('abort', abortSelection, { once: true }); });
      const selected = await Promise.race([plugin[method](input), cancelled]);
      if (selected?.cancelled === true) { active = false; return { status: 'cancelled' }; }
      if (typeof selected?.token !== 'string' || !/^[a-f0-9-]{36}$/.test(selected.token)) throw fail('原生文件捕获无效');
      return handle(selected.token, method === 'create' ? 'write' : 'read', signal, selected.fileName);
    } catch (error) { active = false; throw error; }
    finally { signal?.removeEventListener('abort', abortSelection); }
  }
  function handle(token, mode, external, fileName) {
    const controller = new AbortController(), born = Date.now(); let closed = false, working = false, begun = false, sequence = 0, lastRead;
    const hash = sha256Stream();
    const cancel = () => { if (!closed) { closed = true; active = false; controller.abort(); void plugin.cancel({ token }).catch(() => {}); external?.removeEventListener('abort', cancel); } };
    external?.addEventListener('abort', cancel, { once: true }); if (external?.aborted) cancel();
    async function io(method, args = {}) {
      if (closed || controller.signal.aborted) throw aborted();
      const timeout = Math.min(idleMs, totalMs - (Date.now() - born)); if (timeout <= 0) { cancel(); throw aborted(); }
      let timer, abort;
      const stopped = new Promise((_, reject) => {
        abort = () => reject(aborted()); controller.signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => { cancel(); reject(aborted()); }, timeout);
      });
      try { return await Promise.race([Promise.resolve().then(() => plugin[method]({ token, ...args })), stopped]); }
      catch (error) { cancel(); throw error; }
      finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
    }
    function enter(expected) { if (mode !== expected || closed) throw fail('外部文件捕获不可用', 'ARCHIVE_FILE_CAPTURE_LOST'); if (working) throw fail('文件块操作重叠', 'BACKUP_FILE_BUSY'); working = true; }
    function complete() { closed = true; active = false; external?.removeEventListener('abort', cancel); }
    async function close() {
      if (!closed) {
        if (working) { cancel(); return; }
        try { await io('close'); } finally { complete(); }
      }
    }
    return {
      fileName: typeof fileName === 'string' ? fileName.slice(0, 255) : 'member-book.ndjson',
      get lastRead() { return lastRead ? { ...lastRead } : null; },
      async write(line) {
        enter('write');
        try {
          if (typeof line !== 'string') throw fail('导出块须为 UTF-8 文本');
          const bytes = new TextEncoder().encode(line); if (!bytes.length || bytes.length > ARCHIVE_LIMITS.frameBytes || hash.byteLength + bytes.length > ARCHIVE_LIMITS.totalBytes) throw fail('导出块或文件超过容量');
          if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== line) throw fail('导出块包含无效 Unicode');
          if (!begun) { const start = await io('beginWrite'); if (start?.sequence !== 0 || start.byteLength !== 0) throw fail('原生文件起点无效'); begun = true; }
          for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
            const chunk = bytes.subarray(at, at + CHUNK_BYTES), result = await io('writeChunk', { sequence, data: encoded(chunk) });
            if (result?.sequence !== sequence || result.byteLength !== hash.byteLength + chunk.length) throw fail('文件写入回执与原字节不符'); hash.update(chunk); sequence++;
          }
        } catch (error) { cancel(); throw error; } finally { working = false; }
      },
      async finish() {
        enter('write');
        try {
          if (!begun) throw fail('尚无完整备份可供保存');
          const checksum = hash.hex(), pending = await io('beginVerify');
          if (pending?.verifying !== true || pending.byteLength !== hash.byteLength || pending.sha256 !== checksum) throw fail('原生导出字节摘要不一致');
          for (;;) {
            const result = await io('verifyChunk');
            if (result?.verified === false) continue;
            if (result?.status !== 'saved-verified' || result.byteLength !== hash.byteLength || result.sha256 !== checksum) throw fail('外部文件写后读回未通过', 'BACKUP_FILE_WRITE_FAILED');
            complete(); return { ...result, sha256: checksum, byteLength: hash.byteLength };
          }
        } catch (error) { cancel(); throw error; } finally { working = false; }
      },
      async *chunks() {
        enter('read'); let ended = false; lastRead = null;
        try {
          const hash = sha256Stream(), start = await io('beginRead'); let number = 0;
          if (start?.sequence !== 0 || start.byteLength !== 0) throw fail('原生读取起点无效');
          for (;;) {
            const result = await io('readChunk', { sequence: number });
            if (result?.sequence !== number++ || typeof result.done !== 'boolean') throw fail('文件读取序号无效');
            if (result.done) {
              if ('data' in result || result.byteLength !== hash.byteLength || result.sha256 !== hash.hex()) throw fail('文件完整读取摘要无效');
              lastRead = { byteLength: hash.byteLength, sha256: hash.hex() }; ended = true; return;
            }
            const chunk = decoded(result.data);
            if (hash.byteLength + chunk.length > ARCHIVE_LIMITS.totalBytes || result.byteLength !== hash.byteLength + chunk.length) throw fail('文件读取计数或容量无效');
            hash.update(chunk); yield chunk;
          }
        } catch (error) { cancel(); throw error; } finally { working = false; if (!ended) cancel(); }
      },
      close,
      cancel
    };
  }
  return {
    create({ fileName, signal } = {}) {
      if (typeof fileName !== 'string' || !/^[a-zA-Z0-9_-]{1,180}\.ndjson$/.test(fileName)) return Promise.reject(fail('流式备份文件名无效'));
      return select('create', { fileName }, signal);
    },
    open({ signal } = {}) { return select('choose', {}, signal); }
  };
}
