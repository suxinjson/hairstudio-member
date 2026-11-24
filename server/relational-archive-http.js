import { ApiError } from './security.js';
import { ARCHIVE_LIMITS } from '../src/relational-archive.js';
import { archiveLifetime } from './relational-archive.js';

const closed = () => new ApiError(408, '备份连接已中断', 'ARCHIVE_ABORTED');
// A completed restore returns its receipt without reading the source. Finish
// receiving that HTTP request before replying, otherwise closing a connection
// with upload bytes in flight can reset the response. Discard bounded chunks
// outside the SQL transaction; never parse or retain the duplicate archive.
export async function finishArchiveUpload(request, signal, timeouts) {
  if (request.readableEnded) return;
  const life = archiveLifetime(signal, timeouts); let bytes = 0;
  try {
    for await (const chunk of life.chunks(request.iterator({ destroyOnReturn: false }))) {
      bytes += chunk.byteLength;
      if (bytes > ARCHIVE_LIMITS.totalBytes) throw new ApiError(413, '恢复文件超出流式容量', 'ARCHIVE_CAPACITY');
    }
    life.check();
  } finally { life.close(); }
}
export function writeArchiveChunk(response, line) {
  return new Promise((resolve, reject) => {
    if (response.destroyed || response.writableEnded) return reject(closed());
    const failed = error => { cleanup(); reject(error instanceof Error ? error : closed()); };
    const cleanup = () => { response.off('close', failed); response.off('error', failed); };
    response.once('close', failed); response.once('error', failed);
    try { response.write(line, error => { cleanup(); if (error) reject(error); else resolve(); }); }
    catch (error) { failed(error); }
  });
}
export async function relationalArchiveRoute({ ledger, identity, request, response, url, guard }) {
  const preview = url.pathname.endsWith('/preview'), download = request.method === 'GET';
  const replica = url.pathname === '/api/v2/sync/snapshot';
  guard.take((replica ? 'v2-replica:' : download ? 'v2-backup:' : 'v2-restore:') + identity.id, 3);
  const controller = new AbortController(), abort = () => controller.abort();
  const disconnected = () => { if (!response.writableFinished) abort(); };
  request.once('aborted', abort); response.once('close', disconnected);
  try {
    if (download) {
      if (replica ? [...url.searchParams].length !== 1 || !url.searchParams.has('ledgerEpoch') : [...url.searchParams].length) throw new ApiError(400, '流式导出查询参数无效');
      await ledger[replica ? 'exportReplica' : 'exportArchive'](identity, { ...(replica && { ledgerEpoch: url.searchParams.get('ledgerEpoch') }), signal: controller.signal, write: line => {
        if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store',
          ...(!replica && { 'Content-Disposition': 'attachment; filename="member-relational-backup.ndjson"' }), 'X-Accel-Buffering': 'no' });
        return writeArchiveChunk(response, line);
      } });
      response.end(); return { streamed: true };
    }
    if (!/^application\/x-ndjson(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new ApiError(415, '恢复需要 UTF-8 NDJSON 字节流');
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || BigInt(length) > BigInt(ARCHIVE_LIMITS.totalBytes))) throw new ApiError(413, '恢复文件超出流式容量', 'ARCHIVE_CAPACITY');
    const query = Object.fromEntries(url.searchParams);
    if ([...url.searchParams].length !== Object.keys(query).length) throw new ApiError(400, '恢复参数不得重复');
    const result = await ledger[preview ? 'previewArchiveRestore' : 'restoreArchive'](identity, { ...query, chunks: request, signal: controller.signal });
    await finishArchiveUpload(request, controller.signal);
    return { status: 200, value: result };
  } finally { request.off('aborted', abort); response.off('close', disconnected); }
}
