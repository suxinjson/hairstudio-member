import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createService } from './helpers/licensed-service.js';
import { relationalTestDatabase } from './helpers/relational-database.js';
import { createApi } from '../http.js';
import { createBatchRunner } from '../../src/relational-batch-runner.js';
import { taskLock } from '../relational-batches.js';
import { digest } from '../security.js';
import { canonicalJSON } from '../../src/canonical-json.js';
import { readFile } from 'node:fs/promises';
import { batchSchema } from '../../src/relational-batch-schema.js';

let database, pool, service, ledger, actor, scope, token, server, origin;
const password = 'Batch-Test-2026-Long!';
const batch = (n = 4) => ({ ...scope, id: randomUUID(), sourceDigest: 'a'.repeat(64), items: Array.from({ length: n }, (_, i) => ({ id: randomUUID(), type: 'member.create', data: { name: ' 捕获 ' + i, tags: ['乙', '甲'], phone: String(i + 1).padStart(3, '0') } })) });
const ref = b => ({ ...scope, id: b.id });
const adapter = () => ({ getBatch: (...args) => ledger.getBatch(actor, ...args), executeBatchItem: (...args) => ledger.executeBatchItem(actor, ...args) });
const runner = () => createBatchRunner({ repository: adapter(), getScope: async () => scope });
async function active(b) { await ledger.captureBatch(actor, b); await ledger.controlBatch(actor, { ...ref(b), state: 'active', expectedVersion: '0' }); }
before(async () => {
  database = await relationalTestDatabase(); pool = database.pool; service = createService(pool, { recoveryPool: pool }); ledger = service.relational;
  server = createApi({ service, pool }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  console.log('batch database:', database.engine);
});
after(async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await database?.close(); });
beforeEach(async () => {
  await pool.query('TRUNCATE stores,login_limits RESTART IDENTITY CASCADE');
  const owner = await service.createOwner({ username: 'batch-owner', password });

  const login = await service.login({ username: 'batch-owner', password, deviceId: randomUUID() }, '127.0.0.1'); token = login.accessToken; actor = await service.authenticate(token);
  scope = { ...await ledger.getBook(actor), actorId: actor.id, deviceId: actor.device_id };
});

test('ten batch runners deduplicate captures and row commits, preserve original receipts and durable discovery', async () => {
  const b = batch(12);
  const captures = await Promise.all(Array.from({ length: 10 }, () => ledger.captureBatch(actor, b)));
  assert.equal(captures.filter(row => !row.alreadyCaptured).length, 1);
  await assert.rejects(ledger.executeBatchItem(actor, ref(b), b.items[0].id), { code: 'BATCH_PAUSED' });
  await ledger.controlBatch(actor, { ...ref(b), state: 'active', expectedVersion: '0' });
  await Promise.all(Array.from({ length: 10 }, () => runner().run(ref(b))));
  const progress = await ledger.getBatch(actor, ref(b)); assert.equal(progress.completedCount, 12); assert.equal(progress.pendingCount, 0);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM member_profiles')).rows[0].n), 12);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM application_task_receipts')).rows[0].n), 12);
  assert.equal((await ledger.listBatches(actor, { ledgerEpoch: scope.ledgerEpoch })).items[0].batchId, b.id);
  const receipt = await ledger.getTask(actor, b.items[0].id, scope);
  await ledger.executeTask(actor, { ...scope, id: randomUUID(), type: 'member.update', memberId: receipt.result.id, data: { name: 'later', expectedVersion: '0' } });
  assert.deepEqual(await ledger.executeBatchItem(actor, ref(b), b.items[0].id), receipt.result);
  const changed = structuredClone(b); changed.items[0].data.name = 'changed'; await assert.rejects(ledger.captureBatch(actor, changed), { code: 'BATCH_CONFLICT' });
});

