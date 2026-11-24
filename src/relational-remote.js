import { ledgerEpochOf } from './ledger-epoch.js';
import { ENTITY_ID } from './relational-contract.js';

const pathId = value => encodeURIComponent(value);
function withQuery(path, input = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  return query.size ? path + '?' + query : path;
}

// Transport shares the caller's existing auth/vault. Nothing here can infer
// a new epoch, actor or request ID for a previously captured write.
export function createRelationalRemote({ request }) {
  if (typeof request !== 'function') throw new Error('账本连接未配置');
  const call = (route, options) => request('/api/v2' + route, options);
  const get = (route, query, options) => call(withQuery(route, query), options);
  const post = (route, body, options) => call(route, { ...options, method: 'POST', body: JSON.stringify(body) });
  async function page(route, query = {}) {
    const value = await get(route, query);
    if (!value || !Array.isArray(value.items) || value.items.length > Number(query.limit ?? 50) ||
      (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || value.nextCursor.length > 2048 || !value.nextCursor))) throw new Error('服务器返回无效账本页面');
    return value;
  }
  return {
    async getBook() {
      const book = await get('/book');
      if (typeof book?.storeId !== 'string' || !ENTITY_ID.test(book.storeId)) throw new Error('服务器返回无效账本归属');
      return { storeId: book.storeId, ledgerEpoch: ledgerEpochOf(book.ledgerEpoch) };
    },
    getExportWatermark: (query, options) => get('/book/watermark', query, options),
    listMembers: query => page('/members', query),
    findActiveNames: input => post('/members/check-names', input),
    getMember: (id, query) => get('/members/' + pathId(id), query),
    listLedger: query => page('/ledger', query),
    getConfiguration: query => get('/configuration', query),
    report: query => get('/reports/summary', query),
    reportBusiness: query => get('/reports/business', query),
    reportBreakdown: query => page('/reports/breakdown', query),
    changes: query => get('/sync/changes', query),
    executeCommand: input => post('/commands', input),
    getCommand: (id, query) => get('/commands/' + pathId(id), query),
    executeTask: input => post('/tasks', input),
    getTask: (id, query) => get('/tasks/' + pathId(id), query),
    previewOpeningImport: input => post('/import/openings/preview', input),
    importOpeningBalances: input => post('/import/openings', input),
    captureBatch: input => post('/batches', input),
    listBatches: query => get('/batches', query),
    getBatch: ({ id, ...scope }, query) => get('/batches/' + pathId(id), { ...scope, ...query }),
    controlBatch: input => post('/batches/' + pathId(input.id) + '/control', input),
    getBatchItem: ({ id, ...scope }, taskId) => get('/batches/' + pathId(id) + '/items/' + pathId(taskId), scope),
    executeBatchItems: (scope, { taskIds, signal }) => post('/batches/' + pathId(scope.id) + '/steps', { ...scope, taskIds }, { signal }),
    executeBatchItem: (input, taskId) => post('/batches/' + pathId(input.id) + '/items/' + pathId(taskId), input)
  };
}
