import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { parseUploadedFile } from '../admin/src/utils/importer.js';
import { parseImportBuffer } from '../admin/src/utils/import-parser.js';
import { sanitizeCellValue } from '../admin/src/utils/exporter.js';
import { readProfileBatch } from '../src/relational-profile-batches.js';

function importFile(rows, name = 'members.xlsx') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '会员');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true, bookSST: true });
  return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

test('shared-string references are budgeted before an expanded Worker response is returned', async () => {
  const oversizedCell = importFile([['姓名', '手机号'], ...Array.from({ length: 40 }, () => Array(20).fill('X'.repeat(32767)))]);
  assert.ok(oversizedCell.size < 20000);
  const buffer = await oversizedCell.arrayBuffer();
  assert.throws(() => parseImportBuffer(buffer, false), /单元格文本过长/);
  const aggregate = importFile([['姓名', '手机号'], ...Array.from({ length: 100 }, () => Array(20).fill('文'.repeat(4096)))]);
  assert.ok(aggregate.size < 40000);
  await assert.rejects(parseUploadedFile(aggregate), /展开数据过大/);
  const accepted = await parseUploadedFile(importFile([['姓名', '手机号', '备注'], ['客户', '13800001111', '文'.repeat(4096)]]));
  assert.equal(accepted[1][2].length, 4096);
});

test('invalid Worker responses reject cleanly and terminate parsing', async t => {
  const original = globalThis.Worker, workers = [];
  t.after(() => { globalThis.Worker = original; });
  for (const rows of [null, {}, [null], [[{}]], [['X'.repeat(4097)]], Array.from({ length: 2000 }, () => ['X'.repeat(4096)])]) {
    globalThis.Worker = class {
      constructor() { workers.push(this); }
      postMessage() { queueMicrotask(() => this.onmessage({ data: { rows } })); }
      terminate() { this.terminated = true; }
    };
    await assert.rejects(parseUploadedFile(importFile([['姓名', '手机号'], ['客户', '13800001111']])));
    assert.equal(workers.at(-1).terminated, true);
  }
});

test('small Excel files with enormous declared dimensions are rejected before row expansion', async () => {
  for (const ref of ['A1:XFD1048576', 'A1:B10006', 'A1:DY2', 'A1:DX10000']) {
    const bytes = rangedWorkbook(ref);
    assert.ok(bytes.length < 10000);
    await assert.rejects(parseUploadedFile({ name: 'range.xlsx', size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }), /范围|10,000/);
  }
});

test('CSV conversion limits columns and rejects truncated oversized row sets', async () => {
  for (const content of [Array.from({ length: 129 }, () => 'x').join(',') + '\na,b', '姓名,手机号\n' + '客户,13800001111\n'.repeat(10006)]) {
    const bytes = new TextEncoder().encode(content);
    await assert.rejects(parseUploadedFile({ name: 'range.csv', size: bytes.length, arrayBuffer: async () => bytes.buffer }), /范围|10,000/);
  }
});

test('Excel ZIP expansion and actual upload bytes are bounded before parsing', async () => {
  const bytes = rangedWorkbook('A1:B2');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 46 < bytes.length; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) { view.setUint32(offset + 24, 65 * 1024 * 1024, true); break; }
  }
  await assert.rejects(parseUploadedFile({ name: 'zip.xlsx', size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }), /解压数据过大/);
  const large = new ArrayBuffer(10 * 1024 * 1024 + 1);
  await assert.rejects(parseUploadedFile({ name: 'large.csv', size: 1, arrayBuffer: async () => large }), /文件过大/);
});

test('worker parsing can be aborted or timed out and always terminates the worker', async t => {
  const workers = [], original = globalThis.Worker;
  globalThis.Worker = class { constructor() { workers.push(this); this.terminated = false; } postMessage() {} terminate() { this.terminated = true; } };
  t.after(() => { globalThis.Worker = original; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bytes = new TextEncoder().encode('姓名,手机号\n客户,13800001111');
  const file = { name: 'members.csv', size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(0) };
  const controller = new AbortController(), aborted = parseUploadedFile(file, { signal: controller.signal });
  const checkedAbort = assert.rejects(aborted, { name: 'AbortError' });
  await Promise.resolve(); await Promise.resolve(); controller.abort(); await checkedAbort;
  assert.equal(workers[0].terminated, true);
  const timed = parseUploadedFile(file), checkedTimeout = assert.rejects(timed, /超时/);
  await Promise.resolve(); await Promise.resolve(); t.mock.timers.tick(10000); await checkedTimeout;
  assert.equal(workers[1].terminated, true);
});

test('sanitizeCellValue prevents formula injection by escaping dangerous leading characters', () => {
  assert.equal(sanitizeCellValue('=1+1'), "'=1+1");
  assert.equal(sanitizeCellValue('+cmd|/C calc'), "'+cmd|/C calc");
  assert.equal(sanitizeCellValue('-5+2'), "'-5+2");
  assert.equal(sanitizeCellValue('@SUM(A1:B2)'), "'@SUM(A1:B2)");
  assert.equal(sanitizeCellValue('\tmalicious'), "'\tmalicious");
  assert.equal(sanitizeCellValue('张三丰'), '张三丰');
  assert.equal(sanitizeCellValue('13800001111'), '13800001111');
});


function rangedWorkbook(ref) {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['姓名', '手机号'], ['客户', '13800001111']]), '会员');
  const archive = XLSX.CFB.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const entry = archive.FileIndex[archive.FullPaths.findIndex(path => path.endsWith('/xl/worksheets/sheet1.xml'))];
  entry.content = Buffer.from(Buffer.from(entry.content).toString('utf8').replace('ref="A1:B2"', 'ref="' + ref + '"')); entry.size = entry.content.length;
  return XLSX.CFB.write(archive, { type: 'buffer', fileType: 'zip', compression: true });
}

test('v2 spreadsheet keeps leading zeros, physical row numbers and the funding boundary', async () => {
  const { rows } = await readProfileBatch(importFile([['门店资料'], [], ['姓名', '手机号'], ['同名客户', '00123'], ['同名客户', '']]));
  assert.deepEqual(rows.map(row => [row.data.name, row.data.phone]), [['同名客户', '00123'], ['同名客户', '']]);
  await assert.rejects(readProfileBatch(importFile([['标题'], ['姓名', '会员编号', '档案版本'], [], ['错行', 'member-1', '-1']])), /第 4 行/);
  await assert.rejects(readProfileBatch(importFile([['姓名', '余额'], ['不应写资金', '100.00']])), /资金不在资料批次/);
});
