import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createService } from './helpers/licensed-service.js';
import { relationalTestDatabase } from './helpers/relational-database.js';
import { openNodeSqlite } from '../../tools/sqlite-node-driver.mjs';
import { createRelationalSqlite } from '../../src/relational-sqlite.js';
import { createRelationalSync } from '../../src/relational-sync.js';
import { LICENSE_FEATURES } from '../../src/license-policy.js';

let database, service;
const password = 'Relational-Sync-2026!';
before(async () => { database = await relationalTestDatabase(); service = createService(database.pool); });
after(async () => { await database?.close(); });
async function setup(t) {
  await database.pool.query('TRUNCATE stores,login_limits RESTART IDENTITY CASCADE');
  const { storeId } = await service.createOwner({ username: 'sync-owner', password });

  const deviceId = randomUUID(), session = await service.login({ username: 'sync-owner', password, deviceId }, '127.0.0.1');
  const identity = await service.authenticate(session.accessToken), ledger = service.relational;
  const { ledgerEpoch } = await ledger.getBook(identity);
  await ledger.importOpeningBalances(identity, { ledgerEpoch, batchId: 'sync-opening-20261119', sourceDigest: 'd'.repeat(64), expectedCount: 91,
    members: Array.from({ length: 91 }, (_, index) => ({ id: 'member-' + index, name: '合成会员' + index, balanceCents: index === 0 ? '-100' : '1000' })) });
  const directory = await mkdtemp(join(tmpdir(), 'member-sync-')), path = join(directory, 'ledger.sqlite');
  let repository, localActorId = identity.id, localTime = '2000-01-01T01:00:00.000Z';
  async function open() { repository = createRelationalSqlite({ driver: openNodeSqlite(path), storeId, mode: 'cloud', ledgerEpoch, now: () => localTime, authorize: async () => ({ storeId, id: localActorId, deviceId, role: 'owner', features: LICENSE_FEATURES }) }); await repository.init(); return repository; }
  await open();
  t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const remote = { getBook: () => ledger.getBook(identity), executeCommand: command => ledger.executeCommand(identity, command), changes: options => ledger.changes(identity, options) };
  return { get repository() { return repository; }, remote, ledger, identity, storeId, ledgerEpoch, asActor(id) { localActorId = id; }, at(value) { localTime = value; }, async reopen() { await repository.close(); return open(); } };
}

test('PostgreSQL-compatible service → real SQLite → durable command → service → incrementals', async t => {
  const f = await setup(t); const sync = createRelationalSync({ repository: f.repository, remote: f.remote });
  assert.equal((await sync.sync()).status, 'confirmed');
  assert.equal((await f.repository.getMember('member-0')).balanceCents, '-100');
  const result = await f.repository.executeCommand({ id: randomUUID(), ledgerEpoch: f.ledgerEpoch, type: 'consume', memberId: 'member-1', expectedAccountVersion: '0', amountCents: '100' });
  assert.equal(result.balanceAfterCents, '900'); assert.equal((await sync.sync()).status, 'confirmed');
  assert.equal((await f.ledger.getMember(f.identity, 'member-1')).balanceCents, '900');
  assert.equal((await f.repository.pendingCommands()).length, 0);
  await f.reopen(); assert.equal((await f.repository.getMember('member-1')).balanceCents, '900');
  assert.equal((await f.repository.listLedger()).items[0].confirmedAt !== null, true);
});

test('committed server command with lost response survives SQLite restart and repeats only the original ID', async t => {
  const f = await setup(t); await createRelationalSync({ repository: f.repository, remote: f.remote }).sync();
  const command = { id: randomUUID(), ledgerEpoch: f.ledgerEpoch, type: 'recharge', memberId: 'member-1', expectedAccountVersion: '0', actualPayCents: '100' };
  await f.repository.executeCommand(command); let drop = true;
  const remote = { ...f.remote, async executeCommand(input) { const result = await f.remote.executeCommand(input); if (drop) { drop = false; throw new Error('response lost'); } return result; } };
  assert.equal((await createRelationalSync({ repository: f.repository, remote }).sync()).status, 'pending');
  assert.equal((await f.repository.pendingCommands())[0].command.id, command.id);
  await f.reopen(); assert.equal((await createRelationalSync({ repository: f.repository, remote }).sync()).status, 'confirmed');
  assert.equal((await f.ledger.getMember(f.identity, 'member-1')).balanceCents, '1100');
  assert.equal(Number((await database.pool.query('SELECT count(*) AS n FROM ledger_entries')).rows[0].n), 1);
});

