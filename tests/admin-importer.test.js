import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  sanitizeCellValue,
  guessColumnMapping,
  parseImportMoney,
  parseUploadedFile,
  createErrorReportWorkbook,
  validateImportBatch
} from '../admin/src/utils/importer.js';
import { maskPhone, formatYuan } from '../admin/src/utils/security.js';
import { createMembersWorkbook, createLedgersWorkbook } from '../admin/src/utils/exporter.js';

test('ambiguous legacy phone identities are rejected rather than choosing a financial target', () => {
  const members = [{ id: 'a', name: 'A', phone: '13800001111', balance: 10000 }, { id: 'b', name: 'B', phone: '138 0000-1111', balance: 20000 }];
  const mapping = { name: 0, phone: 1, balance: 2, gift: 3, remark: null, tag: null };
  for (const conflictStrategy of ['skip', 'merge_balance', 'overwrite_profile']) {
    const report = validateImportBatch([['B', '(138)00001111', '50', '0']], mapping, members, { conflictStrategy });
    assert.equal(report.invalidCount, 1); assert.match(report.results[0].reason, /多个档案/);
    assert.equal(report.results[0].existingMember, undefined);
  }
});

test('financial Excel cells remain numeric and summable after serialization while text stays protected', () => {
  const members = [{ name: '=1+1', phone: '13800001111', balance: 12345 }, { name: '欠款', phone: '13900002222', balance: -2000 }];
  const book = createMembersWorkbook(members);
  const roundtrip = XLSX.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellNF: true });
  const sheet = roundtrip.Sheets[roundtrip.SheetNames[0]];
  assert.equal(sheet.C2.t, 'n'); assert.equal(sheet.D3.t, 'n'); assert.equal(sheet.C2.z, '0.00');
  assert.equal(sheet.C2.v + sheet.C3.v, 103.45); assert.equal(sheet.D3.v, 20);
  assert.equal(sheet.A2.t, 's'); assert.equal(sheet.A2.f, undefined); assert.equal(sheet.B2.t, 's');
  const ledgers = createLedgersWorkbook([{ id: '@cmd', type: 'RECHARGE', changeAmount: 12345, balanceAfter: 12345 }, { id: '2', type: 'CONSUME', changeAmount: -2345, balanceAfter: 10000 }]);
  const result = XLSX.read(XLSX.write(ledgers, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellNF: true });
  const ledgerSheet = result.Sheets[result.SheetNames[0]];
  assert.equal(ledgerSheet.F2.t, 'n'); assert.equal(ledgerSheet.G3.t, 'n'); assert.equal(ledgerSheet.F2.z, '0.00');
  assert.equal(ledgerSheet.F2.v + ledgerSheet.F3.v, 100); assert.equal(ledgerSheet.A2.f, undefined);
});

function rangedWorkbook(ref) {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['姓名', '手机号'], ['客户', '13800001111']]), '会员');
  const archive = XLSX.CFB.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const entry = archive.FileIndex[archive.FullPaths.findIndex(path => path.endsWith('/xl/worksheets/sheet1.xml'))];
  entry.content = Buffer.from(Buffer.from(entry.content).toString('utf8').replace('ref="A1:B2"', 'ref="' + ref + '"')); entry.size = entry.content.length;
  return XLSX.CFB.write(archive, { type: 'buffer', fileType: 'zip', compression: true });
}

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

test('guessColumnMapping correctly matches diverse salon management headers', () => {
  const headers = ['顾客姓名', '手机号码', '当前储值余额', '活动赠金', '发型喜好备注', '会员分组'];
  const mapping = guessColumnMapping(headers);

  assert.equal(mapping.name, 0);
  assert.equal(mapping.phone, 1);
  assert.equal(mapping.balance, 2);
  assert.equal(mapping.gift, 3);
  assert.equal(mapping.remark, 4);
  assert.equal(mapping.tag, 5);
});

test('validateImportBatch identifies valid, invalid and duplicate records', () => {
  const mapping = { name: 0, phone: 1, balance: 2, gift: 3, remark: 4, tag: 5 };
  const existingMembers = [
    { id: 'M1', name: '老会员', phone: '13800001111', balance: 50000 }
  ];

  const dataRows = [
    ['全新会员A', '13912345678', '100.50', '20.00', '常客', 'VIP'],
    ['老会员', '13800001111', '200.00', '0.00', '期初导入', ''], // 与现有系统冲突
    ['手机号错误', '1391234', '50.00', '0.00', '', ''], // 7位手机号
    ['姓名为空', '13788889999', '50.00', '0.00', '', ''],
    ['全新会员B', '13912345678', '80.00', '0.00', '', ''] // 与第1行手机号重复
  ];
  dataRows[3][0] = ''; // 姓名为空

  // 1. 采用 skip 策略测试
  const reportSkip = validateImportBatch(dataRows, mapping, existingMembers, { conflictStrategy: 'skip' });
  assert.equal(reportSkip.total, 5);
  assert.equal(reportSkip.validCount, 1); // 全新会员A
  assert.equal(reportSkip.conflictCount, 1); // 13800001111
  assert.equal(reportSkip.invalidCount, 3); // 手机号短、姓名空、文件内手机号重复

  // 校验金额转换
  const validItem = reportSkip.results.find(r => r.status === 'valid_new');
  assert.equal(validItem.data.balanceCents, 10050);
  assert.equal(validItem.data.giftCents, 2000);

  // 2. 采用 merge_balance 策略测试
  const reportMerge = validateImportBatch(dataRows, mapping, existingMembers, { conflictStrategy: 'merge_balance' });
  const conflictItem = reportMerge.results.find(r => r.status === 'conflict');
  assert.ok(conflictItem.reason.includes('累加余额'));
});

