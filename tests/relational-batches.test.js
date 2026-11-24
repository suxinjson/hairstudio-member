import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openNodeSqlite } from '../tools/sqlite-node-driver.mjs';
import { createRelationalSqlite, sha256 } from '../src/relational-sqlite.js';
import { batchRequest } from '../src/relational-batches.js';
import { createBatchRunner } from '../src/relational-batch-runner.js';
import { LICENSE_FEATURES } from '../src/license-policy.js';
import { canonicalJSON } from '../src/canonical-json.js';

const ledgerEpoch = '00000000-0000-4000-8000-000000000001', storeId = 'batch-store', deviceId = 'batch-device-20261119', actorId = 'batch-owner';
const scope = () => ({ storeId, ledgerEpoch, actorId, deviceId });
const batch = (n = 4) => ({ ...scope(), id: randomUUID(), sourceDigest: 'a'.repeat(64), items: Array.from({ length: n }, (_, i) => ({ id: randomUUID(), type: 'member.create', data: { name: ' 原始 ' + i, phone: String(i + 1).padStart(4, '0'), notes: '', tags: ['乙', '甲'] } })) });
const ref = b => ({ ...scope(), id: b.id });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'member-batches-')), path = join(directory, 'book.sqlite');
  let db, driver, user = { storeId, id: actorId, deviceId, role: 'owner', features: LICENSE_FEATURES }, fault;
  async function open() {
    driver = openNodeSqlite(path); const run = driver.run, exec = driver.exec, all = driver.all;
    driver.run = (sql, p) => { if (fault && sql.includes(fault)) throw new Error('injected batch failure'); return run(sql, p); };
    driver.exec = sql => { if (fault && sql === fault) throw new Error('injected batch failure'); return exec(sql); };
    driver.all = (sql, p) => { const rows = all(sql, p); assert.ok(rows.length <= 1000); return rows; };
    db = createRelationalSqlite({ driver, storeId, mode: 'standalone', ledgerEpoch, authorize: async () => user }); await db.init();
  }
  await open();
  t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); });
  return { get db() { return db; }, get driver() { return driver; }, fault: value => fault = value, user: value => user = { ...user, ...value }, reopen: async () => { await db.close(); await open(); } };
}
const runner = repository => createBatchRunner({ repository, getScope: async () => scope() });
async function restore(f, backup) { return f.db.restoreBackup(backup, { id: randomUUID(), ...await f.db.getBook(), actorId, deviceId, digest: backup.digest }); }
async function active(f, b) { await f.db.captureBatch(b); return f.db.controlBatch({ ...ref(b), state: 'active', expectedVersion: '0' }); }

test('batch contract captures all rows before awaits and rejects ambiguous identities, payloads and bounds', () => {
  const b = batch(), captured = batchRequest(b); b.items[0].data.name = 'changed'; b.items[0].data.tags.push('changed');
  assert.equal(captured.items[0].data.name, ' 原始 0'); assert.deepEqual(captured.items[0].data.tags, ['乙', '甲']);
  for (const change of [b => delete b.actorId, b => b.items.push(b.items[0]), b => b.sourceDigest = 'bad', b => b.items[0].data.balanceCents = '1', b => b.items[0].data.phone = null, b => b.items[0].storeId = 'other', b => b.items = [], b => b.items = Array.from({ length: 501 }, () => batch(1).items[0])]) {
    const input = batch(); change(input); assert.throws(() => batchRequest(input));
  }
});

test('SQLite captured batches survive reopen; ten independent runners deduplicate rows and recover original progress', async t => {
  const f = await fixture(t), b = batch(16); await f.db.captureBatch(b);
  assert.equal((await f.db.listMembers()).items.length, 0);
  await assert.rejects(f.db.executeBatchItem(ref(b), b.items[0].id), { code: 'BATCH_PAUSED' });
  await f.reopen(); assert.equal((await f.db.listBatches({ ledgerEpoch })).items[0].batchId, b.id);
  await f.db.controlBatch({ ...ref(b), state: 'active', expectedVersion: '0' });
  await Promise.all(Array.from({ length: 10 }, () => runner(f.db).run(ref(b))));
  const progress = await f.db.getBatch(ref(b)); assert.equal(progress.completedCount, 16); assert.equal(progress.pendingCount, 0);
  assert.equal((await f.db.listMembers()).items.length, 16);
  assert.equal(f.driver.all('SELECT count(*) AS n FROM local_task_receipts')[0].n, '16');
  const receipt = await f.db.getTask(b.items[0].id, { ledgerEpoch });
  await f.db.executeTask({ ...scope(), id: randomUUID(), type: 'member.update', memberId: receipt.result.id, data: { name: 'later', expectedVersion: '0' } });
  assert.deepEqual(await f.db.executeBatchItem(ref(b), b.items[0].id), receipt.result);
  assert.equal((await f.db.captureBatch(b)).alreadyCaptured, true);
  const changed = structuredClone(b); changed.items[0].data.name = 'changed'; await assert.rejects(f.db.captureBatch(changed), { code: 'BATCH_CONFLICT' });
  assert.equal((await f.db.getBatch(ref(b), { after: 4, limit: 2 })).nextAfter, 6);
});

