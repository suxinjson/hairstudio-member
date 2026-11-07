import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'csv-parse/sync';
import { localDb } from '../src/storage.js';
import { validateAccountHistory } from '../src/accounting.js';
import { moneyToCent, isValidMoney } from '../src/money.js';
import { useMemberCrud } from '../src/composables/useMemberCrud.js';

const membersKey = 'hairstudio_members_v2';
const ledgersKey = 'hairstudio_ledgers_v2';
const snapshotsKey = 'hairstudio_local_snapshots_v1';
const safetyKey = 'hairstudio_pre_restore_safety_snapshot';

class MemoryStorage {
  values = new Map();
  failKey = null;
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) {
    if (key === this.failKey) throw new Error('quota exceeded');
    this.values.set(key, String(value));
  }
  removeItem(key) { this.values.delete(key); }
}

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage();
  localDb.init();
});

const newMember = (initialBalance = 100) => localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance });
const backup = () => localDb.exportBackupData({ archiveSnapshot: false });

test('member edits reject a newer profile without losing the form and reopen against the latest data', () => {
  const member = newMember(), feedback = [];
  const edit = useMemberCrud({ localDb, refreshAll() {}, selectMember() {}, showToast() {},
    showFeedback: message => feedback.push(message), askConfirm: async () => true, selectedMember: { value: null } });
  edit.openEditMemberModal(member);
  edit.memberForm.value.name = '新姓名';
  localDb.updateMember(member.id, { notes: '其他设备新备注' });
  edit.submitMemberForm();
  assert.match(feedback[0], /重新打开/);
  assert.equal(edit.showMemberModal.value, true);
  assert.equal(edit.memberForm.value.name, '新姓名');
  assert.equal(localDb.getMemberById(member.id).name, member.name);
  assert.equal(localDb.getMemberById(member.id).notes, '其他设备新备注');
  edit.openEditMemberModal(localDb.getMemberById(member.id));
  edit.memberForm.value.name = '新姓名'; edit.submitMemberForm();
  assert.equal(edit.showMemberModal.value, false);
  assert.equal(localDb.getMemberById(member.id).name, '新姓名');
  assert.equal(localDb.getMemberById(member.id).notes, '其他设备新备注');
});

test('legacy phone conflicts remain readable and repairable by ID while all financial writes stay blocked', () => {
  const members = Array.from({ length: 5 }, (_, i) => localDb.createMember({
    name: '旧客户' + i, phone: String(13800000000 + i), initialBalance: i === 4 ? 0 : 100
  }));
  const legacy = localDb.readBackupState();
  legacy.members.find(m => m.id === members[1].id).phone = '138 0000 0000';
  legacy.members.find(m => m.id === members[3].id).phone = '(138) 0000-0002';
  localStorage.setItem(membersKey, JSON.stringify(legacy.members));
  const history = structuredClone(legacy.ledgers);
  assert.doesNotThrow(() => localDb.init());
  assert.equal(localDb.getMembers().length, 5);
  assert.deepEqual(localDb.readBackupState(), legacy);
  assert.throws(() => localDb.parseAndValidateBackup(JSON.stringify({ data: legacy })), /重复/);
  assert.throws(() => localDb.applyCloudSnapshot(legacy, 'metadata', {}), /重复/);
  assert.doesNotThrow(() => localDb.applyCloudSnapshot(legacy, 'metadata', {}, { allowPhoneConflicts: true }));
  const before = new Map(localStorage.values);
  for (const write of [
    () => localDb.createMember({ name: '新客户', phone: '13900000000' }),
    () => localDb.recharge({ memberId: members[0].id, actualPay: 10 }),
    () => localDb.consume({ memberId: members[0].id, amount: 10 }),
    () => localDb.refundLedger(history[0].id),
    () => localDb.deleteMember(members[4].id),
    () => localDb.updateMember(members[1].id, { phone: '---' }),
    () => localDb.updateMember(members[1].id, { phone: '138-0000-0002' })
  ]) {
    assert.throws(write, /会员单号|不能为空|占用/);
    assert.deepEqual(localStorage.values, before);
  }
  localDb.updateMember(members[1].id, { phone: '13900000001' });
  assert.throws(() => localDb.recharge({ memberId: members[0].id, actualPay: 10 }), /会员单号/);
  localDb.updateMember(members[3].id, { phone: '13900000003' });
  assert.deepEqual(localDb.readBackupState().ledgers, history);
  for (const m of localDb.readBackupState().members) {
    assert.equal(m.balance, m.id === members[4].id ? 0 : 10000);
    assert.equal(m.total_consume, 0);
  }
  localDb.recharge({ memberId: members[0].id, actualPay: 10 });
  assert.equal(localDb.getMemberById(members[0].id).balance, 11000);
});

test('all phone formats share one identity across creation, edits, backup validation and merging', () => {
  const member = localDb.createMember({ name: '张姐', phone: '(138) 0000-1111' });
  assert.equal(member.phone, '13800001111');
  assert.throws(() => localDb.createMember({ name: '重复', phone: '138 0000 1111' }), /已存在/);
  const other = localDb.createMember({ name: '另一客户', phone: '13900002222' });
  assert.throws(() => localDb.updateMember(other.id, { phone: '138-0000-1111' }), /占用/);
  const legacy = JSON.parse(backup());
  legacy.data.members.find(m => m.id === member.id).phone = '138 0000 1111';
  localDb.importBackupData(JSON.stringify(legacy));
  assert.throws(() => localDb.createMember({ name: '重复', phone: '13800001111' }), /已存在/);
  const incoming = JSON.parse(backup()); incoming.data.members = incoming.data.members.filter(m => m.id === member.id);
  incoming.data.members[0].id = 'older-backup-id'; incoming.data.members[0].phone = '13800001111';
  assert.equal(localDb.previewBackup(JSON.stringify(incoming)).diff.existingMembersCount, 1);
  assert.equal(localDb.importBackupData(JSON.stringify(incoming), { mode: 'merge' }).newMembersAdded, 0);
  const invalid = JSON.parse(backup()); invalid.data.members.find(m => m.id === other.id).phone = '138-0000-1111';
  const before = backup();
  assert.throws(() => localDb.importBackupData(JSON.stringify(invalid)), /重复/);
  assert.deepEqual(JSON.parse(backup()).data, JSON.parse(before).data);
});

