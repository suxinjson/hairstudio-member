import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { businessDays } from '../../src/relational-presentation.js';

export async function verifyLowBalanceBoundaries({ importMembers, list, report }) {
  const members = [
    { id: 'boundary-debt', name: '欠款边界', balanceCents: '-1' },
    { id: 'boundary-zero', name: '零元边界', balanceCents: '0' },
    { id: 'boundary-cent', name: '一分边界', balanceCents: '1' },
    { id: 'boundary-fifty', name: '五十元边界', balanceCents: '5000' },
    { id: 'boundary-funded', name: '超过五十元', balanceCents: '5001' }
  ];
  await importMembers({ batchId: randomUUID(), sourceDigest: 'c'.repeat(64), expectedCount: members.length, members });
  const low = await list({ balance: 'low' });
  assert.equal(low.total, 3);
  assert.deepEqual(new Set(low.items.map(member => member.id)), new Set(['boundary-zero', 'boundary-cent', 'boundary-fifty']));
  const { balances } = await report(businessDays('2026-11-26', '2026-11-26'));
  assert.equal(balances.memberCount, 5);
  assert.equal(balances.debtCount, 1);
  assert.equal(balances.zeroCount, 1);
  assert.equal(balances.lowCount, 2);
  assert.equal(balances.fundedCount, 1);
  assert.equal(balances.lowCount + balances.zeroCount, low.total);
  assert.equal(balances.lowCount + balances.zeroCount + balances.debtCount + balances.fundedCount, balances.memberCount);
}
