import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { nextTick } from 'vue';
import { relationalTestDatabase } from './helpers/relational-database.js';
import { createService } from './helpers/licensed-service.js';
import { createApi } from '../http.js';
import { createNativeWorkspace } from '../../src/relational-native-workspace.js';
import { createRelationalNativeSession } from '../../src/relational-native-session.js';
import { memoryStorage, nativeCredentials, nativeFile } from '../../tests/helpers/native-fixture.mjs';

const password = 'Replica-Validation-2026!', username = 'replica-owner', memberId = 'opening-member';
const digest = content => createHash('sha256').update(content).digest('hex');
async function fixture(t) {
  let native;
  t.after(() => native?.workspace.dispose());
  const db = await relationalTestDatabase(), service = createService(db.pool);
  t.after(() => db.close());
  const { storeId } = await service.createOwner({ username, password });
  const owner = await service.authenticate((await service.login({ username, password, deviceId: randomUUID() })).accessToken);
  const ledger = service.relational, { ledgerEpoch } = await ledger.getBook(owner);
  await ledger.importOpeningBalances(owner, { ledgerEpoch, batchId: randomUUID(), sourceDigest: 'a'.repeat(64), expectedCount: 1,
    members: [{ id: memberId, name: '样本会员', phone: '0123', balanceCents: '1000' }] });
  await service.createUser(owner, { username: 'replica-clerk', password, role: 'clerk', displayName: '合成店员' });
  const api = createApi({ service, pool: db.pool, rateLimits: true });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(async () => { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); });
  const origin = 'http://127.0.0.1:' + api.address().port, deviceId = randomUUID(), file = await nativeFile(t);
  const device = nativeCredentials(deviceId), storage = memoryStorage();
  let online = true, transformSnapshot;
  const writes = [];
  async function open(logIn) {
    if (native) await native.workspace.dispose();
    const session = createRelationalNativeSession({ device, isOnline: () => online, fetch: async (url, options) => {
      if (!online) throw new Error('offline');
      const path = new URL(url).pathname;
      if (path === '/api/v2/commands') writes.push(JSON.parse(options.body).id);
      const response = await fetch(url, options);
      if (path === '/api/v2/sync/snapshot' && transformSnapshot && response.ok) return transformSnapshot(response);
      return response;
    } });
    const workspace = createNativeWorkspace(session, { storage, openDriver: file.open });
    native = { session, workspace };
    if (logIn) await session.login(origin, logIn, password);
    else { await session.init(); if (online) await session.heartbeat(); }
    await nextTick(); await workspace.connect(); await workspace.sync(); return native;
  }
  const clerk = await service.authenticate((await service.login({ username: 'replica-clerk', password, deviceId: randomUUID() })).accessToken);
  return { db, storeId, owner, clerk, ledgerEpoch, ledger, open, storage, file, writes,
    online: value => { online = value; }, snapshot: transform => { transformSnapshot = transform; },
    setEpoch: epoch => db.pool.query('UPDATE stores SET ledger_epoch=$1 WHERE id=$2', [epoch, storeId]),
    trade: (fields, epoch = ledgerEpoch) => ledger.executeCommand(owner, { id: randomUUID(), storeId, memberId, ledgerEpoch: epoch, ...fields }) };
}

test('owner rebuilds an expired incremental cursor from a complete confirmed snapshot; truncation preserves the old book', async t => {
  const f = await fixture(t), { workspace } = await f.open(username);
  const oldState = await workspace.repository.syncState();
  const sale = await f.trade({ type: 'consume', expectedAccountVersion: '0', amountCents: '120' });
  const undo = await f.trade({ type: 'reverse', expectedAccountVersion: '1', originalEntryId: sale.commandId, reason: '合成冲正' });
  await f.db.pool.query('DELETE FROM store_changes WHERE store_id=$1 AND cursor=2', [f.storeId]);
  await workspace.sync(); assert.equal(workspace.state.syncError, 'CURSOR_HISTORY_INCOMPLETE');
  await assert.rejects(f.ledger.exportReplica(f.clerk, { ledgerEpoch: f.ledgerEpoch, write: () => assert.fail('clerk must never receive data') }), { code: 'FORBIDDEN' });
  await workspace.prepareRebuild(); f.snapshot(async response => {
    const text = await response.text();
    return new Response(text.split('\n').slice(0, -2).join('\n') + '\n', { headers: response.headers });
  });
  await assert.rejects(workspace.rebuildReplica(f.ledgerEpoch), { code: 'ARCHIVE_TRUNCATED' });
  assert.deepEqual(await workspace.repository.syncState(), oldState);
  assert.deepEqual((await workspace.read('listLedger', {})).items, []);
  assert.equal(workspace.state.blockedEpoch, true);
  let further;
  f.snapshot(response => afterSnapshot(response, async () => {
    further = await f.trade({ type: 'recharge', expectedAccountVersion: '2', actualPayCents: '99' });
  }));
  const result = await workspace.rebuildReplica(f.ledgerEpoch);
  assert.deepEqual([result.memberCount, result.entryCount, result.cursor], [1, 2, undo.cursor]);
  assert.equal(workspace.state.blockedEpoch, false);
  assert.equal((await workspace.read('getMember', memberId)).accountVersion, '2');
  assert.equal((await workspace.read('listLedger', {})).items.find(entry => entry.id === sale.commandId).reversalEntryId, undo.commandId);
  await workspace.sync(); assert.equal((await workspace.repository.syncState()).cursor, further.cursor);
  assert.equal((await workspace.read('getMember', memberId)).balanceCents, '1099');
});

