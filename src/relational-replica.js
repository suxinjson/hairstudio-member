import { ARCHIVE_LIMITS } from './relational-archive.js';

export const REPLICA_FORMAT = Object.freeze({ engine: 'cloud-replica', schemaVersion: 1 });
export const REPLICA_TABLES = Object.freeze({ head: ['value'], configuration: ['value'], member: ['value'], ledger: ['value'] });
export const REPLICA_TIMEOUT_MS = 10 * 60 * 1000;

export function validateReplicaRow(table, row) {
  if (!row || typeof row.value !== (table === 'head' ? 'string' : 'object') || row.value === null || Array.isArray(row.value)) {
    throw Object.assign(new Error('云端副本记录无效'), { code: 'REPLICA_SNAPSHOT_INVALID' });
  }
}

export async function* replicaChunks(stream) {
  if (!stream || typeof stream.getReader !== 'function') throw new Error('服务器未返回云端副本数据流');
  const reader = stream.getReader(); let completed = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { completed = true; return; }
      for (let at = 0; at < value.byteLength; at += ARCHIVE_LIMITS.chunkBytes) yield value.subarray(at, at + ARCHIVE_LIMITS.chunkBytes);
    }
  } finally {
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
