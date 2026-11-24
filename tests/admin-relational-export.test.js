import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { collectMemberExport, relationalExportBook } from '../admin/src/utils/relational-export.js';
import { createLedgerExportClient } from '../admin/src/utils/ledger-export-jobs.js';
import { XLSX_TYPE } from '../src/relational-export-sheet.js';

const scope = { storeId: 'table-fixture', ledgerEpoch: '00000000-0000-4000-8000-000000000001', actorId: 'owner', deviceId: 'fixture-device' };
const member = { id: 'm1', name: '=1+1', phone: '0123', notes: '@公式示例', balanceCents: '-9223372036854775808', version: '0', accountVersion: '0' };
const head = cursor => ({ ...scope, cursor });

test('member spreadsheet keeps archived rows, the phone and exact signed money as text without formula cells', async () => {
  const workspace = { getScope: () => scope, async read(method, { balance, cursor } = {}) {
    if (method === 'getExportWatermark') return head('10');
    if (balance === 'archived') return { items: [{ ...member, id: 'm3', archivedAt: '2026-11-20T00:00:00Z' }], nextCursor: null };
    return cursor ? { items: [{ ...member, id: 'm2' }], nextCursor: null } : { items: [member], nextCursor: 'original-page' };
  } };
  const data = await collectMemberExport(workspace);
  const sheet = XLSX.read(XLSX.write(relationalExportBook(XLSX, data), { type: 'buffer', bookType: 'xlsx' })).Sheets[data.name];
  assert.deepEqual([sheet.B2.t, sheet.B2.v, sheet.B2.f, sheet.C2.v, sheet.E2.f, sheet.F2.v, sheet.J4.v],
    ['s', '=1+1', undefined, '0123', undefined, '-92233720368547758.08', '2026-11-20T00:00:00Z']);
});

test('exports reject a moving book head, repeated pages and cancellation without returning a partial workbook', async () => {
  let cursor = 0;
  const workspace = { getScope: () => scope, read: async method => method === 'getExportWatermark' ? head(String(++cursor)) : { items: [], nextCursor: null } };
  await assert.rejects(collectMemberExport(workspace), /有变动/);
  workspace.read = async method => method === 'getExportWatermark' ? head('0') : { items: [member], nextCursor: 'repeat' };
  await assert.rejects(collectMemberExport(workspace), /资料改变/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collectMemberExport(workspace, { signal: controller.signal }), /已取消/);
});

test('background file download rejects truncation and changes in identity while receiving bytes', async () => {
  let active = scope, content = Uint8Array.of(123), switchAccount = false;
  const id = '00000000-0000-4000-8000-000000000002';
  const api = { restoreSession() {}, requestStream: async (path, consume) => {
    assert.equal(path, '/api/v2/exports/ledger/' + id + '/file?ledgerEpoch=' + scope.ledgerEpoch);
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(content); controller.close();
      if (switchAccount) active = { ...scope, actorId: 'other' };
    } });
    return consume(new Response(body, { headers: { 'Content-Type': XLSX_TYPE, 'X-Export-Bytes': '2' } }), () => {});
  } };
  const client = createLedgerExportClient({ workspace: { getScope: () => active }, api });
  await assert.rejects(client.download(scope, id), /接收不完整/);
  content = Uint8Array.of(123, 45);
  assert.deepEqual(new Uint8Array(await (await client.download(scope, id)).arrayBuffer()), content);
  switchAccount = true;
  await assert.rejects(client.download(scope, id), { code: 'AUTH_CONTEXT_CHANGED' });
});
