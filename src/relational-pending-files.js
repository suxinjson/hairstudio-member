import { DATA_LIMITS } from './data-limits.js';

// Called from an explicit user gesture so the browser can show its picker.
// Do not clear a pending request after an ordinary unverified download.
export async function openPendingWriter(id) {
  const handle = await globalThis.showSaveFilePicker({ suggestedName: 'member-pending-' + id + '.json', types: [{ description: '原操作核对文件', accept: { 'application/json': ['.json'] } }] });
  return async ({ content }) => {
    const bytes = new TextEncoder().encode(content), writer = await handle.createWritable();
    try { await writer.write(bytes); await writer.close(); }
    catch (error) { await writer.abort().catch(() => {}); throw error; }
    const file = await handle.getFile();
    if (file.size !== bytes.length || file.size > DATA_LIMITS.operationBytes + 4096) throw new Error('外部文件长度未通过读回核验');
    const result = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
    return { status: 'saved-verified', sha256: Array.from(result, value => value.toString(16).padStart(2, '0')).join('') };
  };
}