test('offline reversal reactivates an archived member, then confirms and synchronizes the original id', async t => {
  const f = await setup(t), book = await f.ledger.getBook(f.identity), task = () => ({ ...book, id: randomUUID() });
  const member = await f.ledger.createMember(f.identity, { name: '原档案', phone: '01234' }, task());
  await f.remote.executeCommand({ ...book, id: randomUUID(), type: 'recharge', memberId: member.id, expectedAccountVersion: '0', actualPayCents: '100' });
  const spend = await f.remote.executeCommand({ ...book, id: randomUUID(), type: 'consume', memberId: member.id, expectedAccountVersion: '1', amountCents: '100' });
  await f.ledger.archiveMember(f.identity, member.id, task());
  const sync = () => createRelationalSync({ repository: f.repository, remote: f.remote }).sync();
  assert.equal((await sync()).status, 'confirmed');
  assert.ok((await f.repository.getMember(member.id)).archivedAt);
  const undo = { ...book, id: randomUUID(), type: 'reverse', memberId: member.id, originalEntryId: spend.entryId, expectedAccountVersion: '2' };
  assert.equal((await f.repository.executeCommand(undo)).balanceAfterCents, '100');
  assert.equal((await f.repository.getMember(member.id)).archivedAt, null);
  await f.reopen();
  assert.equal((await f.repository.pendingCommands())[0].command.id, undo.id);
  assert.equal((await sync()).status, 'confirmed');
  assert.equal((await f.repository.pendingCommands()).length, 0);
  const remote = await f.ledger.getMember(f.identity, member.id);
  assert.deepEqual(await f.repository.getMember(member.id), remote);
  assert.equal(remote.archivedAt, null);
  assert.equal(remote.version, '2');
});

test('remote account change retains the offline command and balance as a conflict instead of reapplying it', async t => {
  const f = await setup(t), sync = createRelationalSync({ repository: f.repository, remote: f.remote }); await sync.sync();
  const local = { id: randomUUID(), ledgerEpoch: f.ledgerEpoch, type: 'consume', memberId: 'member-1', expectedAccountVersion: '0', amountCents: '100' };
  await f.repository.executeCommand(local);
  await f.ledger.executeCommand(f.identity, { id: randomUUID(), ledgerEpoch: f.ledgerEpoch, storeId: f.storeId, type: 'recharge', memberId: 'member-1', expectedAccountVersion: '0', actualPayCents: '100' });
  const state = await sync.sync(); assert.equal(state.status, 'conflict'); assert.equal(state.errorCode, 'ACCOUNT_VERSION_CHANGED');
  assert.equal((await f.repository.getMember('member-1')).balanceCents, '900'); assert.equal((await f.ledger.getMember(f.identity, 'member-1')).balanceCents, '1100');
  assert.equal((await f.repository.pendingCommands())[0].command.id, local.id);
  assert.equal((await sync.sync()).status, 'conflict');
});