test('restored padded phone numbers cannot be duplicated by creation or editing', () => {
  const member = newMember(), other = localDb.createMember({ name: '另一客户', phone: '13900002222' });
  const imported = JSON.parse(backup());
  imported.data.members.find(item => item.id === member.id).phone = ' 13800001111 ';
  localDb.importBackupData(JSON.stringify(imported));
  const before = new Map(localStorage.values);
  assert.throws(() => localDb.createMember({ name: '重复客户', phone: '13800001111' }), /已存在/);
  assert.deepEqual(localStorage.values, before);
  assert.throws(() => localDb.updateMember(other.id, { phone: '13800001111' }), /已被其他会员占用/);
  assert.deepEqual(localStorage.values, before);
  assert.doesNotThrow(() => localDb.init());
  localDb.updateMember(member.id, { phone: ' 13800001111 ' });
  assert.equal(localDb.getMemberById(member.id).phone, '13800001111');
});

test('history validation scans ledger membership a bounded number of times as customers grow', () => {
  let reads = 0;
  const members = Array.from({ length: 1000 }, (_, index) => ({ id: 'M' + index, name: '客户', balance: 0, total_recharge: 100, total_consume: 100 }));
  const ledgers = members.flatMap(member => [
    { id: member.id + '-C', type: 'CONSUME', changeAmount: -100, balanceBefore: 100, balanceAfter: 0 },
    { id: member.id + '-R', type: 'RECHARGE', changeAmount: 100, balanceBefore: 0, balanceAfter: 100 }
  ].map(record => ({ ...record, get memberId() { reads++; return member.id; } })));
  validateAccountHistory(members, ledgers);
  assert.ok(reads <= ledgers.length * 6, `Repeated full scans: ${reads}`);
  ledgers[0].balanceBefore = 99;
  assert.throws(() => validateAccountHistory(members, ledgers), /余额与流水不一致/);
});

for (const damaged of ['{broken', '', JSON.stringify({ version: 1, writes: [{ key: membersKey, previous: 123 }] })]) {
  test(`damaged transaction journals remain exportable and permit preserved full restoration (${JSON.stringify(damaged)})`, t => {
    t.mock.method(console, 'error', () => {});
    const member = newMember(), validBackup = backup();
    const journalKey = 'hairstudio_pending_write_v1';
    localStorage.setItem(journalKey, damaged);
    const before = new Map(localStorage.values);
    const raw = localDb.readRecoveryState();
    assert.equal(raw.pendingWrite, damaged);
    assert.equal(raw.storage[membersKey], before.get(membersKey));
    assert.equal(raw.data, null);
    assert.ok(raw.dataError);
    assert.deepEqual(localStorage.values, before);
    assert.throws(() => localDb.importBackupData(validBackup, { mode: 'merge' }));
    assert.deepEqual(localStorage.values, before);
    localDb.importBackupData(validBackup, { mode: 'replace' });
    assert.equal(localDb.getMemberById(member.id).balance, 10000);
    assert.equal(localStorage.getItem(journalKey), null);
    const preserved = JSON.parse(localStorage.getItem(safetyKey));
    assert.equal(preserved.pendingWrite, damaged);
    assert.equal(preserved.storage[membersKey], before.get(membersKey));
  });
}

test('a malformed journal is validated entirely before any rollback changes', t => {
  t.mock.method(console, 'error', () => {});
  newMember();
  const members = localStorage.getItem(membersKey);
  localStorage.setItem('hairstudio_pending_write_v1', JSON.stringify({ version: 1, writes: [
    { key: ledgersKey, previous: 123 }, { key: membersKey, previous: '[]' }
  ] }));
  assert.throws(() => localDb.init());
  assert.equal(localStorage.getItem(membersKey), members);
});

test('failed full recovery restores the damaged journal and original account, then permits retry', t => {
  t.mock.method(console, 'error', () => {});
  const member = newMember(), validBackup = backup();
  localDb.consume({ memberId: member.id, amount: 38 });
  const originalMembers = localStorage.getItem(membersKey), originalLedgers = localStorage.getItem(ledgersKey);
  const journalKey = 'hairstudio_pending_write_v1', damaged = '{broken';
  localStorage.setItem(journalKey, damaged);
  const before = new Map(localStorage.values);
  localStorage.failKey = safetyKey;
  assert.throws(() => localDb.importBackupData(validBackup));
  assert.deepEqual(localStorage.values, before);
  localStorage.failKey = ledgersKey;
  assert.throws(() => localDb.importBackupData(validBackup), /回滚|恢复/);
  assert.equal(localStorage.getItem(membersKey), originalMembers);
  assert.equal(localStorage.getItem(ledgersKey), originalLedgers);
  assert.equal(localStorage.getItem(journalKey), damaged);
  assert.equal(JSON.parse(localStorage.getItem(safetyKey)).pendingWrite, damaged);
  localStorage.failKey = null;
  localDb.importBackupData(validBackup);
  assert.equal(localDb.getMemberById(member.id).balance, 10000);
});

