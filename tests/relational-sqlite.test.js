import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openNodeSqlite } from '../tools/sqlite-node-driver.mjs';
import { createRelationalSqlite, sha256 } from '../src/relational-sqlite.js';
import { canonicalJSON } from '../src/canonical-json.js';
import { LICENSE_FEATURES } from '../src/license-policy.js';
import { verifyMemberTotals } from './helpers/member-totals.mjs';

const ledgerEpoch = '00000000-0000-4000-8000-000000000001';
const storeId = 'sqlite-test-store', deviceId = 'sqlite-test-device-2026';
const source = () => ({ ledgerEpoch, batchId: 'sqlite-opening-20261119', sourceDigest: 'a'.repeat(64), expectedCount: 91,
  members: Array.from({ length: 91 }, (_, i) => ({ id: 'member-' + i, name: '合成会员' + i, balanceCents: String((i - 1) * 100), phone: '00100', notes: '', tags: ['测试'] })) });
async function fixture(t, mode = 'standalone') {
  const directory = await mkdtemp(join(tmpdir(), 'member-relational-')), path = join(directory, 'ledger.sqlite');
  let db, driver, fault = null, role = 'owner', actorId = 'local-owner', denied = false, features = LICENSE_FEATURES, at = '2026-11-19T01:00:00.000Z';
  async function open() {
    driver = openNodeSqlite(path); const originalRun = driver.run, originalExec = driver.exec, originalAll = driver.all;
    driver.all = (sql, params) => { const rows = originalAll(sql, params); assert.ok(rows.length <= 1000, 'query exceeds Android bridge 1000-row limit'); return rows; };
    driver.run = (sql, params) => { if (fault && sql.includes(fault)) throw new Error('injected write failure'); return originalRun(sql, params); };
    driver.exec = sql => { if (fault && sql === fault) throw new Error('injected commit failure'); return originalExec(sql); };
    db = createRelationalSqlite({ driver, storeId, mode, ledgerEpoch: mode === 'cloud' || !db ? ledgerEpoch : undefined, now: () => at, authorize: async () => { if (denied) throw new Error('license expired'); return { storeId, id: actorId, deviceId, role, features }; } });
    return db.init();
  }
  const diagnostics = await open();
  t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); });
  return { get db() { return db; }, get driver() { return driver; }, diagnostics,
    fault(value) { fault = value; }, role(value) { role = value; }, actor(value) { actorId = value; }, deny(value) { denied = value; }, features(value) { features = value; }, at(value) { at = value; }, async reopen() { await db.close(); return open(); }, path };
}
async function recharge(db, memberId, extra = {}) { const member = await db.getMember(memberId); return db.executeCommand({ id: randomUUID(), ledgerEpoch: (await db.getBook()).ledgerEpoch, type: 'recharge', memberId, expectedAccountVersion: member.accountVersion, actualPayCents: '1010', giftCents: '101', ...extra }); }
async function restore(f, backup) { return f.db.restoreBackup(backup, { id: randomUUID(), ...await f.db.getBook(), actorId: 'local-owner', deviceId, digest: backup.digest }); }

test('SQLite member totals are complete, reverse-aware and exact beyond signed BIGINT', async t => {
  const f = await fixture(t), book = await f.db.getBook();
  const result = await verifyMemberTotals({
    create: data => f.db.createMember(data, { ...book, id: randomUUID() }),
    async command(memberId, type, data) {
      const member = await f.db.getMember(memberId);
      return f.db.executeCommand({ ...book, id: randomUUID(), memberId, type, expectedAccountVersion: member.accountVersion, ...data });
    },
    totals: id => f.db.getMemberTotals(id),
    history: memberId => f.db.listLedger({ memberId, limit: 15 })
  });
  await assert.rejects(f.db.getMemberTotals('missing-member'), { status: 404 });
  f.features(['core', 'members', 'cashier']);
  assert.deepEqual(await f.db.getMemberTotals(result.member.id), result.expected);
  f.features(['core', 'members']);
  await assert.rejects(f.db.getMemberTotals(result.member.id), { code: 'FEATURE_DISABLED' });
  f.features(['core', 'cashier']);
  await assert.rejects(f.db.getMemberTotals(result.member.id), { code: 'FEATURE_DISABLED' });
});

test('only a standalone owner can inspect a previous actor receipt and another device cannot read it', async t => {
  let other;
  t.after(async () => other?.close());
  const f = await fixture(t), book = await f.db.getBook(), task = { ...book, id: randomUUID() };
  const member = await f.db.createMember({ name: '旧身份合成会员' }, task);
  const original = await recharge(f.db, member.id);
  f.actor('renewed-owner');
  await assert.rejects(f.db.getCommand(original.commandId, book), { code: 'COMMAND_NOT_FOUND' });
  assert.deepEqual(await f.db.getCommand(original.commandId, { ...book, actorId: 'local-owner' }), original);
  assert.equal((await f.db.getTask(task.id, { ...book, actorId: 'local-owner' })).result.id, member.id);
  f.role('clerk');
  await assert.rejects(f.db.getCommand(original.commandId, { ...book, actorId: 'local-owner' }), { status: 403, code: 'FORBIDDEN' });
  await assert.rejects(f.db.getTask(task.id, { ...book, actorId: 'local-owner' }), { status: 403, code: 'FORBIDDEN' });
  other = createRelationalSqlite({ driver: openNodeSqlite(f.path), ...book, mode: 'standalone',
    authorize: () => ({ storeId, id: 'renewed-owner', deviceId: 'another-device-2026', role: 'owner', features: LICENSE_FEATURES }) });
  await other.init();
  await assert.rejects(other.getCommand(original.commandId, { ...book, actorId: 'local-owner' }), { code: 'COMMAND_NOT_FOUND' });
  await assert.rejects(other.getTask(task.id, { ...book, actorId: 'local-owner' }), { code: 'TASK_NOT_FOUND' });
});