test('identity change blocks the outbox before issuing a server request', async t => {
  const f = await setup(t); await createRelationalSync({ repository: f.repository, remote: f.remote }).sync();
  await f.repository.executeCommand({ id: randomUUID(), ledgerEpoch: f.ledgerEpoch, type: 'consume', memberId: 'member-1', expectedAccountVersion: '0', amountCents: '100' });
  f.asActor(randomUUID()); let calls = 0;
  const result = await createRelationalSync({ repository: f.repository, remote: { ...f.remote, executeCommand() { calls++; throw new Error('must not send'); } } }).sync();
  assert.equal(result.status, 'blocked'); assert.equal(result.errorCode, 'PENDING_ACTOR_CHANGED'); assert.equal(calls, 0);
  assert.equal((await f.repository.pendingCommands()).length, 1);
});
test('server recovery fences offline work before sending; source commands, balances and cursor remain intact', async t => {
  const f = await setup(t); await createRelationalSync({ repository: f.repository, remote: f.remote }).sync();
  const input = { id: randomUUID(), ledgerEpoch: f.ledgerEpoch, type: 'consume', memberId: 'member-1', expectedAccountVersion: '0', amountCents: '100' };
  await f.repository.executeCommand(input); const pending = await f.repository.pendingCommands(), before = await f.repository.syncState();
  await database.pool.query('UPDATE stores SET ledger_epoch=$1 WHERE id=$2', [randomUUID(), f.storeId]);
  await f.reopen(); let sends = 0, pulls = 0;
  const remote = { ...f.remote, executeCommand() { sends++; throw new Error('must not send'); }, changes() { pulls++; throw new Error('must not pull'); } };
  const result = await createRelationalSync({ repository: f.repository, remote }).sync();
  assert.equal(result.status, 'blocked'); assert.equal(result.errorCode, 'LEDGER_EPOCH_MISMATCH'); assert.equal(sends, 0); assert.equal(pulls, 0);
  assert.deepEqual(await f.repository.pendingCommands(), pending); assert.deepEqual(await f.repository.syncState(), before);
  assert.equal((await f.repository.getMember('member-1')).balanceCents, '900'); assert.equal((await f.ledger.getMember(f.identity, 'member-1')).balanceCents, '1000');
});
test('recovery racing the sync preflight is rejected inside the server write without changing the queued request', async t => {
  const f = await setup(t); await createRelationalSync({ repository: f.repository, remote: f.remote }).sync();
  await f.repository.executeCommand({ id: randomUUID(), ledgerEpoch: f.ledgerEpoch, type: 'consume', memberId: 'member-1', expectedAccountVersion: '0', amountCents: '100' });
  const original = await f.repository.pendingCommands(); let sends = 0;
  const remote = { ...f.remote, async executeCommand(input) { sends++; await database.pool.query('UPDATE stores SET ledger_epoch=$1 WHERE id=$2', [randomUUID(), f.storeId]); return f.remote.executeCommand(input); } };
  const result = await createRelationalSync({ repository: f.repository, remote }).sync();
  assert.equal(sends, 1); assert.equal(result.status, 'blocked'); assert.equal(result.errorCode, 'LEDGER_EPOCH_MISMATCH');
  assert.deepEqual(await f.repository.pendingCommands(), original); assert.equal((await f.ledger.getMember(f.identity, 'member-1')).balanceCents, '1000');
});
test('recovery racing an incremental read leaves the local generation and cursor unchanged', async t => {
  const f = await setup(t), before = await f.repository.syncState();
  const remote = { ...f.remote, async changes(input) { await database.pool.query('UPDATE stores SET ledger_epoch=$1 WHERE id=$2', [randomUUID(), f.storeId]); return f.remote.changes(input); } };
  const result = await createRelationalSync({ repository: f.repository, remote }).sync();
  assert.equal(result.status, 'blocked'); assert.equal(result.errorCode, 'LEDGER_EPOCH_MISMATCH'); assert.deepEqual(await f.repository.syncState(), before); assert.equal((await f.repository.listMembers()).items.length, 0);
});
test('configured split payments and service rows round-trip through typed outbox after restart', async t => {
  const f = await setup(t);
  await f.ledger.updateConfiguration(f.identity, { expectedVersion: '0', services: [{ id: 'cut', name: '剪发', priceCents: '101' }], rechargePlans: [{ id: 'plan', payCents: '1000', giftCents: '100' }], rechargeSettings: { giftEnabled: true, giftRateBasisPoints: 1000 } }, { id: randomUUID(), ledgerEpoch: f.ledgerEpoch, storeId: f.identity.store_id });
  await createRelationalSync({ repository: f.repository, remote: f.remote }).sync();
  assert.equal((await f.repository.getConfiguration()).version, '1');
  const request = { id: randomUUID(), ledgerEpoch: f.ledgerEpoch, type: 'recharge', memberId: 'member-1', expectedAccountVersion: '0', actualPayCents: '1000', giftCents: '100', planId: 'plan', configurationVersion: '1', payments: [{ method: ' 现金 ', amountCents: '900' }, { method: '微信', amountCents: '100' }] };
  await f.repository.executeCommand(request);
  const consumption = { id: randomUUID(), ledgerEpoch: f.ledgerEpoch, type: 'consume', memberId: 'member-1', expectedAccountVersion: '1', amountCents: '202', configurationVersion: '1', items: [{ serviceId: 'cut', name: ' 剪发 ', quantity: 2, unitPriceCents: '101' }] };
  await f.repository.executeCommand(consumption); const before = await f.repository.pendingCommands(); await f.reopen();
  assert.deepEqual(await f.repository.pendingCommands(), before); assert.equal(before.length, 2);
  assert.equal((await createRelationalSync({ repository: f.repository, remote: f.remote }).sync()).status, 'confirmed');
  const serverEntries = (await f.ledger.listLedger(f.identity)).items, localEntries = (await f.repository.listLedger()).items;
  for (const server of serverEntries) { const local = localEntries.find(row => row.id === server.id); for (const field of ['items', 'payments', 'recharge', 'payMethod', 'itemsSummary', 'remark']) assert.deepEqual(local[field], server[field]); }
  assert.equal((await f.repository.pendingCommands()).length, 0);
  const period = { from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 86400000).toISOString(), offsetMinutes: -480 };
  const { localState, ...business } = await f.repository.reportBusiness(period); assert.deepEqual(business, await f.ledger.reportBusiness(f.identity, period)); assert.equal(localState.pendingCount, 0);
  await f.ledger.executeCommand(f.identity, { id: randomUUID(), ledgerEpoch: f.ledgerEpoch, storeId: f.storeId, type: 'reverse', memberId: 'member-1', expectedAccountVersion: '2', originalEntryId: consumption.id });
  await createRelationalSync({ repository: f.repository, remote: f.remote }).sync();
  const { localState: _, ...reversed } = await f.repository.reportBusiness(period); assert.deepEqual(reversed, await f.ledger.reportBusiness(f.identity, period)); assert.equal(reversed.ranking.length, 0);
});
test('configuration changes keep offline originals as a conflict and never reinterpret captured prices', async t => {
  const f = await setup(t); await createRelationalSync({ repository: f.repository, remote: f.remote }).sync();
  const request = { id: randomUUID(), ledgerEpoch: f.ledgerEpoch, type: 'recharge', memberId: 'member-1', expectedAccountVersion: '0', actualPayCents: '100' };
  await f.repository.executeCommand(request);
  await f.ledger.updateConfiguration(f.identity, { expectedVersion: '0', services: [], rechargePlans: [], rechargeSettings: { giftEnabled: true, giftRateBasisPoints: 2000 } }, { id: randomUUID(), ledgerEpoch: f.ledgerEpoch, storeId: f.identity.store_id });
  const result = await createRelationalSync({ repository: f.repository, remote: f.remote }).sync();
  assert.equal(result.status, 'conflict'); assert.equal(result.errorCode, 'CONFIGURATION_VERSION_CHANGED');
  assert.equal((await f.repository.pendingCommands())[0].command.id, request.id);
  assert.equal((await f.repository.getMember('member-1')).balanceCents, '1100'); assert.equal((await f.ledger.getMember(f.identity, 'member-1')).balanceCents, '1000');
});