test('explicit adoption of a cloud ledger preserves damaged journals and remains atomic', t => {
  t.mock.method(console, 'error', () => {});
  const member = newMember(), data = JSON.parse(backup()).data;
  const journalKey = 'hairstudio_pending_write_v1', damaged = '{broken';
  localStorage.setItem(journalKey, damaged);
  assert.throws(() => localDb.applyCloudSnapshot(data, 'test-metadata', { revision: 1 }));
  localStorage.failKey = safetyKey;
  assert.throws(() => localDb.applyCloudSnapshot(data, 'test-metadata', { revision: 1 }, { allowRecovery: true }));
  assert.equal(localStorage.getItem(journalKey), damaged);
  localStorage.failKey = null;
  localDb.applyCloudSnapshot(data, 'test-metadata', { revision: 1 }, { allowRecovery: true });
  assert.equal(localDb.getMemberById(member.id).balance, 10000);
  assert.equal(JSON.parse(localStorage.getItem(safetyKey)).pendingWrite, damaged);
  assert.equal(JSON.parse(localStorage.getItem('test-metadata')).revision, 1);
});

test('startup rolls back an interrupted full recovery and keeps the prior damaged journal', t => {
  t.mock.method(console, 'error', () => {});
  const member = newMember(), originalMembers = localStorage.getItem(membersKey);
  const journalKey = 'hairstudio_pending_write_v1', damaged = '{broken';
  const changedMembers = JSON.stringify([{ ...localDb.getMemberById(member.id), name: 'partial replacement' }]);
  localStorage.setItem(journalKey, JSON.stringify({ version: 1, previousJournal: damaged, writes: [
    { key: membersKey, value: changedMembers, previous: originalMembers },
    { key: 'test-cloud-metadata', value: '{"revision":2}', previous: '{"revision":1}' }
  ] }));
  localStorage.setItem(membersKey, changedMembers);
  localStorage.setItem('test-cloud-metadata', '{"revision":2}');
  assert.throws(() => localDb.init(), /未完成的数据恢复/);
  assert.equal(localStorage.getItem(membersKey), originalMembers);
  assert.equal(localStorage.getItem('test-cloud-metadata'), '{"revision":1}');
  assert.equal(localStorage.getItem(journalKey), damaged);
  assert.equal(localDb.readRecoveryState().pendingWrite, damaged);
});

test('debt requires explicit acknowledgement and stays exact through more consumption and repayment', () => {
  const member = newMember('20.01');
  const before = new Map(localStorage.values);
  assert.throws(() => localDb.consume({ memberId: member.id, amount: '38.02' }), /确认欠款/);
  assert.throws(() => localDb.consume({ memberId: member.id, amount: '38.02', allowDebt: 'true' }), /布尔值/);
  assert.deepEqual(localStorage.values, before);
  const consumed = localDb.consume({ memberId: member.id, amount: '38.02', allowDebt: true });
  assert.equal(consumed.balanceAfter, -1801);
  assert.match(localDb.getLedgers()[0].remark, /新增¥18.01，累计¥18.01/);
  assert.throws(() => localDb.consume({ memberId: member.id, amount: '0.01' }), /确认欠款/);
  localDb.consume({ memberId: member.id, amount: '0.07', allowDebt: true });
  assert.equal(localDb.getMemberById(member.id).balance, -1808);
  localDb.recharge({ memberId: member.id, actualPay: '10.01' });
  assert.equal(localDb.getMemberById(member.id).balance, -807);
  localDb.recharge({ memberId: member.id, actualPay: '8.00', giftAmount: '0.07' });
  assert.equal(localDb.getMemberById(member.id).balance, 0);
  assert.doesNotThrow(() => localDb.parseAndValidateBackup(backup()));
});

test('negative balances survive backup replacement, merge, snapshots and CSV export', () => {
  const member = newMember(0), older = backup();
  localDb.consume({ memberId: member.id, amount: '38.01', allowDebt: true });
  const debtBackup = backup();
  assert.match(localDb.exportCSV(), /-38.01/);
  localDb.importBackupData(older);
  assert.equal(localDb.previewBackup(debtBackup).mergeError, '');
  localDb.importBackupData(debtBackup, { mode: 'merge' });
  assert.equal(localDb.getMemberById(member.id).balance, -3801);
  localDb.saveLocalSnapshot('欠款快照');
  assert.doesNotThrow(() => localDb.parseAndValidateBackup(localDb.getLocalSnapshots()[0].content));
  localDb.importBackupData(debtBackup);
  assert.equal(localDb.getMemberById(member.id).balance, -3801);
  const tampered = JSON.parse(debtBackup);
  tampered.data.members[0].balance = -3800;
  assert.throws(() => localDb.parseAndValidateBackup(JSON.stringify(tampered)), /会员数据|不一致/);
  tampered.data.members[0].balance = -3801;
  tampered.data.members[0].isArchived = true;
  assert.throws(() => localDb.parseAndValidateBackup(JSON.stringify(tampered)), /会员数据/);
});

test('debt cannot be archived and recharge reversal must acknowledge the debt it restores', () => {
  const member = newMember(0);
  const consumed = localDb.consume({ memberId: member.id, amount: 38, allowDebt: true });
  assert.throws(() => localDb.deleteMember(member.id), /欠款.*结清/);
  const recharge = localDb.recharge({ memberId: member.id, actualPay: 38 });
  assert.throws(() => localDb.refundLedger(recharge.ledgerId), /确认欠款/);
  localDb.refundLedger(recharge.ledgerId, '撤销错误还款', true);
  assert.equal(localDb.getMemberById(member.id).balance, -3800);
  localDb.refundLedger(consumed.ledgerId);
  assert.equal(localDb.getMemberById(member.id).balance, 0);
  assert.doesNotThrow(() => localDb.deleteMember(member.id));
  assert.doesNotThrow(() => localDb.parseAndValidateBackup(backup()));
});