test('maskPhone masks middle 4 digits by default and reveals on demand', () => {
  assert.equal(maskPhone('13812345678', false), '138 **** 5678');
  assert.equal(maskPhone('13812345678', true), '138 1234 5678');
  assert.equal(maskPhone(''), '—');
});

test('formatYuan accurately formats integer cents to 2-decimal string', () => {
  assert.equal(formatYuan(10050), '100.50');
  assert.equal(formatYuan(0), '0.00');
  assert.equal(formatYuan(-3500), '-35.00');
});

test('column ownership is independent of order and ambiguous money columns stay unselected', () => {
  assert.deepEqual(guessColumnMapping(['赠金余额', '本金余额', '会员标签', '手机号码', '会员姓名']),
    { name: 4, phone: 3, balance: 1, gift: 0, remark: null, tag: 2 });
  assert.equal(guessColumnMapping(['本金余额', '可用余额', '手机号', '姓名']).balance, null);
});

test('money parsing preserves cents and rejects rounding, exponent notation, malformed grouping and overflow', () => {
  assert.equal(parseImportMoney('￥1,234.56元'), 123456);
  assert.equal(parseImportMoney('-100.01', { signed: true }), -10001);
  assert.equal(parseImportMoney('90071992547409.91'), Number.MAX_SAFE_INTEGER);
  for (const text of ['1.005', '1e3', '1,2', '90071992547409.92', 'Infinity', '0x10']) assert.throws(() => parseImportMoney(text));
  assert.throws(() => parseImportMoney('-1'));
});

test('import precheck matches only active phone holders and counts explicit debt entries', () => {
  const mapping = { name: 0, phone: 1, balance: 2, gift: 3, remark: null, tag: null };
  const active = { id: 'active', name: '在用', phone: '13800001111', balance: 0 };
  const archived = { ...active, id: 'archived', isArchived: true };
  const rows = [['欠款', active.phone, '-100.01', '0']];
  const report = validateImportBatch(rows, mapping, [active, archived], { conflictStrategy: 'merge_balance' });
  assert.equal(report.results[0].existingMember.id, active.id);
  assert.equal(report.debtCount, 1);
  assert.equal(validateImportBatch(rows, mapping, [archived]).results[0].status, 'valid_new');
  assert.equal(validateImportBatch([['精度错误', active.phone, '1.005', '0']], mapping).invalidCount, 1);
  assert.throws(() => validateImportBatch(rows, { ...mapping, gift: 2 }));
});

test('uploaded CSV notation and underlying Excel precision reach precheck without coercion or display rounding', async () => {
  const csv = new TextEncoder().encode('姓名,手机号,本金余额\n指数金额,13800001111,1e3\n十六进制,13800001112,0x10\n正常金额,13800001113,12.34');
  const csvResult = await parseUploadedFile({ name: 'members.csv', size: csv.byteLength, arrayBuffer: async () => csv.buffer });
  const csvReport = validateImportBatch(csvResult.dataRows, csvResult.mapping);
  assert.equal(csvReport.invalidCount, 2); assert.equal(csvReport.validCount, 1);
  assert.equal(csvReport.results[2].data.balanceCents, 1234);

  const sheet = XLSX.utils.aoa_to_sheet([['姓名', '手机号', '本金余额'], ['隐藏小数', '13800001111', 1.005], ['正常金额', '13800001112', 12.34]]);
  sheet.C2.z = '0.00';
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '会员');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const excelResult = await parseUploadedFile({ name: 'members.xlsx', size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  const excelReport = validateImportBatch(excelResult.dataRows, excelResult.mapping);
  assert.equal(excelReport.invalidCount, 1); assert.equal(excelReport.validCount, 1);
  assert.equal(excelReport.results[1].data.balanceCents, 1234);
});

test('correction workbooks preserve original invalid amounts through export and reimport', async () => {
  const mapping = { name: 0, phone: 1, balance: 2, gift: 3, remark: null, tag: null };
  const rows = [
    ['小数错误', '13800001111', '123.456', '0.789'],
    ['指数错误', '13800001112', '1e3', '-5'],
    ['超出范围', '13800001113', '90071992547409.92', '=1+1'],
    ['', '13800001114', '￥1,234.56元', '12.34']
  ];
  const report = validateImportBatch(rows, mapping);
  assert.equal(report.invalidCount, 4);
  const book = createErrorReportWorkbook(report.results);
  const sheet = book.Sheets[book.SheetNames[0]];
  rows.forEach((row, i) => {
    assert.equal(sheet['E' + (i + 2)].v, row[2]);
    assert.equal(sheet['F' + (i + 2)].v, row[3]);
    assert.equal(sheet['F' + (i + 2)].t, 's');
    assert.equal(sheet['F' + (i + 2)].f, undefined);
  });
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const uploaded = await parseUploadedFile({ name: 'correction.xlsx', size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  assert.equal(validateImportBatch(uploaded.dataRows, uploaded.mapping).invalidCount, 4);
  uploaded.dataRows[3][uploaded.mapping.name] = '已修正姓名';
  const corrected = validateImportBatch(uploaded.dataRows, uploaded.mapping);
  assert.equal(corrected.validCount, 1);
  assert.equal(corrected.results[3].data.balanceCents, 123456);
  assert.equal(corrected.results[3].data.giftCents, 1234);
});
