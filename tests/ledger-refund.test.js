import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import { createLocalDb } from '../src/storage.js';
import { useLedgerRefund } from '../src/composables/useLedgerRefund.js';

function fixture() {
  const values = new Map();
  const db = createLocalDb({ getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) });
  db.init();
  const member = db.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  const prompts = [], feedback = [];
  const { confirmRefundLedger } = useLedgerRefund({ localDb: db, refreshAll: () => {}, selectedMember: ref(null),
    askConfirm: options => new Promise(resolve => prompts.push({ ...options, resolve })),
    showToast: () => {}, showFeedback: (...args) => feedback.push(args), formatCent: cents => (cents / 100).toFixed(2) });
  return { db, member, prompts, feedback, confirmRefundLedger };
}

for (const scenario of [
  { name: 'increasing debt', spent: 50, method: 'consume', amount: 50, expected: -10000 },
  { name: 'new debt', spent: 0, method: 'consume', amount: 50, expected: -5000 },
  { name: 'debt repaid', spent: 50, method: 'recharge', amount: 60, expected: 1000 }
]) {
  test(`refund confirmation is renewed after ${scenario.name} changes while awaiting approval`, async () => {
    const { db, member, prompts, feedback, confirmRefundLedger } = fixture();
    const recharge = db.getLedgers()[0];
    if (scenario.spent) db.consume({ memberId: member.id, amount: scenario.spent });
    const waiting = confirmRefundLedger(recharge);
    db[scenario.method]({ memberId: member.id,
      ...(scenario.method === 'consume' ? { amount: scenario.amount } : { actualPay: scenario.amount }) });
    const before = db.getMemberById(member.id).balance;
    prompts[0].resolve(true);
    await Promise.resolve();
    assert.equal(prompts.length, 2);
    assert.equal(db.getMemberById(member.id).balance, before);
    assert.equal(db.getLedgers().filter(record => record.type === 'REFUND').length, 0);
    assert.ok(prompts[1].message.includes((Math.abs(scenario.expected) / 100).toFixed(2)));
    prompts[1].resolve(true); await waiting;
    assert.equal(db.getMemberById(member.id).balance, scenario.expected);
    assert.equal(db.getLedgers().filter(record => record.type === 'REFUND').length, 1);
    assert.deepEqual(feedback, []);
  });
}

test('cancelling the updated refund confirmation leaves the changed ledger untouched', async () => {
  const { db, member, prompts, confirmRefundLedger } = fixture();
  const waiting = confirmRefundLedger(db.getLedgers()[0]);
  db.consume({ memberId: member.id, amount: 50 });
  const before = db.readBackupState();
  prompts[0].resolve(true); await Promise.resolve();
  prompts[1].resolve(false); await waiting;
  assert.deepEqual(db.readBackupState(), before);
});

test('a zero-balance archived member can still have a consumption reversed', async () => {
  const { db, member, prompts, feedback, confirmRefundLedger } = fixture();
  db.consume({ memberId: member.id, amount: 100 });
  const consumption = db.getLedgers()[0]; db.deleteMember(member.id);
  const waiting = confirmRefundLedger(consumption);
  prompts[0].resolve(true); await waiting;
  assert.equal(db.getMemberById(member.id).balance, 10000);
  assert.deepEqual(feedback, []);
});