test('reversing an archived zero-balance member recharge restores an active debt account', () => {
  const member = newMember(100), opening = localDb.getLedgers()[0].id;
  localDb.consume({ memberId: member.id, amount: 100 });
  localDb.deleteMember(member.id);
  localDb.refundLedger(opening, '错误充值', true);
  assert.equal(localDb.getMemberById(member.id).balance, -10000);
  assert.doesNotThrow(() => localDb.parseAndValidateBackup(backup()));
});

test('a failed overdraft write rolls back both balance and consumption ledger', t => {
  t.mock.method(console, 'error', () => {});
  const member = newMember(0), before = new Map(localStorage.values);
  localStorage.failKey = ledgersKey;
  assert.throws(() => localDb.consume({ memberId: member.id, amount: 38, allowDebt: true }), /回滚|恢复/);
  localStorage.failKey = null;
  assert.equal(localDb.getMemberById(member.id).balance, 0);
  assert.deepEqual(localStorage.values, before);
});

test('debt and prepaid balances are counted separately and extreme deductions cannot overflow', () => {
  const debtor = newMember(0);
  localDb.consume({ memberId: debtor.id, amount: 38, allowDebt: true });
  localDb.createMember({ name: '预付客户', phone: '13900002222', initialBalance: 100 });
  const totals = localDb.getDashboard();
  assert.equal(totals.totalBalance, 6200);
  assert.equal(totals.totalCreditBalance, 10000);
  assert.equal(totals.totalDebt, 3800);
  assert.equal(totals.debtMemberCount, 1);
  const before = new Map(localStorage.values);
  assert.throws(() => localDb.consume({ memberId: debtor.id, amount: '90071992547409.91', allowDebt: true }), /范围/);
  assert.deepEqual(localStorage.values, before);
});

test('decimal amounts are exact through opening, recharge, consumption and service pricing', () => {
  for (const [amount, cents] of [[0.07, 7], [0.14, 14], [0.29, 29], [1.1, 110], [2.3, 230], [19.99, 1999]]) {
    assert.equal(moneyToCent(amount), cents);
    assert.equal(moneyToCent(String(amount)), cents);
    assert.equal(isValidMoney(amount), true);
  }
  const member = newMember('19.99');
  localDb.recharge({ memberId: member.id, actualPay: '2.30', giftAmount: '0.07' });
  localDb.consume({ memberId: member.id, amount: '1.10' });
  assert.equal(localDb.getMemberById(member.id).balance, 2126);
  localDb.saveService({ name: '护理', price: '19.99' });
  assert.equal(localDb.getServices().at(-1).price, 19.99);
  const previous = new Map(localStorage.values);
  for (const invalid of [-1, '1.001', '1e2', '', Infinity, NaN, '90071992547409.92']) {
    assert.equal(isValidMoney(invalid), false);
    assert.throws(() => localDb.consume({ memberId: member.id, amount: invalid }));
  }
  assert.deepEqual(localStorage.values, previous);
});

test('a newer backup updates balance with its consumption, and reversal cannot create excess credit', () => {
  const member = newMember();
  const older = backup();
  const consumed = localDb.consume({ memberId: member.id, amount: 38 });
  const newer = backup();
  localDb.importBackupData(older);
  assert.equal(localDb.previewBackup(newer).mergeError, '');
  const result = localDb.importBackupData(newer, { mode: 'merge' });
  assert.equal(result.updatedMembers, 1);
  assert.equal(localDb.getMemberById(member.id).balance, 6200);
  assert.equal(localDb.getMemberById(member.id).total_consume, 3800);
  localDb.refundLedger(consumed.ledgerId);
  assert.equal(localDb.getMemberById(member.id).balance, 10000);
  assert.throws(() => localDb.refundLedger(consumed.ledgerId));
  assert.doesNotThrow(() => localDb.previewBackup(backup()));
});

test('the canonical transaction order survives merge when all timestamps are equal', () => {
  const member = newMember();
  const older = JSON.parse(backup());
  localDb.consume({ memberId: member.id, amount: 10 });
  localDb.recharge({ memberId: member.id, actualPay: 20 });
  localDb.consume({ memberId: member.id, amount: 10 });
  const newer = JSON.parse(backup());
  const timestamp = '2026-01-01T00:00:00.000Z';
  for (const record of [...older.data.ledgers, ...newer.data.ledgers]) record.created_at = timestamp;
  localDb.importBackupData(JSON.stringify(older));
  localDb.importBackupData(JSON.stringify(newer), { mode: 'merge' });
  assert.deepEqual(localDb.getLedgers().map(record => record.id), newer.data.ledgers.map(record => record.id));
  assert.doesNotThrow(() => localDb.parseAndValidateBackup(backup()));
});

test('phone edits preserve member identity and never restore a duplicate funded account', () => {
  const member = newMember();
  const older = backup();
  localDb.updateMember(member.id, { phone: '13900001111' });
  localDb.consume({ memberId: member.id, amount: 38 });
  const preview = localDb.previewBackup(older);
  assert.equal(preview.diff.newMembersCount, 0);
  assert.equal(preview.mergeError, '');
  localDb.importBackupData(older, { mode: 'merge' });
  assert.equal(localDb.getMembers().length, 1);
  assert.equal(localDb.getMemberById(member.id).phone, '13900001111');
  assert.equal(localDb.getDashboard().totalBalance, 6200);
});