test('replica reports identify pending/conflict scope and switch to server confirmation time across dates', async t => {
  const f = await setup(t), sync = createRelationalSync({ repository: f.repository, remote: f.remote }); await sync.sync();
  const localDay = { from: '2000-01-01T00:00:00.000Z', to: '2000-01-02T00:00:00.000Z' }, allTime = { from: '1999-01-01T00:00:00.000Z', to: '9999-01-01T00:00:00.000Z' };
  const command = { id: randomUUID(), ledgerEpoch: f.ledgerEpoch, type: 'recharge', memberId: 'member-1', expectedAccountVersion: '0', actualPayCents: '101', giftCents: '10', payments: [{ method: '现金 ✂️', amountCents: '101' }] };
  await f.repository.executeCommand(command);
  let local = await f.repository.report(localDay); assert.equal(local.entryCount, 1); assert.equal(local.localState.pendingCount, 1); assert.equal(local.localState.mode, 'cloud');
  assert.equal((await f.repository.reportBreakdown({ ...localDay, kind: 'payment' })).items[0].amountCents, '101');
  assert.equal((await sync.sync()).status, 'confirmed');
  local = await f.repository.report(localDay); assert.equal(local.entryCount, 0); assert.equal(local.localState.pendingCount, 0);
  assert.deepEqual((await f.repository.reportBreakdown({ ...localDay, kind: 'payment' })).items, []);
  let { localState, ...localSummary } = await f.repository.report(allTime);
  assert.deepEqual(localSummary, await f.ledger.report(f.identity, allTime)); assert.equal(localState.conflictCount, 0);
  const businessPeriod = { from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 86400000).toISOString(), offsetMinutes: 480 };
  const { localState: initialScope, ...business } = await f.repository.reportBusiness(businessPeriod);
  assert.deepEqual(business, await f.ledger.reportBusiness(f.identity, businessPeriod)); assert.equal(initialScope.pendingCount, 0);
  for (const kind of ['payment', 'service']) { const { localState: _, ...breakdown } = await f.repository.reportBreakdown({ ...allTime, kind }); assert.deepEqual(breakdown, await f.ledger.reportBreakdown(f.identity, { ...allTime, kind })); }
  await f.repository.executeCommand({ id: randomUUID(), ledgerEpoch: f.ledgerEpoch, type: 'consume', memberId: 'member-1', expectedAccountVersion: '1', amountCents: '100' });
  await f.ledger.executeCommand(f.identity, { id: randomUUID(), ledgerEpoch: f.ledgerEpoch, storeId: f.storeId, type: 'consume', memberId: 'member-1', expectedAccountVersion: '1', amountCents: '50' });
  assert.equal((await sync.sync()).status, 'conflict');
  localState = (await f.repository.report(allTime)).localState; assert.equal(localState.pendingCount, 1); assert.equal(localState.conflictCount, 1);
  localState = (await f.repository.reportBusiness(businessPeriod)).localState; assert.equal(localState.pendingCount, 1); assert.equal(localState.conflictCount, 1);
});
