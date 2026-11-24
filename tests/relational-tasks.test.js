const ledgerEpoch = '00000000-0000-4000-8000-000000000001';
import test from 'node:test';
import assert from 'node:assert/strict';
import { taskRequest, bindTask, mutationTask } from '../src/relational-tasks.js';

const request = () => ({ id: 'task-contract-20261119', storeId: 'store-1', ledgerEpoch, type: 'member.create', data: { name: ' 原始内容 ', phone: '001', tags: ['标签'] } });
test('task requests are bounded typed captures, require identity scope, and preserve original content across awaits', () => {
  const input = request(), captured = taskRequest(input); input.data.name = 'changed'; input.data.tags.push('changed');
  assert.equal(captured.data.name, ' 原始内容 '); assert.deepEqual(captured.data.tags, ['标签']);
  const bound = bindTask(captured, { storeId: 'store-1', ledgerEpoch, actorId: 'actor-1', deviceId: 'device-contract-2026' });
  assert.equal(bound.actorId, 'actor-1'); assert.equal(bound.deviceId, 'device-contract-2026');
  for (const override of [{ id: '' }, { storeId: ' ' }, { memberId: 'unwanted' }, { data: { name: 'x', balanceCents: '1' } }, { type: 'member.archive' }, { type: 'member.update', memberId: 'm', data: { name: 'x' } }, { actorId: 1 }, { deviceId: '' }, { extra: 1 }]) assert.throws(() => taskRequest({ ...request(), ...override }), { status: 400 });
  for (const context of [{ storeId: 'other', ledgerEpoch, actorId: 'actor-1', deviceId: 'device-contract-2026' }, { storeId: 'store-1', ledgerEpoch, actorId: 'other', deviceId: 'device-contract-2026' }, { storeId: 'store-1', ledgerEpoch, actorId: 'actor-1', deviceId: 'other-device-2026' }]) assert.throws(() => bindTask(bound, context), { status: 400 });
  assert.throws(() => mutationTask('member.create', { name: 'x' }), { status: 400 });
  assert.throws(() => mutationTask('member.create', { name: 'x' }, { id: 'task-contract-2026', storeId: 'store-1', ledgerEpoch, extra: 1 }), { status: 400 });
  assert.deepEqual(taskRequest({ id: 'task-archive-20261119', storeId: 's', ledgerEpoch, memberId: 'm', type: 'member.archive', data: {} }).data, {});
});
