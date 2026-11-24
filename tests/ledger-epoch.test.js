import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerEpochOf, requireLedgerEpoch } from '../src/ledger-epoch.js';
import { validateFinancialCommand } from '../src/relational-contract.js';
import { taskRequest, bindTask } from '../src/relational-tasks.js';

const epoch = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002';
test('book generations are captured UUIDs; missing, coerced or replaced generations cannot authorize a request', () => {
  assert.equal(requireLedgerEpoch(epoch, epoch), epoch);
  for (const value of [undefined, null, '', 1, [epoch], epoch.toUpperCase().replace('4', 'A'), '00000000-0000-0000-0000-000000000000', epoch + ' ']) assert.throws(() => ledgerEpochOf(value), { code: 'LEDGER_EPOCH_REQUIRED', status: 400 });
  assert.throws(() => requireLedgerEpoch(epoch, other), { code: 'LEDGER_EPOCH_MISMATCH', status: 409 });
  const command = { id: 'generation-command-2026', storeId: 'store', memberId: 'member', type: 'recharge', expectedAccountVersion: '0', actualPayCents: '1' };
  assert.throws(() => validateFinancialCommand(command), { code: 'LEDGER_EPOCH_REQUIRED' });
  const captured = validateFinancialCommand({ ...command, ledgerEpoch: epoch }); assert.equal(captured.ledgerEpoch, epoch);
  const task = { id: 'generation-task-2026', storeId: 'store', type: 'member.create', data: { name: '合成会员' } };
  assert.throws(() => taskRequest(task), { code: 'LEDGER_EPOCH_REQUIRED' });
  assert.throws(() => bindTask(taskRequest({ ...task, ledgerEpoch: epoch }), { storeId: 'store', ledgerEpoch: other, actorId: 'owner', deviceId: 'generation-device-2026' }), { code: 'LEDGER_EPOCH_MISMATCH' });
});