test('cross-generation rebuild never sends old money; only a verified original document and explicit disposition release its fence', async t => {
  const f = await fixture(t); let { session, workspace } = await f.open(username);
  f.online(false); await session.heartbeat();
  const old = await workspace.submit('command', { type: 'consume', memberId, expectedAccountVersion: '0', amountCents: '250' }, workspace.getScope());
  assert.equal(old.balanceAfterCents, '750');
  const nextEpoch = randomUUID();
  await f.setEpoch(nextEpoch);
  f.online(true); await session.heartbeat(); await workspace.sync();
  assert.equal(workspace.state.syncError, 'LEDGER_EPOCH_MISMATCH');
  const originalTask = { ...workspace.getScope(), id: randomUUID(), type: 'member.create', data: { name: '原待办任务' } };
  const originalKey = 'hairstudio_v2_pending:' + [f.storeId, originalTask.actorId, originalTask.deviceId].join(':');
  const raw = JSON.stringify({ kind: 'task', input: originalTask }); f.storage.setItem(originalKey, raw);
  await assert.rejects(workspace.rebuildReplica(nextEpoch), { code: 'PENDING_IN_PROGRESS' });
  await assert.rejects(workspace.archiveObsolete(randomUUID(), nextEpoch, () => assert.fail('different original ID')), { code: 'PENDING_IN_PROGRESS' });
  await assert.rejects(workspace.archiveObsolete(originalTask.id, nextEpoch, () => ({ status: 'saved-verified', sha256: '0'.repeat(64) })), { code: 'REPLICA_REVIEW_MISMATCH' });
  assert.equal(f.storage.getItem(originalKey), raw);
  const archive = await workspace.archiveObsolete(originalTask.id, nextEpoch, ({ content }) => {
    assert.deepEqual(JSON.parse(content).input, originalTask); return { status: 'saved-verified', sha256: digest(content) };
  });
  assert.deepEqual(archive, { reviewed: true }); assert.equal(f.storage.getItem(originalKey), null);
  await assert.rejects(workspace.rebuildReplica(nextEpoch), { code: 'REPLICA_PENDING_REVIEW' });
  const badDocument = { save: async () => ({ status: 'saved-verified', sha256: '0'.repeat(64) }) };
  await assert.rejects(workspace.savePendingReview(old.commandId, 'manual', nextEpoch, badDocument), { code: 'REPLICA_REVIEW_MISMATCH' });
  const saved = [];
  const documents = { async save({ content }) { saved.push(JSON.parse(content)); return { status: 'saved-verified', sha256: digest(content) }; } };
  assert.deepEqual(await workspace.savePendingReview(old.commandId, 'manual', nextEpoch, documents), { reviewed: true });
  assert.deepEqual([saved[0].command.id, saved[0].command.ledgerEpoch, saved[0].receipt.balanceAfterCents, saved[0].targetEpoch], [old.commandId, f.ledgerEpoch, '750', nextEpoch]);
  assert.equal((await workspace.repository.syncState()).pendingCount, 1);
  ({ session, workspace } = await f.open());
  assert.equal(workspace.state.blockedEpoch, true);
  const result = await workspace.rebuildReplica(nextEpoch); assert.equal(result.ledgerEpoch, nextEpoch);
  const proof = await f.file.open();
  try { assert.throws(() => proof.run('DELETE FROM account_openings'), /immutable/); }
  finally { proof.close(); }
  assert.equal((await workspace.repository.syncState()).pendingCount, 0);
  ({ workspace } = await f.open());
  assert.equal(workspace.getScope().ledgerEpoch, nextEpoch);
  assert.equal((await workspace.read('getMember', memberId)).balanceCents, '1000');
  assert.deepEqual(f.writes, []);
  assert.deepEqual((await f.ledger.listLedger(f.owner)).items, []);
});

function afterSnapshot(response, action) {
  return new Response(response.body.pipeThrough(new TransformStream({ flush: action })), { headers: response.headers });
}