test('pause/resume and terminal cancel serialize with row execution and fence delayed direct requests', async () => {
  const b = batch(); await active(b); const first = await ledger.executeBatchItem(actor, ref(b), b.items[0].id);
  const paused = await ledger.controlBatch(actor, { ...ref(b), state: 'paused', expectedVersion: '1' });
  assert.deepEqual(await ledger.controlBatch(actor, { ...ref(b), state: 'paused', expectedVersion: '1' }), paused);
  await assert.rejects(ledger.executeTask(actor, { ...scope, ...b.items[1] }), { code: 'BATCH_PAUSED' });
  await ledger.controlBatch(actor, { ...ref(b), state: 'active', expectedVersion: '2' });
  if (database.engine.startsWith('PostgreSQL')) {
    const blocker = await pool.connect(); let pending;
    try {
      await blocker.query('BEGIN'); await taskLock(blocker, scope.storeId, b.items[1].id);
      pending = ledger.executeBatchItem(actor, ref(b), b.items[1].id);
      // execute may already be waiting for the task lock or arrive later. Both
      // must observe the cancellation after acquiring the shared batch lock.
      await ledger.controlBatch(actor, { ...ref(b), state: 'cancelled', expectedVersion: '3' });
      await blocker.query('COMMIT');
      await assert.rejects(pending, { code: 'BATCH_CANCELLED' });
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending.catch(() => {}); }
  } else {
    console.log('cancellation lock race requires real PostgreSQL; local check covers delayed arrival only');
    await ledger.controlBatch(actor, { ...ref(b), state: 'cancelled', expectedVersion: '3' });
  }
  await assert.rejects(ledger.executeTask(actor, { ...scope, ...b.items[1] }), { code: 'BATCH_CANCELLED' });
  assert.deepEqual(await ledger.executeBatchItem(actor, ref(b), b.items[0].id), first);
  assert.equal((await ledger.getBatch(actor, ref(b))).cancelledCount, 3);
  await assert.rejects(ledger.controlBatch(actor, { ...ref(b), state: 'active', expectedVersion: '4' }), { code: 'BATCH_CANCELLED' });
});

test('SQL, audit and commit failures roll back capture or one row without consuming task identities', async () => {
  const b = batch();
  function faulty(match) {
    const wrapped = { query: (...args) => pool.query(...args), async connect() {
      const client = await pool.connect(); return { release: () => client.release(), query(sql, params) { if (sql.includes(match)) throw new Error('injected batch fault'); return client.query(sql, params); } };
    } };
    return createService(wrapped).relational;
  }
  for (const marker of ['INSERT INTO application_batch_tags', 'INSERT INTO audit_events', 'COMMIT']) {
    await assert.rejects(faulty(marker).captureBatch(actor, b), /injected/);
    assert.equal((await ledger.listBatches(actor, { ledgerEpoch: scope.ledgerEpoch })).items.length, 0);
  }
  await active(b);
  for (const marker of ['INSERT INTO application_task_receipts', 'INSERT INTO audit_events', 'COMMIT']) {
    await assert.rejects(faulty(marker).executeBatchItem(actor, ref(b), b.items[0].id), /injected/);
    assert.equal((await ledger.getBatch(actor, ref(b))).completedCount, 0); assert.equal((await ledger.listMembers(actor)).items.length, 0);
  }
  await ledger.executeBatchItem(actor, ref(b), b.items[0].id);
});

