import { canonicalJSON } from '../../../src/canonical-json.js';
import { LEDGER_EPOCH } from '../../../src/ledger-epoch.js';
import { LEDGER_EXPORT, XLSX_TYPE } from '../../../src/relational-export-sheet.js';

const route = '/api/v2/exports/ledger';
const changed = () => Object.assign(new Error('登录身份或账本已变化，请重新打开导出页面'), { code: 'AUTH_CONTEXT_CHANGED' });
export function createLedgerExportClient({ workspace, api }) {
  async function request(scope, suffix, { signal, body, consume } = {}) {
    api.restoreSession();
    const key = canonicalJSON(scope), check = () => {
      signal?.throwIfAborted();
      if (!scope || canonicalJSON(workspace.getScope()) !== key) throw changed();
    };
    check();
    const path = route + suffix + (body ? '' : '?' + new URLSearchParams({ ledgerEpoch: scope.ledgerEpoch }));
    try {
      const result = await api.requestStream(path, consume, { signal, ...(body && { method: 'POST', body: JSON.stringify({ ...body, ledgerEpoch: scope.ledgerEpoch }) }) }, consume ? 60000 : 15000);
      check();
      return result;
    } catch (error) {
      if (error.code === 'LEDGER_EPOCH_MISMATCH' && canonicalJSON(workspace.getScope()) === key) void workspace.connect();
      throw error;
    }
  }
  function taskPath(id) {
    if (!LEDGER_EPOCH.test(id)) throw new Error('导出任务号无效');
    return '/' + id;
  }
  return {
    current: (scope, signal) => request(scope, '', { signal }),
    queue: (scope, { id, from, to }, signal) => request(scope, '', { signal, body: { id, from, to } }),
    discard: (scope, id, signal) => request(scope, taskPath(id) + '/discard', { signal, body: {} }),
    download: (scope, id, signal) => request(scope, taskPath(id) + '/file', { signal, async consume(response, checkSession) {
      const length = Number(response.headers.get('X-Export-Bytes'));
      if (response.headers.get('Content-Type') !== XLSX_TYPE || !Number.isSafeInteger(length) || length < 1 || length > LEDGER_EXPORT.bytes || !response.body) throw new Error('导出文件的格式或大小无效');
      const reader = response.body.getReader(), chunks = []; let received = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); checkSession(); signal?.throwIfAborted(); if (done) break;
          received += value.length;
          if (received > length) throw new Error('导出文件超出声明大小');
          chunks.push(value);
        }
        if (received !== length) throw new Error('导出文件接收不完整，请重新下载');
        return new Blob(chunks, { type: XLSX_TYPE });
      } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
    } })
  };
}