test('pause is resumable with a version; terminal cancellation fences delayed direct tasks and preserves committed rows', async t => {
  const f = await fixture(t), b = batch(); await active(f, b);
  const first = await f.db.executeBatchItem(ref(b), b.items[0].id);
  const paused = await f.db.controlBatch({ ...ref(b), state: 'paused', expectedVersion: '1' });
  assert.deepEqual(await f.db.controlBatch({ ...ref(b), state: 'paused', expectedVersion: '1' }), paused);
  await assert.rejects(f.db.executeBatchItem(ref(b), b.items[1].id), { code: 'BATCH_PAUSED' });
  await f.db.controlBatch({ ...ref(b), state: 'active', expectedVersion: '2' });
  await assert.rejects(f.db.controlBatch({ ...ref(b), state: 'paused', expectedVersion: '1' }), { code: 'BATCH_VERSION_CHANGED' });
  await f.db.controlBatch({ ...ref(b), state: 'cancelled', expectedVersion: '3' });
  const delayed = { ...scope(), ...b.items[1] };
  await assert.rejects(f.db.executeTask(delayed), { code: 'BATCH_CANCELLED' });
  await assert.rejects(f.db.controlBatch({ ...ref(b), state: 'active', expectedVersion: '4' }), { code: 'BATCH_CANCELLED' });
  assert.deepEqual(await f.db.executeBatchItem(ref(b), b.items[0].id), first);
  const p = await f.db.getBatch(ref(b)); assert.equal(p.completedCount, 1); assert.equal(p.cancelledCount, 3); assert.equal(p.pendingCount, 0);
  await f.reopen(); await assert.rejects(f.db.executeTask(delayed), { code: 'BATCH_CANCELLED' });
  assert.throws(() => f.driver.run("UPDATE application_batch_controls SET state='active',version=5"), /invalid batch transition/);
});

test('lost row response stops the runner; a new controller resumes original captures without duplicate effects', async t => {
  const f = await fixture(t), b = batch(); await active(f, b);
  let calls = 0;
  const transport = { getBatch: (...args) => f.db.getBatch(...args), executeBatchItem: async (...args) => { calls++; await f.db.executeBatchItem(...args); throw new Error('response lost'); } };
  await assert.rejects(runner(transport).run(ref(b)), /response lost/); assert.equal(calls, 1);
  assert.equal((await f.db.getBatch(ref(b))).completedCount, 1);
  await f.reopen(); const p = await runner(f.db).run(ref(b), { maxItems: 1 }); assert.equal(p.completedCount, 2);
  await runner(f.db).run(ref(b)); assert.equal((await f.db.getBatch(ref(b))).completedCount, 4);
  const abort = new AbortController(); abort.abort(); const empty = batch(); await active(f, empty);
  await runner(f.db).run(ref(empty), { signal: abort.signal }); assert.equal((await f.db.getBatch(ref(empty))).completedCount, 0);
});

test('captured edits retain their original version on resume and a conflict never overwrites a newer profile', async t => {
  const f = await fixture(t), created = await f.db.executeTask({ ...scope(), id: randomUUID(), type: 'member.create', data: { name: 'initial' } });
  const b = { ...batch(1), items: [{ id: randomUUID(), type: 'member.update', memberId: created.id, data: { name: 'captured', expectedVersion: '0' } }] };
  await active(f, b);
  await f.db.executeTask({ ...scope(), id: randomUUID(), type: 'member.update', memberId: created.id, data: { name: 'newer', expectedVersion: '0' } });
  await assert.rejects(runner(f.db).run(ref(b)), { status: 409 }); await f.reopen();
  await assert.rejects(runner(f.db).run(ref(b)), { status: 409 });
  assert.equal((await f.db.getMember(created.id)).name, 'newer'); assert.equal((await f.db.getBatch(ref(b))).completedCount, 0);
});

test('typed rows preserve omitted fields, empty tags and mixed create/update/archive tasks exactly', async t => {
  const f = await fixture(t), make = name => f.db.executeTask({ ...scope(), id: randomUUID(), type: 'member.create', data: { name } });
  const update = await make('update'), archive = await make('archive');
  const b = { ...batch(1), items: [
    { id: randomUUID(), type: 'member.update', memberId: update.id, data: { name: ' updated ', expectedVersion: '0', tags: [], notes: '' } },
    { id: randomUUID(), type: 'member.archive', memberId: archive.id, data: {} },
    { id: randomUUID(), type: 'member.create', data: { name: 'only-name' } }
  ] };
  await active(f, b); await f.reopen();
  for (const item of b.items) assert.deepEqual(await f.db.getBatchItem(ref(b), item.id), { ...scope(), ...item });
  await runner(f.db).run(ref(b)); assert.equal((await f.db.getMember(update.id)).name, 'updated');
  assert.ok((await f.db.getMember(archive.id)).archivedAt);
});