test('SQLite archive reversal safeguards phone ownership and survives rollback and backup', async t => {
  const f = await fixture(t), book = await f.db.getBook(), task = () => ({ ...book, id: randomUUID() });
  const member = await f.db.createMember({ name: '原会员', phone: '+01 (234)' }, task());
  await assert.rejects(f.db.createMember({ name: '冲突', phone: '01234' }, task()), { code: 'MEMBER_PHONE_IN_USE' });
  await recharge(f.db, member.id, { actualPayCents: '100', giftCents: '0' });
  const spend = await f.db.executeCommand({ ...book, id: randomUUID(), type: 'consume', memberId: member.id, expectedAccountVersion: '1', amountCents: '100' });
  await f.db.archiveMember(member.id, task());
  const other = await f.db.createMember({ name: '新会员', phone: '01＊2.34' }, task());
  const undo = { ...book, id: randomUUID(), type: 'reverse', memberId: member.id, originalEntryId: spend.entryId, expectedAccountVersion: '2' };
  await assert.rejects(f.db.executeCommand(undo), { code: 'MEMBER_PHONE_IN_USE' });
  await f.db.updateMember(other.id, { name: other.name, phone: '012345', expectedVersion: '0' }, task());
  f.fault('INSERT INTO command_receipts');
  await assert.rejects(f.db.executeCommand(undo), /injected write failure/);
  f.fault(null);
  assert.ok((await f.db.getMember(member.id)).archivedAt);
  assert.equal((await f.db.getMember(member.id)).balanceCents, '0');
  assert.equal((await f.db.listLedger({ memberId: member.id })).items.length, 2);

  const receipt = await f.db.executeCommand(undo);
  await f.reopen();
  assert.deepEqual(await f.db.executeCommand(undo), receipt);
  const active = await f.db.getMember(member.id);
  assert.equal(active.archivedAt, null);
  assert.equal(active.version, '2');
  assert.equal(active.balanceCents, '100');
  const backup = await f.db.exportBackup(), target = await fixture(t);
  await restore(target, backup);
  assert.deepEqual(await target.db.getMember(member.id), active);
  assert.equal((await f.db.exportArchive({ write() {} })).entryCount, 3);
});

