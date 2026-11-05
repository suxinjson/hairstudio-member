import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  sanitizeCellValue,
  guessColumnMapping,
  parseImportMoney,
  parseUploadedFile,
  validateImportBatch
} from '../admin/src/utils/importer.js';
import { maskPhone, formatYuan } from '../admin/src/utils/security.js';

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