test('500-row batches cross progress pages without truncation and controllers suppress old-context progress', async t => {
  const f = await fixture(t), b = batch(500); await active(f, b);
  let total = 0, after = -1;
  for (;;) {
    const page = await f.db.getBatch(ref(b), { after }); total += page.items.length;
    if (page.nextAfter === null) break; after = page.nextAfter;
  }
  assert.equal(total, 500);
  let current = scope(), notifications = 0;
  const adapter = { executeBatchItem: (...args) => f.db.executeBatchItem(...args), getBatch: async (...args) => {
    const result = await f.db.getBatch(...args); if (result.completedCount) current = { ...current, actorId: 'new-owner' }; return result;
  } };
  const r = createBatchRunner({ repository: adapter, getScope: async () => current });
  await assert.rejects(r.run(ref(b), { maxItems: 2, onProgress: () => notifications++ }), { code: 'BATCH_CONTEXT_CHANGED' });
  assert.equal(notifications, 0); assert.equal((await f.db.getBatch(ref(b))).completedCount, 1);
});

test('batch capture and row commits roll back on SQL, audit or commit faults; immutable captures remain retryable', async t => {
  const f = await fixture(t), b = batch();
  for (const fault of ['INSERT INTO application_batch_tags', 'INSERT INTO local_audit', 'COMMIT']) {
    f.fault(fault); await assert.rejects(f.db.captureBatch(b), /injected/); f.fault(null);
    assert.equal((await f.db.listBatches({ ledgerEpoch })).items.length, 0);
  }
  await active(f, b);
  for (const fault of ['INSERT INTO task_member_results', 'INSERT INTO local_audit', 'COMMIT']) {
    f.fault(fault); await assert.rejects(f.db.executeBatchItem(ref(b), b.items[0].id), /injected/); f.fault(null);
    assert.equal((await f.db.listMembers()).items.length, 0); assert.equal((await f.db.getBatch(ref(b))).completedCount, 0);
  }
  await f.db.executeBatchItem(ref(b), b.items[0].id);
  assert.throws(() => f.driver.run("UPDATE application_batch_items SET name='changed'"), /immutable/);
});

test('batch capture, discovery, execution and controls bind actor, device, epoch, permission and original task identity', async t => {
  const f = await fixture(t), b = batch(); await active(f, b);
  f.user({ id: 'another-owner' }); assert.equal((await f.db.listBatches({ ledgerEpoch })).items.length, 0);
  for (const action of [() => f.db.getBatch(ref(b)), () => f.db.executeBatchItem(ref(b), b.items[0].id), () => f.db.controlBatch({ ...ref(b), state: 'cancelled', expectedVersion: '1' })]) await assert.rejects(action(), { code: 'BATCH_CONTEXT_CHANGED' });
  f.user({ id: actorId, role: 'viewer' }); await assert.rejects(f.db.executeBatchItem(ref(b), b.items[0].id), { status: 403 });
  f.user({ role: 'owner' });
  await assert.rejects(f.db.executeTask({ ...scope(), ...b.items[0], data: { name: 'different' } }), { code: 'TASK_CONFLICT' });
  const rebound = { ...b, id: randomUUID() }; await assert.rejects(f.db.captureBatch(rebound), { code: 'BATCH_TASK_CONFLICT' });
  await assert.rejects(f.db.getBatch({ ...ref(b), ledgerEpoch: randomUUID() }), { code: 'LEDGER_EPOCH_MISMATCH' });
});

test('backup includes typed pending captures and cancellation; restore fences old batches and rejects altered row hashes', async t => {
  const f = await fixture(t), target = await fixture(t), b = batch(); await active(f, b); await f.db.executeBatchItem(ref(b), b.items[0].id);
  await f.db.controlBatch({ ...ref(b), state: 'cancelled', expectedVersion: '1' });
  const backup = await f.db.exportBackup(); assert.equal(backup.tables.application_batch_items.length, 4);
  const damaged = structuredClone(backup); damaged.tables.application_batch_items[1].name = 'tampered';
  const { digest: _, ...payload } = damaged; damaged.digest = await sha256(canonicalJSON(payload));
  await assert.rejects(restore(target, damaged), /摘要/);
  const invalidProfile = structuredClone(backup); invalidProfile.tables.member_profiles[0].phone = null;
  const { digest: _priorDigest, ...invalidPayload } = invalidProfile; invalidProfile.digest = await sha256(canonicalJSON(invalidPayload));
  await assert.rejects(target.db.previewBackupRestore(invalidProfile), /有界文本/);
  const result = await restore(target, backup); assert.notEqual(result.ledgerEpoch, ledgerEpoch);
  await assert.rejects(target.db.executeBatchItem(ref(b), b.items[1].id), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(target.db.getBatch({ ...ref(b), ledgerEpoch: result.ledgerEpoch }), { code: 'LEDGER_EPOCH_MISMATCH' });
  const again = await target.db.exportBackup(); assert.deepEqual(again.tables.application_batch_items, backup.tables.application_batch_items);
});
