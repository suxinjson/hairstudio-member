import { ApiError } from './security.js';
import { DATA_LIMITS } from '../src/data-limits.js';
import { relationalArchiveRoute } from './relational-archive-http.js';
import { COMMAND_ID } from '../src/relational-contract.js';
import { XLSX_TYPE } from '../src/relational-export-sheet.js';

// Transport only: authorization, version checks and all financial writes live
// inside the relational application service's database transaction.
export async function relationalRoute({ ledger, identity, request, response, url, readBody, guard }) {
  if (!ledger) throw new ApiError(503, '关系化账务服务未配置');
  const path = url.pathname, route = request.method + ' ' + path;
  const query = Object.fromEntries(url.searchParams);
  let match;
  if (route === 'GET /api/v2/backup/archive' || route === 'GET /api/v2/sync/snapshot' || /^POST \/api\/v2\/backup\/archive\/restore(?:\/preview)?$/.test(route)) return relationalArchiveRoute({ ledger, identity, request, response, url, guard });
  if (route === 'GET /api/v2/book') return { status: 200, value: await ledger.getBook(identity) };
  if (route === 'GET /api/v2/book/watermark') return { status: 200, value: await ledger.getExportWatermark(identity, query) };
  if (route === 'GET /api/v2/backup') {
    guard.take('v2-backup:' + identity.id, 3);
    return { status: 200, value: await ledger.exportBackup(identity) };
  }
  if (route === 'POST /api/v2/backup/restore/preview' || route === 'POST /api/v2/backup/restore') {
    guard.take('v2-restore:' + identity.id, 3);
    const input = await readBody(request, DATA_LIMITS.restoreBytes);
    return { status: 200, value: await ledger[path.endsWith('/preview') ? 'previewBackupRestore' : 'restoreBackup'](identity, input) };
  }
  if (request.method === 'GET' && (match = /^\/api\/v2\/backup\/restores\/([a-zA-Z0-9-]{16,80})$/.exec(path))) return { status: 200, value: await ledger.getRestore(identity, match[1], query) };
  if (route === 'GET /api/v2/configuration') return { status: 200, value: await ledger.getConfiguration(identity, query) };
  if (route === 'POST /api/v2/batches') return { status: 200, value: await ledger.captureBatch(identity, await readBody(request, DATA_LIMITS.operationBytes)) };
  if (route === 'GET /api/v2/batches') return { status: 200, value: await ledger.listBatches(identity, { ...query, ...(query.limit === undefined ? {} : { limit: Number(query.limit) }) }) };
  if (request.method === 'GET' && (match = /^\/api\/v2\/batches\/([a-zA-Z0-9-]{16,80})$/.exec(path))) {
    const { after, limit, ...scope } = query;
    return { status: 200, value: await ledger.getBatch(identity, { ...scope, id: match[1] }, { ...(after === undefined ? {} : { after: Number(after) }), ...(limit === undefined ? {} : { limit: Number(limit) }) }) };
  }
  if (request.method === 'POST' && (match = /^\/api\/v2\/batches\/([a-zA-Z0-9-]{16,80})\/control$/.exec(path))) {
    const body = await readBody(request, DATA_LIMITS.operationBytes);
    if (body.id !== match[1]) throw new ApiError(400, '路径与批次号不一致');
    return { status: 200, value: await ledger.controlBatch(identity, body) };
  }
  if (request.method === 'POST' && (match = /^\/api\/v2\/batches\/([a-zA-Z0-9-]{16,80})\/items\/([a-zA-Z0-9-]{16,80})$/.exec(path))) {
    const body = await readBody(request, DATA_LIMITS.operationBytes);
    if (body.id !== match[1]) throw new ApiError(400, '路径与批次号不一致');
    return { status: 200, value: await ledger.executeBatchItem(identity, body, match[2]) };
  }
  if (request.method === 'POST' && (match = /^\/api\/v2\/batches\/([a-zA-Z0-9-]{16,80})\/steps$/.exec(path))) {
    const { taskIds, ...scope } = await readBody(request, 8 * 1024);
    if (scope.id !== match[1] || !Array.isArray(taskIds) || taskIds.length < 1 || taskIds.length > 25 ||
        new Set(taskIds).size !== taskIds.length || !taskIds.every(id => typeof id === 'string' && COMMAND_ID.test(id))) {
      throw new ApiError(400, '批次步骤须提供 1–25 个不同的原行号');
    }
    for (const taskId of taskIds) {
      if (response.destroyed || request.aborted) throw new ApiError(408, '批次连接中断，已提交行仍保留', 'BATCH_ABORTED');
      await ledger.executeBatchItem(identity, scope, taskId);
    }
    return { status: 200, value: { confirmed: taskIds.length } };
  }
  if (request.method === 'GET' && (match = /^\/api\/v2\/batches\/([a-zA-Z0-9-]{16,80})\/items\/([a-zA-Z0-9-]{16,80})$/.exec(path))) return { status: 200, value: await ledger.getBatchItem(identity, { ...query, id: match[1] }, match[2]) };
  if (route === 'POST /api/v2/tasks') {
    const input = await readBody(request, DATA_LIMITS.operationBytes);
    const result = await ledger.executeTask(identity, input);
    return { status: 200, value: { taskId: input.id, ledgerEpoch: input.ledgerEpoch, type: input.type, result } };
  }
  if (request.method === 'GET' && (match = /^\/api\/v2\/tasks\/([a-zA-Z0-9-]{16,80})$/.exec(path))) return { status: 200, value: await ledger.getTask(identity, match[1], query) };
  if (route === 'GET /api/v2/members') return { status: 200, value: await ledger.listMembers(identity, query) };
  if (route === 'POST /api/v2/members/check-names') return { status: 200, value: await ledger.findActiveNames(identity, await readBody(request, DATA_LIMITS.operationBytes)) };
  if (request.method === 'GET' && (match = /^\/api\/v2\/members\/([a-zA-Z0-9_-]{1,128})\/totals$/.exec(path))) return { status: 200, value: await ledger.getMemberTotals(identity, match[1], query) };
  if ((match = /^\/api\/v2\/members\/([a-zA-Z0-9_-]{1,128})$/.exec(path))) {
    if (request.method === 'GET') return { status: 200, value: await ledger.getMember(identity, match[1], query) };
  }
  if (route === 'GET /api/v2/ledger') return { status: 200, value: await ledger.listLedger(identity, query) };
  if (route === 'POST /api/v2/exports/ledger') {
    guard.take('ledger-export:' + identity.id, 4);
    return { status: 202, value: await ledger.queueLedgerExport(identity, await readBody(request, 1024)) };
  }
  if (route === 'GET /api/v2/exports/ledger') return { status: 200, value: await ledger.getLedgerExport(identity, query) };
  if ((match = /^\/api\/v2\/exports\/ledger\/([0-9a-f-]{36})\/(file|discard)$/.exec(path))) {
    if (request.method === 'POST' && match[2] === 'discard') return { status: 200, value: await ledger.discardLedgerExport(identity, match[1], await readBody(request, 1024)) };
    if (request.method === 'GET' && match[2] === 'file') {
      const file = await ledger.downloadLedgerExport(identity, match[1], query);
      if (!response.destroyed) {
        response.writeHead(200, { 'Content-Type': XLSX_TYPE, 'Content-Length': file.length, 'X-Export-Bytes': file.length, 'Cache-Control': 'private, no-store, no-transform',
          'Content-Disposition': 'attachment; filename="ledger-' + match[1] + '.xlsx"' });
        response.end(file);
      }
      return { streamed: true };
    }
  }
  if (route === 'POST /api/v2/commands') return { status: 200, value: await ledger.executeCommand(identity, await readBody(request, DATA_LIMITS.operationBytes)) };
  if (request.method === 'GET' && (match = /^\/api\/v2\/commands\/([a-zA-Z0-9-]{16,80})$/.exec(path))) return { status: 200, value: await ledger.getCommand(identity, match[1], query) };
  if (route === 'POST /api/v2/import/openings/preview' || route === 'POST /api/v2/import/openings') {
    guard.take('v2-import:' + identity.id, 3);
    const input = await readBody(request, DATA_LIMITS.restoreBytes);
    const method = path.endsWith('/preview') ? 'previewOpeningImport' : 'importOpeningBalances';
    return { status: 200, value: await ledger[method](identity, input) };
  }
  if (route === 'GET /api/v2/sync/changes') return { status: 200, value: await ledger.changes(identity, query) };
  if (route === 'GET /api/v2/reports/summary') return { status: 200, value: await ledger.report(identity, query) };
  if (route === 'GET /api/v2/reports/breakdown') return { status: 200, value: await ledger.reportBreakdown(identity, query) };
  if (route === 'GET /api/v2/reports/business') return { status: 200, value: await ledger.reportBusiness(identity, query) };
  throw new ApiError(404, '关系化接口不存在');
}