test('clock changes do not reorder the financial history during backup or merge', () => {
  const member = newMember();
  const older = JSON.parse(backup());
  older.data.ledgers[0].created_at = '2026-11-02T00:00:00.000Z';
  localDb.importBackupData(JSON.stringify(older));
  localDb.consume({ memberId: member.id, amount: 38 });
  const newer = JSON.parse(backup());
  newer.data.ledgers[0].created_at = '2026-11-01T00:00:00.000Z';
  localDb.importBackupData(JSON.stringify(older));
  localDb.importBackupData(JSON.stringify(newer), { mode: 'merge' });
  assert.equal(localDb.getMemberById(member.id).balance, 6200);
  assert.equal(localDb.getLedgers()[0].type, 'CONSUME');
  assert.doesNotThrow(() => localDb.parseAndValidateBackup(backup()));
});

test('branch transactions reject merge without changing any stored data', () => {
  const member = newMember();
  const base = backup();
  localDb.consume({ memberId: member.id, amount: 38 });
  const branch = backup();
  localDb.importBackupData(base);
  localDb.recharge({ memberId: member.id, actualPay: 50 });
  const previous = new Map(localStorage.values);
  assert.match(localDb.previewBackup(branch).mergeError, /独立交易/);
  assert.throws(() => localDb.importBackupData(branch, { mode: 'merge' }), /独立交易/);
  assert.deepEqual(localStorage.values, previous);
});

test('matching transaction IDs with conflicting amounts are rejected', () => {
  newMember();
  const altered = JSON.parse(backup());
  altered.data.members[0].balance = 20000;
  altered.data.members[0].total_recharge = 20000;
  altered.data.ledgers[0].changeAmount = 20000;
  altered.data.ledgers[0].balanceAfter = 20000;
  const previous = new Map(localStorage.values);
  assert.throws(() => localDb.importBackupData(JSON.stringify(altered), { mode: 'merge' }), /冲突/);
  assert.deepEqual(localStorage.values, previous);
});

test('merge imports reversal status and is idempotent against older and newer backups', () => {
  const member = newMember();
  const consumed = localDb.consume({ memberId: member.id, amount: 38 });
  const beforeRefund = backup();
  localDb.refundLedger(consumed.ledgerId);
  const afterRefund = backup();
  localDb.importBackupData(beforeRefund);
  localDb.importBackupData(afterRefund, { mode: 'merge' });
  assert.equal(localDb.getMemberById(member.id).balance, 10000);
  assert.equal(localDb.getLedgers().find(record => record.id === consumed.ledgerId).isRefunded, true);
  assert.throws(() => localDb.refundLedger(consumed.ledgerId));
  localDb.importBackupData(beforeRefund, { mode: 'merge' });
  localDb.importBackupData(afterRefund, { mode: 'merge' });
  assert.equal(localDb.getLedgers().filter(record => record.type === 'REFUND').length, 1);
  assert.equal(localDb.getMemberById(member.id).balance, 10000);
});

test('legacy reversal remarks restore a missing flag and block repeat reversal', () => {
  const member = newMember();
  const consumed = localDb.consume({ memberId: member.id, amount: 38 });
  localDb.refundLedger(consumed.ledgerId);
  const oldFormat = JSON.parse(backup());
  oldFormat.data.ledgers.forEach(record => {
    delete record.originalLedgerId;
    delete record.isRefunded;
  });
  localDb.importBackupData(JSON.stringify(oldFormat));
  assert.throws(() => localDb.refundLedger(consumed.ledgerId));
  assert.equal(localDb.getLedgers()[0].originalLedgerId, consumed.ledgerId);
});

test('archive retains history, round trips through backup, and old backup cannot reactivate it', () => {
  const member = newMember();
  localDb.consume({ memberId: member.id, amount: 100 });
  const beforeArchive = backup();
  localDb.deleteMember(member.id);
  assert.equal(localDb.getMembers().length, 0);
  assert.equal(localDb.getDashboard().memberCount, 0);
  assert.equal(localDb.getLedgers().length, 2);
  localDb.importBackupData(beforeArchive, { mode: 'merge' });
  assert.equal(localDb.getMembers().length, 0);
  const archivedBackup = backup();
  localDb.importBackupData(archivedBackup);
  assert.equal(localDb.getMembers().length, 0);
  assert.equal(JSON.parse(archivedBackup).data.members[0].isArchived, true);
});

test('legacy backups with deleted zero-balance members regain archived historical records', () => {
  const member = newMember();
  localDb.consume({ memberId: member.id, amount: 100 });
  const oldFormat = JSON.parse(backup());
  oldFormat.data.members = [];
  localDb.importBackupData(JSON.stringify(oldFormat));
  assert.equal(localDb.getMembers().length, 0);
  assert.equal(JSON.parse(backup()).data.members[0].id, member.id);
  localStorage.setItem(membersKey, '[]');
  localDb.init();
  assert.equal(JSON.parse(localStorage.getItem(membersKey))[0].isArchived, true);
});

test('reversing an archived consumption restores a visible funded account', () => {
  const member = newMember();
  const consumed = localDb.consume({ memberId: member.id, amount: 100 });
  localDb.deleteMember(member.id);
  localDb.refundLedger(consumed.ledgerId);
  assert.equal(localDb.getMemberById(member.id).balance, 10000);
  assert.equal(localDb.getMembers().length, 1);
});

