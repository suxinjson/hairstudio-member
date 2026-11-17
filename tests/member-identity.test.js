import test from 'node:test';
import assert from 'node:assert/strict';
import { sameNameMembers } from '../src/member-identity.js';

test('same-name warnings normalize spacing and letter width while retaining identifying suffixes', () => {
  const members = [{ id: 'a', name: ' Alice　 Chen ', phone: '13800001111' },
    { id: 'b', name: 'Alice Chen（东区）', phone: '' }, { id: 'c', name: 'Alice Chen', isArchived: true }];
  assert.deepEqual(sameNameMembers(members, { name: 'ＡＬＩＣＥ   Chen', phone: '   ' }).map(member => member.id), ['a']);
  assert.deepEqual(sameNameMembers(members, { name: 'Alice Chen (西区)' }), []);
  assert.deepEqual(sameNameMembers(members, { name: 'Alice Chen', phone: '13900001111' }), []);
  assert.deepEqual(sameNameMembers(members, { id: 'a', name: 'Alice Chen', phone: '' }), []);
});
