import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCents, centsString, applyDelta, createRecharge, createConsumption, applyFinancialCommand, createReversal } from '../src/ledger-domain.js';

test('v2 money rejects coercion, fractions and overflow and preserves signed cents', () => {
  for (const invalid of [0, null, undefined, '', '-0', '1.00', '1e2', ' 1', '+1', '01', NaN, '9223372036854775808', '-9223372036854775809']) assert.throws(() => parseCents(invalid));
  assert.equal(parseCents('-9223372036854775808'), -9223372036854775808n);
  assert.throws(() => parseCents('1'.repeat(1000000)));
  assert.equal(centsString(9223372036854775807n), '9223372036854775807');
  assert.throws(() => centsString(9223372036854775808n));
  assert.throws(() => applyDelta('9223372036854775807', '1'));
  assert.throws(() => applyDelta('0', 9223372036854775808n));
});

test('v2 recharge, debt settlement, consumption and reversal use exact integer arithmetic', () => {
  assert.deepEqual(createRecharge({ actualPayCents: '1010', giftCents: '101' }), { kind: 'recharge', actualPayCents: '1010', giftCents: '101', deltaCents: '1111' });
  assert.equal(applyFinancialCommand('-500', createRecharge({ actualPayCents: '100' })).balanceAfterCents, '-400');
  assert.throws(() => applyFinancialCommand('10', createConsumption({ amountCents: '11' })), /欠款/);
  assert.equal(applyFinancialCommand('10', createConsumption({ amountCents: '11', allowDebt: true })).balanceAfterCents, '-1');
  assert.throws(() => createRecharge({ actualPayCents: '0' }));
  assert.throws(() => createRecharge({ actualPayCents: '9223372036854775807', giftCents: '1' }));
  assert.throws(() => createConsumption({ amountCents: '1', allowDebt: 'true' }));
  assert.throws(() => createReversal({ originalKind: 'consume', originalDeltaCents: '-9223372036854775808', currentBalanceCents: '-9223372036854775808', allowDebt: true }));
  assert.equal(createReversal({ originalKind: 'consume', originalDeltaCents: '-11', currentBalanceCents: '-1' }).balanceAfterCents, '10');
});

test('signed boundaries are exact and underflow is rejected even after debt consent', () => {
  const minimum = '-9223372036854775808';
  assert.equal(centsString(minimum), minimum);
  assert.throws(() => centsString(-9223372036854775809n), /BIGINT/);
  assert.deepEqual(applyDelta('-9223372036854775807', '-1'), {
    balanceBeforeCents: '-9223372036854775807', deltaCents: '-1', balanceAfterCents: minimum
  });
  assert.throws(() => applyFinancialCommand(minimum, createConsumption({ amountCents: '1', allowDebt: true })), /交易后余额超出/);
  assert.equal(applyFinancialCommand('1', createConsumption({ amountCents: '1' })).balanceAfterCents, '0');
});

test('financial constructors reject zero debits and negative inputs and require explicit reversal debt consent', () => {
  const source = { originalKind: 'recharge', originalDeltaCents: '11', currentBalanceCents: '10' };
  assert.throws(() => createRecharge({ actualPayCents: '-1' }), /实付金额必须大于零/);
  assert.throws(() => createRecharge({ actualPayCents: '1', giftCents: '-1' }), /赠送金额不能为负数/);
  assert.throws(() => createConsumption({ amountCents: '0' }), /消费金额必须大于零/);
  assert.throws(() => createReversal({ ...source, originalKind: 'reversal' }), /不能撤销/);
  assert.throws(() => createReversal({ ...source, originalDeltaCents: '0' }), /零金额/);
  assert.throws(() => createReversal({ ...source, allowDebt: 'true' }), /必须是布尔值/);
  assert.throws(() => createReversal(source), /形成欠款/);
  assert.equal(createReversal({ ...source, allowDebt: true }).balanceAfterCents, '-1');
});

test('v2 deterministic reference model: 100 seeds × 100 financial commands', () => {
  for (let seed = 1; seed <= 100; seed++) {
    let state = Math.imul(seed, 0x9e3779b9), balance = BigInt(seed % 3 - 1);
    const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    const unreversed = [];
    for (let step = 0; step < 100; step++) {
      const context = 'seed=' + seed + ' step=' + step;
      const amount = BigInt(next() % 100000 + 1), gift = BigInt(next() % 1000), operation = next() % 3, allowDebt = next() % 2 === 0;
      const reversing = operation === 2 && unreversed.length > 0;
      const index = reversing ? next() % unreversed.length : -1;
      const original = unreversed[index], recharge = operation === 0;
      const delta = reversing ? -original.delta : recharge ? amount + gift : -amount;
      const expected = balance + delta;
      const apply = () => reversing ? createReversal({ originalKind: original.kind, originalDeltaCents: String(original.delta), currentBalanceCents: String(balance), allowDebt })
        : applyFinancialCommand(String(balance), recharge ? createRecharge({ actualPayCents: String(amount), giftCents: String(gift) }) : createConsumption({ amountCents: String(amount), allowDebt }));
      if (expected < 0n && (reversing || !recharge) && !allowDebt) {
        assert.throws(apply, /欠款/, context);
        continue;
      }
      const result = apply();
      assert.deepEqual([result.balanceBeforeCents, result.deltaCents, result.balanceAfterCents], [String(balance), String(delta), String(expected)], context);
      if (reversing) unreversed.splice(index, 1);
      else unreversed.push({ kind: recharge ? 'recharge' : 'consume', delta });
      balance = expected;
    }
  }
});