test('reversing an archive cannot create two active accounts with the same phone', () => {
  const member = newMember();
  const consumed = localDb.consume({ memberId: member.id, amount: 100 });
  localDb.deleteMember(member.id);
  localDb.createMember({ name: '新会员', phone: member.phone });
  const previous = new Map(localStorage.values);
  assert.throws(() => localDb.refundLedger(consumed.ledgerId), /手机号已用于其他会员/);
  assert.deepEqual(localStorage.values, previous);
});

test('invalid balances and duplicate reversal records cannot be imported', () => {
  const member = newMember();
  const consumed = localDb.consume({ memberId: member.id, amount: 38 });
  const inconsistent = JSON.parse(backup());
  inconsistent.data.members[0].balance = 10000;
  inconsistent.data.members[0].total_consume = 0;
  assert.throws(() => localDb.importBackupData(JSON.stringify(inconsistent)), /余额与流水/);
  const validMembers = localStorage.getItem(membersKey);
  localStorage.setItem(membersKey, JSON.stringify(inconsistent.data.members));
  assert.throws(() => localDb.init(), /余额与流水/);
  localStorage.setItem(membersKey, validMembers);
  localDb.refundLedger(consumed.ledgerId);
  const duplicated = JSON.parse(backup());
  duplicated.data.ledgers.unshift({ ...duplicated.data.ledgers[0], id: 'DUPLICATE-REFUND' });
  const previous = new Map(localStorage.values);
  assert.throws(() => localDb.importBackupData(JSON.stringify(duplicated)), /重复撤销/);
  assert.deepEqual(localStorage.values, previous);
});

test('a damaged ledger can be replaced, while its exact original bytes remain recoverable', t => {
  t.mock.method(console, 'error', () => {});
  newMember();
  const validBackup = backup();
  for (const damaged of ['{broken', '']) {
    localStorage.setItem(membersKey, damaged);
    assert.throws(() => localDb.init());
    assert.equal(localStorage.getItem(membersKey), damaged);
    const preview = localDb.previewBackup(validBackup);
    assert.equal(preview.isValid, true);
    assert.ok(preview.currentDataError);
    const previous = new Map(localStorage.values);
    assert.throws(() => localDb.importBackupData(validBackup, { mode: 'merge' }));
    assert.deepEqual(localStorage.values, previous);
    localDb.importBackupData(validBackup, { mode: 'replace' });
    assert.equal(localDb.getMembers().length, 1);
    assert.equal(JSON.parse(localStorage.getItem(safetyKey)).storage[membersKey], damaged);
  }
});

test('failure to preserve pre-restore data prevents replacement', t => {
  t.mock.method(console, 'error', () => {});
  newMember();
  const validBackup = backup();
  localStorage.failKey = safetyKey;
  const previous = new Map(localStorage.values);
  assert.throws(() => localDb.importBackupData(validBackup));
  assert.deepEqual(localStorage.values, previous);
});

test('snapshot errors are observable and do not prevent an external backup export', t => {
  t.mock.method(console, 'warn', () => {});
  newMember();
  localStorage.failKey = snapshotsKey;
  assert.throws(() => localDb.saveLocalSnapshot(), /快照保存失败/);
  assert.equal(localDb.getLocalSnapshots().length, 0);
  const validBackup = backup();
  assert.equal(localDb.parseAndValidateBackup(validBackup).data.members.length, 1);
  const result = localDb.importBackupData(validBackup);
  assert.equal(result.success, true);
  assert.equal(result.snapshotSaved, false);
  assert.throws(() => localDb.deleteLocalSnapshot('missing'), /删除本地快照失败/);
});

test('today totals exclude reversed recharges and consumptions', () => {
  const member = newMember();
  const opening = localDb.getLedgers()[0].id;
  const consumed = localDb.consume({ memberId: member.id, amount: 38 });
  localDb.refundLedger(consumed.ledgerId);
  localDb.refundLedger(opening);
  assert.deepEqual(localDb.getDashboard().today, {
    rechargeCount: 0, rechargeCreditTotal: 0, consumeCount: 0, consumeAmount: 0
  });
});

test('CSV round trips commas, quotes and embedded newlines in member names and remarks', () => {
  const name = '张姐,"熟客"';
  const remark = '剪短 "一点", 洗头\n温水';
  const member = localDb.createMember({ name, phone: '13800002222', initialBalance: 100 });
  localDb.consume({ memberId: member.id, amount: 38, itemsSummary: remark });
  const rows = parse(localDb.exportCSV(), { bom: true });
  assert.equal(rows.length, 3);
  assert.equal(rows[1].length, 8);
  assert.equal(rows[1][1], name);
  assert.equal(rows[1][6], remark);
  assert.equal(rows[1][4], '-38.00');
});

test('empty or invalid member edits leave the entire stored account unchanged', () => {
  const member = newMember();
  const previous = new Map(localStorage.values);
  for (const phone of ['', '   ', '\t\n', null, 13800001111]) {
    assert.throws(() => localDb.updateMember(member.id, { phone }), /手机号码/);
    assert.deepEqual(localStorage.values, previous);
  }
  assert.throws(() => localDb.updateMember(member.id, { name: '   ' }), /会员姓名/);
  assert.deepEqual(localStorage.values, previous);
  assert.doesNotThrow(() => localDb.init());
  localDb.updateMember(member.id, { phone: ' 13900001111 ', notes: '只修改备注' });
  assert.equal(localDb.getMemberById(member.id).phone, '13900001111');
  assert.doesNotThrow(() => localDb.init());
});