test('cancellation and a failed SQLite commit preserve the existing replica, cursor and write fence', async t => {
  const f = await fixture(t); let { workspace } = await f.open(username);
  const first = await f.trade({ type: 'consume', expectedAccountVersion: '0', amountCents: '120' });
  await workspace.sync();
  const old = await workspace.repository.syncState();
  const later = await f.trade({ type: 'recharge', expectedAccountVersion: '1', actualPayCents: '50' });
  await f.db.pool.query('DELETE FROM store_changes WHERE store_id=$1 AND cursor=$2', [f.storeId, later.cursor]);
  await workspace.sync(); assert.equal(workspace.state.syncError, 'CURSOR_HISTORY_INCOMPLETE');
  async function unchanged() {
    assert.deepEqual(await workspace.repository.syncState(), old);
    assert.equal(workspace.state.blockedEpoch, true);
    assert.equal((await workspace.read('getMember', memberId)).balanceCents, '880');
    assert.deepEqual((await workspace.read('listLedger', {})).items.map(entry => entry.id), [first.entryId]);
  }
  f.snapshot(response => afterSnapshot(response, () => workspace.cancelRebuild()));
  await assert.rejects(workspace.rebuildReplica(f.ledgerEpoch), { code: 'REQUEST_ABORTED' });
  await unchanged();
  f.snapshot(response => afterSnapshot(response, () => f.file.failCommit('before')));
  await assert.rejects(workspace.rebuildReplica(f.ledgerEpoch), error => error.network && /commit response unavailable/.test(error.cause?.message));
  ({ workspace } = await f.open()); await unchanged();
  f.snapshot(null);
  await workspace.rebuildReplica(f.ledgerEpoch);
  assert.equal((await workspace.read('getMember', memberId)).balanceCents, '930');
  assert.equal((await workspace.repository.syncState()).cursor, later.cursor);
  assert.equal(workspace.state.blockedEpoch, false);
});

test('a second cloud generation after the snapshot has streamed discards the replacement and retains original evidence', async t => {
  const f = await fixture(t); let { session, workspace } = await f.open(username);
  f.online(false); await session.heartbeat();
  const original = await workspace.submit('command', { type: 'consume', memberId, expectedAccountVersion: '0', amountCents: '40' }, workspace.getScope());
  const oldState = await workspace.repository.syncState(), plannedEpoch = randomUUID(), latestEpoch = randomUUID();
  await f.setEpoch(plannedEpoch);
  f.online(true); await session.heartbeat(); await workspace.sync();
  const target = await workspace.prepareRebuild(); assert.equal(target.ledgerEpoch, plannedEpoch);
  const documents = { save: ({ content }) => ({ status: 'saved-verified', sha256: digest(content) }) };
  await workspace.savePendingReview(original.commandId, 'manual', plannedEpoch, documents);
  f.snapshot(response => afterSnapshot(response, () => f.setEpoch(latestEpoch)));
  await assert.rejects(workspace.rebuildReplica(plannedEpoch), { code: 'LEDGER_EPOCH_MISMATCH' });
  assert.equal(workspace.state.rebuildTarget, null);
  assert.deepEqual(await workspace.repository.syncState(), oldState);
  assert.equal((await workspace.pendingDetails(original.commandId)).command.id, original.commandId);
  assert.deepEqual(f.writes, []);
  f.snapshot(null);
  assert.equal((await workspace.prepareRebuild()).ledgerEpoch, latestEpoch);
  await assert.rejects(workspace.rebuildReplica(latestEpoch), { code: 'REPLICA_PENDING_REVIEW' });
});

test('a missing same-generation receipt or a cursor ahead of cloud cannot authorize discarding a pending command', async t => {
  const f = await fixture(t), { session, workspace } = await f.open(username);
  f.online(false); await session.heartbeat();
  const original = await workspace.submit('command', { type: 'consume', memberId, expectedAccountVersion: '0', amountCents: '125' }, workspace.getScope());
  await f.trade({ type: 'recharge', expectedAccountVersion: '0', actualPayCents: '50' });
  f.online(true); await session.heartbeat(); await workspace.sync();
  assert.equal(workspace.state.syncStatus, 'conflict');
  assert.deepEqual(await workspace.inspectOriginal(original.commandId), { status: 'not-found', commandId: original.commandId });
  await f.db.pool.query('UPDATE store_change_heads SET head=0 WHERE store_id=$1', [f.storeId]);
  const before = await workspace.repository.syncState();
  await workspace.sync(); assert.equal(workspace.state.syncError, 'CURSOR_AHEAD');
  await workspace.prepareRebuild();
  await assert.rejects(workspace.rebuildReplica(f.ledgerEpoch), { code: 'REPLICA_REBUILD_BLOCKED' });
  assert.deepEqual(await workspace.repository.syncState(), before);
  assert.deepEqual(f.writes, [original.commandId]);
});
