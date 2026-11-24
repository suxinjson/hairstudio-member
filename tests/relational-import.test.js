import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildOpeningProjection, yuanToCents } from '../tools/relational-import.mjs';

test('one-time JSON projection uses cents once, keeps identity and excludes old history', () => {
  const raw = JSON.stringify({ data: { members: Array.from({ length: 91 }, (_, i) => ({ id: 'old-' + i, name: '合成' + i, balance: (i - 1) * 1010, phone: '001-000', tag: '原标签', total_recharge: 99999 })), ledgers: [{ secret: 'not migrated' }] } });
  const { projection, summary } = buildOpeningProjection(raw);
  assert.equal(projection.members.length, 91); assert.equal(projection.members[0].balanceCents, '-1010'); assert.equal(projection.members[2].balanceCents, '1010');
  assert.equal(projection.members[0].phone, '001-000'); assert.deepEqual(projection.members[0].tags, ['原标签']);
  assert.equal(JSON.stringify(projection).includes('total_recharge'), false); assert.equal(JSON.stringify(projection).includes('ledgers'), false);
  assert.equal(summary.duplicatePhoneGroups, 1); assert.equal(summary.negativeBalanceCount, 1); assert.equal(summary.zeroBalanceCount, 1);
  assert.equal(JSON.stringify(summary).includes('原标签'), false); assert.equal(JSON.stringify(summary).includes('001-000'), false);
  assert.deepEqual(buildOpeningProjection(raw), { projection, summary });
});
test('yuan conversion is exact and rejects truncation, unsafe input and unsupported formats', () => {
  for (const [input, expected] of [['0.01', '1'], ['10.10', '1010'], ['-0.01', '-1'], ['0', '0'], ['92233720368547758.07', '9223372036854775807']]) assert.equal(yuanToCents(input), expected);
  for (const input of ['', 'NaN', '1e2', '1.001', ' 1', '+1', '1,000', '92233720368547758.08', 1.1]) assert.throws(() => yuanToCents(input));
  assert.throws(() => buildOpeningProjection('{"members":[]}'), /数量/);
  assert.throws(() => buildOpeningProjection('{"members":[{"id":"a","name":"x","balance":9007199254740992}]}', { expectedCount: 1 }), /安全整数/);
});
test('CSV preserves phone zeros, stable generated IDs and signed yuan without merging names or phones', () => {
  const raw = 'name,phone,balance_yuan,tags\n合成,00123,-10.10,甲|乙\n合成,00123,0,\n';
  const a = buildOpeningProjection(raw, { format: 'csv-yuan', expectedCount: 2 }), b = buildOpeningProjection(raw, { format: 'csv-yuan', expectedCount: 2 });
  assert.equal(a.projection.members[0].balanceCents, '-1010'); assert.equal(a.projection.members[0].phone, '00123');
  assert.notEqual(a.projection.members[0].id, a.projection.members[1].id); assert.deepEqual(a, b); assert.deepEqual(a.summary.generatedIdRows, [1, 2]);
});

test('retired JSON archive flags require a disposition and cannot silently become active profiles', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'member-import-archived-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.json'), target = join(directory, 'candidate.json');
  const raw = JSON.stringify({ data: { members: [{ id: 'retired-one', name: '合成归档', balance: 0, isArchived: true }] } });
  await writeFile(source, raw);
  const { summary } = buildOpeningProjection(raw, { expectedCount: 1 });
  assert.deepEqual(summary.archivedSourceRows, [1]);
  const tool = fileURLToPath(new URL('../tools/relational-import.mjs', import.meta.url));
  const args = [tool, '--source', source, '--expected-count', '1', '--out', target, '--reviewed-source-digest', summary.sourceDigest, '--reviewed-payload-digest', summary.payloadDigest];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /去向核对/); await assert.rejects(access(target));
  const review = join(directory, 'review.json');
  await writeFile(review, JSON.stringify({ reviewedSourceDigest: summary.sourceDigest, reactivateIds: ['wrong'] }));
  assert.equal(spawnSync(process.execPath, [...args, '--archived-review', review]).status, 1); await assert.rejects(access(target));
  await writeFile(review, JSON.stringify({ reviewedSourceDigest: summary.sourceDigest, reactivateIds: ['retired-one'] }));
  assert.equal(spawnSync(process.execPath, [...args, '--archived-review', review]).status, 0); await access(target);
});

test('import CLI redacts malformed source content and refuses writing candidate members into the repository', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'member-import-')), source = join(directory, 'source.json');
  const tool = fileURLToPath(new URL('../tools/relational-import.mjs', import.meta.url));
  try {
    await writeFile(source, '{"members":[{"name":"SYNTHETIC_PRIVATE_NAME","phone":"009876543210"} BROKEN');
    const invalid = spawnSync(process.execPath, [tool, '--source', source], { encoding: 'utf8' });
    assert.equal(invalid.status, 1); assert.doesNotMatch(invalid.stderr, /SYNTHETIC_PRIVATE_NAME|009876543210/);
    const raw = JSON.stringify({ members: Array.from({ length: 91 }, (_, i) => ({ id: 'mock-' + i, name: '合成', balance: 0 })) });
    await writeFile(source, raw); const { summary } = buildOpeningProjection(raw);
    const target = fileURLToPath(new URL('../.forbidden-member-projection.json', import.meta.url));
    const blocked = spawnSync(process.execPath, [tool, '--source', source, '--out', target, '--reviewed-source-digest', summary.sourceDigest, '--reviewed-payload-digest', summary.payloadDigest], { encoding: 'utf8' });
    assert.equal(blocked.status, 1); assert.match(blocked.stderr, /仓库之外/); await assert.rejects(access(target));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