test('merge rejects a reactivated archive whose phone is in use, and permits retry after resolving it', () => {
  const member = newMember();
  const consumed = localDb.consume({ memberId: member.id, amount: 100 });
  localDb.deleteMember(member.id);
  const archived = backup();
  localDb.refundLedger(consumed.ledgerId);
  const reactivated = backup();
  localDb.importBackupData(archived);
  const replacement = localDb.createMember({ name: '新会员', phone: member.phone });
  const previous = new Map(localStorage.values);
  assert.match(localDb.previewBackup(reactivated).mergeError, /手机号/);
  assert.deepEqual(localStorage.values, previous);
  assert.throws(() => localDb.importBackupData(reactivated, { mode: 'merge' }), /手机号/);
  assert.deepEqual(localStorage.values, previous);
  assert.doesNotThrow(() => localDb.init());
  localDb.updateMember(replacement.id, { phone: '13900002222' });
  assert.equal(localDb.previewBackup(reactivated).mergeError, '');
  assert.equal(localDb.importBackupData(reactivated, { mode: 'merge' }).success, true);
  assert.equal(localDb.getMemberById(member.id).balance, 10000);
  assert.equal(localDb.getMembers().length, 2);
  assert.doesNotThrow(() => localDb.init());
});

test('invalid backup text fields fail preview and restoration before any storage changes', () => {
  newMember();
  const valid = backup();
  const previous = new Map(localStorage.values);
  for (const [collection, field, value] of [
    ['ledgers', 'memberPhone', 13800001111],
    ['ledgers', 'memberName', {}],
    ['ledgers', 'remark', []],
    ['members', 'notes', true]
  ]) {
    const invalid = JSON.parse(valid);
    invalid.data[collection][0][field] = value;
    const content = JSON.stringify(invalid);
    assert.throws(() => localDb.previewBackup(content), /无效/);
    for (const mode of ['replace', 'merge']) {
      assert.throws(() => localDb.importBackupData(content, { mode }), /无效/);
      assert.deepEqual(localStorage.values, previous);
    }
  }
});

test('legacy backups missing optional text fields restore safe display values', () => {
  const member = newMember();
  const legacy = JSON.parse(backup());
  delete legacy.data.members[0].notes;
  delete legacy.data.ledgers[0].memberName;
  delete legacy.data.ledgers[0].memberPhone;
  legacy.data.ledgers[0].remark = null;
  localDb.importBackupData(JSON.stringify(legacy));
  assert.equal(localDb.getMemberById(member.id).notes, '');
  const ledger = localDb.getLedgers()[0];
  assert.equal(ledger.memberName, member.name);
  assert.equal(ledger.memberPhone, member.phone);
  assert.equal(ledger.remark, '');
  assert.doesNotThrow(() => localDb.init());
});

test('orphan reversal flags fail preview and both restore modes without changing storage', () => {
  const member = newMember();
  localDb.consume({ memberId: member.id, amount: 38 });
  const valid = backup();
  const previous = new Map(localStorage.values);
  for (const index of [0, 1]) {
    const invalid = JSON.parse(valid);
    invalid.data.ledgers[index].isRefunded = true;
    const content = JSON.stringify(invalid);
    assert.throws(() => localDb.previewBackup(content), /撤销|冲正/);
    for (const mode of ['replace', 'merge']) {
      assert.throws(() => localDb.importBackupData(content, { mode }), /撤销|冲正/);
      assert.deepEqual(localStorage.values, previous);
    }
  }
  assert.equal(localDb.getDashboard().today.rechargeCreditTotal, 10000);
  assert.equal(localDb.getDashboard().today.consumeAmount, 3800);
  assert.doesNotThrow(() => localDb.refundLedger(localDb.getLedgers()[0].id));
});

for (const fixedMemberFirst of [false, true]) {
  test(`fixed member IDs remain distinct when a phone is reused (fixed member first: ${fixedMemberFirst})`, () => {
    const member = newMember();
    const older = JSON.parse(backup());
    localDb.updateMember(member.id, { phone: '13900001111' });
    const replacement = localDb.createMember({ name: '新会员', phone: member.phone, initialBalance: 50 });
    const newer = JSON.parse(backup());
    // 改号与建档可能发生在同一毫秒，不能依赖时间戳严格递增。
    older.data.members[0].updated_at = newer.data.members.find(item => item.id === member.id).updated_at;
    if (fixedMemberFirst) newer.data.members.reverse();
    localDb.importBackupData(JSON.stringify(older));
    const preview = localDb.previewBackup(JSON.stringify(newer));
    assert.equal(preview.mergeError, '');
    assert.equal(preview.diff.newMembersCount, 1);
    assert.equal(preview.diff.existingMembersCount, 1);
    const result = localDb.importBackupData(JSON.stringify(newer), { mode: 'merge' });
    assert.equal(result.newMembersAdded, 1);
    assert.equal(localDb.getMembers().length, 2);
    assert.equal(localDb.getMemberById(member.id).phone, '13900001111');
    assert.equal(localDb.getMemberById(member.id).balance, 10000);
    assert.equal(localDb.getMemberById(replacement.id).phone, member.phone);
    assert.equal(localDb.getMemberById(replacement.id).balance, 5000);
    assert.equal(localDb.getLedgers({ memberId: replacement.id }).length, 1);
    localDb.importBackupData(JSON.stringify(older), { mode: 'merge' });
    localDb.importBackupData(JSON.stringify(newer), { mode: 'merge' });
    assert.equal(localDb.getMemberById(member.id).phone, '13900001111');
    assert.equal(localDb.getDashboard().totalBalance, 15000);
    assert.equal(localDb.getLedgers().length, 2);
    assert.doesNotThrow(() => localDb.init());
  });
}

