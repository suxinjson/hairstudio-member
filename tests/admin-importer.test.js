import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeCellValue,
  guessColumnMapping,
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