test('batch HTTP routes bind exact scope, paginate progress and preserve task versions through partial failure', async () => {
  const b = batch(3), headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const post = async (path, body) => fetch(origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post('/api/v2/batches', b)).status, 200);
  assert.equal((await post('/api/v2/batches/' + b.id + '/items/' + b.items[0].id, ref(b))).status, 409);
  assert.equal((await post('/api/v2/batches/' + b.id + '/control', { ...ref(b), state: 'active', expectedVersion: '0' })).status, 200);
  assert.equal((await post('/api/v2/batches/' + b.id + '/items/' + b.items[0].id, ref(b))).status, 200);
  const query = new URLSearchParams({ ...ref(b), limit: '1' });
  const response = await fetch(origin + '/api/v2/batches/' + b.id + '?' + query, { headers }); const p = await response.json();
  assert.equal(response.status, 200); assert.equal(p.items.length, 1); assert.equal(p.completedCount, 1); assert.equal(p.nextAfter, 0);
  const itemResponse = await fetch(origin + '/api/v2/batches/' + b.id + '/items/' + b.items[1].id + '?' + new URLSearchParams(ref(b)), { headers });
  assert.equal(itemResponse.status, 200); assert.deepEqual(await itemResponse.json(), { ...scope, ...b.items[1] });
  assert.equal((await post('/api/v2/batches/' + b.id + '/control', { ...ref(b), id: randomUUID(), state: 'cancelled', expectedVersion: '1' })).status, 400);
  await assert.rejects(ledger.getBatch(actor, { ...ref(b), deviceId: randomUUID() }), { code: 'BATCH_CONTEXT_CHANGED' });
  await assert.rejects(ledger.captureBatch(actor, { ...b, id: randomUUID() }), { code: 'BATCH_TASK_CONFLICT' });
  await assert.rejects(ledger.executeTask(actor, { ...scope, ...b.items[1], data: { name: 'new capture' } }), { code: 'TASK_CONFLICT' });
  await pool.query('UPDATE stores SET ledger_epoch=$1 WHERE id=$2', [randomUUID(), scope.storeId]);
  await assert.rejects(ledger.executeBatchItem(actor, ref(b), b.items[1].id), { code: 'LEDGER_EPOCH_MISMATCH' });
});

test('batch SQL schema matches the shared typed column contract', async () => {
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  for (const sql of batchSchema('postgres')) assert.ok(schema.includes(sql + ';'), 'shared batch DDL missing from schema.sql');
});

test('cloud backup preserves typed batch captures, controls and audit and rejects recomputed files with changed request hashes', async () => {
  const b = batch(); await active(b); await ledger.executeBatchItem(actor, ref(b), b.items[0].id);
  await ledger.controlBatch(actor, { ...ref(b), state: 'cancelled', expectedVersion: '1' });
  const backup = await ledger.exportBackup(actor); assert.equal(backup.tables.application_batch_items.length, 4);
  const changed = structuredClone(backup); changed.tables.application_batch_items[1].name = 'tampered';
  const { digest: _, ...payload } = changed; changed.digest = digest(canonicalJSON(payload));
  const request = file => ({ id: randomUUID(), ledgerEpoch: scope.ledgerEpoch, reviewedDigest: file.digest, backup: file });
  await assert.rejects(ledger.previewBackupRestore(actor, request(changed)), /摘要/);
  const invalidProfile = structuredClone(backup); invalidProfile.tables.member_profiles[0].phone = null;
  const { digest: _priorDigest, ...invalidPayload } = invalidProfile; invalidProfile.digest = digest(canonicalJSON(invalidPayload));
  await assert.rejects(ledger.previewBackupRestore(actor, request(invalidProfile)));
  // Isolate only this synthetic store's business data in its disposable schema;
  // retain current auth/licence and restore the same-store full backup.
  await pool.query('TRUNCATE member_profiles,account_opening_batches,ledger_entries,ledger_command_receipts,application_task_receipts,store_change_heads,store_changes,audit_events,ledger_restore_receipts,application_batches CASCADE');
  await pool.query('DELETE FROM service_catalog; DELETE FROM recharge_plan_items; DELETE FROM store_recharge_settings;');
  const result = await ledger.restoreBackup(actor, request(backup)); assert.notEqual(result.ledgerEpoch, scope.ledgerEpoch);
  const again = await ledger.exportBackup(actor); assert.deepEqual(again.tables.application_batch_items, backup.tables.application_batch_items);
  await assert.rejects(ledger.executeBatchItem(actor, { ...ref(b), ledgerEpoch: result.ledgerEpoch }, b.items[1].id), { code: 'LEDGER_EPOCH_MISMATCH' });
});