test('standalone restore rotates the book atomically, retains receipt provenance and fences old tasks, funds and cursors', async t => {
  const original = await fixture(t); await original.db.importOpeningBalances(source());
  const member = await original.db.getMember('member-1'), request = { id: randomUUID(), ledgerEpoch, type: 'recharge', memberId: member.id, expectedAccountVersion: member.accountVersion, actualPayCents: '100', payments: [{ method: '现金', amountCents: '50' }, { method: '微信', amountCents: '50' }] };
  await original.db.executeCommand(request);
  const task = { id: randomUUID(), ledgerEpoch, storeId, type: 'member.create', data: { name: '代际测试' } };
  await original.db.executeTask(task);
  const backup = await original.db.exportBackup(), target = await fixture(t), initialBook = await target.db.getBook();
  const cursor = (await original.db.listMembers({ limit: 1 })).nextCursor;
  const reportQuery = { from: '2026-11-19T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z', kind: 'payment', limit: 1 }, reportCursor = (await original.db.reportBreakdown(reportQuery)).nextCursor;
  assert.ok(reportCursor);
  target.fault('COMMIT'); await assert.rejects(restore(target, backup), /injected/); target.fault(null);
  assert.deepEqual(await target.db.getBook(), initialBook); assert.equal((await target.db.listMembers()).items.length, 0);
  const restored = await restore(target, backup); assert.notEqual(restored.ledgerEpoch, ledgerEpoch); assert.notEqual(restored.ledgerEpoch, initialBook.ledgerEpoch);
  assert.equal(restored.sourceLedgerEpoch, ledgerEpoch);
  for (const input of [request, { ...request, id: randomUUID(), expectedAccountVersion: '1' }]) await assert.rejects(target.db.executeCommand(input), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(target.db.executeTask(task), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(target.db.getTask(task.id, { ledgerEpoch }), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(target.db.getTask(task.id, { ledgerEpoch: restored.ledgerEpoch }), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(target.db.executeTask({ ...task, ledgerEpoch: restored.ledgerEpoch }), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(target.db.executeCommand({ ...request, ledgerEpoch: restored.ledgerEpoch }), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(target.db.listMembers({ after: cursor }), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(target.db.reportBreakdown({ ...reportQuery, cursor: reportCursor }), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(target.db.importOpeningBalances(source()), { code: 'LEDGER_EPOCH_MISMATCH' });
  assert.equal((await target.db.getMember(member.id)).balanceCents, '100');
  const result = await recharge(target.db, member.id); assert.equal(result.ledgerEpoch, restored.ledgerEpoch);
  await target.reopen(); assert.equal((await target.db.getBook()).ledgerEpoch, restored.ledgerEpoch);
  const nextBackup = await target.db.exportBackup(); assert.equal(nextBackup.tables.command_receipts[0].ledger_epoch, ledgerEpoch); assert.equal(nextBackup.tables.command_receipts[1].ledger_epoch, restored.ledgerEpoch);
  const nextTarget = await fixture(t); await restore(nextTarget, nextBackup); assert.equal((await nextTarget.db.getMember(member.id)).balanceCents, '1211');
});

test('replica generation mismatch never applies pages, acknowledges money or reopens under a different generation', async t => {
  const f = await fixture(t, 'cloud'), other = randomUUID(), at = '2026-11-19T01:00:00.000Z';
  const page = { storeId, ledgerEpoch, head: '1', cursor: '1', hasMore: false, items: [{ cursor: '1', entityType: 'member', entityId: 'm', changeType: 'upsert', value: { id: 'm', name: '云端会员', phone: '', notes: '', tags: [], balanceCents: '100', version: '0', accountVersion: '0', createdAt: at, updatedAt: at, archivedAt: null, openingBalanceCents: '100' } }] };
  await assert.rejects(f.db.applyChanges({ ...page, ledgerEpoch: other }), { code: 'LEDGER_EPOCH_MISMATCH' });
  assert.equal((await f.db.syncState()).cursor, '0'); assert.equal((await f.db.listMembers()).items.length, 0);
  await f.db.applyChanges(page);
  const receipt = await f.db.executeCommand({ id: randomUUID(), ledgerEpoch, type: 'consume', memberId: 'm', expectedAccountVersion: '0', amountCents: '10' });
  await assert.rejects(f.db.acknowledge(receipt.commandId, { ...receipt, ledgerEpoch: other }), { code: 'LEDGER_EPOCH_MISMATCH' });
  await assert.rejects(f.db.applyChanges({ storeId, ledgerEpoch: other, cursor: '0', head: '0', items: [] }), { code: 'LEDGER_EPOCH_MISMATCH' });
  assert.equal((await f.db.pendingCommands()).length, 1); assert.equal((await f.db.getMember('m')).balanceCents, '90');
  await f.db.close(); const driver = openNodeSqlite(f.path), wrong = createRelationalSqlite({ driver, storeId, mode: 'cloud', ledgerEpoch: other, authorize: async () => null });
  await assert.rejects(wrong.init(), { code: 'LEDGER_EPOCH_MISMATCH' }); await wrong.close(); await f.reopen();
  assert.equal((await f.db.getBook()).ledgerEpoch, ledgerEpoch); assert.equal((await f.db.pendingCommands()).length, 1);
});

test('real file SQLite enforces foreign keys, WAL/FULL, 91 openings, exact BIGINT and restart persistence', async t => {
  const fixtureDb = await fixture(t), { db } = fixtureDb;
  assert.deepEqual(fixtureDb.diagnostics, { foreignKeys: true, journalMode: 'wal', synchronous: 'FULL', schemaVersion: 6 });
  await db.importOpeningBalances(source());
  const ids = []; let after; do { const page = await db.listMembers({ limit: 7, after }); ids.push(...page.items.map(row => row.id)); after = page.nextCursor; } while (after);
  assert.equal(ids.length, 91); assert.equal(new Set(ids).size, 91);
  assert.equal((await db.getMember('member-0')).balanceCents, '-100');
  assert.equal((await db.importOpeningBalances(source())).alreadyImported, true);
  assert.throws(() => fixtureDb.driver.run('INSERT INTO member_accounts VALUES(?,?,?,?)', [storeId, 'missing', '0', '0']), /FOREIGN KEY/);
  const result = await recharge(db, 'member-1'); assert.equal(result.balanceAfterCents, '1111');
  await fixtureDb.reopen(); assert.equal((await fixtureDb.db.getMember('member-1')).balanceCents, '1111');
  assert.equal((await fixtureDb.db.listLedger()).items.length, 1);
});

test('SQLite transaction rollback covers balances, ledger, immutable receipt and core audit; failed COMMIT does not report success', async t => {
  const f = await fixture(t); const member = await f.db.createMember({ name: '故障测试' }, { id: randomUUID(), ledgerEpoch, storeId: storeId });
  for (const failure of ['INSERT INTO ledger_entries', 'UPDATE member_accounts', 'INSERT INTO command_receipts', 'INSERT INTO local_audit', 'COMMIT']) {
    f.fault(failure); await assert.rejects(recharge(f.db, member.id), /injected/); f.fault(null);
    assert.equal((await f.db.getMember(member.id)).balanceCents, '0');
    assert.equal((await f.db.listLedger()).items.length, 0);
    assert.equal(f.driver.all('SELECT count(*) AS n FROM command_receipts')[0].n, '0');
  }
  assert.equal((await recharge(f.db, member.id)).balanceAfterCents, '1111');
});

test('SQLite handles signed 64-bit cents without Number rounding or REAL coercion', async t => {
  const f = await fixture(t), maximum = '9223372036854775807';
  const input = { ledgerEpoch, batchId: 'int64-opening-20261119', sourceDigest: 'f'.repeat(64), expectedCount: 1, members: [{ id: 'large', name: '大整数', balanceCents: maximum }] };
  await f.db.importOpeningBalances(input); assert.equal((await f.db.getMember('large')).balanceCents, maximum);
  await assert.rejects(recharge(f.db, 'large'), /BIGINT/);
  assert.throws(() => f.driver.run('UPDATE member_accounts SET balance_cents=?', ['9223372036854775808']), /CHECK/);
  await f.reopen(); assert.equal((await f.db.getMember('large')).balanceCents, maximum);
});

test('SQLite commands retry identically, reject changed payloads and cannot update/delete historical originals', async t => {
  const f = await fixture(t), member = await f.db.createMember({ name: '幂等测试' }, { id: randomUUID(), ledgerEpoch, storeId: storeId });
  const command = { id: randomUUID(), ledgerEpoch, type: 'recharge', memberId: member.id, expectedAccountVersion: '0', actualPayCents: '100' };
  const result = await f.db.executeCommand(command); assert.deepEqual(await f.db.executeCommand(command), result);
  await assert.rejects(f.db.executeCommand({ ...command, actualPayCents: '1' }), { code: 'COMMAND_CONFLICT' });
  await f.db.executeCommand({ id: randomUUID(), ledgerEpoch, type: 'reverse', memberId: member.id, expectedAccountVersion: '1', originalEntryId: command.id });
  assert.equal((await f.db.getMember(member.id)).balanceCents, '0');
  assert.throws(() => f.driver.run('UPDATE ledger_entries SET delta_cents=1'), /immutable/);
  assert.throws(() => f.driver.run('DELETE FROM ledger_entries'), /immutable/);
  f.role('viewer'); await assert.rejects(recharge(f.db, member.id), { status: 403 });
  f.role('owner'); f.deny(true); await assert.rejects(recharge(f.db, member.id), /license expired/);
});

test('SQLite import rolls the entire batch back at audit failure and refuses changed source contents', async t => {
  const f = await fixture(t); f.fault('INSERT INTO local_audit');
  await assert.rejects(f.db.importOpeningBalances(source())); f.fault(null);
  assert.equal((await f.db.listMembers()).items.length, 0); await f.db.importOpeningBalances(source());
  const changed = source(); changed.members[0].balanceCents = '9';
  await assert.rejects(f.db.importOpeningBalances(changed), { code: 'OPENING_BATCH_CONFLICT' });
});

test('cloud SQLite stores typed durable outbox, preserves conflicts and never silently overwrites local pending balances', async t => {
  const f = await fixture(t, 'cloud'), at = '2026-11-19T01:00:00.000Z';
  const page = { storeId, ledgerEpoch, head: '1', cursor: '1', hasMore: false, items: [{ cursor: '1', entityType: 'member', entityId: 'remote-member', changeType: 'upsert', value: { id: 'remote-member', name: '云端会员', phone: '', notes: '', tags: [], balanceCents: '1000', version: '0', accountVersion: '0', createdAt: at, updatedAt: at, archivedAt: null, openingBalanceCents: '1000' } }] };
  await f.db.applyChanges(page);
  const request = { id: randomUUID(), ledgerEpoch, type: 'consume', memberId: 'remote-member', amountCents: '100', expectedAccountVersion: '0' };
  const result = await f.db.executeCommand(request);
  const pending = await f.db.pendingCommands(); assert.deepEqual(pending[0].command, { storeId, actorId: 'local-owner', deviceId, configurationVersion: '0', ...request });
  f.actor('another-actor'); assert.equal((await f.db.pendingCommands())[0].status, 'blocked');
  await assert.rejects(recharge(f.db, 'remote-member'), { code: 'PENDING_ACTOR_CHANGED' }); f.actor('local-owner');
  await f.reopen(); assert.equal((await f.db.getMember('remote-member')).balanceCents, '900'); assert.equal((await f.db.pendingCommands()).length, 1);
  const update = { storeId, ledgerEpoch, head: '2', cursor: '2', items: [{ ...page.items[0], cursor: '2', value: { ...page.items[0].value, balanceCents: '2000', accountVersion: '1' } }] };
  await assert.rejects(f.db.applyChanges(update), { code: 'SYNC_PENDING' });
  assert.equal((await f.db.syncState()).cursor, '1'); assert.equal((await f.db.getMember('remote-member')).balanceCents, '900');
  await assert.rejects(f.db.acknowledge(request.id, { ...result, balanceAfterCents: '999' }), { code: 'RECEIPT_MISMATCH' });
  await f.db.markConflict(request.id, 'ACCOUNT_VERSION_CHANGED');
  assert.equal((await f.db.pendingCommands())[0].status, 'conflict');
  await assert.rejects(recharge(f.db, 'remote-member'), { code: 'MEMBER_SYNC_CONFLICT' });
  await f.db.acknowledge(request.id, result); assert.equal((await f.db.pendingCommands()).length, 0);
});

test('SQLite refuses reopening a file under another tenant or authority mode', async t => {
  const f = await fixture(t); await f.db.close();
  for (const options of [{ storeId: 'another-store', mode: 'standalone' }, { storeId, mode: 'cloud' }]) {
    const driver = openNodeSqlite(f.path), other = createRelationalSqlite({ driver, ledgerEpoch, ...options, authorize: async () => null });
    await assert.rejects(other.init(), /归属/); await other.close();
  }
});

const configuration = () => ({ expectedVersion: '0', services: [{ id: 'cut', name: '剪发', priceCents: '1010' }], rechargePlans: [{ id: 'plan', payCents: '10000', giftCents: '1000' }], rechargeSettings: { giftEnabled: true, giftRateBasisPoints: 1000 } });
test('SQLite configuration, captured service prices and split payments survive restart and cannot be rewritten', async t => {
  const f = await fixture(t); assert.equal((await f.db.getConfiguration()).version, '0');
  await f.db.updateConfiguration(configuration(), { id: randomUUID(), ledgerEpoch, storeId: storeId });
  await assert.rejects(f.db.updateConfiguration(configuration(), { id: randomUUID(), ledgerEpoch, storeId: storeId }), { code: 'CONFIGURATION_VERSION_CHANGED' });
  const member = await f.db.createMember({ name: '成交明细' }, { id: randomUUID(), ledgerEpoch, storeId: storeId });
  const request = { id: randomUUID(), ledgerEpoch, type: 'recharge', memberId: member.id, expectedAccountVersion: '0', actualPayCents: '10000', giftCents: '1000', configurationVersion: '1', planId: 'plan', payments: [{ method: '现金', amountCents: '9000' }, { method: '微信', amountCents: '1000' }] };
  const receipt = await f.db.executeCommand(request);
  await f.db.executeCommand({ id: randomUUID(), ledgerEpoch, type: 'consume', memberId: member.id, expectedAccountVersion: '1', amountCents: '2020', configurationVersion: '1', items: [{ serviceId: 'cut', name: '剪发', quantity: 2, unitPriceCents: '1010' }] });
  await f.db.updateConfiguration({ ...configuration(), expectedVersion: '1', services: [], rechargePlans: [], rechargeSettings: { giftEnabled: false, giftRateBasisPoints: 0 } }, { id: randomUUID(), ledgerEpoch, storeId: storeId });
  assert.deepEqual(await f.db.executeCommand(request), receipt); await f.reopen();
  const entries = (await f.db.listLedger()).items;
  assert.deepEqual(entries.find(row => row.id === request.id).payments, request.payments);
  assert.equal(entries.find(row => row.type === 'consume').items[0].unitPriceCents, '1010');
  for (const table of ['consumption_items', 'payment_records', 'recharge_details']) { assert.throws(() => f.driver.run('DELETE FROM ' + table), /immutable/); }
  await assert.rejects(recharge(f.db, member.id), { code: 'GIFT_DISABLED' });
  f.role('clerk'); await assert.rejects(f.db.updateConfiguration({ ...configuration(), expectedVersion: '2' }, { id: randomUUID(), ledgerEpoch, storeId: storeId }), { status: 403 });
});
test('SQLite sale and configuration audit failures roll back snapshots, balances and configuration version', async t => {
  const f = await fixture(t), member = await f.db.createMember({ name: '故障' }, { id: randomUUID(), ledgerEpoch, storeId: storeId });
  for (const point of ['INSERT INTO payment_records', 'INSERT INTO recharge_details']) {
    f.fault(point); await assert.rejects(recharge(f.db, member.id), /injected/); f.fault(null);
    assert.equal((await f.db.getMember(member.id)).balanceCents, '0'); assert.equal((await f.db.listLedger()).items.length, 0);
  }
  f.fault('INSERT INTO local_audit'); await assert.rejects(f.db.updateConfiguration(configuration(), { id: randomUUID(), ledgerEpoch, storeId: storeId }), /injected/); f.fault(null);
  assert.equal((await f.db.getConfiguration()).version, '0'); assert.equal(f.driver.all('SELECT count(*) AS n FROM service_catalog')[0].n, '0');
});

test('implicit configuration is captured durably and an original manual command still retries after rule changes', async t => {
  const f = await fixture(t), member = await f.db.createMember({ name: '手工命令' }, { id: randomUUID(), ledgerEpoch, storeId: storeId });
  const request = { id: randomUUID(), ledgerEpoch, type: 'recharge', memberId: member.id, expectedAccountVersion: '0', actualPayCents: '1' };
  const result = await f.db.executeCommand(request); await f.db.updateConfiguration(configuration(), { id: randomUUID(), ledgerEpoch, storeId: storeId }); await f.reopen();
  assert.deepEqual(await f.db.executeCommand(request), result); assert.equal((await f.db.listLedger()).items.length, 1);
});

test('standalone complete backup restores openings plus new funds, receipts, reversals, prices and audit, then accepts new business', async t => {
  const original = await fixture(t); await original.db.importOpeningBalances(source()); await original.db.updateConfiguration(configuration(), { id: randomUUID(), ledgerEpoch, storeId: storeId });
  const charged = await recharge(original.db, 'member-1');
  const spent = await original.db.executeCommand({ id: randomUUID(), ledgerEpoch, type: 'consume', memberId: 'member-1', expectedAccountVersion: '1', amountCents: '1010', configurationVersion: '1', items: [{ serviceId: 'cut', name: '剪发', quantity: 1, unitPriceCents: '1010' }] });
  await original.db.executeCommand({ id: randomUUID(), ledgerEpoch, type: 'reverse', memberId: 'member-1', expectedAccountVersion: '2', originalEntryId: spent.entryId });
  const backup = await original.db.exportBackup(); assert.equal(backup.tables.ledger_entries.length, 3); assert.equal(backup.tables.command_receipts.length, 3);
  const fresh = await fixture(t), result = await restore(fresh, backup); assert.equal(result.memberCount, 91); assert.equal(result.entryCount, 3);
  assert.equal((await fresh.db.getMember('member-1')).balanceCents, charged.balanceAfterCents);
  assert.deepEqual((await fresh.db.listLedger()).items, (await original.db.listLedger()).items);
  assert.deepEqual(await fresh.db.getConfiguration(), await original.db.getConfiguration());
  await fresh.reopen(); await recharge(fresh.db, 'member-1');
  assert.equal((await fresh.db.getMember('member-1')).balanceCents, '2222');
  const second = await fresh.db.exportBackup(); assert.equal(second.tables.ledger_entries.length, 4); assert.ok(second.tables.local_audit.some(row => row.event === 'ledger_restored'));
  await assert.rejects(restore(fresh, backup), { code: 'BACKUP_NOT_EMPTY' });
});
test('backup rejects digest damage and recomputed but inconsistent funds, receipts, snapshots or tenant rows', async t => {
  const original = await fixture(t), member = await original.db.createMember({ name: '备份核验' }, { id: randomUUID(), ledgerEpoch, storeId: storeId }); await recharge(original.db, member.id);
  const backup = await original.db.exportBackup(), target = await fixture(t);
  const brokenDigest = structuredClone(backup); brokenDigest.tables.member_accounts[0].balance_cents = '1';
  await assert.rejects(restore(target, brokenDigest), { code: 'BACKUP_INVALID' });
  for (const change of [b => b.tables.member_accounts[0].balance_cents = '1', b => b.tables.command_receipts.pop(), b => b.tables.payment_records[0].amount_cents = '1', b => b.tables.ledger_entries[0].account_version = '2', b => b.tables.member_profiles[0].store_id = 'other-store', b => b.tables.local_audit = []]) {
    const changed = structuredClone(backup); change(changed); const { digest, ...payload } = changed; changed.digest = await sha256(canonicalJSON(payload));
    await assert.rejects(restore(target, changed)); assert.equal((await target.db.listMembers()).items.length, 0);
  }
  const wrongStore = structuredClone(backup); wrongStore.storeId = 'other-store'; await assert.rejects(restore(target, wrongStore), { code: 'BACKUP_INVALID' });
});
test('backup restore failure rolls back the complete new book, checks owner permission and rejects cloud replica replacement', async t => {
  const original = await fixture(t), member = await original.db.createMember({ name: '恢复故障' }, { id: randomUUID(), ledgerEpoch, storeId: storeId }); await recharge(original.db, member.id);
  const backup = await original.db.exportBackup(), target = await fixture(t);
  target.fault('INSERT INTO payment_records'); await assert.rejects(restore(target, backup), /injected/); target.fault(null);
  assert.equal((await target.db.listMembers()).items.length, 0); assert.equal(target.driver.all('SELECT count(*) AS n FROM command_receipts')[0].n, '0');
  target.role('viewer'); await assert.rejects(restore(target, backup), { status: 403 }); target.role('owner'); await restore(target, backup);
  const cloud = await fixture(t, 'cloud'); assert.throws(() => cloud.db.exportBackup(), { code: 'WRONG_AUTHORITY' }); await assert.rejects(restore(cloud, backup), { code: 'WRONG_AUTHORITY' });
});

const dayOne = { from: '2026-11-19T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' };
const dayTwo = { from: '2026-11-20T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' };
test('SQLite reports reconcile gross, reversal and net by occurrence period and retain historical sale groups', async t => {
  const f = await fixture(t); await f.db.importOpeningBalances(source()); await f.db.updateConfiguration(configuration(), { id: randomUUID(), ledgerEpoch, storeId: storeId });
  const charged = await recharge(f.db, 'member-1', { actualPayCents: '10000', giftCents: '1000', planId: 'plan', configurationVersion: '1', payments: [{ method: '现金', amountCents: '9000' }, { method: '微信', amountCents: '1000' }] });
  const spent = await f.db.executeCommand({ id: randomUUID(), ledgerEpoch, type: 'consume', memberId: 'member-1', expectedAccountVersion: '1', amountCents: '2020', configurationVersion: '1', items: [{ serviceId: 'cut', name: '剪发', quantity: 2, unitPriceCents: '1010' }] });
  const first = await f.db.report(dayOne);
  assert.equal(first.memberCount, 91); assert.equal(first.entryCount, 2);
  for (const [key, expected] of Object.entries({ storedCents: '409480', debtCents: '-100', actualPayCents: '10000', giftCents: '1000', consumptionCents: '2020', netChangeCents: '8980', netActualPayCents: '10000', netGiftCents: '1000', netConsumptionCents: '2020', reversedActualPayCents: '0', reversedGiftCents: '0', reversedConsumptionCents: '0' })) assert.equal(first[key], expected, key);
  assert.deepEqual(first.localState, { mode: 'standalone', ledgerEpoch, cursor: '0', pendingCount: 0, conflictCount: 0 });
  await f.db.updateConfiguration({ ...configuration(), expectedVersion: '1', services: [], rechargePlans: [] }, { id: randomUUID(), ledgerEpoch, storeId: storeId });
  let services = await f.db.reportBreakdown({ ...dayOne, kind: 'service' });
  assert.deepEqual(services.items, [{ name: '剪发', serviceId: 'cut', quantity: '2', amountCents: '2020' }]);
  const payments = [], pages = []; let cursor;
  do { const page = await f.db.reportBreakdown({ ...dayOne, kind: 'payment', limit: 1, cursor }); payments.push(...page.items); pages.push(page); cursor = page.nextCursor; } while (cursor);
  assert.equal(pages.length, 2); assert.equal(new Set(payments.map(row => row.name)).size, 2);
  assert.deepEqual(Object.fromEntries(payments.map(row => [row.name, row.amountCents])), { '微信': '1000', '现金': '9000' });
  f.at(dayTwo.from);
  await f.db.executeCommand({ id: randomUUID(), ledgerEpoch, type: 'reverse', memberId: 'member-1', expectedAccountVersion: '2', originalEntryId: spent.entryId });
  await f.db.executeCommand({ id: randomUUID(), ledgerEpoch, type: 'reverse', memberId: 'member-1', expectedAccountVersion: '3', originalEntryId: charged.entryId });
  const second = await f.db.report(dayTwo);
  assert.equal(second.entryCount, 2);
  for (const [key, expected] of Object.entries({ storedCents: '400500', debtCents: '-100', actualPayCents: '0', giftCents: '0', consumptionCents: '0', netChangeCents: '-8980', reversalDeltaCents: '-8980', reversedActualPayCents: '10000', reversedGiftCents: '1000', reversedConsumptionCents: '2020', netActualPayCents: '-10000', netGiftCents: '-1000', netConsumptionCents: '-2020' })) assert.equal(second[key], expected, key);
  services = await f.db.reportBreakdown({ ...dayTwo, kind: 'service' });
  assert.deepEqual(services.items, [{ name: '剪发', serviceId: 'cut', quantity: '-2', amountCents: '-2020' }]);
  const both = await f.db.report({ from: dayOne.from, to: dayTwo.to });
  for (const key of ['netChangeCents', 'netActualPayCents', 'netGiftCents', 'netConsumptionCents']) assert.equal(both[key], '0');
  assert.equal((await f.db.reportBreakdown({ from: dayOne.from, to: dayTwo.to, kind: 'service' })).items[0].amountCents, '0');
  assert.equal((await f.db.report(dayOne)).entryCount, 2, 'upper boundary excludes next day reversals');
  const firstBusiness = await f.db.reportBusiness({ ...dayOne, offsetMinutes: 0 }), secondBusiness = await f.db.reportBusiness({ ...dayTwo, offsetMinutes: 0 });
  assert.equal(firstBusiness.summary.newActiveMemberCount, 0, 'opening profiles are not new customers');
  assert.equal(firstBusiness.summary.rechargeCreditCents, '11000'); assert.equal(firstBusiness.summary.consumeCount, 1); assert.equal(firstBusiness.summary.consumeMemberCount, 1); assert.equal(firstBusiness.summary.averageConsumeCents, '2020');
  assert.equal(secondBusiness.summary.rechargeCount, 0); assert.equal(secondBusiness.summary.reversalCount, 2); assert.equal(secondBusiness.summary.netRechargeCreditCents, '-11000'); assert.equal(secondBusiness.summary.netConsumptionCents, '-2020');
  assert.deepEqual(firstBusiness.ranking, [{ memberId: 'member-1', name: '合成会员1', netConsumptionCents: '2020', netConsumeCount: 1 }]);
  assert.deepEqual(secondBusiness.ranking, [{ memberId: 'member-1', name: '合成会员1', netConsumptionCents: '-2020', netConsumeCount: -1 }]);
  assert.deepEqual(firstBusiness.balances, { storedCents: '400500', debtCents: '-100', memberCount: 91, debtCount: 1, zeroCount: 1, lowCount: 50, fundedCount: 39 });
  assert.equal((await f.db.reportBusiness({ from: dayOne.from, to: dayTwo.to, offsetMinutes: 0 })).ranking.length, 0);
  f.features(LICENSE_FEATURES.filter(value => value !== 'reports'));
  await assert.rejects(f.db.report(dayOne), { code: 'FEATURE_DISABLED' });
  await assert.rejects(f.db.reportBreakdown({ ...dayOne, kind: 'payment' }), { code: 'FEATURE_DISABLED' });
  await assert.rejects(f.db.reportBusiness(dayOne), { code: 'FEATURE_DISABLED' });
  assert.equal((await f.db.getMember('member-1')).balanceCents, '0');
});

test('SQLite report aggregates exceed BIGINT exactly while preserving minimum signed debt and payment splits', async t => {
  const f = await fixture(t), maximum = '9223372036854775807', minimum = '-9223372036854775808';
  await f.db.importOpeningBalances({ ledgerEpoch, batchId: 'report-extreme-20261119', sourceDigest: 'f'.repeat(64), expectedCount: 1, members: [{ id: 'debt', name: '最低余额', balanceCents: minimum }] });
  for (let i = 0; i < 2; i++) { const member = await f.db.createMember({ name: '最大充值' + i }, { id: randomUUID(), ledgerEpoch, storeId: storeId }); await recharge(f.db, member.id, { actualPayCents: maximum, giftCents: '0', payMethod: '现金' }); }
  const report = await f.db.report(dayOne), doubled = '18446744073709551614';
  for (const key of ['storedCents', 'actualPayCents', 'netActualPayCents', 'netChangeCents']) assert.equal(report[key], doubled, key);
  assert.equal(report.debtCents, minimum); assert.equal(report.entryCount, 2);
  assert.deepEqual((await f.db.reportBreakdown({ ...dayOne, kind: 'payment' })).items, [{ name: '现金', amountCents: doubled }]);
});

test('SQLite report aggregate chunk pagination crosses 500 chunks without truncation, including one group spanning pages', async t => {
  const f = await fixture(t), member = await f.db.createMember({ name: '聚合查询边界' }, { id: randomUUID(), ledgerEpoch, storeId: storeId });
  // Sparse rowids exercise the SQL aggregation paging contract without
  // manufacturing millions of financial commands or claiming a load test.
  f.driver.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < 503; i++) {
    const entry = 'aggregate-query-' + String(i).padStart(16, '0'), rowid = String(i * 10000 + 1), name = i < 502 ? '同组 ✂️' : '末组 👩';
    f.driver.run('INSERT INTO ledger_entries(rowid,store_id,entry_id,member_id,kind,account_version,delta_cents,balance_before_cents,balance_after_cents,actual_pay_cents,gift_cents,pay_method,items_summary,remark,actor_id,device_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [rowid, storeId, entry, member.id, 'consume', String(i + 1), '-1', String(-i), String(-i - 1), '0', '0', '', '', '', 'local-owner', deviceId, '2026-11-19T01:00:00.000Z']);
    f.driver.run('INSERT INTO consumption_items(rowid,store_id,entry_id,position,service_id,name,quantity,unit_price_cents,line_total_cents) VALUES(?,?,?,?,?,?,?,?,?)', [rowid, storeId, entry, '0', null, name, '1', '1', '1']);
  }
  f.driver.run('UPDATE member_accounts SET balance_cents=-503,version=503'); f.driver.exec('COMMIT');
  const report = await f.db.report(dayOne); assert.equal(report.entryCount, 503); assert.equal(report.consumptionCents, '503'); assert.equal(report.debtCents, '-503');
  const first = await f.db.reportBreakdown({ ...dayOne, kind: 'service', limit: 1 });
  assert.deepEqual(first.items, [{ name: '同组 ✂️', serviceId: null, quantity: '502', amountCents: '502' }]); assert.ok(first.nextCursor);
  const last = await f.db.reportBreakdown({ ...dayOne, kind: 'service', limit: 1, cursor: first.nextCursor });
  assert.deepEqual(last.items, [{ name: '末组 👩', serviceId: null, quantity: '1', amountCents: '1' }]); assert.equal(last.nextCursor, null);
  const business = await f.db.reportBusiness({ ...dayOne, offsetMinutes: 0 });
  assert.equal(business.summary.consumptionCents, '503'); assert.equal(business.summary.consumeCount, 503); assert.equal(business.summary.consumeMemberCount, 1); assert.equal(business.ranking[0].netConsumptionCents, '503');
});

test('complete SQLite backup paginates every table under Android bridge limit and restores more than 1000 rows intact', async t => {
  const f = await fixture(t), input = { ...source(), expectedCount: 1001, members: Array.from({ length: 1001 }, (_, i) => ({ id: 'paged-' + i, name: '分页备份' + i, balanceCents: '1' })) };
  await f.db.importOpeningBalances(input);
  const backup = await f.db.exportBackup(); assert.equal(backup.tables.member_profiles.length, 1001); assert.equal(backup.tables.account_openings.length, 1001);
  assert.ok(backup.tables.member_profiles.every(row => !('__rowid' in row)));
  const target = await fixture(t); assert.equal((await restore(target, backup)).memberCount, 1001);
  assert.equal((await target.db.report(dayOne)).storedCents, '1001');
});

test('SQLite durable task results survive changes, restart and restore while old-epoch retries remain fenced', async t => {
  const f = await fixture(t), create = { id: randomUUID(), ledgerEpoch, storeId, type: 'member.create', data: { name: ' 原姓名 ', phone: '001', tags: ['😀', '\uE000', '中', 'A'] } };
  const original = await f.db.executeTask(create);
  assert.deepEqual(original.tags, ['A', '中', '\uE000', '😀']); assert.deepEqual((await f.db.getMember(original.id)).tags, original.tags);
  const update = { id: randomUUID(), ledgerEpoch, storeId, type: 'member.update', memberId: original.id, data: { name: '修改姓名', expectedVersion: '0', tags: ['新标签'] } };
  const updated = await f.db.executeTask(update); await recharge(f.db, original.id);
  const change = { id: randomUUID(), ledgerEpoch, storeId, type: 'configuration.update', data: configuration() }, firstConfig = await f.db.executeTask(change);
  await f.db.executeTask({ id: randomUUID(), ledgerEpoch, storeId, type: 'configuration.update', data: { ...configuration(), expectedVersion: '1', services: [] } });
  await f.reopen();
  assert.deepEqual(await f.db.executeTask(create), original); assert.deepEqual(await f.db.executeTask(update), updated); assert.deepEqual(await f.db.executeTask(change), firstConfig);
  assert.deepEqual((await f.db.getTask(create.id, { ledgerEpoch })).result, original); assert.equal((await f.db.getMember(original.id)).balanceCents, '1111');
  assert.equal((await f.db.listMembers()).items.length, 1);
  const zero = await f.db.createMember({ name: '待归档' }, { id: randomUUID(), ledgerEpoch, storeId }), archive = { id: randomUUID(), ledgerEpoch, storeId, type: 'member.archive', memberId: zero.id, data: {} };
  assert.deepEqual(await f.db.executeTask(archive), { success: true }); assert.deepEqual(await f.db.executeTask(archive), { success: true });
  const backup = await f.db.exportBackup(), target = await fixture(t); await restore(target, backup);
  for (const request of [create, update, change, archive]) await assert.rejects(target.db.executeTask(request), { code: 'LEDGER_EPOCH_MISMATCH' });
  const restored = await target.db.exportBackup();
  for (const table of ['local_task_receipts', 'task_member_results', 'task_member_tags', 'task_configuration_results', 'task_configuration_services', 'task_configuration_plans']) assert.deepEqual(restored.tables[table], backup.tables[table]);
  for (const table of ['local_task_receipts', 'task_member_results', 'task_member_tags', 'task_configuration_results', 'task_configuration_services', 'task_configuration_plans']) {
    assert.throws(() => f.driver.run('DELETE FROM ' + table), /immutable/); assert.throws(() => f.driver.run('UPDATE ' + table + ' SET task_id=task_id'), /immutable/);
  }
});

test('SQLite task identity, exact input, target and operation are bound and retries recheck current permissions', async t => {
  const f = await fixture(t), request = { id: randomUUID(), ledgerEpoch, storeId, type: 'member.create', data: { name: 'x' } };
  const result = await f.db.executeTask(request);
  for (const override of [{ data: { name: 'y' } }, { type: 'member.update', memberId: result.id, data: { name: 'x', expectedVersion: '0' } }]) await assert.rejects(f.db.executeTask({ ...request, ...override }), { code: 'TASK_CONFLICT' });
  await assert.rejects(f.db.executeTask({ ...request, storeId: 'other' }), { status: 400 });
  f.actor('another-actor'); await assert.rejects(f.db.executeTask(request), { code: 'TASK_CONFLICT' }); await assert.rejects(f.db.getTask(request.id, { ledgerEpoch }), { code: 'TASK_NOT_FOUND' });
  f.actor('local-owner'); f.role('viewer'); await assert.rejects(f.db.executeTask(request), { status: 403 }); f.role('owner');
  f.features(LICENSE_FEATURES.filter(feature => feature !== 'members')); await assert.rejects(f.db.executeTask(request), { code: 'FEATURE_DISABLED' }); f.features(LICENSE_FEATURES);
  assert.throws(() => f.db.createMember({ name: 'missing task' }), { status: 400 });
  const cloud = await fixture(t, 'cloud'); await assert.rejects(cloud.db.executeTask({ ...request, id: randomUUID() }), { code: 'ONLINE_REQUIRED' });
});

test('SQLite task receipt/result/audit/commit failures roll back business and the same original task remains retryable', async t => {
  const f = await fixture(t);
  for (const point of ['INSERT INTO local_task_receipts', 'INSERT INTO task_member_results', 'INSERT INTO task_member_tags', 'INSERT INTO local_audit', 'COMMIT']) {
    const request = { id: randomUUID(), ledgerEpoch, storeId, type: 'member.create', data: { name: '故障任务', tags: ['标签'] } }, before = Number(f.driver.all('SELECT count(*) AS n FROM member_profiles')[0].n);
    f.fault(point); await assert.rejects(f.db.executeTask(request), /injected/); f.fault(null);
    assert.equal(Number(f.driver.all('SELECT count(*) AS n FROM member_profiles')[0].n), before);
    await assert.rejects(f.db.getTask(request.id, { ledgerEpoch }), { code: 'TASK_NOT_FOUND' });
    const saved = await f.db.executeTask(request); assert.deepEqual(await f.db.executeTask(request), saved);
  }
  const configurationTask = { id: randomUUID(), ledgerEpoch, storeId, type: 'configuration.update', data: configuration() };
  f.fault('INSERT INTO task_configuration_services'); await assert.rejects(f.db.executeTask(configurationTask), /injected/); f.fault(null);
  assert.equal((await f.db.getConfiguration()).version, '0'); await assert.rejects(f.db.getTask(configurationTask.id, { ledgerEpoch }), { code: 'TASK_NOT_FOUND' });
  await f.db.executeTask(configurationTask);
});

test('backup rejects missing task results, core audit and inconsistent historical response amounts', async t => {
  const f = await fixture(t); await f.db.createMember({ name: '任务备份' }, { id: randomUUID(), ledgerEpoch, storeId }); await f.db.updateConfiguration(configuration(), { id: randomUUID(), ledgerEpoch, storeId });
  const backup = await f.db.exportBackup(), target = await fixture(t);
  for (const change of [b => b.tables.task_member_results.pop(), b => b.tables.task_member_results[0].balance_cents = '1', b => b.tables.task_configuration_results[0].version = '2', b => b.tables.task_configuration_services[0].position = '1', b => b.tables.local_audit = b.tables.local_audit.filter(row => row.event !== 'task_completed')]) {
    const changed = structuredClone(backup); change(changed); const { digest, ...payload } = changed; changed.digest = await sha256(canonicalJSON(payload));
    await assert.rejects(restore(target, changed)); assert.equal((await target.db.listMembers()).items.length, 0);
  }
});

for (const schemaVersion of [1, 2, 3, 4, 5]) test('SQLite schema ' + schemaVersion + ' developer books fail closed without dropping existing rows or committing schema 6 tables', async t => {
  const f = await fixture(t); await f.db.close();
  const old = openNodeSqlite(f.path);
  for (const table of ['task_configuration_plans', 'task_configuration_services', 'task_configuration_results', 'task_member_tags', 'task_member_results', 'local_task_receipts']) old.exec('DROP TABLE ' + table);
  old.exec('DROP TABLE book_identity'); old.exec('CREATE TABLE book_identity(singleton INTEGER PRIMARY KEY,store_id TEXT,mode TEXT,schema_version INTEGER CHECK(schema_version=' + schemaVersion + '),cursor INTEGER DEFAULT 0)');
  old.run('INSERT INTO book_identity VALUES(1,?,?,?,0)', [storeId, 'standalone', schemaVersion]); old.exec('CREATE TABLE developer_sentinel(value TEXT)'); old.run('INSERT INTO developer_sentinel VALUES(?)', ['preserve']); await old.close();
  await assert.rejects(f.reopen(), /版本不一致/);
  assert.equal(f.driver.all('SELECT value FROM developer_sentinel')[0].value, 'preserve'); assert.equal(f.driver.all('SELECT schema_version FROM book_identity')[0].schema_version, String(schemaVersion));
  assert.equal(f.driver.all("SELECT count(*) AS n FROM sqlite_master WHERE name='local_task_receipts'")[0].n, '0');
});

test('business report fills zero days, groups calendar months, separates current balances and excludes imported/archived new customers', async t => {
  const f = await fixture(t); await f.db.importOpeningBalances(source());
  const january = { from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z', offsetMinutes: 480 };
  f.at('2026-01-31T15:59:59.999Z'); const member = await f.db.createMember({ name: '月末新客' }, { id: randomUUID(), ledgerEpoch, storeId }); await recharge(f.db, member.id, { actualPayCents: '5001', giftCents: '0' });
  f.at('2026-01-31T16:00:00.000Z'); await f.db.executeCommand({ id: randomUUID(), ledgerEpoch, type: 'consume', memberId: member.id, expectedAccountVersion: '1', amountCents: '1' });
  const archived = await f.db.createMember({ name: '已归档新客' }, { id: randomUUID(), ledgerEpoch, storeId }); await f.db.archiveMember(archived.id, { id: randomUUID(), ledgerEpoch, storeId });
  const business = await f.db.reportBusiness(january);
  assert.equal(business.daily.length, 60, 'partial March local day is explicit'); assert.equal(business.trendUnit, 'month'); assert.equal(business.trend.length, 3);
  assert.equal(business.daily.find(row => row.date === '2026-01-31').actualPayCents, '5001'); assert.equal(business.daily.find(row => row.date === '2026-02-01').consumptionCents, '1');
  assert.equal(business.trend[0].actualPayCents, '5001'); assert.equal(business.trend[1].consumptionCents, '1'); assert.equal(business.trend[2].consumptionCents, '0');
  assert.equal(business.summary.newActiveMemberCount, 1); assert.equal(business.balances.memberCount, 92); assert.equal(business.balances.lowCount, 51);
  const empty = await f.db.reportBusiness({ from: '2020-01-01T00:00:00Z', to: '2020-01-02T00:00:00Z', offsetMinutes: 0 });
  assert.equal(empty.daily.length, 1); assert.equal(empty.summary.actualPayCents, '0'); assert.equal(empty.ranking.length, 0); assert.deepEqual(empty.balances, business.balances);
});

test('business report sums and ranking preserve exact totals above BIGINT and average cents without floating point', async t => {
  const f = await fixture(t), member = await f.db.createMember({ name: '精确排行' }, { id: randomUUID(), ledgerEpoch, storeId }), maximum = '9223372036854775807';
  for (let i = 0; i < 2; i++) {
    await recharge(f.db, member.id, { actualPayCents: maximum, giftCents: '0' });
    const current = await f.db.getMember(member.id); await f.db.executeCommand({ id: randomUUID(), ledgerEpoch, type: 'consume', memberId: member.id, expectedAccountVersion: current.accountVersion, amountCents: maximum });
  }
  const report = await f.db.reportBusiness({ ...dayOne, offsetMinutes: 0 });
  assert.equal(report.summary.actualPayCents, '18446744073709551614'); assert.equal(report.summary.consumptionCents, '18446744073709551614'); assert.equal(report.summary.averageConsumeCents, maximum); assert.equal(report.ranking[0].netConsumptionCents, '18446744073709551614');
  assert.equal(report.balances.storedCents, '0'); assert.equal(report.balances.zeroCount, 1);
});