test('a financial extension also imports the member archive and keeps it on older merges', () => {
  const member = newMember();
  const older = backup();
  localDb.consume({ memberId: member.id, amount: 100 });
  localDb.deleteMember(member.id);
  const archived = backup();
  const archivedMember = JSON.parse(archived).data.members[0];
  localDb.importBackupData(older);
  const result = localDb.importBackupData(archived, { mode: 'merge' });
  assert.equal(result.updatedMembers, 1);
  assert.equal(localDb.getMemberById(member.id), null);
  assert.equal(localDb.getDashboard().memberCount, 0);
  assert.equal(JSON.parse(backup()).data.members[0].deleted_at, archivedMember.deleted_at);
  localDb.importBackupData(older, { mode: 'merge' });
  assert.equal(localDb.getMembers().length, 0);
  assert.equal(localDb.getLedgers().length, 2);
  assert.throws(() => localDb.recharge({ memberId: member.id, actualPay: 100 }), /注销/);
});

test('an archive with no added transactions is merged without relying on the phone clock', () => {
  const member = newMember(0);
  const older = backup();
  localDb.deleteMember(member.id);
  const archived = JSON.parse(backup());
  archived.data.members[0].updated_at = '2020-01-01T00:00:00.000Z';
  localDb.importBackupData(older);
  assert.equal(localDb.importBackupData(JSON.stringify(archived), { mode: 'merge' }).updatedMembers, 1);
  assert.equal(localDb.getMembers().length, 0);
  localDb.importBackupData(older, { mode: 'merge' });
  assert.equal(localDb.getMembers().length, 0);
});

test('a later reversal and consumption can reactivate an archive even when the final balance is zero', () => {
  const member = newMember();
  const consumed = localDb.consume({ memberId: member.id, amount: 100 });
  localDb.deleteMember(member.id);
  const archived = backup();
  localDb.refundLedger(consumed.ledgerId);
  localDb.consume({ memberId: member.id, amount: 100 });
  const reactivated = backup();
  localDb.importBackupData(archived);
  localDb.importBackupData(reactivated, { mode: 'merge' });
  assert.equal(localDb.getMemberById(member.id).balance, 0);
  assert.equal(localDb.getMembers().length, 1);
  assert.equal(JSON.parse(backup()).data.members[0].deleted_at, undefined);
});

test('CSV exports untrusted cells as text while keeping numeric amounts and ordinary text intact', () => {
  const member = localDb.createMember({ name: '=1+1', phone: '+13800002222', initialBalance: 100 });
  // Historic phone display text remains untrusted even though new profiles normalize it.
  const legacy = JSON.parse(backup()); legacy.data.members[0].phone = '+13800002222';
  localDb.importBackupData(JSON.stringify(legacy));
  for (const value of ['=SUM(1,1)', '+1+1', '-1+1', '@SUM(1,1)', '\t=1+1', '\r=1+1', '\n=1+1', ' \t=1+1', '\u00a0=1+1']) {
    localDb.consume({ memberId: member.id, amount: 1, itemsSummary: value });
    const rows = parse(localDb.exportCSV(), { bom: true });
    assert.equal(rows[1][1], "'=1+1");
    assert.equal(rows[1][2], "'+13800002222");
    assert.equal(rows[1][4], '-1.00');
    assert.equal(rows[1][6], "'" + value);
    assert.equal(localDb.getLedgers()[0].remark, value);
  }
  localDb.consume({ memberId: member.id, amount: 1, itemsSummary: '温水\n洗头,"剪短"' });
  const altered = JSON.parse(backup());
  altered.data.ledgers[0].id = '=1+1';
  localDb.importBackupData(JSON.stringify(altered));
  const rows = parse(localDb.exportCSV(), { bom: true });
  assert.equal(rows[1][0], "'=1+1");
  assert.equal(rows[1][6], '温水\n洗头,"剪短"');
  assert.equal(rows[1][5], '90.00');
});

test('reversing a legacy archive with no phone fails before writing and succeeds after restoring its profile', () => {
  const member = newMember();
  const consumed = localDb.consume({ memberId: member.id, amount: 100 });
  localDb.deleteMember(member.id);
  const legacy = JSON.parse(backup());
  legacy.data.members = [];
  for (const record of legacy.data.ledgers) delete record.memberPhone;
  localDb.importBackupData(JSON.stringify(legacy));
  assert.equal(localDb.readBackupState().members[0].phone, '');
  const previous = new Map(localStorage.values);
  assert.throws(() => localDb.refundLedger(consumed.ledgerId), /手机号/);
  assert.deepEqual(localStorage.values, previous);
  assert.doesNotThrow(() => localDb.init());
  assert.equal(localDb.getLedgers().find(record => record.id === consumed.ledgerId).isRefunded, undefined);

  const repaired = JSON.parse(backup());
  repaired.data.members[0].phone = member.phone;
  localDb.importBackupData(JSON.stringify(repaired));
  localDb.refundLedger(consumed.ledgerId);
  assert.equal(localDb.getMemberById(member.id).balance, 10000);
  assert.doesNotThrow(() => localDb.readBackupState());
});

test('reactivating an archive cannot introduce a duplicate phone hidden by surrounding whitespace', () => {
  const member = newMember();
  const consumed = localDb.consume({ memberId: member.id, amount: 100 });
  localDb.deleteMember(member.id);
  localDb.createMember({ name: '新会员', phone: member.phone });
  const altered = JSON.parse(backup());
  altered.data.members.find(item => item.id === member.id).phone = ' ' + member.phone + ' ';
  localDb.importBackupData(JSON.stringify(altered));
  const previous = new Map(localStorage.values);
  assert.throws(() => localDb.refundLedger(consumed.ledgerId), /手机号/);
  assert.deepEqual(localStorage.values, previous);
  assert.doesNotThrow(() => localDb.readBackupState());
});
